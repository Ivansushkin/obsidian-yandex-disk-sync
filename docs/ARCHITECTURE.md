# Архитектура плагина Yandex Disk Sync

## Обзор

Плагин реализует двустороннюю синхронизацию файлов между локальным vault Obsidian и облачным хранилищем Яндекс Диск. Архитектура построена на модульном подходе с чётким разделением ответственности.

Нормативные пользовательские сценарии и критерии приёмки описаны в
[`SYNC_USER_SCENARIOS.md`](SYNC_USER_SCENARIOS.md).

## Структура проекта

```
src/
├── main.ts                 # Точка входа, жизненный цикл плагина
├── settings.ts             # UI настроек
├── types.ts                # TypeScript интерфейсы и типы
│
├── api/
│   ├── yandex-client.ts    # HTTP клиент для Yandex Disk API
│   └── vault-adapter.ts    # Адаптер для работы с Obsidian Vault
│
├── sync/
│   ├── sync-engine.ts      # Основной движок синхронизации
│   ├── index-manager.ts    # Управление индексами файлов
│   ├── sync-coordinator.ts # Единая последовательная очередь сессий
│   ├── local-operation-store.ts # Durable FIFO mutations/actions
│   ├── index-transaction-rules.ts # Lock, pagination, stable comparison
│   ├── index-rules.ts      # Причинный reducer
│   ├── conflict-resolver.ts # Разрешение конфликтов
│   ├── file-watcher.ts     # Отслеживание изменений файлов
│   └── sync-scheduler.ts   # Планировщик периодической синхронизации
│
├── backup/
│   └── backup-manager.ts   # Управление резервным копированием
│
├── crypto/
│   ├── encryption.ts       # E2E encryption service (Web Crypto API)
│   └── encryption-transition.ts # Общий transition executor и crash recovery
│
├── ui/
│   ├── status-bar.ts       # Индикатор статуса в статус-баре
│   ├── init-modal.ts       # Модальные окна
│   ├── force-sync-modal.ts # Модал подтверждения Force Sync
│   └── encryption-modals.ts # Модальные окна шифрования
│
└── utils/
    ├── path-utils.ts       # Утилиты для работы с путями
    ├── hash-utils.ts       # Вычисление SHA256 хешей
    ├── resource-fingerprint.ts # Service/physical fingerprint rules
    ├── semaphore.ts        # Контроль параллелизации
    └── logger.ts           # Логирование
```

## Компоненты

### Main (main.ts)

Точка входа плагина. Отвечает за:

- Инициализацию всех компонентов
- Регистрацию команд
- Обработку жизненного цикла (onload/onunload)
- Координацию между модулями

Enable, disable и rotate используют один `EncryptionTransitionController`.
Контроллер выполняет общий причинный workflow поверх существующих
`SyncEngine` и `IndexManager`: maintenance claim, re-encode, manifest/index
commit, guarded cleanup и recovery. Mode-specific код определяет только
source/target режим и способ публикации manifest. Этот же completion path
используется после Force recovery незавершённого transition.

### YandexDiskClient (api/yandex-client.ts)

HTTP клиент для взаимодействия с Yandex Disk REST API.

- `getResource(path)` — получить метаданные файла/папки
- `getResourcesRecursive(path)` — рекурсивный список всех файлов
- `uploadFile(path, content)` — загрузить файл
- `downloadFile(path)` — скачать файл
- `deleteResource(path)` — удалить файл/папку
- `moveResource(from, to)` — переместить/переименовать

**Особенности реализации:**

- Двухшаговая загрузка файлов (получение upload URL → PUT контента)
- Автоматический retry с exponential backoff и jitter для 423/429/503;
  конфликт 409 обрабатывается причинно в lock/upload/move workflows
- Пагинация для больших директорий
- Обработка rate limiting

### VaultAdapter (api/vault-adapter.ts)

Адаптер для работы с файловой системой Obsidian Vault.

**Основные методы:**

- `getAllSyncableFiles()` — получить все файлы для синхронизации
- `getAllFileMetadata()` — получить метаданные всех файлов с хешами
- `readFile(path)` — читать содержимое файла
- `writeFile(path, content)` — записать файл
- `deleteFile(path)` — удалить файл

**Особенности:**

- Фильтрация по include/exclude паттернам
- Поддержка конфигурируемой папки настроек Obsidian
- Использование FileManager.trashFile() для удаления
- **Параллельное вычисление SHA256 хешей** (concurrency=10) для повышения производительности

### IndexManager (sync/index-manager.ts)

Управление индексами синхронизации.

**Структура индекса:**

```typescript
interface SyncIndex {
	version: 3;
	epoch: string; // Generation, replaced only by explicit Force sync
	revision: number; // Общая причинная ревизия
	lastSyncTime: number; // Время последней синхронизации
	deviceId: string; // ID устройства
	files: Record<string, FileMetadata>;
	folderTombstones: Record<string, FolderTombstone>;
	moves: Record<string, IndexMove>;
	appliedMutationSeq: Record<string, number>;
	maintenance?: IndexMaintenance;
}

interface LocalSyncState {
	version: 1;
	observedEpoch: string | null;
	observedRevision: number;
	files: Record<string, FileMetadata>; // Last applied baseline
	nextMutationSeq: number;
}

interface FileMetadata {
	path: string; // Путь к файлу
	sha256: string; // SHA256 хеш содержимого
	size: number; // Размер в байтах
	mtime: number; // Время модификации
	syncedAt: number; // Время последней синхронизации
	deleted?: boolean; // Флаг удаления
	deletedAt?: number; // Время удаления
	changedRevision?: number;
	baseRevision?: number;
}
```

**Хранение и транзакция:**

`LocalSyncState`, FIFO-очередь мутаций, durable watcher events и очередь
незавершённых физических действий хранятся атомарно в `data.json`. Чтение
canonical index не продвигает `observedRevision`: она меняется только после
полного успешного reconciliation. Мутации нумеруются
монотонным `seq` для каждого устройства, а индекс хранит только непрерывный
high-watermark `appliedMutationSeq`.
Авторитетное состояние находится в одном файле
`.obsidian-sync-index.json` на Яндекс Диске. Для записи файл атомарно
перемещается в уникальное `.obsidian-sync-index.lock.<transactionId>`,
обновляется и перемещается обратно с `overwrite=false`. Неизменившийся за две
минуты единственный lock восстанавливается другим устройством. Несколько lock
или lock с той же ревизией, но другим содержимым, блокируют обычную
синхронизацию до явного Force sync. Список lock читается с полной пагинацией;
транзакция требует два последовательных одинаковых снимка root listing.

`SyncCoordinator` последовательно выполняет full, Force, realtime batch и
encryption maintenance. Повторные full-запросы объединяются в один запуск.
Watcher использует один durable drain для upload, delete, rename и folder
events. Перед постановкой full sync в очередь локальный `prepare`-этап
замораживает новые realtime-сессии и завершает destructive/rename events,
существовавшие на cutoff. Upload-события cutoff покрывает full barrier.
Acknowledgement и causal rebase выполняются в `settle` до освобождения
coordinator-сессии и сохраняются в `data.json`. Missing-target rename без
remote side effects может быть отложен до конца full: уже подтверждённый или
логически вытесненный путь поглощается по свежему local/canonical состоянию,
а неоднозначный causal source оставляет full неуспешной. После resume
автоматически запускаются только события, созданные либо изменённые во время
паузы; неуспешная сессия ничего не подтверждает и не replay-ит.

Если rename появляется во время уже submitted upload, watcher сохраняет
локальную связь между ID событий и mutation sequence. Upload, принятый
canonical, передаёт rename подтверждённую revision внутри coordinator
settlement; upload до commit retarget-ится с сохранением FIFO sequence. Full
barrier не поглощает upload, на который ссылается rename: вся причинная цепочка
должна завершиться до reconciliation. После realtime upload проверяются только
затронутые physical paths; полный remote-tree scan остаётся обязанностью full
sync для external edit и orphan detection.

Startup является обычной coordinator-сессией `fullSync({ startup: true })`.
Watcher durable-буфер включается до первого чтения encryption manifest.
Manifest и canonical читаются единым stable raw-примитивом
`metadata → download → metadata`; неизменность подтверждается по `sha256`,
затем `md5`, затем паре `server modified + size`. Canonical и lock находятся
одним стабильным root listing, после чего physical tree сканируется отдельно
с ограниченной параллельностью папок. Перед записью manifest проверяется по
session token; для строгого no-op финальный запрос не выполняется.

Индекс v1/v2 не мигрируется обычной синхронизацией: пользователь должен
обновить все устройства до 2.0.0-beta.11 и явно выполнить Force sync.

### SyncEngine (sync/sync-engine.ts)

Основной движок синхронизации. Координирует весь процесс.

**Алгоритм полной синхронизации:**

```
1. Загрузить canonical index и возобновить durable physical actions
2. Построить локальный снимок vault
3. Получить список файлов с Яндекс Диска
4. Сравнить индексы и определить операции
5. Для удалений сначала зафиксировать tombstone в удалённом индексе
6. Выполнить upload/download; перед delete повторно проверить canonical и
   server fingerprint
7. Согласовать pending put с выбранным состоянием: совпавшие SHA подтверждаются
   watermark, вытесненные операции становятся локальными `noop`
8. Подтвердить непрерывный mutation `seq` и удалить его из локальной очереди
9. Завершить сохранённые `PendingPhysicalAction` после фактического действия
10. Подтвердить captured upload-события watcher только после успешного full
```

**Логика определения операций:**

| Локально               | На диске                 | Действие      |
| ---------------------- | ------------------------ | ------------- |
| Новый файл             | Нет                      | Upload        |
| Нет                    | Новый файл               | Download      |
| Изменён от baseline    | Не изменён от baseline   | Upload        |
| Не изменён от baseline | Изменён canonical/remote | Download      |
| Изменены обе стороны   | Изменены обе стороны     | Conflict copy |
| Удалён                 | Есть                     | Delete remote |
| Есть                   | Удалён                   | Delete local  |

### ConflictResolver (sync/conflict-resolver.ts)

Разрешение конфликтов синхронизации.

**Правила:**

- локальное изменение определяется по SHA-256;
- удалённое изменение определяется сначала по server fingerprint, затем по
  любому изменению server mtime относительно baseline;
- точечное удаление побеждает конкурентное изменение, изменённая локальная
  копия сохраняется в backup;
- новый или изменённый потомок переживает конкурентное удаление папки;
- неизменённый потомок удаляется;
- локальный файл без baseline на первой синхронизации считается новым; при
  разных файлах с одинаковым путём создаётся conflict copy.

### FileWatcher (sync/file-watcher.ts)

Отслеживание изменений файлов в реальном времени.

**События:**

- `vault.on('create')` — создание файла → upload
- `vault.on('modify')` — изменение файла → upload (с debounce)
- `vault.on('delete')` — удаление файла → delete remote
- `vault.on('rename')` — переименование → move remote
- события удаления/rename папок объединяются в одну префиксную мутацию
- пользовательские события во время полной синхронизации буферизуются, а
  события, созданные самим движком, подавляются по зарегистрированному пути
- каждое файловое событие сохраняется в `data.json` с `id`, `epoch`,
  `baseRevision` и временем создания до постановки realtime-сессии
- modify заменяет ещё не начатый upload того же пути; быстрые file rename
  coalesce до конечного target; successor running-rename получает
  подтверждённую canonical revision либо безопасно rebase-ится, если
  промежуточный target исчез до remote-действий; повторно созданный old path
  остаётся отдельным событием
- событие удаляется только по ID после результата `completed` или
  `superseded`; acknowledgement сохраняется внутри исходной
  coordinator-сессии, а `retry` остаётся в durable-очереди

**Debouncing:**

- Задержка 2-3 секунды после последнего изменения
- Предотвращает множественные загрузки при быстром наборе текста

### SyncScheduler (sync/sync-scheduler.ts)

Планировщик периодической синхронизации.

- Запуск полной синхронизации по таймеру
- Настраиваемый интервал (0 = отключено)
- Автоматическая остановка при выгрузке плагина

## Потоки данных

### Реал-тайм синхронизация

```
[Пользователь редактирует файл]
         ↓
[FileWatcher: событие modify]
         ↓
[Debounce (2-3 сек)]
         ↓
[SyncEngine.uploadFile()]
         ↓
[YandexClient.uploadFile()]
         ↓
[Обновление индексов]
```

### Полная синхронизация

```
[Таймер / Команда "Sync now"]
         ↓
[SyncEngine.fullSync()]
         ↓
[IndexManager: построить локальный индекс]
         ↓
[IndexManager: загрузить удалённый индекс]
         ↓
[YandexClient: получить список файлов с диска]
         ↓
[Сравнение и генерация операций]
         ↓
[Выполнение операций (upload/download/delete)]
         ↓
[Сохранение индексов]
```

## Обработка ошибок

### Retry логика

```typescript
// Exponential backoff для API ошибок
const delays = [1000, 2000, 4000, 8000, 16000]; // мс

async function requestWithRetry(fn, maxRetries = 5) {
	for (let i = 0; i < maxRetries; i++) {
		try {
			return await fn();
		} catch (error) {
			if (isRetryable(error) && i < maxRetries - 1) {
				await sleep(delays[i]);
				continue;
			}
			throw error;
		}
	}
}
```

### Обрабатываемые ошибки

- `429 Too Many Requests` — retry с задержкой
- `503 Service Unavailable` — retry с задержкой
- `401 Unauthorized` — показать ошибку токена
- `404 Not Found` — ресурс не существует (нормально для новых файлов)
- Network errors — retry

## Безопасность

### Хранение токена

OAuth токен хранится в `data.json` плагина. Рекомендации:

- Не коммитить data.json в git
- Использовать токен с минимальными правами
- Учитывать, что token хранится в открытом виде: у мобильных плагинов Obsidian
  нет переносимого доступа к системному хранилищу ключей

### Валидация путей

- Нормализация путей через Obsidian API
- Проверка на path traversal атаки
- Фильтрация недопустимых символов

## Производительность

### Оптимизации

- **Инкрементальная синхронизация** — сравнение по SHA256 хешам
- **Debouncing** — предотвращение частых операций
- **Параллельные операции** — несколько файлов одновременно (1-20 concurrency)
- **Кэширование индексов** — локальное хранение для быстрого старта
- **Кэширование папок** — избежание повторных запросов к API
- **Preflight создание папок** — заблаговременная подготовка структуры
- **Параллельное вычисление хешей** — 10x ускорение для больших хранилищ

### Рекомендации

- Исключайте большие бинарные файлы из синхронизации
- Используйте интервал синхронизации 5-15 минут
- Не синхронизируйте папку `.obsidian` если не нужно

## Расширение

### Добавление новой стратегии конфликтов

```typescript
// В conflict-resolver.ts
class ConflictResolver {
	resolve(local: FileMetadata, remote: FileMetadata): SyncAction {
		switch (this.strategy) {
			case "myNewStrategy":
				return this.myNewStrategyLogic(local, remote);
			// ...
		}
	}

	private myNewStrategyLogic(
		local: FileMetadata,
		remote: FileMetadata,
	): SyncAction {
		// Ваша логика
	}
}
```

### Добавление нового провайдера хранилища

Создайте класс, реализующий интерфейс:

```typescript
interface StorageClient {
	getResource(path: string): Promise<ResourceMetadata | null>;
	listFolder(path: string): Promise<ResourceMetadata[]>;
	uploadFile(path: string, content: ArrayBuffer): Promise<void>;
	downloadFile(path: string): Promise<ArrayBuffer>;
	deleteResource(path: string): Promise<void>;
	moveResource(from: string, to: string): Promise<void>;
}
```

## Тестирование

### Ручное тестирование

1. Создайте тестовый vault
2. Настройте плагин с тестовым токеном
3. Проверьте сценарии:
    - Создание/редактирование/удаление файлов
    - Конфликты (изменение на двух устройствах)
    - Офлайн → онлайн переход
    - Большие файлы

### Отладка

Включите **Настройки → Yandex Disk Sync → Логирование → Включить
отладочное логирование**. Журнал записывается в
`.obsidian/plugins/yandex-disk-sync/debug.log`, ограничивается 5 МБ и никогда
не включается в пользовательскую синхронизацию, даже если включена
синхронизация папки настроек.

Каждая сессия получает `sessionId`; canonical-транзакция дополнительно
получает `indexTransactionId`. На durable-границах журнал содержит epoch,
observed/canonical revision, mutation/action ID, ожидаемые fingerprint и фазы
перехода шифрования. Токены, пароли и ключи очищаются централизованно перед
выводом.

## Параллелизация операций

Начиная с версии 1.1.0, плагин поддерживает параллельное выполнение операций синхронизации.

### Архитектура параллелизации

```
Sync Flow:
┌────────────────────────────────────────────────────────┐
│ 1. Preparation (sequential)                            │
│    - Build local index (parallel hash computation)     │
│    - Load remote index                                 │
│    - Determine operations                              │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 2. Preflight (sequential by depth)                     │
│    - Collect all required folders                      │
│    - Create folders level by level                     │
│    - Cache created folders                             │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 3. Parallel Execution (with Semaphore)                 │
│    ┌──────────────────────────────────────────────┐   │
│    │ Uploads      (parallel, concurrency=N)       │   │
│    └──────────────────────────────────────────────┘   │
│    ┌──────────────────────────────────────────────┐   │
│    │ Downloads    (parallel, concurrency=N)       │   │
│    └──────────────────────────────────────────────┘   │
│    ┌──────────────────────────────────────────────┐   │
│    │ Deletes      (parallel, concurrency=N)       │   │
│    └──────────────────────────────────────────────┘   │
│    ┌──────────────────────────────────────────────┐   │
│    │ Conflicts    (sequential)                    │   │
│    └──────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│ 4. Finalization (sequential)                           │
│    - Update sync time                                  │
│    - Save remote index                                 │
│    - Cleanup old deleted records                       │
└────────────────────────────────────────────────────────┘
```

### Ключевые компоненты

#### Semaphore (utils/semaphore.ts)

Контролирует количество одновременно выполняемых операций:

```typescript
class Semaphore {
	private permits: number;
	async acquire(): Promise<void>;
	release(): void;
}
```

#### runWithConcurrency / runWithConcurrencySettled

Утилитные функции для параллельного выполнения задач с ограничением concurrency:

```typescript
// Прерывается при первой ошибке
await runWithConcurrency(tasks, maxConcurrency, onProgress);

// Выполняет все задачи, собирает ошибки
await runWithConcurrencySettled(tasks, maxConcurrency, onProgress);
```

### Оптимизации

1. **Параллельное вычисление хешей**
    - Вычисление SHA256 для всех файлов происходит параллельно (concurrency=10)
    - Ускорение в ~10x для больших хранилищ

2. **Preflight создание папок**
    - Все папки создаются заранее перед началом загрузки
    - Позволяет параллельно загружать файлы без проверки папок
    - Кэширование созданных папок предотвращает повторные запросы

3. **Folder caching в YandexDiskClient**
    - Кэш созданных папок (`folderCache: Set<string>`)
    - Проверка кэша перед каждым API запросом
    - Автоматическое добавление в кэш при 409 (Already Exists)

4. **Группировка операций**
    - Операции группируются по типам (upload/download/delete/conflict)
    - Каждая группа выполняется параллельно
    - Conflicts обрабатываются последовательно (требуют особой логики)

### Настройки производительности

**maxConcurrency** (1-20, по умолчанию 10):

- Контролирует количество одновременных операций
- Можно настроить через Settings → Automatic sync
- Рекомендуемые значения:
    - 1-3: медленное соединение
    - 5-7: стандартное соединение
    - 8-15: быстрое соединение
    - 16-20: очень быстрое соединение

### Производительность

Бенчмарки (maxConcurrency=5):

| Операция                      | Последовательно | Параллельно | Ускорение |
| ----------------------------- | --------------- | ----------- | --------- |
| 100 uploads                   | ~100 сек        | ~20 сек     | 5x        |
| 50 uploads + 50 downloads     | ~100 сек        | ~15 сек     | 6.7x      |
| Вычисление хешей (500 файлов) | ~50 сек         | ~5 сек      | 10x       |

Подробнее см. [PARALLELIZATION.md](./PARALLELIZATION.md)

## Система резервного копирования

Плагин включает встроенную систему резервного копирования для создания моментальных снимков хранилища.

### Архитектура бекапов

```
backup/
└── backup-manager.ts   # Управление резервным копированием
```

### BackupManager (backup/backup-manager.ts)

Отвечает за:

- Создание ZIP-архивов всех синхронизируемых файлов
- Загрузку бекапов на Яндекс.Диск в защищенную папку `.backup`
- Проверку созданного remote-файла по physical fingerprint
- Создание raw remote snapshot перед Force local

### Интеграция с синхронизацией

- Canonical index не содержит время или список backup
- Каждое устройство читает общий список напрямую из remote `.backup`
- Папка `.backup` жестко исключена из операций синхронизации

### Формат бекапов

- **Расширение**: `.zip`
- **Именование**: `backup_YYYY-MM-DD_HH-MM-SS.zip` для plaintext и
  `backup_YYYY-MM-DD_HH-MM-SS.enc.zip` при активном encryption codec
- **Содержимое**: Все файлы, подлежащие синхронизации
- **Расположение**: `{remotePath}/.backup/`

### Безопасность

- Папка `.backup` защищена от случайного удаления
- Фильтрация на уровне `path-utils` и `IndexManager`
- Бекапы не участвуют в конфликтах синхронизации

Подробнее см. [BACKUP.md](./BACKUP.md)

## Force Sync

Force Sync — функция принудительной синхронизации, игнорирующая все условия (даты модификации, хеши файлов, состояние индексов). Создаёт точную копию хранилища в указанном направлении.

### ForceSyncModal (ui/force-sync-modal.ts)

Модальное окно подтверждения перед выполнением Force Sync.

**Возможности:**

- Пояснение операции в зависимости от направления
- Предупреждение о деструктивности операции
- Единственная кнопка продолжения сначала создаёт обязательный бекап
- Кнопка отмены

### Force Sync From Local

Перезаписывает ВСЕ файлы на Яндекс.Диске локальными версиями. Файлы, отсутствующие локально, удаляются с диска.

**Алгоритм:**

```
1. Построить локальный индекс (сканирование vault)
2. Получить список файлов с Яндекс.Диска
3. Все локальные файлы → upload (принудительно)
4. Создать новый `epoch` и canonical snapshot только из локального vault
5. Удалить remote-only объекты guarded-действиями по fingerprint
6. Очистить старые locks только после подтверждённого replacement commit
```

### Force Sync From Remote

Перезаписывает ВСЕ локальные файлы версиями с Яндекс.Диска. Локальные файлы, отсутствующие на диске, удаляются.

**Алгоритм:**

```
1. Построить локальный индекс (для определения удаляемых файлов)
2. Получить фактический список файлов с Яндекс.Диска, не используя
   legacy/ambiguous index как источник истины
4. Все удалённые файлы → download (принудительно)
5. Все локальные файлы, которых нет на диске → delete_local
6. Создать новый `epoch`, canonical и local baseline из применённого remote
   snapshot
```

### Особенности реализации

- **Не использует ConflictResolver** — операции генерируются вручную без сравнения
- **Не использует сравнение mtime/sha256** — безусловная перезапись
- **Всегда требует backup** — Force local сохраняет raw remote snapshot,
  Force remote сохраняет локальный vault
- **FileWatcher приостанавливается** через существующие `syncPauseCallbacks`
- **Прогресс отображается** через штатную систему `updateState()`
- **Параллелизация** через `executeOperationsParallel()`

### UI в настройках

Секция **Force Sync** расположена в конце страницы настроек, после секции Backup:

- **From local to remote** — кнопка принудительной синхронизации из локального в удалённое
- **From remote to local** — кнопка принудительной синхронизации из удалённого в локальное

## TODO

- [x] Параллельная загрузка/скачивание файлов
- [x] Прогресс-бар для больших операций
- [x] Force Sync (From Local / From Remote)
- [ ] UI для просмотра истории конфликтов
- [ ] Перенести token в системное хранилище, если Obsidian предоставит
  переносимый API для desktop и mobile
- [ ] Поддержка Yandex Disk App Folder API
- [x] Unit и fake integration тесты
- [ ] Adaptive concurrency (автоматическое снижение при 429)

# Архитектура плагина Yandex Disk Sync

## Обзор

Плагин реализует двустороннюю синхронизацию файлов между локальным vault Obsidian и облачным хранилищем Яндекс Диск. Архитектура построена на модульном подходе с чётким разделением ответственности.

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
│   ├── conflict-resolver.ts # Разрешение конфликтов
│   ├── file-watcher.ts     # Отслеживание изменений файлов
│   └── sync-scheduler.ts   # Планировщик периодической синхронизации
│
├── ui/
│   ├── status-bar.ts       # Индикатор статуса в статус-баре
│   └── init-modal.ts       # Модальные окна
│
└── utils/
    ├── path-utils.ts       # Утилиты для работы с путями
    ├── hash-utils.ts       # Вычисление SHA256 хешей
    └── logger.ts           # Логирование
```

## Компоненты

### Main (main.ts)

Точка входа плагина. Отвечает за:
- Инициализацию всех компонентов
- Регистрацию команд
- Обработку жизненного цикла (onload/onunload)
- Координацию между модулями

### YandexDiskClient (api/yandex-client.ts)

HTTP клиент для взаимодействия с Yandex Disk REST API.

**Основные методы:**
- `getResource(path)` — получить метаданные файла/папки
- `listFolder(path)` — список файлов в папке
- `uploadFile(path, content)` — загрузить файл
- `downloadFile(path)` — скачать файл
- `deleteResource(path)` — удалить файл/папку
- `moveResource(from, to)` — переместить/переименовать

**Особенности реализации:**
- Двухшаговая загрузка файлов (получение upload URL → PUT контента)
- Автоматический retry с exponential backoff для 429/503 ошибок
- Пагинация для больших директорий
- Обработка rate limiting

### VaultAdapter (api/vault-adapter.ts)

Адаптер для работы с файловой системой Obsidian Vault.

**Основные методы:**
- `getAllSyncableFiles()` — получить все файлы для синхронизации
- `readFile(path)` — читать содержимое файла
- `writeFile(path, content)` — записать файл
- `deleteFile(path)` — удалить файл
- `renameFile(from, to)` — переименовать файл

**Особенности:**
- Фильтрация по include/exclude паттернам
- Поддержка конфигурируемой папки настроек Obsidian
- Использование FileManager.trashFile() для удаления

### IndexManager (sync/index-manager.ts)

Управление индексами синхронизации.

**Структура индекса:**
```typescript
interface SyncIndex {
  version: number;           // Версия формата индекса
  lastSyncTime: number;      // Время последней синхронизации
  deviceId: string;          // ID устройства
  files: Record<string, FileMetadata>;
}

interface FileMetadata {
  path: string;              // Путь к файлу
  sha256: string;            // SHA256 хеш содержимого
  size: number;              // Размер в байтах
  mtime: number;             // Время модификации
  syncedAt: number;          // Время последней синхронизации
  deleted?: boolean;         // Флаг удаления
  deletedAt?: number;        // Время удаления
}
```

**Два индекса:**
1. **Локальный индекс** — хранится в data.json плагина
2. **Удалённый индекс** — файл `.sync-index.json` на Яндекс Диске

### SyncEngine (sync/sync-engine.ts)

Основной движок синхронизации. Координирует весь процесс.

**Алгоритм полной синхронизации:**

```
1. Построить локальный индекс (сканирование vault)
2. Загрузить удалённый индекс с Яндекс Диска
3. Получить список файлов с Яндекс Диска
4. Сравнить индексы и определить операции
5. Выполнить операции (upload/download/delete)
6. Сохранить обновлённые индексы
```

**Логика определения операций:**

| Локально | На диске | Действие |
|----------|----------|----------|
| Новый файл | Нет | Upload |
| Нет | Новый файл | Download |
| Изменён (новее) | Есть | Upload |
| Есть | Изменён (новее) | Download |
| Удалён | Есть | Delete remote |
| Есть | Удалён | Delete local |

### ConflictResolver (sync/conflict-resolver.ts)

Разрешение конфликтов синхронизации.

**Стратегии:**
- `newerWins` — более новый файл по mtime побеждает
- `localWins` — локальная версия имеет приоритет
- `remoteWins` — удалённая версия имеет приоритет
- `keepBoth` — создать копию с суффиксом `.conflict`

### FileWatcher (sync/file-watcher.ts)

Отслеживание изменений файлов в реальном времени.

**События:**
- `vault.on('create')` — создание файла → upload
- `vault.on('modify')` — изменение файла → upload (с debounce)
- `vault.on('delete')` — удаление файла → delete remote
- `vault.on('rename')` — переименование → move remote

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
- В будущем: интеграция с SecretStorage Obsidian

### Валидация путей

- Нормализация путей через Obsidian API
- Проверка на path traversal атаки
- Фильтрация недопустимых символов

## Производительность

### Оптимизации

- **Инкрементальная синхронизация** — сравнение по SHA256 хешам
- **Debouncing** — предотвращение частых операций
- **Параллельные операции** — несколько файлов одновременно (TODO)
- **Кэширование индексов** — локальное хранение для быстрого старта

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
      case 'myNewStrategy':
        return this.myNewStrategyLogic(local, remote);
      // ...
    }
  }
  
  private myNewStrategyLogic(local: FileMetadata, remote: FileMetadata): SyncAction {
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

Включите логирование в консоли разработчика:

```javascript
// В logger.ts уровень debug
logger.setLevel('debug');
```

## TODO

- [ ] Параллельная загрузка/скачивание файлов
- [ ] Прогресс-бар для больших операций
- [ ] UI для просмотра истории конфликтов
- [ ] Интеграция с SecretStorage для токена
- [ ] Поддержка Yandex Disk App Folder API
- [ ] Unit и integration тесты

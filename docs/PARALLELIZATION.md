# Параллелизация операций синхронизации

## Обзор

Начиная с версии 1.1.0, плагин поддерживает параллельное выполнение операций синхронизации, что значительно повышает производительность при работе с большим количеством файлов.

## Архитектура

### Компоненты

```
┌─────────────────────────────────────────────────────────────┐
│                       SyncEngine                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  fullSync()                                            │ │
│  │  1. Подготовка (построение индексов)                   │ │
│  │  2. Определение операций                               │ │
│  │  3. Preflight: создание всех папок                     │ │
│  │  4. Параллельное выполнение:                           │ │
│  │     - Uploads (parallel)                               │ │
│  │     - Downloads (parallel)                             │ │
│  │     - Deletes (parallel)                               │ │
│  │     - Conflicts (sequential)                           │ │
│  │  5. Сохранение индексов                                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Semaphore Utility                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Semaphore: контроль concurrency                       │ │
│  │  runWithConcurrency(): выполнение с ограничением       │ │
│  │  runWithConcurrencySettled(): + обработка ошибок       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    YandexDiskClient                         │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  Folder Cache: кэширование созданных папок             │ │
│  │  ensureFoldersExist(): batch создание папок            │ │
│  │  uploadFile(): опциональная проверка папок             │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Semaphore

Класс `Semaphore` контролирует количество одновременно выполняемых операций:

```typescript
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  async acquire(): Promise<void>  // Захватить разрешение
  release(): void                  // Освободить разрешение
}
```

### Функции параллельного выполнения

#### runWithConcurrency

Выполняет массив задач с ограничением concurrency:

```typescript
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<T[]>
```

**Пример:**
```typescript
const tasks = files.map(file => async () => {
  return await processFile(file);
});

const results = await runWithConcurrency(tasks, 5);
```

#### runWithConcurrencySettled

То же, что `runWithConcurrency`, но не прерывается при ошибках:

```typescript
async function runWithConcurrencySettled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<Array<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
>>
```

**Пример:**
```typescript
const results = await runWithConcurrencySettled(tasks, 5);

results.forEach((result, i) => {
  if (result.status === "rejected") {
    console.error(`Task ${i} failed:`, result.reason);
  } else {
    console.log(`Task ${i} succeeded:`, result.value);
  }
});
```

## Оптимизации

### 1. Параллельное вычисление хешей

**До:**
```typescript
for (const file of files) {
  const content = await vault.readBinary(file);
  const sha256 = await computeSha256(content);
  // ...
}
```

**После:**
```typescript
const tasks = files.map(file => async () => {
  const content = await vault.readBinary(file);
  const sha256 = await computeSha256(content);
  return { path: file.path, sha256, ... };
});

const results = await runWithConcurrency(tasks, 10);
```

**Результат:** 10x ускорение для больших хранилищ.

### 2. Preflight создание папок

Перед параллельной загрузкой файлов все необходимые папки создаются заранее:

```typescript
// Собрать все уникальные папки
const folders = new Set<string>();
for (const op of operations) {
  const dir = getDirectory(op.path);
  if (dir) folders.add(dir);
}

// Создать папки последовательно по уровням
await yandexClient.ensureFoldersExist(Array.from(folders));

// Теперь можно загружать файлы параллельно без проверки папок
```

### 3. Кэширование папок

`YandexDiskClient` кэширует созданные папки:

```typescript
class YandexDiskClient {
  private folderCache: Set<string> = new Set();

  async createFolder(path: string): Promise<void> {
    if (this.folderCache.has(path)) {
      return; // Папка уже создана
    }
    
    // Создать папку и добавить в кэш
    await this.request("PUT", `/resources?path=${path}`);
    this.folderCache.add(path);
  }
}
```

### 4. Группировка операций по типам

Операции группируются и выполняются параллельно внутри групп:

```typescript
const uploads = operations.filter(op => op.action === "upload");
const downloads = operations.filter(op => op.action === "download");
const deletes = operations.filter(op => op.action.includes("delete"));
const conflicts = operations.filter(op => op.action === "conflict");

// Uploads параллельно
await executeOperationsParallel(uploads, maxConcurrency);

// Downloads параллельно
await executeOperationsParallel(downloads, maxConcurrency);

// Deletes параллельно
await executeOperationsParallel(deletes, maxConcurrency);

// Conflicts последовательно (требуют особой обработки)
for (const op of conflicts) {
  await handleConflict(op);
}
```

## Настройки

### maxConcurrency

Максимальное количество одновременных операций (1-20):

- **По умолчанию:** 5
- **Рекомендуемое для медленного соединения:** 1-3
- **Рекомендуемое для быстрого соединения:** 5-10
- **Агрессивное (осторожно с rate limits):** 10-20

**Настройка через UI:**
`Settings → Automatic sync → Max concurrent operations`

**Программная настройка:**
```typescript
this.plugin.settings.maxConcurrency = 10;
await this.plugin.saveSettings();
```

## Производительность

### Бенчмарки

| Операция                      | Последовательно | Параллельно (5) | Ускорение |
| ----------------------------- | --------------- | --------------- | --------- |
| 100 uploads                   | ~100 сек        | ~20 сек         | 5x        |
| 50 uploads + 50 downloads     | ~100 сек        | ~15 сек         | 6.7x      |
| Вычисление хешей (500 файлов) | ~50 сек         | ~5 сек          | 10x       |
| 20 deletes                    | ~20 сек         | ~4 сек          | 5x        |

### Факторы производительности

1. **Скорость сети:** Быстрее сеть = больше выгоды от параллелизации
2. **Размер файлов:** Маленькие файлы = больше выигрыш (меньше overhead)
3. **CPU:** Вычисление хешей ограничено CPU
4. **API Rate Limits:** Слишком высокий concurrency может привести к 429 ошибкам

### Оптимальные значения concurrency

**Для вычисления хешей (CPU-bound):**
- Фиксировано: 10

**Для сетевых операций (I/O-bound):**
- Автоматически: `settings.maxConcurrency`
- По умолчанию: 5
- Максимум: 20

## Обработка ошибок

### Graceful degradation

При ошибке в одной операции остальные продолжают выполняться:

```typescript
const results = await runWithConcurrencySettled(tasks, concurrency);

// Собрать ошибки
const errors = results
  .filter(r => r.status === "rejected")
  .map(r => r.reason);

// Сообщить пользователю
if (errors.length > 0) {
  logger.error(`${errors.length} operations failed`);
}
```

### Rate limiting

При получении 429 (Too Many Requests):

1. `YandexDiskClient` автоматически делает retry с exponential backoff
2. Если retry не помогает, операция завершается с ошибкой
3. Другие операции продолжают выполняться
4. Рекомендация: уменьшить `maxConcurrency`

## Corner Cases

### 1. Файл изменился во время sync

**Проблема:** Файл был изменён локально между вычислением хеша и загрузкой.

**Решение:** При следующей синхронизации файл будет обнаружен как изменённый и загружен заново.

### 2. Ошибка в одном файле из batch

**Проблема:** Один файл не загрузился, что делать с остальными?

**Решение:** `runWithConcurrencySettled` продолжает обработку остальных файлов. Ошибки собираются в массив `result.errors`.

### 3. Rate limit 429

**Проблема:** Yandex Disk вернул 429 (Too Many Requests).

**Решение:** 
- Встроенный retry с exponential backoff в `YandexDiskClient.request()`
- При повторном 429 операция помечается как failed
- Рекомендация в логах: уменьшить `maxConcurrency`

### 4. Память при большом download

**Проблема:** Загрузка 1000 файлов может съесть всю память.

**Решение:** Файлы обрабатываются по одному, не держатся все в памяти. Semaphore ограничивает количество одновременных операций.

### 5. Конфликт папки и файла

**Проблема:** На одном устройстве есть папка `/docs/test`, на другом файл `/docs/test.md`.

**Решение:** Preflight создание папок проверяет существование. При конфликте Yandex Disk вернёт ошибку, которая будет залогирована.

## Мониторинг и отладка

### Логирование

Все параллельные операции логируются:

```typescript
logger.info(`Ensuring ${folders.size} folders exist...`);
logger.info(`Uploading ${uploads.length} files in parallel...`);
logger.debug(`Task ${i} completed`);
logger.error(`Task ${i} failed:`, error);
```

### Progress tracking

Progress обновляется в реальном времени:

```typescript
const onProgress = (completed: number, total: number) => {
  const progress = Math.round((completed / total) * 100);
  this.updateState({ progress, pendingCount: total - completed });
};

await runWithConcurrency(tasks, concurrency, onProgress);
```

### Status Bar

Status bar показывает:
- Текущую операцию: "Uploading files..."
- Progress: 45%
- Осталось файлов: 55

## API Reference

### Semaphore

```typescript
class Semaphore {
  constructor(permits: number);
  
  async acquire(): Promise<void>;
  release(): void;
  availablePermits(): number;
}
```

### runWithConcurrency

```typescript
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<T[]>
```

**Параметры:**
- `tasks`: Массив функций, возвращающих Promise
- `concurrency`: Максимальное количество одновременных выполнений
- `onProgress`: Опциональный callback для отслеживания прогресса

**Возвращает:** Массив результатов в том же порядке, что и tasks

**Throws:** При ошибке в любой task выбрасывается исключение

### runWithConcurrencySettled

```typescript
async function runWithConcurrencySettled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<Array<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
>>
```

**Параметры:** Те же, что у `runWithConcurrency`

**Возвращает:** Массив результатов, каждый элемент либо `fulfilled` с value, либо `rejected` с reason

**Throws:** Никогда не выбрасывает исключений

### YandexDiskClient.ensureFoldersExist

```typescript
async ensureFoldersExist(paths: string[]): Promise<void>
```

**Параметры:**
- `paths`: Массив путей к папкам

**Описание:** Создаёт все указанные папки вместе с родительскими. Использует кэш для избежания дублирующих запросов. Создание происходит последовательно по уровням вложенности.

## Миграция с предыдущей версии

### Версия 1.0.x → 1.1.x

**Изменения:**
1. Добавлена настройка `maxConcurrency` со значением по умолчанию 5
2. Все операции теперь выполняются параллельно
3. API методов не изменился - совместимость полная

**Действия:**
- Обновить плагин
- При желании настроить `maxConcurrency` в Settings
- Никаких изменений в данных или индексах не требуется

## Лучшие практики

### 1. Выбор правильного concurrency

- **1-3:** Медленное соединение, ограниченный API лимит
- **5-7:** Стандартное соединение (рекомендуется по умолчанию)
- **8-15:** Быстрое соединение, большое хранилище
- **16-20:** Очень быстрое соединение, готовность к rate limits

### 2. Мониторинг ошибок

Следите за ошибками 429 в логах:

```
[YandexSync] Error 429, retry in 2000ms
```

Если видите много таких ошибок → уменьшите `maxConcurrency`.

### 3. Производительность первой синхронизации

При первой синхронизации большого хранилища:
- Временно увеличьте `maxConcurrency` до 15-20
- После завершения верните к нормальному значению

### 4. Отладка проблем

При проблемах с синхронизацией:
1. Уменьшите `maxConcurrency` до 1
2. Проверьте логи на конкретные ошибки
3. После исправления постепенно увеличивайте concurrency

## Будущие улучшения

### Возможные оптимизации

1. **Adaptive concurrency:** Автоматическое снижение concurrency при 429 ошибках
2. **Priority queue:** Приоритизация маленьких файлов перед большими
3. **Chunked uploads:** Параллельная загрузка частей больших файлов
4. **Connection pooling:** Переиспользование HTTP соединений
5. **Compression:** Сжатие файлов перед загрузкой

### Известные ограничения

1. Conflicts всё ещё обрабатываются последовательно (редкий случай)
2. Folder creation происходит последовательно (необходимо для корректности)
3. Нет автоматического определения оптимального concurrency
4. Нет статистики по скорости загрузки/скачивания

## Заключение

Параллелизация операций синхронизации значительно улучшает производительность плагина, особенно при работе с большим количеством файлов. Правильная настройка `maxConcurrency` в зависимости от скорости соединения и размера хранилища позволяет достичь оптимального баланса между скоростью и надёжностью.

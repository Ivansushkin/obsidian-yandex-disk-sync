# E2E шифрование плагина Yandex Disk Sync

## 1. Архитектура

Сквозное шифрование на основе **Web Crypto API** (`window.crypto.subtle`).
Контент файлов и их имена шифруются перед отправкой на Яндекс.Диск,
расшифровываются после загрузки. Ключ деривируется из пароля пользователя
через PBKDF2.

```
User password
    | PBKDF2 (100k итераций, HMAC-SHA256)
Master Key (AES-256, in memory only)
    |
    +---> EncryptionService.encrypt(data)       -- AES-GCM, случайный IV
    +---> EncryptionService.encryptFilename()   -- AES-GCM, детерминированный IV
```

## 2. Модули

### 2.1 EncryptionService (`src/crypto/encryption.ts`)

Ядро криптографии. Не имеет внешних зависимостей, использует только
Web Crypto API.

| Метод                            | Назначение                                                            |
| -------------------------------- | --------------------------------------------------------------------- |
| `constructor(salt)`              | Сохраняет соль для PBKDF2                                             |
| `initializeKey(password)`        | PBKDF2(100k, salt, HMAC-SHA256) -> AES-256-GCM raw key                |
| `encrypt(data)`                  | Случайный 12-byte IV -> AES-GCM -> `[IV][ciphertext + auth_tag]`      |
| `decrypt(data)`                  | Выделить IV[0:12] -> AES-GCM decrypt                                  |
| `encryptFilename(path)`          | IV = SHA256(path + ":iv:" + salt).slice(0,12) -> AES-GCM -> Base64URL |
| `decryptFilename(enc)`           | Base64URL decode -> восстановить IV -> AES-GCM decrypt                |
| `static generateSalt()`          | `crypto.getRandomValues(16)`                                          |

#### 2.1.1 Шифрование контента

Формат зашифрованных данных на диске:

```
offset  0..11:    IV (12 bytes, случайный, crypto.getRandomValues)
offset 12..end:   AES-GCM output (ciphertext + 16-byte authentication tag)
```

#### 2.1.2 Шифрование имён файлов

IV генерируется **детерминированно**:

```
iv_data = SHA-256(originalPath + ":iv:" + salt)
iv      = iv_data[0..11]   // первые 12 байт
```

Детерминированность гарантирует, что один и тот же путь всегда шифруется
в одно и то же имя. Это необходимо для обратимого маппинга при синхронизации.

Результат шифрования — `Base64URL(ciphertext + tag)` без паддинга.
IV не хранится в результате (восстанавливается на лету).

### 2.2 YandexDiskClient (`src/api/yandex-client.ts`)

Внедрение прозрачного шифрования на уровне API-клиента.

```typescript
private encryptionService: EncryptionService | null = null;

setEncryptionService(service: EncryptionService | null): void {
    this.encryptionService = service;
}
```

**Правила трансформации путей:**

При активном `encryptionService`:

| Метод                   | Контент | Путь (filename)              | Ответ                                   |
| ----------------------- | ------- | ---------------------------- | --------------------------------------- |
| `uploadFile`            | encrypt | encryptFilename              | --                                     |
| `downloadFile`          | decrypt | encryptFilename              | --                                     |
| `deleteResource`        | --      | encryptFilename              | --                                     |
| `moveResource`          | --      | encryptFilename (from + to)  | --                                     |
| `copyResource`          | --      | encryptFilename (from + to)  | --                                     |
| `getResource`           | --      | encryptFilename              | decryptFilename(path + name)            |
| `getResourcesRecursive` | --      | encryptFilename (root)       | decryptFilename(path + name) всех items |
| `createFolder`          | --      | encryptFilename              | --                                     |
| `ensureFoldersExist`    | --      | encryptFilename (всех папок) | --                                     |

Шифруется только имя файла/папки (последний компонент пути), не весь путь.
Для `getResourcesRecursive` требуется расшифровка `resource.path` и `resource.name`
в каждом ответе.

**Исключения:**

- `.obsidian-sync-index.json` — путь не шифруется (чтобы индекс был находим без пароля).
  Контент шифруется штатно.
- `.obsidian-encrypt.json` — файл соли, всегда RAW (без шифрования), так как на момент
  его чтения encryption service ещё не инициализирован.

### 2.3 SyncEngine (`src/sync/sync-engine.ts`)

Добавляется поддержка прогресса для обратной связи при длительном шифровании:

```typescript
private encryptionProgressCallback: ((filename: string, progress: number) => void) | null = null;

setEncryptionProgressCallback(cb): void;
```

Прогресс-колбэк вызывается в циклах `uploadFile()` внутри `fullSync()`
и `forceSyncFromLocal()`: `(processedCount / totalCount * 100)`.

### 2.4 main.ts

Управление жизненным циклом шифрования.

#### Инициализация (`onload()`)

```typescript
private async initEncryption(): Promise<void> {
    if (!this.settings.enableEncryption
        || !this.settings.encryptionSalt
        || !this.settings.encryptedPassword
    ) return;

    const salt = EncryptionService.base64ToBytes(this.settings.encryptionSalt);
    const service = new EncryptionService(salt);
    await service.initializeKey(this.settings.encryptedPassword);
    this.encryptionService = service;
    this.yandexClient.setEncryptionService(service);
}
```

Пароль хранится в `encryptedPassword` как plaintext string (не base64).

#### enableEncryption(password)

Адаптивный метод — проверяет remote salt:

```typescript
async enableEncryption(password: string): Promise<void> {
    const remoteSalt = await this.indexManager.downloadEncryptionSalt();
    if (remoteSalt) {
        // Remote уже зашифрован — используем ту же соль, верифицируем пароль
        saltBytes = EncryptionService.base64ToBytes(remoteSalt);
        isNewEncryption = false;
    } else {
        // Первое включение — генерируем новую соль
        saltBytes = EncryptionService.generateSalt();
        isNewEncryption = true;
    }
    // derive key...
    if (!isNewEncryption) {
        try {
            await this.indexManager.loadRemoteIndex();
        } catch {
            // Wrong password
            this.yandexClient.setEncryptionService(null);
            throw new Error(t("notice.encryption_wrong_password"));
        }
    }
    // Для isNewEncryption: uploadSalt, forceSyncFromLocal, cleanup old plaintext
}
```

#### disableEncryption(options?)

```typescript
async disableEncryption(options?: { reuploadPlaintext?: boolean }): Promise<void> {
    this.encryptionService = null;
    this.yandexClient.setEncryptionService(null);

    if (options?.reuploadPlaintext) {
        await this.syncEngine.forceSyncFromLocal();
    }

    this.settings.enableEncryption = false;
    this.settings.encryptionSalt = null;
    this.settings.encryptedPassword = null;
    await this.saveSettings();
    await this.indexManager.deleteEncryptionSalt();
}
```

При выключении (toggle OFF): `disableEncryption({ reuploadPlaintext: true })`.
При смене пароля: `disableEncryption()` (без аргументов).

#### syncEncryptionStateWithRemote()

Вызывается в `onLayoutReady()` для multi-device сценария:

1. Проверить remote salt
2. Если salt есть, а локально encryption выключен — запросить пароль через `PasswordPromptModal`
3. Верифицировать пароль через `loadRemoteIndex()`
4. Если успешно — сохранить локально

### 2.5 encryption-modals.ts (`src/ui/encryption-modals.ts`)

Все модалки шифрования — классы, наследующие `Modal`:

| Класс                   | Назначение                                          | Кол-во полей | Кнопки                                                   |
| ----------------------- | --------------------------------------------------- | ------------ | -------------------------------------------------------- |
| `EnableEncryptionModal` | Включение шифрования (новый пароль)                 | 2 (pw + confirm) | Create backup + enable / Enable without backup / Cancel |
| `DisableEncryptionModal`| Подтверждение отключения                            | 0            | Yes (Cta) / Cancel                                       |
| `VerifyPasswordModal`   | Верификация текущего пароля (смена пароля)          | 1            | Confirm (Cta) / Cancel                                   |
| `PasswordPromptModal`   | Запрос пароля для multi-device входа                | 1            | Create backup + continue / Continue without backup / Cancel |
| `ChangePasswordModal`   | Ввод нового пароля при смене                        | 2 (pw + confirm) | Change password (Cta) / Cancel                         |

Общий паттерн для всех модалок:

- `private finish(value)` — разрешает Promise с защитой от повторного вызова (`resolved` guard)
- `onClose()` — прототипный метод, вызывает `finish(null/false)` как fallback
- Кнопки вызывают `this.finish(value)` **до** `this.close()`, чтобы `onClose()` не перезаписал результат
- `Setting` + `addButton()` + класс `force-sync-modal-buttons` для вертикального расположения кнопок

**VerifyPasswordModal:** при неверном пароле не закрывается — подсвечивает инпут классом `is-error`,
очищает поле и показывает `new Notice()`. `oninput` снимает `is-error`.

### 2.6 settings.ts

Секция **Encryption** в настройках (после Force Sync, перед File filters):

- Toggle "Enable encryption"
  - ON: `EnableEncryptionModal` -> persistent notice -> `enableEncryption(password)` -> `Notice(encryption_enabled)`
  - OFF: `DisableEncryptionModal` -> persistent notice -> `disableEncryption({ reuploadPlaintext: true })` -> `Notice(encryption_disabled)`
- При активном шифровании: кнопка "Change password"
  - `VerifyPasswordModal(correctPassword)` -> `ChangePasswordModal` -> persistent notice -> `disableEncryption()` + `enableEncryption(newPassword)` -> `Notice(encryption_enabled)`
- Информационный блок после toggle/change-password:
  - Описание принципа работы (AES-256-GCM + PBKDF2)
  - Warning о безвозвратной потере данных при утере пароля
  - Уведомление, что пароль хранится локально и не отправляется на удалённое хранилище

### 2.7 IndexManager (`src/sync/index-manager.ts`)

Методы для работы с файлом соли на Яндекс.Диске:

| Метод                              | Описание                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| `uploadEncryptionSalt(saltBase64)` | RAW upload в `.obsidian-encrypt.json` (без шифрования)                |
| `downloadEncryptionSalt()`         | RAW download, возвращает содержимое `.obsidian-encrypt.json` или null |
| `deleteEncryptionSalt()`           | Удаляет `.obsidian-encrypt.json` с диска                              |

Файл соли всегда передаётся **raw** (без шифрования) — критически важно,
так как на момент загрузки/выгрузки соли encryption service ещё не инициализирован.

#### Формат salt файла

```json
{
	"version": 1,
	"salt": "base64-encoded-16-bytes"
}
```

Хранится на Яндекс.Диске как `/Приложение/ваш-vault/.obsidian-encrypt.json`.

## 3. Хранение пароля

Пароль хранится в `data.json` (через Obsidian plugin API `saveData()`)
вместе с остальными настройками плагина.

```typescript
// В YandexDiskSyncSettings:
enableEncryption: boolean; // false
encryptionSalt: string | null; // Base64, null = не инициализирован
encryptedPassword: string | null; // plaintext string, пароль пользователя
```

Путь на диске: `<vault>/.obsidian/plugins/obsidian-yandex-disk-sync/data.json`

Уровень защиты — sandbox ОС + права доступа к `.obsidian` директории.
Пароль не шифруется повторно (нет доступа к OS Keychain на мобильных платформах).

При включении шифрования пароль сохраняется как plaintext и используется
для `EncryptionService.initializeKey(password)`. Никакой запрос к удалённому
API не содержит пароль в теле или заголовках.

## 4. Multi-device flow

```
Device A (first setup):
  enableEncryption(password):
    1. Проверить remote salt — не найден → новый salt
    2. PBKDF2(password, salt) → key
    3. Сохранить key + salt локально
    4. Загрузить salt на диск (raw, без шифрования)
    5. Force sync (все файлы шифруются, загружаются)
    6. Удалить старые plaintext файлы с диска

Device B (new device, encrypted data already exists):
  syncEncryptionStateWithRemote() [onLayoutReady]:
    1. Проверить remote salt — найден, но encryption выключен
    2. "Encrypted data detected. Enter password?"
    3. PasswordPromptModal — пользователь вводит пароль
    4. Создать EncryptionService с remote salt + password
    5. Пробует загрузить encrypted index → если успешно → сохранить локально
    6. Если ошибка → "Wrong password", сброс
```

## 5. Ключевые решения

1. **AES-256-GCM** — обеспечивает аутентифицированное шифрование (целостность + конфиденциальность)
2. **PBKDF2 с 100k итерациями** — защита от brute-force пароля
3. **Детерминированный IV для имён** — обратимость маппинга путей
4. **Случайный IV для контента** — криптографическая стойкость
5. **Base64URL для имён** — безопасные для URL имена файлов
6. **Web Crypto API** — кроссплатформенность (desktop + mobile)
7. **Шифрование в yandex-client** — прозрачно для sync-engine и вышележащих слоёв
8. **Исключение `.obsidian-sync-index.json`** — плагин должен находить индекс даже без пароля
9. **Class-based модалки с onClose() прототипом** — надёжная обработка закрытия через Escape/click-outside
10. **Пароль как plaintext в data.json** — нет доступа к OS Keychain на mobile, sandbox ОС как защита

## 6. Форматы

| Сущность                    | Формат                                             |
| --------------------------- | -------------------------------------------------- |
| Salt (в настройках)         | 16 bytes, Base64                                   |
| Password (в настройках)     | plaintext string                                   |
| Зашифрованный контент файла | `[IV 12 bytes][ciphertext + tag 16 bytes]`         |
| Зашифрованное имя файла     | Base64URL от `[ciphertext + tag]` (IV не хранится) |

## 7. Обработка ошибок

| Ситуация                                        | Где ловится                         | Реакция                                        |
| ----------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| decrypt вернул OperationError (неверный пароль) | yandex-client download              | notice "Wrong password / corrupted data", skip |
| decryptFilename вернул OperationError           | yandex-client getResourcesRecursive | notice "Can't decrypt file names"              |
| Пароль не установлен, encryption=ON             | disableEncryption                   | сброс флага, очистка соли                      |
| PBKDF2 ошибка                                   | EncryptionService.initializeKey     | пробросить, в UI — "Invalid password"          |
| Отсутствует encryptionSalt                      | main.ts initEncryption              | disable encryption, сбросить флаг              |
| Неверный пароль в VerifyPasswordModal           | VerifyPasswordModal.setError()      | `is-error` класс + Notice, модалка не закрывается |

## 8. UI нотификации

| Операция                     | Notice (persistent, 0)                          | Финальный Notice                        |
| ---------------------------- | ----------------------------------------------- | --------------------------------------- |
| Включение шифрования         | `notice.encryption_syncing`                     | `notice.encryption_enabled`             |
| Отключение шифрования        | `notice.encryption_disabling`                   | `notice.encryption_disabled`            |
| Смена пароля                 | `notice.encryption_syncing`                     | `notice.encryption_enabled`             |
| Неверный пароль (verify)     | -- (Notice с ошибкой)                           | модалка не закрывается, `is-error`      |

## 9. История реализации

| Фаза | Компонент                                                                 | Статус |
| ---- | ------------------------------------------------------------------------- | ------ |
| 0    | i18n ключи (translations.ts)                                              | Done   |
| 1    | types.ts (поля) + encryption.ts (ядро)                                    | Done   |
| 2    | yandex-client.ts (прозрачное шифрование)                                  | Done   |
| 3    | sync-engine.ts (прогресс-колбэк)                                          | Done   |
| 4    | index-manager.ts (salt upload/download)                                   | Done   |
| 5    | main.ts (initEncryption, enableEncryption, syncEncryptionStateWithRemote) | Done   |
| 6    | settings.ts (UI + error handling + infoblock)                             | Done   |
| 7    | styles.css (encryption-info, is-error)                                    | Done   |
| 8    | Multi-device: reuse remote salt, auto-detect, verification                | Done   |
| 9    | encryption-modals.ts: class-based модалки (VerifyPassword, ChangePassword)| Done   |
| 10   | UI: persistent notices, инфоблок в настройках, is-error подсветка         | Done   |

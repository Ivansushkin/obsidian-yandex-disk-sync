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

| Метод                      | Назначение                                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `constructor(salt)`        | Сохраняет соль для PBKDF2                                             |
| `initializeKey(password)`  | PBKDF2(100k, salt, HMAC-SHA256) -> AES-256-GCM raw key                |
| `encrypt(data)`            | Случайный 12-byte IV -> AES-GCM -> `[IV][ciphertext + auth_tag]`      |
| `decrypt(data)`            | Выделить IV[0:12] -> AES-GCM decrypt                                  |
| `encryptFilename(path)`    | IV = SHA256(path + ":iv:" + salt).slice(0,12) -> AES-GCM -> Base64URL |
| `decryptFilename(enc)`     | Base64URL decode -> восстановить IV -> AES-GCM decrypt                |
| `createVerifier()`         | Шифрует фиксированный payload для проверки пароля                     |
| `verifyVerifier(verifier)` | Расшифровывает verifier и проверяет payload                           |
| `static generateSalt()`    | `crypto.getRandomValues(16)`                                          |

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

Результат шифрования — `Base64URL(IV + ciphertext + tag)` без паддинга.
IV хранится в результате, чтобы имя можно было расшифровать без знания
исходного пути.

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
| `uploadFile`            | encrypt | encryptFilename              | --                                      |
| `downloadFile`          | decrypt | encryptFilename              | --                                      |
| `deleteResource`        | --      | encryptFilename              | --                                      |
| `moveResource`          | --      | encryptFilename (from + to)  | --                                      |
| `copyResource`          | --      | encryptFilename (from + to)  | --                                      |
| `getResource`           | --      | encryptFilename              | decryptFilename(path + name)            |
| `getResourcesRecursive` | --      | encryptFilename (root)       | decryptFilename(path + name) всех items |
| `createFolder`          | --      | encryptFilename              | --                                      |
| `ensureFoldersExist`    | --      | encryptFilename (всех папок) | --                                      |

Каждый сегмент ниже `remotePath` шифруется отдельно; сам корень остаётся
открытым. Для `getResourcesRecursive` требуется расшифровка `resource.path` и
`resource.name` в каждом ответе.

**Исключения:**

- `.obsidian-sync-index.json` — путь не шифруется (чтобы индекс был находим без пароля).
  Контент шифруется штатно.
- `.obsidian-sync-index.lock.<transactionId>` — временное имя того же индекса;
  путь также не шифруется, контент остаётся зашифрован текущим ключом.
- `.obsidian-encrypt.json` — remote manifest шифрования, всегда RAW (без шифрования),
  так как на момент его чтения encryption service ещё не инициализирован.

### 2.3 SyncEngine (`src/sync/sync-engine.ts`)

Шифрование прозрачно для движка синхронизации: оно выполняется внутри
`YandexDiskClient` при upload/download. Прогресс длительных операций
включения/отключения шифрования и смены пароля отображается через общий
`onProgress` колбэк `SyncEngine` (`updateState` → status bar), который
получает `(processedCount / totalCount * 100)`.

Enable, disable и rotate выполняются как эксклюзивная maintenance-операция.
FileWatcher сохраняет пользовательские события на протяжении всего перехода и
воспроизводит их только после финального manifest.

### 2.4 main.ts

Управление жизненным циклом шифрования.

#### Инициализация (`onload()`)

```typescript
private async initEncryption(): Promise<void> {
    if (!this.settings.enableEncryption
        || !this.settings.encryptionSalt
        || !this.settings.encryptionPassword
    ) return;

    const salt = EncryptionService.base64ToBytes(this.settings.encryptionSalt);
    const service = new EncryptionService(salt);
    await service.initializeKey(this.settings.encryptionPassword);
    this.encryptionService = service;
    this.yandexClient.setEncryptionService(service);
}
```

Пароль хранится в `encryptionPassword` как plaintext string (не base64).

#### enableEncryption(password)

Если remote manifest уже существует, устройство подключается к нему после
проверки пароля. Первое включение создаёт локальную запись перехода, публикует
manifest `state="enabling"`, загружает target-файлы и непосредственно перед
commit фиксирует фазу `files-copied`. После повторного чтения canonical index
целевым ключом canonical переводится в фазу `cleanup`, затем публикуется stable
manifest и начинается guarded cleanup старых файлов.

#### disableEncryption(options?)

При выключении с re-upload сначала сохраняются raw paths и server fingerprints
старых encrypted-файлов. Plaintext-файлы загружаются без раннего удаления
старого набора. До commit ошибка автоматически восстанавливает старый ключ,
настройки и stable manifest; после commit rollback запрещён, manifest удаляется,
а cleanup старого набора повторяется идемпотентно. Файл удаляется только при
совпадении сохранённого fingerprint.

При смене пароля используется отдельный метод `rotateEncryptionPassword(newPassword)`:

1. Сохраняет raw paths и fingerprints старого набора.
2. Генерирует новый salt/key/verifier и увеличивает `revision`.
3. Выполняет тот же фазовый переход с `state="rotating"`.
4. После canonical commit публикует stable target manifest.
5. Удаляет только неизменившиеся файлы старого набора.

Для enable, disable и rotate локально и в canonical maintenance сохраняются
фазы `prepared → files-copied → index-committed → cleanup`; stable manifest
публикуется после commit, а maintenance удаляется после cleanup. При запуске
инициирующее устройство пробует прочитать canonical index source- и target-
ключом. Source означает rollback, target — обязательное завершение нового
режима. Если индекс не читается ни одним способом, автоматическое
восстановление останавливается без удаления данных.

Во время `cleanup` обновлённые устройства работают в target-режиме: старые raw
paths фильтруются по canonical cleanup metadata, а удалить их может любое
устройство с target-ключом. Если инициирующее устройство утрачено до commit,
обычная синхронизация на остальных устройствах остаётся заблокированной. На
устройстве с проверенной полной
локальной копией можно выполнить Force local с обязательным
backup-подтверждением: canonical index перестраивается в текущем локальном
режиме, публикуется stable manifest, а лишний raw-набор удаляется только при
совпадении fingerprints. Force remote при переходном manifest не разрешён.

#### clearLocalEncryptionState() (private)

Сбрасывает encryption service и все локальные настройки шифрования без обращения
к remote. Используется в `ensureEncryptionReady` когда удалённый manifest пропал
(другое устройство отключило шифрование). Вызывает `saveSettings()` и
`setEncryptionBlock(null)`.

#### encryptionStateChangeCallback

```typescript
encryptionStateChangeCallback: (() => void) | null = null;
```

Публичный callback, устанавливаемый `SettingsTab.display()`. Вызывается
в двух местах:

- `promptForRemoteEncryptionPasswordOnce` после успешного `connectToRemoteEncryption` — обновляет toggle в ON
- `ensureEncryptionReady` после авто-отключения через `clearLocalEncryptionState` — обновляет toggle в OFF

`SettingsTab.hide()` сбрасывает его в `null`, предотвращая вызов после закрытия tab.

#### ensureEncryptionReady()

Вызывается перед любым sync-входом: startup, manual sync, force sync,
scheduler и realtime watcher через guard в `SyncEngine`.

1. Проверить remote manifest
2. Если manifest отсутствует:
    - Локально encryption **выключен** → sync разрешён, `setEncryptionBlock(null)`
    - Локально encryption **включён** → авто-отключение через `clearLocalEncryptionState()` + Notice `encryption_disabled_remotely` (10s) + `encryptionStateChangeCallback?.()` → sync разрешён
3. Если `state` не `enabled` — заблокировать sync до завершения операции на другом устройстве
4. Если локально нет ключа — показать `ConnectEncryptedVaultModal` и запросить пароль
5. Если `salt/revision` отличаются — запросить новый пароль
6. Верифицировать пароль через `manifest.verifier`
7. Если успешно — сохранить локально `salt/password/revision`, снять блокировку

Если пользователь отменяет ввод пароля или вводит неверный пароль, синхронизация
остаётся заблокированной. File watcher и scheduler не запускаются.

### 2.5 encryption-modals.ts (`src/ui/encryption-modals.ts`)

Все модалки шифрования — классы, наследующие `Modal`:

| Класс                        | Назначение                                           | Кол-во полей     | Кнопки                                                  |
| ---------------------------- | ---------------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `EnableEncryptionModal`      | Включение шифрования (новый пароль)                  | 2 (pw + confirm) | Create backup + enable / Enable without backup / Cancel |
| `DisableEncryptionModal`     | Подтверждение отключения                             | 0                | Yes (Cta) / Cancel                                      |
| `VerifyPasswordModal`        | Верификация текущего пароля (смена пароля)           | 1                | Confirm (Cta) / Cancel                                  |
| `ConnectEncryptedVaultModal` | Запрос пароля для подключения encrypted remote vault | 1                | Connect / Cancel                                        |
| `ChangePasswordModal`        | Ввод нового пароля при смене                         | 2 (pw + confirm) | Change password (Cta) / Cancel                          |

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
    - ON, remote manifest отсутствует: `EnableEncryptionModal` -> persistent notice -> `enableEncryption(password)` -> `Notice(encryption_enabled)`
    - ON, remote manifest есть: `ConnectEncryptedVaultModal` -> `connectToRemoteEncryption(password)` -> `Notice(encryption_connected)`
    - OFF: `DisableEncryptionModal` -> persistent notice -> `disableEncryption({ reuploadPlaintext: true })` -> если `!hadErrors`: `Notice(encryption_disabled)`, иначе notice уже показан внутри функции
- При активном шифровании: кнопка "Change password"
    - `VerifyPasswordModal(verifyPassword)` -> `ChangePasswordModal` -> persistent notice -> `rotateEncryptionPassword(newPassword)` -> `Notice(encryption_password_changed)`
- Информационный блок после toggle/change-password:
    - Описание принципа работы (AES-256-GCM + PBKDF2)
    - Warning о безвозвратной потере данных при утере пароля
    - Уведомление, что пароль хранится локально и не отправляется на удалённое хранилище

**Toggle auto-refresh:**

`display()` устанавливает `plugin.encryptionStateChangeCallback = () => this.display()`.
`hide()` сбрасывает его в `null`. Callback вызывается из `main.ts` при изменении
состояния шифрования из фоновых операций (connect после prompt, авто-отключение при
пропавшем манифесте), обновляя toggle без перехода в settings вручную.

### 2.7 IndexManager (`src/sync/index-manager.ts`)

Методы для работы с remote manifest на Яндекс.Диске:

| Метод                                | Описание                                                               |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `uploadEncryptionManifest(manifest)` | RAW upload в `.obsidian-encrypt.json` (без шифрования)                 |
| `downloadEncryptionManifest()`       | RAW download, возвращает manifest или null только при 404              |
| `deleteEncryptionManifest()`         | Удаляет `.obsidian-encrypt.json` с диска                               |
| `getRemoteRawFileSnapshots()`        | Возвращает raw paths и fingerprints для guarded cleanup старого набора |

Manifest всегда передаётся **raw** (без шифрования) — критически важно,
так как на момент загрузки manifest encryption service ещё не инициализирован.

`downloadEncryptionManifest()` не превращает network/parse/auth ошибки в `null`.
`null` означает только отсутствие manifest-файла. Это предотвращает split-brain,
когда клиент ошибочно считает encrypted remote vault plaintext-хранилищем.

#### Формат manifest v2

```json
{
	"version": 2,
	"state": "enabled",
	"revision": 3,
	"salt": "base64-encoded-16-bytes",
	"verifier": "base64([IV][ciphertext+tag])",
	"kdf": {
		"name": "PBKDF2",
		"hash": "SHA-256",
		"iterations": 100000
	},
	"cipher": {
		"name": "AES-GCM",
		"keyLength": 256,
		"ivLength": 12
	},
	"updatedAt": 1781712000000,
	"updatedBy": "device_id"
}
```

Состояния:

| State       | Значение для клиентов                                            |
| ----------- | ---------------------------------------------------------------- |
| `enabled`   | Шифрование активно, можно подключаться с актуальным паролем      |
| `enabling`  | Другое устройство включает шифрование, sync нужно заблокировать  |
| `rotating`  | Другое устройство меняет пароль, sync нужно заблокировать        |
| `disabling` | Другое устройство отключает шифрование, sync нужно заблокировать |

Legacy формат v1 поддерживается для чтения:

```json
{
	"version": 1,
	"salt": "base64-encoded-16-bytes"
}
```

Для v1 нет `verifier`, поэтому пароль проверяется строгим чтением encrypted index.
Новые записи всегда используют v2.

Manifest хранится на Яндекс.Диске как `/Приложение/ваш-vault/.obsidian-encrypt.json`.

## 3. Хранение пароля

Пароль хранится в `data.json` (через Obsidian plugin API `saveData()`)
вместе с остальными настройками плагина.

```typescript
// В YandexDiskSyncSettings:
enableEncryption: boolean; // false
encryptionSalt: string | null; // Base64, null = не инициализирован
encryptionPassword: string | null; // plaintext string, пароль пользователя
encryptionRevision: number | null; // remote manifest revision, применённый локально
```

Путь на диске: `<vault>/.obsidian/plugins/yandex-disk-sync/data.json`

Уровень защиты — sandbox ОС + права доступа к `.obsidian` директории.
Пароль не шифруется повторно (нет доступа к OS Keychain на мобильных платформах).

При включении шифрования пароль сохраняется как plaintext и используется
для `EncryptionService.initializeKey(password)`. Никакой запрос к удалённому
API не содержит пароль в теле или заголовках.

## 4. Multi-device flow

```
Device A (first setup):
  enableEncryption(password):
    1. Проверить remote manifest — не найден → новый salt/revision/verifier
    2. Сохранить raw paths и fingerprints старых remote-файлов
    3. PBKDF2(password, salt) → key
    4. Записать distributed maintenance в canonical и manifest state=enabling
    5. Переписать только physical representation, сохранив epoch/history
    6. index-committed → записать canonical cleanup metadata
    7. Опубликовать stable manifest и удалить только файлы с прежним fingerprint

Device B (new device, encrypted data already exists):
  ensureEncryptionReady() [before sync]:
    1. Проверить remote manifest — найден enabled, но локально нет ключа
    2. Заблокировать sync, остановить watcher/scheduler
    3. Показать Notice + ConnectEncryptedVaultModal
    4. Создать EncryptionService с manifest.salt + password
    5. Проверить password через manifest.verifier
    6. Если успешно → сохранить salt/password/revision локально, снять блок
    7. Если ошибка или cancel → оставить sync заблокированным

Device A (password rotation):
  rotateEncryptionPassword(newPassword):
    1. Проверить, что remote manifest state=enabled
    2. Сохранить raw paths и fingerprints старого набора
    3. Сгенерировать новый salt/key/verifier, revision += 1
    4. prepared/files-copied с manifest state=rotating
    5. Зафиксировать canonical index новым ключом
    6. Записать canonical cleanup metadata и опубликовать stable manifest
    7. Guarded cleanup старого набора

Device B (password changed elsewhere):
  ensureEncryptionReady() [before sync]:
    1. Проверить manifest — salt/revision отличаются от локальных
    2. Заблокировать sync
    3. Показать Notice "Пароль изменён на другом устройстве"
    4. Запросить новый пароль через ConnectEncryptedVaultModal
    5. Проверить verifier и сохранить новый revision

Device A (disable encryption with reuploadPlaintext):
  disableEncryption({ reuploadPlaintext: true }):
    1. Захватить raw paths и fingerprints пока source service активен
    2. prepared → загрузить manifest state=disabling
    3. Обнулить encryptionService, yandexClient.setEncryptionService(null)
    4. Переписать physical snapshot через reencodeRemoteFiles()
    5. files-copied → canonical commit в plaintext
    6. index-committed → записать canonical cleanup metadata, затем удалить manifest
    7. Guarded cleanup файлов и пустых папок deepest-first
    8. До commit ошибка откатывает source; после commit завершается target

Device B (encryption was disabled elsewhere, opens Obsidian):
  ensureEncryptionReady() [before sync]:
    1. Проверить remote manifest — не найден (удалён device A)
    2. Локально enableEncryption=true → авто-отключение:
       clearLocalEncryptionState(): обнулить service + соль + пароль + saveSettings
    3. Notice(encryption_disabled_remotely, 10s)
    4. encryptionStateChangeCallback?.() — toggle в settings переключается в OFF
    5. Sync разрешён в plaintext-режиме
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
11. **Remote manifest v2** — единый сигнал для multi-device включения, rotation и временных состояний
12. **Fail-closed sync guard** — sync не запускается без актуального ключа или при незавершённой remote-операции
13. **Verifier вместо index-check** — пароль проверяется через AES-GCM verifier, а не через чтение индекса

## 6. Форматы

| Сущность                    | Формат                                         |
| --------------------------- | ---------------------------------------------- |
| Salt (в настройках)         | 16 bytes, Base64                               |
| Password (в настройках)     | plaintext string                               |
| Revision (в настройках)     | number из remote manifest                      |
| Manifest                    | raw JSON `.obsidian-encrypt.json`, version 2   |
| Verifier                    | Base64 от `[IV 12 bytes][ciphertext + tag]`    |
| Зашифрованный контент файла | `[IV 12 bytes][ciphertext + tag 16 bytes]`     |
| Зашифрованное имя файла     | Base64URL от `[IV 12 bytes][ciphertext + tag]` |

## 7. Обработка ошибок

| Ситуация                                            | Где ловится                         | Реакция                                                                                                 |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| decrypt вернул OperationError (неверный пароль)     | yandex-client download              | notice "Wrong password / corrupted data", skip                                                          |
| decryptFilename вернул OperationError               | yandex-client getResourcesRecursive | notice "Can't decrypt file names"                                                                       |
| Пароль не установлен, encryption=ON                 | disableEncryption                   | сброс флага, очистка соли                                                                               |
| PBKDF2 ошибка                                       | EncryptionService.initializeKey     | пробросить, в UI — "Invalid password"                                                                   |
| Отсутствует encryptionSalt                          | main.ts initEncryption              | disable encryption, сбросить флаг                                                                       |
| Неверный пароль в VerifyPasswordModal               | VerifyPasswordModal.setError()      | `is-error` класс + Notice, модалка не закрывается                                                       |
| Remote manifest есть, локального ключа нет          | ensureEncryptionReady               | status `encryption-required`, prompt password, sync blocked                                             |
| Remote manifest state `enabling/rotating/disabling` | ensureEncryptionReady               | sync blocked, Notice с инструкцией дождаться завершения                                                 |
| Remote salt/revision изменились                     | ensureEncryptionReady               | sync blocked, запрос нового пароля                                                                      |
| Ошибка чтения/parse manifest                        | downloadEncryptionManifest          | sync blocked, ошибка не трактуется как plaintext remote                                                 |
| Remote manifest отсутствует, локально enc ON        | ensureEncryptionReady               | авто-отключение через `clearLocalEncryptionState`, sync разрешён, Notice `encryption_disabled_remotely` |
| Переход шифрования завершился с ошибками до commit  | recoverEncryptionTransition         | восстановить source key/settings/manifest, target cleanup по fingerprint                                |
| Сбой непосредственно около canonical commit         | recoverEncryptionTransition         | прочитать index source и target ключом; rollback только для source                                      |

## 8. UI нотификации

| Операция                                      | Notice (persistent, 0)                | Финальный Notice                                      |
| --------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Включение шифрования                          | `notice.encryption_syncing`           | `notice.encryption_enabled`                           |
| Отключение шифрования (успешно)               | `notice.encryption_disabling`         | `notice.encryption_disabled`                          |
| Отключение шифрования (с ошибками)            | `notice.encryption_disabling`         | `notice.encryption_disable_partial` (30s, из main.ts) |
| Авто-отключение при пропавшем remote manifest | --                                    | `notice.encryption_disabled_remotely` (10s)           |
| Неверный пароль (verify)                      | -- (Notice с ошибкой)                 | модалка не закрывается, `is-error`                    |
| Подключение второго устройства                | `notice.encryption_password_required` | `notice.encryption_connected`                         |
| Смена пароля                                  | `notice.encryption_password_rotating` | `notice.encryption_password_changed`                  |
| Требуется пароль                              | `notice.encryption_password_required` | status bar `YD: Требуется пароль шифрования`          |

## 9. История реализации

| Фаза | Компонент                                                                               | Статус |
| ---- | --------------------------------------------------------------------------------------- | ------ |
| 0    | i18n ключи (translations.ts)                                                            | Done   |
| 1    | types.ts (поля) + encryption.ts (ядро)                                                  | Done   |
| 2    | yandex-client.ts (прозрачное шифрование)                                                | Done   |
| 3    | sync-engine.ts (прогресс-колбэк)                                                        | Done   |
| 4    | index-manager.ts (salt upload/download)                                                 | Done   |
| 5    | main.ts (initEncryption, enableEncryption, ensureEncryptionReady)                       | Done   |
| 6    | settings.ts (UI + error handling + infoblock)                                           | Done   |
| 7    | styles.css (encryption-info, is-error)                                                  | Done   |
| 8    | Multi-device: reuse remote salt, auto-detect, verification                              | Done   |
| 9    | encryption-modals.ts: class-based модалки (VerifyPassword, ChangePassword)              | Done   |
| 10   | UI: persistent notices, инфоблок в настройках, is-error подсветка                       | Done   |
| 11   | Manifest v2, verifier, fail-closed sync guard, password rotation                        | Done   |
| 12   | Segment-wise folder name encryption, empty folder pruning                               | Done   |
| 13   | Distributed maintenance, physical re-encode без Force и guarded cleanup                 | Done   |
| 14   | `ensureEncryptionReady`: авто-отключение при пропавшем манифесте вместо блокировки sync | Done   |
| 15   | `encryptionStateChangeCallback`: авто-обновление toggle при connect и авто-отключении   | Done   |

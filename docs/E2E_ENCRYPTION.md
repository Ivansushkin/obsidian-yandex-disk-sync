# E2E шифрование

## Контракты

- Canonical index остаётся v4, remote manifest для новых vault — v3.
- Canonical, lock, manifest, `.backup` и plugin directory имеют raw-имена.
- Пользовательские пути шифруются посегментно ниже `remotePath`.
- Формат content ciphertext не изменён:
  `[12-byte IV][AES-GCM ciphertext + 16-byte tag]`.
- Пароль, OAuth token и производные ключи существуют только в локальном
  `data.json`/памяти и никогда не журналируются.
- До canonical commit авторитетен source codec. После commit rollback запрещён,
  авторитетен target codec.

## Codec profile: `hardened-v3`

- PBKDF2-HMAC-SHA256, ровно 600 000 итераций, случайная salt 16 bytes;
- PBKDF2 выводит 256-bit master key;
- HKDF-SHA256 с независимыми `info` выводит:
  - 256-bit AES-GCM content key;
  - 512-bit AES-SIV filename key;
- filename cipher: RFC 5297 AES-SIV из `@noble/ciphers@2.2.0`;
- filename AAD: `obsidian-yandex-disk-sync:filename:v3`;
- encoding: canonical Base64URL без padding.

AAD не включает parent path. Поэтому physical move папки меняет только segment
корня, а потомки не требуют перекодировки. Детерминированность раскрывает
равенство одинаковых имён, но больше не раскрывает проверяемый публичный IV.

После успешной аутентификации segment принимается только при корректном UTF-8,
непустом значении и отсутствии `/`, `\\`, NUL, `.` и `..`. Любая ошибка
ciphertext или UTF-8 блокирует sync до обращения к Vault API.

## Manifest compatibility

`.obsidian-encrypt.json` всегда читается и записывается raw.

- v1/v2 и все historical prerelease encryption formats не поддерживаются и
  всегда блокируются отдельной ошибкой без попытки compatibility decode.
- v3 обязан полностью и точно объявлять `profileId`, KDF, HKDF, content cipher
  и filename cipher.
- Unknown version/profile/algorithm блокирует watcher, scheduler, upload,
  delete, physical repair и cleanup.

Manifest transitional state содержит secret-free source/target descriptors и
profile IDs. Устройство не выбирает codec по локальной догадке.

## Локальное состояние

`PluginData.schemaVersion = 2`. Current encryption и transition snapshots
обязаны иметь явный `profileId`. Загрузчик принимает только:

- полную current schema v2, сохраняя baseline и очереди без перестановки;
- точную plaintext stable 1.0/1.1 форму
  `settings + localIndex + lastSyncStats`, преобразуя `localIndex` в unobserved
  baseline и создавая пустые очереди.

Unversioned `localState`, historical queues, transition без profile metadata,
unversioned settings с encryption-полями и любая другая schema блокируют plugin
startup до создания компонентов синхронизации.

Если initiator потерян после commit, target-capable устройство проверяет
matching transition ID, target salt/revision/verifier и post-commit phase,
публикует stable v3 и продолжает canonical cleanup без source password.
Pre-commit foreign maintenance остаётся заблокированным.

Офлайн-устройство сначала подключает v3 codec, принимает canonical через full
reconcile и только затем воспроизводит durable logical mutations. Старые
physical actions применяются только при актуальном epoch/canonical/fingerprint
proof.

## Enable, rotate и disable

Все операции используют `EncryptionTransitionController` и одну схему recovery:

- enable создаёт hardened-v3 и backup под target password;
- rotate создаёт новый hardened-v3 target и backup под new password;
- disable создаёт backup под source password и target plaintext;
- `clearIndexTransitionServices()` всегда выполняется через `finally`.

Публичные методы плагина сохранены:
`enableEncryption`, `disableEncryption`, `rotateEncryptionPassword`,
`connectToRemoteEncryption`, `verifyEncryptionPassword`,
`getRemoteEncryptionManifest`, `createBackup`.

Переход из manifest v1/v2 или другого legacy/prerelease encryption metadata не
создаётся: эти данные fail closed до любых remote writes.

## Проверки

Нормативные сценарии находятся в
[`SYNC_USER_SCENARIOS.md`](./SYNC_USER_SCENARIOS.md), ручной multi-device
прогон — в [`SMOKE_TESTS.md`](./SMOKE_TESTS.md). Stable запрещён без реального
двухпрофильного прогона, mobile PERF-006/PBKDF2 evidence и полного P0/P1
evidence файла `release-evidence/2.0.0.json`.

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

## Codec profiles

### `legacy-v2`

Профиль нужен только для чтения, восстановления незавершённого beta-transition
и явного format upgrade:

- PBKDF2-HMAC-SHA256, 100 000 итераций, salt 16 bytes;
- один AES-256-GCM key для content и имён;
- filename: детерминированный публичный IV и Base64URL.

Обычный sync с manifest v1/v2 блокируется состоянием
`encryption-upgrade-required`. Старый codec не используется для новых vault.

### `hardened-v3`

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

- v1 доступен только для подключения и migration.
- v2 без исторических `kdf`/`cipher` нормализуется в legacy constants.
- Объявленные v2-параметры должны точно соответствовать
  PBKDF2-100k/AES-256-GCM; противоречие блокирует sync.
- v3 обязан полностью и точно объявлять `profileId`, KDF, HKDF, content cipher
  и filename cipher.
- Unknown version/profile/algorithm блокирует watcher, scheduler, upload,
  delete, physical repair и cleanup.

Manifest transitional state содержит secret-free source/target descriptors и
profile IDs. Устройство не выбирает codec по локальной догадке.

## Локальное состояние

`PluginData.schemaVersion = 2`. Encryption snapshot имеет optional
`profileId`; отсутствие у существующего encrypted snapshot означает
`legacy-v2`. Миграция аддитивна и не очищает, не сортирует и не переигрывает:

- local baseline;
- pending mutations;
- pending physical actions;
- pending watcher events;
- beta transition recovery data.

## v1/v2 → v3 format upgrade

1. Восстановить незавершённый legacy beta-transition, если он существует.
2. Выполнить source full sync внутри единственного `SyncCoordinator`.
3. Создать logical backup текущего согласованного vault и подтвердить exact
   raw bytes read-back.
4. Привязать backup proof к canonical epoch/revision и digest local snapshot.
   После concurrent canonical commit preflight и backup повторяются.
5. Создать новый hardened-v3 target с новой salt. Пароль можно оставить тем же.
6. Захватить exclusive canonical maintenance под source codec.
7. Опубликовать manifest v3 `rotating` до первых target writes.
8. Перекодировать physical tree, повторно проверить source fingerprints и
   записать target fingerprints.
9. Прочитать canonical source codec и записать target codec. Cleanup plan со
   source paths/fingerprints входит в тот же canonical commit.
10. Опубликовать stable manifest v3 и выполнить только fingerprint-matching
    cleanup.
11. Выполнить full reconcile и только затем запускать watcher/scheduler.

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
- format upgrade имеет canonical kind `rotate`, локальный diagnostic reason
  `format-upgrade`;
- disable создаёт backup под source password и target plaintext;
- `clearIndexTransitionServices()` всегда выполняется через `finally`.

Публичные методы плагина сохранены:
`enableEncryption`, `disableEncryption`, `rotateEncryptionPassword`,
`connectToRemoteEncryption`, `verifyEncryptionPassword`,
`getRemoteEncryptionManifest`, `createBackup`.

## Проверки

Нормативные сценарии находятся в
[`SYNC_USER_SCENARIOS.md`](./SYNC_USER_SCENARIOS.md), ручной multi-device
прогон — в [`SMOKE_TESTS.md`](./SMOKE_TESTS.md). Stable запрещён без реального
двухпрофильного прогона, mobile PERF-006/PBKDF2 evidence и полного P0/P1
evidence файла `release-evidence/2.0.0.json`.

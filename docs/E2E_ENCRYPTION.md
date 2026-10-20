# E2E шифрование

## Контракты

- Current canonical содержит `format: "sync-index"`, а remote manifest —
  `format: "encryption-manifest"`.
- Canonical, lock, manifest, `.backup` и plugin directory имеют raw-имена.
- Пользовательские пути шифруются посегментно ниже `remotePath`.
- Формат content ciphertext не изменён:
  `[12-byte IV][AES-GCM ciphertext + 16-byte tag]`.
- Пароль, OAuth token и производные ключи существуют только в локальном
  `data.json`/памяти и никогда не журналируются.
- До canonical commit авторитетен source codec. После commit rollback запрещён,
  авторитетен target codec.

## Codec profile: `hardened`

- PBKDF2-HMAC-SHA256, ровно 600 000 итераций, случайная salt 16 bytes;
- PBKDF2 выводит 256-bit master key;
- HKDF-SHA256 с независимыми `info` выводит:
  - 256-bit AES-GCM content key;
  - 512-bit AES-SIV filename key;
- filename cipher: RFC 5297 AES-SIV из `@noble/ciphers@2.2.0`;
- HKDF info: `obsidian-yandex-disk-sync:content-key` и
  `obsidian-yandex-disk-sync:filename-key`;
- filename AAD: `obsidian-yandex-disk-sync:filename`;
- verifier domain: `obsidian-yandex-disk-sync:encryption-verifier`;
- encoding: canonical Base64URL без padding.

AAD не включает parent path. Поэтому physical move папки меняет только segment
корня, а потомки не требуют перекодировки. Детерминированность раскрывает
равенство одинаковых имён, но больше не раскрывает проверяемый публичный IV.

После успешной аутентификации segment принимается только при корректном UTF-8,
непустом значении и отсутствии `/`, `\\`, NUL, `.` и `..`. Любая ошибка
ciphertext или UTF-8 блокирует sync до обращения к Vault API.

## Manifest boundary

`.obsidian-encrypt.json` всегда читается и записывается raw.

- Numeric и иные historical encryption formats не поддерживаются и всегда
  блокируются отдельной ошибкой без попытки compatibility decode.
- Current manifest обязан содержать semantic marker и полностью, точно
  объявлять `profileId`, KDF, HKDF, content cipher и filename cipher.
- Unknown format/profile/algorithm блокирует watcher, scheduler, upload,
  delete, physical repair и cleanup.

Manifest transitional state содержит secret-free source/target descriptors и
profile IDs. Устройство не выбирает codec по локальной догадке. Manifest,
canonical maintenance и local transition принимаются только с точным набором
полей; ID, initiator, phase, mode descriptors, profile IDs и revisions должны
быть согласованы. Cleanup paths нормализованы, уникальны, не protected и всегда
имеют expected fingerprint.

## Локальное состояние

Storage binding определяется raw identity корневой папки и не меняется от
enable/rotate/disable или random IV. Проверка binding предшествует admission
recovery и физическим writes. Unbound current history требует подтверждения;
новое подключение не может отбросить сохранённый transition. Scope повторно
проверяется перед локальной записью download/copy. Ambiguous PUT read-back сверяет
plaintext и исходную codec authority до и после чтения; новый IV не мешает
подтверждению, смена authority запрещает успех. Corrective repair сохраняет
accepted mutationSeq и обновляет ciphertext fingerprint как physical rewrite.

Conflict reconciliation сравнивает plaintext SHA, подтверждая canonical SHA
физическим content hash или stable logical download. Изменение ciphertext при
тех же plaintext bytes не создаёт копию. Копия перед overwrite получает exclusive
upload, read-back и canonical confirmation. Проверки повторяют manifest/codec
guards; plaintext buffers существуют только внутри операции и не журналируются.

Current `data.json` содержит `format: "plugin-data"`. Encryption и transition
snapshots обязаны иметь явный `profileId`. Загрузчик принимает только:

- полную current semantic shape, сохраняя baseline и очереди без перестановки;
- точную plaintext stable 1.0/1.1 форму
  `settings + localIndex + lastSyncStats`, преобразуя `localIndex` в unobserved
  baseline и создавая пустые очереди.

Unmarked `localState`, historical queues, transition без profile metadata,
unmarked settings с encryption-полями и любой другой format блокируют plugin
startup до создания компонентов синхронизации.

Если initiator потерян после commit, target-capable устройство проверяет
matching transition ID, source/target descriptors, profile combination и
post-commit phase. Для enable/rotate оно аутентифицирует target verifier,
явно читает target canonical новым codec, публикует stable manifest и
продолжает canonical cleanup без source password. Для disable оно явно читает
plaintext target canonical; transitional manifest проверяется, если ещё
существует, но его отсутствие допустимо только для committed plaintext target.
Explicit target read разрешён `IndexManager` только внутри matching recovery
scope. Pre-commit foreign maintenance остаётся заблокированным.

Подключение нового устройства транзакционно: пароль создаёт candidate codec,
который проверяет verifier и читает canonical до изменения active codec,
settings, salt или revision. Wrong password, Cancel и любая coherence/canonical
ошибка не сохраняют candidate credentials и не выполняют remote writes.
Password prompt не запускается из guard уже активной coordinator-сессии.

Перед re-encode строится полное injective
`targetRawByLogicalPath`. Оно не может пересекаться с source raw tree или
protected paths. Каждый target upload проходит stable raw read-back, обратное
декодирование logical path и проверку plaintext SHA-256; только после этого его
fingerprint атомарно сохраняется локально. Crash между upload и persistence
требует повторить доказательство. Missing или ambiguous proof не разрешает
rollback/delete и не позволяет сообщить завершение cleanup.
Ни success, ни 409/423/429, ни timeout сами по себе не подтверждают upload:
единственный успех — прошедший read-back proof. Source raw object без stable
fingerprint блокирует переход до claim. Source preflight также отклоняет любую
активную canonical maintenance до filesystem scan или write. При concurrent
claim retry собственный local block не считается remote proof: manifest guard
обязательно выполняется повторно, и только его PASS разрешает новый preflight.

Manifest следующего post-commit состояния публикуется перед соответствующим
canonical commit. После commit foreign device видит matching authority; до
commit любое рассогласование блокирует его без remote writes. Stable encrypted
manifest может сопровождать matching `index-committed` или `cleanup`
maintenance и позволяет target-capable device довести cleanup. Для disable
отсутствующий manifest допустим только с matching committed plaintext target.
Свежий random-IV verifier stable manifest не обязан совпадать побайтно с
maintenance verifier, но candidate codec обязан аутентифицировать оба до
первого recovery write.
Pre-commit rollback никогда не переводит source canonical в post-commit
`cleanup` phase.
Own-device recovery не получает послабления только из-за совпавшего device ID:
local transition, manifest и canonical maintenance должны совпасть по ID, kind,
initiator, revisions и descriptors с учётом единственного разрешённого окна,
когда manifest следующей phase уже опубликован, а canonical commit ещё нет.

Офлайн-устройство сначала подключает `hardened` codec, принимает canonical через full
reconcile и только затем воспроизводит durable logical mutations. Старые
physical actions применяются только при актуальном epoch/canonical/fingerprint
proof.

## Enable, rotate и disable

Все операции используют `EncryptionTransitionController` и одну схему recovery:

- enable создаёт `hardened` target и выбранный backup под target password;
- rotate создаёт новый `hardened` target и выбранный backup под new password;
- disable создаёт выбранный backup под source password и target plaintext;
- `clearIndexTransitionServices()` всегда выполняется через `finally`.

Публичные методы плагина сохранены:
`enableEncryption`, `disableEncryption`, `rotateEncryptionPassword`,
`connectToRemoteEncryption`, `verifyEncryptionPassword`,
`getRemoteEncryptionManifest`, `createBackup`.

Переход из numeric или другого historical encryption metadata не создаётся:
эти данные fail closed до любых remote writes.

## Проверки

Нормативные сценарии находятся в
[`SYNC_USER_SCENARIOS.md`](./SYNC_USER_SCENARIOS.md), ручной multi-device
прогон — в [`SMOKE_TESTS.md`](./SMOKE_TESTS.md). Stable запрещён без реального
двухпрофильного прогона, mobile PERF-006/PBKDF2 evidence и полного P0/P1
evidence файла `release-evidence/2.0.0.json`.

## Архивы и завершение другим устройством

Enable/disable/rotate предлагают архив, продолжение без архива или отмену.
`backupProof` в local transition обязателен и nullable; отсутствие поля не означает
отказ от архива. Все source/canonical/codec/fingerprint проверки сохраняются.
Пароль архива: target для enable/rotate, source для disable. Recovery и connect
не создают архив повторно; source drift завершает текущую попытку.

Foreign target recovery сначала доказывает target canonical и matching descriptors,
затем публикует stable target manifest или удаляет manifest для plaintext, переводит
canonical в cleanup, выполняет guarded удаления и завершает maintenance. Старое окно
canonical cleanup + manifest index-committed допускается только с той же identity
и descriptors. Manifest перечитывается после recovery. Wrong password и Cancel
не сохраняют candidate credentials и не делают remote mutations.

На каждом delete/retry свежие authority, action, live target mapping и fingerprint
обязательны. Timeout/202/успешный ответ без проверки отсутствия не завершают action.
Старый worker не возвращает completed maintenance сохранением устаревшего снимка.
Matching target recovery нового epoch не принимает его как local baseline и не
replay старые mutations; обычный full затем обрабатывает offline changes.

## Admission и настройки

Публичные enable/disable/rotate/connect резервируют foreground operation до первого
await и освобождают её через finally. Backup choice dialog не удерживает coordinator;
внутренние connect/recovery/preflight не приобретают повторно reservation владельца.
Настройки path/scope блокируются также сохранённым pending transition. Idle token repair
разрешён для восстановления доступа, но не снимает encryption authority checks.
Internal сохранение target snapshot и очередей не проходит пользовательский allowlist.

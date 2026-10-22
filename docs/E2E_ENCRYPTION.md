# E2E шифрование

## Контракты

- Current canonical содержит `format: "sync-index"`, а remote manifest —
  `format: "encryption-manifest"`.
- Canonical, lock, manifest, `.backup` и plugin directory имеют raw-имена.
- Пользовательские пути шифруются посегментно ниже `remotePath`.
- Формат content ciphertext не изменён:
  `[12-byte IV][AES-GCM ciphertext + 16-byte tag]`.
- Пароль и OAuth token сохраняются только в локальном `data.json`; производные
  ключи остаются в памяти. Эти значения никогда не журналируются.
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

- Numeric и иные historical encryption formats блокируют обычный sync и
  чтение зашифрованного Force source. Подтверждённый Force local заменяет
  destination metadata raw, без старого пароля и compatibility decode.
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

`crypto/encryption-transition.ts` проверяет decoded target path и plaintext SHA,
сохраняет proof до возврата результата и разделяет две identity: transition и
cleanup получают строгий `snapshot.fingerprint`, а файловый `remoteFingerprint`
получает `getPhysicalResourceFingerprint(snapshot.resource)`. Service fingerprint
не ослабляется до resource ID. Правило едино для enable, disable, rotate и
проверки target при recovery; строки отпечатков не преобразуются удалением
префикса. После перехода full сверяет stamp даже при совпавших plaintext hashes,
если fingerprint/mtime расходятся, и использует существующий stable read-back.

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

Post-commit recovery другого устройства описан в
[разделе recovery](#архивы-и-завершение-другим-устройством). Pre-commit foreign
maintenance остаётся заблокированным.

Подключение нового устройства транзакционно: пароль создаёт candidate codec,
который проверяет verifier и читает canonical до изменения active codec,
settings, salt или revision. Wrong password, Cancel и любая coherence/canonical
ошибка не сохраняют candidate credentials и не выполняют remote writes.
Password prompt не запускается из guard уже активной coordinator-сессии.

## Target proof, publication и rollback

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
Для rollback controller использует отдельную неперсистентную authority: собственный
local transition, matching pre-commit canonical того же epoch и сохранённые proofs
только target-объектов. Canonical cleanup остаётся пустым. Перед публикацией
source manifest, каждым DELETE/retry и завершением maintenance повторно проверяются
canonical ownership, manifest/source codec и local transition. Удаление дополнительно
требует прежнего fingerprint и отсутствия live source по этому raw path; пустые папки
сохраняются: recursive pruning не защищает позднего потомка. Уже сохранённый target proof не обновляется новым
fingerprint даже при совпавшем plaintext SHA. Отсутствующий target сохраняет proof
для идемпотентного завершения durable action после restart. Незавершённый rollback
сохраняет тот же transition ID, source authority и блокировку automation; logical
queues не подтверждаются и не очищаются. Persisted shapes и post-commit cleanup
не изменяются.
Если maintenance уже снята, а очистка local transition не сохранилась, recovery
только завершает checkpoint: свежие source canonical/manifest того же observed epoch,
точный прежний source physical snapshot и отсутствие всех targets обязательны.
Этот путь не получает права DELETE; существующий target или незавершённое durable
cleanup блокируют завершение. Failed final save возвращает transition в память.
Own-device recovery не получает послабления только из-за совпавшего device ID:
local transition, manifest и canonical maintenance должны совпасть по ID, kind,
initiator, revisions и descriptors с учётом единственного разрешённого окна,
когда manifest следующей phase уже опубликован, а canonical commit ещё нет.

Офлайн-устройство сначала подключает `hardened` codec, принимает canonical через full
reconcile и только затем воспроизводит durable logical mutations. Старые
physical actions применяются только при актуальном epoch/canonical/fingerprint
proof.

## Orchestration и admission

Все операции используют `EncryptionTransitionController` и одну схему recovery:

- enable создаёт `hardened` target и выбранный backup под target password;
- rotate создаёт новый `hardened` target и выбранный backup под new password;
- disable создаёт выбранный backup под source password и target plaintext;
- `clearIndexTransitionServices()` всегда выполняется через `finally`.

Preparation и connect выполняет `crypto/workflow.ts`; claim, phase publication,
snapshot application и guarded cleanup — `crypto/maintenance.ts`; recovery —
`crypto/recovery.ts`. Все используют существующий controller и его `finally`
очистки codec services. `EncryptionManager` создаёт codec, snapshot и manifest.
Узкие context ports используют актуальные settings и один plugin snapshot;
password/salt/transition не копируются в новый runtime и сохраняются прежней
coherent очередью вместе с baseline и pending work.

`crypto/admission.ts` сохраняет порядок manifest/verifier checks и единственный
ожидающий password prompt. `allowRecovery: false` запрещает reconnect, mutating
recovery и prompt. Ответ закрытого после unload диалога не подключает codec и
не меняет credentials. UI и foreground reservation принадлежат `main.ts`;
после подключения watcher/scheduler запускаются только после успешного full
и повторных lifecycle/pause checks. Подтверждение нового пароля в Force modal
сохраняет `confirmPassword`; recovery по-прежнему не создаёт новый архив.

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

При потере initiator target-capable устройство завершает post-commit recovery без
source password. Оно сверяет ID, initiator, source/target
descriptors, profile и post-commit phase. Для enable/rotate оно аутентифицирует
verifier и явно читает target canonical новым codec; для disable — plaintext
внутри matching IndexManager recovery scope. Отсутствующий manifest допустим
только после commit plaintext target.

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

## Направленный Force

Force использует отдельный maintenance kind и recovery, сохраняя формат markers
и профиль `hardened`. Он не выполняет enable/disable/rotate как фиктивный переход.
Локальное → Диск создаёт свежую соль и согласованные target user objects,
canonical и manifest; источник — фактические локальные plaintext bytes.
Старый ключ назначения не нужен при полном raw scope. При ограниченных include
patterns raw имя вне scope, похожее на ciphertext, требует доказанного target
codec logical path; иначе Force блокируется до удаления, сохраняя возможный
excluded plaintext. Явное raw exclusion снимает неоднозначность для посторонних
объектов. Manifest сам по себе не доказывает формат каждого user object.
Диск → локальное проверяет все source paths и decrypt до первого overwrite/delete.
Неоднозначный mixed plaintext/ciphertext source также блокируется при decrypt
failure; посторонние raw objects можно явно исключить до filename conversion.
При потерянном manifest формат выбирается явно; сохранённые salt/profile допустимы
только с успешной проверкой пути и bytes. Один пароль не заменяет потерянные salt/profile.
Пустой remote сохраняет локальный mode и получает рабочие пустые metadata.

Подробные backup, source/scope guards и restart phases описаны в
[ARCHITECTURE.md](ARCHITECTURE.md). Два профиля Obsidian и реальный Диск проверяются
отдельно; functional harness не является доказательством этого прогона.

Force maintenance проверяется по kind до encryption recovery и даёт отдельный
`force-recovery-pending`. Completion receipt Force не откатывает последующую
enable/disable/rotate. Guard перед manifest PUT/DELETE не является server fencing;
late manifest write остаётся P0 release blocker в [проверках Force](FORCE_SAFETY_VALIDATION.md).

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

## Новые и существующие пароли

Enable, rotate и Force create принимают 4–30 кодовых точек Unicode без trim,
нормализации или обрезания; составной символ может содержать несколько точек.
HTML password-поле не сохраняет CR/LF. Общая `crypto/password-policy.ts` отклоняет
новый пароль в UI и domain preparation до архива, persistence и remote writes;
локализованная ошибка сохраняет ввод для исправления.

Существующие пароли любой поддерживаемой длины сохраняют точные bytes при
restart, connect, current-password verification, recovery, Force reuse и открытии
backup. Форматы и размеры ключей не меняются, миграция не нужна. Четыре символа
дают слабую защиту от подбора; предпочтителен длинный случайный пароль.
Проверки: `ENC-015`, manual `TC-PASSWORD-LENGTH-01`.

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
  чтение зашифрованного Force source и классификацию encrypted destination.
  Force local не доверяет старому canonical, но scoped cleanup требует читаемый
  текущий manifest и проверенный codec.
- Current manifest обязан содержать semantic marker и полностью, точно
  объявлять `profileId`, KDF, HKDF, content cipher и filename cipher.
- Unknown format/profile/algorithm блокирует watcher, scheduler, upload,
  delete, physical repair и cleanup.

Manifest transitional state содержит secret-free source/target descriptors и
profile IDs. Устройство не выбирает codec по локальной догадке. Manifest,
canonical maintenance и local transition принимаются только с точным набором
полей; ID, initiator, phase, mode descriptors, profile IDs и revisions должны
быть согласованы. Legacy cleanup paths нормализованы, уникальны, не protected и имеют expected
fingerprint. Новые переходы вместо них используют explicit replacement descriptor
и durable recursive deletion cover; см. [политику переходов](#orchestration-и-admission).

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

Обычные startup/full read-sessions и manifest tokens переиспользуют только verified
bytes после fresh scope/root/lock/hash checks. Они не разрешают physical write;
corrective repair повторяет canonical/manifest/physical authority. Ciphertext hash
не сравнивается с plaintext SHA. Подробности общих read/lifetime/ACK boundaries —
[ARCHITECTURE.md](ARCHITECTURE.md#чтение-snapshots-и-lifetime) и
[PARALLELIZATION.md](PARALLELIZATION.md).

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

Matching authenticated candidate устанавливается без повторного PBKDF2 только при
exact manager-owned profile/salt/password. Instance-local WeakMap не удерживает codec
и не принимает сторонние экземпляры. Verifier, canonical target и fresh manifest
проверяются до install; cancellation/config ABA во время derivation запрещает позднюю
публикацию. Отказ persistence сохраняет прежнюю target/error authority, без ложного
success или rollback после commit (`SYNC-048`).

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

Офлайн-устройство сначала аутентифицирует target codec и принимает canonical.
Stable replacement receipt требует authoritative reception до ordinary merge: old
mutations не replay-ятся. У checkpoint без replacement сохраняются прежнее
reconciliation и fresh epoch/canonical/fingerprint guards для physical actions.

## Orchestration и admission

Новые переходы используют **initiator-wins**: frozen local reference в текущих
sync filters, fresh target epoch и stable replacement receipt. Чужие old-generation
PUT/mutation не сливаются в эталон. Верхнеуровневая папка удаляется одним DELETE,
если весь наблюдаемый subtree removable и фильтры покрывают его целиком. Смешанная
папка разбивается до безопасных descendants; root, service paths, `.backup`, plugin
state, исключённые объекты и live target paths не входят в cover. Excluded raw
inventory сохраняется после cleanup, до любого декодирования новым codec.

Durable cover находится в `maintenance.replacement.deletions`; дополнительные
fingerprint actions для него не создаются. Каждая попытка проверяет свежую canonical
replacement authority и отсутствие retained targets, а после отправки — authority
и отсутствие subtree. Изменившийся source fingerprint намеренно не блокирует purge.
Healthy workers переиспользуют каждый свою verified read-session, сохраняя fresh
root/hash/lock checks. Failed guard не ACK даже уже отсутствующего объекта.
Неоднозначный отправленный DELETE разрешается свежим absence proof. Первая ошибка
останавливает admissions, все sent requests joined до recovery. Config ABA/unload
закрывает invocation, автоматический retry под новой configuration запрещён.

После purge весь target проверяется по canonical fingerprints, а drift — по
read-back plaintext SHA. Metadata читается до четырёх запросов между свежими
проверками authority/reference. Collector выбирает fresh parent listing после
DELETE только при известной меньшей стоимости страниц; pre-delete scan служит
только cost hint. Missing entry требует GET; type/pagination drift блокирует finish.
Hashless metadata не заменяет bytes; fallback сохраняет исходный read budget.
Repair и stamps последовательны, с per-attempt authority и mandatory read-back;
stamps берутся из verified snapshot. Failed reads joined до recovery, а lifetime/
config ABA запрещает поздние writes и успех даже после более ранней сетевой ошибки.
Инициатор может восстановить target только из сохранённых
reference hashes. Не более четырёх sweep/repair passes; нет сходимости — нет success.
Local drift не меняет эталон и блокирует завершение. Foreign target-only recovery
использует уже durable raw cover и target codec. Если после crash обнаружился новый
неидентифицируемый source object вне cover, recovery fail closed: нужны source-capable
owner и его ключ; исключения нельзя расширять предположением.

Обычный sync не хранит состояние пустых папок. Complete raw inventory может содержать
пустые деревья от прежнего codec, включая plaintext после enable. Cleanup оставляет
такие деревья нетронутыми и не пытается расшифровать их имена. Непустое дерево
определяется по file descendants полного inventory; retained/protected paths по-прежнему
защищены. Ошибка чтения/listing или нечитаемый file не превращаются в пустое дерево
и сохраняют recovery без success (`TRANS-050`).

Старое устройство автоматически принимает stable target epoch до ordinary baseline
merge и не возвращает offline edits/старые queues на сервер. Выбранные local extras
удаляются, baseline и очереди заменяются только после проверенных bytes и coherent
save. При failed save старые causal IDs сохраняются для повторного приёма. После
foreign completion владелец снимает checkpoint только read-only: matching operation,
reference canonical/local hashes, target read-back, отсутствие source cover и свежая
стабильная authority. Failed save восстанавливает transition и causal snapshot.

Следующие fingerprint/unchanged-epoch правила относятся к **старым guarded
checkpoints без replacement descriptor**, а также к неизменённому pre-commit rollback:

Post-commit cleanup enable/disable/rotate и foreign recovery использует до
`min(maxConcurrency, 4)` исполнителей. У каждого своя invocation-bound canonical
read-session: тело переиспользуется только после свежих root/hash/lock checks.
Каждый DELETE/retry сохраняет порядок canonical authority → разрешённый action и
live-path exclusion → physical fingerprint → canonical authority. Отказ guard
не является неоднозначным ответом DELETE и не подтверждается отсутствием объекта.
После отправленного DELETE повторно проверяются authority и отсутствие source,
затем action завершается через прежнюю coherent persistence queue (`TRANS-042`).

Первая ошибка останавливает выдачу новых paths. Уже начатые задачи завершаются до
recovery, смены codec или снятия maintenance; сохраняется первая ошибка. Readers
закрываются в `finally`, configuration/host lifetime проверяется перед dispatch.
Pre-commit rollback остаётся последовательным со всеми source checks (`TRANS-041`).

Если foreign device уже завершил transition, initiator может снять старые local
cleanup receipts без remote writes: нужны тот же observed epoch, стабильный
canonical без maintenance, принадлежащие transition fingerprints, отсутствие
соответствующих source objects и повторная target/manifest coherence. Появившийся
source блокирует retirement; failed persistence восстанавливает local causal state
и transition. Committed disable после удаления manifest восстанавливается по
plaintext target без исходного пароля (`TRANS-041`).
Retirement использует явно read-only canonical session: lock или missing canonical
блокируют checkpoint без stale-lock repair, MOVE или DELETE.

Rewrite готовит папки параллельно внутри одной глубины, до четырёх siblings,
и дожидается всей глубины перед дочерними путями. Остальные callers сохраняют
default concurrency 1. Ошибка подготовки не запускает transfers. Target codec
переиспользуется только при exact manager-owned profile/salt/password; исходный
codec применяется к source descriptor. Hardened, verifier и полный read-back
targets/выбранного архива неизменны (`PERF-015`). Диагностика:
`npm run check:sync-efficiency -- --encryption-transitions --out <fresh.json>`.
Counts и synthetic timings не доказывают latency реального Диска или Obsidian/mobile.

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
ожидающий password prompt. `prompt` разрешает ввод credentials, а
`allowRecovery: false` независимо запрещает mutating recovery и смену remote mode.
Смена ключа уже подключённого устройства при `prompt: false` создаёт неперсистентный
`rotated` request с profile/salt/revision и захваченными до первого await
configuration/generation/lifetime guards. Поздний verifier не восстанавливает
отозванный request. Host activity запускает его после coordinator и outer owner;
очередь и решения остаются в admission, `main.ts` содержит wiring.

Перед prompt admission перечитывает stable enabled manifest; общий connect с
`allowRecovery: false` проверяет verifier, canonical и fresh authority до install.
После освобождения foreground owner запускается один full; automation возвращается
только после reconciliation и persistence. Каждый target автоматически запрашивается
один раз за экземпляр plugin, включая учёт startup/manual prompts. Cancel/wrong
сохраняет block; manual Sync повторяет ввод, новый target или restart разрешает
новую автоматическую попытку. Token/path change и unload сбрасывают request;
pause/config ABA/persistence failure запрещают поздние install и resume.

Token/path save устанавливает `manualSyncRequired`: до успешного manual full нет
автоматических проверок и prompts, включая restart. Ручной admission проверяет
свежее encryption state через reads текущего invocation вместо cached `validated`.
Connect требует stable manifest без canonical maintenance; manifest/canonical
перечитываются до сохранения credentials без lock recovery и cleanup. Runtime/scope
settings, persistence repair и reopen сами пароль не запрашивают. Guards действуют
через prompt, очередь и derivation, включая codec change. Force сохраняет
`confirmPassword`; recovery не создаёт новый архив. Проверки: `ENC-016`,
manual `TC-ROTATED-PASSWORD-01`.

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
отказ от архива. Source/canonical/codec proofs сохраняются; cleanup policy выбирается по explicit
replacement descriptor, а не по наличию архива.
Пароль архива: target для enable/rotate, source для disable. Recovery и connect
не создают архив повторно; source drift завершает текущую попытку.

При потере initiator target-capable устройство может завершить post-commit recovery
без source password по durable cover. Неидентифицируемый late source object вне
cover требует source-capable owner; recovery не расширяет scope предположением. Оно сверяет ID, initiator, source/target
descriptors, profile и post-commit phase. Для enable/rotate оно аутентифицирует
verifier и явно читает target canonical новым codec; для disable — plaintext
внутри matching IndexManager recovery scope. Отсутствующий manifest допустим
только после commit plaintext target.

Foreign target recovery сначала доказывает target canonical и matching descriptors,
затем публикует stable target manifest или удаляет manifest для plaintext, переводит
canonical в cleanup, выполняет cleanup по explicit replacement policy либо legacy guarded удаления и завершает maintenance. Старое окно
canonical cleanup + manifest index-committed допускается только с той же identity
и descriptors. Manifest перечитывается после recovery. Wrong password и Cancel
не сохраняют candidate credentials и не делают remote mutations.

Для legacy guarded cleanup на каждом delete/retry свежие authority, action, live target mapping и fingerprint
обязательны. Timeout/202/успешный ответ без проверки отсутствия не завершают action.
Старый worker не возвращает completed maintenance сохранением устаревшего снимка.
Target recovery не принимает epoch как local baseline и не replay старые mutations.
Следующий full для replacement receipt получает эталон без старых offline edits;
для legacy checkpoint действует прежнее reconciliation.

## Admission и настройки

Публичные enable/disable/rotate/connect резервируют foreground operation до первого
await и освобождают её через finally. Backup choice dialog не удерживает coordinator;
внутренние connect/recovery/preflight не приобретают повторно reservation владельца.
Настройки path/scope блокируются также сохранённым pending transition. Idle token repair
разрешён для восстановления доступа, но не снимает encryption authority checks.
Internal сохранение target snapshot и очередей не проходит пользовательский allowlist.

## Направленный Force

[Полный direct Force](FORCE_SYNC.md) не выполняет enable/disable/rotate как фиктивный
переход и не меняет semantic markers или hardened profile. Локальное → Диск
применяет frozen filters и к source, и к destination. Для encrypted destination
проверяет прежний пароль и классифицирует logical paths без чтения старых contents.
Если шифрование сохраняется, сохраняется и codec/salt: исключённые ciphertext
остаются читаемыми. Fresh salt создаётся только для нового encrypted назначения.
Удаление codec при исключённых encrypted остатках блокируется до writes; сначала
нужен отдельный disable через настройки. Повреждённый manifest назначения блокирует
scoped cleanup. Canonical пересоздаётся независимо от прежней index history.

Диск → локальное при наличии manifest сначала аутентифицирует выбранные
source paths и bytes; raw exclusions/protected paths пропускаются до decoding. Рабочий manifest и его salt/profile сохраняются. Пароль
проверяется в том же окне Force с повторным вводом при ошибке. Отсутствующий
manifest выбирает обычное чтение имён/bytes даже при прежних локальных encryption
settings; автоматического восстановления потерянных параметров в этом Force нет.
Повреждённый/неподдерживаемый manifest и ошибка его загрузки блокируют подготовку,
не разрешая plaintext fallback. Для зашифрованного источника ошибка чтения или
аутентификации не разрешает очистку локального назначения.

Force не использует временные файлы и не обеспечивает server fencing. Обычный
sync сначала завершает direct-v1 remainder, затем использует прежние encryption
guards. Незавершённый старый scoped Force требует новой явной полной замены.
Реальные два профиля Obsidian/Yandex проверяются отдельно от functional harness.

## Обычный sync при шифровании

`SYNC-050/051` и `PERF-014` сохраняют plaintext semantics: unchanged receipt требует
causal identity и fresh physical proof. Reusable proof связывает реальные raw
ciphertext bytes с server SHA-256 до decrypt; MD5/resource ID не заменяют это
доказательство. Startup raw prefetch не разрешает decode до authentication или
late install после config/codec drift. Force и transitions не используют
published-local-tombstone fast path обычного full.

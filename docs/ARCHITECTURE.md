# Архитектура плагина Yandex Disk Sync

Плагин работает в browser runtime Obsidian на desktop и mobile. Его source of
truth — canonical index на Яндекс Диске; локальные baseline и durable queues
описывают состояние конкретной установки. Нормативные пользовательские исходы
перечислены в [SYNC_USER_SCENARIOS.md](SYNC_USER_SCENARIOS.md).

## Границы модулей

| Владелец                                       | Ответственность                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `main.ts`                                      | Composition root, Obsidian lifecycle/UI, typed blocks, foreground reservation и wiring актуальных ports.                |
| `plugin-persistence.ts`                        | Единственные `PluginData`, coherent tail queue, load generation и unload-save admission.                                |
| `plugin-startup.ts`, `settings-workflow.ts`    | Read-only startup classification; admission, save и publication user drafts.                                            |
| `api/yandex-client.ts`, `api/vault-adapter.ts` | Transport/codec conversion; Obsidian Vault/DataAdapter/FileManager.                                                     |
| `backup/`, `crypto/`                           | Snapshots и exact archive proofs; codecs, manifest, transitions и recovery.                                             |
| `SyncEngine`                                   | Публичные входы, один coordinator, lifecycle/session guards, state/UI listeners и expected watcher events.              |
| `realtime/queue-rules.ts`                      | Pure queue/receipt transformations нормализованных readonly events и submitted ID sets.                                 |
| `FileWatcher`                                  | Identity/time allocation, subscriptions, transient aliases, runtime references, один drain, barriers и save scheduling. |
| `realtime/settlement.ts`                       | `WatcherSettlement` для single/batch file и folder outcomes; receipts, ACK и durability через watcher ports.            |
| `ui/sync-indicator.ts`                         | Общая раскрывающаяся плашка desktop/mobile; только state и callbacks, без domain state.                                 |

Settings/callbacks читаются через live getters; стабильные сервисы передаются
узкими capabilities. Domain-модули не импортируют runtime-фасад или Obsidian UI
и не создают второй coordinator, causal store или persistence queue. Encryption
settings, active codec и transition имеют одного владельца в plugin snapshot;
их orchestration описана в [E2E_ENCRYPTION.md](E2E_ENCRYPTION.md).

В `sync/` папки отражают ответственность: `canonical/`, `local/`, `files/`,
`reconciliation/`, `workflows/`, `realtime/`. Импорты ведут прямо к владельцу без
barrel-модулей. Публичные compatibility re-exports сохраняют constructor identity.

Queue reducer не выполняет I/O, не выделяет ID/seq, не читает часы и не пишет логи.
File/folder rename
reducers используют общий typed chain algorithm; submitted snapshots не
переписываются parent notifications. Receipt effects обновляют existing runtime
references **до ACK**, чтобы текущий drain получил committed revision.
`WatcherSettlement` не имеет очереди, timers или enabled-state. Stopped watcher
завершает settlement принятой сессии без нового replay.

Watcher объединяет saves по неперсистентным dirty/saved revisions поверх прежнего
`PluginPersistence`. Ошибка не становится скрытым успешным retry; durable wait
повторно проверяет актуальную revision после await. Порядок prepare/pause/finalize/
resume, completion-microtask и settings-save описан в
[PARALLELIZATION.md](PARALLELIZATION.md).

Общая upload classification в `rules.ts` ограничена watermark по ID/seq и
live content/SHA predicate. `wasPendingPutAccepted` проверяет live source и
watermark без требования matching upload snapshot; это отдельная семантика.
`batch.ts` сохраняет fresh canonical reads, pending-put eligibility, epoch checks,
receipt reasons и baseline effects. При just-committed receipt stale/foreign
reason использует текущий device ID без обязательного applied watermark;
recovered receipt требует watermark и actor из сохранённого ID. Эти политики
не объединены. Watermark/content predicate сам не разрешает physical write.

Realtime cost audit сохраняет эту границу: canonical body уже не загружается
для здорового edit/window; lock snapshots, per-file stamp/repair и durable ACK
сохраняют порядок. При rename tracked source подготовленный put завершается со
своими ID/seq, accepted receipt передаёт revision rename; новый unsynced source
сохраняет pending-put/coalesced handoff (`SYNC-049`). После interruption recovery
подтверждает source plaintext против durable put SHA; старый canonical source или
его отсутствие допускают только guarded rematerialization текущего target snapshot
с тем же put ID/seq. Source commit/repair предшествуют move. Lifetime-only port
existing read session дополняет fresh guards, bytes между invocation не сохраняются.
Recovery source put передаёт source validator в существующую canonical save queue.
Он проверяет acquired lock до reducer, поэтому foreign same-SHA successor не
становится own put и не получает delete authority через последующий rename.
Semantic rejection откатывает lock без retry; IDs/FIFO сохраняются, следующий
restart/full сохраняет foreign source и публикует target через обычный put-target.
Если physical source уже содержит чужой SHA, recovery сразу использует тот же
put-target с прежним put ID/seq; fingerprint-guarded cleanup не удаляет чужие bytes,
а обычный full сверяет unindexed source без бесконечного pre-full retry.
Его lifetime временно дополняет существующий client writeGuard через
`withWriteGuard`: awaited authority не открывает окно для write после config ABA,
pause или host stop. Callback снимается в `finally`; это не coordinator или cache.
Подробности RED/GREEN и измерения — в
[отчёте](superpowers/plans/sync-efficiency/reports/06-realtime.md).

| Модуль `src/sync`                              | Владелец алгоритма                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `contracts.ts`                                 | Публичные options, proofs, lifecycle и guards; engine сохраняет re-exports |
| `files/operations.ts`                          | Transfers, local writes, physical actions, folders и parallel execution    |
| `files/remote-moves.ts`                        | Snapshot-matched moves, target materialization и guarded source deletion   |
| `reconciliation/commits.ts`                    | Strict/best-effort commits и публикация deletion intents                   |
| `reconciliation/rejected-puts.ts`              | Settlement rejected puts и восстановление canonical winner                 |
| `reconciliation/accepted-uploads.ts`           | Guarded repair принятого upload после commit                               |
| `reconciliation/conflict-settlement.ts`        | Проверенная remote version, сохранение/публикация conflict copy            |
| `reconciliation/physical-recovery.ts`          | Move/delete recovery и подтверждение выполненных physical actions          |
| `reconciliation/baselines.ts`                  | Content verification и подтверждённые causal baselines                     |
| `reconciliation/context.ts`                    | Только typed capability contract для существующих сервисов и live ports    |
| `errors.ts`                                    | Классификация с прежним приоритетом cause                                  |
| `workflows/force.ts`                           | Preflight, bootstrap, source snapshots, replacement и cleanup              |
| `workflows/encryption-rewrite.ts`              | Exclusive target upload, read-back, beforeIndexCommit и finally            |
| `workflows/full.ts`                            | Reconciliation, uploads, pending puts и epoch adoption                     |
| `realtime/batch.ts`                            | Batch, receipts, prepared items, superseded/retry и handoff                |
| `files/rename.ts`, `files/folder-mutations.ts` | Rename/folder алгоритмы с прежним causal timing                            |

Upload и публикация metadata остаются раздельными. Watcher finalization предшествует
`markRemoteObserved`; settlement и очистка validation token остаются в фасаде.
Force UI/архив принадлежат `ForceSyncController`, транзакции — `IndexManager`.

### Стадии workflows и передаваемые данные

| Workflow                  | Стадии и explicit data flow                                                                                                                                                                                                                                                                                                                                                                                                                             | Граница подтверждения                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full                      | `loadFullCanonical` принимает initial receive; `prepareFullReconciliation` возвращает `FullAdmission` (decision + pending work) и сохраняет rollback snapshot в `FullSyncContext`; `scanFullReconciliation` возвращает `FullPlan` (operations + metadata/baseline flags); `applyFullReconciliation` передаёт результаты групп в `FullCommitState`; `commitFullReconciliation` проверяет codec, публикует canonical и вызывает final physical settlement | Engine сохраняет rollback при failed adoption; accept/preserve/later не заменены default. Finalize watcher/initial/epoch предшествует `markRemoteObserved`, ordinary upload ACK/save остаётся в resume до coordinator release           |
| File rename               | `captureRenameTarget` возвращает bytes/SHA/mtime либо typed retry до remote; excluded destination публикует exact delete; fresh canonical classification выбирает already-applied / recovery / put / move; `stageFileMove` готовит общий single/batch intent; `commitFileRename` публикует intent, выполняет guarded move и completion                                                                                                                  | Recovery использует существующий move ID/sequence; исходный outer catch сохраняет незавершённую работу. Prepared snapshot не заменяет fresh authority                                                                                   |
| Folder rename             | Guard + fresh canonical; `getOrCreateFolderMutation` сохраняет retry identity; общий single/batch `planFolderMove` возвращает pairs/hashes/survivors/conflicts; `stageFolderMove` публикует logical intent; `materializeFolderRename` возвращает committed pairs/unresolved; отдельный recovery продолжает исходный move                                                                                                                                | Prepared callback/save до intent; completion commit и coherent save до возвращения completed. Descendant admission и concurrency policy прежние                                                                                         |
| Remote move               | Fresh canonical admission → physical source/target observations → existing/materialized/moved target → `completeMovedTarget` (stamp, затем retire action)                                                                                                                                                                                                                                                                                               | Live target требует `metadata && !deleted`, source допускает retained tombstone. Только content comparison общий; fingerprint/hash и fresh cleanup authority остаются в прежних местах. Final explicit action ID retirement сохраняется |
| Commits                   | Strict/best-effort canonical publication → rejected-put settlement; accepted upload repair отдельно перечитывает canonical/codec/physical; conflict copy проверяется перед corrective write; recovery/baselines имеют отдельных владельцев                                                                                                                                                                                                              | `CanonicalCommitProof` ускоряет лишь безопасное чтение. Он не разрешает overwrite/delete; physical guards и сохранение protective copies не объединены с commit                                                                         |
| Directed Force            | `prepareForceReplacement` → readable full source → optional archive → direct-v1 checkpoint → direct canonical → unfiltered purge/direct transfers → destination/manifest verification → final canonical → `finishForceReplacement`                                                                                                                                                                                                                      | Новый epoch после commit не откатывается; общий finish только после проверок соответствующей ветки. Cutoff IDs retirement до coherent clearing checkpoint; same ID/epoch при retry; ordinary full продолжает direct-v1                  |
| Internal compatible Force | Legacy `forceBackupProof` adapter либо current preflight proof → independent source identity → transfer → repeated source proof → replacement commit → cleanup                                                                                                                                                                                                                                                                                          | Adapter сохранён для существующих consumers/tests. Public directed replacement не получает второй набор сервисов через options                                                                                                          |

`SyncRunOptions.forceReplacement` содержит plan, выбранный backup mode и ephemeral continuing flag.
`setForceReplacementPorts` подключает plugin-owned persistence/password/cutoff
callbacks; engine подставляет свои существующие client/index/adapter и live settings.
Main wiring читает текущие settings getter-ом; dependency objects не изменяются
для установки watcher callback. Стабильные bound guard/UI capabilities читают
текущие engine callbacks/state/token при вызове. Epoch decision также вызывается
через live port, поэтому замена callback во время canonical load видна этой сессии.

Оставшаяся связность явная: conflict/rejected settlement может повторно вызвать
best-effort commit для retained copy; accepted repair использует эти же функции.
Общий typed contract включает транзитивные capabilities этой группы, а baseline
и snapshot helpers требуют только используемые ports. Engine по-прежнему собирает
nested transfer/reconciliation dependencies; это wiring одного набора сервисов,
а не дополнительный store или mutable Runtime. Lookup оптимизирован временными
индексами прохода, описанными ниже. Digest-only traversal и realtime content windows
имеют отдельные границы владения bytes. Safety reads разных времён остаются раздельными.

### Canonical schema и reducer

`canonical/schema.ts` владеет чистой проверкой current canonical shape,
causality и mode descriptors, включая отдельный Force maintenance.
`crypto/manifest-schema.ts` независимо разбирает current hardened manifest:
exact keys, canonical Base64, safe integers и согласованность transition.
Canonical mode validator сохраняет прежнюю менее строгую политику строк и
целых чисел; эти accepted domains не объединяются. Общий object-record guard
находится в `utils/record-utils.ts` и не меняет protected path records.
`IndexManager` вызывает validators, сохраняя transport/read/write и прежний
публичный фасад. Force recovery и plugin loader не загружают runtime manager
ради чистой валидации.

`canonical/merge.ts` владеет чистым `mergeDesiredIndex(input)`:
`CanonicalMergeInput` явно передаёт `latest` (snapshot под lock), `loadedBase`,
`desired`, `deviceId`, `baseRevision`, readonly `completedMoveIds` и упорядоченный snapshot `putBaselines`
(только `type`, `path`, optional `baselineSha256` из pending mutations).
`CanonicalMergeMode` — discriminated union `normal / physical-rewrite /
replacement / target-recovery`; replacement получает timestamp для tombstones,
recovery — конкретный maintenance ID. Приоритет прежних scopes сохраняется:
replacement, затем target recovery, затем physical rewrite, затем normal.
Mode описывает уже выбранную транзакцию и не заменяет guards manager.

`CanonicalMergeResult` возвращает новый `index`, `rejectedPuts` прежней shape
(`path`, `reason`, `remoteFingerprint`, optional `baselineSha256`) и metadata-only
`diagnostics`. Manager снимает snapshots причинного контекста, применяет result
в прежней under-lock точке, сокращает device ID при логировании и владеет
transport, persistence, error/rollback и acknowledgement. Reducer не меняет
inputs, не читает store, сеть или часы и не выполняет save/logging.
`transaction-rules.ts` содержит общий `cloneIndex` (deep JSON copy с повторным
`protectRecord` всех четырёх records) и прежний predicate
`isTargetRecoveryIndex(index, maintenanceId)`, используемые manager и reducer.

Порядок reduction сохраняется: replacement; observed maintenance и target
recovery; prepared-claim guard; files (physical stamp перед logical mutation);
folder tombstones и surviving descendants; moves и completed move IDs;
watermarks; maintenance; revision только при изменении. Watermark-only no-op
по-прежнему публикует revision, а physical-only stamp сохраняет mutationSeq 0.
Последний put baseline индексируется в Map один раз за merge snapshot: каждый
последующий put по path заменяет предыдущий, включая отсутствующий SHA.
Отсутствие path и значение undefined не дают fallback к более старому baseline.
Store сохраняет direct reverse lookup `findLatestPutBaselineSha` для единичных reads.
Target recovery меняет только maintenance; epoch, post-commit phase и ID
проверяются до раннего возврата.

### Временные lookup и ancestry индексы

`local/baseline-rules.PendingPutLookup` индексирует последний matching put по
(path, SHA) для синхронных baseline/full-upload проходов. Enqueue сразу добавляется
в lookup; более поздний put с другим SHA не скрывает последний matching put.
Epoch не фильтруется там, где его не фильтровал прежний алгоритм. Map keys
сохраняют `__proto__`, `constructor` и undefined SHA без объединения значений.
После await download и rejected-put conflict settlement используют актуальный
`LocalOperationStore.findMatchingPut` через manager: download выбирает последний,
conflict-copy — первый matching put. Возвращается копия только найденного элемента;
`getPendingMutations` по-прежнему возвращает defensive copy всего FIFO. Realtime
eligibility с event ID/epoch/watermark и rename lookup не подменяются этим predicate.

`utils/path-utils.PathAncestryIndex` хранит membership snapshot для merge/replay,
включая exact path и literal slash prefixes без повторной нормализации. Это
сохраняет прежний более широкий local replay domain (включая backslash);
canonical path validation не меняется. Merge строит его после file reduction; surviving descendant
metadata читается из текущего merged index на каждом tombstone в прежнем порядке.
Replay строит его лениво из union local/remote keys; delete-file добавляет вновь
материализованный key. Exact folder path исключается прежним prefix predicate;
каждый descendant заново проходит causal guard. Индексы не переживают проход,
не сохраняются и не подтверждают physical authority. При перекрывающихся папках
повторные visits их descendants остаются необходимыми для causal order.

Prune собирает Set ancestors живых canonical files один раз до candidate filter,
без сортировки живого дерева. Deepest-first порядок candidates прежний. Каждая
DELETE/retry независимо перечитывает canonical epoch/maintenance/live descendants
и фактическую пустоту; file deletes сохраняют свежие fingerprint guards.

### Transaction owners и commit proof

`canonical/commit.ts` владеет обычным exclusive acquire/write/read-back/final move,
исходной bounded retry policy и irreversible committed boundary. Под lock он
получает результат чистого reducer через `reduceLockedIndex`; causal snapshots,
rejected puts и принятие подтверждённого index остаются у фасада. Дочерним
модулям передаются узкие transport/read/accept ports и актуальные getters,
без доступа к store, mutable settings или полному состоянию manager.

`canonical/recovery.ts` содержит `CanonicalRecovery`: два совпавших root listings
с полной пагинацией, наблюдения lease по strict content identity, stale/orphan
recovery, общий exclusive seed, hash/semantic commit verification и raw rollback.
Его единственное собственное состояние — временные observations locks.
Source/target codecs и legacy/replacement admission читаются через getters;
rollback восстанавливает исходные raw bytes и проверяет их прежним source codec.
`transaction.ts` сохраняет transport-independent классификацию и raw rollback,
а также общие `IndexSnapshotReader`/`IndexSnapshotDecoder` contracts.

Публичный direct Force публикует canonical через
IndexManager.publishDirectForceCanonical без locks или MOVE.
canonical/force-publication.ts и прежние proof APIs остаются только внутренним
совместимым адаптером; UI и direct-v1 continuation их не вызывают.
Правила обычных canonical transactions и encryption maintenance не меняются.

`CanonicalMoveResolution` — union committed с `CanonicalCommitProof` либо
неуспешного outcome без proof. `recoverAmbiguousFinalMove` возвращает proof
проверенного snapshot или verification после exclusive retry move;
`isExpectedCanonicalCommitted` возвращает уже полученный proof либо null.
Commit потребляет его внутри той же resolution без немедленного повторного
verify. Proof не переживает новую physical operation/retry и не сериализуется.
Подтверждённый commit устанавливает stage до local acceptance/cleanup: их отказ
не разрешает rollback, а committed-cleanup error сохраняет прежний outcome.

## Canonical, baseline и причинность

Локальная история имеет nullable `remoteScope`: нормализованный remote path и
opaque resource ID корневой папки. После точного перехода с прежней current shape
непустая unbound-история требует одного ручного подтверждения прежнего хранилища.
До admission не запускаются sync/recovery writes. Другой storage подключается
только без durable queues и encryption transition, с новым локальным baseline.
Ошибки persistence восстанавливают прежнее causal state. Привязка не заменяет
content fingerprints; root identity проверяется перед physical writes/retries и
canonical transactions. Download и conflict copy повторяют scope guard перед
финальной local identity check после подготовки parent folders. Неоднозначный PUT
проверяется read-back без ослабления write guards. Ошибка bulk upload сохраняет
pending FIFO и останавливает full до settlement; corrective physical repair
сохраняет accepted causality и использует guarded physical rewrite.
Один активный baseline не является multi-storage database.

Потеря plugin data означает нового actor даже при прежнем ID в localStorage.
Существующий actor перед новыми allocations сверяет FIFO floor с canonical
watermark того же epoch. Чужие очереди не переподписываются и gaps не заполняются
догадками. Отсутствующий/недоступный localStorage восстанавливает ID из валидного
local state; известный чужой cache ID не присваивает себе pending work.
При чистом первом sync epoch фиксируется до enqueue/persist, без продвижения
`observedRevision` и подтверждения baseline. Legacy baseline и replacement adoption
сохраняют отдельные правила rollback. `local-state` блокирует normal startup;
подтверждённый Force проверяет собственный source и выбранный путь подключения независимо
от старого destination baseline. Ошибка load/persistence не обходится.

`LocalSyncState`, FIFO-очередь мутаций, durable watcher events и очередь
незавершённых физических действий хранятся атомарно в `data.json`. Чтение
canonical index не продвигает `observedRevision`: она меняется только после
полного успешного reconciliation. Мутации нумеруются
монотонным `seq` для каждого устройства, а индекс хранит только непрерывный
high-watermark `appliedMutationSeq`.
Последовательный edit того же installation ID считается причинным successor,
если его sequence непрерывно достигнут watermark текущего epoch. Поэтому
устаревший `baseRevision`, снятый до завершения предыдущего upload, не создаёт
ложный конфликт. Для другого device ID по-прежнему применяется сравнение с
baseline/base revision; одинаковый sequence с разным logical state и FIFO gap
блокируют commit как повреждённое причинное состояние.

Проверенное обновление только `remoteFingerprint`/`remoteMtime` не является
логической mutation, в том числе для существующей записи с `mutationSeq: 0`.
Под canonical lock сравнивается вся исходная file entry: уже совпавшее target
состояние идемпотентно, любое другое изменение этой entry отклоняет устаревший
stamp. Изменения других entries не мешают commit. Все причинные поля, watermark,
plaintext SHA и пользовательские bytes сохраняются; глобальная revision меняется
только при фактическом обновлении canonical. Старые prefixed stamps исправляются
после stable logical read-back, без Force и перенумерации очередей.

Авторитетное состояние находится в одном файле
`.obsidian-sync-index.json` на Яндекс Диске. Для записи файл атомарно
перемещается в уникальное `.obsidian-sync-index.lock.<transactionId>`,
обновляется и перемещается обратно с `overwrite=false`. Неизменившийся за две
минуты единственный читаемый lock восстанавливается другим устройством. Несколько
locks или несовместимые snapshots блокируют normal sync; подтверждённый Force
заменяет только зафиксированный preflight набор locks. Список lock читается с полной пагинацией;
транзакция требует два последовательных одинаковых снимка root listing.
Recovery привязывает единственный stable raw snapshot к исходному strict
fingerprint наблюдения, затем эксклюзивно переносит исходный lock в уникальный
raw lock того же reserved namespace. Claim получает stable raw read-back и должен
точно совпасть с исходными bytes до отдельного MOVE в canonical. Каждая попытка
claim, publication или возврата требует свежего stable root listing с единственным
pinned source и отсутствующим canonical. Codec fallback использует одни bytes;
transport/semantic failures не дают права на другое codec-чтение или публикацию.
Renewal до claim начинает новую двухминутную lease. Renewal на server boundary
claim не публикуется: fresh bytes возвращаются на исходное имя только exclusive
MOVE с теми же guards; иначе остаются raw locks для explicit recovery, без overwrite.
Resurrected original или competing lock блокирует publication. Lost MOVE reply
разрешается exact raw read-back и проверкой единственности восстановленного имени;
success-log появляется только после подтверждённого canonical без locks.
Crash оставляет обычный raw claim lock: новый recovery заново наблюдает полную lease.
Path-based API не поддерживает atomic source precondition: наблюдения и MOVE не
атомарны. Уникальный claim отделяет publication от пути прежнего владельца;
обнаруженный drift после final guard остаётся fail-closed без corrective overwrite.
Отсутствующий canonical создаётся одним общим initialization-путём с непустым
installation device ID и `overwrite=false`. Exact JSON seed и кандидата commit
проверяется текущим валидатором до upload. Неоднозначный seed upload разрешается
stable read-back; чужой seed можно принять normal read, но нельзя заменить Force
на основании прежнего доказательства отсутствия canonical.
Успешный commit возвращает временный `CanonicalCommitProof`. Он позволяет
пропустить повторный index download только при совпавшем SHA-256/MD5 и
отсутствующих locks. Proof не сохраняется и не разрешает physical write:
corrective upload заново проверяет canonical и encryption manifest.

Обычное чтение canonical и чтение с явным recovery codec используют metadata
из двух совпавших root listings как начальное наблюдение stable raw read.
Проверка после download остаётся обязательной. Независимый `readCanonicalIndex()`
всегда создаёт новое чтение, без кеша между сессиями. Initial receive использует
одну временную read session с последним проверенным `IndexFileSnapshot`: свежие
scope и два стабильных root listings выполняются для каждой проверки; только
совпавший SHA-256/MD5 и отсутствие locks позволяют не передавать те же bytes.
Без hash либо при drift выполняется полный stable download. Снимок возвращается
копией, не сохраняется и не является `CanonicalCommitProof` или разрешением
physical write. Общий hash/lock-критерий используется также post-commit repair.

Обычный full владеет explicit `CanonicalReadSession` с callable read, `load()`
и `assertCurrent()`. `load()` сохраняет фактически загруженный и проверенный
`IndexFileSnapshot` приватно; desired и loaded reducer views получают независимые
копии. Нельзя seed-ить сессию через caller-supplied `SyncIndex`. Upload guards
получают эту же сессию и manifest validation token из admission: каждое обращение
по-прежнему выполняет свежие scope, stable root, locks и server-hash checks.
Первая передача не дублируется конкурентными guards; failed observation отклоняет
следующие queued reads. Нет hash или обнаружен drift — прежний stable download
с post-transfer metadata. Отдельный full/read начинает независимую сессию.

Read generation учитывает token/path/active codec и transition-codec ABA;
invocation проверяет coordinator identity, pause generation и host stop/unload
до и после awaits. Ordinary full передаёт ту же сессию в client.withWriteGuard:
синхронная проверка непосредственно перед native/API dispatch сохраняется после
awaited authority, включая retries/rollback. Finalize callbacks также ограничены
этой lifetime; interruption не продвигает observed revision/time. Main подключает
только lifecycle getter. Read snapshot не
является write proof: before-PUT/retry/ambiguous read-back guards и свежая physical
проверка сохранены. Accepted-upload repair сначала проверяет physical fingerprint;
при совпадении local bytes не нужны. При необходимости repair local SHA и свежие
canonical/manifest/physical guards выполняются перед corrective write. Direct Force,
maintenance и realtime не подключаются к ordinary-full reuse. См. `SYNC-041/042/043`.

Ordinary full определяет необходимость remote commit сравнением всего desired canonical
с независимым loaded snapshot через `IndexManager.hasPendingCanonicalChanges()`.
Pending mutations (включая matching put/noop watermark), move completions и активные
commit modes также требуют transaction; imported physical metadata, tombstones и
maintenance входят в сравниваемый JSON, conflict settlement сохраняет commit.
Количество downloads и изменение только local baseline не определяют remote dirty.
Перед read-only завершением сначала coherent save частичных baselines/queues без
продвижения observed revision/time и без watcher ACK, затем fresh session evaluation:
scope, manifest token, unlocked stable root и exact canonical comparison. Drift,
config/lifetime ABA или save failure запрещают success; сохранённый partial baseline
позволяет безопасный restart без ложного offline conflict. Physical recovery и lifecycle
finalize/observed сохраняют прежний порядок. Эта оптимизация не применяется к
Direct Force, realtime или encryption maintenance (`SYNC-045/046`).

Initial identical admission повторно использует только положительные raw file metadata
из свежей stable root pair своей evaluation. Копия не является observation или
write proof. `YandexDiskClient.collectLogicalMetadata` общий для initial и
`IndexManager.refreshMissingServerMetadata`: immediate-parent listing выбирается,
только когда известное число страниц меньше числа требуемых GET; неизвестная
стоимость означает individual GET. Listing полный и строгий: смена directory→file между страницами и duplicate raw aliases
отклоняются без partial result. Пропуск требует GET,
не inference отсутствия. Full хранит page costs только в FullPlan текущего invocation.
После bulk выбираются все live canonical entries без remoteMtime, включая старые
пропуски; повторного recursive scan незатронутых веток нет. Original full inventory
по-прежнему обнаруживает foreign edits. Optional stamp failure сохраняет прежний
fallback, pre-write fingerprints всегда свежие (`SYNC-044`).

Для initial paths с совпавшим local SHA-256 metadata обрабатываются read-only группой
с лимитом `maxConcurrency`. Scope, manifest и stable canonical проверяются до и
после наблюдений; local bytes проверяются перед подтверждением. Совпавшие physical
fingerprints дают только baselines: группа сохраняется одним coherent save с
rollback при его ошибке, без physical write и без продвижения observed revision/time.
Несовпавший physical fingerprint сразу запускает прежний stable download внутри той же
bounded task с уже прочитанными metadata и исходным budget, без нового deadline и без
ожидания остальных metadata. Остальные paths также сохраняют per-action guards.
Финальные authority/local checks обязательны перед завершением.
Пауза до или во время authority check запрещает подтверждение initial receive.

Initial guards и ordinary-full upload guards используют `session(validate)`:
каждая evaluation получает новую пару полностью paginated raw root listings.
Root path/type/resource ID и существование проверяются на каждой странице и между
проходами; missing identity, неполная/повторная страница или неизвестная service
identity блокируют чтение. Signature включает raw canonical/manifest/lock metadata.
Scope и manifest-token validators получают один opaque `RemoteAuthorityObservation`
из этой пары; затем canonical validator использует её metadata. Observation
зарегистрирована только на время callback, привязана к manager/config/lifetime и
удаляется через finally. Повторное использование позже или другим manager запрещено.
Нет global/TTL cache, persisted proof или нового mutex. Checks без безопасного
представления в observation сохраняют отдельный fresh read; unbound/prompt storage
admission и manifest body admission остаются самостоятельными.

Перед каждым следующим write/retry выполняется новая evaluation, а standalone
client writeGuard, physical fingerprint, backup и post-transfer checks сохранены.
Read observation не является `CanonicalCommitProof` или write authority. Recovery
проверяет scope/manifest до lock cleanup; ожидание lock получает новые listings.
Config/pause/host checks bracket каждую страницу и callback. Ошибка прекращает queued проверки этой read session;
следующий full начинает новую. Изменение token, remote path или active codec
до/во время чтения запрещает применение снимка, включая смену обратно на прежнюю
конфигурацию. Текущие ссылки transition services также проверяются на совпадение.
Timeout и повторные попытки транспорта
не расширяются; direct Force publication сохраняет свой отдельный контракт.

`IndexManager.buildLocalIndex()` требует полного local snapshot внутри прежнего
sync scope. Ошибка чтения или hashing любого syncable файла пробрасывается с
исходной cause вместо частичной Map: unreadable не означает missing. Это общий
контракт для full planning, initial receive, epoch adoption, Force и re-encode;
неполный scan не разрешает новые delete intents или causal confirmations.
Protected/excluded файлы по-прежнему отфильтровываются до чтения.

Full без adoption, maintenance и начатой ранее causal/physical работы не создаёт
delete action для tombstone, когда оба scan подтверждают отсутствие объекта и
VaultAdapter повторно подтверждает отсутствие файла и папки. Такой путь не
увеличивает `deleted` и не требует canonical commit. Неизвестному файлу не
добавляется фиктивный baseline; existing baseline и observed revision сохраняются
через обычное успешное завершение full. Появившийся после scan локальный объект
или ошибка чтения существующего файла требуют повторного reconciliation.

`SyncCoordinator` сериализует full, Force, realtime и encryption maintenance.
Watcher сохраняет одну durable queue и один drain. Full prepare фиксирует cutoff,
settlement/ACK/save завершаются до coordinator release; failed session не
подтверждает queue и не запускает replay. Initial receive, stopped watcher,
rename handoff и late-event rebase имеют отдельные durability boundaries в
[PARALLELIZATION.md](PARALLELIZATION.md#watcher-и-persistence).

Realtime upload/delete series исполняется внутри одной сессии последовательными
окнами до 32 events / целевые 8 MiB plaintext. Каждое окно завершает commit,
repair, cleanup и receipts/ACK/save до освобождения snapshots и следующего prepare.
Result содержит metadata без content. Overflow recapture, oversized files и
дополнительные commits описаны в
[PARALLELIZATION.md](PARALLELIZATION.md#папки-retry-и-memory).

Обычные независимые rename events могут исполняться пачкой до 32 root events внутри одной realtime coordinator-сессии: общий intent commit, плоская очередь guarded file moves с общим concurrency ≤ 4 и общий completion commit. Подготовка file/folder intent используется также одиночным путём; новых persisted records нет. Отбор не перескакивает через excluded/submitted events, upload/delete, зависимости или пересечения source/target. Только неизменённые snapshots с causal baseline входят в fast path; неподходящий префикс возвращается одиночной обработке без allocations. Ошибка либо obsolete physical result не подтверждает watcher event; существующий recovery завершает классификацию. Committed-cleanup error не означает rollback и не разрешает выделить новые sequences.

File rename stages и сохраняет свой FIFO sequence до первого logical commit.
Retry перечитывает canonical и использует исходную pending mutation; непрерывные
target puts, поглощённые тем же snapshot, завершаются watermark-only no-op без
пропуска чужих операций. Сбой не должен накапливать новые sequences на каждом retry.
Быстрый перенос папки сохраняет порядок дочерних пользовательских действий и связь
rename с running upload. Переименовываются оба пути ещё не выполненного события;
механические child notifications промежуточных папок не создают отдельные mutations.
Новые unsynced копии остаются в durable queue по конечному пути.

До remote classification startup загружает local baseline/очереди и один раз
регистрирует lifecycle callbacks. Это выполняется даже без token и при 401/403.
Неперсистентные typed-блоки `migration`, `encryption`, `historical` и
`authentication` останавливают normal full, realtime, watcher и scheduler.
Подтверждённый directed Force выполняет собственный readable-source и connection
admission независимо от destination historical/encryption/authentication/local-state
blocks; failed local load/persistence не обходится. Internal compatible Force
сохраняет прежний guard, допускающий только migration block. Resume сначала
выполняет read-only recheck и не может скрыть активный блок статусом `idle`.
Persisted watcher events загружаются в память, но watcher и scheduler
запускаются после строгой проверки manifest/canonical и успешного full reconciliation.
Resume также выполняет full перед replay накопленных событий; неуспешная
проверка, пауза или unload оставляют автоматику остановленной.
Manifest и canonical читаются единым stable raw-примитивом
`metadata → download → metadata`; неизменность подтверждается по `sha256`,
затем `md5`, затем паре `server modified + size`. Canonical и lock находятся
одним стабильным root listing, после чего physical tree сканируется отдельно
с параллельностью независимых чтений папок по `maxConcurrency` (1–40,
по умолчанию 20; сохранённые значения сохраняются). Страницы одного каталога,
зависимые guards, canonical transactions и сохранение состояния сохраняют порядок;
специальные лимиты Force/rename/recovery не меняются. Перед записью manifest проверяется по
session token. В ordinary full даже read-only результат получает fresh final evaluation;
matching service hashes позволяют обойти body transfer, но не root/guard checks.

Plaintext stable 1.0/1.1 canonical точной формы `version: 1`/`version: 2`
требует явного Force на авторитетном устройстве. Stable local settings/hashes/baseline
необратимо преобразуются и сохраняются одним current snapshot после installation
identity, до автоматизации. Ошибка load/save блокирует sync; unload не заменяет
непрочитанные данные. Lifecycle регистрируется до token/remote checks. Current
canonical допускает normal full adoption, отсутствующий — initial sync. Автоматического
архива при conversion или foreign adoption нет. Resume не снимает typed blocks;
encrypted legacy и неподдерживаемые historical formats блокируют обычный sync.
Force local может заменить такие metadata назначения без их декодирования.

Force — полная замена всего назначения фактическим источником, независимо от
обычных include/exclude. Контракт, исключения, direct-v1 checkpoint, миграция
и ограничения описаны в [FORCE_SYNC.md](FORCE_SYNC.md).

Локальное → Диск сохраняет корневую .backup, удаляет старые payload/index/locks
и пишет файлы напрямую. Старый ключ/индекс/fingerprint назначения не требуются.
Диск → локальное предварительно читает и расшифровывает физический источник;
сохраняет локальную .backup и собственный плагин, остальные файлы заменяет.
Рабочий source manifest сохраняется, canonical перестраивается по source.

IndexManager владеет прямой публикацией Force в конечный canonical path.
Временных файлов, leases, staging и MOVE в этом пути нет.
Обычные canonical transactions сохраняют эксклюзивный MOVE.
Ошибки отдельных действий не отменяют остальные; partial result сохраняет
оставшиеся действия для обычного full/startup/scheduled sync до нормального merge.
Успех Force не требует последующего ordinary full. Старые scoped checkpoints
не продолжаются как полный purge: нужен новый подтверждённый Force.

Current canonical хранит `mutationSeq` в file metadata, folder tombstones и moves. Folder move
фиксирует logical intent одной revision, а физически выполняется как
ограниченная пачка guarded file moves; folder-level move API не используется.
Перед использованием current canonical проходит строгую runtime-валидацию всех
records, путей, числовых полей, mutation watermarks, moves, tombstones и
maintenance. Семантически неверный canonical не запускает codec fallback и блокирует
normal sync без удалённых записей.

Full reconciliation классифицирует каждую операцию как новую локальную
mutation, применение canonical state либо physical repair. Новый logical
delete всегда резервирует FIFO sequence до canonical commit. Уже принятый
tombstone применяется физически без изменения `lastModifiedBy` и
`mutationSeq`. Current file entry без sequence не даёт causal proof для
destructive folder operation и не получает baseline fallback; само наличие
такой записи не включает historical recovery.
Force создаёт один новый `epoch`. Другое устройство с offline delta или durable
work сначала показывает выбор: принять remote state, разрешить перенос своих
правок либо отложить. До выбора baseline/очереди и локальные bytes сохраняются,
старые изменения не отправляются. Выбор привязан к конкретному epoch; ещё одна
замена требует нового выбора. Без offline delta допустим обычный full adoption.
Принятие remote использует обычные protective copies; перенос правок — прежний
three-way reducer с новыми причинными counters. Это не повторный Force.

Смена epoch во время realtime замораживает старые intents и запрашивает один
coalesced full. Force replacement содержит только выбранные live entries с
`mutationSeq: 0`; старые causal receipts не переносятся. Обычные logical mutations
по-прежнему проходят строгие FIFO/sequence guards.

Первое подключение pristine device выполняет `workflows/initial-receive.ts` внутри
full coordinator: сначала cloud live paths и exact tombstones, затем coherent
local save, после него обычная загрузка unknown local-only. Разные local bytes
сохраняются защитными копиями вне sync scope; conflict copy не создаётся.
Eligibility использует существующие revision/time/sequence/queues; partial baselines
не завершают подключение. Legacy baseline с неизвестным epoch и существующие
causal mutations не переводятся в этот режим. Persist failure откатывает только
неподтверждённое завершение; уже применённые bytes и partial baselines остаются.
Новых persisted fields или изменений canonical/physical-action schema нет.

## Encryption profiles и migration

Единственный codec — `hardened`: PBKDF2-HMAC-SHA256 600 000 и HKDF-separated
AES-GCM content / AES-SIV filename keys. Numeric/unknown historical encryption
formats блокируют normal sync и чтение encrypted source; Force local имеет
отдельные правила raw destination replacement.

Enable/disable/rotate используют существующий `EncryptionTransitionController`.
До canonical commit авторитетен source; после commit — target, rollback запрещён.
Injective target mapping и exact read-back создают pinned target proofs до commit
или cleanup. Pre-commit rollback имеет отдельную ephemeral authority и не публикует
post-commit cleanup. Завершение checkpoint после failed final save не получает
права DELETE. Foreign target recovery требует matching ID/descriptors/phase,
а совпадения device ID недостаточно.

Wire formats, manifest publication windows, candidate credentials, guards каждого
DELETE/retry и restart описаны один раз в
[E2E_ENCRYPTION.md](E2E_ENCRYPTION.md). `clearIndexTransitionServices()` всегда
выполняется через `finally`; recovery/connect не создают новый архив.

## Локальное применение и физический cleanup

`uploadFile` использует один missing-parent recovery tail независимо от
`skipFolderCheck`: initial parent preflight сохраняется, transport 404 сбрасывает
folder observation, пересоздаёт parent и допускает один повтор `putFile`.
Повторный 404 выходит ошибкой; exclusive 409 не запускает recovery/overwrite.
Перед каждым фактическим PUT, включая retry и parent recovery, выполняются
актуальные `beforeAttempt` и storage write guard. Ошибка любого guard либо
ambiguous read-back, включая 404, возвращается с исходной identity и не считается
ответом upload transport. Она не разрешает mkdir, новый PUT или ложный успех.
Move сохраняет `beforeAttempt` перед каждой POST-попыткой; DELETE и его polling
сохраняют отдельную классификацию отсутствия объекта.

Encryption mapping использует общий `getAncestorDirectories` после строгой
валидации source/target paths; Set нужен только для membership. Raw/logical reads,
live target/retained source и service/physical fingerprints имеют разные
accepted domains и остаются отдельными контрактами.

Прямой GET bytes использует ограниченные `maxRetries` и backoff клиента при
сетевом исключении или retryable HTTP-ответе (423/429/500/502/503/504). Каждая новая попытка
получает новую signed download link; link не логируется. Окончательные HTTP-ошибки
и ошибки декодирования не повторяются. HTTP 404 от signed link остаётся ошибкой
передачи и не доказывает отсутствие API resource или encryption manifest.
API GET также повторяет завершённые HTTP 500/502/504 в пределах maxRetries;
правила PUT и polling записей не расширяются. Force preflight при постоянной
ошибке чтения remote snapshot завершается до mutations, включая without-backup.
До полного download и успешных apply guards
локальные bytes/baseline не подтверждаются; retry не изменяет правила конфликтов.

GET к API, signed download link и operation status имеют deadline 60 s.
Stable raw/logical read и direct download используют общий 60 s budget на
metadata/link/bytes/retry/backoff. Незавершённый native request не повторяется,
поздний ответ не применяется; queued downloads после timeout не запускаются,
уже начатые tasks дожидаются settlement. Full выходит до новых conflict/delete
commits, сохраняя durable work.

Stale-lock recovery декодирует один stable raw snapshot разными codecs;
только `UnreadableRemoteIndexError` разрешает fallback. Encryption recovery
тоже не превращает transport/persistence/semantic failure в выбор другого codec.
Подробные local apply и conflict правила: [CONFLICTS.md](CONFLICTS.md).

Download фиксирует отсутствие файла или его plaintext SHA до remote I/O.
`VaultAdapter.writeFile` принимает необязательный guard: после подготовки папок
проверяет identity и всё локальное дерево, затем регистрирует ожидаемое watcher
событие непосредственно перед записью. Protective copy нужна для отличающихся
неподтверждённых bytes, включая файл без baseline. Ошибка копии запрещает запись;
после неё SHA проверяется повторно. Late edit/create остаётся для reconciliation,
без подтверждения baseline или счётчика download.

Конфликтная копия переиспользуется только по фактическим bytes. Её локальная
правка сохраняется отдельно; новое имя создаётся с условием отсутствия.
В обычном sync exact/NFC/case-fold collisions сегментов, файл на месте папки
или предка блокируют применение. В Force source ambiguity также блокируется,
но destination blockers могут быть устранены после intent с сохранением
protected/excluded descendants. Exact update, Unicode и `__proto__` допустимы.
Полный collision preflight и final scan всего загруженного дерева после await
сохранены: `getAbstractFileByPath` не доказывает отсутствие NFC/case sibling
или несовместимого предка. Стоимость final scans пропорциональна числу download
и размеру дерева; уменьшение требует проверенного Vault observation lifecycle.
Политики не дублируются: `hasPortablePathCollision` и
`shouldInspectRawSyncPath` остаются общими path-utils владельцами.

Физическое удаление в обычном sync требует durable action и свежего canonical.
Направленный Force использует свой coherent checkpoint и canonical intent,
сохраняя свежие operation/scope/fingerprint guards. Каждая сетевая
попытка, включая retry, повторяет authority и fingerprint checks. Move cleanup
проверяет также актуальный move и физически доступный target. Папка удаляется
только при отсутствии live descendants в свежем canonical и фактической пустоте.
После protective backup локальное удаление повторяет canonical/SHA checks;
FileManager отправляет файл в trash. Изменившийся snapshot остаётся pending.

Результаты physical action различаются: `completed`, `cancelled`, `deferred`.
Отмена устаревшей authority не означает удаление; deferred не увеличивает
счётчик удалённых файлов и не подтверждает baseline. HTTP success/202 сам по себе
не доказывает отсутствие объекта. Эти проверки не дают атомарной защиты от
произвольной внешней записи между последним чтением и mutation.

Invocation-bound startup reads (`SYNC-047/048`) принадлежат `PluginStartup.runInvocation`.
`StartupInvocation` лениво создаёт `IndexManager.createStartupReadSession`, передаёт
её через token settings/cold layout/resume/manual full и закрывает в
`finally`. Scheduler вызывает самостоятельный `engine.fullSync`: его admission и
canonical session независимы. Standalone `refresh` владеет отдельной сессией. Recovery или изменение
codec отбрасывает её; новая сессия не получает старые bytes. Только приватный
verified download seed-ит canonical/manifest; каждый reuse получает новую stable
root pair, scope/lock/hash и config generation checks. Full добавляет собственные
coordinator/pause guards. Initial receive использует ту же canonical session;
write/repair authority, coherent partial save и final ACK barriers остаются прежними.

Parsed canonical переиспользуется только вместе с приватной identity decode context:
`undefined` — захваченная active/transition configuration, `null` — explicit plaintext,
объект codec — exact explicit candidate. Fresh hash/lock/scope/config checks не требуют
повторного decrypt/parse при той же identity. Другой context заново аутентифицирует raw
bytes; его ошибка блокирует всю session. Body drift/no-hash сохраняет прежний verified
read/decode путь, а caller получает независимый clone (`SYNC-047`).

`EncryptionManager` отмечает только собственные подготовленные codec в instance-local
WeakMap с параметрами derivation. Snapshot install может использовать такой codec
только при exact profile/salt/password; произвольный caller codec не принимается.
Это не persistent/global secret cache и не пропуск verifier/canonical target proof.
Connect повторно проверяет manifest и connection перед install. Settings/service
публикуются согласованно через прежнюю persistence queue; отказ save не даёт success,
после target commit rollback по-прежнему запрещён.

## Startup и остановка

| Состояние/событие                      | Переход и разрешённая работа                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Load/read/format failure               | Persistence закрыта; save/unload не заменяют исходные данные defaults.                                                                                                                                                            |
| Identity и stable migration            | Сначала installation identity и один coherent current save; его failure закрывает startup и unload retry.                                                                                                                         |
| Компоненты созданы                     | Baseline, mutations, physical actions и watcher events восстановлены, lifecycle callbacks зарегистрированы до layout/token checks.                                                                                                |
| Layout ещё не готов                    | Remote automation не запускается; поздний callback после unload игнорируется.                                                                                                                                                     |
| Pending Force recovery                 | Layout/manual/scheduled full подхватывает direct-v1 remainder до merge; legacy требует нового Force confirmation.                                                                                                                 |
| Нет token / root admission отклонён    | Typed authentication/local-state block; local queues сохраняются. Token repair повторно классифицирует storage, не переносит work в чужой root.                                                                                   |
| History / migration / encryption block | Разные typed blocks сохраняют приоритеты `SyncEngine`; startup не объявляет их ready. Foreign migration decision перечитывается.                                                                                                  |
| Read-only classification ready         | Только успешный full допускает watcher/scheduler. Явная пауза сохраняется, settings её не снимают.                                                                                                                                |
| Save failure                           | Непринятый draft не публикуется; normal automation остановлена до успешного user save и повторного startup/full. Internal recovery пользуется той же очередью.                                                                    |
| Новая load generation                  | Очередь дренируется; старые queued saves отклонены до write, in-flight save не публикует draft после supersession. Уже начатый storage write не отменяется.                                                                       |
| Unload                                 | Watcher/scheduler и Notice timers/subscriptions остановлены; unload-save проверяет loaded/failed state в момент исполнения. Lifecycle subscriptions снимаются после settlement уже принятой сессии, без новой maintenance-сессии. |

Новый persistence snapshot строится при исполнении задачи и отделён от live references
на время `saveData`. Encryption settings/transition и Force checkpoint сохраняются
через эту же очередь; отдельного password/snapshot канала нет. UI setters только
передают typed block движку и показывают его причину, не снимают pause и не решают
порядок admission. Поздние Notice/epoch callbacks после unload не создают новую работу.

## Настройки и автоматизация

UI передаёт `UserSettingsPatch` через runtime allowlist. Installation identity и
принятый encryption snapshot сохраняются внутренними workflow. Пользовательский
candidate сохраняется согласованно с актуальными queues в существующей persistence
очереди; только после успеха он публикуется компонентам. Failed save не публикует
candidate и блокирует sync до восстановления persistence.

Connection/scope нельзя менять при preparing/queued/running sync, Force preflight,
encryption operation или backup. Pending transition блокирует смену папки и состава
файлов, но idle token repair разрешён и не снимает encryption block. Непустые durable
queues запрещают перенос destination. Сначала watcher останавливается и сохраняет
события, затем ставится задача settings persistence: обратный порядок создаёт deadlock.

Назначение settings само не запускает watcher/scheduler. После изменения выполняются
cache invalidation и read-only recheck; смена destination/scope требует full до
realtime. Остановленный watcher участвует в full settlement, но не запускает replay.
Автоматизация учитывает layout readiness, typed startup blocks, явную паузу и unload.
Подробности очередей и параллелизма: [PARALLELIZATION.md](PARALLELIZATION.md).

Engine трактует lifecycle callbacks как durability boundary. Отказ pause прерывает
body до reconciliation. Resume исполняется до итогового result/status/success-log
и до освобождения coordinator; отказ successful resume делает сессию неуспешной
с исходной cause. Остальные resume callbacks получают failure и не допускают replay;
ошибка cleanup failed session не скрывает её исходный отказ. Подтверждённые
physical/canonical изменения не откатываются из-за ACK/save failure. Late watcher
events при epoch adoption также сохраняют новый causal context до возврата
resume; failure не подтверждает adoption и сохраняет прежний durable ID для restart.

## Архивы и пользовательские операции

Force предлагает один dialog с archive toggle off by default; enable/disable/rotate
сохраняют прежние with-backup, without-backup и cancel. Force не проверяет старую operation authority; connection и читаемый source обязательны. Force без
backup также пропускает per-file copies и destination-content snapshot;
обычный sync сохраняет обязательные protective copies.

Ручной backup использует существующий coordinator и фиксирует path/mode/password
до чтения файлов. Список/download учитывают configuration generation и закрытие UI.
Materialized ZIP и digest-only имеют общую exact identity, но разное владение bytes.
Формат envelope, password policy, freshness и пределы памяти:
[BACKUP.md](BACKUP.md).

## Состояние синхронизации и уведомления

`SyncCoordinator` назначает каждой full, realtime, Force или maintenance-сессии
идентификатор и тип. `SyncEngine` публикует через один `SyncState` стабильную
фазу, время начала и опциональный прогресс `{ completed, total }`. Смена фазы
удаляет прогресс предыдущей фазы, поэтому завершённая пачка не оставляет
устаревший `N/M` во время записи canonical index или physical cleanup.

`sync-status-presentation` содержит общее форматирование для единого
`SyncIndicator` на desktop/mobile и обновляемого `Notice` ручной full, Force
и enable/disable/rotate. Startup, scheduler и realtime отражаются в постоянной
плашке; progress Notice для них не создаётся. Foreground и blocking Notice
сохраняют прежнее поведение.

Кнопки синхронизации в настройках и плашке используют общую активность:
любой normal full, включая validation до engine-сессии и persistence после неё,
блокирует повторный запуск. Другие busy-операции также блокируют запуск без
full-loader. Плашка перечитывает актуальный контекст: active Force flow → active
sync → foreground encryption/backup → normal full при idle/initializing →
состояние движка. Состояния блокировки сохраняют приоритет; Force удерживает
ownership между внутренними сессиями.
Ожидание canonical lock при startup отражается активной плашкой и однократным
INFO-сообщением с длительностью защитного lease; ожидание не сокращает lease
и не разрешает обходить canonical recovery.

При первой ошибке transfer ещё во время пачки `SyncState.errorMessage` получает
причину; progress считается по завершённым tasks, включая ошибки, без пропущенных
queued tasks. Conflict task увеличивает completed после завершения попытки.
Плашка и ручной Notice сохраняют первую причину с operation/code и числом ошибок.
Команда показа статуса открывает полный selectable текст с маскировкой credentials.

На desktop плашка справа снизу, на 8 px над видимым status bar или нижним краем
окна; прежний YD в баре не создаётся. Подробности раскрываются вверх. На mobile
плашка справа сверху, на 8 px ниже видимых панелей и safe area; подробности
раскрываются вниз. Правый край закреплён, ширина раскрытия до 360 px с полями
не менее 12 px. Измерения chrome изолированы в компоненте и относятся к документу
владельца workspace. Mobile резервирует высоту панели после максимума system
inset, Obsidian safe area и header offset, включая floating/fullscreen layout.

Нативные `details`/`summary` начинают свёрнутыми: YD, отдельный loader и status
icon. Шапка остаётся справа при раскрытии. Этап, имя файла, N/M, retry, время
последнего успеха и полная причина доступны внутри раскрытия; длинный текст
переносится и прокручивается в пределах видимой области. Нажатие на шапку и
Enter/Space меняют раскрытие; обновления и remount его сохраняют. Кнопки sync
и copy находятся слева в той же строке, вне `summary` и live status: их нажатие
не сворачивает плашку. Touch targets не меньше 44 × 44 px, названия и подсказки
локализованы. Копирование не меняет sync-state; при пустом логе буфер сохраняется,
ошибка Clipboard API не даёт ложного успеха. Запись через `ClipboardItem` начинается
в обработчике касания для WebKit; при её отказе используется `writeText()`,
чтобы сохранить совместимость с текстовым clipboard bridge Obsidian.

`idle` не обещает отсутствие deferred events. UI-состояние не сохраняется в
`data.json` и не участвует в causal merge или выборе codec. `onLayoutReady` и
layout events восстанавливают тот же DOM после cold startup, независимо от sync.
Unload снимает подписки/observers, отменяет frame и запрещает повторный mount.
Снаружи плашки касания доступны; modal/menu располагаются выше неё. Reduced
motion отключает вращение loader; status icon не вращается.

`ForceSyncController` владеет полным пользовательским сценарием обоих
направлений: read-only preflight → выбор архива → необязательный backup с exact read-back →
direct Force через существующий coordinator → проверка нового результата → coherent persistence.
Он резервирует busy-состояние до первого await, не создаёт очередь и не
позволяет повторному клику запустить второй backup или отложенный Force.
`main.ts` подключает зависимости и Obsidian UI. `SyncRunOptions.onActivity`
передаёт только события с ID принадлежащей вызову coordinator-сессии.

При выборе архива один persistent Notice показывает создание, загрузку и проверку backup,
далее фазы Force, сохранение и итоговую проверку. Настройки подписаны на
тот же неперсистентный flow-state: индикатор внутри кнопки выбранного направления
работает только при active Force, сохраняя текст кнопки. Отдельной строки прогресса
под кнопками нет; этапы остаются в Notice. Оба Force-контрола блокируются также при
configuration/foreground work. При обычной sync-сессии Force сериализуется тем же coordinator. Во время Force настройки и ручные mutating-действия
недоступны, включая промежутки между coordinator-сессиями. Повторное открытие
настроек читает текущее состояние; закрытие снимает подписки, но не отменяет Force.

Успех показывается после подтверждённого replacement, persistence и собственного
контроля canonical/manifest/bytes/cleanup. После cutover обычный full согласует поздние изменения; прежние destination-очереди
не возвращаются. После ошибки остаётся durable
checkpoint direct-v1; следующий ordinary full повторяет только остаток. Повторный клик наблюдает тот же
Promise, а поздние callbacks предыдущего flow не меняют новый Notice.

## Проверки

Компактные тесты выполняют реальные алгоритмы причинности, транзакций, конкурентности
и recovery с synthetic transport. Они проверяют bytes, canonical, baseline и queues,
а не только вызовы mocks. Wire types определены в `src/types.ts`; строгие loaders
не допускают неявного расширения исторических форматов.

Test/lint/build/format/bundle checks дополняются [SMOKE_TESTS.md](SMOKE_TESTS.md).
Штатный build может читать optional root `.env` и копировать assets в тестовый vault;
его потенциально чувствительный вывод подавляется до capture, содержимое `.env`
агент не читает. Build/copy не доказывает работу Obsidian или Yandex API.

Exact auto references сверяются с фактически исполняемыми Node test names. Перед
использованием статического scenario validator проверяется поддержка templates и
evidence grammar; его ограничения не являются дефектом валидного сценария.
Реальный двухпрофильный прогон обязателен для release. Статус хранится в
[release evidence](release-evidence/2.0.0.json); автоматические checks его не меняют.
Историческая приёмка и измерения — [REFACTOR_REPORT.md](REFACTOR_REPORT.md).

## Единый контракт ошибок

`errors.ts` не зависит от UI и sync. Он хранит транспортные классы, in-memory
`OperationFailure` с исходной `cause`, очищенную `FailureSummary` и решение
`decideRecovery`. Клиент переэкспортирует прежние классы, поэтому их identity и
существующие `instanceof` не меняются. Signed-download HTTP ошибки имеют
отдельную identity: 404 signed link не доказывает отсутствие API resource.
`sync/errors.ts` адаптирует domain exceptions; root, canonical, local identity
и обязательный backup имеют приоритет над вложенной сетью или authentication.
`sync/canonical/errors.ts` — единственный владелец canonical/transaction и
format error constructors, decode-attempt types и прежней retry classification.
Runtime consumers импортируют их напрямую; `canonical/manager.ts` сохраняет
совместимые re-exports с той же constructor identity, cause и stage.

Политика разрешает попытку, но не выполняет её. Счётчики, backoff и deadlines
остаются в клиенте; GET сохраняет 423/429/500/502/503/504, writes — 423/429/503,
operation polling — 409/423/429/503. Только rejection native transport
помечается как network; decode и неизвестная ошибка автоматически не повторяются.
Незавершённый native timeout не повторяется. PUT с неоднозначным transient
результатом проходит прежний guarded read-back даже после последней попытки.
Новых повторов сессий или изменений scheduler нет.

Sync/realtime, Force, startup, backup и encryption передают очищенную summary
в неперсистентных результатах/статусах; исходная cause остаётся внутренней.
Ни summary, ни cause не входят в plugin data, canonical, mutations или physical
actions. Форматтер общий для Notice и status surfaces; старые message/code/
errorMessage остаются совместимыми представлениями. Backoff отражается в текущем
прогрессе без дополнительного Notice. Failure содержит этап, logical path,
HTTP/provider code и известный исход; частичный результат не объявляет данные
неизменными. Force preflight/protected snapshot сохраняют причину; post-commit
сбой остаётся cleanup-pending. Cancel, пароль и ожидаемые blocked outcomes
сохраняют отдельные сценарии. Startup сеть блокирует запуск с причиной
недоступности, а не с утверждением о неверном токене; виды блоков и Force права
не меняются.

Логи сохраняют очищенную цепочку причин, этап, попытку и длительность, не
response descriptions/body и не signed URLs. Provider error code проходит
ограничение формата. Реальная доступность Диска и работа двух Obsidian-профилей
проверяются отдельно от автоматических алгоритмических тестов.

## Force completion и границы конкурентности

Direct Force использует локальный checkpoint direct-v1 и final receipt
проверенной прямой публикации canonical. Успех означает завершённые действия и
coherent persistence; intent не равен final commit. Частичные действия подхватывает
обычный full без отдельного выбора recovery. Форматы sync-index,
encryption-manifest, plugin-data, hardened и persisted physical actions не меняются.

Проверки нового результата не выбирают победителя по старому назначению.
Остановка других устройств не является допуском Force. Поздние чужие запросы
могут изменить данные или manifest после завершения: server fencing отсутствует.
Старая fencing suite сохраняется как диагностика отсутствующей гарантии, а не
условие выпуска этого контракта. [Контракт](FORCE_SYNC.md);
[исторические наблюдения](FORCE_SAFETY_VALIDATION.md).

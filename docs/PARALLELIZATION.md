# Очереди и параллельные операции

Границы модулей и общего состояния — в [архитектуре](ARCHITECTURE.md).
Здесь описаны порядок сессий, durability и пределы параллелизма.

## Сессии

Один `SyncCoordinator` сериализует full, realtime, Force и encryption maintenance.
Ручной backup использует maintenance того же coordinator. Подготовка считается
pending work до первого await; повторные full объединяются. Foreground reservation
блокирует конкурирующие пользовательские операции и connection/scope changes,
включая промежутки между внутренними сессиями. Диалог выбора архива не удерживает
coordinator; nested encryption preflight не ставит повторную задачу в ту же очередь.

Сессия освобождается после settlement/ACK/save и resume. Ошибка prepare/pause
останавливает body. Resume failure делает successful body неуспешной сессией;
последующие callbacks получают failure. Cleanup failed session не скрывает исходную
ошибку. Подтверждённые canonical/physical изменения не откатываются из-за local save.

## Watcher и persistence

FileWatcher владеет subscriptions, identity/time allocation, transient aliases,
одной durable queue и одним drain. `queue-rules.ts` — чистые преобразования
нормализованных readonly events/submitted IDs; `WatcherSettlement` исполняет
receipts и ACK через live ports, без своих timers, enabled-state или очереди.
Receipt effects меняют существующие runtime references до ACK.

Debounce объединяет только ещё не submitted edits. Running upload/rename сохраняет
отдельный successor с прежними ID/seq и causal links. Folder rename сначала делает
debounce durable, затем переносит оба пути queued child event; submitted child не
переписывается, но bytes читаются по конечному target. Parent поглощает только
механические notifications, а новый content по старому source остаётся отдельным.
Transient aliases промежуточных папок не переживают stop/restart.

Folder-delete suppression различает экземпляры `TFile`: live create/modify/rename
отмечают новых descendants, включая internal upload notifications. Их следующий
delete сохраняется; запоздалый delete прежнего экземпляра остаётся mechanical
(`FDEL-019`). Это не меняет persisted events или canonical merge.

| Путь                     | Durability boundary                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal full              | Prepare сохраняет cutoff и завершает допустимый destructive/rename pre-drain; pause фиксирует signatures. Finalize сохраняет rename settlement до `markRemoteObserved`. Resume дожидается upload ACK/save и только затем допускает late replay. |
| Initial receive          | Prepare не отправляет destructive cutoff. До полного receive события только durable. Finalize снимает лишь unchanged cutoff signatures; новые/изменившиеся IDs остаются.                                                                        |
| Failed full              | Нет queue ACK, observed advancement или late replay. Незавершённая работа остаётся для restart.                                                                                                                                                 |
| Stopped/unloaded watcher | Settlement и обязательные saves уже принятой сессии не зависят от enabled-state; новый replay запрещён.                                                                                                                                         |
| Confirmed Force          | Checkpoint хранит cutoff; после verified replacement снимаются только covered IDs с awaited save. Поздние events сохраняются; recovery сохраняет operation ID/epoch.                                                                            |
| Foreign epoch            | Replay заблокирован до full adoption. Late events получают принятые epoch/base revision через awaited resume-save; failure восстанавливает прежний causal snapshot.                                                                             |

Dirty/saved revisions объединяют watcher saves поверх прежнего `PluginPersistence`.
До начала callback синхронная пачка даёт один save; arrivals во время await требуют
следующего save. Один callback работает одновременно. Runner освобождается вместе
с последней проверкой dirty revision до Promise settlement: arrival в следующем
microtask получает нового runner. Durable wait после await сверяет актуальную
revision. Failure виден всем waiters и не превращается в автоматический успешный
retry без нового явного save request.

`PluginPersistence` последовательно сохраняет settings, baseline, logical/physical
work и watcher events одним snapshot, снятым при исполнении задачи. Settings change
сначала дожидается watcher drain/save, затем ставит свой save; ждать watcher внутри
settings-save task нельзя из-за взаимной зависимости очередей. Draft публикуется
только после success. Reload generation проверяется до write и после await;
in-flight storage write не отменяется, но superseded draft не публикуется.
Unload-save проверяет admission при исполнении и не повторяет failed load/save.

Runtime settings (`maxConcurrency`, debounce, interval, realtime) не сбрасывают remote
admission. Interval меняет timer; `0` выключает scheduler, generation отсекает старые
callbacks. Realtime off сохраняет events и снимает drain timers. Client ID/logging
не запускают remote work. Connection/file-scope changes сохраняют stop/drain/save/full
ordering; token/path инвалидируют admission. Failed save устанавливает отдельный
`local-persistence` block, снимаемый явным успешным settings repair.

## Внутри сессии

| Работа                                          | Параллелизм и порядок                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Обычные независимые transfers и directory reads | `maxConcurrency`, целое 1–40, default 20; сохранённая настройка не заменяется.                                                    |
| Страницы одного каталога                        | Последовательно, полная pagination и identity checks. Dynamic traversal запускает потомка при свободном слоте без барьера уровня. |
| Canonical transactions и plugin persistence     | Последовательно у своих владельцев.                                                                                               |
| Local и remote full scans                       | Перекрываются после admission/adoption/recovery; обе ветви joined до classification даже при failure.                             |
| Realtime upload/delete                          | Последовательные окна; внутри uploads последовательны.                                                                            |
| Независимые rename roots                        | До 32 events; physical tasks всех папок/файлов используют общий лимит `min(maxConcurrency, 4)`.                                   |
| Post-commit encryption cleanup                  | До `max(1, min(maxConcurrency, 4))` workers; у каждого отдельная canonical read-session.                                          |
| Encryption rewrite mkdir                        | До четырёх siblings одной глубины, затем depth barrier; остальные callers default 1.                                              |
| Pre-commit encryption rollback                  | Последовательно, с source authority и fingerprint guards.                                                                         |

`runWithConcurrencySettled` возвращает отдельные outcomes. Первая ошибка traversal
останавливает новые directory tasks, уже начатые завершаются без partial success.
Force продолжает независимые действия после ошибки по своему direct-v1 контракту.
Encryption cleanup после первой ошибки прекращает admissions и joins все sent
requests до recovery/codec change, сохраняя первую ошибку независимо от порядка
завершения. Readers закрываются в `finally` до смены authority.

Read-session reuse не кеширует write authority. Каждая initial/full evaluation
получает новую fully paginated stable root pair для scope/manifest/canonical checks.
Matching service SHA-256/MD5 разрешает reuse verified bytes, no-hash/drift — новый
stable download. Startup/full одной invocation могут делить service session;
будущая invocation, recovery или codec/config drift её не наследуют. Config/pause
ABA, unload и закрытие session запрещают late publication. Подробный контракт —
[чтение и lifetime](ARCHITECTURE.md#чтение-snapshots-и-lifetime).

Initial identical metadata reads идут bounded группой с authority checks до/после.
Совпавшие fingerprints подтверждают только baselines одним coherent save. Miss
сразу запускает guarded download внутри той же task с исходными metadata/budget.
Targeted collector выбирает parent listing лишь при известной меньшей стоимости
страниц, иначе GET. Missing listing entry требует GET; partial/duplicate/type-drift
listing отклоняется. После bulk дополняются live missing stamps, включая старые,
без повторного обхода незатронутых веток (`SYNC-044`–`SYNC-046`).

Encryption target verification и первичная accepted-upload metadata используют
тот же collector с отдельным лимитом `max(1, min(maxConcurrency, 4))`. Callbacks
только собирают observations; repair/stamps/commits выполняются последовательно.
Encryption использует fresh parent listings после DELETE, а не pre-delete metadata;
стоимость страниц известна из предыдущего scan. Первые tasks разных parent идут
раньше siblings, чтобы ожидающие общий listing не заняли все слоты.
Первая ошибка останавливает admissions и сохраняется после join; финальная
проверка lifetime/config имеет приоритет и запрещает recovery под новой конфигурацией.
Accepted uploads повторно проверяют relevant canonical entries и encryption admission
до receipt/ACK; prefetched metadata не разрешает corrective PUT/retry.

## Rename и causal handoff

Batch не перескакивает через submitted/excluded event, upload/delete или пересечение
source/target. Watcher отмечает весь предложенный префикс submitted до coordinator;
engine перепроверяет eligibility до allocation. Только unchanged causal snapshots
попадают в fast path; неподходящий префикс возвращается одиночной обработке без
новых sequences. Общие staging helpers обслуживают single/batch; intent/completion
commits общие для подтверждённых roots. Deferred/obsolete action не ACK событие.

Tracked-source PUT завершается со своим ID/seq до rename (`SYNC-049`). После restart
source подтверждается plaintext SHA и fresh canonical/manifest/physical authority.
При отсутствии own source допускается guarded rematerialization frozen target с
прежним put ID/seq, затем read-back, source commit/accepted repair и move. Under-lock
source validator не превращает foreign same-SHA successor в own put. При чужом
source применяется обычный put-target; foreign bytes не удаляются. Новый unsynced
source сохраняет отдельный coalesced handoff.

Canonical authority предшествует physical observations для MOVE/DELETE. Cleanup
доказывает canonical, target, затем fresh source; backup и source removal не
перекрываются. Target body proof reusable только с fresh server SHA-256, связанным
с фактически скачанными raw bytes, и той же logical/config authority. MD5-only,
no-hash или drift требуют stable logical read. `confirmed-unchanged` receipt требует
plaintext/causal/physical/manifest agreement, не выделяет sequence и не ACK put.
Rename baseline продвигается после completion commit, не посреди physical batch.

`withWriteGuard` проверяет synchronous lifetime после awaited remote guard прямо
перед dispatch, включая retry/recovery. Callback снимается в `finally`; ни read
reuse, ни prepared snapshot не заменяют fresh write authority. Same-root canonical
MOVE может использовать `existingParentOnly`: пропускается parent preparation,
но не guard, exclusive MOVE, polling или ambiguous recovery; missing root не создаётся.

## Папки, retry и memory

Remote-folder cache — наблюдение; delete/move и token/path/codec changes его
инвалидируют. Upload transport 404 или известный path-missing 409 допускает parent
GET; только подтверждённый GET 404 разрешает пересоздание и один retry. Exclusive
или неизвестный 409 не разрешает overwrite. Guard error, включая 404, не является
ответом transport и не разрешает новый PUT/mkdir. Direct Force очищает folder cache
перед apply/recovery.

Каждая DELETE attempt повторяет beforeAttempt authority; callback failure не
подтверждается отсутствием. Polling failure после 202 также оставляет action
pending. Успешный transport требует проверки результата. Ordinary cleanup имеет
fingerprint guards; direct Force и новые encryption replacements используют свои
явные destructive authority, не старые fingerprints назначения. Ordinary remote
pruning выключен; replacement может рекурсивно удалять разрешённый subtree.

Read budget — 60 s; stable raw/logical и direct download делят его между queue wait,
metadata/link/bytes/backoff. API metadata/link attempt — 15 s; максимум четыре
attempts, после unresolved timeout — максимум один replacement. Native occupancy
удерживается до реального settlement: основной пул равен `maxConcurrency`, reserve
для replacement имеет два места. Queue wait ограничен тем же budget; истёкший или
отозванный waiter не запускает HTTP после получения permit. Config changes,
pause/resume и unload отзывают старые waits. Signed bytes и polling после unresolved
timeout не дублируются; поздние bytes не применяются. Queued downloads не запускаются после failure; уже начатые tasks
joined до освобождения сессии. Пропущенные tasks не увеличивают progress.

Realtime content windows имеют предел 32 events / целевые 8 MiB retained plaintext;
oversized file идёт отдельно. Stat — оценка, byteLength — факт. Заниженный stat
временно допускает budget + один read: лишние bytes освобождаются, следующий snapshot
перечитывается с новым SHA. Это не hard cap JS heap, encryption buffers или файла.

Окно завершает canonical/rejected settlement, accepted repair, cleanup, coherent
save и watcher receipts/ACK/save до следующего prepare. Snapshots освобождаются;
aggregate result содержит metadata. Settled runtime IDs удаляются после receipt
reducer, чтобы поздний rename не ждал уже доставленный receipt. Failure оставляет
suffix durable, prefix ID/seq не перенумеровываются. Больше окон может увеличить
число commits и сетевых запросов.

Digest-only backup читает один файл за раз и удерживает identities, тогда как
ZIP/envelope materialize полный архив. Filter/order/digest совпадают с materialized
snapshot; source read/auth/decrypt failure блокирует proof. Политика архивов и
пределы памяти — [BACKUP.md](BACKUP.md). Большая concurrency увеличивает число
одновременных buffers; request counts и сумма request durations не измеряют latency
или mobile heap.

## Replacement и epoch adoption

[Direct Force](FORCE_SYNC.md) использует тот же coordinator и frozen filters для source/destination
inventory. Исключённые/protected descendants запрещают recursive deletion предка. Coherent direct-v1 checkpoint предшествует purge; independent failures
оставляют remainder. Ordinary full продолжает его до merge без повторного broad
purge. Failed subtree delete возвращает затрагиваемые copies в pending, чтобы retry
не удалил уже записанные bytes. Cutover снимает старые queues и covered watcher IDs,
сохраняя late events. Foreign offline delta требует accept/preserve/later.

Новые [encryption transitions](E2E_ENCRYPTION.md) выбирают frozen local reference,
fresh epoch и durable deletion cover. `planRecursiveDeletes` схлопывает только
полностью removable subtree без protected/excluded/live descendants. Filter coverage
проверяется до collapse. Workers повторяют fresh authority/cover/lifetime checks
на каждом DELETE/retry; ambiguous sent request требует authority/absence proof,
guard refusal не ACK. Legacy checkpoint без replacement сохраняет fingerprint policy.

Foreign full принимает stable encryption replacement до ordinary merge и coherently
заменяет selected local bytes/baseline/old-generation queues. Realtime PUT проверяет
maintenance/epoch/manifest перед каждой попыткой. Уже sent foreign request невозможно
отозвать server-side: Force и encryption replacement не дают fencing guarantee.

## Проверки

[Каталог](SYNC_USER_SCENARIOS.md) фиксирует outcomes, а [AGENTS.md](../AGENTS.md#documentation-and-testing)
— политику минимальных algorithm tests. Functional harness исполняет реальные
watcher/engine/IndexManager/client/adapter/codecs с synthetic filesystem/HTTP,
проверяет exact bytes, canonical, baselines, FIFO и JSON restart.

Диагностика эффективности: `npm run check:sync-efficiency -- --out <fresh.json>`.
Отдельные режимы: `--realtime-boundaries`, `--rename-latency`,
`--encryption-transitions`, `--verify-oracle`. Они не подтверждают native events,
сетевую latency, throttling или mobile memory. Реальная приёмка —
[SMOKE_TESTS.md](SMOKE_TESTS.md).

# Очереди и параллельные операции

## Сессии

Один `SyncCoordinator` сериализует full, realtime, Force и maintenance.
Ручной архив использует maintenance того же coordinator. Подготовка сессии считается
pending work до первого await; повторные full объединяются в один результат.
`settle` сохраняет acknowledgement до освобождения сессии. Ошибка prepare/enter/settle
не должна терять очередь или подтверждать незавершённую работу.

Encryption preflight внутри уже принятого maintenance не ставится повторно в ту же
очередь. Его обход nesting не отключает canonical/encryption guards. Диалог выбора
архива не удерживает coordinator. Foreground admission блокирует конкурирующие
пользовательские операции и изменение connection/scope.

## Watcher и persistence

Одноразовое подтверждение storage binding сохраняется той же очередью persistence,
что baseline и durable work. Cancel не очищает work, failed save восстанавливает
snapshot; смена scope не переподписывает pending operations. Foreground admission
резервируется до первого await, в том числе до диалога binding. Physical write
guard повторяет root identity check на каждой попытке; content-guarded full
upload также перепроверяет canonical и ожидаемый physical fingerprint.
Local write повторяет scope check после parent preparation и затем local identity,
до watcher suppression. Ошибка upload-группы прекращает full до settlement и
следующих операций; snapshot сохраняется с исходными pending IDs. Read-back после
неоднозначного PUT не обходит canonical/codec guards и не разрешает новый overwrite.

Новая conflict copy определяется path/content key, создаётся exclusive и
подтверждается в canonical до применения winner. Crash/restart не меняет имя
той же версии; повтор не создаёт новый sequence для уже подтверждённой копии.

Watcher хранит события с identity, epoch, base revision и причинными связями.
Debounce объединяет ещё не submitted edits; running upload/rename сохраняет successor.
Folder events поглощают только механические события своих descendants. Новое содержимое
по прежнему source path остаётся отдельной операцией.
Folder-delete suppression различает экземпляры `TFile`: live create/modify и file/folder
rename отмечают новые descendants даже при internal upload notification. Их последующий
delete создаёт обычное durable событие; запоздалый delete старого объекта по тому же
пути остаётся mechanical. Эти transient identity sets очищаются при stop и не меняют
persisted events, FIFO или правила canonical merge (FDEL-019).

Чистая `realtime/queue-rules.ts` получает нормализованный incoming event и readonly
snapshot очереди плюс submitted ID sets. Она возвращает transformed events,
chain/child disposition и receipt effects. Watcher применяет их в прежних точках
и сохраняет identity/time allocation, durable save scheduling и runtime references.
Входящий folder notification не поглощает и не rebases submitted child rename;
его predecessor upload/ID/seq остаются до coordinator settlement. Partition
descendants не использует повторный `includes`; retarget выполняется одним проходом.
JSON restart сохраняет distinct running successor и прежние epoch/ID/seq.

Folder rename сначала переносит debounce в durable queue. Предшествующий child
rename сохраняет source и upload receipt до settlement, но читает bytes по конечному
target; coalesced parent переносит оба пути зависимого child event. Queued uploads
следуют за parent по конечным путям. Submitted события не переписываются. Alias
промежуточной папки используется только для поглощения механических notifications
её descendants и не переживает остановку watcher.

До завершённого initial remote receive watcher хранит события локально и не
публикует mutations. Full prepare не выполняет pre-drain destructive events;
после успешного full сверяются filesystem и сохранённые signatures cutoff events.
События, изменившиеся во время прохода, остаются для replay; failed full не
подтверждает очередь. Обычный pre-drain после подключения работает по прежним правилам.

Full cutoff, signatures, initial receive и stopped watcher имеют разные границы
подтверждения, перечисленные в таблице ниже. Upload receipt передаёт committed
revision последующему rename до ACK; неоднозначная цепочка остаётся durable и
делает reconciliation незавершённой.

`realtime/settlement.ts` содержит `WatcherSettlement`: file batch, file rename и
folder outcome исполняются из одиночного и batch replay. Он получает текущие
runtime references, acknowledgement и durability ports watcher; своей очереди,
таймеров или enabled-state нет. Receipt effects по-прежнему применяются watcher
к существующим references до acknowledgement. FileWatcher сохраняет один drain,
локальный `replayFileBatch`, cutoff/barrier, подписки и scheduling.

Watcher coalescing использует только runtime dirty/saved revisions. Синхронная
пачка запросов до начала callback даёт один save; arrivals во время await помечают
новую revision и требуют повторного save последнего состояния. Одновременно
выполняется один callback. Завершающий runner освобождается синхронно с последней
проверкой dirty revision, до settlement своего Promise: arrival в следующем
microtask начинает новый save и не остаётся без runner. Успех подтверждает только revision, снятую перед этим
callback; ожидание durability повторяет проверку после await, пока актуальная
queue не сохранена. Ошибка отклоняет зависимых waiters и остаётся видимой новым
ожиданиям без arrivals. Уже ожидающие запросы не превращаются в автоматический
успешный retry после ошибки. Следующий явный запрос save может сохранить всё
накопленное состояние; до его успеха remote replay не допускается. Это не новая
plugin tail queue и не объединение settings publication с acknowledgement.

Фактический порядок жизненного цикла сохраняется:

| Путь                     | Порядок и граница durability                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal full              | Prepare фиксирует cutoff и сохраняет очередь до coordinator enter; destructive/rename pre-drain завершается заранее. В coordinator pause сохраняет signatures/barrier, затем выполняются physical work и canonical commit. Finalize сохраняет post-full rename settlement до `markRemoteObserved` и его coherent save. В `finally` resume завершает upload barrier и ждёт его save, затем допускает late-event replay; coordinator освобождается после возврата resume. |
| Initial receive          | Prepare не отправляет destructive cutoff. После успешного reconciliation finalize снимает только unchanged cutoff signatures и сохраняет очередь до observed revision. Изменённые/новые IDs остаются для replay.                                                                                                                                                                                                                                                        |
| Failed full              | Finalize не подтверждает очередь, observed revision не продвигается; resume с failure не снимает captured uploads и не запускает replay. Failed persistence также отклоняет durability boundary.                                                                                                                                                                                                                                                                        |
| Stopped/unloaded watcher | Те же finalize/resume и обязательные saves уже принятой сессии исполняются независимо от enabled-state. Replay и поздние layout callbacks отключены; сохранение settlement не зависит от запуска watcher.                                                                                                                                                                                                                                                               |
| Confirmed Force          | Cutoff хранится в существующем Force checkpoint, уточняется на его source/verification boundaries. После replacement/проверки `settleForceReplacement` снимает только перечисленные IDs и ждёт сохранения до освобождения Force. Более поздние edits не покрываются старым cutoff; recovery сохраняет прежние operation ID/epoch.                                                                                                                                       |

Ошибка pause callback останавливает body до canonical/physical work. Resume
ordinary full остаётся после observed save, но до итогового success-result/log
и coordinator release. Ошибка ACK/save возвращается как failure с исходной cause;
уже принятые bytes/canonical не откатываются. На failed session последующие resume
callbacks видят failure, а cleanup error не маскирует первичный отказ. Durable
pre-ACK queue остаётся пригодной для restart/replay (`SYNC-038`). Late events при
epoch adoption получают новый epoch/base revision и отдельный awaited save до
replay/return даже у stopped watcher; failure не подтверждает adoption, прежний
local causal snapshot восстанавливается существующим full owner.

Foreign epoch блокирует явный и автоматический replay до успешного full adoption.
Новые события при блокировке остаются durable. После accepted full поздние events
получают контекст принятого epoch через существующий resume path, без изменения
persisted shapes и без перенумерации уже принятых mutations.

`PluginPersistence` (`plugin-persistence.ts`) имеет одну последовательную очередь для settings, baseline,
mutations, physical actions и watcher events. Snapshot собирается при выполнении задачи,
а не при постановке. При изменении settings сначала завершаются watcher drain/persistence,
затем ставится settings save. Ожидание watcher из settings-save задачи запрещено: watcher
сам ожидает plugin persistence. Save failure сохраняет блокировку и непринятый draft. Load generation проверяется
до write и после await save: старый in-flight draft не публикуется после reload.
Unload-save стоит в той же очереди и проверяет допуск при исполнении; failed load,
initial save или предшествующий failed save не запускают повторный write из unload.
Lifecycle callbacks уже принятой сессии сохраняются до её settlement; затем
снимаются по existing pending-work notification, без новой sync/maintenance работы.

## Внутри сессии

`utils/semaphore.ts` ограничивает параллельные независимые задачи.
`runWithConcurrencySettled` сохраняет отдельные результаты, чтобы ошибка одного transfer
не скрывала остальные. Лимит файлов задаёт `maxConcurrency`; каталог папок также обходится
с ограниченной параллельностью. Параллелизм не переносится на canonical transactions.

Физический upload и публикация metadata разделены: realtime проверяет актуальность
события между ними. Bulk upload может получать stamps общим повторным listing;
нельзя заменять это отдельным metadata запросом для каждого файла при переносе кода.

Force, rewrite и обычные transfers имеют разные правила результата. Rewrite требует
exclusive upload, exact read-back и target proof. Force повторно проверяет выбранный
source до replacement commit. Обычный deferred physical action не становится success
из-за fulfilled Promise. Общий обработчик с флагами не подменяет эти контракты.

Обычные независимые renames используют пачки до 32 root events без задержки накопления. Watcher помечает весь предложенный префикс submitted до ожидания coordinator; engine повторно проверяет применимость до первого allocation. Общие stage helpers обслуживают одиночный и пакетный путь. Physical tasks всех папок и файлов идут через один `runWithConcurrencySettled` с лимитом `min(maxConcurrency, 4)`. Fresh canonical/codec/fingerprint checks сохраняются для каждого действия; buffers после классификации не удерживаются. При обнаружении нового epoch автоматический и явный watcher replay замораживаются до успешного full adoption; новые события продолжают сохраняться. Completion публикуется для подтверждённых root events, а ошибки и отменённые по authority действия остаются durable для одиночного recovery. Общая очистка исходных ancestors не ослабляет проверки пустоты. Итоговый лог содержит counts, confirmed commits и duration; реальную latency из числа запросов не выводить.

## Папки, retry и memory

Upload заранее создаёт нужные родительские папки. Remote-folder cache — наблюдение:
после delete/move и изменения token/path/codec он инвалидируется. Upload 404 или известный DiskPathDoesntExistsError 409 допускает raw parent GET;
только подтверждённый GET 404 разрешает один восстановительный upload retry.
Exclusive collision и неизвестный 409 не разрешают retry. Force очищает cache
перед directed apply/recovery и ограничивает повторные inventory тремя проходами.

Перед каждой попыткой DELETE повторяются canonical/identity checks. Проверка пустоты не защищает от позднего потомка после guard. Optional remote
pruning выключен в ordinary/Force/encryption; remote folder replacement блокируется.
Move source не удаляется без доказанного target. Неоднозначный ответ требует read-back;
неподтверждённое действие остаётся durable для recovery.

Исполнитель remote delete проверяет authority один раз непосредственно перед
каждой сетевой попыткой через `beforeAttempt`, без отдельного предварительного
прохода. Ошибка callback, включая `404`, не является ответом DELETE. Ошибка polling
после `202` также не доказывает отсутствие объекта: action остаётся для recovery.
Успешный транспортный ответ по-прежнему требует проверки физического результата.

Realtime uploads остаются последовательными; `maxConcurrency` не распараллеливает
их подготовку и передачу. Сокращение повторных чтений canonical и исключение
отсутствующих tombstone paths из full не меняют FIFO, receipts и rename handoff.
HTTP-счётчик `apiReads` учитывает GET через API wrapper, но не прямые transfers,
записи и polling; для сравнения полной стоимости считать также эти обращения.
Он не измеряет latency: одинаковый счётчик не означает одинаковое время или
объём передачи.

Realtime upload/delete series исполняется последовательными окнами внутри одной
coordinator-сессии, без nested jobs. Внутренние пределы: 32 events и целевые 8 MiB
retained plaintext на окно; oversized файл отдельно. Stat только оценивает размер,
byteLength authoritative. Заниженный stat допускает временный budget + один read;
лишний read отбрасывается, следующий snapshot получает свежие bytes/SHA. Это не
hard cap JS heap, encryption buffers или одного файла. Uploads последовательны,
rename batch limit 32 не меняется.

Каждое окно завершает canonical/rejected-put settlement, accepted repair, cleanup
и coherent save до watcher receipts/ACK/save и следующего prepare. Snapshot references
удаляются после этой границы; aggregate result содержит только metadata. Submitted
references доступны receipt reducer до ACK, затем settled IDs удаляются из runtime
map: поздний rename не ожидает уже доставленный receipt. Ошибка останавливает suffix;
подтверждённые prefix IDs/seq не перенумеровываются при restart. Полная серия может
потребовать несколько index rewrites; network requests могут вырасти. Synthetic
retention/request probe в [отчёте](REFACTOR_REPORT.md#что-измерено) не доказывает mobile heap или live latency.

Digest-only backup traversal читает и хеширует один файл за раз, освобождая
content перед следующим read; сохраняются только identities для прежнего JSON
digest. Enumeration/filter/order общие с materialized ZIP snapshot для каждого
kind. Freshness до/после архива и source read/auth/decrypt failures сохраняются.
Это ограничение retained content, без уменьшения числа reads или обещания сетевого
ускорения. Public directed Force without-backup не запускает destination digest.
With-backup ZIP по-прежнему materializes bytes всего защищаемого набора; его peak
и live mobile heap отдельно не подтверждены (PERF-006/012).

Большая concurrency увеличивает число одновременных buffers и запросов, а ZIP/envelope
требуют памяти полного архива. Настройки не обещают фиксированного ускорения. Реальные
latency, throttling и mobile memory проверяются smoke-прогоном; количественные результаты
без воспроизводимого benchmark не публикуются.

## Проверки

Сохраняются отдельные проверки FIFO/coalescing, prepare/settle ordering, stopped watcher,
rename handoff, lost response, interrupted cleanup и epoch adoption. Политика минимальных
тестов — [AGENTS.md](../AGENTS.md#documentation-and-testing), пользовательские исходы —
[SYNC_USER_SCENARIOS.md](SYNC_USER_SCENARIOS.md). Desktop/mobile и два профиля Яндекс Диска
проверяются по [SMOKE_TESTS.md](SMOKE_TESTS.md), независимо от automated results.

`tests/sync-user-flows.test.ts` выполняет пользовательские цепочки через реальные
watcher, engine, IndexManager, HTTP client, VaultAdapter и криптографию. Подменены
только файловая система/события Obsidian и HTTP-хранилище. Проверяются canonical,
точные local/physical bytes, отсутствие промежуточных файлов, JSON restart и пустые
очереди. Это проверка взаимодействия алгоритмов, не доказательство работы реальных
Obsidian events, сетевых задержек и Yandex API.

Remote reads имеют deadline 60 s на запрос. Timeout останавливает запуск queued
downloads full/Force, но не освобождает сессию до завершения уже начатых tasks.
Поздние bytes timed-out read не применяются. Пропущенные tasks сохраняют error
outcome без продвижения progress; первая фактическая ошибка видна до конца batch.
Native request не отменяется; лимит ожидания не доказывает восстановление сети.

## Force replacement и epoch decision

Force работает через тот же coordinator даже при paused automation. Повторный
клик наблюдает активный Promise. Подготовка получает направление и проверяет
читаемый source; stale destination metadata не запускают ordinary recovery.
После intent durable `forceRecovery` запрещает обычную автоматизацию до
подтверждённых bytes/canonical/manifest/baseline и cleanup. Старые receipts и
покрытые watcher events снимаются coherent при cutover, поздние события получают
новый causal context. Destination drift ограничен тремя инвентаризациями;
source drift не создаёт смешанный успешный snapshot.

Foreign epoch с offline delta сначала требует явного epoch-bound решения.
Отложенный выбор сохраняет local bytes/queues и не разрешает auto upload.

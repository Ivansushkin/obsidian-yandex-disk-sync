# Архитектура плагина Yandex Disk Sync

Плагин работает в browser runtime Obsidian на desktop и mobile. Его source of
truth — canonical index на Яндекс Диске; локальные baseline и durable queues
описывают состояние конкретной установки. Нормативные пользовательские исходы
перечислены в [SYNC_USER_SCENARIOS.md](SYNC_USER_SCENARIOS.md).

## Границы модулей

`main.ts` соединяет компоненты и владеет plugin lifecycle, UI и persistence.
`api/yandex-client.ts` выполняет транспортные запросы и codec conversion;
`api/vault-adapter.ts` работает через Obsidian Vault/DataAdapter и FileManager.
`backup/` отвечает за snapshots, архивы, envelope и exact read-back;
`crypto/` — за codecs, manifest и transition/recovery.

В `sync/` папки отражают ответственность: `canonical/` — индекс и транзакции,
`local/` — baseline и очередь устройства, `files/` — физические операции,
`reconciliation/` — commit/recovery и конфликты, `workflows/` — полные и служебные
проходы, `realtime/` — watcher и обработка событий. Имена дополняют контекст папки;
префикс `sync-` не повторяется. Импорты ведут прямо к владельцу без barrel-модулей.

`SyncEngine` сохраняет публичные входы, один coordinator, session/lifecycle
wrappers, guards, UI/listeners, pause/busy, expected watcher events и validation
token. Изменяемые settings/callbacks читаются через актуальные getters.
Неизменяемые сервисы передаются узкими зависимостями. Внутренние алгоритмы не
импортируют runtime-фасад, не создают второй coordinator или persisted store.
Watcher и scheduler используют его публичный API.

| Модуль `src/sync`                              | Владелец алгоритма                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `contracts.ts`                                 | Публичные options, proofs, lifecycle и guards; engine сохраняет re-exports      |
| `files/operations.ts`                          | Transfers, local writes, physical actions, folders и parallel execution         |
| `files/remote-moves.ts`                        | Snapshot-matched moves, target materialization и guarded source deletion        |
| `reconciliation/commits.ts`                    | Strict/best-effort commits, rejected puts, repairs, recovery, baselines/deletes |
| `errors.ts`                                    | Классификация с прежним приоритетом cause                                       |
| `workflows/force.ts`                           | Preflight, bootstrap, source snapshots, replacement и cleanup                   |
| `workflows/encryption-rewrite.ts`              | Exclusive target upload, read-back, beforeIndexCommit и finally                 |
| `workflows/full.ts`                            | Reconciliation, uploads, pending puts и epoch adoption                          |
| `realtime/batch.ts`                            | Batch, receipts, prepared items, superseded/retry и handoff                     |
| `files/rename.ts`, `files/folder-mutations.ts` | Rename/folder алгоритмы с прежним causal timing                                 |

Upload и публикация metadata остаются раздельными. Watcher finalization предшествует
`markRemoteObserved`; settlement и очистка validation token остаются в фасаде.
Force UI/архив принадлежат `ForceSyncController`, транзакции — `IndexManager`.

## Canonical, baseline и причинность

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
Авторитетное состояние находится в одном файле
`.obsidian-sync-index.json` на Яндекс Диске. Для записи файл атомарно
перемещается в уникальное `.obsidian-sync-index.lock.<transactionId>`,
обновляется и перемещается обратно с `overwrite=false`. Неизменившийся за две
минуты единственный lock восстанавливается другим устройством. Несколько locks или несовместимые snapshots блокируют операции до устранения неоднозначности; Force не обходит эту защиту. Список lock читается с полной пагинацией;
транзакция требует два последовательных одинаковых снимка root listing.
Успешный commit возвращает временный `CanonicalCommitProof`. Он позволяет
пропустить повторный index download только при совпавшем SHA-256/MD5 и
отсутствующих locks. Proof не сохраняется и не разрешает physical write:
corrective upload заново проверяет canonical и encryption manifest.

Обычное чтение canonical и чтение с явным recovery codec используют metadata
из двух совпавших root listings как начальное наблюдение stable raw read.
Проверка после download остаётся обязательной. Наблюдение живёт только внутри
одного чтения: оно не кешируется между операциями и не разрешает physical write.

Full без adoption, maintenance и начатой ранее causal/physical работы не создаёт
delete action для tombstone, когда оба scan подтверждают отсутствие объекта и
VaultAdapter повторно подтверждает отсутствие файла и папки. Такой путь не
увеличивает `deleted` и не требует canonical commit. Неизвестному файлу не
добавляется фиктивный baseline; existing baseline и observed revision сохраняются
через обычное успешное завершение full. Появившийся после scan локальный объект
или ошибка чтения существующего файла требуют повторного reconciliation.

`SyncCoordinator` последовательно выполняет full, Force, realtime batch и
encryption maintenance. Повторные full-запросы объединяются в один запуск.
Watcher использует один durable drain для upload, delete, rename и folder
events. Перед постановкой full sync в очередь локальный `prepare`-этап
замораживает новые realtime-сессии и завершает destructive/rename events,
существовавшие на cutoff. Upload-события cutoff покрывает full barrier.
Acknowledgement и causal rebase выполняются в `settle` до освобождения
coordinator-сессии и сохраняются в `data.json`. Missing-target rename без
remote side effects может быть отложен до конца full: уже подтверждённый или
логически вытесненный путь поглощается по свежему local/canonical состоянию,
а неоднозначный causal source оставляет full неуспешной. После resume
автоматически запускаются только события, созданные либо изменённые во время
паузы; неуспешная сессия ничего не подтверждает и не replay-ит.

Если rename появляется во время уже submitted upload, watcher сохраняет
локальную связь между ID событий и mutation sequence. Upload, принятый
canonical, передаёт rename подтверждённую revision внутри coordinator
settlement; upload до commit retarget-ится с сохранением FIFO sequence. Full
barrier не поглощает upload, на который ссылается rename: вся причинная цепочка
должна завершиться до reconciliation. После realtime upload проверяются только
затронутые physical paths; полный remote-tree scan остаётся обязанностью full
sync для external edit и orphan detection.

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
`authentication` останавливают normal full, realtime, watcher и scheduler;
только `migration` пропускает подтверждённый Force. Resume сначала выполняет
read-only recheck и не может скрыть активный блок статусом `idle`.
Persisted watcher events загружаются в память, но watcher и scheduler
запускаются после строгой проверки manifest/canonical и успешного full reconciliation.
Resume также выполняет full перед replay накопленных событий; неуспешная
проверка, пауза или unload оставляют автоматику остановленной.
Manifest и canonical читаются единым stable raw-примитивом
`metadata → download → metadata`; неизменность подтверждается по `sha256`,
затем `md5`, затем паре `server modified + size`. Canonical и lock находятся
одним стабильным root listing, после чего physical tree сканируется отдельно
с ограниченной параллельностью папок. Перед записью manifest проверяется по
session token; для строгого no-op финальный запрос не выполняется.

Plaintext stable 1.0/1.1 canonical точной формы `version: 1`/`version: 2`
требует явного Force на авторитетном устройстве. Stable local settings/hashes/baseline
необратимо преобразуются и сохраняются одним current snapshot после installation
identity, до автоматизации. Ошибка load/save блокирует sync; unload не заменяет
непрочитанные данные. Lifecycle регистрируется до token/remote checks. Current
canonical допускает normal full adoption, отсутствующий — initial sync. Автоматического
архива при conversion или foreign adoption нет. Resume не снимает typed blocks;
encrypted legacy и неподдерживаемые historical formats запрещают также Force.

Force подтверждается выбором архива, продолжения без архива или отмены. В coordinator
всегда передаётся `ForcePreflightProof`: canonical identity, protected snapshot digest
и nullable archive proof. Canonical, protected snapshot, source и пути проверяются
в обоих вариантах; raw SHA архива — только когда архив выбран. Drift либо ошибка
архива останавливает попытку. Новый запуск требует нового подтверждения, без
автоматического fallback/повторного архива. Source проверяется на transfers и перед
replacement commit; после commit rollback запрещён. Старый `ForceBackupProof`
поддерживается адаптером; одновременные proof запрещены.

До backup metadata-only scan проверяет legacy canonical и physical tree. Любая
копия `plugins/yandex-disk-sync`/`plugins/obsidian-yandex-disk-sync` блокирует
migration без content download и требует удалить remote directory и заменить
OAuth token. Обнаружение сохраняет только non-secret local remediation marker:
даже после удаления remote directory Force остаётся заблокированным до смены
token в настройках. Remote-raw snapshot также проверяет metadata до первого
download и не архивирует plugin data. User paths, конфликтующие с current
service names или меняющиеся при current normalization, требуют ручного
переименования. Path records нейтрализуют prototype accessor, поэтому корневой
`__proto__` остаётся обычным пользовательским ключом.
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
Force создаёт новый `epoch` только на авторитетном устройстве. Остальные
обновлённые устройства принимают этот epoch обычной full sync: до успеха они
сохраняют прежний baseline, сравнивают с ним текущий filesystem и новый
canonical, затем атомарно продвигают `observedEpoch`. Старые mutations и
physical actions не воспроизводятся; локальные изменения оформляются как новые
операции с epoch и base revision принятого canonical snapshot, не старого baseline.
Новая live revision после подтверждённого удаления скачивается: отсутствие файла
под старым deletion baseline не является новым пользовательским delete.
Смена epoch во время realtime не повторяет index
transaction, а оставляет событие durable и ставит один coalesced full.
Replacement canonical содержит live entries выбранной стороны и tombstones с
`mutationSeq: 0` для отсутствующих canonical/physical paths. Transfer принимает
только bytes исходного source snapshot: Force local проверяет SHA каждого
upload и повторный local scan, Force remote использует
`metadata → download → metadata` и повторный remote-tree scan. До первого
local write Force remote блокирует exact/NFC/case-fold collisions. До commit
source mode остаётся авторитетным; после подтверждённого commit rollback
запрещён, migration block снимается, а fingerprint-guarded cleanup продолжает
обычный full даже после потери инициатора.

## Encryption profiles и migration

Новые vault используют `hardened`: PBKDF2 600k выводит master key, HKDF
разделяет AES-GCM content key и AES-SIV filename key. Других codecs в текущей
версии нет. Numeric manifest, encrypted legacy index и другие historical
formats fail closed без чтения или migration; current manifest имеет marker
`encryption-manifest`, строго объявляет все алгоритмы, а unknown
format/profile блокирует любые remote mutations.

Fresh enable, rotate и disable используют один crash-safe transition. До
commit canonical читается source codec, после commit — только target codec.
Cleanup paths и source fingerprints фиксируются атомарно с target canonical,
поэтому другое target-capable устройство может завершить post-commit cleanup
без source password. `IndexManager` разрешает это только matching transition ID
и post-commit phase. Для enable/rotate target canonical читается только после
проверки transitional manifest, target descriptors и verifier. Для disable
target canonical явно читается plaintext внутри того же recovery scope;
удалённый после commit manifest допустим только для matching plaintext target.

До первого target upload строится полное injective отображение
`logicalPath -> targetRawPath`, не пересекающее source и protected paths. Каждый
upload подтверждается stable raw read-back: target path декодируется обратно в
ожидаемый logical path, а расшифрованные bytes сравниваются по plaintext
SHA-256. Fingerprint сохраняется сразу после proof. После crash пропущенный
fingerprint восстанавливается только тем же read-back; без proof canonical
commit и cleanup запрещены.
Success, 409, timeout и остальные ответы upload не считаются доказательством
сами по себе. Raw source object без стабильного server fingerprint блокирует
transition до claim, потому что его последующее удаление нельзя доказать.

Transition manifest для следующей canonical phase публикуется до canonical
commit. Поэтому crash до commit даёт только fail-closed рассогласование, а
сразу после commit remote уже содержит matching authority для foreign
recovery. После target commit stable manifest (либо его удаление при disable)
публикуется до перевода canonical maintenance в `cleanup`. Stable manifest с
matching `index-committed` maintenance является безопасным resume-состоянием.
Pre-commit rollback не публикует post-commit `cleanup`: он оставляет source
авторитетным, удаляет только доказанные target-объекты и затем снимает
maintenance. Неполный guarded cleanup сохраняет local transition и блокировку.
Local recovery дополнительно связывает local snapshot с canonical и manifest по
transition ID, kind, initiator, source revision, descriptors и допустимому
publication window; совпадения одного device ID недостаточно.
Подробный wire и recovery contract описан в
[E2E_ENCRYPTION.md](./E2E_ENCRYPTION.md).

## Локальное применение и физический cleanup

Download фиксирует отсутствие файла или его plaintext SHA до remote I/O.
`VaultAdapter.writeFile` принимает необязательный guard: после подготовки папок
проверяет identity и всё локальное дерево, затем регистрирует ожидаемое watcher
событие непосредственно перед записью. Protective copy нужна для отличающихся
неподтверждённых bytes, включая файл без baseline. Ошибка копии запрещает запись;
после неё SHA проверяется повторно. Late edit/create остаётся для reconciliation,
без подтверждения baseline или счётчика download.

Конфликтная копия переиспользуется только по фактическим bytes. Её локальная
правка сохраняется отдельно; новое имя создаётся с условием отсутствия.
Exact/NFC/case-fold collisions сегментов, файл на месте папки или предка
блокируют применение. Exact update, Unicode и `__proto__` допустимы.

Физическое удаление требует durable action и свежего canonical. Каждая сетевая
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

## Архивы и пользовательские операции

Force и enable/disable/rotate предлагают with-backup, without-backup и cancel на
один запуск. Обязательные source/canonical/codec/fingerprint guards действуют всегда.
Полный архив не заменяет отдельные protective/conflict copies. Ручной backup проходит
через существующий coordinator; папка, режим и пароль фиксируются до чтения файлов.
Настройки и другие foreground operations заблокированы до завершения.

Список/скачивание архивов учитывают поколение конфигурации и закрытие UI. Архив может
открываться собственным паролем после смены vault codec. Формат, limits, password policy
и совместимость описаны в [BACKUP.md](BACKUP.md).

## Состояние синхронизации и уведомления

`SyncCoordinator` назначает каждой full, realtime, Force или maintenance-сессии
идентификатор и тип. `SyncEngine` публикует через один `SyncState` стабильную
фазу, время начала и опциональный прогресс `{ completed, total }`. Смена фазы
удаляет прогресс предыдущей фазы, поэтому завершённая пачка не оставляет
устаревший `N/M` во время записи canonical index или physical cleanup.

`sync-status-presentation` содержит общее форматирование для desktop
`SyncStatusBar`, мобильного `MobileSyncIndicator` и обновляемого `Notice`
ручной full, Force и enable/disable/rotate. Startup, scheduler и realtime
отражаются в status bar на desktop и в постоянной плашке на Android/iOS/iPadOS;
progress Notice для них не создаётся. Существующие foreground и blocking
Notice сохраняются без изменений.

Мобильная плашка находится справа сверху, на 8 px ниже видимых верхних
панелей с учётом safe area. До двух строк, ширина до 360 px и поля не менее
12 px с учётом боковых safe area. Правый край закреплён; при изменении
текста плашка расширяется влево. Она пропускает касания и располагается ниже модальных окон и меню.
DOM-зависимое измерение верхних панелей изолировано внутри компонента;
`ItemView.contentEl` не считается границей системного UI: в floating/fullscreen
раскладке контент может начинаться с нулевой координаты под кнопками. Всегда
резервируется высота верхней панели после максимума native safe area,
Obsidian `--safe-area-inset-top` и `--view-header-top-offset`, без двойного
сложения inset. Учитываются реальные нижние границы header и его плавающих
контролов, даже когда они ниже начала контента; нижние split/tab панели
исключены из верхней области измерения. Резерв остаётся при автоскрытии шапки.
Layout, resize, visual viewport, scroll, завершение CSS transition и изменение
размеров панелей/inset probe обновляют положение через один animation frame,
без polling. Изменения class/style на body/html отслеживаются для смены
мобильной раскладки и safe area. Plugin lifecycle снимает подписки и observers,
отменяет frame и удаляет плашку. Reduced motion отключает вращение; состояние доступно
скринридеру. Кнопок, настроек положения и переходов по нажатию нет.

Плашка перечитывает актуальный UI-контекст: active Force flow → active sync →
foreground encryption/backup → состояние движка. Force сохраняет ownership
между внутренними sync-сессиями. В покое остаётся компактная строка `YD`
либо `YD · HH:mm`, если известно время последней успешной синхронизации;
полная подпись готовности/времени доступна скринридеру. Это не обещание
«всё синхронизировано»: `idle` не доказывает отсутствие deferred events.
При cold startup Obsidian может удалить plugin-owned DOM во время
восстановления workspace. `onLayoutReady` и layout events перечитывают
состояние и повторно подключают тот же элемент к актуальному workspace;
это не зависит от запуска sync. CSS задаёт безопасную начальную позицию
без скрытия до первого animation frame. После unload восстановление запрещено. Подробности ошибки могут
занимать вторую строку. UI-состояние не сохраняется в `data.json` и не
участвует в causal merge, lock-транзакции или выборе encryption codec.

`ForceSyncController` владеет полным пользовательским сценарием обоих
направлений: read-only preflight → выбор архива → необязательный backup с exact read-back →
Force через существующий coordinator → persistence → завершающий normal full.
Он резервирует busy-состояние до первого await, не создаёт очередь и не
позволяет повторному клику запустить второй backup или отложенный Force.
`main.ts` подключает зависимости и Obsidian UI. `SyncRunOptions.onActivity`
передаёт только события с ID принадлежащей вызову coordinator-сессии.

При выборе архива один persistent Notice показывает создание, загрузку и проверку backup,
далее фазы Force, сохранение и итоговую проверку. Настройки подписаны на
тот же неперсистентный flow-state; оба Force-контрола блокируются также при
другой активной sync-сессии. Во время Force настройки и ручные mutating-действия
недоступны, включая промежутки между coordinator-сессиями. Повторное открытие
настроек читает текущее состояние; закрытие снимает подписки, но не отменяет Force.

Успех миграции показывается на 8 секунд только после replacement commit,
persistence, успешного итогового full и отсутствия pending cleanup. Если full
восстановил прерванный cleanup, допустим успех. Иначе после commit остаётся
постоянное сообщение о необходимости normal full; rollback и повторная
миграция не предлагаются. Ошибка backup не запускает Force. Поздние события
предыдущего flow и таймеры не меняют новое уведомление.

## Проверки

Компактные тесты выполняют реальные алгоритмы причинности, транзакций, конкурентности
и recovery с synthetic transport. Они проверяют bytes, canonical, baseline и queues,
а не только вызовы mocks. Wire types определены в `src/types.ts`; строгие loaders
не допускают неявного расширения исторических форматов.

`npm test`, lint, изолированный build, bundle check и scenario validator дополняются
[SMOKE_TESTS.md](SMOKE_TESTS.md). Build читает optional root `.env` для deployment;
агент проверяет сборку в разрешённой копии без `.env` и рабочего vault. Реальный
двухпрофильный прогон обязателен для release. Статус manual evidence хранится отдельно
в `docs/release-evidence/`; успех автоматических проверок его не меняет.

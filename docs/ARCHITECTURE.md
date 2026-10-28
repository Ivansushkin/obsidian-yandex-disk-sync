# Архитектура плагина Yandex Disk Sync

Плагин работает в browser runtime Obsidian на desktop и mobile. Источник общего
состояния — canonical index на Яндекс Диске; baseline и durable queues описывают
отдельную установку. Ожидаемые пользовательские исходы и стабильные ID находятся в
[каталоге сценариев](SYNC_USER_SCENARIOS.md), навигация — в [путеводителе](README.md).

## Границы модулей

Все пути в таблице относительно `src/`.

| Владелец                                                                                          | Ответственность                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `main.ts`                                                                                         | Composition root, Obsidian lifecycle/UI, foreground reservation, wiring live ports.                     |
| `plugin-persistence.ts`                                                                           | Один plugin snapshot, последовательная coherent save queue, load generation и unload admission.         |
| `plugin-startup.ts`, `settings-workflow.ts`                                                       | Read-only startup classification; проверка, сохранение и публикация settings drafts.                    |
| `api/yandex-client.ts`, `api/read-transport.ts`, `api/vault-adapter.ts`                           | HTTP/codec transport, bounded native GET occupancy и доступ к Obsidian Vault/DataAdapter/FileManager.   |
| `sync/engine.ts`, `sync/coordinator.ts`                                                           | Публичные входы, одна очередь сессий, lifecycle guards, sync-state и callbacks.                         |
| `sync/canonical/schema.ts`, `merge.ts`                                                            | Чистая валидация canonical и causal reducer.                                                            |
| `sync/canonical/manager.ts`                                                                       | Фасад canonical, baseline и causal work; единственная точка публикации canonical.                       |
| `sync/canonical/commit.ts`, `recovery.ts`, `transaction.ts`                                       | Обычный exclusive commit, неоднозначные ответы, stale-lock recovery и exact raw rollback.               |
| `sync/local/`                                                                                     | LocalOperationStore, baseline rules, storage binding и scope identity.                                  |
| `sync/files/`                                                                                     | Transfers, guarded local apply, physical actions, rename/folder moves и recursive deletion planner.     |
| `sync/reconciliation/`                                                                            | Планирование конфликтов, commits, rejected puts, accepted repair, physical recovery и baselines.        |
| `sync/workflows/full.ts`, `initial-receive.ts`, `encryption-adoption.ts`                          | Full reconciliation, первое получение cloud и приём authoritative encryption epoch.                     |
| `sync/workflows/force-controller.ts`, `force-replacement.ts`, `force-state.ts`                    | Подтверждение, direct Force, checkpoint и завершение. `force.ts` сохраняет внутренний совместимый путь. |
| `sync/realtime/queue-rules.ts`, `rules.ts`                                                        | Чистые преобразования watcher queue и правила receipts/eligibility.                                     |
| `sync/realtime/watcher.ts`, `settlement.ts`, `batch.ts`, `rename-batch.ts`                        | Подписки, один drain, durability barriers, settlement и пакетное исполнение.                            |
| `crypto/workflow.ts`, `admission.ts`, `maintenance.ts`, `recovery.ts`                             | Encryption preparation/connect, admission, publication, cleanup и recovery.                             |
| `crypto/replacement.ts`, `replacement-cleanup.ts`                                                 | Replacement descriptors, frozen scope и authoritative cleanup.                                          |
| `crypto/encryption-transition.ts`, `encryption-manager.ts`, `encryption.ts`, `manifest-schema.ts` | Transition controller, codec/snapshot ownership, криптография и strict manifest validation.             |
| `backup/`                                                                                         | Logical/raw snapshots, ZIP/envelope, archive choice и exact read-back proofs.                           |
| `errors.ts`, `sync/errors.ts`, `sync/canonical/errors.ts`                                         | Транспортные/domain ошибки, классификация recovery и безопасная presentation summary.                   |
| `ui/`                                                                                             | Dialogs, status presentation и общая desktop/mobile плашка; без domain state.                           |

Settings и изменяемые callbacks читаются через live getters. Domain-модули получают
узкие capabilities; они не импортируют UI/runtime-фасад и не создают второй
coordinator, store или persistence queue. Импорты ведут к владельцу; compatibility
re-exports сохраняют identity классов ошибок. `main.ts` не содержит новых алгоритмов.

## Состояние и причинность

Один `.obsidian-sync-index.json` содержит `format: "sync-index"`, `epoch`, `revision`,
file states, folder tombstones, pending moves, `appliedMutationSeq` и optional
maintenance/epoch-adoption metadata. Перед использованием проверяются точные shapes,
пути, числовые поля и causal relationships. Semantic failure не разрешает codec fallback.

Локальный `data.json` с `format: "plugin-data"` объединяет settings, encryption/Force
checkpoints, `LocalSyncState`, pending mutations, physical actions и watcher events.
Они сохраняются одним coherent snapshot. Чтение canonical само по себе не продвигает
`observedRevision`: нужен полностью применённый reconciliation и durability barriers.

Для каждой установки мутации имеют монотонный `seq`; canonical подтверждает только
непрерывный watermark внутри epoch. Retry сохраняет исходные ID/seq. FIFO gap,
чужой actor или один sequence с разным logical state блокируют commit. Own successor
с непрерывным watermark не становится конфликтом из-за старого `baseRevision`.
Client clocks не выбирают победителя.

Local drift определяется plaintext SHA-256 относительно baseline. Remote drift —
physical fingerprint, затем server mtime относительно baseline при отсутствии
fingerprint. Exact delete побеждает stale put; causally-later put восстанавливает
путь; новый/изменённый descendant переживает folder delete. Политика conflict и
protective copies принадлежит [CONFLICTS.md](CONFLICTS.md).

Проверенный physical stamp не является logical mutation: под lock сравнивается вся
исходная entry, сохраняются plaintext SHA, actor/seq и watermarks. Идемпотентный stamp
не меняет revision; изменившаяся entry отклоняет устаревший stamp, другие entries
не мешают. Это применимо и к `mutationSeq: 0`.

`remoteScope` связывает local history с нормализованным remote path и opaque resource
ID корневой папки. ID доказывает идентичность папки, но не неизменность её содержимого.
Unbound непустая history требует подтверждения прежнего storage. Новый storage
допускается без pending work/transition, с coherent reset baseline. Token repair для
той же папки сохраняет историю. Потеря plugin data создаёт нового actor; localStorage
не переименовывает существующие pending IDs.

## Canonical transactions и recovery

Обычный commit использует exclusive MOVE в уникальный raw
`.obsidian-sync-index.lock.<transactionId>`, запись и MOVE обратно с `overwrite=false`.
`canonical/merge.ts` получает latest under lock, loaded/desired snapshots, actor,
base revision, completed moves и put baselines; он не выполняет I/O/save/logging.
Режимы normal, physical rewrite, replacement и target recovery выбираются manager,
а не reducer. Последний put baseline выбирается по path, включая explicit undefined.

Стабильное чтение root полностью paginated и повторяется дважды. Multiple locks,
неизвестная identity или несовместимые snapshots блокируют обычную sync. Единственный
читаемый неизменный lock получает двухминутную lease. Recovery привязывает strict
content identity и exact bytes, эксклюзивно переносит lock в уникальный raw claim,
проверяет claim read-back и только затем публикует canonical. Renewal начинает lease
заново; competing/resurrected locks запрещают publication. Crash оставляет raw lock
для нового наблюдения. Lost MOVE reply требует exact read-back и проверки единственности.

Missing canonical создаётся общим initialization-путём с installation ID, runtime
validation и `overwrite=false`; ambiguous seed подтверждается stable read-back.
Чужой seed можно принять обычным чтением, но нельзя заменить по старому absence proof.

До подтверждённого commit допустим exact raw rollback исходным codec. После commit
ошибка local acceptance/cleanup не разрешает rollback. `CanonicalCommitProof`
эфемерен: matching SHA-256/MD5 и fresh unlocked root позволяют не скачивать index
повторно в той же resolution. Proof не сохраняется и не разрешает physical write.

Direct Force — явное исключение: `IndexManager.publishDirectForceCanonical` валидирует,
пишет конечный raw canonical и проверяет read-back без lock, lease, staging или MOVE.
Старый `canonical/force-publication.ts` остаётся внутренним совместимым адаптером;
public direct-v1 его не использует. Полный контракт — [FORCE_SYNC.md](FORCE_SYNC.md).

## Чтение, snapshots и lifetime

Service content identity: SHA-256 → MD5 → server modified + size; `resource_id` не
доказывает неизменность service bytes. Physical user fingerprints используют общий
helper и принимают сохранённые SHA-256, MD5, resource ID и modified без migration.
Raw canonical/lock/manifest и logical user paths не смешиваются.

Stable raw/logical read проверяет metadata до и после download и связывает bytes
с server SHA-256, когда он доступен. Raw read при несовпадении хеша один раз заново
получает download link и проверяет metadata в прежнем budget, сохраняя исходную
content identity; повторное несовпадение или смена версии — ошибка.
Invocation-owned
`CanonicalReadSession` хранит только собственный verified snapshot; caller не может
seed-ить её desired index. Fresh scope/root/lock/hash checks обязательны на каждом
reuse. Matching SHA-256/MD5 позволяет reuse bytes; no-hash/drift требует нового stable
download. Parsed view переиспользуется только при той же decode-context identity;
caller получает независимую копию.

Startup classification и следующий full могут разделять service session одного
`PluginStartup.runInvocation`. Standalone refresh и scheduled full независимы.
Recovery, codec/config ABA или ошибка наблюдения инвалидируют сессию. У encrypted
startup raw canonical/manifest могут читаться параллельно, но не декодируются до
аутентификации выбранного codec. Candidate install не пропускает verifier/canonical proof.

В initial/full evaluation scope, manifest-token и canonical validators получают одну
opaque observation из новой stable root pair. Root identity проверяется на каждой
странице; partial/repeated pages и service drift запрещают reuse. Observation живёт
только внутри callback данного manager/config/lifetime и удаляется в `finally`.
Это не TTL cache, persisted proof или разрешение записи. Следующий write/retry
получает новую evaluation; standalone write guard остаётся самостоятельным.

Generation учитывает token/path, active/transition codecs, pause и host stop/unload,
включая смену обратно на прежнее значение. Guards проверяются до/после await и
синхронно перед native/API dispatch через `withWriteGuard`; callback снимается в
`finally`. Late bytes и callbacks закрытой invocation не применяются.

## Full, realtime и physical apply

Full проходит admission/recovery/adoption → local и remote scan → classification →
transfers → canonical commit → physical recovery → watcher settlement → coherent
observed-state save → resume/ACK до освобождения coordinator. Local и remote scans
перекрываются, но обе ветви завершаются до classification. Любой неполный local
read/hash или remote listing — ошибка, никогда не пустое дерево.

Pristine device сначала получает live cloud paths и exact tombstones с protective
copies; partial baselines переживают restart, но не разрешают watcher publication.
После coherent receive обычный full загружает unknown local-only файлы. Established
file без baseline считается новым. Legacy/непустая causal history не получает
pristine semantics.

При unchanged desired canonical, отсутствии pending mutations, completed moves и
active commit modes baseline-only receive не пишет canonical. Сначала сохраняются
partial baselines/queues без observed advancement/ACK, затем fresh final evaluation
сверяет scope/manifest/canonical/lifetime. Stamp, watermark и conflict settlement
по-прежнему требуют commit. Published local tombstone может создать durable local
action без нового commit; backup, local identity и final authority checks сохраняются.

Обычный upload и публикация metadata раздельны. Перед каждым PUT/retry проверяются
canonical/codec/scope и expected physical state. Accepted repair сначала проверяет
physical fingerprint, затем при необходимости pinned local SHA и свежую authority.
Первичная metadata accepted uploads читается группой до четырёх без изменения
индекса; перед settlement повторно проверяются encryption admission и актуальные
canonical entries. Lifetime/config ABA отменяет всю группу после join начатых reads.
Repair и conflict copies остаются последовательными; stamps берутся из verified snapshot.
Ambiguous PUT подтверждается stable plaintext read-back, а не повторным overwrite.
Upload-group failure сохраняет FIFO и останавливает full до дальнейшего settlement.

Local write фиксирует absence/SHA до remote I/O и повторяет проверку после mandatory
protective copy и parent preparation. Scope и полный portable-collision scan проходят
до watcher suppression и записи. Late create/edit/delete запрещает stale apply.
Обычное локальное удаление использует FileManager trash. Ошибка обязательной копии
блокирует overwrite/delete.

Обычное remote delete требует durable intent, fresh canonical authority и expected
physical fingerprint на каждой попытке; move cleanup дополнительно доказывает target.
`completed`, `cancelled`, `deferred` различаются: HTTP success/202 и deferred не
доказывают отсутствие и не увеличивают deleted. Ordinary optional remote pruning
выключен; удаление папки не должно поглотить live/excluded descendant.

Realtime хранит один drain и durable queue. Upload/delete идут последовательными
окнами до 32 events / целевые 8 MiB plaintext; oversized file обрабатывается отдельно.
Окно полностью завершает commit/repair/ACK/save до следующего prepare. Независимые
renames используют общий intent/completion commit и concurrency ≤4, сохраняя
causal dependencies. Tracked-source put завершается с исходными ID/seq до rename;
foreign source не получает own delete authority. `confirmed-unchanged` receipt не
подтверждает put и не двигает watermark. Детали очередей и retry —
[PARALLELIZATION.md](PARALLELIZATION.md).

Lookup-индексы ограничены проходом: latest matching (path,SHA), latest put baseline,
ancestry membership и Set live ancestors не кешируют authority. После await берутся
актуальные store/metadata; overlapping tombstones сохраняют causal order.

## Force и encryption replacement

| Режим                                        | Источник и область                                                                                                                                                            | Приём другим устройством                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Ordinary sync                                | Three-way reconciliation в текущих filters; protective copies обязательны по правилам конфликтов.                                                                             | Merge относительно baseline и причинности.                                                             |
| Direct Force                                 | Подтверждённый source заменяет destination в frozen user filters/config switch; protected/excluded paths сохранены. Hidden/empty directories участвуют только в этой области. | При offline delta — epoch-bound accept/preserve/later; без delta — обычный full adoption.              |
| Новые enable/disable/rotate                  | Frozen local reference инициатора заменяет selected scope в fresh epoch; protected/excluded raw paths сохранены.                                                              | Stable `epochAdoption` автоматически заменяет выбранные local bytes и старые queues до ordinary merge. |
| Legacy encryption checkpoint без replacement | Прежний epoch и fingerprint-guarded cleanup; policy не выводится из kind/phase.                                                                                               | Прежний recovery и обычное reconciliation.                                                             |

Direct Force применяет общие include/exclude/protected правила к чтению и удалению.
Для encrypted destination нужны проверенные параметры: сохранение codec защищает
исключённые ciphertext; его удаление при таких остатках блокируется. Scope до
apply заморожен в плане; persistent schema не меняется, explicit pending lists
определяют recovery независимо от новых filters.

Direct Force сохраняет direct-v1 remainder до destructive work. Independent failures
не останавливают остальные действия; ordinary manual/startup/scheduled full продолжает
остаток до merge, без повторного broad purge или архива. Source read/auth failure не
означает empty source. Новый полный Force всегда требует подтверждения; legacy
checkpoint не расширяется автоматически. `ForceSyncController` резервирует один
invocation и открывает окно до source reads. Preparation, password retry и archive
confirmation остаются в нём; UI показывает состояние, а controller управляет
отменой и ждёт admitted reads/archive перед освобождением reservation. Passwords
передаются напрямую, без публикации в `ForceFlowState`. Manifest absence означает
plaintext source; manifest read/parse errors не разрешают fallback.

Encryption использует существующий `EncryptionTransitionController`, source authority
до target commit и target authority после него. `maintenance.replacement` хранит
scope/epochs/preserved raw paths/durable deletion cover; local transition — reference
hashes. Shared `planRecursiveDeletes` схлопывает только полностью removable subtree.
Excluded old-codec inventory сохраняется между переходами и фильтруется до decode.

Новые replacement DELETE проверяют operation authority и lifetime, а не старый
fingerprint назначения. После purge target повторно проверяется; repair возможен
только из pinned local reference с read-back/stamp. Не более четырёх sweep/repair
passes; несовпадение оставляет recovery. Legacy cleanup и pre-commit rollback
сохраняют fingerprint guards. Candidate credentials, publication windows, foreign
recovery и wire formats описаны в [E2E_ENCRYPTION.md](E2E_ENCRYPTION.md).

Target metadata проверяется отдельно от repair, до четырёх reads, между свежими
authority observations с неизменным reference. Parent listings получаются после
DELETE; pre-delete scan сообщает только стоимость страниц. Missing entry требует
GET, no-hash/drift — stable plaintext read-back; resource ID не заменяет content hash.

Force и authoritative encryption replacement не дают server fencing: уже отправленный
чужой запрос может завершиться после проверки. Предупреждение encryption transition требует не
редактировать ни одно устройство до завершения. Остановка других устройств не является
допуском direct Force. Архивы и их exact verification — [BACKUP.md](BACKUP.md).

## Startup, settings и остановка

Локальная настройка `language` принимает `system`, `en`, `ru`, `kk`, `be`, `uz`.
`system` сохраняет существующий источник Obsidian `localStorage["language"]`;
неизвестный системный язык даёт English. Отсутствующее/неизвестное сохранённое
предпочтение нормализуется в `system` до coherent save, без изменения format.
Ручной выбор применяется через `UserSettingsPatch` только после успешного save;
он не меняет admission, `manualSyncRequired`, causal state или очереди и не
запускает remote work. Селектор подчиняется общему busy-guard.

i18n владеет активным языком; `main.ts` только обновляет зарегистрированные commands,
ribbon, indicator и существующий settings Notice. Перерисовка настроек сохраняет
generation guards для подсказок логов и не добавляет подписок зеркала. Copy/open/clear
сохраняют иконки, подписи и отсутствие loader; удалённый viewer не восстанавливается.
Последний backup хранится в settings UI как наблюдённая дата: смена языка
переформатирует её без нового remote listing. Известные failure codes переводятся
при presentation; исходная причина остаётся в локализованном блоке технических
подробностей. Это сохраняет исходные sanitized
summary/cause, classification и recovery policy. Даты и размеры используют активный
язык. Ключи, placeholders и конечные динамические семейства проверяет `check:i18n`;
это проверка ресурсов, а не доказательство работы Obsidian.

Local state загружается и lifecycle callbacks регистрируются до token/remote checks.
Load/format/initial-save failure закрывает persistence и automation; unload не
перезаписывает исходные данные defaults и не повторяет failed save. Stable plaintext
1.0/1.1 local migration необратима: installation identity, затем один coherent current
save до automation. Encrypted legacy/unknown formats fail closed; mixed builds не
поддерживаются. Confirmed Force независимо проверяет source/destination admission,
но не обходит failed local load/persistence.

Только успешный full после read-only classification допускает watcher/scheduler.
Resume сначала перепроверяет blocks и выполняет full; явная pause сохраняется.
Pending direct Force продолжается до normal merge. Pause failure останавливает body;
resume/ACK failure делает сессию неуспешной без rollback подтверждённых bytes/canonical.

`UserSettingsPatch` проходит runtime allowlist; identity и encryption snapshot не
редактируются произвольным draft. Сначала watcher drain/save, затем settings save,
затем publication. Settings-save task не ждёт watcher внутри persistence queue.
Runtime-only изменения не запускают remote recheck; token/path инвалидируют admission,
file scope требует нового full. Failed save оставляет `local-persistence` block;
явный settings repair может повторить save. Scheduler interval 0 отключает timer;
realtime off сохраняет durable events.

Snapshot собирается при исполнении save, а не постановке. Load generation проверяется
до write и после await: старый draft не публикуется после reload. Unload снимает UI,
listeners/timers и запрещает новые writes; lifecycle settlement уже принятой сессии
завершается через прежнюю persistence queue, без нового replay.

## Диагностика, UI и проверки

`SyncState` содержит session ID/kind, фазу и известный progress; смена фазы снимает
старый N/M. Один formatter обслуживает desktop/mobile `SyncIndicator`, Notice и
selectable status dialog. Состояние UI не сохраняется и не выбирает causal winner.
Force/encryption foreground reservation охватывает промежутки между внутренними
сессиями. Success появляется после verification и coherent persistence; idle не
доказывает отсутствие deferred work на других устройствах.

Настройки применяют одну UI-политику поверх существующих activity sources: startup/full,
realtime, configuration update, Force, backup и encryption отключают действия и поля.
Собственные ограничения компонентов сохраняются после busy. Loader и `aria-busy`
принадлежат выполняемому действию, включая повторное открытие экрана; обновления
прогресса не пересоздают поля.
Кнопка Sync сохраняет постоянную подпись для раскладки и доступного имени; во время
проверки подключения и full подпись скрыта, по центру виден только loader.
Статусы используют общую presentation; размеры кнопки не зависят от этапа.
Весь раздел логов доступен во время работы, кроме собственных migration/lifecycle
ограничений. Logging patches идут через общую
persistence queue без remote recheck и не инвалидируют backup context.
Сохранение token/path не создаёт startup invocation и не запускает admission,
password prompt или full. Оно атомарно устанавливает локальный settings-флаг
`manualSyncRequired` вместе с новым подключением. Fresh install устанавливает его;
существующие данные без поля используют false. Маркер `plugin-data` не меняется.

Пока флаг установлен, startup, watcher, scheduler, queued automatic full и passive
backup listing не начинают удалённую работу, в том числе после restart. Другие
settings patches не обходят ожидание. Успешный manual full сохраняет snapshot со
снятым флагом через общую persistence queue и лишь затем публикует activation.
Pause/unload во время финального save отзывает activation: до settlement очередь
сохраняет coherent pending snapshot, не публикуя снятие ожидания. Epoch retry
привязан к поколению подключения и отменяется при token/path change, включая ABA.
Failed save/cancel/error не запускают automation; Force/encryption maintenance
не снимают ожидание. `trigger` full invocation явно различает manual/automatic/
maintenance независимо от Notice policy. Admitted filter changes и persistence
repair используют обычный full после освобождения settings lock, без отдельного
admission и busy bypass.

`EncryptionAdmission` владеет отложенным запросом пароля после rotation; host
запускает его после settlement coordinator и outer operation, затем один full.
Ручной admission перепроверяет cached startup state. Дедупликация и отзыв
контекста описаны в [E2E_ENCRYPTION.md](E2E_ENCRYPTION.md#orchestration-и-admission).

`getSyncPresentation` вычисляет один приоритет и текст для плашки и settings Notice:
Force → engine activity → foreground → connection → full → terminal/idle.
Плашка показывает все статусы; один `SettingsStatusNotice` зеркалит её только
в открытой вкладке настроек плагина. Idle/hide/другая вкладка/unload снимают зеркало;
reopen читает live state, re-render и поздние результаты не создают дубликатов.
Ошибки preflight, settings drain и backup вне engine state хранятся в памяти как
presentation issue: admission не меняется, ошибка очищается при следующем запуске
или разрешении причины, но не при открытии настроек. Команда статуса также читает
эту ошибку. Самостоятельные action errors, clipboard feedback и ошибка загрузки
до создания плашки остаются отдельными. Manual full использует общие admission,
invocation-owned reads и recovery guards без settings-only preflight.

Общие `copyLogTail` и `openLogFile` обслуживают настройки и плашку. Копирование
сохраняет clipboard activation/fallback, ограничивает очищенный хвост 4000 символами
и игнорирует поздние чтения после закрытия UI. Счётчик подсказки читается только при
наведении/фокусе, обновляется после copy/clear и не подписывается на flush логгера.
Внешнее открытие использует optional `app.openWithDefaultApp` с lifecycle guards;
возврат метода не доказывает успех ОС. Встроенного viewer нет.

Создание ручного backup и очистка журнала требуют явного подтверждения. Закрытие
диалога означает отказ; UI повторно проверяет lifecycle, конфигурацию и busy перед
запуском. Парольный submit допускает одну проверку; ответ закрытого окна не продолжает
workflow. Это UI-admission, а не новый coordinator или persisted operation.

`OperationFailure` хранит cause только в памяти; наружу идёт очищенная summary с
этапом и безопасным code. Root/canonical/local identity/mandatory backup ошибки имеют
приоритет над вложенной сетью. Signed-link 404 не доказывает absence API resource.
Только native transport rejection считается network; decode/unknown ошибки не
повторяются автоматически. Read budget — 60 s, включая очередь, backoff и все этапы
stable snapshot. API metadata/link GET attempt — 15 s; до четырёх attempts всего,
после unresolved timeout — максимум один replacement. Общая recovery policy не
разрешает unresolved retry: узкое исключение принадлежит API transport. Signed
bytes и operation polling после unresolved timeout не дублируются.

Native GET удерживает место до фактического ответа, даже после timeout/отзыва.
Основной пул соответствует `maxConcurrency`, отдельный replacement pool — два
места на клиент. Локальная concurrency обхода/backup не меняет глобальный пул.
Polling сохраняет исходный lifetime между iterations и backoff.
Истёкший/отозванный waiter не dispatch-ится при позднем освобождении
места. Смена token/path/codec, pause/resume и unload отзывает старые waits; поздние
ответы наблюдаются без применения. Это не отмена native HTTP и не второй sync
coordinator. Retry/backoff остаются у transport owner; writes сохраняют прежние guards.

Логи не содержат credentials, keys, ciphertext, content, signed links или полный
canonical. Build ID и request/byte counters помогают сравнивать runs; сумма длительностей
конкурентных запросов не равна latency. Synthetic tests проверяют реальные algorithms
через искусственный transport; они не доказывают работу Obsidian/Yandex/mobile.
На info/warn фиксируются безопасные request ID, endpoint без query, категория
чтения, attempt, queue/native duration, remaining budget и решение recovery.
Capacity timeout отличается от native timeout; late reply помечается ignored.

Команды разработки и проверок — [README.md](README.md#разработка-и-проверки), реальный
двухпрофильный прогон — [SMOKE_TESTS.md](SMOKE_TESTS.md). Machine-readable
[release evidence](release-evidence/2.1.0.json) сохраняет фактический статус ручной
приёмки и не обновляется автоматически из unit results.

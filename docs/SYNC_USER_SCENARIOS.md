# Пользовательские сценарии синхронизации

Этот документ — нормативный каталог поведения синхронизации. Изменение
алгоритма считается законченным только после обновления затронутых сценариев и
соответствующих тестов.

## Как читать каталог

- `P0` — возможна незаметная потеря или раскрытие данных.
- `P1` — синхронизация может остановиться, повторять операцию или потребовать
  ручного восстановления.
- `P2` — проблема производительности, диагностики или удобства.
- `auto` — сценарий должен выполняться автоматически.
- `auto: <suite>` задаёт обязательную suite/категорию, а не подтверждает, что
  тест уже реализован. До появления исполняемого теста с этим ID сценарий
  считается непокрытым и блокирует release согласно приоритету.
- `manual-required` — требуется проверка на реальном Яндекс Диске и Obsidian.
- Под `canonical` понимается `.obsidian-sync-index.json`.
- `Physical` — фактические пользовательские файлы на Яндекс Диске.
- Локальный файл без baseline существует до первой успешной синхронизации
  данного устройства и считается новым пользовательским состоянием.
- Пустые папки отдельно не синхронизируются.

Для каждого сценария применяются варианты из [матрицы](#матрица-вариантов),
если строка явно не ограничивает режим или число устройств.

## Инварианты

| ID      | Инвариант                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------- |
| INV-001 | В стабильном состоянии существует один canonical index; lock является временным именем того же файла.   |
| INV-002 | Пользовательский файл не удаляется физически до commit соответствующего tombstone.                      |
| INV-003 | Ошибка backup блокирует удаление изменённого локального файла.                                          |
| INV-004 | Exact delete побеждает конкурентное изменение, но causally-later put восстанавливает путь.              |
| INV-005 | Folder delete не удаляет нового или изменённого потомка.                                                |
| INV-006 | Принятый canonical put в итоге имеет соответствующий physical-файл с подтверждённым fingerprint.        |
| INV-007 | Старое physical action не применяется к более новому canonical-состоянию.                               |
| INV-008 | Операция подтверждается только непрерывным per-device FIFO watermark своего epoch.                      |
| INV-009 | Force создаёт новый epoch; другое устройство принимает его full sync, не replay-ит старые physical actions и заново причинно применяет локальный drift. |
| INV-010 | Local `observedRevision` изменяется только после полностью применённого canonical-состояния.            |
| INV-011 | Клиентские часы разных устройств не участвуют в выборе победителя.                                      |
| INV-012 | Service-файлы, lock и данные самого плагина не попадают в пользовательскую синхронизацию.               |
| INV-013 | До encryption commit авторитетен source-режим, после commit rollback запрещён.                          |
| INV-014 | Во время encryption cleanup старый physical-набор не виден как пользовательские файлы.                  |
| INV-015 | Неоднозначное состояние блокируется, а не разрешается выбором случайного index или lock.                |

## Первичная синхронизация и запуск

| ID       | P   | Исходное состояние и действие                          | Ожидаемый результат                                               | Проверка                |
| -------- | --- | ------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------- |
| INIT-001 | P1  | Local и remote пусты, canonical отсутствует            | Создаётся пустой canonical и локальный baseline текущего epoch    | manual-required |
| INIT-002 | P1  | Только local-файлы                                     | Все файлы загружены, canonical содержит live entries              | manual-required |
| INIT-003 | P1  | Только remote-файлы                                    | Все файлы скачаны, baseline содержит server fingerprints          | manual-required |
| INIT-004 | P1  | Одинаковый файл есть с обеих сторон                    | `none`, без повторной загрузки, baseline сохранён                 | manual-required |
| INIT-005 | P0  | Разные файлы одного пути без local baseline            | Создаётся conflict copy; ни одна версия не теряется               | manual-required |
| INIT-006 | P0  | Новый local-файл находится под старым folder tombstone | Local-файл считается новым и восстанавливает путь                 | auto: conflict-resolver |
| INIT-007 | P1  | Remote physical существует, canonical отсутствует      | Canonical строится из фактического remote/local merge             | manual-required |
| INIT-008 | P1  | Canonical отсутствует, существует один активный lock   | Sync ждёт владельца; до stale-time lock не забирается             | auto: fault             |
| INIT-009 | P1  | Canonical отсутствует, один неизменный stale lock      | Lock восстанавливается после двух стабильных наблюдений           | auto: fault             |
| INIT-010 | P0  | Несколько locks                                        | Normal sync блокируется; ни один lock не удаляется                | manual-required |
| INIT-011 | P1  | Canonical v1/v2                                        | Normal sync блокируется с инструкцией Force                       | manual-required |
| INIT-012 | P1  | Предрелизный v3 без epoch                              | Normal sync блокируется как legacy prerelease state               | manual-required |
| INIT-013 | P1  | Новый девайс, canonical current epoch                  | Выполняется initial merge; epoch принимается после reconciliation | manual-required |
| INIT-014 | P0  | Старый девайс с другим непустым epoch                  | Full принимает новый epoch и выполняет трёхсторонний merge без Force | auto: `a full sync accepts a replacement epoch without Force ping-pong`; two-device |
| INIT-015 | P1  | Первый запуск прерван после remote scan                | Следующий запуск повторяет merge без потери состояния             | auto: fault             |
| INIT-016 | P2  | В remote только пустые папки                           | Папки не скачиваются и не попадают в canonical                    | auto: integration       |
| INIT-017 | P1  | Token отсутствует или недействителен                   | Ни watcher, ни scheduler не изменяют remote                       | manual-required |
| INIT-018 | P1  | Сеть недоступна при определении initial state          | Initial sync не подменяет remote пустым состоянием                | auto: fault             |
| INIT-019 | P0  | Encrypted canonical v1/v2 с правильным ключом          | Ошибка версии не маскируется codec fallback; показывается Force-инструкция | auto: `encrypted legacy startup preserves LegacyIndexVersionError` |
| INIT-020 | P0  | Canonical не читается разрешёнными codec               | Startup блокируется без watcher, scheduler и remote mutation      | auto: `wrong encrypted index key is classified as unreadable` |
| INIT-021 | P0  | Watcher-событие возникает до/во время startup encryption guard | Событие durable-буферизуется; blocked/failed startup его не теряет | auto: `strict no-op validates encryption only once`; integration |
| INIT-022 | P0  | Устройство 1.1 обновляется после Force на другом устройстве | Legacy `localIndex` преобразуется в baseline до первого save; local drift участвует в adoption merge | auto: `legacy local index becomes an unobserved baseline`; integration |

## Обычный full и realtime

| ID       | P   | Действие                                         | Ожидаемый результат                                             | Проверка                |
| -------- | --- | ------------------------------------------------ | --------------------------------------------------------------- | ----------------------- |
| SYNC-001 | P2  | Full без изменений                               | Нет physical операций и лишнего canonical commit                | auto: integration       |
| SYNC-002 | P1  | Новый local-файл                                 | Один upload и один batch index commit                           | manual-required |
| SYNC-003 | P1  | Новый remote-файл                                | Один download и сохранение baseline                             | manual-required |
| SYNC-004 | P1  | Local edit                                       | SHA отличается от baseline, выполняется upload                  | manual-required |
| SYNC-005 | P1  | Remote edit                                      | Fingerprint/mtime отличается от baseline, выполняется download  | manual-required |
| SYNC-006 | P0  | Local и remote изменены независимо               | Создаётся conflict copy, сохраняются обе версии                 | manual-required |
| SYNC-007 | P1  | Remote fingerprint изменился при том же mtime    | Изменение считается remote edit                                 | auto: conflict-resolver |
| SYNC-008 | P1  | Fingerprint отсутствует, server mtime изменился  | Изменение считается remote edit без tolerance window            | auto: conflict-resolver |
| SYNC-009 | P0  | Разные клиентские часы                           | Результат совпадает с вариантом без clock skew                  | manual-required |
| SYNC-010 | P1  | Physical отсутствует при live canonical          | Файл восстанавливается с authoritative live-копии               | manual-required |
| SYNC-011 | P1  | Physical существует без canonical entry          | Объект проходит безопасный initial/orphan merge                 | manual-required |
| SYNC-012 | P1  | Obsidian закрыт до realtime debounce             | Следующий startup full обнаруживает изменение                   | auto: fault             |
| SYNC-013 | P1  | Obsidian закрыт после durable mutation до upload | Mutation или filesystem state воспроизводится идемпотентно      | auto: fault             |
| SYNC-014 | P1  | Edit во время full sync                          | Событие сохраняется и воспроизводится после сессии              | manual-required |
| SYNC-015 | P1  | Create→modify в одном debounce                   | Загружается последний snapshot                                  | auto: file-watcher      |
| SYNC-016 | P1  | Create→delete до flush                           | Не создаётся потерянный live entry                              | auto: file-watcher      |
| SYNC-017 | P1  | Delete→create до flush                           | Итоговое состояние live                                         | auto: file-watcher      |
| SYNC-018 | P1  | Engine записывает/удаляет локальный файл         | Watcher не создаёт обратную пользовательскую операцию           | manual-required |
| SYNC-019 | P1  | Engine event приходит с большой задержкой        | Он подавляется по durable expectation, не по TTL                | auto: fault             |
| SYNC-020 | P2  | Несколько scheduler/manual full одновременно     | Выполняется один coalesced full run                             | auto: coordinator       |
| SYNC-021 | P2  | Realtime batch из нескольких файлов              | Контент читается и хешируется по одному разу, index commit один | auto: integration       |
| SYNC-022 | P1  | Durable upload остался после закрытия до debounce, а файла при restart уже нет | Успешная full sync подтверждает captured ID без realtime replay и remote write | auto: `plaintext/encrypted no-op full consumes a stale watcher upload without remote write` |
| SYNC-023 | P0  | Upload создан во время full sync                  | Новый ID не поглощается barrier и воспроизводится после full    | auto: `successful full barrier acknowledges only pre-full uploads` |
| SYNC-024 | P0  | Full sync завершилась с ошибками при pre-full upload | Captured upload остаётся durable и повторяется позже            | auto: `failed full barrier retains every captured upload`; `failed full sync postpones watcher replay` |
| SYNC-025 | P0  | Успешный realtime `put-target`, затем full sync       | Confirmed baseline сохраняет fingerprint/mtime/revision; full выполняет `0/0/0` без index commit | auto: `plaintext/encrypted unsynced rename retargets the pending put`; integration |
| SYNC-026 | P0  | Retry существовал до full/maintenance                 | Старый retry не запускается повторно сразу после сессии; автоматически replay-ятся только новые/изменённые за время паузы события | auto: `successful session replays only watcher events created while paused`; `failed session does not replay watcher events created while paused` |
| SYNC-027 | P0  | Manual/startup full запрошен во время upload → rename chain | Связанные upload и rename завершаются до reconciliation; неоднозначная цепочка блокирует full и старый путь не скачивается | auto: `startup blocks before reconciliation when an upload rename chain is unresolved`; integration |
| SYNC-028 | P0  | Realtime commit обнаруживает новый epoch | Транзакция откатывается без четырёх retry, событие остаётся durable и ставится один coalesced full; повторная замена завершает full с `epoch-replaced-during-sync` | manual-required |


## Удаление файла

| ID      | P   | Действие и порядок                                         | Ожидаемый результат                                                           | Проверка                    |
| ------- | --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| DEL-001 | P0  | Local exact delete                                         | Tombstone commit предшествует physical delete                                 | manual-required |
| DEL-002 | P0  | Remote exact delete                                        | Изменённый local-файл сохраняется в backup и удаляется                        | manual-required |
| DEL-003 | P0  | Backup изменённого файла не создался                       | Tombstone остаётся, physical local delete не выполняется                      | auto: fault                 |
| DEL-004 | P1  | Crash до tombstone commit                                  | Local deletion остаётся pending и повторяется                                 | auto: fault                 |
| DEL-005 | P0  | Crash после tombstone до physical delete                   | Следующий запуск продолжает delete, не восстанавливает файл                   | auto: fault                 |
| DEL-006 | P1  | Crash после physical delete до action confirmation         | Отсутствие файла идемпотентно завершает action                                | auto: fault                 |
| DEL-007 | P0  | Edit конкурентен exact delete и имеет старый base          | Delete побеждает, edit сохраняется в backup                                   | manual-required |
| DEL-008 | P0  | Put создан после наблюдения exact tombstone                | Put восстанавливает canonical и physical path                                 | manual-required |
| DEL-009 | P0  | Put commit произошёл между delete commit и physical delete | Delete не уничтожает более новое live-состояние либо put ремонтирует physical | auto: fault                 |
| DEL-010 | P1  | Physical уже отсутствует                                   | Delete action подтверждается без ошибки                                       | manual-required |
| DEL-011 | P0  | Physical fingerprint изменился после staging delete        | Старый action не удаляет новый объект                                         | auto: fault                 |
| DEL-012 | P1  | DELETE вернул async operation                              | Action завершается только после terminal success и проверки 404               | auto: fake-yandex           |
| DEL-013 | P1  | DELETE async operation failed                              | Action остаётся pending                                                       | auto: fake-yandex           |
| DEL-014 | P1  | Оба устройства удаляют один файл                           | Один tombstone, оба действия идемпотентны                                     | manual-required |
| DEL-015 | P0  | Local-файл без baseline попал под exact tombstone          | Перед удалением создаётся backup, поскольку равенство baseline не доказано    | auto: physical-action-rules |

## Удаление папки

| ID       | P   | Действие и состояние потомка                                   | Ожидаемый результат                                        | Проверка                |
| -------- | --- | -------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| FDEL-001 | P1  | Удалена пустая папка                                           | Нет canonical операции                                     | auto: file-watcher      |
| FDEL-002 | P0  | Удалена папка с неизменёнными файлами                          | Один prefix tombstone, потомки удалены                     | manual-required |
| FDEL-003 | P0  | Глубокая папка со многими уровнями                             | Все известные потомки удалены, папки очищены deepest-first | manual-required |
| FDEL-004 | P0  | Потомок изменён конкурентно                                    | Потомок остаётся live                                      | manual-required |
| FDEL-005 | P0  | Потомок создан конкурентно                                     | Потомок остаётся live и восстанавливает ветку              | manual-required |
| FDEL-006 | P0  | Explicit put имеет тот же SHA                                  | Потомок остаётся live                                      | auto: index-rules       |
| FDEL-007 | P0  | Потомок неизвестен удаляющему устройству                       | Merge latest canonical сохраняет causally-new child        | manual-required |
| FDEL-008 | P0  | Child put commit после folder tombstone commit                 | Physical delete не уничтожает принятый put                 | auto: fault             |
| FDEL-009 | P0  | Локальный folder-derived tombstone встречает remote live child | Выполняется download, а не новый exact delete              | auto: conflict-resolver |
| FDEL-010 | P1  | Один из массовых DELETE упал                                   | Остальные завершаются, failed action остаётся pending      | manual-required |
| FDEL-011 | P1  | Crash после batch tombstone commit                             | Все незавершённые child actions воспроизводятся            | auto: fault             |
| FDEL-012 | P2  | Папка содержит тысячи файлов                                   | Concurrency ограничена, canonical commit один              | auto: performance       |
| FDEL-013 | P0  | Два устройства удаляют/редактируют одну ветку                  | Результат не зависит от порядка lock acquisition           | auto: permutation       |
| FDEL-014 | P1  | В папке появился physical orphan                               | Папка не удаляется рекурсивно без live-empty проверки      | auto: fake-yandex       |
| FDEL-015 | P1  | Файл перенесён в папку, переименован, затем папка удалена       | Historical source tombstone не получает physical action; удаляются только текущий live-путь и пустая папка | auto: `plaintext/encrypted rename tombstone is skipped by folder delete` |

## Rename и move

| ID       | P   | Действие                                               | Ожидаемый результат                                                | Проверка          |
| -------- | --- | ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------- |
| MOVE-001 | P1  | Rename файла                                           | Old tombstone и new live фиксируются одной revision                | manual-required |
| MOVE-002 | P1  | Rename глубокой папки                                  | Все logical paths изменяются атомарно                              | manual-required |
| MOVE-003 | P0  | Target уже существует                                  | Target не перезаписывается; создаётся conflict/blocked result      | auto: `different physical target is not overwritten by rename` |
| MOVE-004 | P0  | Concurrent edit old path                               | Правило конфликта применяется до physical move                     | manual-required |
| MOVE-005 | P0  | Concurrent edit new path                               | Target не теряется                                                 | manual-required |
| MOVE-006 | P1  | Crash после logical commit до move                     | Любое устройство завершает move идемпотентно                       | auto: fault       |
| MOVE-007 | P1  | Crash после move до completion commit                  | Source absent + target present завершает action                    | auto: fault       |
| MOVE-008 | P0  | Новый child появился в old subtree после folder rename | Child не перемещается/удаляется как устаревший без causal проверки | auto: fault       |
| MOVE-009 | P1  | Rename из syncable в excluded                          | Old path удаляется remote, target не загружается                   | manual-required |
| MOVE-010 | P1  | Rename из excluded в syncable                          | Target загружается как новый                                       | manual-required |
| MOVE-011 | P1  | Async move failed/timeout                              | Move остаётся pending, оба пути проверяются повторно               | auto: fake-yandex |
| MOVE-012 | P0  | Create → rename до начала upload                       | Загружается только target; source не получает tombstone, move или physical action | auto: `plaintext/encrypted unsynced rename retargets the pending put` |
| MOVE-013 | P0  | Modify существующего файла → rename до upload          | Target содержит новый SHA; старый physical удаляется только после fingerprint guard | auto: `plaintext/encrypted modified source rename materializes target before cleanup` |
| MOVE-014 | P0  | После прерванного move canonical target live, а source/target physical отсутствуют | Target materialize из совпадающего local snapshot, move/action завершаются за один full | auto: `missing move target is materialized and completed` |
| MOVE-015 | P1  | Create A → rename A→B → создать новый A                | Rename и новый put имеют разные ID; canonical сохраняет оба файла | auto: `new file at the old path survives a queued rename`; manual-required |
| MOVE-016 | P1  | Быстрые move A→B→C                                     | Не начатая цепочка coalesce до A→C; начатые шаги завершаются последовательно и идемпотентно | auto: `quick file rename chain coalesces to the final target`; manual-required |
| MOVE-017 | P0  | Create → rename → deep move при занятом coordinator   | Queued цепочка становится одним A→C; submitted upload причинно передаёт accepted revision конечному rename | auto: `plaintext/encrypted durable create rename and deep move materializes only final path`; `plaintext/encrypted running upload hands its committed revision to a deep rename`; manual-required |
| MOVE-018 | P0  | Successor появился до или после snapshot predecessor | До physical/index commit put retarget-ится; после начала commit successor использует подтверждённую revision | auto: `plaintext/encrypted rename after physical upload retargets before canonical commit`; `accepted submitted upload advances its rename before acknowledgement` |
| MOVE-019 | P0  | Rename → delete target до commit                       | Операция становится delete причинного source либо noop для никогда не принятого put | auto: `queued rename followed by delete reduces to source deletion`; integration |
| MOVE-020 | P0  | Full запрошен во время watcher drain                   | Cutoff destructive/rename events settle до full; более новые events остаются durable | auto: `settlement completes before the next session starts`; integration |
| MOVE-021 | P0  | Durable rename, source и target уже отсутствуют после full | Событие становится superseded без remote read/write и удаляется из durable queue | auto: `plaintext/encrypted full supersedes a stale rename after both paths settle` |
| MOVE-022 | P0  | Durable rename, target уже подтверждён local/canonical | Событие подтверждается как `already-applied` без нового commit/upload/move/delete | auto: `full acknowledges an already applied rename target without remote write` |
| MOVE-023 | P0  | Source остаётся causal-live, target отсутствует после full | Событие остаётся durable, full получает `watcher-rename-unresolved` и не продвигает observed revision | auto: `full leaves an ambiguous causal rename durable and reports an error` |
| MOVE-024 | P0  | Rename появляется после начала canonical transaction upload | Upload подтверждается watermark/SHA, successor получает committed revision, old tombstone и final live фиксируются как causal move | auto: `plaintext/encrypted running upload hands its committed revision to a deep rename`; `plaintext/encrypted accepted upload receipt recovers after watcher settlement crash` |

## Несколько устройств

| ID        | P   | Сценарий                                            | Ожидаемый результат                                                           | Проверка            |
| --------- | --- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| MULTI-001 | P1  | Два full запускаются одновременно                   | Index commits сериализованы lock-механизмом                                   | manual-required |
| MULTI-002 | P1  | Full против realtime                                | Ни одно пользовательское событие не теряется                                  | manual-required |
| MULTI-003 | P1  | Realtime против realtime разных путей               | Оба изменения присутствуют в следующей revision                               | manual-required |
| MULTI-004 | P0  | Два edit одного пути                                | Conflict copy, обе версии доступны                                            | manual-required |
| MULTI-005 | P0  | Upload против exact delete                          | Causal delete/restore rules соблюдены                                         | auto: permutation   |
| MULTI-006 | P0  | Folder delete против new child                      | New child остаётся live                                                       | auto: permutation   |
| MULTI-007 | P0  | Rename против delete                                | Не остаётся live canonical без physical и наоборот                            | auto: permutation   |
| MULTI-008 | P0  | Offline device возвращается через много revisions   | Изменения сравниваются с его старым baseline                                  | manual-required |
| MULTI-009 | P0  | Три устройства доставляют операции в разном порядке | Одинаковый causal graph даёт одинаковый итог                                  | auto: permutation   |
| MULTI-010 | P0  | Vault/profile скопирован на второе устройство       | Устройства получают разные installation device IDs                            | manual-required |
| MULTI-011 | P0  | `syncDotObsidian=true`                              | `data.json`, пароль и causal state плагина не синхронизируются как user files | auto: vault-adapter |
| MULTI-012 | P1  | Устройство offline во время Force                   | При возврате принимает последний remote epoch; локальный drift причинно вливается | manual-required |
| MULTI-013 | P0  | Concurrent source edit/delete и target put во время rename-chain | Более новый source не удаляется, независимый target не перезаписывается, merge читает последнюю revision под lock | auto: `source changed after rename base survives as a concurrent file`; permutation |
| MULTI-014 | P0  | Source создан или изменён другим устройством после baseRevision stale rename | Более новый source сохраняется, missing-target rename становится superseded без destructive action | auto: `post-full rename preserves newer sources and blocks causal ambiguity`; two-device |

## Стабильное шифрование

| ID      | P   | Сценарий                              | Ожидаемый результат                                              | Проверка               |
| ------- | --- | ------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| ENC-001 | P0  | Новый девайс вводит правильный пароль | Canonical и файлы читаются, baseline plaintext SHA корректен     | auto + manual-required |
| ENC-002 | P0  | Неверный пароль                       | Sync и любые удаления блокируются                                | manual-required |
| ENC-003 | P1  | Пользователь отменяет пароль          | Watcher/scheduler не запускаются                                 | manual-required |
| ENC-004 | P0  | Обычные create/edit/delete/rename     | Logical результат совпадает с plaintext-вариантом                | auto: parameterized    |
| ENC-005 | P0  | Remote ciphertext fingerprint изменён | Изменение обнаруживается без сравнения plaintext/ciphertext SHA  | manual-required |
| ENC-006 | P0  | Index/lock/manifest                   | Имена service-файлов raw, index content зашифрован, manifest raw | auto: `canonical service path stays raw while its content may be encrypted`; `real encryption service transforms physical paths and content` |
| ENC-007 | P0  | Wrong-key canonical                   | Ошибка расшифровки не интерпретируется как пустой remote         | auto: fault            |
| ENC-008 | P0  | Source/target codec во время transition | Явный codec не использует plaintext fallback                     | auto: `explicit transition codec does not fall back to plaintext` |
| ENC-009 | P0  | Сбой enable/disable/rotate после установки transition codec | Общий executor всегда очищает source/target codec и запускает causal recovery | auto: `transition services are cleared after a failed re-encode`; fault matrix |

## Переходы шифрования

| ID        | P   | Сценарий                                                         | Ожидаемый результат                                                                                            | Проверка                                  |
| --------- | --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TRANS-001 | P0  | Enable после успешного source full                               | Все logical files присутствуют в target                                                                        | manual-required |
| TRANS-002 | P0  | Disable после source full                                        | Все logical files присутствуют plaintext                                                                       | manual-required |
| TRANS-003 | P0  | Rotate после source full                                         | Все logical files доступны новым ключом                                                                        | manual-required |
| TRANS-004 | P0  | Remote-only файл перед transition                                | Он сначала скачивается/разрешается и не удаляется cleanup                                                      | manual-required |
| TRANS-005 | P0  | Source revision изменилась до maintenance claim                  | Preflight повторяется                                                                                          | auto: fault                               |
| TRANS-006 | P0  | Два устройства начинают transition                               | Только один получает ownership                                                                                 | manual-required |
| TRANS-007 | P0  | Обычный sync начался до transition                               | Его index commit блокируется новым maintenance ID                                                              | manual-required |
| TRANS-008 | P1  | Пользователь редактирует во время transition                     | Event durable и воспроизводится в target-режиме                                                                | manual-required |
| TRANS-009 | P0  | Crash в `prepared`                                               | Source остаётся авторитетным                                                                                   | manual-required |
| TRANS-010 | P0  | Crash в `files-copied`                                           | Source rollback или повтор copy без потери данных                                                              | manual-required |
| TRANS-011 | P0  | Crash непосредственно до commit                                  | Recovery определяет source canonical                                                                           | manual-required |
| TRANS-012 | P0  | Crash непосредственно после commit                               | Recovery определяет target canonical, rollback запрещён                                                        | manual-required |
| TRANS-013 | P0  | Crash в cleanup                                                  | Любое target-capable устройство продолжает guarded cleanup                                                     | manual-required |
| TRANS-014 | P0  | Initiator потерян после commit                                   | Второе устройство завершает cleanup из canonical metadata                                                      | manual-required |
| TRANS-015 | P0  | Source и target trees сосуществуют                               | Source tree не появляется в vault как новые файлы                                                              | manual-required |
| TRANS-016 | P0  | Disable cleanup ещё не завершён                                  | Старый ciphertext не скачивается как plaintext user file                                                       | manual-required |
| TRANS-017 | P0  | Fingerprint старого файла изменился                              | Cleanup не удаляет заменённый объект                                                                           | auto: fault                               |
| TRANS-018 | P1  | Cleanup resource уже отсутствует                                 | Action завершается идемпотентно                                                                                | manual-required |
| TRANS-019 | P0  | Manifest и canonical phase расходятся                            | Sync блокируется до deterministic recovery                                                                     | auto: fault                               |
| TRANS-020 | P1  | Старый пароль после rotate                                       | Он не открывает target canonical; новый пароль открывает                                                       | auto + manual-required                    |
| TRANS-021 | P0  | Source и target raw paths сравниваются при nested remote root    | Оба набора представлены путями относительно одного remote root; target не попадает в cleanup                   | manual-required |
| TRANS-022 | P0  | Force local восстанавливает abandoned transition, cleanup падает | Canonical сохраняет cleanup paths/fingerprints; старый tree фильтруется и может быть очищен другим устройством | manual-required |


## Force sync

| ID        | P   | Сценарий                               | Ожидаемый результат                                                     | Проверка              |
| --------- | --- | -------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| FORCE-001 | P0  | Force local, backup успешен            | Remote становится точной local-копией, создаётся новый epoch            | manual-required |
| FORCE-002 | P0  | Force remote, backup успешен           | Local становится точной remote-копией, создаётся новый epoch            | manual-required |
| FORCE-003 | P0  | Backup не создан                       | Force не начинается                                                     | manual-required |
| FORCE-004 | P1  | Legacy canonical                       | Оба направления строят новый v4 с epoch                                 | manual-required |
| FORCE-005 | P1  | Несколько locks                        | Оба направления Force работоспособны; cleanup после commit              | manual-required |
| FORCE-006 | P1  | Canonical отсутствует                  | Force создаёт новый canonical                                           | manual-required |
| FORCE-007 | P0  | Старые pending mutations инициатора    | Они не переходят в новый epoch                                          | auto: operation-store |
| FORCE-008 | P0  | Старый девайс возвращается после Force | Normal full принимает новый epoch, сохраняет локальные изменения и очищает старые causal queues | auto: `a full sync accepts a replacement epoch without Force ping-pong`; two-device |
| FORCE-009 | P0  | Force local encrypted                  | Logical snapshot и новый epoch записываются текущим ключом              | manual-required |
| FORCE-010 | P0  | Force remote encrypted                 | Physical ciphertext читается текущим ключом и перестраивает canonical   | manual-required |
| FORCE-011 | P0  | Force во время active transition       | Разрешён только документированный recovery-flow                         | manual-required |
| FORCE-012 | P1  | Crash до replacement commit            | Старый canonical остаётся авторитетным либо locks блокируют normal sync | auto: fault           |
| FORCE-013 | P1  | Crash после replacement commit         | Новый epoch авторитетен, cleanup повторяем                              | auto: fault           |
| FORCE-014 | P0  | Optional-поля index проходят JSON roundtrip | Отсутствующее поле и `undefined` семантически равны; реальные различия сохраняются | auto: `semantic index comparison uses JSON undefined semantics` |
| FORCE-015 | P0  | Перезапуск после частично завершённого Force | Существующий v4 проходит initial reconciliation без повторной загрузки одинаковых файлов; одиночный читаемый lock восстанавливается | auto: fake-yandex + manual-required |
| FORCE-016 | P0  | Device 1 выполняет Force local, device 2 остаётся на старом epoch | Device 2 выполняет обычный full, принимает remote и больше не требует Force | manual-required |
| FORCE-017 | P0  | После этого device 2 явно выполняет Force remote | Device 1 принимает следующее поколение обычным full; ping-pong требований Force отсутствует | manual-required |
| FORCE-018 | P0  | Local и remote одновременно изменились между epoch | Создаётся одна conflict copy, remote остаётся на исходном пути | auto: `epoch adoption restores a remote deletion and conflicts on two live edits`; two-device |
| FORCE-019 | P0  | Remote delete и local edit между epoch | Локальный edit восстанавливает путь новым put | auto: `epoch adoption restores a remote deletion and conflicts on two live edits` |
| FORCE-020 | P0  | Старый folder delete не знает нового remote-потомка | Неизвестный потомок скачивается и не удаляется | auto: `unknown remote child survives an old device folder deletion` |

## Сеть и Яндекс Диск API

| ID      | P   | Ошибка                                 | Ожидаемый результат                                                       | Проверка                |
| ------- | --- | -------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| NET-001 | P1  | 401/403                                | Операция останавливается без retry и без изменения causal state           | auto: fake-yandex       |
| NET-002 | P1  | 404 после неоднозначного move          | Проверяются source, target и canonical                                    | auto: fake-yandex       |
| NET-003 | P1  | 409/423 lock contention                | Retry с jitter, без overwrite чужого lock                                 | auto: fake-yandex       |
| NET-004 | P1  | 429/503                                | Ограниченный exponential retry с jitter                                   | auto: fake-yandex       |
| NET-005 | P1  | Quota exceeded                         | Mutation/action остаётся durable, пользователь видит причину              | auto: fake-yandex       |
| NET-006 | P1  | Timeout после upload                   | Проверяется physical fingerprint до повтора                               | auto: fake-yandex       |
| NET-007 | P1  | Timeout после canonical move           | Проверяются lock/canonical и fingerprint                                  | auto: fake-yandex       |
| NET-008 | P1  | Async operation status `failed`        | Physical action не подтверждается                                         | auto: fake-yandex       |
| NET-009 | P1  | Async operation timeout                | Состояние проверяется повторным read                                      | auto: fake-yandex       |
| NET-010 | P0  | Root listing меняется между страницами | Snapshot повторяется либо commit блокируется                              | auto: fake-yandex       |
| NET-011 | P1  | 1001+ объектов в root                  | Locks после первой страницы обнаруживаются                                | auto: index-transaction |
| NET-012 | P1  | Fingerprint отсутствует                | Destructive action блокируется или использует подтверждённую альтернативу | auto: fake-yandex       |
| NET-013 | P0  | Сбой после перезаписи захваченного lock | Исходные raw bytes восстанавливаются и проверяются до возврата canonical; неоднозначность не ретраится | auto: index-transaction + fake-yandex |
| NET-014 | P0  | Persisted action содержит SHA-256, MD5, resource ID или modified | Совпадение принимается по любой поддерживаемой server identity, но новый destructive action использует единый strongest fingerprint | auto: `physical fingerprints accept every persisted server identity` |

## Масштаб, платформы и пути

| ID       | P   | Сценарий                            | Ожидаемый результат                                                  | Проверка            |
| -------- | --- | ----------------------------------- | -------------------------------------------------------------------- | ------------------- |
| PERF-001 | P2  | 10 000 live files                   | Ограничены память, API calls и время index commit                    | auto: benchmark     |
| PERF-002 | P2  | 10 000 tombstones                   | Lookup зависит от глубины пути, не от размера history                | auto: benchmark     |
| PERF-003 | P2  | 100 уровней вложенности             | Нет stack overflow и квадратичного folder traversal                  | auto: benchmark     |
| PERF-004 | P2  | 5 000 файлов удаляются одной папкой | Один tombstone commit, bounded delete concurrency                    | auto: benchmark     |
| PERF-005 | P2  | Realtime edit при большом index     | Один index rewrite, без повторного SHA/read файла                    | auto: benchmark     |
| PERF-006 | P2  | Mobile с ограниченной памятью       | Нет одновременного хранения нескольких полных file-content snapshots | manual-required     |
| PERF-007 | P2  | Encrypted no-op startup, 9 local/9 remote | Не более 13 GET, `0/0/0`, без index write и post-full realtime | manual-required; integration |
| PERF-008 | P2  | Remote tree содержит независимые папки и `.backup` | Папки читаются с bounded concurrency, `.backup` не обходится | auto: `remote tree uses bounded folder concurrency and skips backup` |
| PATH-001 | P1  | Unicode и emoji в имени             | Logical/physical mapping обратим                                     | auto: parameterized |
| PATH-002 | P1  | Пробелы, `%`, `#`, `?`, `+`         | API path кодируется один раз                                         | auto: parameterized |
| PATH-003 | P1  | Имена, различающиеся регистром      | Поведение соответствует платформе и не объединяет entries молча      | manual-required     |
| PATH-004 | P1  | Очень длинный путь                  | Ошибка API не повреждает canonical                                   | auto: fake-yandex   |
| PATH-005 | P0  | Имя похоже на service lock          | Пользовательский protected path не перезаписывает служебный файл     | auto: vault-adapter |

## Backup и безопасность

| ID       | P   | Сценарий                             | Ожидаемый результат                                | Проверка            |
| -------- | --- | ------------------------------------ | -------------------------------------------------- | ------------------- |
| SAFE-001 | P0  | Exact delete изменённого local-файла | Backup содержит точные исходные bytes              | manual-required |
| SAFE-002 | P0  | Force local/remote                   | Без успешного backup продолжение невозможно        | auto: UI            |
| SAFE-003 | P0  | Encryption password/device state     | Не попадают в user sync даже при `syncDotObsidian` | auto: vault-adapter |
| SAFE-004 | P0  | Wrong encryption key                 | Не выполняются upload/delete/cleanup               | manual-required |
| SAFE-005 | P1  | Backup создан старым encryption key  | UI явно сообщает способ восстановления до rotate   | manual-required     |
| SAFE-006 | P1  | Cleanup старых overwritten backups   | Не блокирует sync и не удаляет свежие backup       | manual-required |
| SAFE-007 | P0  | `.obsidian` отсутствует в Vault cache | Backup создаётся через DataAdapter в физической plugin-папке | auto: `hidden plugin backup uses DataAdapter and preserves exact bytes` |
| SAFE-008 | P1  | Два backup одного пути подряд        | Создаются два независимых файла с уникальными именами | auto: `hidden plugin backup uses DataAdapter and preserves exact bytes` |
| SAFE-009 | P0  | Write или verification backup упали  | Overwrite/delete/rename блокируются, исходный файл сохраняется | auto: `failed mandatory backup prevents a local overwrite` |

## Диагностика

| ID       | P  | Сценарий                                      | Ожидаемый результат                                                                 | Проверка            |
| -------- | -- | --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| DIAG-001 | P1 | Сбой index transaction на любом durable-шаге | По `sessionId` и `indexTransactionId` видны lock, epoch, revisions и результат retry | manual-required |
| DIAG-002 | P1 | Crash во время encryption transition         | В журнале видны transition ID, kind, последняя сохранённая phase и recovery decision | manual-required |
| DIAG-003 | P1 | `syncDotObsidian=true` и file logging включён | Текущий и legacy debug log не попадают в watcher и пользовательскую синхронизацию    | auto: path-utils    |
| DIAG-004 | P2 | Несколько flush происходят одновременно      | Записи сериализованы, не теряются и журнал остаётся ограниченным по размеру           | auto: logger        |
| DIAG-005 | P0 | Контекст содержит пароль, token или key       | Секреты маскируются до console/file output                                           | auto: logger        |
| DIAG-006 | P1 | Force вернул `success=false`                  | Журнал содержит `completed with errors` и transaction outcome, но не сообщение об успешном завершении | manual-required |
| DIAG-007 | P1 | Ни один index codec не читается               | Лог содержит стадии codec, размер, fingerprint и короткий SHA без index/ciphertext   | auto: index-manager |
| DIAG-008 | P2 | Удаление папки поглощает дочерние watcher events | Лог содержит число live targets, пропущенных historical tombstones и оставшихся physical actions | auto: folder-delete |
| DIAG-009 | P1 | После post-pass остаётся pending move          | Full sync пишет `completed with errors`, сохраняет action и не продвигает observed revision | auto: `unresolved final move recovery records a full-sync error`; manual-required |
| DIAG-010 | P1 | Realtime batch вернул структурированный `retry` | Пишется warning-summary с `completed/superseded/retry`; событие остаётся durable без общего replay error | auto: `structured watcher retry remains durable without throwing` |
| DIAG-011 | P2 | Startup/full завершён без изменений             | Summary содержит GET по manifest/index/root/tree, concurrency и длительность без путей/ciphertext | auto: integration; manual-required |
| DIAG-012 | P1 | Enable, disable и rotate падают на одинаковой фазе | Все три режима проходят один executor, сохраняют одинаковый phase/recovery contract и не оставляют transition codec | auto: `all rewrite modes use the same post-commit cleanup`; fault matrix |
| DIAG-013 | P1 | Rename superseded/rebased ожидаемым локальным событием | Лог содержит event ID, исходный session ID и `rebased`/`already-applied` без повторных error stack | auto: file-watcher; manual-required |
| DIAG-014 | P1 | Startup завершён без canonical maintenance/cleanup | После full не создаётся пустая maintenance/realtime-сессия; summary содержит post-full rename settlement и число новых replay events | auto: full-sync-barrier; manual-required |
| DIAG-015 | P1 | Submitted upload причинно передан rename              | Лог содержит predecessor event ID, mutation sequence, handoff state и accepted revision; rename не маскируется как независимый `put-target` | auto: file-watcher + file-rename; manual-required |

## UI синхронизации

| ID     | P  | Сценарий | Ожидаемый результат | Проверка |
| ------ | -- | -------- | -------------------- | -------- |
| UI-001 | P1 | Пользователь запускает manual full | Один persistent Notice появляется до watcher drain, обновляется тем же экземпляром по фазам и через 5 секунд скрывается после успеха | auto: `full UI activity starts before watcher preparation`; integration; manual-required |
| UI-002 | P0 | Manual full ожидает медленную realtime rename-цепочку | Внешняя full-сессия сохраняет UI ownership: сначала видны подготовка и ожидание; внутренняя realtime-сессия не закрывает и не подменяет Notice | manual-required |
| UI-003 | P1 | No-op full | Видны подготовка, scan, анализ и завершение без `0%`; итог сообщает об отсутствии изменений, canonical не записывается | auto: full-sync-barrier + sync-ui; manual-required |
| UI-004 | P1 | Standalone realtime batch | Status bar показывает realtime и монотонный `N/M` по durable events; progress Notice не создаётся | manual-required |
| UI-005 | P1 | Startup либо scheduler full | Все реальные фазы видны в status bar, progress Notice не создаётся; блокировка создаёт один persistent Notice | manual-required |
| UI-006 | P0 | Force local/remote с обязательным backup | Один Notice живёт от подтверждённого backup через Force и restart watcher/scheduler до финального успеха либо ошибки | manual-required |
| UI-007 | P0 | Enable, disable или rotate encryption | Один Notice отражает maintenance/re-encode/commit/cleanup; вложенная операция не вытесняет внешнюю maintenance-сессию | manual-required |
| UI-008 | P0 | Auth, legacy, wrong password или ambiguous lock блокируют sync | Нет ложного success; пользователь получает один дедуплицированный persistent Notice, watcher/scheduler остановлены | manual-required |
| UI-009 | P1 | Экран настроек открыт без токена либо с 401/403 | Backup API не вызывается при пустом токене; показывается «Статус резервных копий недоступен» без ERROR-spam | unit; manual-required |

## Причинные операции над папками и migration v4

| ID        | P  | Сценарий | Ожидаемый результат | Проверка |
| --------- | -- | -------- | -------------------- | -------- |
| MOVE-025  | P0 | Быстрый folder move с механическими child rename | Child events поглощаются parent mutation; только конечные paths live | manual-required |
| MOVE-026  | P0 | Folder chain `A → B → C` до remote work | Один logical move `A → C`, не создаются intermediate live paths | auto: `queued folder rename chains reduce to one final target`; integration |
| MOVE-027  | P0 | User child rename отличается от механического target | Событие rebased относительно target folder и выполняется после parent receipt | auto: `user child rename is rebased relative to the folder target`; integration |
| MOVE-028  | P0 | Crash после logical folder commit и части file moves | Parent move остаётся durable; restart завершает pairs и один completion commit | manual-required |
| FDEL-016  | P0 | Folder delete после собственных revisions при старом observedRevision | Потомки с меньшим same-device sequence удаляются; foreign/newer сохраняются | manual-required |
| MULTI-016 | P0 | Другой device меняет child во время folder move/delete | Foreign child и отличающийся target не удаляются и не перезаписываются | manual-required |
| SYNC-029  | P0 | Full запускается при unresolved parent move/action | Full останавливается до local/remote scan, не создаёт compensating operations | manual-required |
| MIG-004   | P0 | Переход beta.1.1 index v3 на beta.2 index v4 | Один Force local с backup создаёт v4; остальные devices принимают epoch обычной full | manual-required |
| DIAG-016  | P1 | Folder reducer и recovery | Лог содержит parent event/mutation, sequence, absorbed/rebased, survivor/conflict/unresolved counts без expected coalescing ERROR | manual-required |
| MOVE-029  | P0 | Одновременно ожидают unrelated и nested folder moves, затем приходит child rename | Выбирается только содержащий child source и самый глубокий causal parent; unrelated move не влияет | auto: `child rename selects the deepest matching folder parent` |
| MOVE-030  | P0 | Folder move встречает существующий target с другим SHA | Ноль canonical/physical writes; source и local target сохраняются; event остаётся durable с `folder-target-conflict` | auto: `folder target conflict performs no canonical or physical writes` |
| FDEL-017  | P0 | Предрелизная v4 file entry не содержит `mutationSeq` | Destructive folder operation разрешена только при exact baseline и достаточной base revision | auto: `unsequenced prerelease v4 child requires an exact observed baseline` |
| SYNC-030  | P0 | Full обнаруживает новое локальное удаление файла | До tombstone сохраняется FIFO mutation; canonical получает sequence и watermark; existing foreign tombstone сохраняет attribution | auto: `full-discovered logical delete receives and confirms a FIFO sequence`; `applying a canonical tombstone preserves foreign causal attribution` |
| INDEX-001 | P0 | JSON декодирован, но current v4 имеет неверную структуру | Возвращается semantic invalid-index; codec fallback и remote mutation не выполняются; Force остаётся доступным после backup | auto: `malformed current v4 is rejected as a semantic index error` |
| PERF-008  | P1 | Folder move/delete на 10 000 descendants | Планирование использует Set/Map, targeted API calls линейны, concurrency ≤ 4, index commits ≤ 2 | auto: `folder delete target planning handles ten thousand descendants`; move/API/commit manual-required |

## Матрица вариантов

Каждый новый алгоритм проверяется минимум pairwise-набором по следующим осям.
Для `P0`-сценариев обязательны все применимые сочетания режима и порядка
операций.

| Ось        | Значения                                                                       |
| ---------- | ------------------------------------------------------------------------------ |
| Устройства | 1, 2 одновременно online, 2 с одним offline, 3 с разным порядком               |
| Режим      | plaintext, encrypted stable, enable, disable, rotate, cleanup                  |
| Запуск     | initial, startup full, manual full, scheduler, realtime, Force                 |
| Объект     | file, empty folder, folder with files, deep folder, rename/move                |
| Baseline   | отсутствует, актуален, устарел, другой epoch                                   |
| Сеть       | stable, offline, timeout before response, timeout after commit, throttling     |
| Сбой       | до durable intent, после intent, после canonical commit, после physical action |
| Контент    | одинаковый SHA, разный SHA, same-SHA explicit put, binary, большой файл        |
| Путь       | корневой, глубокий, Unicode, special chars, excluded/config path               |

## Правило выпуска

Release блокируется, пока каждый `P0` и `P1` сценарий не имеет выполняемого
автоматического теста либо датированного результата `manual-required`. Новая
ошибка сначала добавляется сюда как сценарий, затем воспроизводится тестом и
только после этого исправляется.

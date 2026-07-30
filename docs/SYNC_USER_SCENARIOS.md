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
| INV-009 | Force создаёт новый epoch; старые устройства не воспроизводят операции предыдущего epoch автоматически. |
| INV-010 | Local `observedRevision` изменяется только после полностью применённого canonical-состояния.            |
| INV-011 | Клиентские часы разных устройств не участвуют в выборе победителя.                                      |
| INV-012 | Service-файлы, lock и данные самого плагина не попадают в пользовательскую синхронизацию.               |
| INV-013 | До encryption commit авторитетен source-режим, после commit rollback запрещён.                          |
| INV-014 | Во время encryption cleanup старый physical-набор не виден как пользовательские файлы.                  |
| INV-015 | Неоднозначное состояние блокируется, а не разрешается выбором случайного index или lock.                |

## Первичная синхронизация и запуск

| ID       | P   | Исходное состояние и действие                          | Ожидаемый результат                                               | Проверка                |
| -------- | --- | ------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------- |
| INIT-001 | P1  | Local и remote пусты, canonical отсутствует            | Создаётся пустой canonical и локальный baseline текущего epoch    | auto: integration       |
| INIT-002 | P1  | Только local-файлы                                     | Все файлы загружены, canonical содержит live entries              | auto: integration       |
| INIT-003 | P1  | Только remote-файлы                                    | Все файлы скачаны, baseline содержит server fingerprints          | auto: integration       |
| INIT-004 | P1  | Одинаковый файл есть с обеих сторон                    | `none`, без повторной загрузки, baseline сохранён                 | auto: integration       |
| INIT-005 | P0  | Разные файлы одного пути без local baseline            | Создаётся conflict copy; ни одна версия не теряется               | auto: integration       |
| INIT-006 | P0  | Новый local-файл находится под старым folder tombstone | Local-файл считается новым и восстанавливает путь                 | auto: conflict-resolver |
| INIT-007 | P1  | Remote physical существует, canonical отсутствует      | Canonical строится из фактического remote/local merge             | auto: integration       |
| INIT-008 | P1  | Canonical отсутствует, существует один активный lock   | Sync ждёт владельца; до stale-time lock не забирается             | auto: fault             |
| INIT-009 | P1  | Canonical отсутствует, один неизменный stale lock      | Lock восстанавливается после двух стабильных наблюдений           | auto: fault             |
| INIT-010 | P0  | Несколько locks                                        | Normal sync блокируется; ни один lock не удаляется                | auto: integration       |
| INIT-011 | P1  | Canonical v1/v2                                        | Normal sync блокируется с инструкцией Force                       | auto: integration       |
| INIT-012 | P1  | Предрелизный v3 без epoch                              | Normal sync блокируется как legacy prerelease state               | auto: integration       |
| INIT-013 | P1  | Новый девайс, canonical current epoch                  | Выполняется initial merge; epoch принимается после reconciliation | auto: integration       |
| INIT-014 | P0  | Старый девайс с другим непустым epoch                  | Normal sync блокируется; предлагается Force remote                | auto: integration       |
| INIT-015 | P1  | Первый запуск прерван после remote scan                | Следующий запуск повторяет merge без потери состояния             | auto: fault             |
| INIT-016 | P2  | В remote только пустые папки                           | Папки не скачиваются и не попадают в canonical                    | auto: integration       |
| INIT-017 | P1  | Token отсутствует или недействителен                   | Ни watcher, ни scheduler не изменяют remote                       | auto: integration       |
| INIT-018 | P1  | Сеть недоступна при определении initial state          | Initial sync не подменяет remote пустым состоянием                | auto: fault             |
| INIT-019 | P0  | Encrypted canonical v1/v2 с правильным ключом          | Ошибка версии не маскируется codec fallback; показывается Force-инструкция | auto: `encrypted legacy startup preserves LegacyIndexVersionError` |
| INIT-020 | P0  | Canonical не читается разрешёнными codec               | Startup блокируется без watcher, scheduler и remote mutation      | auto: `wrong encrypted index key is classified as unreadable` |

## Обычный full и realtime

| ID       | P   | Действие                                         | Ожидаемый результат                                             | Проверка                |
| -------- | --- | ------------------------------------------------ | --------------------------------------------------------------- | ----------------------- |
| SYNC-001 | P2  | Full без изменений                               | Нет physical операций и лишнего canonical commit                | auto: integration       |
| SYNC-002 | P1  | Новый local-файл                                 | Один upload и один batch index commit                           | auto: integration       |
| SYNC-003 | P1  | Новый remote-файл                                | Один download и сохранение baseline                             | auto: integration       |
| SYNC-004 | P1  | Local edit                                       | SHA отличается от baseline, выполняется upload                  | auto: integration       |
| SYNC-005 | P1  | Remote edit                                      | Fingerprint/mtime отличается от baseline, выполняется download  | auto: integration       |
| SYNC-006 | P0  | Local и remote изменены независимо               | Создаётся conflict copy, сохраняются обе версии                 | auto: two-device        |
| SYNC-007 | P1  | Remote fingerprint изменился при том же mtime    | Изменение считается remote edit                                 | auto: conflict-resolver |
| SYNC-008 | P1  | Fingerprint отсутствует, server mtime изменился  | Изменение считается remote edit без tolerance window            | auto: conflict-resolver |
| SYNC-009 | P0  | Разные клиентские часы                           | Результат совпадает с вариантом без clock skew                  | auto: two-device        |
| SYNC-010 | P1  | Physical отсутствует при live canonical          | Файл восстанавливается с authoritative live-копии               | auto: integration       |
| SYNC-011 | P1  | Physical существует без canonical entry          | Объект проходит безопасный initial/orphan merge                 | auto: integration       |
| SYNC-012 | P1  | Obsidian закрыт до realtime debounce             | Следующий startup full обнаруживает изменение                   | auto: fault             |
| SYNC-013 | P1  | Obsidian закрыт после durable mutation до upload | Mutation или filesystem state воспроизводится идемпотентно      | auto: fault             |
| SYNC-014 | P1  | Edit во время full sync                          | Событие сохраняется и воспроизводится после сессии              | auto: integration       |
| SYNC-015 | P1  | Create→modify в одном debounce                   | Загружается последний snapshot                                  | auto: file-watcher      |
| SYNC-016 | P1  | Create→delete до flush                           | Не создаётся потерянный live entry                              | auto: file-watcher      |
| SYNC-017 | P1  | Delete→create до flush                           | Итоговое состояние live                                         | auto: file-watcher      |
| SYNC-018 | P1  | Engine записывает/удаляет локальный файл         | Watcher не создаёт обратную пользовательскую операцию           | auto: integration       |
| SYNC-019 | P1  | Engine event приходит с большой задержкой        | Он подавляется по durable expectation, не по TTL                | auto: fault             |
| SYNC-020 | P2  | Несколько scheduler/manual full одновременно     | Выполняется один coalesced full run                             | auto: coordinator       |
| SYNC-021 | P2  | Realtime batch из нескольких файлов              | Контент читается и хешируется по одному разу, index commit один | auto: integration       |

## Удаление файла

| ID      | P   | Действие и порядок                                         | Ожидаемый результат                                                           | Проверка                    |
| ------- | --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| DEL-001 | P0  | Local exact delete                                         | Tombstone commit предшествует physical delete                                 | auto: integration           |
| DEL-002 | P0  | Remote exact delete                                        | Изменённый local-файл сохраняется в backup и удаляется                        | auto: integration           |
| DEL-003 | P0  | Backup изменённого файла не создался                       | Tombstone остаётся, physical local delete не выполняется                      | auto: fault                 |
| DEL-004 | P1  | Crash до tombstone commit                                  | Local deletion остаётся pending и повторяется                                 | auto: fault                 |
| DEL-005 | P0  | Crash после tombstone до physical delete                   | Следующий запуск продолжает delete, не восстанавливает файл                   | auto: fault                 |
| DEL-006 | P1  | Crash после physical delete до action confirmation         | Отсутствие файла идемпотентно завершает action                                | auto: fault                 |
| DEL-007 | P0  | Edit конкурентен exact delete и имеет старый base          | Delete побеждает, edit сохраняется в backup                                   | auto: two-device            |
| DEL-008 | P0  | Put создан после наблюдения exact tombstone                | Put восстанавливает canonical и physical path                                 | auto: two-device            |
| DEL-009 | P0  | Put commit произошёл между delete commit и physical delete | Delete не уничтожает более новое live-состояние либо put ремонтирует physical | auto: fault                 |
| DEL-010 | P1  | Physical уже отсутствует                                   | Delete action подтверждается без ошибки                                       | auto: integration           |
| DEL-011 | P0  | Physical fingerprint изменился после staging delete        | Старый action не удаляет новый объект                                         | auto: fault                 |
| DEL-012 | P1  | DELETE вернул async operation                              | Action завершается только после terminal success и проверки 404               | auto: fake-yandex           |
| DEL-013 | P1  | DELETE async operation failed                              | Action остаётся pending                                                       | auto: fake-yandex           |
| DEL-014 | P1  | Оба устройства удаляют один файл                           | Один tombstone, оба действия идемпотентны                                     | auto: two-device            |
| DEL-015 | P0  | Local-файл без baseline попал под exact tombstone          | Перед удалением создаётся backup, поскольку равенство baseline не доказано    | auto: physical-action-rules |

## Удаление папки

| ID       | P   | Действие и состояние потомка                                   | Ожидаемый результат                                        | Проверка                |
| -------- | --- | -------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| FDEL-001 | P1  | Удалена пустая папка                                           | Нет canonical операции                                     | auto: file-watcher      |
| FDEL-002 | P0  | Удалена папка с неизменёнными файлами                          | Один prefix tombstone, потомки удалены                     | auto: integration       |
| FDEL-003 | P0  | Глубокая папка со многими уровнями                             | Все известные потомки удалены, папки очищены deepest-first | auto: integration       |
| FDEL-004 | P0  | Потомок изменён конкурентно                                    | Потомок остаётся live                                      | auto: two-device        |
| FDEL-005 | P0  | Потомок создан конкурентно                                     | Потомок остаётся live и восстанавливает ветку              | auto: two-device        |
| FDEL-006 | P0  | Explicit put имеет тот же SHA                                  | Потомок остаётся live                                      | auto: index-rules       |
| FDEL-007 | P0  | Потомок неизвестен удаляющему устройству                       | Merge latest canonical сохраняет causally-new child        | auto: two-device        |
| FDEL-008 | P0  | Child put commit после folder tombstone commit                 | Physical delete не уничтожает принятый put                 | auto: fault             |
| FDEL-009 | P0  | Локальный folder-derived tombstone встречает remote live child | Выполняется download, а не новый exact delete              | auto: conflict-resolver |
| FDEL-010 | P1  | Один из массовых DELETE упал                                   | Остальные завершаются, failed action остаётся pending      | auto: integration       |
| FDEL-011 | P1  | Crash после batch tombstone commit                             | Все незавершённые child actions воспроизводятся            | auto: fault             |
| FDEL-012 | P2  | Папка содержит тысячи файлов                                   | Concurrency ограничена, canonical commit один              | auto: performance       |
| FDEL-013 | P0  | Два устройства удаляют/редактируют одну ветку                  | Результат не зависит от порядка lock acquisition           | auto: permutation       |
| FDEL-014 | P1  | В папке появился physical orphan                               | Папка не удаляется рекурсивно без live-empty проверки      | auto: fake-yandex       |
| FDEL-015 | P1  | Файл перенесён в папку, переименован, затем папка удалена       | Historical source tombstone не получает physical action; удаляются только текущий live-путь и пустая папка | auto: `plaintext/encrypted rename tombstone is skipped by folder delete` |

## Rename и move

| ID       | P   | Действие                                               | Ожидаемый результат                                                | Проверка          |
| -------- | --- | ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------- |
| MOVE-001 | P1  | Rename файла                                           | Old tombstone и new live фиксируются одной revision                | auto: integration |
| MOVE-002 | P1  | Rename глубокой папки                                  | Все logical paths изменяются атомарно                              | auto: integration |
| MOVE-003 | P0  | Target уже существует                                  | Target не перезаписывается; создаётся conflict/blocked result      | auto: `different physical target is not overwritten by rename` |
| MOVE-004 | P0  | Concurrent edit old path                               | Правило конфликта применяется до physical move                     | auto: two-device  |
| MOVE-005 | P0  | Concurrent edit new path                               | Target не теряется                                                 | auto: two-device  |
| MOVE-006 | P1  | Crash после logical commit до move                     | Любое устройство завершает move идемпотентно                       | auto: fault       |
| MOVE-007 | P1  | Crash после move до completion commit                  | Source absent + target present завершает action                    | auto: fault       |
| MOVE-008 | P0  | Новый child появился в old subtree после folder rename | Child не перемещается/удаляется как устаревший без causal проверки | auto: fault       |
| MOVE-009 | P1  | Rename из syncable в excluded                          | Old path удаляется remote, target не загружается                   | auto: integration |
| MOVE-010 | P1  | Rename из excluded в syncable                          | Target загружается как новый                                       | auto: integration |
| MOVE-011 | P1  | Async move failed/timeout                              | Move остаётся pending, оба пути проверяются повторно               | auto: fake-yandex |
| MOVE-012 | P0  | Create → rename до начала upload                       | Загружается только target; source не получает tombstone, move или physical action | auto: `plaintext/encrypted unsynced rename retargets the pending put` |
| MOVE-013 | P0  | Modify существующего файла → rename до upload          | Target содержит новый SHA; старый physical удаляется только после fingerprint guard | auto: `plaintext/encrypted modified source rename materializes target before cleanup` |
| MOVE-014 | P0  | Beta.4: canonical target live, source/target physical отсутствуют | Target materialize из совпадающего local snapshot, move/action завершаются за один full | auto: `beta.4 missing move target is materialized and completed` |
| MOVE-015 | P1  | Create A → rename A→B → создать новый A                | Rename и новый put имеют разные ID; canonical сохраняет оба файла | auto: `new file at the old path survives a queued rename`; manual-required |
| MOVE-016 | P1  | Быстрые move A→B→C                                     | Не начатая цепочка coalesce до A→C; начатые шаги завершаются последовательно и идемпотентно | auto: `quick file rename chain coalesces to the final target`; manual-required |

## Несколько устройств

| ID        | P   | Сценарий                                            | Ожидаемый результат                                                           | Проверка            |
| --------- | --- | --------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| MULTI-001 | P1  | Два full запускаются одновременно                   | Index commits сериализованы lock-механизмом                                   | auto: two-device    |
| MULTI-002 | P1  | Full против realtime                                | Ни одно пользовательское событие не теряется                                  | auto: two-device    |
| MULTI-003 | P1  | Realtime против realtime разных путей               | Оба изменения присутствуют в следующей revision                               | auto: two-device    |
| MULTI-004 | P0  | Два edit одного пути                                | Conflict copy, обе версии доступны                                            | auto: two-device    |
| MULTI-005 | P0  | Upload против exact delete                          | Causal delete/restore rules соблюдены                                         | auto: permutation   |
| MULTI-006 | P0  | Folder delete против new child                      | New child остаётся live                                                       | auto: permutation   |
| MULTI-007 | P0  | Rename против delete                                | Не остаётся live canonical без physical и наоборот                            | auto: permutation   |
| MULTI-008 | P0  | Offline device возвращается через много revisions   | Изменения сравниваются с его старым baseline                                  | auto: two-device    |
| MULTI-009 | P0  | Три устройства доставляют операции в разном порядке | Одинаковый causal graph даёт одинаковый итог                                  | auto: permutation   |
| MULTI-010 | P0  | Vault/profile скопирован на второе устройство       | Устройства получают разные installation device IDs                            | auto: integration   |
| MULTI-011 | P0  | `syncDotObsidian=true`                              | `data.json`, пароль и causal state плагина не синхронизируются как user files | auto: vault-adapter |
| MULTI-012 | P1  | Устройство offline во время Force                   | При возврате old epoch блокируется                                            | auto: two-device    |

## Стабильное шифрование

| ID      | P   | Сценарий                              | Ожидаемый результат                                              | Проверка               |
| ------- | --- | ------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| ENC-001 | P0  | Новый девайс вводит правильный пароль | Canonical и файлы читаются, baseline plaintext SHA корректен     | auto + manual-required |
| ENC-002 | P0  | Неверный пароль                       | Sync и любые удаления блокируются                                | auto: integration      |
| ENC-003 | P1  | Пользователь отменяет пароль          | Watcher/scheduler не запускаются                                 | auto: integration      |
| ENC-004 | P0  | Обычные create/edit/delete/rename     | Logical результат совпадает с plaintext-вариантом                | auto: parameterized    |
| ENC-005 | P0  | Remote ciphertext fingerprint изменён | Изменение обнаруживается без сравнения plaintext/ciphertext SHA  | auto: integration      |
| ENC-006 | P0  | Index/lock/manifest                   | Имена service-файлов raw, index content зашифрован, manifest raw | auto: integration      |
| ENC-007 | P0  | Wrong-key canonical                   | Ошибка расшифровки не интерпретируется как пустой remote         | auto: fault            |
| ENC-008 | P0  | Source/target codec во время transition | Явный codec не использует plaintext fallback                     | auto: `explicit transition codec does not fall back to plaintext` |

## Переходы шифрования

| ID        | P   | Сценарий                                                         | Ожидаемый результат                                                                                            | Проверка                                  |
| --------- | --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TRANS-001 | P0  | Enable после успешного source full                               | Все logical files присутствуют в target                                                                        | auto: encryption integration              |
| TRANS-002 | P0  | Disable после source full                                        | Все logical files присутствуют plaintext                                                                       | auto: encryption integration              |
| TRANS-003 | P0  | Rotate после source full                                         | Все logical files доступны новым ключом                                                                        | auto: encryption integration              |
| TRANS-004 | P0  | Remote-only файл перед transition                                | Он сначала скачивается/разрешается и не удаляется cleanup                                                      | auto: two-device                          |
| TRANS-005 | P0  | Source revision изменилась до maintenance claim                  | Preflight повторяется                                                                                          | auto: fault                               |
| TRANS-006 | P0  | Два устройства начинают transition                               | Только один получает ownership                                                                                 | auto: two-device                          |
| TRANS-007 | P0  | Обычный sync начался до transition                               | Его index commit блокируется новым maintenance ID                                                              | auto: two-device                          |
| TRANS-008 | P1  | Пользователь редактирует во время transition                     | Event durable и воспроизводится в target-режиме                                                                | auto: integration                         |
| TRANS-009 | P0  | Crash в `prepared`                                               | Source остаётся авторитетным                                                                                   | auto: fault matrix                        |
| TRANS-010 | P0  | Crash в `files-copied`                                           | Source rollback или повтор copy без потери данных                                                              | auto: fault matrix                        |
| TRANS-011 | P0  | Crash непосредственно до commit                                  | Recovery определяет source canonical                                                                           | auto: fault matrix                        |
| TRANS-012 | P0  | Crash непосредственно после commit                               | Recovery определяет target canonical, rollback запрещён                                                        | auto: fault matrix                        |
| TRANS-013 | P0  | Crash в cleanup                                                  | Любое target-capable устройство продолжает guarded cleanup                                                     | auto: fault matrix                        |
| TRANS-014 | P0  | Initiator потерян после commit                                   | Второе устройство завершает cleanup из canonical metadata                                                      | auto: two-device                          |
| TRANS-015 | P0  | Source и target trees сосуществуют                               | Source tree не появляется в vault как новые файлы                                                              | auto: encryption integration              |
| TRANS-016 | P0  | Disable cleanup ещё не завершён                                  | Старый ciphertext не скачивается как plaintext user file                                                       | auto: encryption integration              |
| TRANS-017 | P0  | Fingerprint старого файла изменился                              | Cleanup не удаляет заменённый объект                                                                           | auto: fault                               |
| TRANS-018 | P1  | Cleanup resource уже отсутствует                                 | Action завершается идемпотентно                                                                                | auto: integration                         |
| TRANS-019 | P0  | Manifest и canonical phase расходятся                            | Sync блокируется до deterministic recovery                                                                     | auto: fault                               |
| TRANS-020 | P1  | Старый пароль после rotate                                       | Он не открывает target canonical; новый пароль открывает                                                       | auto + manual-required                    |
| TRANS-021 | P0  | Source и target raw paths сравниваются при nested remote root    | Оба набора представлены путями относительно одного remote root; target не попадает в cleanup                   | auto: path-utils + encryption integration |
| TRANS-022 | P0  | Force local восстанавливает abandoned transition, cleanup падает | Canonical сохраняет cleanup paths/fingerprints; старый tree фильтруется и может быть очищен другим устройством | auto: fault matrix                        |

## Force sync

| ID        | P   | Сценарий                               | Ожидаемый результат                                                     | Проверка              |
| --------- | --- | -------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| FORCE-001 | P0  | Force local, backup успешен            | Remote становится точной local-копией, создаётся новый epoch            | auto: integration     |
| FORCE-002 | P0  | Force remote, backup успешен           | Local становится точной remote-копией, создаётся новый epoch            | auto: integration     |
| FORCE-003 | P0  | Backup не создан                       | Force не начинается                                                     | auto: UI/integration  |
| FORCE-004 | P1  | Legacy canonical                       | Оба направления строят новый v3 с epoch                                 | auto: integration     |
| FORCE-005 | P1  | Несколько locks                        | Оба направления Force работоспособны; cleanup после commit              | auto: integration     |
| FORCE-006 | P1  | Canonical отсутствует                  | Force создаёт новый canonical                                           | auto: integration     |
| FORCE-007 | P0  | Старые pending mutations инициатора    | Они не переходят в новый epoch                                          | auto: operation-store |
| FORCE-008 | P0  | Старый девайс возвращается после Force | Normal sync блокируется по epoch mismatch                               | auto: two-device      |
| FORCE-009 | P0  | Force local encrypted                  | Logical snapshot и новый epoch записываются текущим ключом              | auto: integration     |
| FORCE-010 | P0  | Force remote encrypted                 | Physical ciphertext читается текущим ключом и перестраивает canonical   | auto: integration     |
| FORCE-011 | P0  | Force во время active transition       | Разрешён только документированный recovery-flow                         | auto: integration     |
| FORCE-012 | P1  | Crash до replacement commit            | Старый canonical остаётся авторитетным либо locks блокируют normal sync | auto: fault           |
| FORCE-013 | P1  | Crash после replacement commit         | Новый epoch авторитетен, cleanup повторяем                              | auto: fault           |
| FORCE-014 | P0  | Optional-поля index проходят JSON roundtrip | Отсутствующее поле и `undefined` семантически равны; реальные различия сохраняются | auto: `semantic index comparison uses JSON undefined semantics` |
| FORCE-015 | P0  | Запуск после beta.1 partial Force      | Существующий v3 проходит initial reconciliation без повторной загрузки одинаковых файлов; одиночный читаемый lock восстанавливается | auto: fake-yandex + manual-required |

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

## Масштаб, платформы и пути

| ID       | P   | Сценарий                            | Ожидаемый результат                                                  | Проверка            |
| -------- | --- | ----------------------------------- | -------------------------------------------------------------------- | ------------------- |
| PERF-001 | P2  | 10 000 live files                   | Ограничены память, API calls и время index commit                    | auto: benchmark     |
| PERF-002 | P2  | 10 000 tombstones                   | Lookup зависит от глубины пути, не от размера history                | auto: benchmark     |
| PERF-003 | P2  | 100 уровней вложенности             | Нет stack overflow и квадратичного folder traversal                  | auto: benchmark     |
| PERF-004 | P2  | 5 000 файлов удаляются одной папкой | Один tombstone commit, bounded delete concurrency                    | auto: benchmark     |
| PERF-005 | P2  | Realtime edit при большом index     | Один index rewrite, без повторного SHA/read файла                    | auto: benchmark     |
| PERF-006 | P2  | Mobile с ограниченной памятью       | Нет одновременного хранения нескольких полных file-content snapshots | manual-required     |
| PATH-001 | P1  | Unicode и emoji в имени             | Logical/physical mapping обратим                                     | auto: parameterized |
| PATH-002 | P1  | Пробелы, `%`, `#`, `?`, `+`         | API path кодируется один раз                                         | auto: parameterized |
| PATH-003 | P1  | Имена, различающиеся регистром      | Поведение соответствует платформе и не объединяет entries молча      | manual-required     |
| PATH-004 | P1  | Очень длинный путь                  | Ошибка API не повреждает canonical                                   | auto: fake-yandex   |
| PATH-005 | P0  | Имя похоже на service lock          | Пользовательский protected path не перезаписывает служебный файл     | auto: vault-adapter |

## Backup и безопасность

| ID       | P   | Сценарий                             | Ожидаемый результат                                | Проверка            |
| -------- | --- | ------------------------------------ | -------------------------------------------------- | ------------------- |
| SAFE-001 | P0  | Exact delete изменённого local-файла | Backup содержит точные исходные bytes              | auto: integration   |
| SAFE-002 | P0  | Force local/remote                   | Без успешного backup продолжение невозможно        | auto: UI            |
| SAFE-003 | P0  | Encryption password/device state     | Не попадают в user sync даже при `syncDotObsidian` | auto: vault-adapter |
| SAFE-004 | P0  | Wrong encryption key                 | Не выполняются upload/delete/cleanup               | auto: integration   |
| SAFE-005 | P1  | Backup создан старым encryption key  | UI явно сообщает способ восстановления до rotate   | manual-required     |
| SAFE-006 | P1  | Cleanup старых overwritten backups   | Не блокирует sync и не удаляет свежие backup       | auto: integration   |
| SAFE-007 | P0  | `.obsidian` отсутствует в Vault cache | Backup создаётся через DataAdapter в физической plugin-папке | auto: `hidden plugin backup uses DataAdapter and preserves exact bytes` |
| SAFE-008 | P1  | Два backup одного пути подряд        | Создаются два независимых файла с уникальными именами | auto: `hidden plugin backup uses DataAdapter and preserves exact bytes` |
| SAFE-009 | P0  | Write или verification backup упали  | Overwrite/delete/rename блокируются, исходный файл сохраняется | auto: `failed mandatory backup prevents a local overwrite` |

## Диагностика

| ID       | P  | Сценарий                                      | Ожидаемый результат                                                                 | Проверка            |
| -------- | -- | --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| DIAG-001 | P1 | Сбой index transaction на любом durable-шаге | По `sessionId` и `indexTransactionId` видны lock, epoch, revisions и результат retry | auto: integration   |
| DIAG-002 | P1 | Crash во время encryption transition         | В журнале видны transition ID, kind, последняя сохранённая phase и recovery decision | auto: fault matrix  |
| DIAG-003 | P1 | `syncDotObsidian=true` и file logging включён | Текущий и legacy debug log не попадают в watcher и пользовательскую синхронизацию    | auto: path-utils    |
| DIAG-004 | P2 | Несколько flush происходят одновременно      | Записи сериализованы, не теряются и журнал остаётся ограниченным по размеру           | auto: logger        |
| DIAG-005 | P0 | Контекст содержит пароль, token или key       | Секреты маскируются до console/file output                                           | auto: logger        |
| DIAG-006 | P1 | Force вернул `success=false`                  | Журнал содержит `completed with errors` и transaction outcome, но не сообщение об успешном завершении | auto: integration |
| DIAG-007 | P1 | Ни один index codec не читается               | Лог содержит стадии codec, размер, fingerprint и короткий SHA без index/ciphertext   | auto: index-manager |
| DIAG-008 | P2 | Удаление папки поглощает дочерние watcher events | Лог содержит число live targets, пропущенных historical tombstones и оставшихся physical actions | auto: folder-delete |
| DIAG-009 | P1 | После post-pass остаётся pending move          | Full sync пишет `completed with errors`, сохраняет action и не продвигает observed revision | auto: `unresolved final move recovery records a full-sync error`; manual-required |

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

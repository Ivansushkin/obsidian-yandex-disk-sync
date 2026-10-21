# Release smoke tests

Практический release smoke для проверки наиболее опасных регрессий: возврата
удалённых файлов, быстрых rename/move, folder delete, multi-device, Force-loop
и шифрования. Полный последовательный прогон занимает примерно 45–60 минут;
TC-01–TC-07 без расширенного шифрования — около 25 минут.

Массовая генерация юнитов для этого списка запрещена. Компактная автоматика
проверяет сложные алгоритмы по [AGENTS.md](../AGENTS.md#documentation-and-testing),
а UI и пользовательский результат проверяются здесь на реальном приложении.
Зелёный `npm test` не является свидетельством прохождения smoke. Пока прогон
не выполнен, ручные сценарии остаются непроверенными.

## Допущения

Перед прогоном:

- `npm test`, lint и build уже зелёные.
- На обоих устройствах установлена одна и та же `2.0.0`.
- Используются два независимых профиля Obsidian с разными device ID.
- Используется реальный Яндекс Диск.
- Тестовое remote-хранилище можно безопасно очищать.
- Сеть стабильна.
- Crash/fault injection, несколько locks, 10 000 файлов, throttling и mobile
  проверяются отдельно автоматикой или расширенным прогоном.
- Все тесты выполняются на небольшом vault. Нагрузочные проверки вынесены в
  расширенные release gates.

## Общий критерий успешности

После каждого тест-кейса:

1. Выполнить full sync на обоих устройствах.
2. Повторить full sync ещё раз.
3. Второй full должен дать `0/0/0`, без conflict и index commit.
4. Не должно быть старых, промежуточных и дублирующихся путей.
5. В логах не должно оставаться:
   - `pendingWatcherEvents`;
   - `pendingMutations`;
   - `pendingPhysicalActions`;
   - незавершённых `moves`;
   - lock-файлов;
   - `completed with errors`;
   - повторяющихся retry одного события.

## TC-01. Чистая первичная синхронизация и UI

Время: 3 минуты.

Предусловия:

- Plaintext remote пуст.
- Оба профиля запущены.
- На Device 1 пустой тестовый vault.
- Для отдельного fresh-install прогона у Device 1 отсутствует plugin
  `data.json`.

Шаги:

1. На Device 1 запустить manual full.
2. Проследить за Notice и status bar.
3. После завершения создать `Старт.md` с текстом `Версия 1`.
4. Дождаться realtime sync.
5. На Device 2 выполнить full.
6. Повторить full на обоих устройствах.

Ожидание:

- Notice появляется сразу после запуска manual full.
- Notice не исчезает посреди операции и не сменяется другим.
- Нет искусственного `0%`.
- `Старт.md` появляется на Device 2 с правильным содержимым.
- Повторные full дают `0/0/0`.
- На remote существует один canonical с `format: "sync-index"`.
- Плагин без `data.json` загружается без ошибки; после первого сохранения
  создаётся current `plugin-data`.

Покрывает: `INIT-001`, `INIT-002`, `INIT-003`, `INIT-013`, `INIT-027`,
`SYNC-002`, `SYNC-003`, `UI-001`, `UI-003`, `UI-005`.

Дополнительная проверка кнопки синхронизации на desktop и mobile (`UI-017`):

1. На fresh install вставить token в настройках и дождаться автоматического
   full без нажатия кнопки синхронизации.
2. Во время full проверить loader внутри кнопки, текст текущей синхронизации
   и недоступность повторного запуска. Закрыть и снова открыть настройки:
   loader и блокировка сохраняются до завершения full, включая persistence.
3. После завершения проверить восстановление обычного текста и доступности.
   Повторить для ручного full, startup при уже открытых настройках и scheduler.
4. Повторить с ошибкой сети во время full: после завершения попытки loader
   исчезает, кнопка снова доступна, причина ошибки остаётся в штатном UI.
5. Проверить Force и realtime: настройки блокируются по общему busy-guard,
   full-loader не включается без normal full. При reduced motion индикатор
   остаётся видимым без вращения.

Кнопка не меняет canonical, local state или physical files; их результат
определяется исходным sync workflow. Ручной прогон этой проверки обязателен
для подтверждения поведения в Obsidian.

## TC-02. Быстрые create → rename → edit → move → folder move

Время: 4 минуты.

Это главный регрессионный тест.

Шаги на Device 1 выполнять быстро, не ожидая завершения realtime sync:

1. Создать `Без названия.md`.
2. Переименовать в `Маршрут.md`.
3. Написать внутрь `Токио — Киото`.
4. Создать папки `Поездка/2026/Япония`.
5. Перенести заметку в `Поездка/2026/Япония/Маршрут.md`.
6. Переименовать папку `Поездка` в `Путешествия`.
7. Сразу запустить manual full, пока watcher ещё может работать.
8. После завершения выполнить ещё один full.
9. На Device 2 выполнить full.
10. Сохранить длительность realtime-сессии и её `apiReads` из summary.

Ожидание:

- Существует только `Путешествия/2026/Япония/Маршрут.md`.
- Содержимое — `Токио — Киото`.
- Не появились:
  - `Без названия.md`;
  - `Маршрут.md` в корне;
  - старая папка `Поездка`;
  - промежуточные копии заметки.

- Folder move не создаёт отдельные независимые `put-target` для механических
  child rename.
- Manual full не начинает скачивать старые причинные пути.
- Device 2 получает только конечную структуру.
- Повторный full — `0/0/0`.
- При доступном SHA-256/MD5 лог содержит `commitVerification=hash-fast` и
  `postCommitCanonical=proof`; без server hash допустим
  `commitVerification=semantic-fallback`.
- Нет повторяющихся PUT создания уже наблюдённых root/parent directories.
- В evidence записаны длительность и `apiReads`; фиксированного порога для
  нестабильной реальной сети у smoke-теста нет.

Покрывает: `MOVE-001`, `MOVE-002`, `MOVE-016`, `MOVE-017`, `MOVE-025`,
`SYNC-014`, `SYNC-018`, `PERF-009`, `UI-002`, `DIAG-013`, `DIAG-015`,
`DIAG-016`, `DIAG-018`.

## TC-03. Непрерывный ввод без ложного конфликта

Время: 3 минуты.

Предусловие:

- `Буффер.md` синхронизирован на обоих устройствах и не имеет conflict-копий.

Шаги:

1. На Device 1 печатать в `Буффер.md` непрерывно 30–60 секунд, добавляя текст
   каждые 1–2 секунды.
2. Не дожидаясь завершения промежуточного realtime upload, запустить manual
   full и продолжить ввод ещё 10 секунд.
3. Дождаться завершения watcher drain и full.
4. Выполнить повторный full на Device 1, затем full на Device 2.

Ожидание:

- На исходном пути находится последняя введённая версия.
- Файлы `Буффер_conflict_*.md` не создаются.
- В логе более поздняя mutation того же device классифицирована как causal
  successor, а не `foreign-conflict`.
- Все очереди пусты; повторный full — `0/0/0` без index commit.
- Device 2 получает последнюю версию без conflict copy.

Покрывает: `SYNC-031`, `DIAG-017`.

## TC-04. Multi-device edit/edit conflict

Время: 3 минуты.

Предусловие:

- `Общий.md` с текстом `Исходная версия` синхронизирован на обоих устройствах.

Шаги:

1. Отключить сеть на Device 2.
2. На Device 1 изменить файл на `Версия Device 1` и синхронизировать.
3. На Device 2 изменить тот же файл на `Версия Device 2`.
4. Вернуть сеть на Device 2 и выполнить full.
5. Выполнить full на Device 1.

Ожидание:

- Ни одна версия не потеряна.
- Создана ровно одна conflict copy.
- Оригинальный файл и conflict copy содержат две разные версии.
- Следующие full не создают новые conflict copy.
- Разница локальных часов не влияет на результат.

Покрывает: `INIT-005`, `SYNC-006`, `SYNC-009`, `MULTI-004`, `MULTI-008`,
`MULTI-017`.

## TC-05. Exact delete, stale edit и последующее восстановление

Время: 3 минуты.

Предусловие:

- `Удаление.md` синхронизирован на обоих устройствах.

Шаги:

1. Отключить сеть на Device 2.
2. На Device 2 изменить `Удаление.md`, но не синхронизировать.
3. На Device 1 удалить файл и дождаться sync.
4. Вернуть Device 2 в сеть и выполнить full.
5. Проверить overwritten backup на Device 2.
6. После того как Device 2 увидел удаление, снова создать `Удаление.md` с
   новым текстом.
7. Дождаться sync на обоих устройствах.

Ожидание:

- Старое stale-изменение Device 2 не воскрешает удалённый путь.
- Изменённая версия Device 2 сохранена в backup.
- Backup побайтно содержит локальную изменённую версию.
- Новое создание после наблюдения tombstone восстанавливает путь.
- Восстановленный файл появляется на Device 1.
- Повторный full — `0/0/0`.

Покрывает: `DEL-001`, `DEL-002`, `DEL-007`, `DEL-008`, `SAFE-001`.

## TC-06. Folder delete против нового и изменённого потомка

Время: 4 минуты.

Предусловие — синхронизированная структура:

```text
Проект/
  unchanged.md
  changed.md
  deep/old.md
```

Шаги:

1. Отключить сеть на Device 2.
2. На Device 2:
   - изменить `Проект/changed.md`;
   - создать `Проект/new.md`.

3. На Device 1 удалить всю папку `Проект`.
4. Дождаться sync Device 1.
5. Вернуть Device 2 в сеть и выполнить full.
6. Выполнить full на Device 1.

Ожидание:

- `unchanged.md` и `deep/old.md` удалены.
- Изменённый `changed.md` выжил.
- Новый `new.md` выжил.
- Ветка `Проект` восстановлена только ради surviving children.
- Старые неизменённые потомки не возвращаются.
- Нет промежуточных копий и массовых повторных DELETE.
- Повторный full — `0/0/0`.

Покрывает: `FDEL-002`, `FDEL-003`, `FDEL-004`, `FDEL-005`, `FDEL-007`,
`FDEL-016`, `MULTI-016`.

## TC-07. Force epoch adoption без бесконечного Force-loop

Время: 4 минуты.

Шаги:

1. Убедиться, что Device 1 содержит желаемое authoritative-состояние.
2. Подтвердить в UI, что stable 1.1 остановлена на остальных devices.
3. На Device 1 выполнить Force local с backup.
4. Не выполнять Force на Device 2 и убедиться, что его Resume не запускает
   watcher/scheduler при stale migration block.
5. На Device 2 выполнить обычный Full. Проверить создание и exact read-back
   собственного logical backup до изменения его `data.json`.
6. Проверить, что Device 2 принял новый epoch.
7. Теперь на Device 2 выполнить Force remote.
8. На Device 1 выполнить обычный full.

Проверка UI полного Force/migration flow на desktop и mobile (оба направления,
включая отдельную копию exact stable 1.1 → 2.0):

1. После первого нажатия обе кнопки Force заблокированы, индикатор появляется
   внутри кнопки выбранного направления, сохраняя её текст. Под кнопками нет
   отдельного лоудера или строки прогресса. В migration flow
   продолжение недоступно до обязательного подтверждения. Отмена кнопкой либо
   закрытием окна не создаёт backup и возвращает доступность кнопок.
2. После «Создать бекап и продолжить» окно закрывается, сразу виден persistent
   Notice. На медленной сети проверить этапы создания, загрузки и read-back;
   отсутствие файлового счётчика при неизвестном объёме нормально.
3. Повторить клик/команду другого направления; второй backup/Force не создаётся.
   Закрыть и открыть настройки: блокировка и индикатор выбранного направления сохраняются. Проверить,
   что Full, encryption, backup, токен, remote path и фильтры недоступны.
4. Дождаться окончания Force: кнопки всё ещё блокируются во время сохранения и
   завершающей проверки. Успех миграции появляется только после полного успеха,
   остаётся на 8 секунд; обычный Force не сообщает о миграции.
5. Отключить сеть при backup: сообщение об ошибке остаётся видимым, Force не
   запускается. Отдельно прервать cleanup после commit: сообщение предлагает
   обычный full, не повторную миграцию. Если завершающий full исправил cleanup,
   допустимо сообщение об успехе.
6. Скрыть Notice во время работы: операция продолжается, индикатор в кнопке
   остаётся до завершения flow; окончательный результат снова виден. Проверить отсутствие
   дубликатов и преждевременного исчезновения нового Notice из-за старого таймера.
7. После успеха, ошибки и отмены индикатор исчезает. При обычном full/realtime,
   backup или encryption индикаторы внутри Force-кнопок не появляются;
   существующая блокировка кнопок сохраняется. Проверить reduced motion.

Этот UI-прогон требует реального Obsidian/Yandex Disk; unit-тесты его не заменяют.

Отдельно на изолированной копии vault проверить загрузку local storage:

1. Использовать plaintext stable 1.1 snapshot с дробным `mtime` и перезапустить
   2.0.0. Проверить немедленное сохранение current shape и точности timestamp до
   автоматизации, после settings save и unload. Restart принимает current data.
2. Подготовить заведомо нераспознаваемый snapshot без реальных credentials.
   После отказа startup и отключения плагина файл должен остаться неизменным;
   в диагностике допустимо только имя фиксированной секции схемы.
   Не использовать для этого реальные настройки или рабочий vault.

Отдельно с fault injection проверить stale backup gate:

1. Остановить Force после exact read-back backup, но до первой destructive
   operation.
2. Изменить защищаемый source snapshot либо canonical.
3. Продолжить Force.
4. Убедиться, что операция остановилась как stale до upload/delete/overwrite
   и потребовала новый запуск с повторным выбором архива.

Отдельными fault-прогонами:

1. Изменить local source во время Force local и remote source во время Force
   remote. Replacement commit не должен состояться.
2. Прервать Force сразу после replacement commit, затем потерять initiator.
   Другой current device обязан продолжить tombstone/fingerprint cleanup
   обычным Full без повторного Force.
3. Вернуть offline Device 2: unchanged-файл должен удалиться по replacement
   tombstone, а offline edit — восстановиться причинным put.
4. Подготовить remote/local имена, совпадающие после NFC или case-fold. Force
   remote должен остановиться до первого local write/delete.

Ожидание:

- Backup подтверждён до начала каждого Force.
- После Force local Device 2 не требует Force remote.
- Device 2 принимает новый epoch обычным full.
- После Force remote Device 1 также принимает новый epoch обычным full.
- Нет ping-pong требований Force.
- Локальные изменения не теряются молча.
- Watcher и scheduler после Force работают без перезапуска Obsidian.
- Ошибка после replacement commit сообщает pending cleanup, а не требует
  повторной migration.
- Повторный full обоих устройств — `0/0/0`.

Покрывает: `INIT-022`, `FORCE-012`, `SAFE-009`, `FORCE-031`, `INIT-028`, `INIT-030`, `INIT-031`, `FORCE-001`, `FORCE-002`, `FORCE-003`, `FORCE-016`,
`FORCE-017`, `FORCE-023`, `FORCE-024`, `FORCE-025`, `FORCE-026`,
`FORCE-027`, `FORCE-028`, `FORCE-029`, `FORCE-030`,
`MULTI-012`, `MIG-004`, `UI-006`.

## TC-08. Шифрование: fresh hardened и unsupported historical data

Время: 20–30 минут на маленьком vault с заранее подготовленными fixtures.

Использовать vault из предыдущих тестов, но удалить намеренные
conflict/backup-файлы, если они мешают проверке.

### Stable 1.0/1.1 plaintext boundary

1. На двух независимых тестовых профилях подготовить synthetic plaintext stable
   local data и canonical `version: 2`. После upgrade current `plugin-data`
   должен сохраниться до автоматизации: settings/hashes/baseline перенесены,
   installation ID устойчив к restart и отличается на другом профиле.
2. Проверить отсутствие автоматического архива при загрузке/settings/unload.
   Ошибка первоначального save блокирует sync и не ретраится unload.
3. Без token и с неверным token lifecycle/baseline загружены, автоматизация
   остановлена. Resume не обходит legacy/historical/auth/encryption blocks.
4. Выполнить Force local с архивом и без него на отдельных snapshots, затем
   Force remote в обоих вариантах. Получить current canonical с новым epoch.
5. После каждого replacement второй профиль принимает epoch обычным full,
   сохраняя offline edits по существующим conflict rules, без нового архива.
6. Прервать Force до commit: новый запуск снова предлагает выбор архива. После
   commit normal full завершает cleanup; повторный Force не требуется.
7. С current canonical обычный full разрешён; с отсутствующим — initial sync;
   с неподдерживаемым historical — все writes, включая Force, заблокированы.

### Stable config-directory exposure и paths

1. При `syncDotObsidian=true` поместить на remote fixture metadata для
   `*/plugins/yandex-disk-sync/**`, не раскрывая содержимое.
2. Убедиться, что migration блокируется без download этого object, полный path
   не показывается и remote-raw backup не создаётся. Удалить remote plugin
   directory, перезапустить plugin и убедиться, что non-secret remediation marker
   по-прежнему блокирует Force со старым token; затем заменить OAuth token в
   настройках и повторить read-only preflight.
3. Отдельно проверить user path с current service name: требуется ручное
   переименование, silent skip запрещён. Повторить для legacy имени с `\`, которое
   current normalization преобразовало бы в другой logical path.
4. Проверить корневой файл `__proto__`: он сохраняется при conversion/Force.
5. Для Force remote проверить exact/NFC/case-fold collisions до local writes.

### Unsupported historical formats

1. По отдельности подготовить unmarked encrypted legacy local data, numeric
   manifest, encrypted stable canonical, другие numeric canonical formats,
   unmarked local `localState`/queues и transition без profile metadata.
2. Для каждого формата подтвердить отдельную ошибку unsupported historical и
   инструкцию выбрать чистый remote path либо выполнить ручной reset после
   самостоятельного backup.
3. Проверить, что normal sync, watcher, scheduler и оба направления Force не
   создают lock/root directory/backup, не выполняют upload, delete, cleanup и
   не изменяют Vault. Сообщение о backup не считается доказательством: на
   remote не должно появиться нового файла.
4. Скачать non-envelope `.enc.zip`, unknown `.zip` bytes и backup с encrypted
   legacy name: compatibility decrypt не должен вызываться, локальный
   повреждённый `.zip` не создаётся.

### Fresh enable

1. На Device 1 включить шифрование.
2. Проверить единый progress Notice.
3. На Device 2 выполнить full.
4. Сначала ввести неверный пароль.
5. Отменить следующий prompt и перезапустить plugin.
6. Убедиться, что неверный/отменённый candidate password не заменил прежние
   local credentials, sync заблокирована и remote не изменён.
7. Ввести правильный пароль и выполнить full.
8. Несовместимый старый клиент против current manifest должен только
   заблокироваться и не изменить remote.

### Post-commit recovery без initiator

Каждый подпункт выполняется отдельным прогоном с fault injection сразу после
canonical commit, но до публикации stable manifest:

1. Для enable остановить Device 1, оставить manifest в `enabling`, на Device 2
   ввести target password и продолжить sync.
2. Для rotate остановить Device 1, оставить manifest в `rotating`, на Device 2
   ввести новый password и продолжить sync без source password.
3. Для disable остановить Device 1, оставить manifest в `disabling` либо уже
   удалённым, затем продолжить plaintext sync на Device 2.
4. В каждом прогоне проверить совпадение maintenance ID, target descriptors и
   verifier до cleanup; при несовпадении Device 2 должен остановиться без
   удаления.
5. После recovery выполнить full на обоих устройствах и проверить `0/0/0`,
   отсутствие source ciphertext в Vault и только fingerprint-matching cleanup.
6. Повторить enable/rotate/disable с fault injection после отдельного target
   upload, но до persistence его fingerprint. Recovery обязан повторно скачать
   raw object, сверить decoded logical path и plaintext SHA-256.
7. Подменить target bytes и удалить expected fingerprint. Recovery должен
   остаться заблокированным, не удалить объект и не показать success.
8. Подготовить collision двух logical paths в один target raw path, protected
   target и пересечение source/target. Ни один target upload не должен начаться.
9. Внести extra field, mismatched phase/ID/descriptors и cleanup без fingerprint
   по очереди в manifest/canonical/local transition. До lock/upload/delete не
   должно быть remote writes.

### Offline device после encryption transition

1. Отключить Device 2 до enable, затем повторить отдельно для rotate и disable.
2. На Device 1 полностью завершить transition и создать local edit на Device 2
   в offline-режиме.
3. Вернуть Device 2 online, пройти password prompt там, где он нужен.
4. Убедиться, что Device 2 сначала принимает manifest/canonical и выполняет
   full reconcile, затем причинно воспроизводит durable logical mutations.
5. Старые physical actions без matching epoch/canonical/fingerprint proof не
   должны удалять source или target objects.
6. Финальный full на обоих устройствах: `0/0/0`.

### Обычная encrypted sync

1. На Device 1 быстро создать, переименовать и переместить заметку.
2. На Device 2 выполнить full.
3. Удалить на Device 2 вложенную папку с файлом.
4. На Device 1 выполнить full.

### Backup и rotate

1. Скачать созданный при enable backup и восстановить ZIP во временный
   vault; сравнить paths и SHA-256.
2. На Device 1 выполнить rotate encryption key.
3. На Device 2 попробовать старый пароль — sync должна блокироваться.
4. Ввести новый пароль и выполнить full.
5. Скачать pre-rotate `OYDSBKP!` `.enc.zip` и открыть его исходным backup
   password.
6. Создать новый backup, скачать и восстановить его.
7. Создать файл в уже существующей вложенной папке и дождаться realtime sync.

### Disable

1. На Device 1 отключить шифрование.
2. На Device 2 выполнить full.
3. Повторить full на обоих устройствах.
4. Скачать backup, созданный перед disable, открыть source password и сравнить
   восстановленный ZIP.

Ожидание:

- Неверный/старый пароль не позволяет upload, delete или cleanup.
- Правильный пароль открывает canonical и файлы.
- После enable/rotate/disable все logical paths и содержимое сохранены.
- После смены codec upload использует target physical directories и не
  полагается на folder observations предыдущего режима.
- Старый ciphertext не скачивается как пользовательский файл.
- Rename/move/delete в encrypted-режиме дают тот же результат, что plaintext.
- Каждый transition использует один Notice и не сообщает ложный успех.
- После disable файлы доступны plaintext.
- Финальные full — `0/0/0`.

Покрывает: `ENC-001`, `ENC-002`, `ENC-005`, `ENC-010`, `TRANS-001`,
`TRANS-002`, `TRANS-003`, `TRANS-015`, `TRANS-016`, `TRANS-020`,
`TRANS-028`, `TRANS-029`, `TRANS-030`, `TRANS-031`, `TRANS-032`,
`TRANS-033`, `MULTI-015`, `INIT-029`, `MIG-004`, `FORCE-022`, `SAFE-004`,
`SAFE-013`, `UI-007`, `UI-008`.

## Расширенные обязательные release gates

Короткий smoke не заменяет отдельный release-прогон:

- crash на каждом `await`;
- timeout до и после успешного commit;
- 409/423/429/503;
- несколько и повреждённые lock-файлы;
- потерю initiator в каждой фазе transition;
- 1 000–10 000 файлов;
- 100 уровней вложенности;
- mobile memory;
- backup cleanup;
- rename между excluded/config paths;
- параллельные encryption transitions.

Перед stable обязательны: Obsidian 1.0.0 desktop, current desktop и current
mobile; fresh install, stable 1.0/1.1 plaintext migration, fresh `hardened` и
fail-closed historical formats; два независимых
профиля; 409/423/429 и ambiguous upload; offline return; 10 000 descendants;
PERF-006; PBKDF2 p95 не более 3 секунд; финальный full обоих профилей `0/0/0`.
Результаты записываются в `release-evidence/2.0.0.json` без secret и полных
remote paths. Верхнеуровневый `testedCommit` и одноимённое поле каждой записи
сценария должны указывать на один и тот же 40-символьный SHA проверенного
коммита `2.0.0`. После этого коммита до release-tag разрешено менять только
сам evidence-файл.

## Итоговая карточка прогона

Для каждого TC достаточно записывать:

```text
Версия: 2.0.0
Дата:
Устройства:
Режим: plaintext/encrypted
TC:
Результат: PASS/FAIL
Первый full:
Повторный full:
Неожиданные файлы:
Остаток очередей:
Ошибки/предупреждения:
Ссылка на логи:
```

Если хотя бы в одном тесте появляются старый путь, лишний файл, повторный
conflict, Force-loop, неочищенная очередь или второй full не равен `0/0/0`,
релиз следует блокировать.

## TC-09. Конкурентные изменения и восстановление — PENDING

Дополнительно на двух отдельных тестовых профилях повторить в plaintext и encrypted:

- Одинаковые edits на обоих профилях, а также remote `A → X → A` против local
  `A → B`: нет conflict copies, итоговые bytes/canonical/queues согласованы.
- Повторная загрузка одинакового plaintext с новым IV не создаёт конфликт.
- Заменить root между scan/download и локальной записью: исходник и baseline
  остаются прежними, sync останавливается. Проверить также подготовку parent folders.
- Потерять ответ записанного PUT: read-back подтверждает те же bytes без нового
  sequence. При недоступном read-back и частичном upload restart сохраняет queue;
  foreign winner, tombstone, новый epoch/codec не получают старый overwrite.
- Повторить потерю ответа corrective PUT: copy сохранена, accepted causality и
  новый physical fingerprint согласованы. Первый root read с 401/403/network failure
  даёт правильный startup block; исправление connection снимает его.
- Прервать применение winner после подтверждения conflict copy; перезапустить:
  сохранена одна копия проигравшей версии, без ложного success на сбое.
- Прервать первый sync перед commit копии: после restart сохраняются pending ID,
  epoch и один путь копии. Отклонение copy put exact tombstone не разрешает замену
  оригинала и не выдаёт success. Новый winner перед corrective PUT не затирается.
- Удалить только cache installation ID в тестовом профиле: сохранённые actor и queue
  продолжают работу; известный foreign ID с pending work блокирует загрузку.
- Обновить точную прежнюю current local shape: Cancel сохраняет queues и не
  запускает recovery; подтверждение прежней папки сохраняет историю и binding.
  Ошибка local save оставляет startup заблокированным и допускает повтор выбора.
- Сменить папку/аккаунт и пересоздать root по тому же пути: старые deletes не
  применяются; непустые queues/transition запрещают новое подключение. Token
  rotation для того же root сохраняет baseline. Повторный запуск не спрашивает
  уже сохранённую привязку. Накопившиеся conflict files не очищаются.
- Проверить binding перед Force и enable/rotate/disable, включая source/target
  recovery после crash: иной root, wrong password, новая maintenance и drift
  останавливают старые writes; подтверждение storage не ослабляет codec guards.
- Переустановка с оставшимся localStorage ID и восстановление старого plugin
  snapshot не переиспользуют FIFO sequence и не сообщают success со старым index.

Эти шаги не выполняются на пользовательских vaults; до ручного выполнения
статус остаётся PENDING.

Все пункты выполняются на реальном Yandex Disk с двумя независимыми профилями;
применимые сценарии повторяются в plaintext и hardened encrypted режимах.

1. Force local/remote и enable/disable/rotate: with-backup / without-backup /
   cancel; при отказе нет ZIP/upload/readback фаз, но stale source/canonical
   блокирует операцию. Ошибка выбранного архива не вызывает fallback/повтор.
2. A: enable, пауза cleanup; B: завершение, затем disable; A: продолжение.
   Даже одинаковые bytes нового plaintext объекта не разрешают старое удаление.
   Повторить changed/missing fingerprint, timeout/202 и пустые папки.
3. Crash после target commit, stable manifest, canonical cleanup и physical delete.
   Другой профиль завершает recovery с target password; wrong password/Cancel
   не сохраняют credentials и не пишут remote. Затем manifest перечитывается.
4. B с E1 и offline edits завершает transition A после Force E2. До full adoption
   старые baseline/queues неизменны, cleanup не публикует старые mutations.
5. Приостановить download, затем create/edit локальный файл; повторить edit во
   время protective backup. Старые remote bytes не перезаписывают правку;
   следующий full сохраняет обе версии по conflict rules. Ошибка protective
   backup по-прежнему блокирует перезапись.
6. `Foo/a.md` + `foo/b.md`, NFC-варианты родителей, `folder` + `folder/note.md`,
   локальная несинхронизируемая директория на месте remote файла: блок до local
   writes. Exact updates, Unicode и `__proto__` продолжают работать.
7. На паузах full/realtime/Force/maintenance изменить token/client/path/filters
   через UI и программный settings workflow: live memory и persistence неизменны.
   Внутренние baseline/queues сохраняются; после освобождения busy настройки доступны.
8. Проверить один постоянный Notice, double click, reopen settings, отсутствие
   backup-фаз без архива и success только после persistence/full/cleanup.
9. Restore encrypted backup до/после rotate/disable, desktop/mobile, offline
   return, crash/restart; в конце два full дают `0/0/0` без pending queues.

Автоматические regression tests не переводят эти пункты в PASS.

Покрывает: `STATE-006`, `STATE-007`, `CONF-007`, `CONF-008`, `CONF-009`, `SYNC-036`, `CONF-001`, `CONF-002`, `CONF-003`, `CONF-004`, `CONF-005`, `CONF-006`, `STATE-005`, `STATE-001`, `STATE-002`, `STATE-003`, `STATE-004`, `MOVE-034`, `MOVE-032`, `MOVE-033`, `DEL-018`, `FORCE-032`, `TRANS-037`, `TRANS-005`, `TRANS-034`, `TRANS-035`, `TRANS-036`, `SYNC-032`, `PATH-006`, `SAFE-014`, `SYNC-033`, `SYNC-034`, `DEL-016`, `DEL-017`, `FDEL-018`, `MOVE-031`, `SAFE-015`, `SAFE-016`, `SAFE-017`.

Дополнительные шаги TC-09:

- Во время mkdir перед download создать файл назначения; повторить Force remote без
  полного архива для файла без baseline. Проверить bytes protective copy и отсутствие
  ошибочного baseline/suppression после отказа записи.
- Изменить уже существующую conflict copy, затем повторить rejected-put recovery и
  restart: обе версии сохранены, повтор не создаёт дополнительную копию.
- После 503 перед повторным DELETE восстановить файл с другого профиля; отдельно
  изменить move target/source и добавить excluded descendant в очищаемую папку.
  Canonical live state и physical bytes сохраняются; pending не отображается успехом.
- Отредактировать файл во время protective backup перед локальным trash. Проверить,
  что сохранены новая local версия, прежняя backup-версия и durable action.
- Сбой settings save, первый token, явная Pause, pending transition с заменой token,
  изменение remotePath при durable queues. Проверить память и persisted snapshot,
  отсутствие deadlock, full до realtime и отсутствие replay в другой destination.
- На паузе создания ручного ZIP попытаться изменить настройки/codec и запустить Force.
  Архив получает исходный пароль/папку. Закрыть список backup либо изменить конфигурацию
  во время list/download/password prompt: устаревший результат не показывается.

Новые смежные сценарии этого раздела также остаются PENDING до реального прогона.

- Создать папку и вложенную папку, быстро скопировать несколько заметок, изменить и
  переименовать их; переместить папку A → B → C и снова переименовать дочернюю заметку.
  Повторить во время незавершённого upload, удалить одну копию и создать другую.
  Сверить реальные bytes и конечные пути на Диске и втором профиле; промежуточных
  файлов, fifo-gap и зависшей очереди быть не должно.
- Потерять ответ после выполненного move; прервать commit rename, перезапустить
  профиль с сохранённой очередью и копиями позади rename. Все события завершаются
  без повторных имён; два последующих full дают 0/0/0.
- После Force local на A вернуть B с offline edit удалённого пути. Повторить со
  сбоем первого adoption commit и restart B. Проверить, что A скачал восстановленную
  версию B, а не удалил её повторно. Повторить обычное delete → restore на B без Force.

- На B создать и удалить target, пока A переименовывает в него source со старого
  baseline. Во время protective backup на A изменить target: late bytes остаются
  локально, операция показывает pending/retry. После restart/full late bytes доступны
  в проверенной protective copy, tombstones не отменяются и очереди завершаются.

## TC-MOBILE-01. Постоянная мобильная плашка

Статус: manual-required; автоматические проверки и desktop preview не заменяют
прогон на реальных Android и iOS/iPadOS. Второй независимый профиль использует
тот же тестовый Яндекс Диск и ту же версию плагина.

1. Проверить startup, scheduled full и realtime после правки на обоих профилях,
   включая plaintext и encrypted mode. По умолчанию только `YD`, loader при работе
   и status icon. Нажать шапку: внутри доступны реальные этапы и известный `N/M`,
   без искусственного `0%`; готовность либо время последнего успеха показаны
   только в раскрытии. Повторное нажатие сворачивает весь текст. На desktop та же плашка расположена над status bar.
2. На телефоне и планшете открыть длинный заголовок, клавиатуру, сменить вкладку,
   повернуть экран, открыть боковые панели, modal и меню. Плашка закреплена справа сверху и расширяется влево при удлинении текста,
   ниже верхних панелей/safe area на 8 px, шириной до 360 px с полями от 12 px;
   в раскрытии длинные строки переносятся, прогресс не обрезан. Проверить длинную
   ошибку: полный текст выделяется и прокручивается внутри области до 320 px / 45vh,
   не выходящей за видимую область при клавиатуре. Верхние кнопки и редактор
   получают касания снаружи плашки, modal/menu/Notice располагаются выше неё.
   Отдельно повторить на новой floating/fullscreen раскладке Android, где
   текст начинается под системным status bar, а переключатель чтения (книга)
   и меню плавают поверх него. При `env(safe-area-inset-top)=0` учитывается
   Obsidian `--safe-area-inset-top`; плашка ниже кнопок, даже когда их верхняя
   граница ниже `contentEl.top`. Проверить одно- и двухстрочный статус,
   прокрутку с автоскрытием/возвратом кнопок, смену safe area и поворот.
3. Выполнить Force в обоих направлениях с архивом и без; отменить подтверждение;
   выполнить encryption enable/disable/rotate и ручной backup. Между внутренними
   сессиями нет ложного idle, Notice сохранены. Быстрый следующий запуск не
   получает фазу или прогресс предыдущего.
4. Проверить паузу, отключение сети, восстановление, неверный пароль и отсутствие
   токена. Плашка показывает реальное состояние/причину движка; она не выводит
   успех из прекращения сетевой активности. Ошибка full меняет значок даже при
   свёрнутой плашке, не раскрывает её автоматически; при раскрытии видны operation/code
   и сообщение причины вместо одного счётчика. Через команду «Показать статус
   синхронизации» открыть полный selectable текст ошибки, включая переносы строк;
   credentials замаскированы. Blocking Notice сохранён. Во время download оборвать
   сеть, затем восстановить: transient обрыв получает ограниченные повторы. При
   полном отказе исходные local bytes остаются; после restart без правок заметки
   успешный повтор скачивает remote update без conflict copy (`NET-017`).
   Отдельно удержать ответ download: через 60 s видна ошибка timeout, queued
   downloads не начинаются, поздний ответ не заменяет файл. N/M виден с `0/N`
   отдельно от длинного названия этапа, первая ошибка видна до конца пачки
   (`NET-018`, `UI-015`). Во время conflict winner read/upload copy проверить,
   что completed не увеличился заранее; timeout содержит API/transfer context,
   а после завершения попытки progress увеличивается (`UI-016`).
5. Вернуться после background/offline и независимых изменений на втором профиле;
   дождаться обработки. Отключить и снова включить плагин: плашка исчезает и
   появляется в единственном экземпляре. Нет оставшихся callbacks и frame.
   Полностью завершить приложение и запустить снова: до ручного sync и при
   отключённой автоматике плашка присутствует после восстановления workspace.
   В idle видна компактная `YD` со status icon; время доступно после раскрытия.
   Смена состояния и восстановление DOM сохраняют открытый/закрытый вид,
   но после нового включения плагина плашка свёрнута. Async layout callback после выключения не
   возвращает удалённую плашку. Отдельно проверить запуск сразу в background
   и возврат: CSS fallback не скрывает индикатор в ожидании первого frame.
6. Проверить светлую/тёмную тему, увеличенный шрифт, reduced motion и screen
   reader: нативный disclosure сообщает expanded/collapsed, краткий label отражает
   статус и действие. Enter/Space переключают раскрытие; подробности доступны целиком.
   Вращение loader отключено при reduced motion; status icon не вращается.
   Во время sync с ошибкой одновременно видны loader и warning icon. Геометрия обновляется после изменения размеров верхних панелей.

Плашка сама не изменяет canonical/local/physical; результаты синхронизации
проверяются обычными критериями workflow. Зафиксировать устройство, ОС, версию
Obsidian и тему; отсутствующие устройства оставить явно непроверенными.

Покрывает: `UI-004`, `UI-005`, `UI-010`, `UI-011`, `UI-012`, `UI-013`, `UI-014`, `UI-015`, `UI-019`.

## TC-DESKTOP-01. Общая плашка над status bar

Статус: manual-required; браузерный стенд проверяет реальный компонент с
синтетическим workspace, но не заменяет запуск в Obsidian на desktop.

1. Включить плагин: справа снизу одна компактная плашка YD/loader/status icon,
   на 8 px над status bar. Внутри status bar нет прежнего элемента YD;
   другие плагины, счётчики и сам бар сохраняются.
2. Нажать шапку, повторить Enter/Space: подробности открываются вверх и
   сворачиваются; шапка остаётся на прежней нижней позиции. Сменить sync-state,
   развернуть длинную ошибку, выделить и прокрутить текст. Обновления не
   раскрывают и не сворачивают плашку сами; loader и warning совместимы.
3. Скрыть/восстановить status bar, изменить его высоту, размер окна, включить
   fullscreen. Над видимым баром отступ 8 px; без него отступ 8 px от нижнего
   края окна. Подробности помещаются в область над шапкой; modal/menu выше.
4. Открыть split view, боковую панель и заметку в отдельном окне, переключить
   активную заметку. Плашка остаётся привязана к бару своего окна, без дубликата
   в старом status bar. При возврате из background геометрия и статус актуальны.
5. Проверить full/realtime/Force, encryption и backup между внутренними сессиями;
   отключить/включить плагин: callbacks/observers/frame удаляются, новая плашка
   одна и свёрнута. Повторить `TC-MOBILE-01`: расположение на телефоне сверху
   сохранено. Проверить обе темы, reduced motion и screen reader.

Раскрытие само не меняет canonical/local/physical и не запускает sync.
Покрывает `UI-018`; реальный прогон и окружение фиксируются отдельно.

## TC-INDICATOR-ACTIONS-01. Кнопки раскрытой плашки

Статус: manual-required. Проверить desktop и Android/iOS в Obsidian;
браузерный стенд с синтетическим workspace не заменяет эти прогоны.

1. В свёрнутом виде кнопок нет. Раскрыть плашку: слева sync (`refresh-cw`),
   затем copy (`copy`), справа YD/loader/status. Desktop строка снизу,
   mobile сверху. YD не смещается влево при раскрытии; длинная ошибка
   прокручивается отдельно. Проверить ширину 320 px, увеличенный шрифт,
   светлую/тёмную тему, safe area и клавиатуру.
2. Проверить hover-подсказки над обеими кнопками, доступные названия, Tab и видимый focus.
   Enter/Space на YD раскрывает/сворачивает; на кнопках выполняет действие
   без изменения раскрытия. Touch targets обеих кнопок не меньше 44 × 44 px.
3. Sync запускает обычный manual full с прежними Notice и защитными проверками.
   Повторное нажатие не создаёт второй запуск; кнопка недоступна от начала
   validation до конца persistence. Realtime/Force/backup/encryption и
   изменение конфигурации также блокируют её. Копирование остаётся доступным.
4. На искусственных диагностических данных проверить короткий лог и лог
   длиннее 4000 символов: clipboard содержит точный хвост после маскировки,
   включая ещё не сброшенные записи. При выключенной записи в файл копируется
   сохранённый лог. Пустой лог не заменяет clipboard, выводится уведомление.
5. Проверить копирование касанием на Android/iOS. Отказ Clipboard API не даёт
   уведомления об успехе; повторное нажатие заблокировано до завершения, затем
   доступность восстанавливается. Копирование не меняет sync-state или данные.
6. Сменить состояние, восстановить workspace после background/remount,
   выключить/включить плагин: один экземпляр плашки, без оставшихся обработчиков.

Покрывает `UI-020`, `UI-021`. Зафиксировать устройство, ОС, Obsidian и тему;
отсутствующие платформы оставить явно непроверенными.

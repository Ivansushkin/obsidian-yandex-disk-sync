# Release smoke tests

Практический release smoke для проверки наиболее опасных регрессий: возврата
удалённых файлов, быстрых rename/move, folder delete, multi-device, Force-loop
и шифрования. TC-01–TC-10 проверяют алгоритмы и recovery; отдельные mobile,
desktop и indicator cases — UI. Объём расширенного fault/load прогона учитывается
отдельно: это не обещание короткой проверки всех release gates.

Массовая генерация юнитов для этого списка запрещена. Компактная автоматика
проверяет сложные алгоритмы по [AGENTS.md](../AGENTS.md#documentation-and-testing),
а UI и пользовательский результат проверяются здесь на реальном приложении.
Зелёный `npm test` не является свидетельством прохождения smoke. Пока прогон
не выполнен, ручные сценарии остаются непроверенными.

## Допущения

Перед прогоном:

- `npm test`, lint и build уже зелёные.
- На обоих устройствах установлена одна и та же `2.1.0`.
- Используются два независимых профиля Obsidian с разными device ID.
- Используется реальный Яндекс Диск.
- Тестовое remote-хранилище можно безопасно очищать.
- Сеть стабильна.
- Crash/fault injection, несколько locks, 10 000 файлов, throttling и mobile
  проверяются отдельно автоматикой или расширенным прогоном.
- Все тесты выполняются на небольшом vault. Нагрузочные проверки вынесены в
  расширенные release gates.

## Общий критерий успешности

После успешного завершения case либо предусмотренного им recovery:

1. Выполнить full sync на обоих устройствах.
2. Повторить full sync ещё раз.
3. Второй full должен дать `0/0/0`, без conflict и index commit.
4. Не должно быть старых, промежуточных и дублирующихся путей.
5. Подтвердить отсутствие pending watcher/mutations/physical actions, moves и
   lock-файлов в разрешённой диагностике тестового профиля. Отсутствие сообщений
   в логе само по себе не доказывает пустые очереди.
6. Нет `completed with errors` и повторяющихся retry одного события.

На ожидаемом отказе применяются постусловия конкретного сценария: durable work
может оставаться для recovery, success запрещён. Для evidence сохранять безопасные
ID/counts/hashes; не прикладывать plugin data, credentials, содержимое файлов или
полные диагностические логи.

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
2. Проследить за Notice и раскрытой плашкой синхронизации.
3. После завершения создать `Старт.md` с текстом `Версия 1`.
4. Дождаться realtime sync.
5. На Device 2 выполнить full.
6. Повторить full на обоих устройствах.

Ожидание:

- При открытых настройках Notice повторяет плашку с начала manual full; вне настроек
  сохраняется обычное уведомление ручного запуска.
- Settings Notice не исчезает посреди операции, обновляется на месте и исчезает
  при idle или закрытии настроек; UI-025 проверяется также при reopen.
- Нет искусственного `0%`.
- `Старт.md` появляется на Device 2 с правильным содержимым.
- Повторные full дают `0/0/0`.
- На remote существует один canonical с `format: "sync-index"`.
- Плагин без `data.json` загружается без ошибки; после первого сохранения
  создаётся current `plugin-data`.

Покрывает: `INIT-001`, `INIT-002`, `INIT-003`, `INIT-013`, `INIT-027`,
`SYNC-002`, `SYNC-003`, `UI-001`, `UI-003`, `UI-005`, `UI-017`, `INIT-040`, `UI-025`.

Дополнительная проверка кнопки синхронизации на desktop и mobile (`UI-017`):

1. На fresh install выбрать папку первым шагом OAuth-инструкции, затем сохранить
   token. Сохранённый путь и дефолт прежние. После изменения локального файла,
   ожидания interval и restart до ручного Sync нет remote requests, password prompt
   или автоматической синхронизации. Затем нажать «Синхронизировать».
2. Во время проверки подключения и full внутри кнопки виден только loader без
   текста статуса; ширина и высота кнопки остаются такими же, как в покое.
   Доступное имя «Синхронизировать» сохраняется, повторный запуск недоступен.
   Статусы остаются в плашке и тосте. Закрыть и снова открыть настройки:
   loader и блокировка сохраняются до завершения full, включая persistence.
   Одновременно плашка показывает активность с начала startup validation до
   конца persistence, даже когда движок ещё не начал session либо уже закончил
   её. При ожидании canonical lock появляется INFO `Waiting for canonical index
lock`; плашка не показывает готовность, не выдумывает N/M и не раскрывается
   автоматически. Причины блокировки остаются видимыми после проверки.
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

Покрывает: `SYNC-006`, `SYNC-009`, `MULTI-004`, `MULTI-008`,
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
`FDEL-016`, `MULTI-016`, `FDEL-019`.

Для `FDEL-019` сразу после sync удаления папки создать или переместить туда новый
файл, дождаться upload и удалить его. Новый delete должен дойти до canonical и
physical, несмотря на короткий интервал; запоздалое mechanical событие старого
файла не удаляет новый объект. Повторить с offline return второго профиля.

## TC-07. Полный Force и принятие epoch без Force-loop

Выполнить [TC-FORCE-REPLACE-01](#tc-force-replace-01--полный-direct-force-два-профиля-и-реальный-диск)
на двух независимых профилях и disposable remote-папке, в plaintext и hardened.
Фактический прогон отмечать отдельно от automated functional harness.

1. До Force оставить offline edit в B. В A заменить выбранное назначение целиком,
   включая ранее исключённые пути; сохранить только перечисленные исключения.
2. Вернуть B обычным full. До accept/preserve/later auto upload не выполняется;
   offline bytes, baseline и очереди сохранены.
3. Проверить later, preserve через обычный three-way merge и accept с обычной
   защитой вытесняемых bytes на независимых fixtures.
4. Повторный ordinary full на обоих профилях сходится без ответного Force-loop.
   Проверить новые epoch, coherent baseline/queues и сохранность поздних edits.

Новый direct Force не использует locks/MOVE, destination fingerprints или scope
ambiguity для допуска удаления. Актуальные сценарии: FORCE-DIRECT-001—FORCE-DIRECT-028; старые scoped/staged
ожидания не применять.

Покрывает: `INIT-014`, `INIT-028`, `MULTI-012`.

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
5. После replacement второй профиль принимает epoch обычным full без архива;
   offline delta требует accept/preserve/later до любых её uploads.
6. Прервать directed Force на checkpoint/intent/commit: restart сохраняет тот же
   operation ID/epoch, выполняет собственный recovery и не создаёт архив повторно.
7. Current canonical разрешает normal full; missing canonical — initial sync.
   Historical destination блокирует normal sync, но public Force local может
   заменить его raw из читаемого source. Historical encrypted source не читается
   через compatibility decode.

### Stable config-directory exposure и paths

1. При `syncDotObsidian=true` поместить на remote fixture metadata для
   `*/plugins/yandex-disk-sync/**`, не раскрывая содержимое.
2. Normal legacy/internal migration и обычный remote-raw backup блокируются по
   metadata без download plugin data. Remediation требует удалить remote plugin
   directory и заменить OAuth token вне agent context. Direct Force local пропускает
   такие bytes в source/archive и удаляет старые remote plugin copies без чтения;
   Force remote сохраняет local running plugin. Credentials не читать и не архивировать.
3. Отдельно проверить user path с current service name: требуется ручное
   переименование, silent skip запрещён. Повторить для legacy имени с `\`, которое
   current normalization преобразовало бы в другой logical path.
4. Проверить корневой файл `__proto__`: он сохраняется при conversion/Force.
5. Для Force remote source NFC/case-fold ambiguity блокирует apply. Destination
   file/folder blockers удаляются только после intent и без удаления protected/
   excluded descendants; ordinary sync сохраняет прежний collision guard.

### Unsupported historical formats

1. По отдельности подготовить unmarked encrypted legacy local data, numeric
   manifest, encrypted stable canonical, другие numeric canonical formats,
   unmarked local `localState`/queues и transition без profile metadata.
2. Для каждого формата подтвердить отдельную ошибку unsupported historical и
   инструкцию выбрать чистый remote path либо выполнить ручной reset после
   самостоятельного backup.
3. Invalid local plugin data блокирует startup и mutating workflows. Для invalid
   remote metadata отдельно проверить normal sync/watcher/scheduler: user writes
   отсутствуют. Public Force local на валидном local state заменяет historical
   destination raw; Force remote не обходит validation/decrypt своего source.
   Не переносить ожидания старого internal Force API на новый replacement flow.
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
8. На текущем клиенте проверить unknown profile/algorithm в отдельной remote
   fixture: sync блокируется без user writes. Старые сборки к current storage
   не подключать: совместная работа версий не поддерживается.

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
   отсутствие source ciphertext в Vault. Новый переход использует durable replacement
   cover; legacy checkpoint — только fingerprint-matching cleanup.
6. Повторить enable/rotate/disable с fault injection после отдельного target
   upload, но до persistence его fingerprint. Recovery обязан повторно скачать
   raw object, сверить decoded logical path и plaintext SHA-256.
7. Подменить target bytes и удалить expected fingerprint. Recovery должен
   остаться заблокированным, не удалить объект и не показать success.
8. Подготовить collision двух logical paths в один target raw path, protected
   target и пересечение source/target. Ни один target upload не должен начаться.
9. Внести extra field, mismatched phase/ID/descriptors и legacy cleanup без fingerprint
   по очереди в manifest/canonical/local transition. До lock/upload/delete не
   должно быть remote writes.

### Pre-commit rollback

Для `TRANS-039` прервать enable/rotate после verified target upload, но до canonical
commit. После restart source остаётся авторитетным; rollback удаляет только pinned
targets, не меняет logical FIFO и снимает блок только после полного завершения.
Подмена target fingerprint даже при тех же plaintext bytes запрещает DELETE.
Отдельно прервать final local save после снятия maintenance: повтор завершает
checkpoint без нового права удаления и без post-commit cleanup у source.

### Offline device после encryption transition

1. Отключить Device 2 до enable, затем повторить отдельно для rotate и disable.
2. На Device 1 полностью завершить transition и создать local edit на Device 2
   в offline-режиме.
3. Вернуть Device 2 online, пройти password prompt там, где он нужен.
4. Для нового перехода Device 2 сначала принимает target manifest/canonical и
   replacement epoch: выбранные bytes становятся эталоном Device 1, old-generation
   offline edits/queues не replay-ятся. Для legacy checkpoint без replacement
   отдельно проверить прежнее reconciliation с сохранением causal work.
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
- После нового enable/rotate/disable selected paths/bytes совпадают с local reference
  инициатора; remote-only и старые offline edits не добавляются обратно. Protected/
  excluded paths сохранены. Legacy checkpoint сохраняет прежнюю policy.
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
`TRANS-033`, `TRANS-039`, `MULTI-015`, `INIT-029`, `INIT-022`, `INIT-030`, `INIT-031`, `MIG-004`, `ENC-014`, `SAFE-004`,
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
- guarded cleanup после backup/Force, без удаления прежних архивов;
- rename между excluded/config paths;
- параллельные encryption transitions.

Перед stable обязательны: Obsidian 1.0.0 desktop, current desktop и current
mobile; fresh install, stable 1.0/1.1 plaintext migration, fresh `hardened` и
fail-closed historical formats; два независимых
профиля; 409/423/429 и ambiguous upload; offline return; 10 000 descendants;
PERF-006; PBKDF2 p95 не более 3 секунд; финальный full обоих профилей `0/0/0`.
Результаты записываются в `release-evidence/2.1.0.json` без secret и полных
remote paths. Верхнеуровневый `testedCommit` и одноимённое поле каждой записи
сценария должны указывать на один и тот же 40-символьный SHA проверенного
коммита `2.1.0`. После этого коммита до release-tag разрешено менять только
сам evidence-файл.

## Итоговая карточка прогона

Для каждого TC достаточно записывать:

```text
Версия: 2.1.0
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
Безопасная диагностическая сводка:
```

Если хотя бы в одном тесте появляются старый путь, лишний файл, повторный
conflict, Force-loop, неочищенная очередь или второй full не равен `0/0/0`,
релиз следует блокировать.

## TC-09. Конкурентные изменения и восстановление

Дополнительно для `SYNC-043`: root с 1001+ объектами, замена root между страницами,
manifest/canonical/lock drift между проходами и config ABA при позднем ответе.
Отказ не меняет local bytes/queues и не подтверждает receive. На следующем
pre-write/retry требуется новая stable root pair; общая observation validators
не заменяет standalone writeGuard или backup. Реальный прогон — PENDING.

Все подпункты остаются PENDING до реального прогона на двух независимых тестовых
профилях с disposable remote root. Применимые варианты повторяются в plaintext
и hardened; fault injection допускается только на тестовых fixtures.

### Causality, binding и конфликтные операции

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

### Maintenance, snapshots и UI

1. Force local/remote и enable/disable/rotate: with-backup / without-backup /
   cancel. Без архива нет archive ZIP/upload/readback фаз; source read/auth и
   действующие guards сохраняются. Ошибка архива не включает автоматический
   without-backup. У Force retry/uncheck/cancel остаются в том же dialog.
   В обоих направлениях проверить светлую/тёмную тему и узкое окно (320–390 px):
   пустой блок ошибки скрыт, кнопки одинаковой ширины и по центру, длинные
   пути и подписи переносятся без горизонтального скролла. Ошибка архива
   появляется в этом же окне; повторная попытка убирает старое сообщение.
   В остальных диалогах (статус, выбор архива, привязка хранилища, решения,
   пароли) проверить такое же центрирование и перенос подписей кнопок.
   В списке архивов retry расположен по центру окна, download — по центру
   своей ячейки.
2. A: enable, пауза cleanup; B: завершение, затем disable; A: продолжение.
   Даже одинаковые bytes нового plaintext объекта не разрешают старое удаление.
   Для legacy checkpoint повторить changed/missing fingerprint; для replacement —
   durable cover и target/exclusion guards. Проверить timeout/202 и пустые папки.
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
   backup-фаз без архива и success только после verification/persistence/cleanup.
   Direct Force не требует дополнительного ordinary full для success.
9. Restore encrypted backup до/после rotate/disable, desktop/mobile, offline
   return, crash/restart; в конце два full дают `0/0/0` без pending queues.

Автоматические regression tests не переводят эти пункты в PASS.

Покрывает: `SYNC-041`, `SYNC-042`, `SYNC-043`, `SYNC-039`, `ERROR-007`, `INIT-037`, `SYNC-038`, `STATE-006`, `STATE-007`, `CONF-007`, `CONF-008`, `CONF-009`, `SYNC-036`, `CONF-001`, `CONF-002`, `CONF-003`, `CONF-004`, `CONF-005`, `CONF-006`, `STATE-005`, `STATE-001`, `STATE-002`, `STATE-003`, `STATE-004`, `MOVE-034`, `MOVE-032`, `MOVE-033`, `DEL-018`, `TRANS-037`, `TRANS-005`, `TRANS-034`, `TRANS-035`, `TRANS-036`, `SYNC-032`, `PATH-006`, `SAFE-014`, `SYNC-033`, `SYNC-034`, `DEL-016`, `DEL-017`, `FDEL-018`, `MOVE-031`, `SAFE-015`, `SAFE-016`, `SAFE-017`, `SAFE-019`, `SAFE-020`.

### Local apply, settings и persistence

- В обычном sync во время mkdir перед download создать файл назначения:
  проверить protective copy и отсутствие ошибочного baseline/suppression после
  отказа записи. Directed Force remote without-backup проверить отдельно:
  individual copies отсутствуют, source/operation authority остаётся обязательной.
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

### Lifecycle durability

Для `SYNC-038` вызвать контролируемый отказ сохранения на pause и отдельно
при ACK captured upload в resume ordinary full на изолированном профиле.
Pause failure не допускает remote work; ACK failure не показывает success и
не откатывает уже принятые bytes/canonical. После restart durable event сохраняет
свой ID, повторный full завершает его без лишнего remote write. При epoch adoption
создать позднее событие и отдельно прервать save его нового epoch/baseRevision:
до successful save нет success/replay, restart сохраняет прежний durable event ID. Не вызывать отказ
на пользовательском vault. Этот пункт также PENDING.

### Rename и offline return

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

### Read failure и активный canonical lock

- `SYNC-039`: на тестовой fixture сделать существующий syncable файл нечитаемым
  при local scan. Full/initial receive/epoch adoption завершаются ошибкой; файл
  не объявляется отсутствующим; его remote-копия не удаляется на основании failed
  scan, очередь не получает ложный ACK.
- `ERROR-007`: удержать native download lock/canonical до timeout. Другой codec
  не начинает новый незавершённый read; исходная ошибка сохранена, поздние bytes
  не применяются.
- `INIT-037`: обновить единственный lock после истечения старой observation lease
  до/после read, перед MOVE/retry и на серверной границе MOVE. Обновлённые bytes
  не публикуются в canonical по старой lease. Проверить unique claim, lost reply,
  restart и появление competing lock: bytes сохраняются, ложного success нет.

- `SYNC-041/042` (PENDING, real Android/Obsidian + two-profile Yandex): выполнить
  established full с 42 изменениями в plaintext и encrypted режиме, затем no-op
  на обоих профилях. Во время canonical read сменить connection и обратно либо
  остановить/unload плагин: поздний результат не даёт success/ACK или новых writes.
  Проверить сохранение pending work и успешный restart/retry. Синтетические request
  counts не заменяют этот прогон; безопасные счётчики не должны раскрывать payloads
  или credentials. Active lock/no server hash по-прежнему требуют stable read.

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

Отдельно проверить первичное подключение Android с 42 уже совпадающими файлами,
в plaintext и encrypted режиме, по Wi-Fi и мобильной сети. Этап показывает
«Проверка и получение файлов», initial full завершается без user download и без
изменения remote bytes. По безопасной debug-диагностике `resourceKind` для передачи
canonical должно быть не более двух скачиваний за этот full. Completion содержит
`matchedFiles` и фактическую `concurrency`; записать duration и все категории `apiReads`.
Для 42 совпавших flat paths с server hash без drift синтетический full допускает
≤85 API GET (root ≤30, manifest ≤6); реальные tree pages и сеть измеряются отдельно.
Проверить настройки 1/20/40: nested metadata перекрываются до лимита; flat identical
использует fresh root metadata без individual GET. На uneven/deep tree дочерняя
папка начинает читаться до завершения медленного sibling, лимит не превышается;
ошибка останавливает новые tasks и дожидается начатых. После bulk незатронутые ветки
не обходятся повторно; старые missing stamps тоже обновляются. Partial pagination
не означает отсутствие файла. Эти проверки `SYNC-044` и `PERF-008` на реальных
Android/Obsidian + двух профилях Яндекс Диска остаются PENDING.
Общие root/manifest
checks группы не растут с числом файлов. Эти проверки сохраняются до и после группы.
Повторный full не возвращается к initial receive и не
перезаписывает совпадающие файлы. При изменении canonical другим профилем,
смене подключения или timeout видна ошибка без ложного завершения; после
восстановления/перезапуска повтор завершается. Поздний ответ не меняет local bytes
(`INIT-032`, `INIT-033`, `INIT-034`). Не включать credentials или signed URL в отчёт.

Плашка сама не изменяет canonical/local/physical; результаты синхронизации
проверяются обычными критериями workflow. Зафиксировать устройство, ОС, версию
Obsidian и тему; отсутствующие устройства оставить явно непроверенными.

Покрывает: `UI-004`, `UI-005`, `UI-010`, `UI-011`, `UI-012`, `UI-013`, `UI-014`, `UI-015`, `UI-016`, `UI-019`, `NET-017`, `NET-018`.

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
Покрывает: `UI-018`; реальный прогон и окружение фиксируются отдельно.

## TC-INDICATOR-ACTIONS-01. Кнопки раскрытой плашки

Статус: manual-required. Проверить desktop и Android/iOS в Obsidian;
браузерный стенд с синтетическим workspace не заменяет эти прогоны.

1. В свёрнутом виде кнопок нет. Раскрыть плашку: слева sync (`refresh-cw`),
   затем copy (`copy`) и open log (`external-link`), справа YD/loader/status.
   Три кнопки не перекрывают summary и текст. Desktop строка снизу,
   mobile сверху. YD не смещается влево при раскрытии; длинная ошибка
   прокручивается отдельно. Проверить ширину 320 px, увеличенный шрифт,
   светлую/тёмную тему, safe area и клавиатуру.
2. Проверить hover-подсказки над тремя кнопками и шапкой YD: все появляются сверху,
   включая смену статуса и раскрытие/сворачивание. Проверить доступные названия,
   Tab и видимый focus.
   Enter/Space на YD раскрывает/сворачивает; на кнопках выполняет действие
   без изменения раскрытия. Touch targets трёх кнопок не меньше 44 × 44 px.
3. Sync запускает обычный manual full с прежними Notice и защитными проверками.
   Повторное нажатие не создаёт второй запуск; кнопка недоступна от начала
   validation до конца persistence. Realtime/Force/backup/encryption и
   изменение конфигурации также блокируют её. Копирование и открытие логов доступны.
4. На искусственных диагностических данных проверить короткий лог и лог
   длиннее 4000 символов: clipboard содержит точный хвост после маскировки,
   включая ещё не сброшенные записи. При выключенной записи в файл копируется
   сохранённый лог. Пустой лог не заменяет clipboard, выводится уведомление.
5. Проверить копирование касанием на Android/iOS. Если `clipboard.write()`
   недоступен или отклоняет запись, копирование проходит через `writeText()`.
   При отказе обоих способов нет уведомления об успехе; повторное нажатие
   заблокировано до завершения, затем доступность восстанавливается.
   Проверить также пустой лог при отказе `write()`: буфер не меняется.
   Копирование не меняет sync-state или данные.
6. Сменить состояние, восстановить workspace после background/remount,
   выключить/включить плагин: один экземпляр плашки, без оставшихся обработчиков.
7. Open log в плашке и настройках открывает один существующий файл, не создаёт
   отсутствующий и не меняет раскрытие/SyncState. Проверить missing file,
   unsupported API и исключение: показывается ошибка без false success и viewer.
   Возврат opener сам по себе не доказывает открытие ОС.

Покрывает: `UI-020`, `UI-021`. Зафиксировать устройство, ОС, Obsidian и тему;
отсутствующие платформы оставить явно непроверенными.

## TC-FORCE-REPLACE-01 — полный direct Force, два профиля и реальный Диск

Использовать отдельную disposable remote-папку и два тестовых профиля; production
vault не использовать. Повторить plaintext/encrypted и с выбранным архивом/без.

1. Заполнить source скрытыми/исключёнными файлами, конфигурацией, пустыми каталогами
   и zero-byte файлами. Добавить destination-only garbage, corrupt canonical,
   старые locks, file/folder blockers и .backup.
2. Local → Disk: одно окно от source pre-read до результата; после подготовки —
   подтверждение с off-by-default archive и явными исключениями.
   На desktop и узком mobile-экране переключатель архива и кнопки остаются видны
   при прокрутке описания; проверить также длинные пути и увеличенный шрифт.
   Между архивом и кнопками есть заметный отступ; описание читается обычными
   абзацами, без отдельных декоративных плашек для каждой строки.
   Прогресс показан в Notice без дублирующего статуса в окне; ошибки и итог — в окне.
   Проверить замену только включённых файлов, сохранность excluded/protected paths,
   .backup, новый canonical и manifest. Для encrypted destination нужен проверенный
   пароль; при сохранении encryption codec/salt не меняются. Исключённые ciphertext
   после Force читаются прежним ключом. Disable с такими остатками блокируется.
   Во всём trace нет новых временных файлов, leases или MOVE.
3. Disk → local: окно появляется до чтения файлов и сообщает, что destination
   пока не меняется. Рядом с сообщением проверки вращается небольшой spinner;
   при password/confirmation/error он исчезает. Проверить reduced motion:
   spinner остаётся статичным, текст статуса доступен screen reader.
   Во время pre-read показан реальный прогресс. Пароль encrypted
   source вводится здесь же; неверный пароль допускает повтор без нового окна.
   После проверки всегда отдельное подтверждение с выключенным архивом полного
   local vault в remote `.backup`. Только destructive click разрешает replacement.
   При encrypted source добавить обычную .agents и настроить исключение .agents/**;
   конфигурацию отключить через её switch. Эти raw paths не читаются/не декодируются,
   исключённые local files сохраняются. In-scope undecodable имя или content дают
   force-source-format до изменений; Notice показывает остановку вместо 0/N.
   .backup никогда не попадает в расшифровку. Проверить nested includes и custom configDir.
   После selected source pre-read permanent delete заменяет только выбранные файлы,
   исключённые не удаляются. File/folder blocker с excluded descendants блокирует
   оба направления до записи; изменение filters после подготовки требует нового запуска. Собственный sync-плагин и .backup сохранены;
   source manifest/bytes не изменены, canonical перестроен. Перезапустить Obsidian.
4. Без manifest нет выбора «с/без шифрования»: source читается как обычные файлы,
   даже при старых local encryption settings и пустом source. Повреждённый manifest,
   401/403/timeout, wrong/missing password, нечитаемый file и partial listing не
   меняют destination; retry остаётся в том же окне. Cancel во время download
   прекращает дальнейшие действия после settlement. Пустой успешно прочитанный
   selection очищает только selected destination после явного подтверждения с исключениями.
5. Ошибка выбранного archive остаётся в той же модалке; retry/uncheck/cancel.
   Отмена доступна во время архива; reservation держится до settlement, purge не
   начинается. Проверить, что локальные данные действительно находятся в ZIP.
   После начала replacement закрытие окна только скрывает его; Notice остаётся.
   Без архива нет protective/conflict copies, локального .trash и snapshot старого
   destination. Не журналировать tokens/passwords/content/ciphertext.
6. Прервать DELETE/upload/canonical/persistence. Независимые действия продолжаются,
   partial result честный. Обычный manual/startup/scheduled full повторяет остаток,
   не очищает заново успешно заменённое дерево и не удаляет источник из-за недокопии.
7. Повторить с failed subtree delete, JSON restart, late source edit, pause,
   Settings close и duplicate click. Новый Force повторно подтверждает новый source;
   старый scoped checkpoint не получает полный purge автоматически. После partial
   добавить directory blocker с excluded descendant и parent-file blocker; continuation
   не удаляет их через write/mkdir и сохраняет честный partial remainder.
8. Вернуть B с offline edits: проверить обычный epoch-bound accept/preserve/later.
   После Force full с прежними ограниченными фильтрами не удаляет out-of-scope files.
9. Чужие поздние запросы не блокируют Force. Зафиксировать наблюдавшийся результат,
   не заявляя server fencing или гарантированное исправление любой concurrent порчи.

Записать revision, safe counts/hashes, local/canonical/physical результат и остаток
checkpoint. Автоматическая suite не доказывает выполнение этого manual smoke.

Покрывает: `FORCE-DIRECT-001`–`FORCE-DIRECT-028`, `INIT-012`, `INIT-019`,
`INIT-023`, `INIT-029`, `TRANS-040`, `PATH-006`, `SAFE-002`, `SAFE-004`,
`SAFE-009`, `SAFE-013`, `UI-006`.

## Проверки чтения и realtime

### Ordinary baseline-only reception (SYNC-045/046)

Manual-required: two independent Obsidian profiles against real Yandex Disk,
plaintext and encrypted. After profile A publishes an edit, profile B's ordinary
full must apply exact bytes and persist its baseline with unchanged canonical bytes
and revision, no canonical lock/MOVE. Repeat from an empty newly connected profile.
A pending matching put/FIFO ACK or verified imported physical stamp must still
commit and durably settle. Interrupt final validation/save and restart: preserve
partial baselines, queues and old observed revision/time until retry succeeds;
no false success or conflict copy. Check startup after token, manual/scheduled full
and realtime follow-up. Synthetic MemoryDisk diagnostics do not establish this
native/mobile/two-profile evidence; Android and iOS remain pending.

### Startup service reads and authenticated codec install (SYNC-047/048)

PENDING: two native Obsidian profiles on real Yandex Disk and Android.
Measure service GET bodies/bytes separately from API metadata and local reads:
token setup followed by explicit manual full, cold restart, manual retry and scheduler. Unchanged
canonical/manifest must download once within each explicit invocation; a future
invocation must revalidate and read independently. Check plaintext and hardened
modes, missing/historical manifest, wrong password, Force checkpoint and committed
encryption recovery. Change token/path/codec during a delayed response and verify
no late install, automation, write or queued-event ACK. Cancel during the password
prompt and derivation; reject a local save, restart and reconcile without losing
work. Matching authenticated codec install must not repeat PBKDF2; iterations stay 600000. Synthetic runner counts and WebCrypto observation are not native proof.

### Realtime tracked-source handoff (SYNC-049)

PENDING native evidence: first synchronize a tracked note,
modify it, then rename during its native user PUT before canonical commit.
Expected: exact latest target bytes on both independent profiles, preserved FIFO
identities, no stuck predecessor, durable ACK and a clean full/no-op after restart.
Interrupt before user body or canonical commit and restart; also revert target
bytes to their earlier value. Original put ID/seq must settle before move, with
fresh source physical/canonical/manifest proofs. Token ABA or pause/resume during
recovery must perform no further writes or final ACK. Synthetic RED/GREEN covers
these boundaries; it does not complete this native smoke. Repeat
plaintext and hardened encryption with a valid manifest, then native Obsidian,
Android and real Yandex Disk. The existing new-unsynced-source handoff passes a
different branch and cannot establish this tracked-source result.

## TC-10. Authoritative encryption replacement

Два независимых профиля и disposable реальный remote. Для enable, rotate и disable
использовать отдельные исходные snapshots; повторить с выбранным архивом и без него.
До конца перехода не редактировать устройства, кроме явно контролируемой fault fixture.

1. На A подготовить local reference; на Диск добавить remote-only файл, а на
   отключённом B — stale edit, new child и queued rename. В filters оставить
   selected и excluded subtree; сохранить безопасные path/count/hash ожидания.
2. На A запустить переход. Проверить предупреждение о локальном эталоне и одном
   Notice до verification/persistence. Target canonical получает fresh epoch и
   replacement receipt; selected bytes совпадают с A. Remote-only selected extras
   удалены, `.backup`, plugin state и excluded raw descendants сохранены.
3. Прервать post-commit cleanup и перезапустить A. На отдельной fixture завершить
   его через B с target password, включая disable без source key/manifest.
   Проверить тот же operation/target epoch и durable cover; broad reset не повторяется.
   Unknown late old-codec object вне cover без source-capable owner оставляет recovery.
4. Через контролируемую задержку отправить stale full/realtime PUT и изменить target.
   Следующая попытка старой сессии блокируется maintenance/epoch guard. Cleanup удаляет
   selected extras, target repair использует pinned A reference и read-back. Local
   drift, отсутствие сходимости либо guard revocation не показывают success.
5. Вернуть offline B: после authentication он автоматически получает selected target
   до ordinary merge, старые queues не отправляются. Failed local save/restart не
   превращает старые offline edits в новый push. Retained excluded descendants,
   включая поздний child, запрещают destructive structural collision cleanup.
6. Сменить connection и обратно либо unload во время DELETE. Новые dispatch/retry
   запрещены; sent requests joined, guard отказ не ACK отсутствие. После restart
   действуют сохранённые policy и scope. Старый checkpoint без replacement отдельно
   сохраняет fingerprint guards и прежний epoch.
7. Проверить скачивание/restore выбранного архива его собственным паролем и переход
   enable → rotate → disable с retained old-codec exclusions. На обоих профилях два
   full завершаются без новых conflicts/queues. Сохранить реальное elapsed time и
   mobile memory отдельно от synthetic request counts; fencing не заявлять.

Покрывает: `TRANS-004`, `TRANS-008`, `TRANS-013`, `TRANS-017`, `TRANS-022`,
`TRANS-041`, `TRANS-042`, `TRANS-043`, `TRANS-044`, `TRANS-045`, `TRANS-046`,
`TRANS-047`, `TRANS-048`, `TRANS-049`, `PERF-015`.

## TC-I18N-01. Языки интерфейса

На desktop и mobile с тестовыми данными:

1. Без поля `language` проверить прежнее автоопределение через язык Obsidian;
   RU/EN/KK/BE/UZ и региональные коды выбирают свой перевод, неизвестный код — EN.
   Неизвестное сохранённое предпочтение использует системный режим.
2. В начале настроек поочерёдно выбрать пять языков и вернуться к системному.
   После сохранения настройки, плашка, ribbon, tooltip/ARIA и названия команд
   обновляются без перезапуска. ID, горячие клавиши и раскрытие плашки сохраняются.
   Reopen/restart сохраняют выбор; несколько переключений не дублируют команды,
   handlers или Notice. Смена языка не запускает sync и не снимает ожидание подключения.
3. Проверить даты последнего sync/backup, размеры архивов, окно статуса, новые
   Force/encryption/backup/clear диалоги и известные ошибки. Нет сырых ключей,
   сохранены параметры и смысл предупреждений. Журнал и внешние technical details
   не переводятся задним числом.
4. При hover/focus начать чтение счётчика логов и сменить язык: поздний результат
   не переписывает новую подсказку. Сохраняются три кнопки copy/open/clear, их иконки,
   счётчик до 4000, guards и отсутствие spinner. Прогнать `TC-INDICATOR-ACTIONS-01`.
5. При sync/maintenance селектор заблокирован. При ошибке local save новый выбор
   не публикуется, селектор возвращается к сохранённому значению; ошибка не скрыта.
6. Проверить клавиатуру, светлую/тёмную тему и ширину 320–390 px на всех языках.

Автоматические проверки ресурсов и synthetic persistence не заменяют этот прогон.

## TC-SETTINGS-UI-01. Состояния настроек и подтверждения

Проверить desktop/mobile, светлую/тёмную тему, окно 320–390 px, клавиатуру и
prefers-reduced-motion. Использовать тестовые plaintext/encrypted vaults.

1. При открытых настройках запустить full (ручной/startup/scheduler), realtime,
   Force в обоих направлениях, backup, enable/disable/rotate и settings save.
   Все controls вне логов отключены визуально и с клавиатуры. Loader/aria-busy
   принадлежит только активной длительной операции; local copy/open/clear не
   меняют подписи и не показывают spinner. Повторно открыть экран до completion:
   реальная activity сохраняется, после completion/error блокировка снимается.
   Client-ID/migration/device-ID ограничения остаются. Focus не теряется от progress.
2. Во время каждой операции проверить copy/open/clear и изменение debug/file logging
   по `TC-INDICATOR-ACTIONS-01`. Sync и скачивание backup продолжаются; быстрые
   действия сохраняют подписи и иконки, повторные нажатия не дублируют действие.
3. Создать backup: подтвердить локальный filtered source, remote `.backup` и режим
   шифрования в диалоге. Проверить cancel/Escape/close и double click: без согласия
   архива нет, подтверждение запускает ровно один архив. После смены конфигурации,
   hide/reopen или unload старое подтверждение не начинает создание.
4. Очистить файл журнала из общей группы: cancel сохраняет журнал, повторное
   нажатие не открывает второй диалог. Закрыть настройки во время read/clear:
   позднее чтение не меняет clipboard/DOM, старое подтверждение не очищает журнал.
5. Удержать password verification, повторить submit, закрыть окно и завершить
   проверку: одна проверка, flow не продолжается после закрытия. Ошибка позволяет
   повторить ввод. Существующие Force/encryption подтверждения и archive choice
   работают без дополнительного общего подтверждения.
6. Во время скачивания архива остальные download-кнопки отключены; после ошибки
   они возвращаются в актуальное состояние. Дождаться завершения и проверить ZIP.
7. На новом mobile profile вставить token encrypted vault: только локальный save,
   нет проверки подключения и запроса пароля. Reopen и restart сохраняют ожидание.
   Нажать Sync и удержать remote GET: кнопка/плашка/один тост показывают проверку,
   затем общий manual workflow запрашивает пароль и выполняет initial receive.
   Повторить на desktop и при смене remote path. Cancel/wrong password не включают
   automation; следующий ручной Sync позволяет повторить ввод. Pause/unload во время
   prompt/derivation запрещают поздний install. Сбой финального activation save
   сохраняет ожидание после restart; повторное сохранение настроек его не снимает.
8. С synthetic credentials проверить маскировку token, сохранение при вводе и reopen.
   В группе логов ровно три кнопки copy/open/clear; иконки сохраняются при progress
   и reopen. Проверить точный счётчик до 4000 символов при наведении и фокусе,
   обновление после copy/clear, пустой журнал и read error. Без наведения/фокуса
   записи логгера не вызывают повторных чтений для подсказки. Закрытие во время read
   не обновляет DOM. На узкой панели кнопки переносятся без горизонтального скролла;
   нативные стили темы, Tab, Enter/Space и видимый focus сохраняются.
9. При открытых настройках сравнить тост и раскрытую плашку во время full/realtime,
   Force, backup, enable/disable/rotate, retry, pause/offline/error. Text, progress и
   подробности совпадают. В settings idle нет тоста успеха. Закрытие настроек скрывает
   зеркало; reopen сразу отражает актуальный статус; повторная отрисовка не создаёт
   дубликатов. Вне настроек прежние operation Notices сохраняются.

Покрывает: `UI-022`, `UI-023`, `UI-024`, `UI-025`. Автоматические проверки не заменяют
этот прогон в Obsidian и не устанавливают готовность к релизу.

## TC-READ-RETRY-01. Ограниченное восстановление API GET

На Android Obsidian и втором независимом desktop profile, plaintext/encrypted:

1. Проверить initial receive с кириллицей и символами `#?+%` в путях. Удержать
   первый metadata GET дольше 15 s; replacement должен завершить чтение. Вернуть
   первый ответ до/после replacement: он ignored, без false progress/success.
2. Удержать все ответы: максимум один replacement на логический GET, два reserve
   места на клиент; native occupancy не освобождается по timeout. Queue, backoff
   и transfer используют общий 60 s budget. Поздний permit не запускает expired HTTP.
3. Повторить с изменением token/path/codec, pause/resume и unload между attempts и
   перед reply. Старый workflow не читает новую конфигурацию и не подтверждает state.
   Signed download и polling после unresolved timeout не дублируются.
4. Проверить обычные HTTP transient retries, постоянный 401/403 и неизвестный decode
   error: прежние write guards и предел attempts сохранены. В логе endpoint без
   query, category, request ID, queue/native duration, remaining budget и outcome;
   credentials, paths, ciphertext и signed URLs отсутствуют.
5. После failed receive перезапустить phone, получить canonical, сделать offline
   edit, изменить другой файл на desktop и вернуть phone. Оба профиля сходятся
   без потери bytes/queues и ложного observed revision. Сравнить реальный elapsed
   time и peak requests при `maxConcurrency` 1, 4 и 20.

Покрывает `UI-022`, `ERROR-001`, `ERROR-005`, `ERROR-007`, `SYNC-042`.
Synthetic histories не заменяют этот прогон и не подтверждают мобильную готовность.

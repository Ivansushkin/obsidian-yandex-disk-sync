# Release smoke tests

Практический release smoke для проверки наиболее опасных регрессий: возврата
удалённых файлов, быстрых rename/move, folder delete, multi-device, Force-loop
и шифрования. Полный последовательный прогон занимает примерно 45–60 минут;
TC-01–TC-07 без расширенного шифрования — около 25 минут.

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
2. На Device 1 выполнить Force local с backup.
3. Не выполнять Force на Device 2.
4. На Device 2 выполнить обычный full.
5. Проверить, что Device 2 принял новый epoch.
6. Теперь на Device 2 выполнить Force remote.
7. На Device 1 выполнить обычный full.

Отдельно с fault injection проверить stale backup gate:

1. Остановить Force после exact read-back backup, но до первой destructive
   operation.
2. Изменить защищаемый source snapshot либо canonical.
3. Продолжить Force.
4. Убедиться, что операция остановилась как stale до upload/delete/overwrite
   и потребовала создать новый backup.

Ожидание:

- Backup подтверждён до начала каждого Force.
- После Force local Device 2 не требует Force remote.
- Device 2 принимает новый epoch обычным full.
- После Force remote Device 1 также принимает новый epoch обычным full.
- Нет ping-pong требований Force.
- Локальные изменения не теряются молча.
- Watcher и scheduler после Force работают без перезапуска Obsidian.
- Повторный full обоих устройств — `0/0/0`.

Покрывает: `FORCE-001`, `FORCE-002`, `FORCE-003`, `FORCE-016`, `FORCE-017`,
`FORCE-023`, `MULTI-012`, `MIG-004`, `UI-006`.

## TC-08. Шифрование: fresh hardened и unsupported historical data

Время: 20–30 минут на маленьком vault с заранее подготовленными fixtures.

Использовать vault из предыдущих тестов, но удалить намеренные
conflict/backup-файлы, если они мешают проверке.

### Stable 1.0/1.1 plaintext boundary

1. Подготовить plaintext `data.json` и canonical с `version: 2` из stable 1.1
   на Device 1.
2. Обновить плагин и проверить перенос settings, hashes и `localIndex` в
   unobserved baseline; все current queues должны быть пустыми.
3. Проверить, что active device ID заменён installation-scoped ID, переживает
   перезапуск этого профиля и отличается у второго профиля. Старый stable ID
   не используется для новых mutation.
4. Убедиться, что normal sync заблокирован инструкцией Force.
5. Выполнить Force local с обязательным backup и получить canonical с
   `format: "sync-index"`.
6. На Device 2 выполнить обычный full и проверить принятие нового epoch.

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
5. Убедиться, что sync заблокирована и remote не изменён.
6. Ввести правильный пароль и выполнить full.
7. Несовместимый старый клиент против current manifest должен только
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
`TRANS-028`, `TRANS-029`, `TRANS-030`, `FORCE-022`, `SAFE-004`, `UI-007`,
`UI-008`.

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

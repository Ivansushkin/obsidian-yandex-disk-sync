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

Watcher хранит события с identity, epoch, base revision и причинными связями.
Debounce объединяет ещё не submitted edits; running upload/rename сохраняет successor.
Folder events поглощают только механические события своих descendants. Новое содержимое
по прежнему source path остаётся отдельной операцией.

Folder rename сначала переносит debounce в durable queue. Предшествующий child
rename сохраняет source и upload receipt до settlement, но читает bytes по конечному
target; coalesced parent переносит оба пути зависимого child event. Queued uploads
следуют за parent по конечным путям. Submitted события не переписываются. Alias
промежуточной папки используется только для поглощения механических notifications
её descendants и не переживает остановку watcher.

Full prepare фиксирует cutoff событий до входа в очередь. Destructive/rename work
завершается заранее, uploads покрываются full barrier. Upload receipt передаёт
подтверждённую revision последующему rename внутри coordinator settlement. Неоднозначная
цепочка остаётся durable и делает reconciliation незавершённой.

Pause фиксирует signatures событий. После успешной сессии автоматически воспроизводятся
только новые/изменившиеся события; failed session не подтверждает очередь. Остановленный
watcher сохраняет full settlement без запуска replay. Late layout callbacks после stop
игнорируются. Watcher finalization предшествует `markRemoteObserved`.

Plugin persistence имеет одну последовательную очередь для settings, baseline,
mutations, physical actions и watcher events. Snapshot собирается при выполнении задачи,
а не при постановке. При изменении settings сначала завершаются watcher drain/persistence,
затем ставится settings save. Ожидание watcher из settings-save задачи запрещено: watcher
сам ожидает plugin persistence. Save failure сохраняет блокировку и непринятый draft.

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

## Папки, retry и memory

Upload заранее создаёт нужные родительские папки. Remote-folder cache — наблюдение:
после delete/move и изменения token/path/codec он инвалидируется. Missing parent после
404 допускает восстановление; exclusive 409 не означает отсутствующую папку.

Перед каждой попыткой DELETE повторяются canonical/identity checks. Для папок нужны
свежие live descendants и фактическая пустота; исключённый файл также запрещает pruning.
Move source не удаляется без доказанного target. Неоднозначный ответ требует read-back;
неподтверждённое действие остаётся durable для recovery.

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

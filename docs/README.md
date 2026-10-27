# Документация

Установка и повседневная работа: [README на русском](../README_RU.md) или
[English README](../README.md). Документы описывают текущее рабочее дерево;
готовность релиза подтверждается отдельной приёмкой.

## Навигация

| Документ                                            | Назначение                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Пользовательские сценарии](SYNC_USER_SCENARIOS.md) | Нормативные исходы, стабильные ID и ссылки на проверки.                             |
| [Архитектура](ARCHITECTURE.md)                      | Владельцы состояния, границы модулей и общие инварианты.                            |
| [Очереди и параллелизм](PARALLELIZATION.md)         | FIFO, watcher, persistence, lifecycle, batches и memory limits.                     |
| [Конфликты](CONFLICTS.md)                           | Выбор версии, первое подключение, conflict/protective copies и guarded apply.       |
| [Force](FORCE_SYNC.md)                              | Полная замена назначения, direct-v1 recovery и ограничения конкурентности.          |
| [Шифрование](E2E_ENCRYPTION.md)                     | Wire formats, manifest, local-reference replacement, legacy checkpoints и recovery. |
| [Резервное копирование](BACKUP.md)                  | ZIP/envelope, archive choice, passwords и exact verification.                       |
| [Ручные проверки](SMOKE_TESTS.md)                   | Два профиля Obsidian, реальный Диск, desktop/mobile и release gates.                |
| [Release evidence](release-evidence/2.0.0.json)     | Машиночитаемый статус фактически выполненной ручной приёмки.                        |
| [Changelog](../CHANGELOG.md)                        | Изменения относительно stable 1.1.0.                                                |

Каталог задаёт поведение, архитектура — границы реализации, тематические документы —
детали своих областей. При изменении алгоритма обновляйте сценарии и документ
владельца. Сохраняйте ID и точные имена проверок. Планы, дневники работ, отчёты о
рефакторинге и разовые benchmark-таблицы не нужны в постоянной документации;
актуальные ограничения и способы воспроизведения должны оставаться у владельца.

## Разработка и проверки

Нужны Node.js 20.19+ и npm. Правила кода и тестов: [AGENTS.md](../AGENTS.md).

```bash
npm install
npm test
npm run lint
npm run build
npm run format:check
git diff --check
```

`npm install` устанавливает Husky hooks. Перед commit lint-staged применяет ESLint,
затем Prettier к staged files, сохраняя unstaged hunks. После правок используйте
`npm run lint:fix` и `npm run format`; hook не отключайте. Проверки выбираются по
изменённым артефактам; после code changes обязательна вся последовательность выше.

`npm run build` создаёт только `build/main.js`, `build/manifest.json`,
`build/styles.css`. `npm run dev` запускает incremental build. Для установки в
тестовый vault один раз скопируйте `.env.example` в локальный `.env` и задайте там
`YANDEX_PLUGIN_PATH` — абсолютный путь каталога плагина. Значение файла имеет
приоритет над shell variable. Без `.env` assets остаются в `build/`.
Generated files и локальные credentials/state не коммитятся.

Агент не читает `.env` или plugin data. При запуске trusted build с локальной
конфигурацией потенциально чувствительный stdout/stderr подавляется до capture;
результат проверяется по exit status и безопасным checks.

```bash
npm run check:bundle
npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency.json
npm run check:sync-efficiency -- --encryption-transitions --out /private/tmp/encryption-efficiency.json
npm run check:sync-efficiency -- --verify-oracle --out /private/tmp/sync-oracle.json
```

Для новых runs используйте свежие output paths. Дополнительные режимы диагностики:
`--rename-latency`, `--realtime-boundaries`. Synthetic probes проверяют exact bytes,
canonical, baseline, FIFO/queues и corruption oracle; request counts не доказывают
latency реального Диска или mobile heap. Результаты не хранятся как постоянные отчёты.

## Выпуск

`auto:` и `manual:` в каталоге обозначают способ проверки, а не её результат.
Перед выпуском нужен [реальный прогон](SMOKE_TESTS.md) на двух независимых профилях,
в plaintext/encrypted и на требуемых платформах. `release-evidence/2.0.0.json`
остаётся `PENDING`, пока нет фактического evidence для всех P0/P1 и проверенного SHA.
Автоматические tests не переводят его в `PASS`.

`npm run validate:release` проверяет metadata, bundle assets, каталог и evidence;
это gate выпуска, а не замена build или runtime smoke. Его статический parser
ограничен ID вида `PREFIX-123`, numeric `TC-xx` и некоторыми шаблонами test names:
составные `FORCE-DIRECT-*`, named smoke cases,
вычисляемые имена и annotations нужно сверять с owning tests/docs. Несовместимость
parser не оправдывает изменение корректных сценариев или понижение требований.

`npm run test:force-fencing` — отдельная диагностика поздних чужих запросов с более
сильными preservation expectations. Она не входит в default suite и не подтверждает
server fencing; direct Force такой гарантии не даёт. Контракт и реальные проверки
находятся в [FORCE_SYNC.md](FORCE_SYNC.md).

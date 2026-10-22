# Отчёт о рефакторинге 2.0.0

Дата: 2026-10-22. Сводка завершённых планов 00–13 и последующего ревью.
Работа выполнена последовательно в `master`, поверх HEAD
`15b10e4184b9cf551ba17dbf8ace8c856fde1dec` и существовавшего незакоммиченного
Force changeset. На момент приёмки результат находился в рабочем дереве,
staging был пуст, commit/push не выполнялись. Исходные планы и завершённая
очередь заменены этим отчётом.

## Результаты этапов

| Этап | Результат                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00   | Согласованы сценарии и фактические контракты направленного Force: читаемый source, per-run backup, отдельный recovery и epoch adoption.                                    |
| 01   | Чистые validators и классы ошибок выделены в `canonical/schema.ts`, `canonical/errors.ts`, `crypto/manifest-schema.ts`; сохранены accepted formats и constructor identity. |
| 02   | `canonical/merge.ts` стал чистым reducer с явными inputs/results; causal order и побочные эффекты остались под управлением фасада.                                         |
| 03   | Обычный commit, recovery и Force publication получили отдельных владельцев; уже полученный commit proof используется без повторного download в той же resolution.          |
| 04   | Encryption preparation/admission/maintenance/recovery вынесены из `main.ts` в `crypto/`; сохранён существующий transition controller.                                      |
| 05   | Выделены `PluginPersistence` и `PluginStartup`; одна coherent save queue, generation checks и настройки публикуются только после успешного save.                           |
| 06   | Pure watcher queue/receipt rules отделены от subscriptions/replay; submitted child и running successor сохраняют ID/seq и причинные связи.                                 |
| 07   | Выделен `WatcherSettlement`; watcher saves объединяются по runtime generations без потери arrivals, ошибок и durability boundaries.                                        |
| 08   | Full, rename, remote move и reconciliation разделены по typed стадиям; engine использует узкие ports и актуальные getters/callbacks.                                       |
| 09   | Повторные FIFO/path/tree обходы заменены временными lookup/ancestry индексами; fresh authority и полные collision checks после await сохранены.                            |
| 10   | Digest-only traversal освобождает content после каждого файла; materialized snapshot остаётся только там, где нужны bytes для ZIP.                                         |
| 11   | Realtime серии разбиты на последовательные окна до 32 событий / целевые 8 MiB в одной сессии; settlement/save каждого окна предшествует следующему.                        |
| 12   | Объединён missing-parent upload recovery; callback/read-back 404 больше не разрешает mkdir/повторный PUT. Encryption ancestors используют общий helper.                    |
| 13   | Проверен весь накопленный changeset; исправлены скрытые pause/resume save failures и missing await late epoch rebase. Согласованы сценарии и тестовые ссылки.              |

Сохранены один coordinator, causal store и persistence queue, текущие markers,
профиль `hardened`, FIFO, operation IDs и форматы persisted records.
Направленный Force сохраняет отдельный checkpoint/maintenance, принятый в
исходном changeset; рефакторинг не добавляет миграцию под видом переноса кода.
Действующие владельцы и контракты: [ARCHITECTURE.md](ARCHITECTURE.md).

## Ревью после рефакторинга

Отдельно подтверждены воспроизведением и исправлены шесть дефектов:

| Дефект                                                                                                                  | Исправление / нормативный сценарий                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Неполный local scan превращал read failure в remote delete](codex://threads/01a160dd-457b-7d71-ae81-dfb702266233)      | Scan fail-closed до delete intents и acknowledgement; `SYNC-039`.                                                        |
| [Force мог удалить длинное plaintext-имя вне include scope](codex://threads/01a16258-c8e1-7752-9323-e4a60d6c2ce3)       | Shape имени не даёт delete authority; требуется raw scope либо authenticated logical path, иначе ambiguity; `FORCE-040`. |
| [Suppression старого folder delete терял delete нового потомка](codex://threads/01a1625b-ee99-7500-b792-1e02f8d42867)   | Различаются старые и новые экземпляры `TFile`; `FDEL-019`.                                                               |
| [Pre-commit encryption rollback публиковал недопустимый cleanup](codex://threads/01a1625b-f886-74f1-853a-ce604b722209)  | Отдельная source rollback authority, pinned target proofs и идемпотентное завершение checkpoint; `TRANS-039`.            |
| [Codec fallback повторял unresolved native reads и скрывал cause](codex://threads/01a1625c-cdae-7bf0-b3e9-c8179e2d70b7) | Один stable raw download; fallback только после decode mismatch; `ERROR-007`.                                            |
| [Stale recovery публиковал обновлённый активный lock](codex://threads/01a1625f-b909-7ee1-9fb7-e75310b57839)             | Unique raw claim и exact bytes проверяются до publication; renewal/retry/restart сохраняют новую lease; `INIT-037`.      |

Все шесть исправлений выполнены в отдельных чатах последовательно и приняты
после проверки scoped changes. Пять дефектов существовали уже в HEAD; Force scope
относился к новому changeset. История: [исходная сессия](codex://threads/01a16006-4c5a-7e32-afe3-f388b2138d72),
отдельные чаты исправлений указаны в таблице выше.

## Что измерено

- Этап 09: differential probes реальных алгоритмов на N=128/256 сохранили
  metadata/queues. Например, merge field reads: 65 792 → 768 и 262 656 → 1 536.
  Это счётчики работы, без доказанного ускорения реальной сети.
- Этап 10: synthetic forced-GC probe на 16/32 файлах по 1 MiB показал retained
  file buffers N → 1 при прежнем digest и числе reads. Identities остаются O(N);
  ZIP/envelope, WebCrypto и реальный mobile heap этим не измерены.
- Этапы 11/13: на 65 × 1 KiB peak reachable snapshots 65 → 32, canonical commits
  1 → 3; финальный synthetic HTTP count 279 → 315 в обоих режимах. Окна ограничивают
  retained content ценой дополнительных транзакций. Oversized файл и временный
  budget + read не являются hard cap памяти.

Это исторические bounded probes по записям этапов, а не новый benchmark.
Fresh per-delete scans, current FIFO lookup после await и final collision scans
оставлены ради корректности. Их стоимость и path-based API без atomic source
precondition остаются ограничениями, а не обещанием устранённой конкуренции.

## Проверки и оставшийся объём

Автоматическая приёмка этапа 13: **489/489**. После шести исправлений:
**505/505**, lint, build, format, bundle и `git diff --check` — exit 0.
Дополнительно повторены шесть исходных symptom probes и независимый renewal
на серверной границе MOVE: все GREEN. Build output подавлялся до capture.
Это static/unit/functional/build evidence с synthetic Obsidian storage/transport.
Точное имя теста в каталоге не означает реальный smoke.

Реальные два профиля Obsidian/Yandex, desktop/mobile и Obsidian 1.0.0,
offline return, Force, migration, encryption recovery, mobile memory и PBKDF2 p95
не проверены. [Release evidence](release-evidence/2.0.0.json) остаётся `PENDING`;
`testedCommit=null`. Нужен отдельный [ручной прогон](SMOKE_TESTS.md) проверенной сборки.
Live PR diff не проверен; review использовал локальные branch/staged/working
changes и релевантные untracked source/docs.

Сохраняются две границы диагностики: причина единственного старого 15 ms timeout
не установлена; последующие focused/full runs его не повторили. Статический
scenario validator понимает более узкие templates/evidence, чем каталог;
exact-name audit использовал фактически исполняемые имена, без изменения валидных
сценариев ради ограничений validator. Ни один из этих фактов не заменяет release smoke.

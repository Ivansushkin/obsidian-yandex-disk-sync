# Stage 03 — bounded metadata collection and dynamic inventory

Status: `completed_automated`, ready for coordinator acceptance of stage03 only.
Native Android/Obsidian + two-profile real Yandex smoke remains **PENDING**.
No branch/worktree/reset/stage/commit/push, owner queue/automation mutation,
next-stage dispatch or other-chat message was performed.

Dispatch nonce: `cc938fc1-a6d7-46ea-8a92-1091d883a4f0`.
Date: 2026-10-23, Europe/Moscow.

## Actual source boundary

- Branch: `codex/direct-force-sync`; HEAD unchanged:
  `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Actual starting dirty working copy, not HEAD:
  `/private/tmp/sync-efficiency-03-owo1x4lx/`.
  `files/`, `identity.json`, `staged.patch`, `unstaged.patch`, `index-entries.txt`,
  `status.txt`, `head.txt` capture source/index/worktree separately. The snapshot
  covers194 source/test/doc/script/config files; no .env*, real plugin data,
  credentials, user/service logs or sensitive inputs were read.
- Starting production digest, verified by a fresh38-row run:
  `4337c15d1ba17b8f611b123fd5b0fa96f069ee62c888fa279250d051c5a5a701`.
- Final production digest:
  `2fc7e6d9d81ceaa10df7958474364ece35c5abc855fdcbf2c5b616dd6a43f58c`.
- Runner+fixture digest unchanged:
  `bb73c1ae00a111bae23b2f7925583118c817d9c7c80ddce0cc02dd800c8ddcb2`.
  Diagnostic entry point,38 payload/history/mode rows, counters, startup/realtime
  wiring, byte/queue/receipt oracle and sync-flow/Obsidian helpers are unchanged.
- Staged binary diff unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable stage00 JSON unchanged:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- `incremental-final.patch` and `incremental-final-identity.json` in the scratch
  directory isolate12 existing changed files against the actual starting bytes;
  this new report and live coordinator queue are excluded. No historical fixture
  or other captured file was changed. Queue hash changed externally during this
  run; this worker issued no queue write and did not restore owner updates.

Incremental files: `src/api/yandex-client.ts`, `src/sync/canonical/manager.ts`,
`src/sync/workflows/full.ts`, `src/sync/workflows/initial-receive.ts`,
`tests/remote-read-concurrency.test.ts`, `tests/sync-user-flows.test.ts`,
`tests/yandex-client.test.ts`, `docs/ARCHITECTURE.md`, `docs/E2E_ENCRYPTION.md`,
`docs/PARALLELIZATION.md`, `docs/SMOKE_TESTS.md`, `docs/SYNC_USER_SCENARIOS.md`.

## Implementation and API handoff

- `IndexManager.getObservedRootResources(observation)` returns an independent copy
  of raw resources only while the supplied opaque observation is live. Initial
  receive copies it in its own fresh canonical validation callback, verifies the
  canonical signature, and passes positive metadata to identical-file admission.
  The opaque object expires normally; only read-only metadata is retained within
  that initial invocation. No proof/cache is seeded, and missing entries require GET.
- `YandexDiskClient.collectLogicalMetadata(paths, concurrency, onResource, options)`
  is shared by initial receive and post-upload stamps. Paths are full logical paths;
  callbacks receive raw physical resource metadata (or null only after GET404) and
  the original download budget. Options are invocation-local `observedResources`,
  `knownDirectoryPages` keyed by raw parent without disk prefix, and `assertCurrent`.
  Client generation and caller lifetime checks bracket asynchronous work. No global
  cache, TTL, new domain store, persistence schema or coordinator was introduced.
- Immediate parents coalesce one fully paginated listing when known pages are
  cheaper than needed individual GETs. Unknown cost or a tie selects GET. Positive
  initial root metadata needs neither. The map is usable only after strict full
  pagination; malformed/changing/duplicate/out-of-parent responses reject before
  callbacks. Missing entries fall back to individual GET, never absence inference.
  Per-path callbacks run as their metadata completes; an initial mismatch starts
  protected stable download within that task with the same budget/deadline.
- `getResourcesRecursive` retains its arguments/default concurrency4 and appends
  optional `onDirectoryPages(rawPath, pages)`. A bounded dynamic directory queue
  admits discovered children when slots free, deduplicates visits, retains strict
  pagination/filtering and sorted output. The first error stops new task admission;
  rejection waits for all started directory tasks. No partial result is returned.
  Explicit/default Force/backup limits and full hidden/config inventory are intact.
- `IndexManager.getRemoteFiles(directoryPages?)` still performs a complete original
  inventory and the same codec/maintenance/protected/user filters. FullPlan carries
  its raw page-cost map within that invocation. Original inventory still feeds
  foreign-edit discovery and causal reconciliation.
- `refreshMissingServerMetadata(directoryPages, assertCurrent?)` selects every live
  canonical entry lacking remoteMtime, including pre-existing gaps, and uses the
  common collector and shared resource-to-metadata conversion. Bulk no longer
  recursively revisits unaffected branches. `applyServerMtimes` retains existing
  fallback semantics; incomplete/failed metadata never becomes deletion authority
  or verified-content acknowledgement. Optional stamp failure does not fabricate
  success. Fresh pre-write fingerprints, corrective authority, local SHA checks,
  mandatory saves, FIFO, epoch/revision and Direct Force direct-v1 are unchanged.
- Documentation adds `SYNC-044`, updates `INIT-032`, `PERF-008`, architecture,
  encryption/parallelization and pending native smoke. Startup/realtime algorithms
  and subsequent queue stages were not changed.

## Functional RED / GREEN and reviewed boundaries

All evidence below is synthetic and source-only in the scratch directory.
Default suite count stays364; no new cases or helper-unit matrix were added.

- Before production edits, existing initial42 test extended to require0 individual
  metadata overlap failed with actual1; existing inventory test extended with42
  two-level branches and a controlled slow sibling failed on child overlap false
  (`red.log`). Both are GREEN for plaintext/encrypted modes and limits1/20/40.
  Tests assert canonical/physical bytes, local baseline and queues, not just cost.
- Existing bulk two-device flow now retains an untouched nested branch. It first
  refreshes three deliberately missing old stamps: two root entries use one parent
  listing, an unknown-cost nested parent uses an individual GET. It checks exact
  selected paths, finite stamps, unchanged remote bytes and saved device state.
  Actual full uploads42 then lists the unaffected branch only once in the original
  inventory. Both devices settle exact bytes/baselines/queues and a follow-up noop.
- Negative oracle `negative.mjs` restores only the old post-upload recursive call
  in a scratch esbuild bundle: the real bulk flow fails2 listings versus1
  (`recursive-stamps-red.log`). It never mutates production source.
- Existing deadline test uses nested paths whose listing cost is unknown, retaining
  real individual metadata transport. a's budget is shortened to100ms; b advances
  the synthetic clock150ms. The first actual a fallback asserts the same budget
  object and a still-live original deadline, then real stable download succeeds.
  Later full reconciliation may independently verify a without that budget;
  the assertion is deliberately scoped to the initial fallback. Scratch mutation
  dropping the passed budget fails the exact identity assertion
  (`reset-budget-red-final.log`). No reset deadline is accepted as success.
- The initial stopped-batch fixture remains adversarial canonical order c,b,a.
  Because metadata now comes from root listings, injection is armed after actual
  buildLocalIndex and fires on the FIRST actual root metadata request. Pause and
  token ABA retain strict1 observation before stop /0 after /1 total. No user bytes,
  remote bytes, observed revision/time, baseline or queues are relaxed. The same
  test retains canonical/manifest/root/lock/physical/local-edit/save/timeout failures
  and real JSON restart recovery in both modes (`focused-final2.log`).
- Existing inventory case additionally holds the first actual raw directory task,
  fails its started sibling, proves rejection has not settled while the held task
  runs, then releases it and requires only root+those two visits. No descendants
  start after failure; bytes/state remain unchanged. Encrypted physical order is
  selected from the actual sorted raw folder names, not logical folder-0/1 guesses.
- Existing changing-total pagination test now also exercises the shared collector:
  a changing1001+ parent rejects with0 admitted callbacks. Final self-review found
  a concrete old-reader counterexample: first page directory, second page file.
  Its real collector test was RED Missing expected rejection
  (`type-replacement-red.log`); the reader now rejects nonzero-offset file replies
  and invalid directory types. GREEN requires0 admitted callbacks. Raw disk:/
  aliases share normalized seen/visited keys while request/filter paths stay raw.
  The reviewer rechecked this narrow delta and found no new issues. Existing full inventory,
  Direct Force/backup, ambiguous transfers, offline return, reordered events,
  lost-response/restart, lifecycle/config ABA and recovery tests remain executable.
- Intermediate failures were investigated: an early mapper extraction left its
  resource loop unexecuted and was corrected before the first full suite. The first
  full suite's sole failure was the new encrypted drain fixture assuming logical
  folder order matched physical ciphertext order; selecting actual raw first tasks
  fixed it (364/364). A strengthened budget wrapper initially applied its initial
  fallback constraint to a later ordinary verification read; scoping it to the first
  actual fallback fixed the fixture while the reset-budget negative oracle still
  fails. No product guard was removed or failure labelled unrelated.
- Fresh-context read-only review inspected the12-file incremental patch and actual
  production files, including lifetime, codec, write authority, pagination/drain and
  Force/backup parity. It found no Critical/Important/Minor issues. It did not rerun
  gates or inspect all inherited dirty changes; that scope was explicitly declined
  as outside stage03. Final test-only budget strengthening was checked locally.

## Exact comparable38-row measurements

`before.json` and `after-final2.json` retain the same runner and fixtures.
Every row's bytes/canonical/baseline/queue oracle and durable receipt checks passes.
Result counts, observed mutation/event identity counts, native body counts, exact
per-kind transfer bytes, local reads/bytes/phases, persistence requests, MOVE counts
and revision delta are identical. `comparison-final2.json` records all differing fields,
including timing/overlap; source JSON retains every unchanged field and API category.
Initial42 removes42 metadata GETs, with no user transfer. Both old and targeted post-upload refresh need one listing on the flat bulk
fixture; the separate nested functional case proves avoided unaffected traversal.
Total flat bulk API is494→498 plain and496→498 encrypted in the final sample.
The only differing API category there is fresh root reads:270→274 /270→272;
tree126, link GET, service/user body transfers and all state/bytes are unchanged.
No bulk API improvement is claimed.

Fresh pre-stage plain bulk42 is494 GET, encrypted496. Prior accepted stage02 final
plain sample was496; its report documented root-read scheduling variation. This
report compares the actual fresh494→498 plain /496→498 encrypted samples.
The extra root reads remain visible and are not reported as a saving.
A repeat with identical final production+runner hashes (`repeat-final.json`) returns
plain494 /encrypted496: root270/270, with every body/byte/state/persistence result
identical to the498/498 sample. This directly demonstrates sample variation at the
fresh-root observation boundary on the same implementation; it is not attributed
to an unrelated source change or claimed as a guaranteed range. Stable-root retries
remain enabled during concurrent physical uploads. Both samples are preserved;
`after-final2.json` is the authoritative final comparison above.
All measurements are project-algorithm synthetic request costs, not live speed.

C/M/L/U are native GET canonical/manifest/lock/user bodies; PUT counts are user/lock.
Bytes are total native GET/PUT; per-kind exact values are in both JSON files.
Unchanged fields are printed once and mean the identical before and after value.
Result is upload/download/delete; dash means the measured wrapper returns void.
All state oracle flags are true; IDs lists mutation/event identity counts.

| Scenario                      | Mode/limit | API before→after | GET C/M/L/U | PUT U/L | GET/PUT bytes | Local reads/bytes | Saves | MOVE/Δrev | Result | IDs M/E |
| ----------------------------- | ---------- | ---------------- | ----------- | ------- | ------------- | ----------------- | ----- | --------- | ------ | ------- |
| `token-initial-identical42`   | plain/20   | 65 → 23          | 3/0/0/0     | 0/0     | 59004/0       | 168/1640          | 6     | 0/0       | —      | 0/0     |
| `full-noop42`                 | plain/20   | 9 → 9            | 1/0/0/0     | 0/0     | 19668/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `full-upload1`                | plain/20   | 43 → 43          | 1/0/2/0     | 1/1     | 59017/19695   | 43/429            | 3     | 2/1       | 1/0/0  | 1/0     |
| `full-upload42`               | plain/20   | 494 → 498        | 1/0/2/0     | 42/1    | 58972/20230   | 84/1240           | 3     | 2/1       | 42/0/0 | 43/0    |
| `full-download1`              | plain/20   | 29 → 29          | 1/0/1/1     | 0/0     | 39250/0       | 46/676            | 2     | 2/0       | 0/1/0  | 43/0    |
| `full-local-delete1`          | plain/20   | 36 → 36          | 2/0/2/0     | 0/1     | 78572/19671   | 41/612            | 5     | 2/1       | 0/0/1  | 44/0    |
| `full-remote-delete1`         | plain/20   | 33 → 33          | 3/0/1/0     | 0/0     | 78932/0       | 44/654            | 4     | 2/0       | 0/0/1  | 44/0    |
| `full-followup-noop`          | plain/20   | 9 → 9            | 1/0/0/0     | 0/0     | 19733/0       | 40/598            | 2     | 0/0       | 0/0/0  | 44/0    |
| `json-restart-full-noop`      | plain/20   | 18 → 18          | 3/0/0/0     | 0/0     | 59199/0       | 40/598            | 2     | 0/0       | 0/0/0  | 44/0    |
| `realtime-edit1`              | plain/20   | 28 → 28          | 0/0/2/0     | 1/1     | 39349/19703   | 1/22              | 6     | 2/1       | —      | 1/1     |
| `realtime-edit42`             | plain/20   | 216 → 216        | 0/0/4/0     | 42/2    | 78551/40280   | 42/1040           | 10    | 4/2       | —      | 43/43   |
| `realtime-followup-full-noop` | plain/20   | 9 → 9            | 1/0/0/0     | 0/0     | 19610/0       | 42/1040           | 2     | 0/0       | 0/0/0  | 43/43   |
| `json-restart-pending-full1`  | plain/20   | 52 → 52          | 3/0/2/0     | 1/1     | 98051/19631   | 43/1056           | 4     | 2/1       | 1/0/0  | 44/44   |
| `json-restart-noop`           | plain/20   | 9 → 9            | 1/0/0/0     | 0/0     | 19611/0       | 42/1036           | 2     | 0/0       | 0/0/0  | 44/44   |
| `token-initial-empty42`       | plain/20   | 497 → 497        | 3/0/1/42    | 0/0     | 79082/0       | 84/820            | 47    | 2/0       | —      | 0/0     |
| `initial-empty-followup-noop` | plain/20   | 9 → 9            | 1/0/0/0     | 0/0     | 19668/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `token-initial-identical42`   | enc/20     | 66 → 24          | 2/2/0/0     | 0/0     | 40524/0       | 168/1640          | 6     | 0/0       | —      | 0/0     |
| `full-noop42`                 | enc/20     | 11 → 11          | 1/1/0/0     | 0/0     | 20262/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `full-upload1`                | enc/20     | 45 → 45          | 1/1/2/0     | 1/1     | 59667/19751   | 43/429            | 3     | 2/1       | 1/0/0  | 1/0     |
| `full-upload42`               | enc/20     | 496 → 498        | 1/1/2/0     | 42/1    | 59622/21434   | 84/1240           | 3     | 2/1       | 42/0/0 | 43/0    |
| `full-download1`              | enc/20     | 31 → 31          | 1/1/1/1     | 0/0     | 39900/0       | 46/676            | 2     | 2/0       | 0/1/0  | 43/0    |
| `full-local-delete1`          | enc/20     | 38 → 38          | 2/1/2/0     | 0/1     | 79250/19699   | 41/612            | 5     | 2/1       | 0/0/1  | 44/0    |
| `full-remote-delete1`         | enc/20     | 35 → 35          | 3/1/1/0     | 0/0     | 79610/0       | 44/654            | 4     | 2/0       | 0/0/1  | 44/0    |
| `full-followup-noop`          | enc/20     | 11 → 11          | 1/1/0/0     | 0/0     | 20327/0       | 40/598            | 2     | 0/0       | 0/0/0  | 44/0    |
| `json-restart-full-noop`      | enc/20     | 24 → 24          | 2/4/0/0     | 0/0     | 41786/0       | 40/598            | 3     | 0/0       | 0/0/0  | 44/0    |
| `realtime-edit1`              | enc/20     | 30 → 30          | 0/1/2/0     | 1/1     | 39971/19759   | 1/22              | 6     | 2/1       | —      | 1/1     |
| `realtime-edit42`             | enc/20     | 218 → 218        | 0/1/4/0     | 42/2    | 79229/41512   | 42/1040           | 10    | 4/2       | —      | 43/43   |
| `realtime-followup-full-noop` | enc/20     | 11 → 11          | 1/1/0/0     | 0/0     | 20204/0       | 42/1040           | 2     | 0/0       | 0/0/0  | 43/43   |
| `json-restart-pending-full1`  | enc/20     | 58 → 58          | 2/4/2/0     | 1/1     | 80817/19687   | 43/1056           | 5     | 2/1       | 1/0/0  | 44/44   |
| `json-restart-noop`           | enc/20     | 11 → 11          | 1/1/0/0     | 0/0     | 20205/0       | 42/1036           | 2     | 0/0       | 0/0/0  | 44/44   |
| `token-initial-empty42`       | enc/20     | 498 → 498        | 2/2/1/42    | 0/0     | 61806/0       | 84/820            | 47    | 2/0       | —      | 0/0     |
| `initial-empty-followup-noop` | enc/20     | 11 → 11          | 1/1/0/0     | 0/0     | 20262/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `initial-identical42-limit`   | plain/1    | 65 → 23          | 3/0/0/0     | 0/0     | 59004/0       | 168/1640          | 6     | 0/0       | —      | 0/0     |
| `full-noop-uneven-deep`       | plain/1    | 30 → 30          | 1/0/0/0     | 0/0     | 21278/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `initial-identical42-limit`   | plain/20   | 65 → 23          | 3/0/0/0     | 0/0     | 59004/0       | 168/1640          | 6     | 0/0       | —      | 0/0     |
| `full-noop-uneven-deep`       | plain/20   | 30 → 30          | 1/0/0/0     | 0/0     | 21278/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |
| `initial-identical42-limit`   | plain/40   | 65 → 23          | 3/0/0/0     | 0/0     | 59004/0       | 168/1640          | 6     | 0/0       | —      | 0/0     |
| `full-noop-uneven-deep`       | plain/40   | 30 → 30          | 1/0/0/0     | 0/0     | 21278/0       | 42/410            | 2     | 0/0       | 0/0/0  | 0/0     |

## Reproduction and final gates

All logs named below are under `/private/tmp/sync-efficiency-03-owo1x4lx/`.
Build stdout/stderr was suppressed to `/dev/null` BEFORE capture on every run.
The known approved build path was reused; no equivalent sandbox probe was repeated.

- `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-03-owo1x4lx/before.json`:
  exit0,38 rows, actual accepted stage02 production/runner identity.
- `node /private/tmp/sync-efficiency-03-owo1x4lx/focused.mjs` bundles the existing
  functional files using esbuild and the shared Obsidian stub. Then
  `node --test --test-name-pattern='initial fingerprint|initial matching batch|ordinary full reuses|ordinary remote inventory|initial receive reuses|paginated inventory' /private/tmp/sync-efficiency-03-owo1x4lx/bundles/*.mjs`:
  exit0,6 focused cases,0 failed/skipped/cancelled (`focused-final2.log`).
- `node .../negative.mjs` then focused `recursive-stamps.mjs` and
  `reset-budget.mjs`: expected exit1 at the exact assertions described above.
- `npm run lint:fix`: final exit0 (`lint-fix-final3.log`). An earlier lint identified
  unknown Promise rejection type in the new queue; the queue now retains an Error
  or a safe generic Error. No rule was disabled.
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-03-prettier-ignore`:
  exit0; `/docs/superpowers/plans/sync-efficiency/queue.json` and
  `/tests/fixtures/` root-relative rules verified with --file-info ignored=true
  before writes. Foreign captured hashes and all fixtures verified afterward.
- `npm test`: final exit0,364/364,0 failed/skipped/cancelled (`suite-final3.log`).
- `npm run lint`: exit0 (`lint-final3.log`).
- `npm run build > /dev/null 2>&1`: approved execution exit0; no output captured.
- `npm run format:check` and `git diff --check`: final result recorded below after
  report formatting. No report/queue alteration is hidden by a failing gate.
- `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-03-owo1x4lx/after-final2.json`:
  exit0,38 rows. Production digest independently recomputed and matches this JSON;
  all final production changes, including directory replacement, are included.
  No stage00 baseline overwrite.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0, deliberately corrupted
  synthetic local bytes rejected (`oracle.log`).

## Rulings and limitations

Explicit approved stage03/current dirty checkout/no-commit/no-next-worker constraints
supersede skill worktree/branch/commit/plan-deletion/commit-ledger steps. This report
and exact source snapshot are the durable handoff. Only final read-only review was
delegated as required by the applied review skill; no other chat was messaged.
No settings, schemas, markers, crypto iterations, Direct Force locks-free publish,
recovery/FIFO/persistence or startup/realtime algorithm changed. Required optimization
is request selection/traversal, not a claim that local SHA reads can be skipped.

The all-mode synthetic runner retains its documented main/UI/scheduler/native-storage
coverage limits from reports00..02. Two independent in-memory device states and real
plaintext/encryption algorithms are covered; real Android/native Obsidian lifecycle,
real Yandex pagination/throttling/latency and manual two-profile convergence remain
PENDING. Build and364 automated cases do not establish release readiness.

Build artifact: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`
(733278 bytes at verification; generated output was not staged).

## Evidence identities

- `before.json` SHA-256: `c738ecd829a040ce8d7263fb2e292655c084c1c5bf315e6fc30ff14239fc9bc4`.
- `after-final2.json` SHA-256: `ba43faacdb900e1f1cded35f7165050e893f5d2f88987346806efab2aa82180f`.
- `repeat-final.json` SHA-256: `15664c98a69b290b87c0e99828f685337a42cd7709ff198ad6781a2c92b3dae7`.
- `comparison-final2.json` SHA-256: `44e30bbff31534ccb1efdd6523e9b139aeefaeb990896a95c23cdd623d3df575`.
- `incremental-final.patch` SHA-256: `bd511680d5d54acb3cd9cdec7ac05ca9222cd033fce05eaded40df6294d92144`.

## Final handoff verification

Final plain `npm run format:check`: exit0 (`format-check-final.log`);
`git diff --check`: exit0 (`diff-check-final.log`). All12 captured incremental
hashes match `incremental-final-identity.json`; all181 other captured files,
including historical fixtures and the immutable baseline, match the actual
starting bytes. Staged diff/index match byte-for-byte. The live owner queue
changed externally; this worker did not write it. Final production digest matches
`after-final2.json` and `repeat-final.json`; runner digest is unchanged. The
independent reviewer found no issues in the final directory-replacement delta.
Temporary formatter ignore is removed before handoff; report-only formatting and
plain checks are repeated after this note. No automated blocker remains for stage03.

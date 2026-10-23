# Stage 04 — baseline-only canonical admission

Status: `completed_automated`, ready for coordinator acceptance of stage04 only.
Native Android/iOS/Obsidian + two-profile real Yandex Disk smoke is **PENDING**.
No branch/worktree/reset/stage/commit/push, owner queue/automation mutation,
next-stage dispatch or other-chat message was performed.

Dispatch nonce: `6ee9c3d4-60c1-4bde-b490-5ec96307d513`.
Date: 2026-10-23, Europe/Moscow.

## Actual source boundary

- Branch: `codex/direct-force-sync`; HEAD unchanged:
  `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Actual starting dirty copy, not HEAD:
  `/private/tmp/sync-efficiency-04-3_7d_44g/`.
  `files/`, `identity.json`, `staged.patch`, `unstaged.patch`,
  `index-entries.txt`, `status.txt`, `head.txt` distinguish source/index/worktree.
  The snapshot covers196 source/test/doc/script/config files; live owner queue
  is excluded. No .env*, real plugin data, credentials or sensitive logs were read.
- Starting unstaged binary diff SHA-256:
  `d180e6dc41f4b23289b9df5ac04e880cb8d170de50f7c0d652ea03c9f02f30b9`.
- Staged binary diff unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable stage00 JSON unchanged:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Production before: `2fc7e6d9d81ceaa10df7958474364ece35c5abc855fdcbf2c5b616dd6a43f58c`.
- Production after: `544335caf0afe60acae97652e4d063fa6cecf259c7ada67574ae94b2042aae2e`.
- Runner+fixtures unchanged: `bb73c1ae00a111bae23b2f7925583118c817d9c7c80ddce0cc02dd800c8ddcb2`.
- Exact incremental9-file patch: `incremental-final.patch` in the scratch folder.
  SHA-256: `279c759d043d131ad42a4b95e7abd4ca76180f09e8885386c74fdc237bdcf467`.
  `incremental-final-identity.json` records before/after file SHA-256. This new
  report is excluded from its own patch. All187 other captured files, including
  historical fixtures and prerequisite reports, retain their original hashes.

Incremental files:

- `docs/ARCHITECTURE.md`
- `docs/E2E_ENCRYPTION.md`
- `docs/PARALLELIZATION.md`
- `docs/SMOKE_TESTS.md`
- `docs/SYNC_USER_SCENARIOS.md`
- `src/sync/canonical/manager.ts`
- `src/sync/workflows/full.ts`
- `tests/full-sync-barrier.test.ts`
- `tests/sync-user-flows.test.ts`

## Canonical dirty criterion and API handoff

`IndexManager.hasPendingCanonicalChanges()` owns the comparison with its private
loaded reducer snapshot. It compares the complete desired/loaded canonical JSON
through existing `sameIndexValue`: epoch/revision, file metadata, physical stamps,
folder tombstones, moves, watermarks, maintenance and lastSyncTime all participate.
It also retains every pending mutation (matching put/noop included), completedMoveIds,
replacement/legacy-write/physical-rewrite and target-recovery commit modes.
The method exposes a boolean, not a mutable loaded snapshot or a new domain model.

Ordinary full with its explicit `CanonicalReadSession` uses that criterion, retained
tombstone cleanup effect and conflict settlement. `result.downloaded`, other transfer
counters and local baseline changes never authorize skipping its canonical commit.
Any imported verified physical metadata, required watermark or conflict still takes
the existing transaction. Nonordinary callers without that session retain their
previous transfer-based commit/guard contract, including Force and encryption.
No reducer, recovery, schema, FIFO, settings/maxConcurrency or realtime change.

Before read-only completion, the existing coherent local save preserves applied
partial baselines and queues while observed revision/time remain unchanged. Then
a new session evaluation checks scope, manifest token, stable unlocked root, content
identity and config/lifetime generation, with fresh body download on drift/no hash.
The returned canonical must equal desired and no new causal work may have appeared.
Drift/maintenance change/config ABA/save failure cannot become a successful result.
The snapshot is not adopted as a newer observed version. Failure retains partial
baseline for retry; physical recovery and successful watcher finalize/observed save
remain behind their original boundaries. `updateSyncTime()` remains commit-only.

The already-committed delete path retains its final guard and original saves.
The new read-only branch is excluded after deletion intent commit. One intermediate
version added an unnecessary save and skipped that guard; final38-row evidence
confirms original deletion GET/body/MOVE/saves/state parity.

Fresh validation also runs for strict ordinary no-op, costing two metadata GETs.
This is an explicit safety cost. Service body transfers and mandatory saves stay
unchanged for no-op; do not describe this as a no-op acceleration.

## Functional RED / GREEN and negative controls

Default suite grows364→366, exactly two distinct functional cases; no helper-unit
matrix or existing test removal. Tests execute real project algorithms over
MemoryDisk, independent local states and independent initialized encryption codecs;
guarded encrypted reception has a valid current manifest from EncryptionManager.

- `ordinary reception keeps canonical read-only but commits pending FIFO acknowledgements`:
  RED before production edit: actual2 MOVEs, expected0 (`red.log`). GREEN in both
  codecs: published successor downloads, exact remote bytes and revision unchanged,
  local bytes and durable baseline/observed state correct, empty queues. Then a
  matching pending put uploads/downloads0 but performs2 MOVEs, advances exact device
  watermark/revision and persists queue settlement. Both devices converge.
- `ordinary reception preserves partial baselines on final drift and rejects failed saves across restart`:
  first RED after initial optimization: durable baseline stayed on old original bytes
  (`drift-red.log`). Saving partial baseline before fresh validation yields GREEN.
  A desktop successor commits at the receiver final-validation boundary: receiver
  fails, retains its applied partial baseline and old observed revision/time, then
  JSON restart receives the later version without a false conflict. Separate final
  manifest drift and token ABA also fail without receiver writes or ACK. First
  read-only-save failure cannot report success. Exact queues survive and real
  restart retries converge in both codecs (`boundaries-green.log`, final suite).
- Scratch esbuild negative mutations leave workspace source untouched: removing
  pending-mutation criterion fails matching FIFO case (0 vs2 MOVEs); removing desired
  canonical comparison fails both existing zero-sequence metadata/restart cases
  before their expected interrupted commit; removing final canonical equality gives
  false success at drift and fails the new receiver/restart case. See
  `negative-{pending,metadata,drift}-final.log`; each returns the intended assertion
  failure. `negative.mjs` contains the exact source transformations.
- Existing full barrier cases retain persistence-before-ACK/observed, failed pause,
  failed ACK/restart and epoch rollback boundaries. Its transport-free fake now
  captures an independent loaded baseline on load, as real IndexManager does.
  Four first-suite failures were traced to this missing fake behavior. A fifth
  exposed unscoped encryption preflight final guarding; the final optimization
  is explicitly ordinary-session-only. No product fallback was added.
- Existing physical metadata zero-sequence failed commit/lost publication/restart,
  ambiguous PUT, partial upload/FIFO, offline return, reordered events, conflict
  copies, Force/recovery and initial receive cases remain executable and GREEN.
  They were reused rather than duplicated in a helper matrix.
- First source-only type check exposed TS2683 in the new fake cast (`typeof this`);
  corrected to explicit SyncIndex. The first suppressed build exit2 reflected this
  real introduced compile error. Subsequent sandbox build exit1 / approved build0
  matches the execution restriction documented by earlier stages; it is not labelled
  as an unrelated source failure.

## Comparable all-mode evidence

Exact before and final JSON are `before.json` and `after-final2.json` in scratch;
`comparison-final.json` records every changed field, including time/overlap.
Runner payload/history, measurement boundaries and fixtures are byte-identical.
Every38 row passes exact byte/canonical/local baseline/queue and durable receipt
oracle. All result counts, receipt/event identity counts, local reads/bytes/phases,
persistence requests and revision deltas match before. Only two reception rows per
codec remove one lock-body GET and2 MOVEs; user bytes/transfers are unchanged.

All values are synthetic request costs, not native/mobile/Yandex latency.
Bulk stable-root scheduling varies on unchanged code: fresh before494/496 GET;
final494/498. Final encrypted extra2 GETs are fresh root observations only, not
a claimed regression fix or optimization. All body/byte/state/saves are identical.

C/M/L/U = native GET canonical/manifest/lock/user bodies. PUT = user/lock.
Bytes = total native GET/PUT. Unchanged fields appear once; arrows are before→after.
IDs are mutation/event identity counts, all row outcome flags are true.

| Scenario                      | Mode/limit | API GET   | GET C/M/L/U         | PUT U/L | GET/PUT bytes     | Local reads/bytes | Saves | MOVE/Δrev | Result U/D/D | IDs M/E |
| ----------------------------- | ---------- | --------- | ------------------- | ------- | ----------------- | ----------------- | ----- | --------- | ------------ | ------- |
| `token-initial-identical42`   | plain/20   | 23 → 25   | 3/0/0/0             | 0/0     | 59004/0           | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop42`                 | plain/20   | 9 → 11    | 1/0/0/0             | 0/0     | 19668/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `full-upload1`                | plain/20   | 43        | 1/0/2/0             | 1/1     | 59017/19695       | 43/429            | 3     | 2/1       | 1/0/0        | 1/0     |
| `full-upload42`               | plain/20   | 494       | 1/0/2/0             | 42/1    | 58972/20230       | 84/1240           | 3     | 2/1       | 42/0/0       | 43/0    |
| `full-download1`              | plain/20   | 29 → 15   | 1/0/1/1 → 1/0/0/1   | 0/0     | 39250/0 → 19635/0 | 46/676            | 2     | 2/0 → 0/0 | 0/1/0        | 43/0    |
| `full-local-delete1`          | plain/20   | 36        | 2/0/2/0             | 0/1     | 78572/19671       | 41/612            | 5     | 2/1       | 0/0/1        | 44/0    |
| `full-remote-delete1`         | plain/20   | 33        | 3/0/1/0             | 0/0     | 78932/0           | 44/654            | 4     | 2/0       | 0/0/1        | 44/0    |
| `full-followup-noop`          | plain/20   | 9 → 11    | 1/0/0/0             | 0/0     | 19733/0           | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `json-restart-full-noop`      | plain/20   | 18 → 20   | 3/0/0/0             | 0/0     | 59199/0           | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `realtime-edit1`              | plain/20   | 28        | 0/0/2/0             | 1/1     | 39349/19703       | 1/22              | 6     | 2/1       | —            | 1/1     |
| `realtime-edit42`             | plain/20   | 216       | 0/0/4/0             | 42/2    | 78551/40280       | 42/1040           | 10    | 4/2       | —            | 43/43   |
| `realtime-followup-full-noop` | plain/20   | 9 → 11    | 1/0/0/0             | 0/0     | 19610/0           | 42/1040           | 2     | 0/0       | 0/0/0        | 43/43   |
| `json-restart-pending-full1`  | plain/20   | 52        | 3/0/2/0             | 1/1     | 98051/19631       | 43/1056           | 4     | 2/1       | 1/0/0        | 44/44   |
| `json-restart-noop`           | plain/20   | 9 → 11    | 1/0/0/0             | 0/0     | 19611/0           | 42/1036           | 2     | 0/0       | 0/0/0        | 44/44   |
| `token-initial-empty42`       | plain/20   | 497 → 483 | 3/0/1/42 → 3/0/0/42 | 0/0     | 79082/0 → 59414/0 | 84/820            | 47    | 2/0 → 0/0 | —            | 0/0     |
| `initial-empty-followup-noop` | plain/20   | 9 → 11    | 1/0/0/0             | 0/0     | 19668/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `token-initial-identical42`   | enc/20     | 24 → 26   | 2/2/0/0             | 0/0     | 40524/0           | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop42`                 | enc/20     | 11 → 13   | 1/1/0/0             | 0/0     | 20262/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `full-upload1`                | enc/20     | 45        | 1/1/2/0             | 1/1     | 59667/19751       | 43/429            | 3     | 2/1       | 1/0/0        | 1/0     |
| `full-upload42`               | enc/20     | 496 → 498 | 1/1/2/0             | 42/1    | 59622/21434       | 84/1240           | 3     | 2/1       | 42/0/0       | 43/0    |
| `full-download1`              | enc/20     | 31 → 17   | 1/1/1/1 → 1/1/0/1   | 0/0     | 39900/0 → 20257/0 | 46/676            | 2     | 2/0 → 0/0 | 0/1/0        | 43/0    |
| `full-local-delete1`          | enc/20     | 38        | 2/1/2/0             | 0/1     | 79250/19699       | 41/612            | 5     | 2/1       | 0/0/1        | 44/0    |
| `full-remote-delete1`         | enc/20     | 35        | 3/1/1/0             | 0/0     | 79610/0           | 44/654            | 4     | 2/0       | 0/0/1        | 44/0    |
| `full-followup-noop`          | enc/20     | 11 → 13   | 1/1/0/0             | 0/0     | 20327/0           | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `json-restart-full-noop`      | enc/20     | 24 → 26   | 2/4/0/0             | 0/0     | 41786/0           | 40/598            | 3     | 0/0       | 0/0/0        | 44/0    |
| `realtime-edit1`              | enc/20     | 30        | 0/1/2/0             | 1/1     | 39971/19759       | 1/22              | 6     | 2/1       | —            | 1/1     |
| `realtime-edit42`             | enc/20     | 218       | 0/1/4/0             | 42/2    | 79229/41512       | 42/1040           | 10    | 4/2       | —            | 43/43   |
| `realtime-followup-full-noop` | enc/20     | 11 → 13   | 1/1/0/0             | 0/0     | 20204/0           | 42/1040           | 2     | 0/0       | 0/0/0        | 43/43   |
| `json-restart-pending-full1`  | enc/20     | 58        | 2/4/2/0             | 1/1     | 80817/19687       | 43/1056           | 5     | 2/1       | 1/0/0        | 44/44   |
| `json-restart-noop`           | enc/20     | 11 → 13   | 1/1/0/0             | 0/0     | 20205/0           | 42/1036           | 2     | 0/0       | 0/0/0        | 44/44   |
| `token-initial-empty42`       | enc/20     | 498 → 484 | 2/2/1/42 → 2/2/0/42 | 0/0     | 61806/0 → 42110/0 | 84/820            | 47    | 2/0 → 0/0 | —            | 0/0     |
| `initial-empty-followup-noop` | enc/20     | 11 → 13   | 1/1/0/0             | 0/0     | 20262/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/1    | 23 → 25   | 3/0/0/0             | 0/0     | 59004/0           | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/1    | 30 → 32   | 1/0/0/0             | 0/0     | 21278/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/20   | 23 → 25   | 3/0/0/0             | 0/0     | 59004/0           | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/20   | 30 → 32   | 1/0/0/0             | 0/0     | 21278/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/40   | 23 → 25   | 3/0/0/0             | 0/0     | 59004/0           | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/40   | 30 → 32   | 1/0/0/0             | 0/0     | 21278/0           | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |

`full-download1`: GET29/31→15/17, MOVE2→0, exact remote revision unchanged.
`token-initial-empty42`: GET497/498→483/484, MOVE2→0,42 required user downloads.
Identical token startup23/24→25/26 and established no-op9/11→11/13 due to
fresh final metadata validation. Realtime single/burst rows retain28/30 and
216/218 GET, all bodies/bytes/MOVEs/saves/results unchanged. Realtime follow-up
ordinary full inherits the documented no-op final validation cost.

## Commands and final gates

All scratch paths below use `/private/tmp/sync-efficiency-04-3_7d_44g/`.

- `npm run check:sync-efficiency -- --out .../before.json`: exit0,38 rows.
- `node .../focused.mjs`, then `node --test --test-name-pattern=... .../bundles/*.mjs`:
  focused RED/GREEN and barriers/physical-metadata GREEN recorded in safe synthetic logs.
- `npm run lint:fix`: exit0 (`lint-fix-final2.log`).
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-04-prettier-ignore`:
  exit0 (`format-final2.log`). Temporary ignore is repository-root-relative;
  `prettier --file-info` confirms queue and historical fixtures ignored before use.
  Foreign hashes checked after formatting; no foreign captured file changed.
- `npm test`: final366/366,0 failures/skips/cancelled (`suite-final2.log`).
- `npm run lint`: exit0 (`lint-final2.log`).
- `npm run build > /dev/null 2>&1`: final sandbox exit1, same required command
  through approved execution path exit0. stdout/stderr suppressed BEFORE capture.
  No build output or sensitive script input/output was inspected.
- `npm run format:check` with the same correct ignore paths: exit0 (`format-check.log`).
- `git diff --check`: exit0 (`diff-check.log`).
- `npm run check:sync-efficiency -- --out .../after-final2.json`: exit0,38 rows.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0, deliberate synthetic
  corruption rejected (`oracle.log`, byteOracleRejectsCorruption true).
- Final report formatting, foreign identity and staged/index preservation checks
  are recorded after review below.

Build artifact: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`.

## Scope, rulings and remaining evidence

- Existing dirty checkout is the authorized baseline. Generic skill worktree/commit/
  separate-ledger/delete instructions are superseded; this report and scratch patch
  provide durable continuity. No owner queue or automation edit.
- Keep generic legacy commit logic for nonordinary workflows. Direct Force/realtime/
  startup/crypto source, schemas, FIFO, maxConcurrency and SHA checks are unchanged.
  Startup ordinary-full reception naturally benefits without changing invocation wiring.
- Keep complete canonical comparison rather than a field/count allowlist; no new
  transaction reducer or recovery strategy. Pending matching puts still commit.
- Preserve partial baseline before final validation: otherwise proven restart can
  lose its durable relationship to already-written bytes. This save does not claim
  observed progress or acknowledge watcher work.
- Accept +2 metadata GETs for unchanged ordinary no-op to retain fresh validation.
  Do not attribute stable-root retry variation to guaranteed speed improvement.
- Automated evidence covers source-only real algorithms with synthetic transport,
  watcher ports, coherent fixture persistence, codecs and JSON restarts. It does not
  run native plugin load/unload, scheduler/Notice UI, actual PluginPersistence IO,
  Android/iOS, or two Obsidian profiles against real Yandex. All remain pending;
  release readiness and server fencing are not claimed.

Final read-only review: reviewer inspected the9-file incremental patch against
actual captured dirty bytes plus relevant production code and docs. No confirmed
Critical/Important/Minor findings. Reviewer independently reran4 focused functional
cases (two reception/FIFO/drift cases plus both metadata-refresh modes):4/4 PASS,
and checked the provided366/366 synthetic suite log. It did not review unrelated
inherited dirty changes or establish native/live-service behavior. No additional
production edit was made after review dispatch; only this report was finalized.
No deferred new minor or unresolved automated blocker.

Final preservation check: source digest independently recomputed and matches the
final38-row JSON; staged diff/index and immutable baseline retain exact hashes.
All9 changed captured files match incremental-final-identity.json; all187 foreign
captured files retain original hashes. Temporary root Prettier ignore is removed.
Final plain format check and diff check are recorded in the handoff files below.

# Stage 06 — realtime audit and tracked-source FIFO recovery

Stage result: **completed_automated**; coordinator acceptance is separate.
Date: 2026-10-23, Europe/Moscow. Dispatch nonce: `92e3d86b-a508-468a-b83e-43fe114e5e8b`.
Native Android/iOS/Obsidian and two-profile real Yandex Disk smoke: **PENDING**.
This report supersedes the earlier partial-blocked result: the tracked-source RED
was explicitly required to be fixed and is now GREEN in both codecs.

## Outcome and scope ruling

Healthy realtime already downloads zero canonical bodies. No proven safe GET or
body reduction remains inside its current window/drain ports. No speculative
cache, TTL, larger window, write parallelism or extra coordinator was introduced.
One edit remains 28/30 API GETs and burst42 remains 216/218 (plain/encrypted).
The substantive change fixes a reproduced FIFO gap for a modified tracked source
renamed inside its native PUT, including durable recovery after failed PUT or
canonical publication, later/reverted target bytes and interrupted recovery.

The original 38 diagnostic histories, payloads and outcome oracles are unchanged.
The supplemental 16 rows are separate, opt-in measurements over real algorithms,
actual watcher debounce/coordinator paths, two independent states and actual
plain/hardened codecs. The default suite remains 368 executable cases; existing
functional cases were extended rather than adding a test matrix.

## Actual dirty source and incremental ownership

The initial snapshot is `/private/tmp/sync-efficiency-06-k7uz3iht/`: `files/`,
`identities.json`, `staged.patch`, `unstaged.patch`, `index-entries.txt`, `status.txt`,
`head.txt` and `branch.txt`. It captures the actual dirty checkout, not HEAD alone.
Branch: `codex/direct-force-sync`; HEAD: `b4716a0e998d5927d783981d39ab88527ffc66aa`.
Prior Direct Force, initial-receive, inventory, canonical-session and startup work
is retained. No reset/staging/commit/push/worktree, queue/automation mutation,
next-worker creation or other-chat message was performed.

- Production after: `702388cb0cdb4020f89b595705bd79c627cd3ea39088f5271d929ea35af423f8`.
- Runner after: `f9d5f92ea4e3a609e58ac86ebcef9c6bbe63c147d5f19746697641adc2e1be19`.
- Supplemental helper: `f6206e6556ea9720f3cbf31a5619b90bb6b5eb7605072cb4b4239e7e1b62d120`.
- Incremental binary patch: `7a69ac7d87bb8bb5a9928f437ee37995d4d5d12dab53eb37ae715266f3348e43`.
- Incremental identity file: `23e054512118081154ca04e7bc074eb8849985ff0f81bdac453d853d815d4c4a`.
- Staged binary patch unchanged: `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged: `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable reports/00-baseline.json unchanged: `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Production before: `60f172c08f0303c19513d097b5af7a242bb51dbd19ac15927cb44133962472aa`.
- Runner before: `e981f0f325d2bc2b09347df7efd452a6e6575662a9a16418e7b905268a0e5c8e`.

`incremental.patch` and `incremental-identity.json` compare this stage to captured
files, including previously untracked files; they exclude this report and the
coordinator queue. All 181 other captured files are byte-identical, including
fixtures and reports 00–05. `final-identity.json` records these checks. Production
and runner digests use the original runner's ordered `[path, SHA-256]` algorithm.
The supplemental helper has its own digest and does not change the 38-row identity.

Incremental files:

- `docs/ARCHITECTURE.md`
- `docs/PARALLELIZATION.md`
- `docs/SMOKE_TESTS.md`
- `docs/SYNC_USER_SCENARIOS.md`
- `src/api/yandex-client.ts`
- `src/sync/engine.ts`
- `src/sync/files/rename.ts`
- `src/sync/realtime/batch.ts`
- `tests/file-rename.test.ts`
- `tests/full-sync-barrier.test.ts`
- `tests/helpers/sync-efficiency-realtime.ts`
- `tests/helpers/sync-efficiency.ts`
- `tests/sync-user-flows.test.ts`
- `tests/yandex-client.test.ts`
- `docs/superpowers/plans/sync-efficiency/reports/06-realtime.md` (this report).

## Confirmed RED, fix and recovery contract

The original `src/sync/realtime/batch.ts` hash is
`aa35e2bc9d0c0dd5ce513d6b68c443cbd13488832c75620e2b5e6ae6c40d4754`;
it is identical to the stage05 captured file. The fresh baseline and the
independent `review-probe.ts` reproduce the failure before this stage's fix:
modify tracked note, rename it inside native PUT, then drain actual watcher work.
The batch skipped staging source put seq1 as a handoff; rename staged move seq2.
The existing canonical merger correctly rejected `fifo-gap`. Local target bytes
and mutation/event identities survived JSON persistence, but neither codec
converged. The supplemental RED was 14 healthy rows plus 2 failed tracked rows.

`batch.ts` now retains a prepared/completed put when its canonical source is live;
it commits source seq1 and emits its accepted receipt before rename. A new unsynced
source retains the existing pending-put/coalesced handoff. The windows 32/8MiB,
sequential semantics, receipt IDs/reasons and accepted/recovered distinctions remain.

`files/rename.ts` recovers a durable tracked predecessor by stable plaintext SHA.
If upload bytes never arrived, only an unchanged canonical source or physical
absence with the exact next own seq permits rematerializing the frozen current
target under the same put ID/seq. Fresh scope/canonical/manifest and expected
physical fingerprint checks bracket attempts; actual read-back must match before
source metadata/commit/repair. A foreign physical source is not overwritten.
The source put is retained, never replaced by a noop. Existing obsolete target
puts may become noops, and interrupted recovery restages those same noops
idempotently. Only exact accepted actor/seq/SHA permits advancing rename base
revision. Restarted recovery preserves epoch, IDs/FIFO and coherent persistence.
No schema/marker/settings changes, migration or raw-content recovery cache.

The engine uses the existing read-session lifetime port without loading/caching
bodies. `YandexDiskClient.withWriteGuard` composes that invocation guard with the
existing remote write guard for file batches, single rename and rename batches;
unique callbacks are removed in `finally`. Checks directly before native PUT and
API write dispatch also cover retry and canonical rollback. An awaited authority
check cannot authorize a write after token ABA, pause/resume or host stop.
Ordinary full and Force keep their original paths outside these explicit scopes.

Independent review reproduced three relevant boundaries during implementation:
source-download token ABA, late precommit token ABA, and native PUT microtask
expiry. Initial probes allowed writes; final lifetime/dispatch checks prevent them.
`review-write-gap-green.mjs` returns `rejected:true, physicalWrite:false` versus
`physicalWrite:true` before its final synchronous dispatch check. Existing upload
authority test now preserves this exact asynchronous interaction.

Existing two-codec rapid-flow and rename-restart cases execute real transactions.
Restart histories include failed canonical commit, failure before user body,
latest target edit and target reverted to original bytes; interruptions cover
pause/resume, token ABA during source read and after source validation. They
assert no later writes, exact durable identities, restart convergence, independent
peer convergence and final no-op. Narrow transport fakes explicitly model the
new lifetime/write-scope ports; initial missing-port failures were introduced by
this change and corrected. No default case was removed or hidden.

## Comparable original 38 measurements

Fresh `before.json` predates edits. `after-final5.json` and
`after-final5-repeat.json` pass all 38 byte/canonical/baseline/FIFO/receipt oracles.
API means API GET wrapper counts, excluding native body transfers and writes.
Body column is GET canonical/manifest/lock. All rows have verified settled state.
The table uses the first final run; the repeat is retained separately.

| Scenario                    | Mode / concurrency | API before → after | Bodies C/M/L | Local reads / bytes | Saves | Revision delta |
| --------------------------- | ------------------ | ------------------ | ------------ | ------------------- | ----- | -------------- |
| token-initial-identical42   | plain / 20         | 25 → 25            | 1/0/0        | 168 / 1640          | 6     | 0              |
| full-noop42                 | plain / 20         | 11 → 11            | 1/0/0        | 42 / 410            | 2     | 0              |
| full-upload1                | plain / 20         | 43 → 43            | 1/0/2        | 43 / 429            | 3     | 1              |
| full-upload42               | plain / 20         | 494 → 497          | 1/0/2        | 84 / 1240           | 3     | 1              |
| full-download1              | plain / 20         | 15 → 15            | 1/0/0        | 46 / 676            | 2     | 0              |
| full-local-delete1          | plain / 20         | 36 → 36            | 2/0/2        | 41 / 612            | 5     | 1              |
| full-remote-delete1         | plain / 20         | 33 → 33            | 3/0/1        | 44 / 654            | 4     | 0              |
| full-followup-noop          | plain / 20         | 11 → 11            | 1/0/0        | 40 / 598            | 2     | 0              |
| json-restart-full-noop      | plain / 20         | 21 → 21            | 1/0/0        | 40 / 598            | 2     | 0              |
| realtime-edit1              | plain / 20         | 28 → 28            | 0/0/2        | 1 / 22              | 6     | 1              |
| realtime-edit42             | plain / 20         | 216 → 216          | 0/0/4        | 42 / 1040           | 10    | 2              |
| realtime-followup-full-noop | plain / 20         | 11 → 11            | 1/0/0        | 42 / 1040           | 2     | 0              |
| json-restart-pending-full1  | plain / 20         | 53 → 53            | 1/0/2        | 43 / 1056           | 4     | 1              |
| json-restart-noop           | plain / 20         | 11 → 11            | 1/0/0        | 42 / 1036           | 2     | 0              |
| token-initial-empty42       | plain / 20         | 483 → 483          | 1/0/0        | 84 / 820            | 47    | 0              |
| initial-empty-followup-noop | plain / 20         | 11 → 11            | 1/0/0        | 42 / 410            | 2     | 0              |
| token-initial-identical42   | encrypted / 20     | 25 → 25            | 1/1/0        | 168 / 1640          | 6     | 0              |
| full-noop42                 | encrypted / 20     | 13 → 13            | 1/1/0        | 42 / 410            | 2     | 0              |
| full-upload1                | encrypted / 20     | 45 → 45            | 1/1/2        | 43 / 429            | 3     | 1              |
| full-upload42               | encrypted / 20     | 496 → 498          | 1/1/2        | 84 / 1240           | 3     | 1              |
| full-download1              | encrypted / 20     | 17 → 17            | 1/1/0        | 46 / 676            | 2     | 0              |
| full-local-delete1          | encrypted / 20     | 38 → 38            | 2/1/2        | 41 / 612            | 5     | 1              |
| full-remote-delete1         | encrypted / 20     | 35 → 35            | 3/1/1        | 44 / 654            | 4     | 0              |
| full-followup-noop          | encrypted / 20     | 13 → 13            | 1/1/0        | 40 / 598            | 2     | 0              |
| json-restart-full-noop      | encrypted / 20     | 21 → 21            | 1/1/0        | 40 / 598            | 2     | 0              |
| realtime-edit1              | encrypted / 20     | 30 → 30            | 0/1/2        | 1 / 22              | 6     | 1              |
| realtime-edit42             | encrypted / 20     | 218 → 218          | 0/1/4        | 42 / 1040           | 10    | 2              |
| realtime-followup-full-noop | encrypted / 20     | 13 → 13            | 1/1/0        | 42 / 1040           | 2     | 0              |
| json-restart-pending-full1  | encrypted / 20     | 53 → 53            | 1/1/2        | 43 / 1056           | 4     | 1              |
| json-restart-noop           | encrypted / 20     | 13 → 13            | 1/1/0        | 42 / 1036           | 2     | 0              |
| token-initial-empty42       | encrypted / 20     | 483 → 483          | 1/1/0        | 84 / 820            | 47    | 0              |
| initial-empty-followup-noop | encrypted / 20     | 13 → 13            | 1/1/0        | 42 / 410            | 2     | 0              |
| initial-identical42-limit   | plain / 1          | 25 → 25            | 1/0/0        | 168 / 1640          | 6     | 0              |
| full-noop-uneven-deep       | plain / 1          | 32 → 32            | 1/0/0        | 42 / 410            | 2     | 0              |
| initial-identical42-limit   | plain / 20         | 25 → 25            | 1/0/0        | 168 / 1640          | 6     | 0              |
| full-noop-uneven-deep       | plain / 20         | 32 → 32            | 1/0/0        | 42 / 410            | 2     | 0              |
| initial-identical42-limit   | plain / 40         | 25 → 25            | 1/0/0        | 168 / 1640          | 6     | 0              |
| full-noop-uneven-deep       | plain / 40         | 32 → 32            | 1/0/0        | 42 / 410            | 2     | 0              |

All original realtime rows have identical non-timing counters before/after.
Full-upload42 root metadata varies across final runs: plain 273–274 versus 270
initially, encrypted 270–272 versus 270; every other counter and all outcomes match.
Do not describe this as an exact all-counter38-row match. A separate source-only
snapshot replay and root-call audit are retained below; no root guard was removed
to force stable counts. Synthetic elapsed/CPU is not provider or mobile latency.

One edit transfers one user payload, reads two lock bodies, writes one lock and
performs two MOVEs. Burst42 transfers 42 payloads through 32+10 windows, reads four
lock bodies, writes two locks and performs four MOVEs. Local reads/bytes are 1/22
and 42/1040; coherent saves 6 and 10. Encrypted payload bytes add the real codec's
28-byte framing per file. Canonical bodies remain 0; encrypted manifest is 1 per
independent batch invocation. These are necessary measured transactions, not
newly eliminated work. Per-file stamp and accepted-repair checks, fresh root/
scope/manifest authority, read-back, durable save and ACK remain required.

| Realtime row    | Mode      | User PUT bytes | Lock GET / PUT bytes | Manifest GET bytes |
| --------------- | --------- | -------------- | -------------------- | ------------------ |
| realtime-edit1  | plain     | 22             | 39349 / 19681        | 0                  |
| realtime-edit42 | plain     | 1040           | 78551 / 39240        | 0                  |
| realtime-edit1  | encrypted | 50             | 39405 / 19709        | 566                |
| realtime-edit42 | encrypted | 2216           | 78663 / 39296        | 566                |

## Supplemental16 boundary measurements

`boundaries-final.json` is the preserved RED; `boundaries-final5.json` and
`boundaries-final5-repeat.json` are GREEN 16/16 (`success:true`). They use the same
payload/history definitions. Counters exclude before/after outcome oracle reads.
Failed offline PUT attempt is recorded in requests, with no successful user body;
2 events/mutations remain durable and no later suffix is written. JSON restart
uploads both; following full returns 0/0/0 with unchanged canonical/physical bytes.

| Scenario                         | Mode      | API RED → GREEN | Bodies C/M/L | Local reads / bytes | Saves | Receipt / outcome              |
| -------------------------------- | --------- | --------------- | ------------ | ------------------- | ----- | ------------------------------ |
| realtime-edit-same-path-debounce | plain     | 28 → 28         | 0/0/2        | 1 / 10              | 6     | accepted-put:1                 |
| realtime-edit-late-successor     | plain     | 56 → 56         | 0/0/4        | 2 / 28              | 12    | accepted-put:2, accepted-put:3 |
| realtime-edit-rename-handoff     | plain     | 47 → 47         | 2/0/2        | 2 / 32              | 10    | pending-put:4                  |
| realtime-edit-rename-after-ack   | plain     | 85 → 85         | 2/0/6        | 2 / 42              | 11    | accepted-put:5                 |
| offline-stopped                  | plain     | 4 → 4           | 0/0/0        | 2 / 27              | 2     | durable remainder              |
| restart-offline-full             | plain     | 65 → 65         | 1/0/2        | 45 / 479            | 4     | settled/no-op                  |
| boundary-followup-full-noop      | plain     | 12 → 12         | 1/0/0        | 43 / 452            | 2     | settled/no-op                  |
| realtime-edit-same-path-debounce | encrypted | 30 → 30         | 0/1/2        | 1 / 10              | 6     | accepted-put:1                 |
| realtime-edit-late-successor     | encrypted | 60 → 60         | 0/2/4        | 2 / 28              | 12    | accepted-put:2, accepted-put:3 |
| realtime-edit-rename-handoff     | encrypted | 51 → 51         | 2/2/2        | 2 / 32              | 10    | pending-put:4                  |
| realtime-edit-rename-after-ack   | encrypted | 89 → 89         | 2/2/6        | 2 / 42              | 11    | accepted-put:5                 |
| offline-stopped                  | encrypted | 6 → 6           | 0/1/0        | 2 / 27              | 2     | durable remainder              |
| restart-offline-full             | encrypted | 65 → 65         | 1/1/2        | 45 / 479            | 4     | settled/no-op                  |
| boundary-followup-full-noop      | encrypted | 14 → 14         | 1/1/0        | 43 / 452            | 2     | settled/no-op                  |
| tracked-modified-handoff         | plain     | 32 → 88         | 2/0/6        | 2 / 48              | 11    | accepted-put:1                 |
| tracked-modified-handoff         | encrypted | 36 → 92         | 2/2/6        | 2 / 48              | 11    | accepted-put:1                 |

Tracked-source API 32/36 before versus 88/92 after compares failure with completed
source commit + rename transactions, not equivalent successful work. GREEN asserts
accepted source receipt with original event/mutation ID, watermark 2, final bytes,
empty queues, JSON restart, independent peer and no-op. These additional required
transactions must not be removed as an efficiency regression. The two final runs
have identical API/body/local/save counters on all 16 supplemental rows.

For healthy realtime supplemental actions, actual codec decrypt calls remain
plain 0 and encrypted 3/6/7/11 (debounce/successor/new-source handoff/after-ACK rename).
These include lock/user reads and private validated-context work, not only
canonical reads. Process CPU is measured only inside the action, excluding outcome
oracles; report milliseconds of user+system CPU below. It is noisy, not a speedup
claim. Main38 and recovery rows do not provide an isolated CPU/heap measurement.

| Action                           | Mode      | CPU before ms | CPU final first / repeat ms | Decrypts before → final |
| -------------------------------- | --------- | ------------- | --------------------------- | ----------------------- |
| realtime-edit-same-path-debounce | plain     | 16.89         | 18.00 / 14.83               | 0 → 0                   |
| realtime-edit-late-successor     | plain     | 43.39         | 24.65 / 18.21               | 0 → 0                   |
| realtime-edit-rename-handoff     | plain     | 65.30         | 19.48 / 19.67               | 0 → 0                   |
| realtime-edit-rename-after-ack   | plain     | 64.02         | 26.21 / 26.18               | 0 → 0                   |
| realtime-edit-same-path-debounce | encrypted | 12.75         | 10.38 / 13.14               | 3 → 3                   |
| realtime-edit-late-successor     | encrypted | 49.83         | 20.20 / 20.59               | 6 → 6                   |
| realtime-edit-rename-handoff     | encrypted | 64.58         | 15.85 / 19.12               | 7 → 7                   |
| realtime-edit-rename-after-ack   | encrypted | 88.71         | 28.23 / 26.10               | 11 → 11                 |

## Evidence and reproducible checks

All paths below are under `/private/tmp/sync-efficiency-06-k7uz3iht/` unless noted.
Synthetic fixtures only; no real vault, credentials or user/service logs were read.

- `suite-before.log`: 368/368 before. `fifo-red.log`: two original rapid-flow REDs;
  `restart-red.log`, `restart-body-red.log`, `restart-commit-red.log`: recovery
  counterexamples before their fixes. `suite-final5.log`: 368/368, zero skipped.
- `review-probe.ts`, `review-restart.ts`, `review-config.ts`,
  `review-reverted-target.ts`, `review-config-commit.ts`, `review-write-gap.ts`:
  independent source-only reproductions. GREEN logs/artifacts preserve concrete
  config/lifetime/dispatch results; final scoped static review found no confirmed
  remaining Important issues. This does not establish native behavior.
- `npm run check:sync-efficiency -- --out <fresh.json>`: original 38 both modes,
  exit0 twice; `before.json`, `after-final5.json`, `after-final5-repeat.json`.
- `npm run check:sync-efficiency -- --realtime-boundaries --out <fresh.json>`:
  supplemental 16 both modes, exit0 twice. Expected RED remains separate.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0;
  `oracle-final5.log` confirms deliberate corruption is rejected by byte oracle.
- `npm run lint:fix`: exit0 (`lint-fix-final5.log`). Full `npm run format`:
  exit0 (`format-final5.log`); formatter changes inspected against initial hashes.
- `npm test`: exit0 (`suite-final5.log`). `npm run lint`: exit0 (`lint-final5.log`).
- `npm run build`: exit0 through approved execution path, stdout/stderr redirected
  to `/dev/null` before capture. Includes TypeScript and production esbuild;
  output `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`.
  Earlier sandbox failure was a sandbox restriction, not a build diagnostic.
- `npm run format:check` with existing ignore files and temporary explicit excludes
  for coordinator queue and fixtures: exit0 (`format-check-final5.log`). Temporary
  root ignore is removed before handoff; queue and fixtures were not formatted.
- `git diff --check`: exit0. Staged/index/baseline00 hashes and181 foreign captured
  files verified after final source/test formatting. Report formatting is checked
  separately after writing; incremental patch intentionally excludes report itself.

Root metadata audit: `root-audit.ts`, `root-audit-before.mjs` and
`root-audit-after.mjs` run the unchanged plain histories with synchronous caller
counting. Before bundle loads only `src/` bytes from captured `files/` via esbuild
onLoad; it does not reset/swap the checkout. Caller category counts match, including
172 stable-root discovery GETs, and total root 270 for full-upload42 in each.
`before-replay.json` additionally runs both modes against captured production
without caller instrumentation: full-upload42 remains 494/496 API and root270
in plain/encrypted mode. Its embedded filesystem identity reflects the
current checkout and is NOT proof of loaded baseline source; the explicit esbuild
snapshot loader and initial source digest define that replay. Root-read variance
is recorded rather than inferred to be a proven regression or erased by caching.

## Remaining evidence boundary and handoff

Normative scenario `SYNC-049`, architecture, parallelization and native smoke
instructions describe the final contracts. E2E encryption/backup/conflict docs
retain their existing invariants; no archive, encryption transition or destructive
Force behavior was changed. Mandatory saves, backups, fingerprints, markers,
canonical epoch/revision and persisted physical-action schema remain.

Real two-profile Obsidian/Yandex, Android/iOS, startup/scheduled lifecycle and native
stop/unload races remain manual evidence gaps. Automated simulated lifecycle and
plain/encrypted convergence do not establish release readiness. No live service
experiments or release publication were performed. Coordinator can inspect this
report, incremental patch/identities and GREEN artifacts, then accept stage 06 and
continue its queue. This worker does not edit queue state or dispatch stage 07.

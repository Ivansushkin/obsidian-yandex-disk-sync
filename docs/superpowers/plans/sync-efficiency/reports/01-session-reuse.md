# Stage 01 — invocation-bound canonical and manifest reuse

Status: `completed_automated`, ready for coordinator acceptance. Only stage01 was
implemented. No commit, staging, branch/worktree/reset, push, dispatch, automation
or queue mutation was performed. Real Android/native Obsidian + two-profile
Yandex smoke is **PENDING**; synthetic results do not establish a release.

Dispatch nonce: `f9f19234-a9cd-423f-a108-c15cb8339c08`.
Date: 2026-10-23, Europe/Moscow.

## Source and incremental boundary

- Branch: `codex/direct-force-sync`; unchanged HEAD:
  `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Pre-stage snapshot: `/private/tmp/sync-efficiency-01-3vdlwdy6/`.
  `files/` contains the actual starting working-copy bytes; `identity.json`,
  `staged.patch`, `unstaged.patch`, `index-entries.txt`, `status.txt`, `head.txt`
  preserve the dirty baseline. It is not equivalent to HEAD.
- Staged binary diff unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable stage00 JSON unchanged:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Exact incremental binary patch, excluding this report and live owner queue:
  `/private/tmp/sync-efficiency-01-3vdlwdy6/incremental-final.patch`.
  SHA-256: `d4416963614ffbca82e4d8b751acb0166555a8cc51a9a50e4fdd17ef9ce1aa1e`.
  Per-file final hashes: `incremental-identity.json` in that directory.
- Production digest before:
  `33a9c0870fd854ee59269edcec5db68280a2f04ff082c4b42d58a3d7fa8cb70e`.
- Production digest after:
  `dc94ce38ac59eb10c2241b7837a8548cafb2ef28a94f438eaf2956bf01ac2cca`.
- Runner+fixture digest unchanged:
  `c692b92b3cc8d9e103c60dab8b0e9e623c141246e99e1d3cf7cc171c79f48de0`.
  No runner, payload, fixture history, observer, schema or measurement boundary
  was changed. Source digest uses the stage00 runner's ordered path/hash method.

Incremental changed files (all other initially captured source/test/doc bytes
remain unchanged; historical fixtures checked separately):

- `docs/ARCHITECTURE.md`
- `docs/E2E_ENCRYPTION.md`
- `docs/PARALLELIZATION.md`
- `docs/SMOKE_TESTS.md`
- `docs/SYNC_USER_SCENARIOS.md`
- `src/main.ts`
- `src/sync/canonical/manager.ts`
- `src/sync/engine.ts`
- `src/sync/files/operations.ts`
- `src/sync/reconciliation/accepted-uploads.ts`
- `src/sync/workflows/full.ts`
- `tests/full-sync-barrier.test.ts`
- `tests/sync-user-flows.test.ts`

The owner queue changed during this stage only in `waitCursor` from suffix `:1`
to `:2`. This worker did not write it. Correct root-relative Prettier exclusions
were checked with `--file-info` (`ignored: true`) for queue and fixtures before
formatting. Queue bytes stayed unchanged between the explicit final exclusion
snapshot and the subsequent verification; historical fixture hashes stayed
identical throughout. A temporary root ignore file is removed before handoff.

## Implementation and safety

`CanonicalReadSession` extends the existing callable read with `load()` and
`assertCurrent()`. `load()` obtains the actual verified `IndexFileSnapshot` and
keeps it private; desired and loaded reducer state receive independent clones.
Caller-provided indexes cannot seed it. Returned snapshots are clones.
`loadRemoteIndex()` keeps its independent legacy/maintenance callers and view
semantics through shared load/adoption helpers.

Ordinary full creates one session inside its admitted coordinator invocation and
passes it and admission manifest token through explicit full/file-operation
ports. There is no engine-global byte cache, TTL, persisted proof or new store.
Every read still obtains fresh scope and fully stable root observations, locks
and server content identity. Matching SHA-256/MD5 and no locks are required for
reuse. Drift/no hash keeps the stable native download plus post-transfer metadata;
resource ID alone never permits reuse. Sequential observation tail avoids duplicate
first downloads; a rejected read also rejects queued reads. Independent reads and
later full invocations download their own snapshots.

Client config generation covers token/path/codec ABA. Manager generation also
covers transition-codec and settings-path changes. Session checks bracket awaited
load/discovery/download work. Full additionally checks coordinator identity,
pause generation (including pause/resume ABA), and a host stop getter. Main only
wires `unloaded || persistence.failed` to that getter. Full rechecks lifetime
between scan/apply and before returning, and pre-PUT checks lifetime after physical
metadata. Late native responses cannot seed a failed load or revive its queue.

Before-PUT/retry/ambiguous-readback canonical, manifest and expected physical
fingerprint checks remain. An ordinary read snapshot is not `CanonicalCommitProof`
or permission to overwrite. Required lock-body reads/transactions remain. Repair
first obtains fresh physical metadata; a matching accepted fingerprint needs no
local bytes. A mismatch still reads/hashes local bytes and uses fresh independent
canonical, codec and physical authority before corrective write. No local safety
hash, mandatory save, backup or FIFO guard was deleted.

Direct Force and its recovery/publication modules, realtime algorithms, initial
receive's existing independently guarded read session, persisted schemas/markers,
epoch/revision rules, settings 1..40/default20 are unchanged. Maintenance/Force
callers do not opt into ordinary-full reuse. Documentation adds `SYNC-041/042`
and updates architecture, parallelization, encryption and pending smoke cases.

## Minimal functional RED/GREEN and review

- Real baseline runner: all38 outcome rows passed, then a separate acceptance
  assertion failed with canonical85/manifest43 for bulk42. Before/immutable
  baseline counts/bytes/state match, excluding scheduling-dependent timing/overlap.
- New two-device functional test
  `ordinary full reuses verified service bytes and avoids healthy repair reads across two devices`
  failed on unmodified production: `canonical bodies: 85` (`red.log`). GREEN
  exercises plaintext and two initialized encrypted codecs with a valid current
  manifest, transfers42 updates, verifies both devices' plaintext/canonical/local
  baselines and durable empty queues, then follow-up no-op. It also rejects local
  byte reads on the healthy post-commit repair path.
- Existing read-session cases now begin with actual `load()`, mutate both caller
  and desired views, perform concurrent guards, independent reads, SHA/MD5/no-hash,
  foreign canonical updates and ambiguous locks. No duplicated helper test matrix.
- Existing config test adds first-load body and transition ABA boundaries, proves
  no late desired-state adoption and poisoned subsequent reads. New full case
  checks first-body pause/resume or host-stop rejection with unchanged bytes,
  observed revision/time and empty queues in plaintext/encrypted modes.
- Targeted negative-oracle bundles removed one new guard each, without modifying
  workspace source: transition generation (`transition-red.log`), pause generation
  (`pause-red.log`), host stop (`host-stop-red.log`) each failed on the intended
  missing rejection/false-success assertion. Guarded source passes. These are
  synthetic lifecycle ports, not actual Android/native plugin unload evidence.
- Existing timeout/restart, ambiguous PUT/revoked authority, corrective conflict
  repair/lost response, offline return and Direct Force tests remain in the full
  default suite. No cases were hidden or removed.
- First full suite was356/363: seven full-barrier fake failures were introduced by
  the new transport-backed session entry point. Root cause was an intentionally
  transport-free subclass inheriting real `createCanonicalReadSession()`. Its
  narrow fake now supplies the load/read/lifetime port over existing fake methods;
  production has no capability fallback. Subsequent suite363/363. This was not
  classified as an unrelated failure.
- Independent fresh-context read-only review of the incremental patch found no
  Critical/Important/Minor issues. Review was static; it did not supply runtime
  or live-service evidence. No review-driven second implementation pass needed.

Evidence files are synthetic test output under the snapshot directory. No .env*,
real plugin data, credentials or sensitive logs were read. Build output was
redirected to `/dev/null` before capture.

## Comparable before/after measurements

Exact38-row JSON: `before.json` and `after-final.json` in the snapshot directory;
full field-by-field comparison: `comparison.json`. Each contains API category
breakdown, metadata/link vs native transfers, per-kind transfer bytes, local
reads/bytes by phase, persistence, peak reads/user metadata/directories and
controlled synthetic elapsed time. All38 rows retain identical outcome flags,
result counts, receipt identity invariants/counts, user transfers, persistence, MOVE and revision
delta. Realtime-edit rows are identical except synthetic time/overlap.

`before.json` SHA-256: `cd2ad7818c2bb787f004571dc470167d33b04e1466b838851b74efb974572e97`.
`after-final.json` SHA-256: `87ba85d5ec8246eb473884da5e1e14ca5404baaacc4caf65430a0868a9dc647b`.
`comparison.json` SHA-256: `4ba45e8d52304a52f2177d22cf4722c2653eca9c2e13ce312a5202c9f7e7c41b`.

In each cell, `before → after`; unchanged values appear once. C/M/L/U are native
GET bodies canonical/manifest/lock/user. Lock bodies are explicitly separate.
All numbers are synthetic project-algorithm measurements, not mobile latency.

| Scenario / mode / limit                    | API GET    | C/M/L/U GET         | Local reads / bytes | Saves | MOVE / revision Δ |
| ------------------------------------------ | ---------- | ------------------- | ------------------- | ----- | ----------------- |
| `token-initial-identical42` / plain / 20   | 82         | 3/0/0/0             | 168/1640            | 6     | 0 / 0             |
| `full-noop42` / plain / 20                 | 12 → 10    | 1/0/0/0             | 42/410              | 2     | 0 / 0             |
| `full-upload1` / plain / 20                | 56 → 50    | 3/0/2/0 → 1/0/2/0   | 44/443 → 43/429     | 3     | 2 / 1             |
| `full-upload42` / plain / 20               | 917 → 787  | 85/0/2/0 → 1/0/2/0  | 126/1860 → 84/1240  | 3     | 2 / 1             |
| `full-download1` / plain / 20              | 32 → 30    | 1/0/1/1             | 46/676              | 2     | 2 / 0             |
| `full-local-delete1` / plain / 20          | 40 → 38    | 2/0/2/0             | 41/612              | 5     | 2 / 1             |
| `full-remote-delete1` / plain / 20         | 38 → 36    | 3/0/1/0             | 44/654              | 4     | 2 / 0             |
| `full-followup-noop` / plain / 20          | 12 → 10    | 1/0/0/0             | 40/598              | 2     | 0 / 0             |
| `json-restart-full-noop` / plain / 20      | 21 → 19    | 3/0/0/0             | 40/598              | 2     | 0 / 0             |
| `realtime-edit1` / plain / 20              | 28         | 0/0/2/0             | 1/22                | 6     | 2 / 1             |
| `realtime-edit42` / plain / 20             | 216        | 0/0/4/0             | 42/1040             | 10    | 4 / 2             |
| `realtime-followup-full-noop` / plain / 20 | 12 → 10    | 1/0/0/0             | 42/1040             | 2     | 0 / 0             |
| `json-restart-pending-full1` / plain / 20  | 65 → 59    | 5/0/2/0 → 3/0/2/0   | 44/1076 → 43/1056   | 4     | 2 / 1             |
| `json-restart-noop` / plain / 20           | 12 → 10    | 1/0/0/0             | 42/1036             | 2     | 0 / 0             |
| `token-initial-empty42` / plain / 20       | 1010       | 3/0/1/42            | 84/820              | 47    | 2 / 0             |
| `initial-empty-followup-noop` / plain / 20 | 12 → 10    | 1/0/0/0             | 42/410              | 2     | 0 / 0             |
| `token-initial-identical42` / enc / 20     | 83         | 2/2/0/0             | 168/1640            | 6     | 0 / 0             |
| `full-noop42` / enc / 20                   | 14 → 12    | 1/1/0/0             | 42/410              | 2     | 0 / 0             |
| `full-upload1` / enc / 20                  | 60 → 52    | 3/2/2/0 → 1/1/2/0   | 44/443 → 43/429     | 3     | 2 / 1             |
| `full-upload42` / enc / 20                 | 1003 → 790 | 85/43/2/0 → 1/1/2/0 | 126/1860 → 84/1240  | 3     | 2 / 1             |
| `full-download1` / enc / 20                | 34 → 32    | 1/1/1/1             | 46/676              | 2     | 2 / 0             |
| `full-local-delete1` / enc / 20            | 42 → 40    | 2/1/2/0             | 41/612              | 5     | 2 / 1             |
| `full-remote-delete1` / enc / 20           | 40 → 38    | 3/1/1/0             | 44/654              | 4     | 2 / 0             |
| `full-followup-noop` / enc / 20            | 14 → 12    | 1/1/0/0             | 40/598              | 2     | 0 / 0             |
| `json-restart-full-noop` / enc / 20        | 27 → 25    | 2/4/0/0             | 40/598              | 3     | 0 / 0             |
| `realtime-edit1` / enc / 20                | 30         | 0/1/2/0             | 1/22                | 6     | 2 / 1             |
| `realtime-edit42` / enc / 20               | 218        | 0/1/4/0             | 42/1040             | 10    | 4 / 2             |
| `realtime-followup-full-noop` / enc / 20   | 14 → 12    | 1/1/0/0             | 42/1040             | 2     | 0 / 0             |
| `json-restart-pending-full1` / enc / 20    | 73 → 65    | 4/5/2/0 → 2/4/2/0   | 44/1076 → 43/1056   | 5     | 2 / 1             |
| `json-restart-noop` / enc / 20             | 14 → 12    | 1/1/0/0             | 42/1036             | 2     | 0 / 0             |
| `token-initial-empty42` / enc / 20         | 1011       | 2/2/1/42            | 84/820              | 47    | 2 / 0             |
| `initial-empty-followup-noop` / enc / 20   | 14 → 12    | 1/1/0/0             | 42/410              | 2     | 0 / 0             |
| `initial-identical42-limit` / plain / 1    | 82         | 3/0/0/0             | 168/1640            | 6     | 0 / 0             |
| `full-noop-uneven-deep` / plain / 1        | 33 → 31    | 1/0/0/0             | 42/410              | 2     | 0 / 0             |
| `initial-identical42-limit` / plain / 20   | 82         | 3/0/0/0             | 168/1640            | 6     | 0 / 0             |
| `full-noop-uneven-deep` / plain / 20       | 33 → 31    | 1/0/0/0             | 42/410              | 2     | 0 / 0             |
| `initial-identical42-limit` / plain / 40   | 82         | 3/0/0/0             | 168/1640            | 6     | 0 / 0             |
| `full-noop-uneven-deep` / plain / 40       | 33 → 31    | 1/0/0/0             | 42/410              | 2     | 0 / 0             |

Bulk42 in both modes: canonical85→1 (plus unchanged2 lock bodies), encrypted
manifest43→1, local126→84;42 required uploads remain. API GET917→787 plaintext,
1003→790 encrypted. One upload canonical3→1; encrypted manifest2→1, local44→43.
Initial/token rows retain their prior costs; startup admission and initial receive
were not folded into this session. Deep-tree no-op directory overlap remains
1/6/6 for limits1/20/40; no new concurrency cap. For native transfer bytes, only
unneeded canonical/manifest bodies are removed; exact values remain in JSON.

## Commands and validation results

All paths below are under `/private/tmp/sync-efficiency-01-3vdlwdy6/` unless stated.

- `npm run check:sync-efficiency -- --out .../before.json`: exit0,38 rows.
- `node` scratch acceptance assertion on before JSON: exit1, expected RED.
- Focused esbuild+`node --test --test-name-pattern=... focused.mjs`: four affected
  functional/session cases GREEN before the complete suite; negative guard bundles
  each exit1 as intended. See `red.log`, `green-boundaries.log`, `*-red.log`.
- `npm run lint:fix`: exit0 (`lint-fix.log`).
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-01-prettier-ignore`:
  exit0 (`format.log`), correctly rooted queue/fixture exclusions verified first.
- `npm test`: final363/363, zero failed/skipped/cancelled (`suite-final.log`).
  Original361 remain plus two distinct functional cases.
- `npm run lint`: exit0 (`lint.log`).
- `npm run build > /dev/null 2>&1`: sandbox exit1; approved execution path exit0.
  As at stage00, this is an execution restriction; no compilation failure was
  established. stdout/stderr was suppressed before capture for both attempts.
- `npm run format:check` with the same three ignore paths: exit0
  (`format-check.log`); final plain check after report formatting recorded below.
- `git diff --check`: exit0.
- `npm run check:sync-efficiency -- --out .../after-final.json`: exit0,38 rows.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0, deliberate synthetic
  byte corruption rejected (`oracle-final.log`).
- Final report/foreign-hash checks: recorded in final verification below.

Build artifact: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`.
Build/automated success does not prove native Obsidian behavior.

## API handoff and rulings

- `IndexManager.createCanonicalReadSession(assertActive?)` returns callable
  `CanonicalReadSession`; `await session()` performs a fresh authority observation
  and returns a clone. `await session.load(allowEpochAdoption?)` owns verified load,
  independent desired/loaded adoption and private seeding. It accepts no index.
  `session.assertCurrent()` only checks config/lifetime, performs no remote I/O,
  and never substitutes for fresh remote authority.
- `fileOperations.Dependencies.canonicalReadSession?` and `.validationToken?`
  are ephemeral explicit invocation ports. Only ordinary full wires them now.
  Required guards stay inside `executeOperationsParallel` upload callbacks.
- `SyncEngine` optional fifth constructor argument `isStopped` is a live host
  getter. Main wires unload/persistence failure; default preserves existing
  source-only consumers. Full's captured coordinator/pause identity is private
  per invocation. Do not use this as a second coordinator or persistent cache.
- Stage02 can extend the fresh root result and pass composite observations through
  scope/manifest/canonical validators. This stage intentionally leaves all those
  independent fresh checks and the initial-receive session intact. Preserve the
  immutable runner and use fresh JSON output for further comparisons.
- Ruling: execute only this approved brief in the current dirty checkout; skill
  worktree/commit/plan-directory deletion steps are superseded by explicit user
  constraints. Durable continuity is this report plus the captured incremental
  patch. No broad cleanup or next-stage work was performed.
- Deferred pre-existing minor: runner `--only` without value remains unchanged,
  as explicitly requested. No new review minors or unresolved automated blocker.
- Native Android/Obsidian + real two-profile Yandex smoke remains pending.

## Final verification

Final plain `npm run format:check`: exit0 (`format-check-final.log`);
`git diff --check`: exit0. All13 captured incremental files match
`incremental-identity.json`; no unrelated captured file or historical fixture
changed. Staged diff/index, immutable baseline and runner digest remain unchanged.
Temporary formatter ignore removed; build/main.js exists. Owner-only cursor
update is disclosed above and was not reverted.

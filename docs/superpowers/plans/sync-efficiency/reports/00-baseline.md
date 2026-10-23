# Stage 00 — reproducible sync baseline

Baseline implementation and measurements are complete. Coordinator acceptance is
required because a formatter invocation inadvertently reformatted coordinator-owned
queue.json. No stage/status/cursor changes were authored by this worker; the
coordinator also updated that file during the run. Original untracked queue bytes
were not captured, so the worker did not guess a byte-for-byte rollback. See the
incident below. No production behavior, branch, staging, commit, push or automation
changes were made. Real Obsidian/Android/Yandex validation remains pending.

Dispatch nonce: `660330f4-7eef-4108-8d3a-a8034b546f99`.
Date: 2026-10-23, Europe/Moscow.

## Source boundary and preserved work

- Branch before/after: `codex/direct-force-sync`.
- HEAD before/after: `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Original snapshot: `/private/tmp/sync-efficiency-00-fy_aukvx/`.
  `staged.patch` and `unstaged.patch` contain binary diffs; `status.txt`,
  `untracked.txt`, `index-entries.txt`, `identity.json` distinguish HEAD/index/worktree.
  `identity-after.json` contains the final identities of the diagnostic files.
- Index entries SHA-256, unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Staged binary diff SHA-256, unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Original unstaged binary diff SHA-256:
  `2b95561ca765a0fb2e643add49c2623ae71f3cd9a7f178a3fa5641adf2cd68e6`.
- Final tracked unstaged binary diff SHA-256:
  `ea02c8d6cc08b1783ee72815e2289e232c26b18e10af916cc24c4a5b077e1d45`.
  This hash excludes new untracked diagnostic/report files; use runner identity too.
- Every initially tracked `src/` file is byte-identical to its original snapshot.
  Thus staged Direct Force direct-v1, unstaged mobile initial receive,
  `maxConcurrency` 1..40/default20 and schemas remain intact. Existing test
  reductions remain intact; default test count is still 361.
- Tracked changes relative to the initial working copy are limited to
  `package.json`, `test.config.mjs`, and two observer lines in
  `tests/helpers/sync-flow.ts`. New intended files are the runner, diagnostic, shared
  Obsidian stub, and this report/aggregate JSON. The untracked queue also received
  unintended formatting as disclosed below. No dependency was added.

An initial identity command attempted `git write-tree`, which requires an index
lock and was rejected by the sandbox. It was not retried. The snapshot instead
uses read-only `git ls-files --stage`; final index/diff hashes prove preservation.

## Runner contract

```bash
npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-after.json
npm run check:sync-efficiency -- --only plain --out /private/tmp/sync-efficiency-plain.json
npm run check:sync-efficiency -- --only encrypted --out /private/tmp/sync-efficiency-encrypted.json
npm run check:sync-efficiency -- --verify-oracle
```

Use a fresh output filename: `--out` uses exclusive creation (`wx`) and never
overwrites a baseline. Paths are caller-selected. No scratch imports or private
method patches are used. The script bundles real source to a fresh temporary
folder with esbuild, uses the same extracted Obsidian stub as `npm test`, and
removes the bundle in `finally`. Errors print only scenario/error-class; assertion
objects, payloads, ciphertext and request URLs are not printed.

- `scripts/check-sync-efficiency.mjs`: safe bundling/entry point.
- `tests/helpers/sync-efficiency.ts`: 38 measured rows, no additional default
  unit cases or framework. The table below lists primary rows; JSON also retains
  follow-up no-ops, restart no-ops and overlap measurements.
- `tests/helpers/sync-flow.ts`: optional observation of the existing coherent
  JSON save callback. The observer receives a clone and has no production role.
- `tests/helpers/obsidian-stub.mjs`: exact stub extraction, shared with the
  unchanged default test discovery.

Metrics schema: `sync-efficiency-v1`. `api` is the client's public GET accounting;
`requests` independently separates API metadata, download/upload link GET,
POST MOVE, PUT/DELETE and direct bodies. `bodies`/`transferBytes` count successful
native transfers by canonical/manifest/lock/user kind; they are not aliases for
API calls. `canonicalRevisionDelta` counts logical revision advancement, which
is distinct from actual canonical-body writes and read-only lock/MOVE activity.
`localReads`/`localBytes` cover successful Vault and DataAdapter reads, including
backup-related reads; the observer does not read bytes itself. `persistenceRequests`
counts callback requests while measuring, not native filesystem writes.

Each measurement stops counters before its outcome checks. Those then verify
remote/local plaintext bytes, canonical hashes/live paths/tombstones, no orphan
physical/local files or locks/moves, exact complete durable local state, empty
mutation/physical/watcher queues, stable ID-to-sequence mapping and FIFO watermark.
A successful full must durably observe the final revision. Realtime uploads may
retain the earlier observedRevision by design; they must persist the same live
baseline and cannot falsely observe a future revision. Follow-up full checks
canonical/physical byte identity and zero user transfers/writes. JSON restart checks
exact durable queue identity/context before recovery. One queued watcher event
survives pause and restart, then completes through normal full and a no-op.
`--verify-oracle` deliberately corrupts synthetic local bytes and proves the
outcome oracle rejects them; it is not a call-count assertion.

Each fixture has independent desktop and phone states, queues and two actual
initialized codec instances in encrypted mode. The manifest is produced by the
real EncryptionManager with matching salt/profile/verifier. Desktop originates
remote edits/deletions and returns after phone edits; both states are checked.
42 tiny files are intentional request-cost fixtures, not a mobile-memory workload.
A small uneven six-branch tree reaches four nested directory levels. Controlled
2 ms metadata delays expose overlap; latency and peak overlap are observations,
not CI release thresholds.

## Exact coverage limits

Token setup calls real `applyUserSettingsPatch`, real `PluginStartup.refresh`,
EncryptionWorkflow admission/recovery, engine full and watcher lifecycle callbacks.
The missing-token block precedes the patch, and settings publication precedes
reclassification/full. Established full uses actual startup admission and engine.
Realtime uses real FileWatcher events, debounce and batch timers, coordinator,
window preparation, actual uploads/commits/receipts and ACK callbacks; it does not
call a private drain or alias full as realtime.

Host ports are synthetic. Main's Obsidian UI, plugin load/unload registration,
scheduler timers, configuration publication wiring and `runFullSync` Notice /
final `persistPluginData()` wrapper are not executed. The full runner deliberately
counts engine/watcher saves only, so main's extra final-wrapper save is excluded.
Settings/encryption host persistence uses the fixture's coherent JSON callback;
actual PluginPersistence/native storage scheduling is covered by the existing
suite, not measured here. Codec initialization before admission is outside the
measured window; re-derivation counts and whole-process heap are not measured.
Binding uses a preaccepted synthetic root identity; the confirmation dialog is
not executed. No real token, profile, filesystem vault or network service is used.

Realtime has its own freshly connected fixture: running a watcher only after a
sequence of stopped-watcher download fixtures would retain synthetic internal-event
suppression and contaminate the burst. This is fixture isolation, not a production
fix or evidence that real late notifications are correct.

Direct Force is not a measured mode. Its direct publication, full inventory and
recovery remain under the existing default suite. Historical server-fencing tests
were not rerun and no fencing claim is made. Crash/lost-response/reordered-event
coverage is reused from the default functional suite (`partial upload`,
`ambiguous PUT`, FIFO restart, delayed successor and Force recovery cases), not
copied into a diagnostic matrix.

## Immutable baseline and comparison

Primary artifact: [00-baseline.json](00-baseline.json), 38 rows, 37,230 bytes.
The original exact output is also
`/private/tmp/sync-efficiency-00-fy_aukvx/baseline-accepted.json`.
Do not rewrite it in later stages. Write a fresh `--out` file and match rows by
`(scenario, encrypted, maxConcurrency)`. Preserve this runner/fixture contract when
comparing; changing payload sizes, event history or wrapper boundary requires an
explicit new baseline. A correct optimization may reduce metadata concurrency
because it removes requests; only the upper bound is asserted for initial42.

- Production digest before/after:
  `33a9c0870fd854ee59269edcec5db68280a2f04ff082c4b42d58a3d7fa8cb70e`.
- Runner + fixture digest:
  `c692b92b3cc8d9e103c60dab8b0e9e623c141246e99e1d3cf7cc171c79f48de0`.
- Baseline JSON SHA-256:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Digest method: SHA-256 of compact JSON ordered `[path, file SHA-256]` pairs;
  source list is `git ls-files --cached --others --exclude-standard src`.
  Runner paths are the entry script, diagnostic, sync-flow fixture and Obsidian stub.
- Runtime: Node v24.20.0, darwin arm64.
- Exact accepted command:
  `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-00-fy_aukvx/baseline-accepted.json`.
- Repeat command:
  `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-00-fy_aukvx/baseline-repeat.json`.
  Both pass all 38 rows. Counts, transfer bytes and state outcomes match.
  Excluding elapsedMs, only bulk-upload peakUserMetadata varies with scheduling.
  Do not compare overlap or synthetic duration as a fixed performance threshold.

In each paired value below the order is **plaintext/encrypted**. Within semicolon
lists, columns follow their headings. API GET excludes native body GET; adding
both gives actual read request count.

| Scenario                     | API GET   | Native GET canonical / manifest / lock / user | Local reads / bytes | Persistence requests | MOVE / revision delta |
| ---------------------------- | --------- | --------------------------------------------- | ------------------- | -------------------- | --------------------- |
| `token-initial-identical42`  | 82/83     | 3/2; 0/2; 0/0; 0/0                            | 168/168; 1640/1640  | 6/6                  | 0/0; 0/0              |
| `token-initial-empty42`      | 1010/1011 | 3/2; 0/2; 1/1; 42/42                          | 84/84; 820/820      | 47/47                | 2/2; 0/0              |
| `full-noop42`                | 12/14     | 1/1; 0/1; 0/0; 0/0                            | 42/42; 410/410      | 2/2                  | 0/0; 0/0              |
| `full-upload1`               | 56/60     | 3/3; 0/2; 2/2; 0/0                            | 44/44; 443/443      | 3/3                  | 2/2; 1/1              |
| `full-upload42`              | 917/1003  | 85/85; 0/43; 2/2; 0/0                         | 126/126; 1860/1860  | 3/3                  | 2/2; 1/1              |
| `full-download1`             | 32/34     | 1/1; 0/1; 1/1; 1/1                            | 46/46; 676/676      | 2/2                  | 2/2; 0/0              |
| `full-local-delete1`         | 40/42     | 2/2; 0/1; 2/2; 0/0                            | 41/41; 612/612      | 5/5                  | 2/2; 1/1              |
| `full-remote-delete1`        | 38/40     | 3/3; 0/1; 1/1; 0/0                            | 44/44; 654/654      | 4/4                  | 2/2; 0/0              |
| `realtime-edit1`             | 28/30     | 0/0; 0/1; 2/2; 0/0                            | 1/1; 22/22          | 6/6                  | 2/2; 1/1              |
| `realtime-edit42`            | 216/218   | 0/0; 0/1; 4/4; 0/0                            | 42/42; 1040/1040    | 10/10                | 4/4; 2/2              |
| `json-restart-pending-full1` | 65/73     | 5/4; 0/5; 2/2; 0/0                            | 44/44; 1076/1076    | 4/5                  | 2/2; 1/1              |

Initial metadata overlap observed 1/20/40 for the matching42 fixture at limits
1/20/40. Uneven-tree directory overlap is 1/6/6; its API GET count stays 33 and
all three no-op runs preserve canonical/physical bytes and queues.

Avoidable-cost leads for later stages (not yet proven safe optimizations):

- Identical initial42 reads local bytes four times: 168 reads / 1,640 bytes.
  Empty phone initial42 downloads 42 user bodies but still performs 1010/1011 API
  GET and 47 persistence callbacks.
- Bulk full42 transfers canonical 85 times and lock twice; encrypted mode also
  transfers the manifest 43 times. Keep fresh write authority while reducing read
  duplication; the diagnostic cannot authorize reuse on its own.
- Realtime burst42 uses two windows/commits, four MOVEs and 10 persistence requests.
  One edit uses 28/30 API GET and two lock-body downloads; burst uses 216/218 GET
  and four lock bodies, while local reads remain exactly one per edit. Stage06
  should investigate repeated root/index checks per event/window and guarded
  snapshot reuse, preserving FIFO, receipt-before-ACK and mandatory saves.

## Verification, review and rulings

Before changes: `npm test` 361/361, `npm run lint` exit 0;
`npm run format:check` exit 1 solely for coordinator-owned
`docs/superpowers/plans/sync-efficiency/queue.json`.
Sandbox `npm run build > /dev/null 2>&1` exit 1; the same build via approved
execution path exit 0. This is a sandbox restriction, not an established source
failure. Build stdout/stderr was suppressed before capture in every attempt.

After changes:

- `npm run lint:fix`: exit 0.
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-prettier-ignore`:
  corrected invocation exit 0; temporary root ignore verified by `--file-info` and
  removed afterward. It excludes coordinator-owned queue.json while retaining both
  original ignore files. Earlier scratch-relative ignore invocations were wrong;
  see the formatter incident.
- `npm test`: 361/361; zero failed/skipped/cancelled cases. Default discovery/count
  is unchanged. Tests were repeated after restoring historical fixture bytes;
  `test-restored-fixtures.log` retains that final safe synthetic output.
- `npm run lint`: exit 0.
- Approved `npm run build > /dev/null 2>&1`: exit 0; compiler and release bundle
  passed. `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js` exists. This does not establish Obsidian runtime behavior.
- `npm run format:check`: exit 0 after unintended queue formatting; this does not
  prove preservation of its original bytes. Corrected queue-excluding check: exit 0.
- `git diff --check`: exit 0; repeated after fixture restoration.
- Byte-oracle negative control: `npm run check:sync-efficiency -- --verify-oracle`
  exit 0 with `byteOracleRejectsCorruption: true`.

Read-only fresh-context review was performed by reviewer `review_baseline` on this
diagnostic and fixture diff, not the unrelated dirty production changes. The
review was static. Findings addressed before the accepted baseline: compare the
whole durable local state, assert canonical/durable tombstones, use lastSaved for
restart/oracles without a new checkpoint save, retain mutation ID-to-seq, and
allow lower metadata overlap after request-removing optimizations. The final
runner and full default suite pass after those changes.

Rulings: keep the approved dirty checkout; retain all source behavior; use existing
fixture algorithms instead of private method wrappers; do not author queue state changes;
exclude main's final wrapper save explicitly rather than manufacturing it in the
engine measurement. No domain RED/GREEN fix was attempted in this baseline-only
stage. During harness construction JSON undefined normalization and the distinct
realtime observedRevision semantics were corrected in the oracle, not production.
One early prototype encrypted bulk run returned failure before useful failure
classification was added; it did not reproduce in the two final 38-row runs.
It is not labelled pre-existing, unrelated or a proven product root cause.

Deferred minor from review: `--only` without a value currently runs both codecs.
Use the documented complete arguments. This does not affect accepted commands.

### Formatter incident and corrective evidence

The initial scratch ignore file copied relative patterns from .prettierignore.
Prettier resolves them relative to the ignore file, so a copy under /private/tmp
did not exclude repository-relative fixtures or queue.json. The first format log
shows queue.json and three historical stable-1.1 fixtures as changed. This violated
the queue ownership constraint; it is not described as an untouched file.

The three fixtures were clean in the initial status. For each one, `git show
HEAD:<path>` exactly matched the initial SHA-256 before its bytes were restored.
No checkout/reset/staging was used. All tracked source/test fixture identities
are now preserved except the intended package/fixture observer changes; the
shared-stub extraction in test.config.mjs is separately reviewed. Staged diff and
index hashes remain identical. Default suite was rerun after restoration.

The original queue was untracked and the requested snapshot captured its inventory,
not its contents. Its initial raw bytes cannot be recovered from that snapshot;
concurrent coordinator heartbeat updates also prevent a guessed restoration.
Only formatting was performed by this worker's tool; no queue fields were authored.
The coordinator should inspect its current queue and restore its preferred
serialization if desired. This worker will not mutate it again. A read-only check
of the coordinator's most recent turn confirmed that it was still monitoring stage00
and writing its wait cursor; no message was sent to any other chat.

Corrected formatting keeps .gitignore and .prettierignore explicitly and adds one
root-relative temporary ignore. `prettier --file-info` confirmed both queue and
historical fixture exclusion before its use. The temporary file is removed before
handoff. Existing .env and real plugin data were never inspected or copied.

## Handoff to stage01

Read this report and 00-baseline.json before editing. Production and staged
identities above are the real dirty baseline, not HEAD alone. Preserve staged
Direct Force, all unstaged mobile/concurrency fixes and 361-case test reduction.
Keep the runner stable; emit after measurements to a new scratch file and compare
safe counters/bytes/outcomes against this immutable baseline. Inspect queues and
fresh-write guards, not GET counts alone. The queue formatting incident
requires coordinator acceptance; workers must not rewrite queue.json to make a gate green.

No algorithmic or tool blocker prevents stage01. The coordinator must review the
queue formatting incident before accepting this stage. Global completion is not claimed.
Manual Android/native Obsidian plus two independent profiles against real Yandex
Disk remains unperformed and required for release. No real-vault data was read or
written by the diagnostic. Only the already authorized trusted build may load its
own optional local input; its sensitive output was never captured.

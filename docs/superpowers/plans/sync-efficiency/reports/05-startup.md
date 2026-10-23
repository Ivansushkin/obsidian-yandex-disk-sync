# Stage 05 — invocation-owned startup observations and codec install

Status: `completed_automated`, stage05 only, ready for coordinator acceptance.
Native Android/iOS/Obsidian + two-profile real Yandex Disk: **PENDING**.
No branch/worktree/reset/stage/commit/push, owner queue/automation update, worker
chat creation or other-chat messaging was performed. One read-only in-process
review subagent was used as required by requesting-code-review; it made no edits.

Dispatch nonce: `6e9645b2-d484-4265-9dc5-deec082bb359`.
Date: 2026-10-23, Europe/Moscow.

## Exact source boundary

- Actual initial dirty snapshot: `/private/tmp/sync-efficiency-05-2foz3hdc/`; `files/`,
  `identities.json`, `staged.patch`, `unstaged.patch`, `index-entries.txt`,
  `status.txt`, `head.txt` distinguish HEAD/index/worktree. This is not a HEAD diff.
- Branch `codex/direct-force-sync`; HEAD unchanged
  `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Production before: `544335caf0afe60acae97652e4d063fa6cecf259c7ada67574ae94b2042aae2e`.
- Production after, independently recomputed: `60f172c08f0303c19513d097b5af7a242bb51dbd19ac15927cb44133962472aa`.
- Runner before: `bb73c1ae00a111bae23b2f7925583118c817d9c7c80ddce0cc02dd800c8ddcb2`.
- Runner after: `e981f0f325d2bc2b09347df7efd452a6e6575662a9a16418e7b905268a0e5c8e`.
- Staged binary diff unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable stage00 JSON unchanged:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Exact incremental patch covers 22 existing files, excluding this report
  and the live coordinator-owned queue. Before/after identities are recorded in
  `incremental-corrected-identity.json`; all 191 other captured files retain their
  hashes, including historical fixtures, prerequisite reports and measurement oracle.
  The queue changed externally and was never restored or written by this worker.
- Source/runner identities use stage00's ordered `[path, file SHA-256]` compact
  JSON method. Evidence paths below contain only synthetic/source-check outputs.

Incremental files:

- `docs/ARCHITECTURE.md`
- `docs/E2E_ENCRYPTION.md`
- `docs/PARALLELIZATION.md`
- `docs/SMOKE_TESTS.md`
- `docs/SYNC_USER_SCENARIOS.md`
- `src/crypto/admission.ts`
- `src/crypto/context.ts`
- `src/crypto/encryption-manager.ts`
- `src/crypto/maintenance.ts`
- `src/crypto/recovery.ts`
- `src/crypto/workflow.ts`
- `src/main.ts`
- `src/plugin-startup.ts`
- `src/settings-workflow.ts`
- `src/sync/canonical/manager.ts`
- `src/sync/contracts.ts`
- `src/sync/engine.ts`
- `src/sync/workflows/initial-receive.ts`
- `tests/encryption-workflow.test.ts`
- `tests/helpers/encryption-flow.ts`
- `tests/helpers/sync-efficiency.ts`
- `tests/sync-user-flows.test.ts`

## Ownership and API handoff

`PluginStartup.runInvocation(action)` owns a lazy `StartupInvocation` and closes
it in `finally`. `refresh(prompt, allowRecovery, invocation?)` accepts that explicit
owner; omitting it creates and ends a standalone invocation. No engine-global
cache, TTL, persisted observation or extra coordinator/store is introduced.
`invalidate()` closes the old read session before recovery/codec installation;
new observations obtain their own configuration identity and retain no old bytes.

`IndexManager.createStartupReadSession(assertActive)` extends the existing callable
`CanonicalReadSession` with `manifest()`, `inspectFormat()`,
`readWithCodecIfPresent(service)`, `bind(guard)` and `close()`. Only actual verified
stable downloads seed its private bytes; callers cannot seed an index. Views are
cloned. Parsed canonical is retained only for the exact private decode-context identity;
active captured configuration, explicit plaintext and explicit codec instances are distinct.
Another context must authenticate cached raw bytes before it can replace the parsed view.
Every reuse requires a new fully paginated stable unlocked root pair,
scope/server SHA-256 or MD5 and current config/transition generation. Resource ID
or modified/size alone never authorizes reuse; no-hash repeats the stable body
read. A manifest identity change clears the canonical observation too. Initial
receive now shares the full's already verified session, preserving fresh guards.

Classification and manifest observations use pure root observation, without lock
cleanup/recovery. Ordinary canonical reads/load retain existing recovery discovery.
Historical fallback remains uncached and validates config/lifetime after its awaits.
A failed observation poisons its queue. `createReadLifetimeGuard()` captures engine
pause generation and host stop from the first startup/crypto read, including
pause/resume ABA before coordinator admission. Full additionally binds active
coordinator ID/pause lifetime. An initially paused resume may validate first and
resume normally. Closing the invocation prevents future borrowing and late results.

`EncryptionManager.createCodec` privately registers only its own prepared codecs
in an instance-local WeakMap. `applySnapshot` may reuse a candidate only for exact
profile/salt/password, then checks invocation authority before mutating settings.
Foreign caller codecs are ignored and the actual matching codec is derived. Init,
connect and recovery use these prepared services. Verifier, fresh canonical target
and fresh manifest checks precede install. Matching active stable recovery detection
validates authority without reconnecting/saving the same credentials; real maintenance
retains its old recovery path and invalidates observations before writes.

Settings and client/service publication retain the same coherent persistence queue.
Failed save cannot return success, enable automation or acknowledge work. Target
state after a committed transition is never rolled back. Cancel/unload/config/pause
change during derivation is checked before install; init also refuses to clear or
replace a newer service when its own result has expired. PBKDF2 remains 600000.
No durable/global secret cache, schema/marker/FIFO/epoch/revision/maxConcurrency,
realtime or Direct Force behavior change was introduced. Main changes are only
composition and invocation forwarding; domain work stays in focused modules.

## Actual invocation paths and evidence boundary

- Token auto-start: real `applyUserSettingsPatch` creates the invocation before
  draft save, lazily reads only after publication, then passes it through startup
  classification and the immediately following full. Paused/no-layout/failed save
  do not start automation; the scope ends in `finally`.
- Cold startup: actual main `onLayoutReady → refresh → startSync → runFullSync`
  forwards one invocation, including backup-cleanup awaits. Domain integration
  and the cold JSON-restart runner use actual startup/recovery/admission/engine.
- Manual retry and resume: actual main `runFullSync` owns a fresh invocation;
  `resumeSyncIfReady` forwards its owner through recheck/resume/full. Existing
  plugin lifecycle tests execute those wrappers with synthetic host services.
- Scheduler: production `SyncScheduler` directly calls `engine.fullSync`, with no
  PluginStartup classification. It owns a separate ordinary full/admission/session,
  never borrows a standalone refresh. The startup integration case now starts the
  real scheduler timer in both codecs, observes the real full result and verifies
  one canonical/manifest body, zero PBKDF2 and preserved causal state. Timer/native
  UI lifecycle is not included in the comparable38 diagnostic rows.
- Standalone refresh closes its own observations. Two fresh later startup/full
  invocations read again; no persisted/runtime cache is shared between them.

The38-row runner changes only explicit invocation/known-manifest plumbing in its
synthetic host. Payloads, bytes, codec construction, event history, measurement
boundaries and outcome/receipt/FIFO oracles are unchanged. The entry script,
sync-flow fixture and Obsidian stub are byte-identical. This wiring change is why
runner identity differs; it does not establish native main/Obsidian execution.
Native body counts, API metadata/link counts and transfer bytes remain independent.
PBKDF2 is not measured by this runner: the focused workflow tests observe actual
WebCrypto `deriveBits` calls, filtering only algorithm name, without inspecting keys.

## Minimal real-algorithm RED / GREEN

Default suite grows366→368: exactly two added domain cases and two focused
extensions of existing recovery/admission cases; no helper-unit matrix/removal.

- `authenticated startup candidate installs once and rejects wrong credentials before persistence`:
  initial RED on the actual pre-edit source was PBKDF2 **2 vs1** (`red-codec.log`).
  GREEN: first connect derives1, repeated matching active candidate derives0,
  verifier/canonical/manifest proofs still run, foreign-manager codec is not accepted,
  wrong password preserves active service/settings and failed save preserves state
  without success. Real encrypted full settles exact plaintext/baseline/queues.
- `startup invocation shares authenticated service bytes and expires before drift or a future full`:
  initial real38-row baseline had plaintext token canonical **3 vs1**, while its
  byte/state oracle was green. GREEN executes real startup/recovery/admission/full
  in both modes: one canonical and encrypted manifest per invocation, zero matching
  PBKDF2; independent later invocation/timer reads again. Token ABA and manifest
  drift fail without writes/causal-state changes; no-hash manifest downloads twice
  instead of trusting modified/size. Closed sessions reject reuse.
- Existing shared-prompt test now also delays actual codec derivation until unload:
  neither late password nor late derived key installs/saves/starts automation.
  A source-only esbuild override using the original stage05 snapshot independently
  fails both credential and late-derivation cases (`red-baseline-tests.log`,2/2 RED).
  This retrospective negative control is additional to the initial pre-edit RED.
- Existing committed foreign-device transition flow now runs restarted own-device
  recovery via actual PluginStartup and proves the old observations are closed,
  then verifies offline queued edits converge without target rollback/ACK loss.
- Two intermediate issues were reproduced and fixed: read-only startup accidentally
  entered mutating lock discovery (`red-readonly-lock.log`), and pause/resume before
  full failed to invalidate an observation (`red-startup-pause.log`). Both are now
  assertions inside the same startup integration case; no new test matrix.
- Initial timeout test intentionally needs a body read at its queued-guard boundary.
  Sharing the already loaded session removes that transfer under a server hash.
  Its transport metadata now omits canonical SHA, forcing the documented no-hash
  stable-body fallback. Exact bytes,2 transfers with an unresolved second response,
  stop/no-retry, no observed/ACK advancement and JSON-restart assertions remain.
  This is an existing failure-boundary fixture adjustment, not a runner/oracle change.
- Reused existing Force, transitions/rollback/recovery, ambiguous transfer, restart,
  offline, reordered-event, persistence-before-ACK and full barrier tests all pass.
  One in-process independent read-only reviewer found no remaining Critical/Important
  issues after the startup lifetime correction, but did not detect the decode CPU
  regression later found by the coordinator. The corrective RED/GREEN below closes it;
  static review is not runtime proof.

## Comparable all-mode measurements

`before.json → after-correction.json` are the exact actual stage04 dirty baseline
and final stage05 evidence. Stage00 API counts are included only as cumulative
reference. Every38 row passes exact bytes/canonical/local baseline/queue and durable
receipt checks. Result counts, local reads/bytes/phases, user/lock body transfers,
MOVE, revision and mutation/event identity counts are unchanged. Encrypted cold
stable restart removes only the redundant credential snapshot save:3→2, and pending
restart5→4; required full/queue/observed saves are retained. Other saves are unchanged.

Token initial API GET is25/26→25/25 (plain/encrypted); canonical bodies3/2→1/1,
encrypted manifest2→1. Cold no-op API20/26→21/21: plaintext pays one extra metadata
GET for explicit fresh guards while saving two canonical bodies; encrypted canonical
2→1 and manifest4→1. Ordinary no-op11/13 and realtime edit1/42 counts are unchanged.
No blanket latency/speed claim follows from these request reductions.

C/M/L/U = native GET canonical/manifest/lock/user bodies. GET/PUT bytes are total
native transfer bytes; exact per-kind bytes and all request categories are in JSON.
IDs M/E = observed mutation/event identities. Every row's state/receipt oracle is true.
Elapsed/overlap are synthetic observations, not release thresholds. Bulk full has scheduling-dependent metadata counts; the corrected encrypted run
observed501 API GET and a same-source repeat496, differing by5 root metadata GETs
only. Both runs preserve every body/byte/state/receipt counter. Compare actual JSON
rather than treating a particular synthetic scheduling sample as a fixed threshold.

| Scenario                      | Mode/limit | API GET stage00; before→after | GET C/M/L/U         | Native bytes GET/PUT      | Local reads/bytes | Saves | MOVE/Δrev | Result U/D/D | IDs M/E |
| ----------------------------- | ---------- | ----------------------------- | ------------------- | ------------------------- | ----------------- | ----- | --------- | ------------ | ------- |
| `token-initial-identical42`   | plain/20   | 82; 25                        | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0         | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop42`                 | plain/20   | 12; 11                        | 1/0/0/0             | 19668/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `full-upload1`                | plain/20   | 56; 43                        | 1/0/2/0             | 59017/19695               | 43/429            | 3     | 2/1       | 1/0/0        | 1/0     |
| `full-upload42`               | plain/20   | 917; 494                      | 1/0/2/0             | 58972/20230               | 84/1240           | 3     | 2/1       | 42/0/0       | 43/0    |
| `full-download1`              | plain/20   | 32; 15                        | 1/0/0/1             | 19635/0                   | 46/676            | 2     | 0/0       | 0/1/0        | 43/0    |
| `full-local-delete1`          | plain/20   | 40; 36                        | 2/0/2/0             | 78572/19671               | 41/612            | 5     | 2/1       | 0/0/1        | 44/0    |
| `full-remote-delete1`         | plain/20   | 38; 33                        | 3/0/1/0             | 78932/0                   | 44/654            | 4     | 2/0       | 0/0/1        | 44/0    |
| `full-followup-noop`          | plain/20   | 12; 11                        | 1/0/0/0             | 19733/0                   | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `json-restart-full-noop`      | plain/20   | 21; 20 → 21                   | 3/0/0/0 → 1/0/0/0   | 59199/0 → 19733/0         | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `realtime-edit1`              | plain/20   | 28; 28                        | 0/0/2/0             | 39349/19703               | 1/22              | 6     | 2/1       | —            | 1/1     |
| `realtime-edit42`             | plain/20   | 216; 216                      | 0/0/4/0             | 78551/40280               | 42/1040           | 10    | 4/2       | —            | 43/43   |
| `realtime-followup-full-noop` | plain/20   | 12; 11                        | 1/0/0/0             | 19610/0                   | 42/1040           | 2     | 0/0       | 0/0/0        | 43/43   |
| `json-restart-pending-full1`  | plain/20   | 65; 52 → 53                   | 3/0/2/0 → 1/0/2/0   | 98051/19631 → 58831/19631 | 43/1056           | 4     | 2/1       | 1/0/0        | 44/44   |
| `json-restart-noop`           | plain/20   | 12; 11                        | 1/0/0/0             | 19611/0                   | 42/1036           | 2     | 0/0       | 0/0/0        | 44/44   |
| `token-initial-empty42`       | plain/20   | 1010; 483                     | 3/0/0/42 → 1/0/0/42 | 59414/0 → 20078/0         | 84/820            | 47    | 0/0       | —            | 0/0     |
| `initial-empty-followup-noop` | plain/20   | 12; 11                        | 1/0/0/0             | 19668/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `token-initial-identical42`   | enc/20     | 83; 26 → 25                   | 2/2/0/0 → 1/1/0/0   | 40524/0 → 20262/0         | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop42`                 | enc/20     | 14; 13                        | 1/1/0/0             | 20262/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `full-upload1`                | enc/20     | 60; 45                        | 1/1/2/0             | 59667/19751               | 43/429            | 3     | 2/1       | 1/0/0        | 1/0     |
| `full-upload42`               | enc/20     | 1003; 496 → 501               | 1/1/2/0             | 59622/21434               | 84/1240           | 3     | 2/1       | 42/0/0       | 43/0    |
| `full-download1`              | enc/20     | 34; 17                        | 1/1/0/1             | 20257/0                   | 46/676            | 2     | 0/0       | 0/1/0        | 43/0    |
| `full-local-delete1`          | enc/20     | 42; 38                        | 2/1/2/0             | 79250/19699               | 41/612            | 5     | 2/1       | 0/0/1        | 44/0    |
| `full-remote-delete1`         | enc/20     | 40; 35                        | 3/1/1/0             | 79610/0                   | 44/654            | 4     | 2/0       | 0/0/1        | 44/0    |
| `full-followup-noop`          | enc/20     | 14; 13                        | 1/1/0/0             | 20327/0                   | 40/598            | 2     | 0/0       | 0/0/0        | 44/0    |
| `json-restart-full-noop`      | enc/20     | 27; 26 → 21                   | 2/4/0/0 → 1/1/0/0   | 41786/0 → 20327/0         | 40/598            | 3 → 2 | 0/0       | 0/0/0        | 44/0    |
| `realtime-edit1`              | enc/20     | 30; 30                        | 0/1/2/0             | 39971/19759               | 1/22              | 6     | 2/1       | —            | 1/1     |
| `realtime-edit42`             | enc/20     | 218; 218                      | 0/1/4/0             | 79229/41512               | 42/1040           | 10    | 4/2       | —            | 43/43   |
| `realtime-followup-full-noop` | enc/20     | 14; 13                        | 1/1/0/0             | 20204/0                   | 42/1040           | 2     | 0/0       | 0/0/0        | 43/43   |
| `json-restart-pending-full1`  | enc/20     | 73; 58 → 53                   | 2/4/2/0 → 1/1/2/0   | 80817/19687 → 59481/19687 | 43/1056           | 5 → 4 | 2/1       | 1/0/0        | 44/44   |
| `json-restart-noop`           | enc/20     | 14; 13                        | 1/1/0/0             | 20205/0                   | 42/1036           | 2     | 0/0       | 0/0/0        | 44/44   |
| `token-initial-empty42`       | enc/20     | 1011; 484 → 483               | 2/2/0/42 → 1/1/0/42 | 42110/0 → 21848/0         | 84/820            | 47    | 0/0       | —            | 0/0     |
| `initial-empty-followup-noop` | enc/20     | 14; 13                        | 1/1/0/0             | 20262/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/1    | 82; 25                        | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0         | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/1    | 33; 32                        | 1/0/0/0             | 21278/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/20   | 82; 25                        | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0         | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/20   | 33; 32                        | 1/0/0/0             | 21278/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |
| `initial-identical42-limit`   | plain/40   | 82; 25                        | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0         | 168/1640          | 6     | 0/0       | —            | 0/0     |
| `full-noop-uneven-deep`       | plain/40   | 33; 32                        | 1/0/0/0             | 21278/0                   | 42/410            | 2     | 0/0       | 0/0/0        | 0/0     |

## Coordinator correction — cache parsed canonical by decode context

The coordinator identified a CPU regression in the initial stage05 implementation:
hash-matching `readPresent` reused native bytes but still called `decodeIndexSnapshot`
on every guard, repeating decrypt/parse/normalization. The original network-only
runner and initial review did not detect this; the previous stage05 completion claim
was therefore insufficient. The original report/source boundary is preserved under
`/private/tmp/sync-efficiency-05-2foz3hdc/correction/files/`.

The existing real read-session test was extended, with no additional unit case.
After load and a repeated read,84 concurrent guarded evaluations of unchanged
encrypted canonical observed **86 actual codec.decrypt calls vs expected1**:
`correction/red84.log` is RED. GREEN (`correction/focused-final.log`,1/1) observes
**1 decrypt**, all84 validation callbacks and **168 fresh metadata GETs**. SHA/MD5
retain verified parsed state; no-hash still transfers and decodes per read.
This counts actual decryption, not PBKDF2 or native transfers. The skipped
raw decode/parse/normalization branch is confirmed in source; each returned view
still receives the existing independent clone, including its JSON serialization.

`createStartupReadSession` now privately records `snapshotService` alongside its
verified snapshot: `undefined` means the captured active/transition configuration,
`null` means explicit plaintext, an object means that exact explicit codec instance.
Existing config/transition generation guards pin the active context. Only matching
content identity and the same decode context can reuse the parsed index. A changed
explicit context always decodes/authenticates raw again before publishing its view.
New download, load, manifest invalidation, disappearance and close reset the key.
No caller-provided seed, commit proof, global cache or authority shortcut was added.

The same test proves active→explicit same object authenticates once for that context,
then reuses; a distinct valid same-password codec authenticates once independently;
returning to active authenticates again. Wrong-password candidate and explicit
plaintext both raise `UnreadableRemoteIndexError` instead of receiving a prior
parsed index, and poison subsequent reads. Existing drift/locks/no-hash/config/late
and clone/causal-state assertions remain green. Only manager, that existing test,
architecture/scenario docs and this report change in this corrective pass.

New final production: `60f172c08f0303c19513d097b5af7a242bb51dbd19ac15927cb44133962472aa`.
Runner/fixture identity remains `e981f0f325d2bc2b09347df7efd452a6e6575662a9a16418e7b905268a0e5c8e`.
`after-correction.json` and `after-correction-repeat.json` each pass38/38 rows.
Relative to the earlier stage05 sample, all native bodies/bytes, local reads,
persistence, result/state/receipt and MOVE/revision counts are unchanged. Only
bulk42 root metadata counts vary: plain496→494; encrypted496→501 then496 on repeat.
The same-source repeat confirms scheduling variation; it is not hidden or labelled
a deterministic speed gain. `correction/network-comparison.json` and
`correction/repeat-comparison.json` preserve all actual differences. No Android/native
Obsidian CPU/latency claim is made.

Final corrective gates: `npm run lint:fix`, protected `npm run format`, `npm test`
(**368/368**), `npm run lint`, approved `npm run build` (stdout/stderr suppressed
before capture), `npm run format:check` and `git diff --check` all exit0. Logs are
under `correction/`; build exit0 was observed directly. Stage00 JSON, staging/index
and foreign hashes remain preserved. Fresh artifacts `incremental-corrected.patch`,
`incremental-corrected-identity.json` and `comparison-corrected.json` supersede the
old stage05 final identities; old artifacts remain intact.

## Gates and reproducibility

All outputs below are under `/private/tmp/sync-efficiency-05-2foz3hdc/`:

- `npm run lint:fix`: final exit0 (`correction/lint-fix.log` and previous guard pass).
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-05-prettier-ignore`:
  exit0 (`correction/format.log`). Root-relative owner queue, immutable stage00 JSON
  and historical fixtures were excluded; `prettier --file-info` confirmed ignored.
- `npm test`:368/368 pass,0 failures/cancelled/skipped (`correction/tests.log`).
- `npm run lint`: exit0 (`correction/lint.log`).
- `npm run build`: approved execution exit0, stdout/stderr redirected to `/dev/null`
  before capture. Sandbox build exit1 while source-only tsc passes is the same
  execution restriction as earlier stages; approved identical command succeeded.
  Earlier first build exit2 was this stage's introduced unused-wrapper/test typing
  errors, corrected explicitly; not labelled pre-existing. No .env content/log was read.
- `npm run format:check`: exit0 (`correction/format-check.log`); final report formatting
  and plain check are repeated after report creation below.
- `git diff --check`: exit0 before report; final check repeated below.
- `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-05-2foz3hdc/after-correction.json`:
  exit0,38 rows. Fresh filename/exclusive creation; baseline was never overwritten.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0,
  `byteOracleRejectsCorruption:true` (`oracle.log`).
- Focused3 workflow scenarios:3/3 (`focused-green.log`); final default suite also
  includes later real-timer/no-hash/pause assertions. Read-only source/identity review
  confirms staged work and all non-owned captured files are preserved.

Evidence identities:

- `before.json` SHA-256: `2713a4e731d7e54cfe2ce4a52654c9135c83a311d19fb440d6c8bbeb614434ec`.
- `after-correction.json` SHA-256: `81055279c135e63288e5c644f06ef2ddd5396c558e2b28de1fd20997f5c8a8e4`.
- `comparison-corrected.json` SHA-256: `788ffa4740a26b7eb6cf2a091716efdd952ecc7035d02572f1466d376170d55a`.
- `incremental-corrected.patch` SHA-256: `3709aa379f932da75f132841b4f563bd8c7c477cad0da9fbcd0b4bf1c3183313`.
- `incremental-corrected-identity.json` SHA-256: `982c6e120123b09c4765c3c816bd281e9a33a22ab43b3e2a320a7112503d9811`.

## Remaining limits and handoff

Only stage05 is implemented; coordinator acceptance and later plan stages remain.
Do not mark the whole eight-stage queue complete from this report. No queue or
heartbeat operation is requested/performed here. Source digest/API above is the
handoff for stage06. Main's UI/Notice and actual Obsidian load/unload/timer hosts,
native persistence scheduling, Android performance and real network/crash timing
were not executed. The diagnostic deliberately excludes main's extra final save,
as before. Real two-profile Obsidian/Yandex and native mobile smoke remains required.
Build artifact: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`.

## Corrective evidence identities

- `after-correction-repeat.json` SHA-256: `3e5058b5b866c27d76459d98b4b93e0e1d243c8b6555f980509b48c0c3a70bca`.
- `correction/incremental.patch` SHA-256: `52681204cf3321e2171db46722a4e36775ea9181ed2ba6397754d811a4b87719`.
- `correction/red84.log` SHA-256: `a54d581a8bb021dc63ab0b5b91a4af539f7eace17700f028f1bcfa22b8ae5adb`.
- `correction/focused-final.log` SHA-256: `a05f484e4defb1bcdb7c5ab3e70c4c36de651551deda0d1027fa6f5b51698d99`.
- `correction/network-comparison.json` SHA-256: `87a389ea92edf63cb4c9f5dce900677179ff1cb87fcac87da444ae52798288b0`.
- `correction/repeat-comparison.json` SHA-256: `3100615f416a43c30fa4d07d1b9e667b28f752c6cc94cac8240137483c5a849d`.

## Corrected handoff verification

Corrected production digest is independently rechecked against both38-row JSON
artifacts; all22 owned and191 foreign captured file identities are preserved as
expected. Staged binary diff/index and immutable stage00 JSON remain unchanged.
`build/main.js` exists (739854 bytes), unstaged. Temporary formatter exclusions are
removed after report formatting; plain format and diff checks are repeated below.
The coordinator-owned queue is left untouched; no worker chats were created.

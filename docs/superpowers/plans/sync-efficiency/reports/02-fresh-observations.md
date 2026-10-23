# Stage 02 — fresh composite authority observations

Status: `completed_automated`, ready for coordinator acceptance of this stage.
Only stage02 was implemented. No branch/worktree/reset/stage/commit/push,
automation, dispatch, following-stage work or queue write was performed.
Native Android/Obsidian and two independent Obsidian profiles against real
Yandex Disk remain **PENDING**; this is not release evidence.

Dispatch nonce: `6d7b2883-2611-4ff3-8bfd-305ed006797e`.
Date: 2026-10-23, Europe/Moscow.

## Exact source boundary

- Branch: `codex/direct-force-sync`; unchanged HEAD:
  `b4716a0e998d5927d783981d39ab88527ffc66aa`.
- Starting dirty working-copy snapshot:
  `/private/tmp/sync-efficiency-02-runf4egy/`.
  `files/` contains the actual pre-stage source/test/doc/script bytes;
  `identity.json`, `staged.patch`, `unstaged.patch`, `index-entries.txt`,
  `status.txt`, `branch.txt`, `head.txt` preserve the source/index distinction.
  HEAD alone is not this stage's baseline.
- Staged binary diff unchanged:
  `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`.
- Index entries unchanged:
  `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`.
- Immutable stage00 JSON and all historical fixtures remain byte-identical.
  Stage00 JSON SHA-256:
  `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Production digest before:
  `dc94ce38ac59eb10c2241b7837a8548cafb2ef28a94f438eaf2956bf01ac2cca`.
- Production digest after:
  `4337c15d1ba17b8f611b123fd5b0fa96f069ee62c888fa279250d051c5a5a701`.
- Exact incremental unified diff against the captured working copy:
  `incremental-corrected.patch` in the snapshot directory; SHA-256:
  `306132cbec54257276ea61986120ae7440ec280e0c2eaad1e160c71e060597c3`.
  It contains all16 changed existing files, including previously untracked
  runner wiring; this new report and owner queue are excluded. Every source is
  UTF-8 text. `incremental-corrected-identity.json` records final per-file SHA-256 values.
  Earlier `incremental-final.patch`/identity remain preserved as intermediate evidence.
- Runner digest before:
  `c692b92b3cc8d9e103c60dab8b0e9e623c141246e99e1d3cf7cc171c79f48de0`;
  after: `bb73c1ae00a111bae23b2f7925583118c817d9c7c80ddce0cc02dd800c8ddcb2`.

Changed paths relative to the actual starting copy:

- `docs/ARCHITECTURE.md`
- `docs/E2E_ENCRYPTION.md`
- `docs/PARALLELIZATION.md`
- `docs/SMOKE_TESTS.md`
- `docs/SYNC_USER_SCENARIOS.md`
- `src/main.ts`
- `src/sync/canonical/manager.ts`
- `src/sync/canonical/recovery.ts`
- `src/sync/contracts.ts`
- `src/sync/engine.ts`
- `src/sync/files/operations.ts`
- `src/sync/local/storage-binding.ts`
- `src/sync/workflows/full.ts`
- `src/sync/workflows/initial-receive.ts`
- `tests/helpers/sync-efficiency.ts`
- `tests/sync-user-flows.test.ts`

Ruling: the runner's optional guard callback must consume the same new observation
port as main; otherwise it would measure deliberately duplicated legacy scope and
manifest reads. Only its callback signature and two forwarded arguments changed.
Runner schema,38 rows, payloads, fixture history, metrics/counters, observer,
byte/queue oracle and CLI contract are unchanged. Scripts and shared sync-flow/
Obsidian helpers remain byte-identical. This is a wiring adaptation, not an oracle
or fixture change. Fresh before/after files were used; no baseline was overwritten.

No other captured file changed. Queue was excluded from both snapshot contents
and formatter writes. Its hash changed between the initial and final observation;
this worker issued no queue write, did not restore it, and cannot identify the
changed fields from the hash-only initial capture. Correct repository-root ignore
rules were verified with Prettier `--file-info` (`ignored: true`) for queue and
fixtures before formatting. The temporary ignore file is removed at handoff.

## Implementation and freshness boundaries

`CanonicalRecovery.getStableRootListing(assertCurrent)` extends the existing
stable pagination algorithm. Every page carries the same identified raw root
path/type/resource ID (or consistent absence), including across stability passes.
Root replacement fails even when a later listing could stabilize under a new ID.
Incomplete/missing embedded listings, changing totals within a pass, early empty
pages, duplicate items, malformed/out-of-root paths and unknown service identities
fail closed. Two consecutive complete signatures include raw canonical, manifest
and lock metadata and strict service content fingerprints. No global cache or TTL
was introduced. Existing lock wait/recovery/cleanup remains; validators run before
recovery can write. Ordinary canonical commits and Direct Force publication retain
their existing algorithms.

`CanonicalReadSession` stays callable, with private verified load bytes,
`load()` and `assertCurrent()`. Its optional `session(validate)` callback gets an
opaque `RemoteAuthorityObservation` from that evaluation's fresh stable root pair.
A manager-local WeakMap is only an active-lifetime registry, not a metadata cache.
Scope and manifest-token validators resolve the same private listing, check its
configuration/lifetime and perform no duplicate root/manifest metadata GET.
Observation expires via finally on both success and failure, cannot be forged or
consumed by another manager, and cannot be borrowed by the next callback/read.
Canonical validation uses metadata from that same pair. Bytes still require
matching SHA-256/MD5 and no locks; no-hash/drift retains stable native download and
post-transfer metadata. Read observation is neither `CanonicalCommitProof` nor
physical write authority; nothing is persisted.

Two independent production call sites opt in:

1. Initial receive's `assertAuthority`: every queued evaluation runs its scope,
   manifest-token and canonical-signature checks through a new observation.
   Matching metadata group still only establishes baselines; every local write,
   deletion, fallback download, final ACK and required retry retains its existing
   fresh authority boundary. No whole download batch borrows one write guard.
   Its read session now also uses the full invocation lifetime/pause guard.
2. Ordinary full upload's `assertAuthority`: every before-attempt and ambiguous
   read-back validation calls the invocation's session with its current manifest
   validator. Outer admission, independent physical fingerprint, standalone
   client writeGuard and retry callback all remain. Calls without a full session
   retain standalone guard/read order.

`SyncGuardCallback` and the existing engine ports carry an optional observation.
Main only wires it through storage/encryption validators. Bound noninteractive
storage validation uses the observation; unbound/prompt admission keeps the
original fresh controller path. Manifest-body admission and checks not represented
by an observation keep independent reads. No token/key/verifier/body is placed
inside the public opaque object. Client and manager config/transition generations,
coordinator ID, pause/resume generation, host stop/unload bracket awaited pages,
callback and transfers. Late responses cannot seed state or revive failed reads.

No coordinator, operation store, persistence queue, schema/marker, mutation FIFO,
epoch/revision, maxConcurrency1..40/default20, Direct Force/realtime algorithm,
mandatory backup, local SHA or durable acknowledgement was replaced or removed.
Documents add stable scenario `SYNC-043` and pending TC-09 pagination/drift checks.

## RED/GREEN and review

- Before production edits, extended real read-session test failed because the
  authority validators were never called (`red-evaluation.log`), and the new
  pagination interaction test failed with `Missing expected rejection: root`
  (`red-pagination.log`). These executed the actual session/recovery algorithms
  over MemoryDisk, not helper call-count mocks.
- GREEN extends the existing session test: scope and manifest validation run
  inside the callback; one hash-backed evaluation makes exactly2 metadata GETs
  (one stable root pair), preserves bytes and rejects an expired observation.
  Existing SHA/MD5/no-hash, independent sessions, mutable views, foreign canonical
  and ambiguous lock assertions remain.
- One new interaction test covers root replacement between1000-entry pages,
  unknown root identity, early incomplete page, and alternating canonical,
  manifest and lock identities between passes. Every rejection poisons later
  reads, preserves exact remote bytes and captured local causal state/queues,
  and never materializes the local file. No new helper-unit matrix was added.
- Existing matching-batch test remains plaintext/encrypted and checks actual
  manifest/canonical/root/lock/connection drift, pause, late edits, failed save,
  physical mismatch, timeout, restart, byte preservation, empty queues and no
  false observed success. Existing config ABA and late load/timeout/lifetime,
  multi-device bulk upload, offline return, ambiguous PUT and Force scenarios
  remain in the default suite.
- Initial lint/typecheck caught an implementation mistake in the moved initial
  callback: a leftover duplicate canonical read plus out-of-scope `guard`.
  The duplicate and stale reference were removed. Test-only missing null codec
  arguments/assert overloads were corrected. These were stage02 errors, not
  classified as pre-existing. Final lint/typecheck/gates pass.
- One intermediate full suite was363/364: matching-batch stopped-queue assertion
  saw3 user metadata reads instead of1. Follow-up now proves a fixture defect:
  pause/connection injection targeted `a.md`, but canonical insertion order is not
  guaranteed by parallel uploads. Real-algorithm controls with `a,b,c` versus
  `c,b,a` reproduce1 versus3 reads **before** that injection, with0 reads after it
  in plaintext/encrypted modes for both pause and connection ABA. Original trace
  did not record its precise order, but this reproduces the same3!==1 failure
  deterministically without any queued read after stopping. See the correction
  section below for RED/GREEN, exact traces and unchanged production identity.
- Independent fresh-context read-only review against the pre-stage snapshot:
  no actionable Critical/Important/Minor findings. Static only; the reviewer
  did not rerun the automated gates or native/live smoke.

## Before/after measurements

All38 rows use identical scenario/mode/limit keys and pass their original outcome
oracles. Byte transfers by every kind, local reads/bytes and phase counts,
persistence requests, canonical revision delta, result counts and receipt/queue
identity invariants/counts are unchanged. PUT/DELETE/MOVE activity is unchanged.
Only redundant metadata GETs are removed in this stage. Service/native transfer
savings from stage01 remain: bulk42 canonical body1, encrypted manifest body1,
local reads84; required user uploads42 and lock bodies2 remain. Native transfer
bytes are unchanged from this stage's fresh before sample.

This fresh encrypted bulk42 baseline has789 API GET, while the stage01 report
recorded790. Its production digest exactly matches the accepted stage01 digest;
the one metadata request variation is not claimed as a stage02 saving. API and
native counters are separate, so synthetic elapsed/overlap variations are not
interpreted as production/mobile latency. Initial receive native overlap changes
from2 to3 with redundant serial metadata removed; directory/user concurrency
remains bounded by the configured limits1/20/40.

Each row below: API GET before→after; C/M/L/U native GET body counts are unchanged;
GET/PUT are total native transfer bytes, unchanged; local reads/bytes, saves,
MOVE/revision Δ are unchanged. Full category/per-kind details and controlled
latency/overlap are retained in the JSON, including all follow-up/restart rows.

| Scenario                      | Mode / limit | API GET    | C/M/L/U  | Native GET/PUT bytes | Local reads/bytes | Saves | MOVE / revision Δ |
| ----------------------------- | ------------ | ---------- | -------- | -------------------- | ----------------- | ----- | ----------------- |
| `token-initial-identical42`   | plain / 20   | 82 → 65    | 3/0/0/0  | 59004/0              | 168/1640          | 6     | 0 / 0             |
| `full-noop42`                 | plain / 20   | 10 → 9     | 1/0/0/0  | 19668/0              | 42/410            | 2     | 0 / 0             |
| `full-upload1`                | plain / 20   | 50 → 43    | 1/0/2/0  | 59017/19695          | 43/429            | 3     | 2 / 1             |
| `full-upload42`               | plain / 20   | 787 → 496  | 1/0/2/0  | 58972/20230          | 84/1240           | 3     | 2 / 1             |
| `full-download1`              | plain / 20   | 30 → 29    | 1/0/1/1  | 39250/0              | 46/676            | 2     | 2 / 0             |
| `full-local-delete1`          | plain / 20   | 38 → 36    | 2/0/2/0  | 78572/19671          | 41/612            | 5     | 2 / 1             |
| `full-remote-delete1`         | plain / 20   | 36 → 33    | 3/0/1/0  | 78932/0              | 44/654            | 4     | 2 / 0             |
| `full-followup-noop`          | plain / 20   | 10 → 9     | 1/0/0/0  | 19733/0              | 40/598            | 2     | 0 / 0             |
| `json-restart-full-noop`      | plain / 20   | 19 → 18    | 3/0/0/0  | 59199/0              | 40/598            | 2     | 0 / 0             |
| `realtime-edit1`              | plain / 20   | 28 → 28    | 0/0/2/0  | 39349/19703          | 1/22              | 6     | 2 / 1             |
| `realtime-edit42`             | plain / 20   | 216 → 216  | 0/0/4/0  | 78551/40280          | 42/1040           | 10    | 4 / 2             |
| `realtime-followup-full-noop` | plain / 20   | 10 → 9     | 1/0/0/0  | 19610/0              | 42/1040           | 2     | 0 / 0             |
| `json-restart-pending-full1`  | plain / 20   | 59 → 52    | 3/0/2/0  | 98051/19631          | 43/1056           | 4     | 2 / 1             |
| `json-restart-noop`           | plain / 20   | 10 → 9     | 1/0/0/0  | 19611/0              | 42/1036           | 2     | 0 / 0             |
| `token-initial-empty42`       | plain / 20   | 1010 → 497 | 3/0/1/42 | 79082/0              | 84/820            | 47    | 2 / 0             |
| `initial-empty-followup-noop` | plain / 20   | 10 → 9     | 1/0/0/0  | 19668/0              | 42/410            | 2     | 0 / 0             |
| `token-initial-identical42`   | enc / 20     | 83 → 66    | 2/2/0/0  | 40524/0              | 168/1640          | 6     | 0 / 0             |
| `full-noop42`                 | enc / 20     | 12 → 11    | 1/1/0/0  | 20262/0              | 42/410            | 2     | 0 / 0             |
| `full-upload1`                | enc / 20     | 52 → 45    | 1/1/2/0  | 59667/19751          | 43/429            | 3     | 2 / 1             |
| `full-upload42`               | enc / 20     | 789 → 496  | 1/1/2/0  | 59622/21434          | 84/1240           | 3     | 2 / 1             |
| `full-download1`              | enc / 20     | 32 → 31    | 1/1/1/1  | 39900/0              | 46/676            | 2     | 2 / 0             |
| `full-local-delete1`          | enc / 20     | 40 → 38    | 2/1/2/0  | 79250/19699          | 41/612            | 5     | 2 / 1             |
| `full-remote-delete1`         | enc / 20     | 38 → 35    | 3/1/1/0  | 79610/0              | 44/654            | 4     | 2 / 0             |
| `full-followup-noop`          | enc / 20     | 12 → 11    | 1/1/0/0  | 20327/0              | 40/598            | 2     | 0 / 0             |
| `json-restart-full-noop`      | enc / 20     | 25 → 24    | 2/4/0/0  | 41786/0              | 40/598            | 3     | 0 / 0             |
| `realtime-edit1`              | enc / 20     | 30 → 30    | 0/1/2/0  | 39971/19759          | 1/22              | 6     | 2 / 1             |
| `realtime-edit42`             | enc / 20     | 218 → 218  | 0/1/4/0  | 79229/41512          | 42/1040           | 10    | 4 / 2             |
| `realtime-followup-full-noop` | enc / 20     | 12 → 11    | 1/1/0/0  | 20204/0              | 42/1040           | 2     | 0 / 0             |
| `json-restart-pending-full1`  | enc / 20     | 65 → 58    | 2/4/2/0  | 80817/19687          | 43/1056           | 5     | 2 / 1             |
| `json-restart-noop`           | enc / 20     | 12 → 11    | 1/1/0/0  | 20205/0              | 42/1036           | 2     | 0 / 0             |
| `token-initial-empty42`       | enc / 20     | 1011 → 498 | 2/2/1/42 | 61806/0              | 84/820            | 47    | 2 / 0             |
| `initial-empty-followup-noop` | enc / 20     | 12 → 11    | 1/1/0/0  | 20262/0              | 42/410            | 2     | 0 / 0             |
| `initial-identical42-limit`   | plain / 1    | 82 → 65    | 3/0/0/0  | 59004/0              | 168/1640          | 6     | 0 / 0             |
| `full-noop-uneven-deep`       | plain / 1    | 31 → 30    | 1/0/0/0  | 21278/0              | 42/410            | 2     | 0 / 0             |
| `initial-identical42-limit`   | plain / 20   | 82 → 65    | 3/0/0/0  | 59004/0              | 168/1640          | 6     | 0 / 0             |
| `full-noop-uneven-deep`       | plain / 20   | 31 → 30    | 1/0/0/0  | 21278/0              | 42/410            | 2     | 0 / 0             |
| `initial-identical42-limit`   | plain / 40   | 82 → 65    | 3/0/0/0  | 59004/0              | 168/1640          | 6     | 0 / 0             |
| `full-noop-uneven-deep`       | plain / 40   | 31 → 30    | 1/0/0/0  | 21278/0              | 42/410            | 2     | 0 / 0             |

Exact synthetic evidence, under the snapshot directory:

- `before.json` SHA-256: `6948498b86cc9648c642a738f42914a7155fe0f5c02122bf7e2994eb803537ff`.
- `after-final2.json` SHA-256: `6adcd43985a4a3821359fb3f42fd42f0f90f8c9b9da6786595fafc8c228a212b`.
- `comparison.json` SHA-256: `19c950586dbca81fb320f8002cefc1642727b630b1cc408005f82efc02758935`.

## Checks, reproduction and limitations

All listed logs are safe synthetic/source-only outputs under the snapshot path.
No .env*, real plugin data, authentication or user/service logs were read.
Build output was suppressed to `/dev/null` before capture for every attempt.

- `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-02-runf4egy/before.json`:
  exit0,38 rows; accepted stage01 production identity confirmed.
- Focused reproduction: bundle `tests/sync-user-flows.test.ts` with esbuild plus
  `tests/helpers/obsidian-stub.mjs`, then `node --test --test-name-pattern=... focused.mjs`.
  RED logs above; focused GREEN includes session, initial batch and two-device bulk.
- `npm run lint:fix`: final exit0 (`lint-fix-final2.log`).
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-02-prettier-ignore`:
  exit0 (`format-final.log`); queue and fixtures excluded, foreign hashes checked.
- `npm test`: final364/364, no skipped/cancelled (`suite-final2.log`). Original363
  remain plus one distinct pagination/recovery interaction case. Intermediate
  363/364 result is retained in `suite-final.log`;3 repeat focused runs in
  `batch-repeat.log`.
- `npm run lint`: exit0 (`lint.log`).
- `npm exec -- tsc -noEmit -skipLibCheck`: exit0 (`typecheck-final.log`).
- `npm run build > /dev/null 2>&1`: first exit2 from the diagnosed type errors;
  after correction sandbox exit1, approved execution path exit0. A separate
  typecheck succeeded; approved build succeeded. As in prior stages, the latter
  sandbox/approved difference is an execution restriction, not compilation failure.
- `npm run format:check` with the same ignore paths: exit0 (`format-check.log`);
  final report-only formatting/plain check recorded at handoff below.
- `git diff --check`: exit0.
- `npm run check:sync-efficiency -- --out /private/tmp/sync-efficiency-02-runf4egy/after-final2.json`:
  exit0,38 rows. Earlier `after-first.json` and `after-final.json` are intermediate
  measurements; `after-final2.json` matches final formatted production identity.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0; deliberate synthetic
  byte corruption rejected (`oracle.log`).

Rulings: explicit dirty-checkout/no-commit/no-next-worker constraints supersede
skill worktree/commit/plan deletion steps. Only the final read-only review was
delegated as required by the applied review skill. No other chat was messaged.
Stage00 JSON is immutable. The coordinator alone owns queue.json and acceptance.
No new API/package or real-service experiment was needed.

Build artifact: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`.
Native Android/Obsidian lifecycle behavior, live pagination/network timing and real
Yandex two-profile smoke remain **PENDING**. The stopped-batch fixture defect is
resolved by the proven correction below; the product stop guards are unchanged.

## Handoff API

- `session(validate?)`: callable `CanonicalReadSession`; obtains a new stable raw
  root pair on each call, runs `validate(observation)` while that opaque observation
  is live, validates/downloads canonical and returns an independent clone.
  Failed evaluation rejects subsequent queued reads. `load()` retains the private
  verified load seed; `assertCurrent()` checks config/lifetime only, no I/O.
- `IndexManager.assertRemoteScope(observation?)` and
  `isEncryptionManifestTokenCurrent(token, observation?)` consume that opaque
  observation only during its callback. Omitting it preserves independent fresh
  reads. Expired/foreign objects throw, including when local history is unbound.
- Existing `SyncGuardCallback(token?, observation?)` and the fourth ordinary-full
  workflow guard argument forward metadata explicitly. No engine-global borrowed
  observation. `StorageBindingController.ensure(prompt, observation?)` only uses
  it for an already bound noninteractive validation.
- Do not retain this observation across operations, promote it to a commit proof,
  remove client writeGuard, seed bytes from caller indexes, or widen its use into
  Direct Force/realtime without a separate design. Later stages may build on these
  ports while preserving every fresh pre-write/retry boundary.

## Final handoff verification

Final plain `npm run format:check`: exit0 (`format-check-final.log`);
`git diff --check`: exit0. Before the correction, all16 captured incremental file hashes matched
`incremental-identity.json`; corrected handoff uses `incremental-corrected-identity.json`; every other captured file, historical fixture,
immutable baseline and staged diff/index matches the original snapshot. The final
production digest was independently recomputed and equals the38-row final runner
identity above. Temporary formatter ignore was removed. `build/main.js` exists
(730152 bytes); generated output was not staged. Report formatting is checked
again after this final note.

## Coordinator correction — stopped-batch fixture, proven and closed

The coordinator rejected the earlier handoff until the intermediate3!==1 was
explained. The candidate was confirmed on the actual IndexManager/SyncEngine/
VaultAdapter/read-session algorithms, using independent desktop/phone state and
real plaintext/encryption codecs. No production source or diagnostic runner was
changed by this correction.

Controlled canonical JSON retained the same logical entries, epoch/revision and
user bytes/fingerprints, with insertion order set to `a,b,c` or `c,b,a`. Canonical
service bytes were deliberately reserialized for each controlled order; the
preservation snapshot was captured after that fixture seeding and before receive.
This is a valid representation: `serializeCurrentIndex` uses JSON.stringify,
parallel upload completion can change insertion order, and initial receive builds
its tasks from Object.entries(canonical.files). `maxConcurrency=1` preserves that
actual task order. The old injection triggered after metadata for named `a.md`,
which is the first task only in one of those orders.

The safe scratch probe `order-probe.ts`/`order-probe.json` records16 controlled
runs: both modes, pause/connection ABA, both orders, old named-a injection and
proposed first-actual-task injection. Only synthetic a/b/c names and counts are
printed; no contents, ciphertext or credentials. Every run asserts success=false,
observedRevision=lastSyncTime=0, empty local baseline and mutation/physical queues,
exact remote bytes unchanged and all local bytes preserved. Results in every mode
and for each stop type:

| Canonical order | Injection         | Metadata sequence | Reads at stop | Reads after stop | Old total==1 oracle |
| --------------- | ----------------- | ----------------- | ------------- | ---------------- | ------------------- |
| a,b,c           | named a           | a                 | 1             | 0                | pass                |
| c,b,a           | named a           | c,b,a             | 3             | 0                | fail:3!==1          |
| a,b,c           | first actual task | a                 | 1             | 0                | pass                |
| c,b,a           | first actual task | c                 | 1             | 0                | pass                |

The deterministic persistent RED pinned the existing pause/connection fixture to
adversarial canonical order `c,b,a`, leaving the old named-a hook unchanged. The
same test failed exactly3!==1 at false/pause (`correction-order-red.log`). The
minimal correction captures the first actual user metadata path and applies the
stop after that task's response. It retains total userMetadataReads==1 and adds
explicit readsAtStop==1 / readsAfterStop==0, checks that loaded canonical order is
indeed c,b,a, and requires an empty saved baseline. Existing byte, queue, observed
revision/time, no-write and JSON-restart recovery assertions remain. Other failure
injections keep their original named targets. No tests/cases were added or hidden;
the default suite remains364.

This is a fixture/oracle mismatch, not evidence of a product stop race. A
post-stop queued read would fail both the explicit after-stop0 assertion and the
strict total1 assertion. The correction does not relax the expected count to3.
The historical failing run did not log its own insertion order, so no missing
historical trace is invented; the causal controlled counterexample and one-change
RED/GREEN establish and remove the fixture's faulty assumption.

Reproduction/evidence under the same snapshot directory:

- Bundle `order-probe.ts` with esbuild and the existing Obsidian stub, then run
  `order-probe.mjs`; exit0 with16 safe trace rows (`order-probe.log`). Its JSON uses
  exclusive creation and is preserved. Probe source SHA-256:
  `f963e6eb93a9b04bcab08a3c0649a6daabe323d747e3f5e3f710a0b9d1852062`;
  trace JSON SHA-256:
  `8f7655a84d88a87ce55d9cbfef37c572158411f88a65df58677f05c5baa58431`.
- Existing test bundled with the same stub, then
  `node --test --test-name-pattern='initial matching batch' correction-focused.mjs`:
  old hook RED exit1 /3!==1 (`correction-order-red.log`), fixed hook GREEN exit0
  (`correction-order-green.log`); final stronger fixture GREEN exit0
  (`correction-focused-final.log`).
- `npm test`: exit0,364/364, no failed/skipped/cancelled (`correction-suite.log`).
- `npm run lint:fix`: exit0 (`correction-lint-fix.log`);
  `npm run lint`: exit0 (`correction-lint.log`).
- `npm run format` with verified root-relative queue/fixture exclusions: exit0
  (`correction-format.log`). Required final report/plain formatting checks are
  recorded below after report formatting. Exclusions remain in place for writes.
- `npm run build > /dev/null 2>&1`: approved execution exit0; stdout/stderr suppressed
  before capture. The known sandbox restriction was not re-probed.
- `git diff --check` and source/index/foreign hash preservation: checked again at
  corrected handoff. Existing approved build path was reused; no cloud/vault
  experiment, stage/commit/push, owner queue or other chat operation occurred.

Correction source boundary:

- `correction-before/` and `correction-before-identity.json` preserve the first
  stage02 handoff's test/report bytes.
- `correction-test.patch` isolates the sole changed test file versus that handoff;
  SHA-256 `fdaf26a8b5dbfcf86b51f3356fa9a344e6a25ec1aa89c5b4545cfda22effc635`.
- `incremental-corrected.patch` and `incremental-corrected-identity.json` supersede
  the earlier incremental pair for the entire16-file stage02 diff. All other
  captured bytes remain unchanged, including production, diagnostic runner,
  historical fixtures, immutable stage00 JSON and staged/index state.
- Production digest remains exactly
  `4337c15d1ba17b8f611b123fd5b0fa96f069ee62c888fa279250d051c5a5a701`;
  runner digest remains
  `bb73c1ae00a111bae23b2f7925583118c817d9c7c80ddce0cc02dd800c8ddcb2`.
  The38-row `after-final2.json`/comparison still represent this exact production
  and runner. A diagnostic rerun is unnecessary for test/report-only correction.

Metric correction: the authoritative final JSON is `after-final2.json`. Its
bulk42 full-upload API GET totals are plain **496** and encrypted **496**, versus
fresh before787/789 respectively. The earlier final reply's plain494 mistakenly
quoted intermediate `after-final.json`. That intermediate has root270 versus
root272 in final JSON, metadata448 versus450, with identical link/native body,
PUT/MOVE, bytes/local/persistence/outcome counts. Thus two samples show a2-root-GET
variation; this is not claimed as a guaranteed range or an additional saving.
The table above already contains the correct final496. All report/final summaries
now use496/496 and retain the exact sample identity.

Corrected handoff verification: final plain `npm run format:check` exit0
(`correction-format-check.log`), `git diff --check` exit0; all16 corrected
incremental hashes, every other captured file, fixture/baseline and staged/index
match their expected snapshots. Temporary formatter ignore was removed. Production
and runner digests independently recomputed and unchanged as above. Final report
formatting/check repeated after this note (`correction-report-check.log`).

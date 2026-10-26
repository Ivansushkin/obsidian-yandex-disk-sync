# Sequential sync efficiency work

## User authorization

On 2026-10-23 the user approved the full staged sync efficiency plan, requested
one fresh local Codex chat per autonomous work item, sequential execution, and
before/after checks for first sync after token setup, ordinary full, and realtime.
The user will be absent: resolve routine choices without questions, keep working,
and report actual limitations. This explicitly authorizes the coordinator to
create the listed chats, send corrective follow-ups to them, and keep this queue
moving through a thread heartbeat. It does not authorize commit/push, publishing,
access to sensitive data, or destructive live-service experiments.

## Ownership and durable handoff

- Repository: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync`.
- Coordinator chat: `01a1640a-4529-74b3-836e-72525812ee06`, host `local`.
- Project: `54aef0c7-3a05-4119-87c0-d2cc1d3248d8`.
- Only the coordinator updates `queue.json` and dispatches work. Workers must not
  create other worker chats, change automation, or dispatch the next stage.
- Exactly one active worker. A stage is accepted only after the worker is idle,
  its report exists, evidence is inspected, and its completion contract is met.
- Every worker reads this file, its own stage brief, applicable AGENTS/docs and
  prerequisite reports. Do not load the entire original conversation.
- Workers write `reports/NN-*.md` before their final response, including changes,
  baseline and final evidence, exact reproduction/check commands, rulings, safety
  boundaries, and remaining work. Failure reports include the current partial
  diff and a concrete continuation, never a false completion.
- Reports use concise Russian or English; user-facing communication is Russian.
- Coordinator captures per-stage source/diff identity and checks acceptance. If a
  stage needs correction, resume that worker with a scoped prompt; no duplicate
  worker. Following stages start only after acceptance.

## Shared implementation constraints

The checkout is intentionally dirty. Preserve staged Direct Force direct-v1,
unstaged mobile initial-receive/concurrency fixes, and the completed test reduction
(`docs/TEST_OPTIMIZATION.md`, previously 361 executable cases). Never reset,
checkout, stage, commit, push, create a worktree, clean, or edit another task's
artifacts. Establish the fresh actual baseline instead of assuming HEAD is it.

Retain one SyncCoordinator, one LocalOperationStore and one persistence queue.
Retain Direct Force behavior, its full hidden/config inventory, direct canonical
publication without locks/staging, checkpoints/recovery and ordinary-full resume.
Keep current markers, schemas, epoch/revision, mutation IDs/FIFO and settings
(`maxConcurrency` 1..40, default 20, saved user values preserved).

Reuse existing IndexFileSnapshot, fingerprint, pagination, coordinator/store and
codec helpers. A read observation is not CanonicalCommitProof or physical write
authority. Fresh guards before physical PUT/DELETE/local overwrite and retries,
post-transfer validation, backup requirements, and durable acknowledgements remain.
Bytes may be reused only within an explicit invocation-bound session after fresh
unlocked stable-root observations and matching server SHA-256/MD5. No hash/drift
means the existing stable download path, never resource-ID-only content reuse.
Configuration generation/path/codec checks bracket awaits; reject token/path/codec
ABA changes, cancellation, unload and late results. No global/persistent cache or
TTL. Independent sessions never borrow old observations.

Do not remove repeated local SHA checks, mandatory saves, or transaction guards
merely because they are expensive. Retain them unless a concrete algorithmic
counterexample and safe replacement prove otherwise. No crypto iteration change.
No broad speculative refactor, extra coordinator, telemetry, Node/Electron runtime
dependency in the plugin, or production-domain logic in main.ts.

Do not read/search/copy .env*, real plugin data or sensitive logs, tokens/passwords,
auth files, or restricted service records. Trusted required build scripts may read
their own inputs, but suppress potentially sensitive stdout/stderr BEFORE capture
(e.g. command redirection to /dev/null, with only exit status reported). Other
source-only checks may use a safe scratch output file and compact summaries.
Do not run real cloud operations or overwrite a user's vault.

## Evidence and minimum tests

Use real project algorithms over MemoryDisk and two independent local states,
with actual plaintext/encryption codecs and a valid current encryption manifest.
Separate API metadata/link requests, native body transfers/bytes, locks/MOVEs,
local reads/bytes, persistence requests, and controlled synthetic latency/overlap.
Counts alone are insufficient: assert bytes, canonical, local baseline, queues,
receipt identity and restart behavior. Synthetic time is not Android/Yandex proof.

Use existing functional tests first; extend the minimum distinct boundaries.
No test for every helper, branch, trivial assignment, UI string or matrix product.
A new test requires an identified failure absent at the same existing boundary.
Do not undo the test reduction or hide existing cases outside the default suite.
The diagnostic runner is extra measurement, not a substitute for existing tests.

For each behavior change observe a minimal relevant RED before implementation,
then GREEN with real algorithms. Run focused scenarios while iterating, before/after
efficiency checks for affected modes, and required final gates after edits:
`npm run lint:fix`, `npm run format`, `npm test`, `npm run lint`, `npm run build`,
`npm run format:check`, `git diff --check`. Inspect formatter changes and preserve
unrelated hunks. Use npm only. Treat approved-build/sandbox failures accurately.
Update stable IDs in docs/SYNC_USER_SCENARIOS.md and relevant architecture,
parallelization, encryption and mobile smoke docs as behavior changes.

## Prior research (hypotheses to recheck against this checkout)

The earlier scratch diagnostic is `/private/tmp/yandex-sync-cost-audit/run.mjs`
with `probe.ts`, `details.json`, `summaries.jsonl`. These are synthetic fixtures,
not user logs. It may be reused as a starting point, but do not rely on private
method monkeypatches or absolute scratch imports for a durable runner.

Observed plain/encrypted API GET counts: 42 initial identical 79/81; established
42-file no-op 11/13; one upload 55/59; 42 uploads 916/1002; one download 31/33;
empty-phone receive42 1007/1009. Bulk42 uploads downloaded canonical bodies85,
lock bodies2, encrypted manifest bodies43. Initial identical read local bytes168
times (four passes). Cold startup plus initial42 used 86/92 GETs and 4/3 canonical
bodies; encrypted mode read manifest bodies4 and rederived a matching key once.
Realtime was not yet profiled with the same rigor and must be included now.

## Completion

Final state is `completed_automated` only after all eight stages are accepted,
full gates pass and comparable before/after measurements exist for all requested
invocation paths. Mark real Android/native Obsidian + two-profile Yandex smoke
explicitly pending, unless actually performed with safe authorized access.
Provide a concise Russian final report and the exact build/main.js path.
Stop the queue heartbeat after completion or a substantive unrecoverable blocker.

# Unit suite optimization — 2026-10-23

The requested metric is the number of executable cases in the default `npm test`
suite. The starting working-tree snapshot passed **519/519** cases in 48 files.
The reduction target is at most **363** cases. Source size is measured separately;
a smaller registered test count is not a measured runtime or coverage percentage.

## Changes and retained boundaries

| Area                                  | Simplification                                                             | Retained outcomes                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conflict planning and causality       | Shared input/output rows instead of repeated resolver setup                | Exact/folder deletion, concurrent edits, remote fingerprints, first sync, epoch adoption                                                              |
| Canonical validation and transactions | Explicit payload/admission/outcome tables                                  | Legacy rejection, strict mode/schema checks, lost replies, exact-byte rollback, restart and recovery                                                  |
| Backup, encryption and HTTP           | Reuse expensive codec/setup within a scenario; table equivalent failures   | RFC vector, authenticated roundtrip/tamper, invalid UTF-8, historical domains, wrong archive password, stable reads, timeout and authority revocation |
| File/folder rename and full barriers  | Common independent-state fixtures; remove duplicated fake encrypted labels | Changed pending-put hashes, original FIFO identities, restored foreign sources, target collisions, ambiguous moves, missing-source receipt recovery   |
| Watcher and coordinator               | Share setup for settlement/admission variants                              | Captured vs late work, startup/manual admission, failed sessions, persisted acknowledgement and serialized execution                                  |
| Local data and Force controller       | Validate equivalent payload/phase failures through outcome tables          | Prototype paths, migration precision, coherent queues, archive choice, committed vs uncommitted failures and no false success                         |

The removed `encrypted` labels used fakes with no encryption codec. Those paths
read neither the setting nor an encrypted transport. Real codec tests and
independent two-device plaintext/encrypted workflow scenarios remain.

The test runner and production algorithms were not changed by this optimization.
No cases were skipped or moved outside the default suite. Scenario references in
`SYNC_USER_SCENARIOS.md` follow the retained executable names. Independent review
compared changed tests with the initial working-tree snapshot; findings about
changed pending-put bytes, missing local replay sources and wrong current backup
passwords were corrected inside the tables.

## Validation

| Metric             | Starting snapshot | Final working tree | Reduction |
| ------------------ | ----------------- | ------------------ | --------- |
| Executable cases   | 519               | 361                | 30.44%    |
| Default test files | 48                | 48                 | 0%        |
| Test source lines  | 19,061            | 18,233             | 4.34%     |
| Test source bytes  | 569,809           | 538,544            | 5.49%     |

The final count includes one fingerprint-budget regression added concurrently in
`sync-user-flows.test.ts`, outside this optimization. Of the original snapshot,
360 registered cases remain; the extra current case brings the final count to 361.
Tables still execute their individual input variants. Case-count reduction does
not mean that 30% of behavioral assertions or scenario variants were removed.

Final `npm test`: **361/361 passed**, zero failures/skips/cancellations. ESLint,
TypeScript, build, Prettier and `git diff --check` passed. The sandboxed bundler
failed; the same `npm run build` succeeded through the approved execution path.
No sensitive local build output was captured. All previously executable catalog
references resolve to current runtime test names (zero newly dangling references).
No runtime-speed improvement is claimed from these differently loaded runs.

Passing unit checks do not establish real Obsidian/Yandex Disk behavior. No manual
Obsidian run or real Yandex request was performed for this test-only refactor.

# Force safety: evidence and remaining release gates

Investigation base: `5aeca24ba618302b150f203e35d96cb552cc432a`.
Integration base: fresh `origin/master` at `b6f6829361e3e44b33d9f4ca1a0b1a40b8c8a99a`
(the same source tree, with the merged branch history). Changes are prepared on
`codex/sync-refactor-hardening`. No version bump or release.

## Regressions and scope

The original stale-folder reproduction failed on exclusive payload MOVE with
`DiskPathDoesntExistsError` 409. The production fix clears Force observations,
checks physical parents and allows bounded re-inventory only after a missing
parent is proved. Unknown 409, collision, guard, access and ambiguous failures
are not a reason to recreate folders or overwrite destinations.

Final canonical publication now returns a verified raw SHA-256/revision receipt.
Receipt persistence precedes cutover/clear. Staged final publication rechecks
source before MOVE, including staged-target promotion after a crash; a receipt
with missing canonical never authorizes promotion. Post-commit recovery never repeats replacement. Advanced
same-epoch state is reconciled normally, preserving late work and current codec.
Receipt-less changed canonical remains blocked. See FORCE-041 through FORCE-046,
INIT-038/039, NET-021, FDEL-020 and TRANS-040 in the normative catalogue.

`MemoryDisk` now rejects missing upload/move parents, distinguishes missing source,
missing parent and occupied destination, models subtree deletion/trash, and offers
`beforeRequest` (after client guard, before execution), `afterRequest` (after
mutation, before reply), and `asyncOperations` / `beforeOperation` (accepted async
operation, before completion). Pagination exposes actual limit/offset/total;
production traversal rejects changed totals, invalid offsets and duplicate paths.
Blocking full results clear automation readiness, including a failure after a prior
successful full; finally cannot restart stopped automation from stale readiness.
Unreadable Force authority from a superseded codec yields a sanitized typed block;
JSON/decryption errors cannot expose decoded wire bytes in the failure chain.
The real request algorithms, codecs, coordinator, canonical transactions and local
stores run in these tests. This is synthetic transport evidence.

The earlier 504/505 parallel diagnostic result is retained separately from the
505/505 isolated baseline. Its 15 ms timeout was reported at API GET /resources,
not the intentionally stalled transfer. The regression now supplies the existing download read budget only to the
intentionally stalled stable read (15 ms), after fixture preparation;
production timeouts were not raised. This removes that fixture setup deadline;
it does not claim that every possible timing instability has been explained.
A later loaded run also hit the same broad fixture deadline in encryption-workflow;
that test now scopes its 15 ms budget to the stalled canonical read. The original
521/522 run is kept distinct from the final verification.

## Server fencing: release remains blocked

Run `npm run test:force-fencing`. These are preservation assertions, not expected
loss, skipped tests or suppressed exceptions. This command is intentionally a
separate **failing release gate**; a passing ordinary `npm test` is insufficient.

| Request already past the client guard  | Timing exercised                                        | Required result                                                | Current result                                                                                                              |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Old Force DELETE                       | Before execution; accepted async then delayed execution | Successor bytes and canonical survive                          | FAIL: successor physical bytes disappear                                                                                    |
| Old ordinary PUT                       | Native request delayed before execution                 | Force winner survives and is not reclassified as external edit | FAIL: old bytes overwrite winner                                                                                            |
| Old manifest PUT                       | Native request delayed before execution                 | Successor manifest remains paired with canonical               | FAIL: manifest overwritten                                                                                                  |
| Old manifest DELETE                    | Before execution; accepted async then delayed execution | Successor encrypted manifest survives                          | FAIL: manifest removed                                                                                                      |
| Recursive folder DELETE                | Descendant can arrive after empty check                 | Descendant survives                                            | Optional pruning disabled in ordinary/Force/encryption; remote folder replacement blocked                                   |
| Exclusive MOVE / canonical publication | Collision, lost reply, restart                          | Never overwrite destination; recover one authoritative index   | Existing exclusive transaction regressions plus source-at-staging regression; async source-version fencing remains unproved |

Additional real-service contracts still required: PUT accepted
but not completed, MOVE source replacement after acceptance, canonical publication
against a successor, failed/unresolved async operations, and response loss after
server-side completion. Existing guards and staging do not establish these contracts.
A lease timeout does not make already-sent requests safe to take over.

The [YaDisk-async DeleteRequest implementation](https://yadisk-async.readthedocs.io/en/latest/_modules/yadisk_async/api/resources.html#DeleteRequest)
transmits optional `md5`; its [MoveRequest](https://yadisk-async.readthedocs.io/en/latest/_modules/yadisk_async/api/resources.html#MoveRequest)
exposes overwrite and force_async. These client implementations do not establish
when the server evaluates conditions, resource-version fencing, or folder safety.
The official delete/move documentation pages were inaccessible through the web
reader in this run. No authenticated Yandex integration or trusted contract-test
script is available in this workspace; no credential files were inspected.

Before adding conditional DELETE, verify on a separate disposable remote root:
matching/mismatching MD5, replacement after async acceptance, delete/recreate with
identical bytes (ABA), missing MD5 and folders. MD5 is content identity, not object
version. Preserve SHA-256/fingerprint policy; no unconditional fallback or extra
destination downloads in without-backup mode. No expectedMd5 API is added without
this evidence. PUT/MOVE need their own atomic conditions. If the service cannot
provide them at fixed visible paths, release stays blocked; storage generations
or a changed visible tree are outside the approved design.

## Real two-profile smoke (not run)

No Obsidian UI or authenticated Yandex smoke has been performed for this diff.
Use two isolated Obsidian profiles and a separate disposable remote directory.
Never use a user's production vault as the test destination.

1. Connect from empty settings; fail the first sync, retry manually; verify watcher
   edits and scheduled full work. Repeat after token/path change, pause/resume,
   Settings close, unload during await and restart after failed save.
2. Force both directions in plaintext/encrypted, with/without archive; interrupt
   at intent, transfer, final publication, receipt save and checkpoint clear.
   Verify stable operation ID/epoch on continue and cancel, separate new-operation
   confirmation, no repeated archive and no replacement after final commit.
3. Edit source before commit and after commit. Verify pre-commit stop, post-commit
   new work, late watcher IDs, one baseline per profile, offline return/reordered
   events, and a subsequent enable/disable/rotate transition.
4. Exercise excluded/protected scope, restricted include, custom config directory,
   ciphertext-like plaintext names, NFC/case collisions, Unicode/special/long paths,
   file/folder collisions, unreadable/zero/empty source, decrypt failure, 401/403,
   quota, partial listings and loss of responses. Errors must not imply emptiness.
5. Edit while Obsidian download/backup/modify/trash awaits. Verify the latest user
   version at the native Vault/FileManager boundary; synthetic adapter checks do
   not prove this. Run more than 1000 objects and partial middle failure, then
   verify a full pass converges without deleting unrelated descendants.

Record canonical epoch/revision and safe counts/hashes, baseline/queue outcomes,
physical/local survival and false-success absence. Keep credentials, file contents,
keys and ciphertext out of diagnostics. Only then update release evidence.

## Automated verification of the Force fixes

- `npm run lint:fix`, `npm run format`, `npm test`: completed; **522/522** tests pass.
- `npm run lint`, `npm run build`, `npm run format:check`, `git diff --check`: pass.
  Build output was suppressed before capture; after a classified permission
  restriction the unchanged standard build succeeded through approved execution.
- `npm run test:force-fencing`: **0/6**, nonzero exit. All six fail the required
  preservation outcome. Ordinary tests do not include or supersede this release gate.
- Fresh independent review identified two P1 issues (staged final promotion after
  crash; automation restart after a later blocking full). Both received failing
  reproductions, fixes and passing regressions before the final 522-test run.
- Scenario-reference comparison: 151 baseline validator findings, 151 current,
  zero new. Existing findings include unsupported grammar and old manual-case
  coverage mismatches; this is not a clean catalogue-validation claim.
- Real Yandex/Obsidian/mobile and server-version fencing evidence remains pending.

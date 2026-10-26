# 07 — independent final review and all-mode evidence

Stage07 automated work is complete; coordinator acceptance is separate. The global queue and automation were not changed. Release is **NOT established**: native Android/iOS/Obsidian and two-profile real Yandex smoke remain PENDING, and the existing release validator is not green.

Date: 2026-10-23, Europe/Moscow. Nonce: `0bc1595b-a97d-42b8-87cf-24d54c586bbe`.

## Actual scope and independent review

Reviewed real staged/working/untracked inventories, all21 changed production files against the actual stage00 dirty source, incremental reports00–06 and the combined source patch, the runner/fixtures and normative architecture/scenario/encryption/backup/conflict/Force docs. `optimization.patch` in scratch is3546 lines before this stage. The91 source copies in stage01's starting snapshot were individually checked against stage00's `identity.json`; they are the actual stage00 source, not a HEAD-only baseline. Staged Direct Force and inherited initial/concurrency/test-reduction work are preserved. This was a fresh-context review of stages00–06; stage07's own repairs received RED/GREEN and source review, without another reviewer or worker.

The pass covered invocation lifetime/close/poisoned queues, active/explicit decode contexts, config/transition/pause ABA, strict server SHA/MD5 and no-hash fallback, opaque observation expiry, root identity/pagination/locks, per-file budgets and traversal drain, desired/loaded dirty comparison, backups/fingerprints, receipt-before-ACK, coherent saves, native/API dispatch/retries/rollback, foreign source and FIFO restart. No new coordinator/store/persistence queue, schema/marker, crypto iteration, concurrency setting or window size was introduced. Force modules and their staged bytes were not edited.

## Findings, reproduction and repairs

1. **Important — ordinary full did not bind physical dispatch to its new session.** `full-dispatch.ts` and the existing lifecycle flow reproduced7 write requests after pause/resume in the microtasks following awaited write authority. Session validation had already expired, but only realtime supplied client.withWriteGuard. Full now passes the same CanonicalReadSession into that existing guard scope; synchronous client checks cover native/API dispatch and retry/rollback. The persistent existing test was RED7!==0 (`lifetime-red.log`), then GREEN0 post-stop writes, unchanged physical bytes/observed time, retained put and JSON restart convergence in plaintext/encrypted with a valid current manifest and actual admission guards.
2. **Important — finalize could acknowledge an expired full.** Real two-device reception plus pause/resume inside finalize returned success=true and advanced observedRevision1→2 (`finalize-red.log`, `finalize-test-red.log`). The same session is checked before finalization, around each finalize callback and before markRemoteObserved. Existing lifecycle case now proves pause/host-stop failure, retained partial received bytes, old durable observed/time, empty mutation/physical queues, then successful retry. `lifetime-manifest-green.log` and the final368 suite cover both boundaries. No new default test case.
3. **Important — tracked-source recovery could delete a foreign same-SHA canonical successor.** Freshly rebuilding stage06's `review-foreign.ts` reproduced its assertion failure: source became a phone tombstone, although peer had published a live source. The old stage06 report's blanket closure of this boundary was insufficient. A stronger existing rename-restart history publishes the peer's source immediately before recovery acquires canonical lock; both codecs were RED (`foreign-test-red.log`: deleted=true). `IndexManager.saveRemoteIndex` now optionally validates a clone of the acquired canonical before its existing reducer, forwarded through BestEffort. The recovery source validator compares epoch/maintenance and source SHA/deleted/actor/seq/changedRevision both before rematerialization and under lock. It neither changes the reducer nor grants physical authority. Semantic rejection rolls back without transient retry, preserving source, original IDs/FIFO and pending rename. A real JSON restart takes ordinary put-target, retaining foreign source and finishing target/copy. `foreign-physical-test-green.log`, `foreign-retry-current.log` and final suite are GREEN; peer convergence and subsequent no-op are asserted. The original one-invocation foreign probe now deliberately sees a pending failure; its corrected retry probe requires exact preservation and convergence after restart, rather than labelling that pending result success.
4. **Important — unindexed foreign physical source blocked recovery indefinitely.** `foreign-physical-red.log` records three consecutive failed real full invocations with the same pending predecessor. Extending the same rename-restart case was RED in both codecs (`foreign-physical-test-red.log`). If a stable source read matches neither the retained put nor the original canonical SHA, recovery now calls existing putRenamedUnsyncedFile: retarget the original ID/seq to target, leave foreign physical bytes untouched through the existing fingerprint/content cleanup guard, then let ordinary full discover/adopt source. `foreign-physical-test-green.log` and final suite verify both exact source/target bytes, durable settlement, peer/restart outcomes and no-op. No new store, mutation schema or unit case.
5. **Scoped evidence defect — new scenario references failed the repository's supported strict grammar.** SYNC-041…049 named npm commands as executable tests, had vague transition references, and omitted TC-09 coverage declarations. Corrected only these new rows, retaining diagnostic commands and pending native requirements in prose, exact executable names and manual-required. Their17 newly added validator diagnostics are gone. The full catalogue still has92 diagnostics, all a subset of93 in the verified stage00 snapshot. Existing custom manual-case identifiers/unsupported annotations and obsolete nonqueue references were not rewritten or hidden. `catalog-comparison.json`/`catalog-after.json` preserve exact lists. This is partial release-catalog coverage, not a passing release gate.

Test-fixture corrections during this stage are explicit: live metadata can encode deleted=false rather than omit deleted, so the preservation oracle checks Boolean(deleted)==false (old REDtrue still fails). The first complete post-physical suite was367/368: its initial timeout fixture used an arbitrary5ms sleep for a still-running response. A controlled20ms metadata delay reproduces false/timeout at changed==true (`initial-delay-red.log`); awaiting the existing response callback instead is GREEN (`initial-delay-green.log`), preserving strict1-before/0-after counts and all bytes/FIFO/ACK assertions. A test expected-map union caused TS2345 and a suppressed build exit2; adding Record<string,string> corrected that introduced test typing. The final build passes. No source failure was labelled unrelated without snapshot comparison.

## Comparable stage00 → final measurements

`after-verified.json` and same-source `after-verified-repeat.json` each pass the original38 histories. Fixture bytes/history, 2ms synthetic metadata delay, counters, outcome/receipt/FIFO oracles and measurement boundary are unchanged. Runner differences from stage00 are explicit invocation/observation plumbing, opt-in supplemental dispatch and exports; review confirmed no original history/counter/oracle rewrite. API GET excludes native bodies. C/M/L/U means canonical/manifest/lock/user GET bodies; bytes include actual native bodies, not link/API counts. Unchanged values are printed once.

| Scenario                      | Codec/limit | API GET    | GET bodies C/M/L/U  | Native bytes GET/PUT        | Local reads/bytes  | Saves | MOVE / revision Δ |
| ----------------------------- | ----------- | ---------- | ------------------- | --------------------------- | ------------------ | ----- | ----------------- |
| `token-initial-identical42`   | plain/20    | 82 → 25    | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0           | 168/1640           | 6     | 0/0               |
| `full-noop42`                 | plain/20    | 12 → 11    | 1/0/0/0             | 19668/0                     | 42/410             | 2     | 0/0               |
| `full-upload1`                | plain/20    | 56 → 43    | 3/0/2/0 → 1/0/2/0   | 98353/19695 → 59017/19695   | 44/443 → 43/429    | 3     | 2/1               |
| `full-upload42`               | plain/20    | 917 → 494  | 85/0/2/0 → 1/0/2/0  | 1712176/20230 → 58972/20230 | 126/1860 → 84/1240 | 3     | 2/1               |
| `full-download1`              | plain/20    | 32 → 15    | 1/0/1/1 → 1/0/0/1   | 39250/0 → 19635/0           | 46/676             | 2     | 2/0 → 0/0         |
| `full-local-delete1`          | plain/20    | 40 → 36    | 2/0/2/0             | 78572/19671                 | 41/612             | 5     | 2/1               |
| `full-remote-delete1`         | plain/20    | 38 → 33    | 3/0/1/0             | 78932/0                     | 44/654             | 4     | 2/0               |
| `full-followup-noop`          | plain/20    | 12 → 11    | 1/0/0/0             | 19733/0                     | 40/598             | 2     | 0/0               |
| `json-restart-full-noop`      | plain/20    | 21         | 3/0/0/0 → 1/0/0/0   | 59199/0 → 19733/0           | 40/598             | 2     | 0/0               |
| `realtime-edit1`              | plain/20    | 28         | 0/0/2/0             | 39349/19703                 | 1/22               | 6     | 2/1               |
| `realtime-edit42`             | plain/20    | 216        | 0/0/4/0             | 78551/40280                 | 42/1040            | 10    | 4/2               |
| `realtime-followup-full-noop` | plain/20    | 12 → 11    | 1/0/0/0             | 19610/0                     | 42/1040            | 2     | 0/0               |
| `json-restart-pending-full1`  | plain/20    | 65 → 53    | 5/0/2/0 → 1/0/2/0   | 137271/19631 → 58831/19631  | 44/1076 → 43/1056  | 4     | 2/1               |
| `json-restart-noop`           | plain/20    | 12 → 11    | 1/0/0/0             | 19611/0                     | 42/1036            | 2     | 0/0               |
| `token-initial-empty42`       | plain/20    | 1010 → 483 | 3/0/1/42 → 1/0/0/42 | 79082/0 → 20078/0           | 84/820             | 47    | 2/0 → 0/0         |
| `initial-empty-followup-noop` | plain/20    | 12 → 11    | 1/0/0/0             | 19668/0                     | 42/410             | 2     | 0/0               |
| `token-initial-identical42`   | enc/20      | 83 → 25    | 2/2/0/0 → 1/1/0/0   | 40524/0 → 20262/0           | 168/1640           | 6     | 0/0               |
| `full-noop42`                 | enc/20      | 14 → 13    | 1/1/0/0             | 20262/0                     | 42/410             | 2     | 0/0               |
| `full-upload1`                | enc/20      | 60 → 45    | 3/2/2/0 → 1/1/2/0   | 99625/19751 → 59667/19751   | 44/443 → 43/429    | 3     | 2/1               |
| `full-upload42`               | enc/20      | 1003 → 497 | 85/43/2/0 → 1/1/2/0 | 1738950/21434 → 59622/21434 | 126/1860 → 84/1240 | 3     | 2/1               |
| `full-download1`              | enc/20      | 34 → 17    | 1/1/1/1 → 1/1/0/1   | 39900/0 → 20257/0           | 46/676             | 2     | 2/0 → 0/0         |
| `full-local-delete1`          | enc/20      | 42 → 38    | 2/1/2/0             | 79250/19699                 | 41/612             | 5     | 2/1               |
| `full-remote-delete1`         | enc/20      | 40 → 35    | 3/1/1/0             | 79610/0                     | 44/654             | 4     | 2/0               |
| `full-followup-noop`          | enc/20      | 14 → 13    | 1/1/0/0             | 20327/0                     | 40/598             | 2     | 0/0               |
| `json-restart-full-noop`      | enc/20      | 27 → 21    | 2/4/0/0 → 1/1/0/0   | 41786/0 → 20327/0           | 40/598             | 3 → 2 | 0/0               |
| `realtime-edit1`              | enc/20      | 30         | 0/1/2/0             | 39971/19759                 | 1/22               | 6     | 2/1               |
| `realtime-edit42`             | enc/20      | 218        | 0/1/4/0             | 79229/41512                 | 42/1040            | 10    | 4/2               |
| `realtime-followup-full-noop` | enc/20      | 14 → 13    | 1/1/0/0             | 20204/0                     | 42/1040            | 2     | 0/0               |
| `json-restart-pending-full1`  | enc/20      | 73 → 53    | 4/5/2/0 → 1/1/2/0   | 120659/19687 → 59481/19687  | 44/1076 → 43/1056  | 5 → 4 | 2/1               |
| `json-restart-noop`           | enc/20      | 14 → 13    | 1/1/0/0             | 20205/0                     | 42/1036            | 2     | 0/0               |
| `token-initial-empty42`       | enc/20      | 1011 → 483 | 2/2/1/42 → 1/1/0/42 | 61806/0 → 21848/0           | 84/820             | 47    | 2/0 → 0/0         |
| `initial-empty-followup-noop` | enc/20      | 14 → 13    | 1/1/0/0             | 20262/0                     | 42/410             | 2     | 0/0               |
| `initial-identical42-limit`   | plain/1     | 82 → 25    | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0           | 168/1640           | 6     | 0/0               |
| `full-noop-uneven-deep`       | plain/1     | 33 → 32    | 1/0/0/0             | 21278/0                     | 42/410             | 2     | 0/0               |
| `initial-identical42-limit`   | plain/20    | 82 → 25    | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0           | 168/1640           | 6     | 0/0               |
| `full-noop-uneven-deep`       | plain/20    | 33 → 32    | 1/0/0/0             | 21278/0                     | 42/410             | 2     | 0/0               |
| `initial-identical42-limit`   | plain/40    | 82 → 25    | 3/0/0/0 → 1/0/0/0   | 59004/0 → 19668/0           | 168/1640           | 6     | 0/0               |
| `full-noop-uneven-deep`       | plain/40    | 33 → 32    | 1/0/0/0             | 21278/0                     | 42/410             | 2     | 0/0               |

Every row verifies exact local/physical plaintext, canonical/tombstones, durable baseline, mutation/event identity and settled queues. The JSON retains API metadata/download-link/upload-link categories, per-kind PUT/DELETE/MOVE, transfer bytes, local-read phases, results and receipt counts. `comparison-stage00.json` has every changed field. Saves are fixture persistence requests, not native filesystem writes.

Bulk42 actual sample917/1003→494/497 API GET (plain/encrypted); repeat494/496. Same-source difference is one encrypted root metadata request; all body/byte/local/save/state counters match. Initial stage07 source had the same documented root retry variation. Do not treat a sample as an exact fixed threshold or infer latency improvement. Canonical85→1; encrypted manifest43→1; lock reads2, user uploads42 and MOVE2 remain. Canonical GET bytes1672885→19681 plain /1675265→19709 enc; manifest24338→566 enc. Required user PUT bytes620/1796, lock GET39291/39347 and PUT19610/19638 stay unchanged. Local bulk reads126/1860→84/1240. Initial identical remains168/1640 local reads/bytes; no safety SHA pass was removed.

Configured limits1/20/40 are preserved. Initial identical no longer issues individual user metadata requests (peak0 at each limit), having reused positive root metadata; this is not a concurrency regression. Actual uneven deep-tree directory overlap remains1/6/6, API33→32; the separate existing functional case proves dynamic child/sibling overlap and drains all started tasks on error.

## Realtime, startup and coverage boundaries

Supplemental `boundaries-verified.json`:16/16 GREEN, actual watcher/debounce/coordinator, independent local states/codecs and valid manifest. Healthy edit1 stays28/30 API, canonical0, manifest0/1, lock reads2, user PUT1, MOVE2, saves6, local1/22. Burst42 stays216/218, canonical0, manifest0/1, lock reads4, user PUT42, MOVE4, saves10, local42/1040, windows32+10. Receipts retain event/mutation IDs, seq/SHA and accepted/pending distinction. Supplemental covers repeated same-path debounce, late successor, new unsynced handoff, after-ACK rename, offline rejection with durable2 events/mutations, JSON restart/full/no-op, and tracked modified handoff. No new realtime network saving is claimed. Actual decrypt counts remain3/6/7/11 for encrypted healthy supplemental actions; noisy process CPU is not a speed claim.

The stage02 c,b,a FIRST-actual-observation fixture still requires1-before/0-after/1-total; it was not weakened. Stage05's84 fresh validations/168 metadata GET with one encrypted decrypt, independent explicit-codec authentication, wrong/plaintext rejection and close/no-hash behavior remain in the passing default suite. Matching codec candidate tests count actual PBKDF2: connect1, repeated matching active0; verifier/canonical/manifest checks remain, iterations600000. StartupInvocation still closes in finally and never shares bytes with another invocation.

Comparable cold startup rows are JSON-restart startup classification/admission/full, and token rows use real settings/startup/crypto/full algorithms. Realtime uses actual watcher/timers/windows/receipts. Main's native onload/unload/UI/Notice and final persistPluginData wrapper save, actual PluginPersistence/native IO, binding confirmation, OS notifications, and provider timings are not measured. Real scheduler timer/main lifecycle ports have synthetic-host functional coverage in the default suite; scheduler is not a38-row timing measurement. No actual Android CPU/heap/latency or live Yandex result is claimed. No real vault/cloud experiment or sensitive-content read occurred; trusted build output was suppressed before capture.

## Test inventory and gates

Default361→368: seven distinct added algorithm interactions, not bulk units: full verified-byte reuse/healthy repair; full lifetime rejection; strict paginated root identity; read-only reception with pending FIFO; final drift/failed save/restart; authenticated prepared codec install; startup observation ownership/expiry. One pre-existing admission test was renamed to include late derivation and extended, not removed. `test-inventory.json` records the exact name diff (8 added names/1 renamed old name = net7). Stages03/06/07 extend existing cases without raising count; stage07 adds two lifetime boundaries and locked canonical/foreign-physical histories inside those cases. Original test discovery/config and baseline reduction are retained.

Final commands (all synthetic logs below are in scratch):

- `npm run lint:fix`: exit0 (`lint-fix-final-verified.log`).
- `npm run format -- --ignore-path .gitignore --ignore-path .prettierignore --ignore-path .sync-efficiency-07-prettier-ignore`: exit0 (`format-final-verified.log`). Root-relative queue, immutable baseline and historical fixtures excluded; --file-info confirmed ignored=true before writes. Foreign file hashes checked. Temporary ignore removed at handoff.
- `npm test`:368/368,0 failed/skipped/cancelled (`suite-final-verified.log`). Includes Direct Force/direct-v1 and recovery.
- `npm run lint`: exit0 (`lint-final-verified.log`).
- Approved `npm run build > /dev/null 2>&1`: exit0 after the disclosed test typing repair; stdout/stderr suppressed BEFORE capture. No equivalent sandbox retry or sensitive diagnostic read.
- `npm run check:bundle`: exit0; noble contribution9650 bytes, under12288 (`bundle-verified.log`).
- `npm run format:check` and `git diff --check`: passed before reports; final report-inclusive checks recorded at handoff below.
- `npm run check:sync-efficiency -- --out <fresh scratch.json>`:38/38 twice on final production; supplemental --realtime-boundaries:16/16.
- `npm run check:sync-efficiency -- --verify-oracle`: exit0, deliberate corruption rejected (`oracle-verified.log`).
- `npm run test:force-fencing`:0/6, exit1 (`historical-fencing.log`). All six also fail under individually verified stage00 source (`fencing-stage00.log`), proving this is outside the optimization diff. Direct Force's current contract explicitly provides no server fencing; these are historical preservation diagnostics, not passing evidence or a reason to retrofit staging/fencing. No safe-takeover guarantee.
- `npm run validate:release > /dev/null 2>&1`: exit1. Full output was not captured. Independently, the exact source-only catalogue check fails92 pre-existing diagnostics; evidence status is PENDING. Release validation is not green. Minimum continuation: separately reconcile the existing nonqueue catalogue/validator schema and obtain dated two-profile native release evidence; do not change Force contract to satisfy old fencing expectations.

Freshly bundled stage06 probes config, config-before-commit, restart, reverted target and asynchronous write dispatch passed. The foreign probe failed as detailed above and was repaired with a stronger existing persistent two-codec case plus restart probe. This distinction is retained rather than reporting6/6 original probes GREEN.

Deferred pre-existing minor: --only with no value still selects both codecs. Documented complete runner arguments remain valid; no original history changed to repair this optional CLI issue.

## Exact identities and preservation

Repository/branch/HEAD: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync` / `codex/direct-force-sync` / `b4716a0e998d5927d783981d39ab88527ffc66aa`.

- Stage00 production: `33a9c0870fd854ee59269edcec5db68280a2f04ff082c4b42d58a3d7fa8cb70e`.
- Accepted stage06 production: `702388cb0cdb4020f89b595705bd79c627cd3ea39088f5271d929ea35af423f8`.
- Final production: `ef32d1b5e73c1880256a329d56382f2e1c3617b31b3b3071384dda76df5cd287`.
- Stage00 runner: `c692b92b3cc8d9e103c60dab8b0e9e623c141246e99e1d3cf7cc171c79f48de0`; final runner: `f9d5f92ea4e3a609e58ac86ebcef9c6bbe63c147d5f19746697641adc2e1be19` (unchanged from06).
- Supplemental: `f6206e6556ea9720f3cbf31a5619b90bb6b5eb7605072cb4b4239e7e1b62d120` (unchanged from06).
- Immutable baseline JSON: `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`.
- Staged binary diff: `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131`; index entries: `72314bdfb5267cf34b25ea8be5f29fb9a8b80a40b381805323b9a52f58488818`; both byte-identical to00/06.
- Final38 JSON: `5caf867189915aa6b8cf5de486ab9d7bc9477c51d9631f69108ad2cfb59f2189`; repeat: `36ed91621fd9facece7cab4b666db039efd3710c0a60fd3a9ae734aea1d8bbb3`.
- Supplemental16 JSON: `41dc195c4fb4461bf91e22e7560952644bd939ed54f477d8b23b19d1cd43d078`.
- Stage07 incremental8-file patch: `a7d212e922187eb8f2e925f5d25cc75359d097eaa8a75c9bc98465857947c28c`; excludes new reports/owner queue. `incremental-identity.json` and `final-identity.json` retain exact per-file identities.
- 186 other captured files remain byte-identical, including historical fixtures, earlier reports and all runner sources. Owner queue was never written or restored; coordinator changes are excluded from worker-owned identity assertions.

Scratch: `/private/tmp/sync-efficiency-07-bk84ncc2`. Source digest method is the original runner's ordered compact JSON [path,SHA256] pairs; no source bytes were switched/reset. Authoritative baseline remains `/private/tmp/sync-efficiency-00-fy_aukvx` and immutable reports/00-baseline.json.

Build: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`, **744154 bytes**. Ready for native testing, not established release readiness. No branch/worktree/reset/stage/commit/push, queue/automation operation or other-chat message was performed. Coordinator owns acceptance and global queue completion.

Final handoff verification: report-inclusive plain `npm run format:check` exit0 (`format-check-final-verified.log`); `git diff --check` and `git diff --cached --check` exit0. Final suite368/368 (`suite-final-verified.log`), approved build exit0, source/runner/baseline/staged/index identities rechecked. Temporary formatter ignore removed; all186 foreign captured files preserved. Queue remains coordinator-owned.

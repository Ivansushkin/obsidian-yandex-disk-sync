# Sync efficiency — consolidated results

Automated optimization/review work is verified; coordinator acceptance is separate. Native Android/iOS/Obsidian and two-profile real Yandex smoke remain **PENDING**. Release validation is not green; no release or fencing claim.

All values below are API GET counts, excluding native bodies, **plaintext/encrypted**, stage00 → final. Same38 histories, payloads and outcome/receipt/FIFO oracles; detailed bytes/locks/local/saves for every row are in [07-final-review.md](07-final-review.md).

| Mode                          | Before → after API GET |
| ----------------------------- | ---------------------- |
| `token-initial-identical42`   | 82/83 → 25/25          |
| `token-initial-empty42`       | 1010/1011 → 483/483    |
| `json-restart-full-noop`      | 21/27 → 21/21          |
| `full-noop42`                 | 12/14 → 11/13          |
| `full-upload1`                | 56/60 → 43/45          |
| `full-upload42`               | 917/1003 → 494/497     |
| `full-download1`              | 32/34 → 15/17          |
| `full-local-delete1`          | 40/42 → 36/38          |
| `full-remote-delete1`         | 38/40 → 33/35          |
| `full-followup-noop`          | 12/14 → 11/13          |
| `realtime-edit1`              | 28/30 → 28/30          |
| `realtime-edit42`             | 216/218 → 216/218      |
| `realtime-followup-full-noop` | 12/14 → 11/13          |
| `json-restart-pending-full1`  | 65/73 → 53/53          |
| `json-restart-noop`           | 12/14 → 11/13          |
| `initial-empty-followup-noop` | 12/14 → 11/13          |

Bulk42 canonical native GET85→1; encrypted manifest43→1. Canonical bytes1672885→19681 plain /1675265→19709 enc; manifest24338→566. User uploads42, required lock reads2, MOVE2, saves3 remain. Local bulk reads126→84; initial identical168 remains. Baseline-only receive removes lock/MOVE; cold startup uses one canonical/manifest per invocation. Limits1/20/40 remain, deep-tree overlap1/6/6. Same-source bulk repeat494/496 GET versus primary494/497 differs only in one encrypted root metadata request; no fixed latency/CPU claim.

Realtime has no new network saving: single28/30 and burst216/218 GET, canonical0, windows32+10, saves6/10 and receipt/FIFO invariants unchanged. Supplemental16/16 covers late events, handoff, offline/restart and tracked-source convergence.

Final review repaired four demonstrated boundaries inside existing functional cases: full post-authority dispatch after pause/stop; false observed success during finalize; locked recovery replacing/deleting a foreign same-SHA source; and repeated recovery failure on unindexed foreign physical bytes. All received RED/GREEN; exact IDs/FIFO survive JSON restart and peers converge. New scenario references now validate; no mass unit generation.

Default suite **368/368** (baseline361; seven distinct interaction cases added by stages01/02/04/05; stage07 adds0). Lint/fix, format/check, build, bundle and diff gates pass. Historical fencing **0/6**, also0/6 on stage00, is outside Direct Force's no-fencing contract. `validate:release` exits1: the independent catalogue check retains92 diagnostics already present in baseline, and real release evidence is PENDING. No unresolved demonstrated optimization regression remains; these release/native gaps are explicit.

Final source `ef32d1b5e73c1880256a329d56382f2e1c3617b31b3b3071384dda76df5cd287`; runner `f9d5f92ea4e3a609e58ac86ebcef9c6bbe63c147d5f19746697641adc2e1be19`. Immutable baseline `c2c6958aed2a0d5d08a2c8ad5b9d61834d49d5b2a0db098e08649436c3d7b5bb`. Staged diff `5c73c60ab0a3116de606329c6e2d86924d077e1cb0b3bb59cad60aea402ed131` is unchanged. Exact snapshots/commands/inventory and evidence hashes: [07-final-review.md](07-final-review.md).

Build: `/Users/swnet/Desktop/github-repos/obsidian-yandex-disk-sync/build/main.js`, **744154 bytes**. No commit/push or queue/automation change. Next required evidence is real two-profile Obsidian/Yandex and Android/native smoke, followed by separate release-catalog reconciliation.

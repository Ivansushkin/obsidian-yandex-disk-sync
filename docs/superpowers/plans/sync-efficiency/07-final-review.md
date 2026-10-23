# 07 — Fresh-context review and final all-mode verification

Prerequisites: reports/00-baseline.md through reports/06-realtime.md; shared README.
Independently inspect the optimization diff against stage00's actual dirty-tree
snapshot, including staging/working/untracked sources. Do not blame or alter the
pre-existing Force/test-reduction diff without confirming a regression introduced
by this queue. Review observations/cache identity, config ABA, guard timing,
physical writes, receipts, cancellation/late work, pagination and persistence.

Reproduce any substantive finding on real algorithms before the minimal scoped
fix, with RED/GREEN and preservation of all earlier work. Do not add speculative
units or unrelated cleanup. Verify all earlier acceptance contracts; if one is
unsafe/incomplete, repair it or report the concrete unfulfilled contract rather
than claiming completion. Review the actual final code, not only worker reports.

Run the same stage00 diagnostic command/data/latency setup for first sync after
token configuration (identical and empty phone), cold startup, ordinary full
no-op/upload/download/delete, realtime single/burst/late/offline/restart and next
no-op. Compare aggregate GET/link/body bytes, lock/MOVE/commit, local reads,
persistence and overlap against the immutable baseline. Plaintext/encrypted and
selected limits1/20/40 must be represented without a Cartesian unit matrix.
Assert final bytes, canonical, baseline and durable queues, not only performance.

Run the complete current default suite including Force/recovery plus npm lint,
build, format:check and git diff --check, and the required fix/format commands if
you edit. Build stdout/stderr suppressed before capture. Check any relevant
existing release-gate script separately from default tests; preserve documented
Direct Force no-fencing limitations and never claim synthetic green proves live
fencing. Record actual failures/coverage boundaries precisely.

Publish reports/07-final-review.md and a concise consolidated reports/RESULTS.md:
before/after table for every requested sync mode, changes and correctness evidence,
test inventory changes and justification for each newly added distinct scenario,
baseline/final source identity, exact build path/size and commands. Mark actual
Android/native Obsidian + real two-profile Yandex smoke explicitly unperformed
unless safely and actually available; no real credentials/vault experiments.

Acceptance: no unresolved substantive optimization regression, all claimed stages
verified, full current gates, all-mode comparable evidence, docs consistent and
ready-to-test build. No commit/push. Do not change queue/automation or dispatch.

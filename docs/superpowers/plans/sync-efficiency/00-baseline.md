# 00 — Baseline and reusable functional measurements

Read README.md here and applicable project rules. No production behavior change.
Capture the starting branch/HEAD, staged and unstaged binary diffs, untracked file
inventory, and relevant source identities in a safe scratch directory. Preserve
the distinction between HEAD, index and working copy. Record the snapshot location.

Build a small reproducible source-only diagnostic, based on real existing
fixtures/algorithms (the scratch audit in README may help). Keep it maintainable
and callable through npm, e.g. `npm run check:sync-efficiency`; do not add a new
framework or copy large domain algorithms. Emit safe aggregate metrics and outcome
assertions, no payloads/secrets/signed URLs. Support output to a caller-selected
scratch file so later stages can compare without rewriting baseline artifacts.

Cover first sync after token configuration / cold admission (identical phone and
empty phone), established full no-op, one local upload, bulk42 upload, one remote
download and delete, plus realtime single edit and burst42 edits. Exercise real
settings/startup/workflow ports where possible rather than engine-only aliases;
state exact wrapper/UI coverage limits. Include follow-up no-op and JSON restart.
Use two independent states, real codecs/valid manifest; no full Cartesian matrix.
Use controlled delays or barriers to observe independent read overlap, include
the 1/20/40 limits and a small uneven deep tree. Reuse established test coverage
for crash/ambiguous responses instead of cloning it into a new runner.

Distinguish GET/link requests, actual canonical/manifest/lock/user byte transfers,
write/commit/MOVE counts, local byte reads and persistence requests. Assert final
bytes/canonical/baselines/queue identities as well as counters. Record baseline
costs for every requested mode and identify avoidable realtime costs for stage06.
The full runner must finish in bounded practical time; synthetic latency is
diagnostic, not a wall-clock CI release threshold.

Run the current suite and required checks. Build stdout/stderr must be suppressed
before capture. Save immutable baseline aggregate measurements and the reproducible
command in this queue's reports/00-baseline.md (or an adjacent small JSON file).
Record all pre-existing failures with evidence, not assumptions. Workers after
you need the current runner contract and exact baseline identity.

Acceptance: no domain behavior changes; all three sync modes measured using real
algorithms with state/byte outcomes; fresh baseline gates; reusable compact runner;
explicit normal/Force and manual-runtime boundaries. Do not dispatch next stage.

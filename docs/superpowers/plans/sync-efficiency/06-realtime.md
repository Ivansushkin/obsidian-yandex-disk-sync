# 06 — Realtime efficiency without changing receipts and FIFO

Prerequisites: reports/00-baseline.md through reports/05-startup.md; shared README.
Use baseline realtime findings and rerun the real watcher/batch path after prior
changes. Check single edit, burst42, multiple edits of the same path, rename
handoff/late event and offline/restart, followed by a clean full/no-op.

Fix only confirmed remaining avoidable service-body rereads/metadata calls using
the existing invocation-bound read sessions and fresh observations. Scope reuse
to the existing realtime window/drain; preserve sequential event semantics,
32-event/8MiB snapshot bounds, mutation/receipt IDs, accepted/recovered differences,
watermarks, successor edits, rename handoff, stop-on-error and save-before-ACK.
Do not parallelize realtime writes with naive Promise.all, enlarge windows, add a
coordinator or replace fresh write/retry/fingerprint validation with an old read.
Invalidate sessions on canonical publication/config/maintenance boundaries; a
canonical changed by a real commit requires a fresh identity/content observation.

If earlier stages already removed all proven avoidable realtime costs, report
the measured non-regression and required sequential work instead of inventing a
refactor. If a different concrete inefficiency is discovered, reproduce first and
apply only a minimal fix preserving the listed contracts; record the ruling.

Prefer extending existing watcher/receipt/real two-device flow scenarios for a
concrete RED/GREEN. Assert final bytes/canonical/FIFO, restart and no false success,
not only calls. No broad unit suite expansion. Run all-mode comparable diagnostics,
required gates and applicable normative/parallelization docs.
Write reports/06-realtime.md with measured before/after, required vs removed work,
and actual evidence for each realtime entry path.

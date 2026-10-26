# 02 — One composite observation per authority evaluation

Prerequisite: reports/01-session-reuse.md. Read shared README and current docs.
Extend existing stable root discovery with an ephemeral connection-bound result:
root identity, canonical metadata, locks and manifest metadata. Reuse it among
existing scope/manifest/canonical validators within one authority evaluation.
Use at least the initial-receive and ordinary-full authority call sites; domain
logic belongs in focused modules, main.ts only wires ports.

Fully paginate both stable listings. Include root identity/existence and service
identities in stability validation across every page/pass; reject replacement,
incomplete pages and configuration drift. Preserve recovery/lock behavior. No
global cache, TTL, cross-operation guard borrowing or persisted proof. A completed
observation is not write authority; the next required pre-write/pre-retry check
must obtain a new observation. Scope/manifest checks not represented safely by
the composite result keep their original fresh read.

Preserve required ordering and time-of-check boundaries. Do not batch a whole
initial download group under one old write authorization. Do not remove standalone
writeGuard simply because another check happened earlier. Avoid serializing every
independent operation under a new global mutex; keep concurrency bounded.

Minimal RED/GREEN: extend existing real read-session/drift and matching-batch
scenarios to exercise root replacement during pagination, manifest/canonical/lock
drift and config ABA; prove no writes or false observed success after rejection.
Use existing crash/timeout/Force scenarios instead of duplicating them.

Acceptance: one evaluation consumes one fresh stable fully paginated root pair,
without extra identical scope/manifest metadata reads; required later evaluations
stay fresh, and all state/byte/queue results remain correct. Rerun all-mode
measurements to expose cross-path regressions, required gates, and docs.
Write reports/02-fresh-observations.md explaining exact freshness boundaries.

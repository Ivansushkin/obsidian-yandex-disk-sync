# 01 — Invocation-bound canonical and manifest byte reuse

Prerequisite: reports/00-baseline.md. Read shared README and relevant docs.
Work only on ordinary full session reuse and safe accepted-upload local read order.

Extend existing canonical read sessions so initial load and subsequent ordinary-full
authority checks share a privately owned validated IndexFileSnapshot. Expose only
clones, preserve desired/loaded/observed state semantics, and preserve independent
readCanonicalIndex behavior. Pass the explicit session and admission manifest token
through full/file-operation dependencies; avoid engine-global mutable cache state.
Seed using the actual verified load snapshot, never a caller-supplied SyncIndex.

Every check retains fresh scope/stable-root/locks/server-hash observation. Reuse
only with matching server SHA-256/MD5 and no locks. No hash/drift uses stable
download with post-transfer metadata. Prevent concurrent duplicate downloads;
configuration/pause/unload/ABA changes across awaits and failed/late observations
must fail closed. Do not weaken or delete before-PUT/retry/ambiguous-readback guards
or globally change transport callbacks to save requests.

Seed per-operation guards with the full session's manifest validation token so an
unchanged manifest body is not downloaded per upload. Keep fresh token validation.
In accepted-upload repair check fresh physical fingerprint before reading/hashing
local bytes on the common healthy path; retain all fresh repair-write authority.
Do not change Direct Force or realtime algorithms in this stage. Make interfaces
available for later invocation-scoped reuse without applying them speculatively.

Use minimal existing functional RED/GREEN cases: two-device bulk uploads with a
valid encrypted manifest; canonical/lock/no-hash/config drift and late results at
new session boundaries; existing ambiguous PUT/repair tests. Check actual resulting
bytes, canonical and durable queues. No helper/unit matrix.

Acceptance: bulk42 unchanged service content no longer yields 85 canonical and43
manifest bodies: canonical bodies at most2 outside required lock-body reads,
manifest1 per unchanged full. Preserve all real required user transfers and final
state, follow-up no-op, drift rejection, independent-session freshness and Force.
Run affected measurements and required gates; update normative/architecture docs.
Write reports/01-session-reuse.md with before/after and API handoff.

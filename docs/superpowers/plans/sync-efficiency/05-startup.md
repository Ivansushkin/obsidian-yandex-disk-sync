# 05 — Reuse authenticated startup observations and codecs

Prerequisite: reports/04-baseline-only-commit.md. Read shared README and crypto,
startup/admission/recovery docs before editing. Work across real lifecycle ports,
not just a direct engine call. Cover token-setup automatic full, cold startup,
manual retry and scheduled admission where they share the path.

Pass verified observations between format classification, recovery detection and
admission, then to the following full invocation where appropriate. Keep ownership
explicit and invocation-bound; a standalone refresh ends its session. Revalidate
server identity/config before every reuse; recovery/manifest/codec/config changes
invalidate old observations. Legacy/historical/missing manifest, wrong password,
Force recovery and maintenance keep their original fail-closed blocks.

Avoid rederiving the exact active candidate after verifier authentication and
canonical/manifest target validation. Install/persist the already authenticated
codec with matching password/salt/profile parameters. No crypto iteration change,
durable secret cache, rollback after target commit or transition redesign. Keep
settings/service publication and persistence failure semantics coherent.

Minimal RED/GREEN: extend real startup/encryption workflow admission cases for
stable encrypted startup (no extra PBKDF2), drift/wrong candidate and recovery
invalidation. Exercise the diagnostic's token-driven cold flow before/after;
retain existing transition/Force tests rather than duplicating them.

Acceptance: unchanged startup no longer separately downloads the same service
bytes for each consumer; a matching verified active codec is not derived twice.
Independent future runs stay fresh; failed startup does not enable automation or
lose queued work. Required gates, all-mode diagnostics and docs.
Write reports/05-startup.md with exact covered invocation paths and limitations.

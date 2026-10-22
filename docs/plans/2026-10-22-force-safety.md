# Force safety implementation

Approved specification: the user's detailed Force/ordinary sync plan, 2026-10-22.
Base: 5aeca24ba618302b150f203e35d96cb552cc432a.

## Tasks

1. Strengthen MemoryDisk parent/collision/trash semantics; establish failing preservation regressions.
2. Refresh directed Force folder observations and verify missing physical parents before bounded recovery.
3. Separate Force maintenance from encryption recovery; restore automation after successful lifecycle retries.
4. Persist verified final canonical completion receipt; normalize old checkpoints; recover without replaying replacement or resetting new causal work.
5. Preserve operation identity on continuation, distinguish explicitly confirmed new replacement, filter excluded sources before codec selection.
6. Disable unsafe optional folder pruning and recursive remote collision replacement. Investigate service-side fencing; retain release block for unresolved in-flight writes.
7. Update normative scenarios, architecture, evidence and run all required validation plus a fresh review.

## Acceptance

Pre-commit source changes block replacement; post-commit changes remain ordinary work.
Recovery preserves ID/epoch/direction/codec/backup choice. Failures never imply empty sources.
No format marker, hardened profile, FIFO or physical action schema changes.
Old current Force checkpoints gain completion:null before automation; malformed receipts fail closed.
No claim of real Obsidian/Yandex safety from synthetic tests. Real two-profile smoke and atomic server fencing remain separate release gates.

## Review focus

Lost responses, crash between publication and receipt, receipt save/clear failure, successor canonical/encryption settings, late watcher events, missing cached parents, collisions, excluded descendants, lifecycle flags and unload.

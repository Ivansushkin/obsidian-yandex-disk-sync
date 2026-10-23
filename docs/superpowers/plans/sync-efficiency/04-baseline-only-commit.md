# 04 — Skip canonical transactions for baseline-only reception

Prerequisite: reports/03-inventory.md. Read shared README and current docs.
Replace full's had-file-operations remote-dirty shortcut with actual canonical
content changes and causal work. A pure download of an already published version
does not itself require moving canonical to a lock and back.

Skip only when desired canonical content is unchanged against its loaded state,
there are no unpublished mutations/watermarks, move completions, tombstones or
maintenance effects. Do not confuse local baseline changes with canonical edits.
Imported physical metadata, conflict results and required FIFO acknowledgements
still commit through the existing transaction. Retain fresh final validation,
coherent local persistence and durable physical recovery. Keep updateSyncTime and
observed revision/time behind the existing successful boundaries. No transaction
reducer/recovery rewrite, no Force change.

Minimal RED/GREEN: existing two-device full scenario with a remote-only accepted
version must update local bytes/baseline without canonical lock/MOVE. Its causal
counterpart with pending mutations/metadata effects must still commit and settle
only after persistence. Cover canonical drift/save failure/restart via existing
functional scenarios, not a table for every dirty field.

Acceptance: baseline-only download saves local state with unchanged remote bytes
and revision and zero canonical lock transaction; necessary causal commits,
deletes, conflicts, physical work and receipts remain. Rerun all-mode diagnostics,
required gates and normative/architecture docs. Write reports/04-baseline-only-commit.md.

# 03 — Efficient bounded metadata collection and traversal

Prerequisite: reports/02-fresh-observations.md. Read shared README and docs.
Use fresh metadata already obtained by the current initial-receive observation for
read-only identical-file admission. For other relevant paths share one metadata
collector between initial receive and post-upload stamping. Group by immediate
parent; choose individual GET vs fully paginated parent listing by the lesser
estimated request count (needed paths vs known prior inventory page count).
Unknown listing cost selects individual GETs. A partial/inconsistent listing
never proves absence. Preserve active codec conversion and shared path filters.

After bulk upload refresh only live canonical entries lacking remoteMtime,
including pre-existing missing stamps, rather than recursively rescanning
unaffected branches. Keep the original complete inventory for foreign edits.
Old inventory metadata never replaces fresh pre-write fingerprint checks.
Retain optional-stamping fallback semantics; do not acknowledge unknown physical
content as verified. Initial mismatch fallback keeps its original deadline and
starts promptly rather than after waiting for a slow sibling's entire batch.

Replace breadth-level barriers with a bounded dynamic directory work queue. Start
a discovered child when a worker frees, retain concurrency1..40, unique visits,
full pagination, filters, sorted final output and strict failure semantics. On
error stop admission of new tasks and drain started work before returning failure.
Preserve explicit/default Force/backup limits and full hidden/config inventory.

Minimal RED/GREEN: extend current real remote-read-concurrency test with an uneven
deep tree and controlled barrier, assert child overlap and limits1/20/40. Extend
initial42 functional outcome/cost and existing fingerprint-budget scenario for
metadata reuse/fallback. Reuse partial-listing/error/Force checks; no new matrix.

Acceptance: flat initial42 avoids42 individual metadata GETs, post-upload does not
recurse through unaffected folders, slow siblings do not hold idle traversal
slots, no lost user bytes/queues or weakened writes. Rerun all-mode diagnostics,
required gates and docs; write reports/03-inventory.md.

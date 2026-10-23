# Coordinator continuation

Read README.md and queue.json first. This file is the durable controller contract,
not permission to read sensitive data or change unrelated artifacts.

1. Only this parent chat updates queue.json and dispatches. Read current state
   every run. A worker may still be writing after producing a report: obtain its
   compact `wait_threads` status before considering acceptance. When inProgress,
   do not edit source, run fixers or create another worker. Wait or end the
   heartbeat quietly when nothing actionable changed.
2. `needsAttention`/failure is not completion. Inspect the relevant final/error
   evidence and resolve routine issues by authorized `send_message_to_thread`
   to the SAME worker, preserving its changes. No user questions for routine
   choices. Escalate only a true security/destructive/unavailable prerequisite;
   report the exact unmet contract and do not start dependent implementation.
3. On completed worker: read its report and relevant incremental source diff,
   inspect commands/results and functional/cost acceptance criteria. Correct
   missing evidence, unsafe changes or unfulfilled scope in the same worker.
   Do not accept on a final message alone or mark skipped scope as implemented.
   Record acceptance and any documented ruling in queue.json. Preserve source
   identity and initial dirty-tree distinction; do not restage anything.
4. With no active worker, choose the first pending stage whose predecessors are
   accepted. Before create_thread, write status `dispatching`, activeStage and a
   unique dispatch nonce/time to queue.json. Use create_thread with the saved
   projectId, local environment and no model override; the prompt names this
   exact stage ID/nonce and the absolute README, stage brief and report paths.
   Ask it to implement ONLY this stage, take existing dirty changes as baseline,
   write its report before finishing, and not dispatch or update the queue.
5. Persist the returned threadId/hostId and status `in_progress` immediately.
   If creation returned only clientThreadId, resolve the ready thread through
   list_threads; do not pass a client ID to threadId tools. If creation outcome
   is unknown, inspect list_threads and read the matching title/nonce before
   retrying: NEVER blindly create a duplicate. Keep at most one worker running.
6. Prefer event waits with cursor while actively supervising; the heartbeat is
   the idle/restart fallback. Do not repeatedly narrate unchanged status. Share
   significant stage acceptance, material blockers and final completion only.
   New threads created this turn must be attached in the final response with
   the required `::created-thread{threadId="..."}` directive.
7. After all stages, verify reports/RESULTS.md, final source identity and actual
   checks. Set status completed_automated, activeStage null and releaseStatus
   pending_real_android_and_two_profile_yandex_smoke. Disable this queue's
   heartbeat via automation_update and report the real before/after result,
   checks, limitations and exact build path in concise Russian. If already
   complete, never redo stages: only ensure the heartbeat is stopped.

Workers need no messages back to the coordinator: their durable report and final
response are the handoff. The human explicitly authorized coordinator corrective
messages to the new stage chats; do not message other historical chats.

If the controller context grows, keep only queue state and current acceptance
evidence in context; detailed history lives in reports. Every implementer is a
new chat so implementation does not inherit the coordinator's growing history.

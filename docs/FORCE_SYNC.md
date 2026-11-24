# Direct Force replacement

## User contract

Force replaces the selected destination with the chosen readable source, directly
at final paths. Both directions use the shared protected-path rules, current
include/exclude patterns and the Obsidian configuration switch. Hidden files and
empty directories participate only within that selection. A successfully read
empty selection clears only selected destination files after explicit confirmation.
A missing remote root is unavailable, not empty.

Protected paths, excluded files, root .trash, .backup and this plugin's
credentials/state/logs are preserved and never treated as payload. Existing excluded remote copies are
not silently cleaned up. Canonical, manifest and old root locks are managed as
service metadata through their existing owners. Nested protected service names
also follow shared path-utils policy.

Force creates no payload staging, locks, leases, MOVE operations or protective
copies. Local deletion follows the Obsidian preference, including permanent
deletion when configured. Remote deletion is permanent. The optional archive is
written before replacement. The root .trash is outside the sync selection in
both directions, including older remote copies and case variants. Plaintext
Force stops before writes if a retired subtree could be encrypted trash and
its paths cannot be classified safely. In either direction, a surviving raw
object that still requires the previous encryption receipt blocks preparation
before the index is replaced.

## Direction and encryption

Local to Disk uses actual selected local bytes and inventories the destination
without reading old user contents or trusting old canonical history. A valid
existing encrypted destination requires its verified password to classify logical
paths safely. Keeping encryption reuses that codec/salt so excluded ciphertext
remains readable. New encrypted destinations receive fresh hardened parameters.
Disabling encryption is blocked before writes if excluded encrypted resources
would lose their codec; use the dedicated encryption settings first. Corrupt or
unsupported destination manifests cannot authorize a scoped purge. Output mode
still follows local settings; the canonical is rebuilt with a fresh Force epoch.

Disk to local reads the physical remote tree, not old canonical history.
Before deleting anything locally it reads every selected source and authenticates
encrypted paths/content when a valid manifest exists. A valid manifest is preserved.
A missing manifest selects plaintext, including empty sources and devices with stale
local encryption settings. Names and bytes are then copied as ordinary files; Force
does not reconstruct lost encryption parameters. A corrupt/unsupported manifest or
failed manifest request blocks preparation rather than selecting plaintext. A late
404 after manifest metadata was found is a read failure, not proof of absence.
The selected source mode is checked again around the final pre-purge source scan;
a changed manifest or read failure stops replacement before local deletion.
Raw excluded/protected directories are pruned before decryption. Candidate encrypted
names are decoded first, then logical filters select which contents may be read.
A .agents directory is excluded only by actual user settings; the configured
Obsidian directory follows its switch. Neither name is hardcoded as extra protection.
An undecodable directory is left on Disk and omitted from the replacement only
if a complete, unfiltered raw listing proves it has no file descendants. This
covers empty trees retained by encryption cleanup. Force repeats this check
before local purge. A file anywhere in the subtree, an undecodable selected file,
or a failed listing stops replacement. There is no plaintext fallback. The
indicator shows preparation failed instead of retaining 0/N.
Existing local paths unavailable through the Vault tree are preserved. A parent
folder with such a descendant is cleaned only through eligible children. An
existing raw-only directory can contain new files at the same path. An exact
raw-only file is accepted only when its SHA-256 matches the verified source.
Incompatible types, portable name collisions, and different bytes block preparation.
An unreadable source, impossible portable name or file occupying a preserved plugin
ancestor stops preparation without clearing the destination.
Remote user bytes are not replaced; the index is rebuilt from the actual source
and old service locks are removed. Local files are decrypted. Configuration
replacement requires an Obsidian restart to apply application/plugin settings.

Both directions preserve the remote root itself and its backup subtree. The local
root is also retained. Source is pre-read without retaining vault-sized buffers;
this is not an immutable snapshot. Transfers record the bytes actually read.
Later changes are handled by ordinary sync, not by a rollback or conflict dialog.

For Disk to local, Force classifies paths and checks collisions before reading
file contents. Preparation, confirmed validation and copy prefetch group small
files into windows of up to 20 reads within the configured concurrency. Other
files share windows of up to four reads and an estimated 8 MiB. An oversized
file or a file of unknown size is read alone. Before copying, Force refreshes
sizes for the next window and regroups it when needed. The same metadata and
read budget carry into stable download. A file can grow after the observation,
so the estimate is not a bound on actual memory. Validation stops at a failed
window and waits for its admitted reads to settle before returning the error.

## Publication and recovery

IndexManager.publishDirectForceCanonical is the explicit exception to canonical
exclusive-MOVE transactions. It validates and encodes the new index, optionally
deletes the old canonical, uploads directly to its final raw name and verifies
read-back. It does not inspect old logical history. New bytes remain subject to
verification; missing source bytes or failed requests are never reported as success.

A local checkpoint retains existing Force fields plus direct:
format direct-v1, config directory, stage (purging, copying, publishing),
source directories and remaining deletions/transfers. Optional local
`watcherBoundary` stores ID/signature pairs; older checkpoints retain cutoff IDs.
Remote markers and physical-action schemas are unchanged: frozen selection is ephemeral until confirmation; applying checkpoints
already contain explicit selected sources/deletes, so recovery never recomputes or
widens them under new settings. Filter changes before applying invalidate the plan.
Older unfiltered direct-v1 remainders retain their admitted explicit actions; a new
scoped Force requires confirmation. Canonical maintenance keeps
kind force with the current semantic markers and existing phases; its cleanup
array is empty because direct deletion does not use fingerprint-fenced actions.
Passwords remain exclusively in local plugin data.

Existing checkpoints without direct retain their old interpretation. They are
not automatically widened to a full purge. A newly confirmed Force replaces them.
A direct remainder that would delete root .trash or unavailable local objects
requires a newly confirmed plan. Older remainders can also require confirmation when the
former codec is gone and a pending name could be encrypted trash.
Missing old completion still normalizes to null through the existing loader.
Downgrading with a direct checkpoint is unsupported.

One coordinator and persistence flow remain. Preparation is read-only; the
confirmed source is read again before initial deletion. The checkpoint is saved
before destructive work. After deletion starts, each independent failure is
recorded while other actions continue. Completed actions are retired durably.
A pending deletion defers file copies and directory creation at intersecting
destination paths. Other transfers continue. Retrying an older checkpoint
requeues completed copies under the subtree before that deletion runs again.
Before each remote DELETE attempt, Force reads the type at that path. A
confirmed 404 retires the action. A file/directory type change or failed read
keeps it pending, preserves the replacement object and allows independent
transfers to continue.
A remote copy window settles its reads before applying the files in order.
Local writes, verification and copy checkpoints run one at a time. A failed copy
checkpoint leaves that path pending, even when the local write already succeeded.
A continuation never repeats the completed broad purge. Late local edits narrow a
pending purge to unaffected descendants; each narrowing strictly descends and cannot
requeue its own parent. New files and edited paths are retained for ordinary sync.
Verified source metadata remains the baseline when a late local edit prevents copying. Copy/mkdir never implicitly
delete new file/folder blockers; only explicit pending deletes authorize removal.
On restart, portable name and type checks compare the remaining targets and their
ancestors with local objects outside the Vault tree. Two retained names can
differ only by case when no target intersects them.
New blockers retain the remainder and require resolving the collision or confirming
a newly prepared Force. Even raw-pruned encrypted exclusions block codec removal.

Ordinary manual, startup and scheduled full sessions resume a direct checkpoint
before normal admission/merge. If the remainder cannot finish, the session reports
the concrete failure or a deferred concurrent change, with no success or epoch ACK.
Force retires a missing source only after verifying the same readable root and
repeatedly observing a 404 or a directory at the exact path. Invalid metadata
keeps the file pending. Later deletion is ordinary work. If a previous transfer left destination bytes, recovery verifies their source hash and includes them in canonical before retiring the pending transfer. Read,
authentication and decryption errors never prove absence.
Force saves the publishing checkpoint with an empty remainder before uploading
the final index. After a lost upload response, Force can confirm the write by
reading back the exact bytes. An unconfirmed write leaves the checkpoint pending.
Before sending the final index again, recovery checks the root, manifest and
canonical. Its own active maintenance can finish the publication. An already
published final index or a later ordinary revision in the same epoch needs
only local completion. The local baseline describes the
files copied by Force. The public Force session persists that baseline. A full
session that resumes Force may then receive and acknowledge a later revision. A foreign epoch,
active successor maintenance or ambiguous read leaves recovery pending.

Realtime does not operate on a pending replacement. Successful cutover clears old
causal work and only unchanged covered watcher signatures, preserves later work, installs the new
baseline and clears the checkpoint. A post-Force ordinary full is not a success
prerequisite. Ordinary filters apply again without turning out-of-scope canonical
entries into deletions.

## Confirmation and results

One modal opens before source reads and stays through preparation, password entry,
destructive confirmation, optional archive, replacement and result. Preparation is
read-only and reports actual verified objects; password candidates are checked in
that same modal and never appear in published state. Wrong passwords can be retried;
manifest/source failures offer retry or cancel without authorizing replacement.
A spinner accompanies the source-checking message until password entry,
confirmation, an error or the final result replaces it. Reduced-motion preferences
disable the animation while retaining the status text.

After successful source verification the modal shows direction, actual paths, count,
source/output encryption, applied filters, preserved exceptions and an explicit
empty-source warning. Remote encryption is distinguished from decrypted local files.
The archive toggle and action buttons stay in a fixed footer; only the description
scrolls. Plain paragraphs group source details and consequences without separate
decorative panels. Archive controls have a distinct gap before the action row.
The shared indicator shows progress without a duplicate modal status;
failures and the final result remain in the dialog. Notification policy follows
[the shared UI contract](ARCHITECTURE.md#диагностика-ui-и-проверки).
Archive creation is off by default. Remote-to-local archives the entire local vault
to remote .backup; local-to-remote archives the old remote contents. The existing
archive encryption policy is unchanged. Only the explicit destructive button permits
replacement. A chosen archive must be verified before clearing anything; errors stay
in that modal, where the user can retry, uncheck the archive or cancel.

Cancel during preparation prevents later reads/writes after admitted work settles.
Closing the modal during archiving cancels replacement and keeps the reservation
until the archive request settles. After destructive confirmation and entry into
replacement, closing the modal only hides it; the indicator retains progress
through preparation, archive, purge, copies, canonical and local persistence.
Activity stays in the selected direction button. Closing settings does not cancel
a confirmed run; duplicate clicks share the active operation. Unload
prevents further writes, including local writes after awaited downloads and directory
checks. Cancellation before replacement preserves user data. Closing confirmation
during archiving prevents replacement and retains the workflow reservation until
the archive has settled. Successful durable completion restores automation readiness
through the existing lifecycle guards without requiring an ordinary full.

Results distinguish completed, partially completed (counts, errors, ordinary-sync
retry), and not started. An intent is not a completion receipt. Failure after
final publication retains finalization progress without replaying replacement.

## Deliberate limits and validation

Force does not require stopping other devices, wait for their leases or reject
their newer fingerprints/epochs. Already sent foreign DELETE/PUT requests can
change the result later. No server-fencing guarantee or automatic repair of every
possible concurrent encryption corruption is made. The old fencing suite remains
diagnostic, not a release requirement of this deliberately destructive contract.
Ordinary sync retains its own safety rules.

Functional tests use real codecs, algorithms, canonical writes and stores over a
synthetic transport. See tests/direct-force.test.ts, the revised
tests/force-replacement.test.ts, and TC-FORCE-REPLACE-01 in SMOKE_TESTS.md.
A release still requires two actual Obsidian profiles against a disposable real
Yandex Disk folder in plaintext/encrypted modes. This implementation does not
constitute that manual evidence.

# Direct Force replacement

## User contract

Force replaces the selected destination with the chosen readable source, directly
at final paths. Both directions use the shared protected-path rules, current
include/exclude patterns and the Obsidian configuration switch. Hidden files and
empty directories participate only within that selection. A successfully read
empty selection clears only selected destination files after explicit confirmation.
A missing remote root is unavailable, not empty.

Protected paths, excluded files, .backup and this plugin's credentials/state/logs
are preserved and never treated as payload. Existing excluded remote copies are
not silently cleaned up. Canonical, manifest and old root locks are managed as
service metadata through their existing owners. Nested protected service names
also follow shared path-utils policy.

Force creates no payload staging, locks, leases, MOVE operations, protective
copies or trash. Local deletion is permanent. An optional archive is a final
backup artifact, not a staging file. Ordinary synchronization keeps its existing
transaction, filtering and protective-copy rules.

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
Included undecodable names/content stop with force-source-format without a plaintext
fallback. The indicator shows preparation failed instead of retaining 0/N.
File/folder collisions that would erase excluded descendants block preparation.
An unreadable source, impossible portable name or file occupying a preserved plugin
ancestor stops preparation without clearing the destination.
Remote user bytes are not replaced; the index is rebuilt from the actual source
and old service locks are removed. Local files are decrypted. Configuration
replacement requires an Obsidian restart to apply application/plugin settings.

Both directions preserve the remote root itself and its backup subtree. The local
root is also retained. Source is pre-read without retaining vault-sized buffers;
this is not an immutable snapshot. Transfers record the bytes actually read.
Later changes are handled by ordinary sync, not by a rollback or conflict dialog.

## Publication and recovery

IndexManager.publishDirectForceCanonical is the explicit exception to canonical
exclusive-MOVE transactions. It validates and encodes the new index, optionally
deletes the old canonical, uploads directly to its final raw name and verifies
read-back. It does not inspect old logical history. New bytes remain subject to
verification; missing source bytes or failed requests are never reported as success.

A local checkpoint retains existing Force fields plus direct:
format direct-v1, config directory, stage (purging, copying, publishing),
source directories and remaining deletions/transfers. The persisted schema is
unchanged: frozen selection is ephemeral until confirmation; applying checkpoints
already contain explicit selected sources/deletes, so recovery never recomputes or
widens them under new settings. Filter changes before applying invalidate the plan.
Older unfiltered direct-v1 remainders retain their admitted explicit actions; a new
scoped Force requires confirmation. Canonical maintenance keeps
kind force with the current semantic markers and existing phases; its cleanup
array is empty because direct deletion does not use fingerprint-fenced actions.
Passwords remain exclusively in local plugin data.

Existing checkpoints without direct retain their old interpretation. They are
not automatically widened to a full purge. A newly confirmed Force replaces them.
Missing old completion still normalizes to null through the existing loader.
Downgrading with a direct checkpoint is unsupported.

One coordinator and persistence flow remain. Preparation is read-only; the
confirmed source is read again before initial deletion. The checkpoint is saved
before destructive work. After deletion starts, each independent failure is
recorded while other actions continue. Completed actions are retired durably.
A failed subtree deletion requeues affected copies before retrying that deletion.
A continuation never repeats the completed broad purge. Copy/mkdir never implicitly
delete new file/folder blockers; only explicit pending deletes authorize removal.
New blockers retain the remainder and require resolving the collision or confirming
a newly prepared Force. Even raw-pruned encrypted exclusions block codec removal.

Ordinary manual, startup and scheduled full sessions resume a direct checkpoint
before normal admission/merge. If the remainder cannot finish, the session reports
the concrete failure; it never treats incomplete copies as source deletions.
Realtime does not operate on a pending replacement. Successful cutover clears old
causal work and only covered watcher IDs, preserves later work, installs the new
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

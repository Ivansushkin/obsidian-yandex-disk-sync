# Direct Force replacement

## User contract

Force reads the chosen source, clears the destination and copies directly to final
paths. It covers the entire vault, including hidden files, configuration, other
plugins and empty directories, regardless of normal include/exclude settings.
A successfully read empty source explicitly clears the destination. A missing remote
source is unavailable, not empty; only local-to-Disk may create a missing destination.

The root .backup is preserved and is not a payload source. Local sync-plugin
installations, credentials, state and old logs are preserved and never uploaded.
Old remote copies of those plugin directories are deleted by local-to-remote
replacement. Root canonical, manifest and lock names are service metadata, not
payload; nested service-like names are literal user paths.

Force creates no payload staging, locks, leases, MOVE operations, protective
copies or trash. Local deletion is permanent. An optional archive is a final
backup artifact, not a staging file. Ordinary synchronization keeps its existing
transaction, filtering and protective-copy rules.

## Direction and encryption

Local to Disk uses actual local bytes. It deletes old remote payloads and all
old locks without decoding the old index or proving destination fingerprints.
It deletes the old canonical and writes a new sync-index epoch. Local encryption
settings select the output mode. Encrypted output gets fresh hardened salt and
a matching manifest; plaintext output removes the manifest. The old destination
key is not needed.

Disk to local reads the physical remote tree, not old canonical history.
Before deleting anything locally it reads every selected source and authenticates
encrypted paths/content. A valid manifest is preserved. A lost or corrupt manifest
may be rebuilt only from saved salt/profile/password authenticated by the source.
A password alone cannot replace lost encryption parameters. An ambiguous mixed
source, unreadable source, impossible portable name or file occupying a preserved
plugin ancestor stops preparation without clearing the destination.
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
source directories and remaining deletions/transfers. Canonical maintenance keeps
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
A continuation never repeats the completed broad purge.

Ordinary manual, startup and scheduled full sessions resume a direct checkpoint
before normal admission/merge. If the remainder cannot finish, the session reports
the concrete failure; it never treats incomplete copies as source deletions.
Realtime does not operate on a pending replacement. Successful cutover clears old
causal work and only covered watcher IDs, preserves later work, installs the new
baseline and clears the checkpoint. A post-Force ordinary full is not a success
prerequisite. Ordinary filters apply again without turning out-of-scope canonical
entries into deletions.

## Confirmation and results

One modal shows direction, actual paths, count, output encryption, preserved
exceptions, ignored filters and an explicit empty-source warning. Archive creation
is off by default. Buttons explicitly clear and replace the selected destination.
The chosen archive must be verified before clearing anything; errors stay in the
same modal, where the user can retry, uncheck the archive or cancel.

One Notice spans preparation, optional archive, purge, copies, canonical and local
persistence. Activity stays in the selected direction button. Closing settings does
not cancel a confirmed run; duplicate clicks share the active operation. Unload
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

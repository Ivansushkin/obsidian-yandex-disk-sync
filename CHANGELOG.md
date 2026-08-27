# Changelog

## 2.0.0

Changes since stable `1.1.0`.

### Breaking changes

- Replaced the legacy synchronization format with one canonical index marked
  by `format: "sync-index"`. It uses epochs, revisions, per-device mutation
  sequences, file and folder tombstones, pending moves, and durable
  physical-action queues.
- Limited automatic migration to plaintext stable 1.0.0 and 1.1.0 local data.
  Their `localIndex` is converted once into the current baseline. Plaintext
  canonical indexes carrying stable `version: 1` or `version: 2` require an
  explicit Force sync with a verified backup.
- Encrypted legacy data, numeric historical manifests and canonical indexes,
  unmarked transition/queue data, and incomplete current metadata are
  unsupported and fail closed before remote writes. All devices must be
  updated before using the new format.
- Current entries without `mutationSeq` cannot authorize destructive folder
  operations.

### Added

- Added optional end-to-end encryption with PBKDF2-HMAC-SHA256 at 600,000
  iterations, HKDF-separated content and filename keys, AES-256-GCM file
  content, deterministic RFC 5297 AES-SIV path segments, and a strict manifest
  marked by `format: "encryption-manifest"`.
- Added coordinated, crash-safe encryption enable, password rotation, disable,
  and post-commit recovery. Cleanup is repeatable and guarded by canonical
  state and physical fingerprints.
- Added self-contained `OYDSBKP!` encrypted backup envelopes with bounded,
  authenticated headers and archive-specific PBKDF2/AES-GCM parameters.
- Added collision-resistant backup names, non-overwriting upload, and exact
  SHA-256 plus byte read-back after success, timeout, or an ambiguous response.
- Added Force local and Force remote recovery with a mandatory verified backup,
  a new epoch, canonical read-back verification, and automatic watcher and
  scheduler restart.
- Added persistent watcher events, per-device mutation FIFO, resumable physical
  actions, coordinated status UI, and sanitized correlated diagnostics.

### Changed

- Full, realtime, Force, and encryption maintenance now share one exclusive
  coordinator. Changes observed during another session remain durable and are
  replayed in causal order.
- File reconciliation now uses plaintext SHA-256, the device baseline,
  canonical revision and mutation metadata, plus server fingerprints or server
  mtime when a fingerprint is unavailable. Client clocks do not select a
  winner.
- Concurrent edits create conflict copies. Exact deletion beats an older edit,
  while a new or changed descendant survives a concurrent folder deletion.
- Folder rename and move are logical mutations backed by guarded per-file
  actions. Rename chains and Obsidian's mechanical child events are coalesced
  without restoring stale paths.
- Canonical commits now use an exclusive rename lock, stable JSON semantics,
  strict validation, read-back verification, byte-exact rollback, stale-lock
  recovery, and fail-closed handling of ambiguous lock states.
- Physical delete, move, rejected-upload cleanup, and encryption cleanup require
  a fresh canonical authorization check and a matching server fingerprint.
- Startup uses stable service-file reads, paginated root discovery, bounded
  parallel traversal, and a remote-folder observation cache invalidated by
  writes and encryption/path changes.
- Browser runtime dependencies are pinned, Obsidian is a development-only
  dependency, and CI validates tests on Node 20 and 22, lint, build, audits,
  release evidence, exact assets, and downloaded asset hashes.

### Fixed

- Prevented deleted folders and files from returning after restart or a later
  full synchronization.
- Prevented stale watcher uploads, same-device replays, and partially completed
  rename chains from creating false conflicts or duplicate paths.
- Prevented unresolved causal work from being acknowledged or advancing the
  local observed revision.
- Recovered successful uploads and canonical commits whose final response was
  lost or timed out without reporting false success for unverified operations.
- Prevented hidden overwritten-file backups and destructive operations after a
  failed mandatory backup.
- Rejected malformed canonical records, paths, watermarks, transitions,
  ciphertext, and unsupported formats before Vault API or remote mutation.
- Revalidated canonical state and encryption immediately before corrective
  uploads so newer foreign state or maintenance blocks stale writes.

### Performance

- Avoided canonical writes and redundant manifest checks on strict no-op sync.
- Realtime verification uses targeted canonical and physical reads instead of a
  complete remote-tree traversal.
- Folder planning uses path sets and maps, while remote traversal and file
  operations retain bounded concurrency.

## 1.1.0

### Added

#### Force Sync

Added forced one-way synchronization that ignores modification dates, file
hashes, and the previous index state. The selected source becomes the exact
authoritative copy in the chosen direction.

#### ForceSyncModal (`src/ui/force-sync-modal.ts`)

Added a confirmation modal before Force Sync with:

- an explanation specific to the selected direction;
- a warning that the operation is destructive;
- a button to create a backup before continuing;
- a button to continue without a backup;
- a cancel button.

#### Force Sync from local

Overwrites all files on Yandex Disk with local versions and removes remote
files that do not exist locally.

```text
1. Build the local index by scanning the vault.
2. Get the remote file list.
3. Upload every local file unconditionally.
4. Delete every remote-only file.
5. Replace the remote index with the local index.
```

#### Force Sync from remote

Overwrites all local files with versions from Yandex Disk and removes local
files that do not exist remotely.

```text
1. Build the local index to identify local-only files.
2. Load the remote index.
3. Get the remote file list.
4. Download every remote file unconditionally.
5. Delete every local-only file.
6. Replace the local index with the remote index.
```

#### Implementation details

- Force Sync generated operations directly without `ConflictResolver`.
- Overwrites did not compare mtime or SHA-256.
- `FileWatcher` was suspended through the existing `syncPauseCallbacks`.
- Progress was reported through the regular `updateState()` mechanism.
- File operations reused `executeOperationsParallel()`.

#### Settings UI

Added a **Force Sync** section after **Backup** with two actions:

- **From local to remote**;
- **From remote to local**.

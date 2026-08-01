# Changelog

## 2.0.0-beta.1.1

### Fixed

- Removed the cross-device Force sync loop. Devices now accept a valid epoch
  created by Force through a normal full sync instead of requesting another
  Force operation.
- Added three-way reconciliation against the previous device baseline when an
  epoch changes, preserving local create, modify, delete, rename, and folder
  operations while producing conflict copies for concurrent edits.
- Prevented semantic epoch changes from triggering repeated index retries or
  destructive physical actions. Realtime work remains durable and schedules
  one coalesced full reconciliation.
- Migrated the legacy 1.1 local index into the device baseline before the first
  v3 save, allowing updated devices to merge local changes after another
  device performs Force sync.
- Avoided passive backup-status API requests when the token is missing and
  removed duplicate authorization error logging from the settings screen.

## 2.0.0-beta.1

### Breaking change

- Introduced synchronization index v3. It is not compatible with plugin 1.1
  or other versions that use index v1/v2. Update every device before resuming
  synchronization, create a backup, run **Force sync → Local to remote** on
  the authoritative device, then run **Remote to local** on other devices.
- Normal synchronization is blocked when a legacy, unreadable, different-epoch,
  or ambiguous index is detected. Force sync with a verified backup is required
  to select the authoritative state.

### Added

- Added end-to-end AES-256-GCM encryption for file contents, file names, and
  the canonical index. Keys are derived locally with PBKDF2-HMAC-SHA256 using
  100,000 iterations; the password and encryption key are never uploaded.
- Added segment-by-segment encryption for file and folder names. The backup
  tree, canonical index, index locks, and encryption manifest remain protected
  service paths and are never treated as user files.
- Added safe encryption enable, disable, and password rotation workflows with
  distributed maintenance, crash recovery around canonical commit, password
  verification, and fingerprint-guarded cleanup of the old physical tree.
- Added automatic encrypted-vault discovery on additional devices. The plugin
  prompts for and verifies the password, updates the encryption toggle without
  a restart, and safely follows encryption disabled on another device.
- Added encrypted backup markers: archives created with encryption use
  `.enc.zip`, coexist with plaintext `.zip` backups, and clearly report when
  an archive requires the previous password after key rotation.
- Added a single canonical index with epoch/revision history, per-device FIFO
  mutation watermarks, file and folder tombstones, resumable moves, and durable
  physical-action queues.
- Added Force local and Force remote recovery with mandatory verified backups,
  a new epoch, canonical read-back verification, and automatic restart of the
  watcher and scheduler after success.
- Added persistent local watcher events and causal handling of rapid create,
  modify, rename, move, delete, and full-sync sequences across restarts.
- Added coordinated status-bar and Notice UI. It shows real synchronization
  phases and `N/M` only for known work batches instead of a synthetic percent.
- Added correlated, sanitized diagnostics for sessions, index transactions,
  mutations, physical actions, watcher replay, Force, and encryption phases.
- Added **Settings → Logging** controls for detailed logging, file output, and
  viewing or clearing the current debug log. User-facing status and error text
  is available in English and Russian.

### Changed

- Full, realtime, Force, and encryption maintenance now share one exclusive
  coordinator. User changes that occur during full sync or maintenance remain
  durable and are replayed with the correct encryption mode.
- File changes are compared causally against each device baseline using
  SHA-256 and canonical revisions. Concurrent edits create conflict copies;
  first-sync files without a baseline are treated as new.
- External remote edits, including changes made through the Yandex Disk web
  interface, are detected using server modification metadata without comparing
  clocks between devices.
- Exact file deletion wins over an older concurrent edit, while a new or
  changed descendant survives a concurrent folder deletion. Changed local
  content is backed up before destructive replacement or deletion.
- Folder deletion commits one prefix tombstone and deletes only current live
  descendants. Historical rename tombstones are not sent to the physical
  delete queue. Empty local and remote ancestor folders are pruned only after
  a live emptiness check.
- Rapid rename and move chains preserve their relationship to submitted
  uploads. Only the final intended path remains live; stale source paths are
  never restored by a later full sync.
- Canonical index updates use an exclusive rename lock, stable JSON semantics,
  read-back verification, byte-exact rollback, stale-lock recovery, and
  fail-closed handling of ambiguous lock states.
- Physical delete, move, rejected-upload cleanup, and encryption cleanup now
  require canonical authorization and a matching server fingerprint.
- Startup uses one coordinated full-sync path, stable service-file reads,
  paginated root discovery, and bounded parallel remote-tree traversal.
- Manual full, Force, and encryption operations reuse one persistent Notice;
  startup, scheduler, and realtime activity remain visible in the status bar
  without notification spam. Actionable blocks are persistent and deduplicated.

### Fixed

- Prevented deleted folders and files from returning after restart or a later
  full synchronization.
- Prevented stale watcher uploads and partially completed renames from creating
  duplicate files at old or intermediate paths.
- Prevented a full sync from acknowledging unresolved causal work or advancing
  the local observed revision after an incomplete rename, delete, or index
  transaction.
- Fixed encrypted legacy indexes being misclassified as corrupt JSON and made
  wrong-key or unreadable indexes block safely without remote writes.
- Fixed hidden overwritten-file backups by using the physical vault adapter,
  collision-resistant names, and write verification before destructive work.
- Fixed false canonical verification failures caused by optional JSON fields
  and recovered successful Yandex Disk operations whose final response was
  lost or timed out.
- Prevented covered watcher events from starting redundant realtime sessions
  after a successful full sync.

### Performance

- Strict no-op startup avoids canonical writes and redundant manifest checks.
- Realtime upload verification uses targeted canonical and physical reads
  instead of traversing the complete remote tree.
- Remote folders are scanned with bounded concurrency; `.backup` is excluded
  from the user tree and folder tombstones are resolved by path prefixes.

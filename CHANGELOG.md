# Changelog

## 2.0.0-beta.6

### Breaking changes

- Removed migration and recovery compatibility with every 2.0.0 prerelease.
  Manifest v2, canonical index v3, unversioned beta queues, incomplete beta
  transitions, and non-envelope `.enc.zip` archives now fail closed.
- Limited legacy migration to plaintext stable 1.0.0 and 1.1.0 data. Their
  `localIndex` becomes an unobserved current baseline and plaintext canonical
  v1/v2 requires explicit backed-up Force. Stable 1.2 data is unsupported.
- Current v4 entries without `mutationSeq` no longer receive a prerelease
  baseline fallback and cannot authorize destructive folder operations.

### Security

- Force now classifies an existing canonical index before taking its lock.
  Detectable prerelease v3 and malformed current data are rejected before any
  remote mutation.
- Historical backup downloads validate ZIP magic. Non-envelope `.enc.zip`,
  unknown `.zip` bytes, encrypted legacy names, and manifest v1/v2 never invoke
  a compatibility decoder.
- Strict v3 parsing rejects extra algorithm fields and transition/state
  mismatches. Startup, manual/Force backup, and transition preflight/recovery
  revalidate the manifest before enabling remote writes or cleanup.
- Current plugin data and transition snapshots require schema v2 and explicit
  encryption profile metadata. Unsupported prerelease data stops plugin
  startup with manual clean-path/reset guidance.

## 2.0.0-beta.5

### Security

- Added the hardened-v3 encryption profile: PBKDF2-HMAC-SHA256 with 600,000
  iterations, HKDF-separated content and filename keys, AES-256-GCM content,
  and RFC 5297 AES-SIV filenames.
- Added strict manifest v3 parsing and fail-closed filename decoding. Legacy
  manifest v1/v2 remains available only for explicit migration and recovery.
- Added a crash-safe v2-to-v3 format upgrade with mandatory byte-verified
  backup, source/target authority around canonical commit, and durable
  fingerprint-guarded cleanup recoverable by a target-capable device.

### Backup

- Added self-contained `OYDSBKP2` encrypted backup envelopes with bounded,
  authenticated headers and archive-specific PBKDF2/AES-GCM parameters.
- Backup uploads now use unique 96-bit-random names, `overwrite=false`, and
  exact SHA-256 plus byte read-back after success, timeout, or collision.
- Legacy encrypted archives remain readable with their original vault codec
  and are never silently rewritten during encryption migration.

### Changed

- Added additive plugin-data schema v2 profile metadata without changing
  canonical index v4, mutation FIFO, maintenance, or physical-action schemas.
- Moved encryption profile/snapshot/manifest ownership out of `main.ts` into a
  focused manager while preserving the public plugin API.
- Pinned browser runtime dependencies, moved Obsidian to dev dependencies, and
  regenerated the lockfile through the public npm registry with zero runtime
  and full audit findings.
- CI now runs tests on Node 20 and 22. Release validation checks exact assets,
  version consistency, audits, evidence, and downloaded release SHA-256.

## 2.0.0-beta.4

### Changed

- Canonical commits use SHA-256/MD5 metadata and a same-session commit proof to
  avoid redundant index downloads. Hashless resources retain semantic
  read-back verification.
- Confirmed remote directories are reused across uploads. Delete, move,
  credential, remote-path, and encryption-codec changes invalidate the cache;
  a stale cached parent is recreated once after 404.
- Corrective uploads re-read canonical state and revalidate encryption before
  writing. Newer foreign state, maintenance, or a manifest change blocks them.
- Unknown folder conflicts and exclusive upload conflicts no longer trigger
  unsafe folder recovery.

## 2.0.0-beta.3

### Fixed

- Continuous edits from one installation now follow the per-device mutation
  watermark even when a later snapshot retains an older full-sync revision.
  They no longer create false conflict copies.
- Upload receipts now advance a later queued edit of the same path. Applied
  uploads left by a crash are acknowledged without uploading the same content
  again.
- Same-device stale replays and idempotent puts are distinguished from real
  cross-device conflicts. FIFO gaps and divergent states with the same
  sequence fail closed without advancing the canonical watermark.
- Current v4 validation now rejects metadata whose mutation sequence exceeds
  the corresponding device watermark.

## 2.0.0-beta.2

### Fixed

- Child rename events now bind only to a containing folder move, preferring
  the deepest causal parent. Ambiguous parents remain durable and block full
  reconciliation instead of moving the wrong path.
- Folder moves now preflight every target. A different-content target blocks
  the whole operation before canonical or physical writes; same-content
  targets remain safe idempotent completions.
- Full-sync file deletions now use the same per-device FIFO mutations as
  realtime deletion. Applying an existing tombstone preserves its original
  device and mutation sequence.
- Prerelease v4 entries without a mutation sequence can authorize folder
  destruction only when an exact confirmed device baseline proves they were
  observed.
- Current v4 indexes now receive strict semantic validation. Invalid records,
  paths, metadata, watermarks, moves, tombstones, or maintenance state block
  normal sync without codec fallback or remote mutation.

### Performance

- Folder move and delete planning now uses path sets and maps instead of
  repeated linear searches, preserving bounded concurrency and the two-commit
  folder-operation limit.

## 2.0.0-beta.1.2

### Breaking change

- Upgraded the canonical synchronization index to v4. Index v3 cannot safely
  distinguish folder-operation predecessors from concurrent changes. Update
  every device, restore the intended local tree on one authoritative device,
  and run one backed-up **Force sync → Local to remote**. Other updated devices
  adopt that epoch with a normal full sync.

### Fixed

- Added per-device mutation sequences to file metadata, folder tombstones, and
  pending moves so later folder operations recognize earlier changes from the
  same device without deleting foreign or newer descendants.
- Made folder rename one logical mutation backed by guarded per-file moves.
  Yandex folder moves with an unverifiable fingerprint are no longer used.
- Coalesced folder rename chains and absorbed Obsidian's mechanical child
  rename/delete events while preserving user edits and recreated old paths.
- Folder delete now queues physical work only for canonical tombstones actually
  accepted by the latest index transaction and remains durable on partial
  failure.
- Full sync now fails closed before scanning either tree when a pending folder
  move or authorized destructive action cannot be resolved, preventing stale
  paths from being downloaded or uploaded as compensating changes.

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

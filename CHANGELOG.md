# Changelog

## 2.0.0-beta.3

### Fixed

- Fixed encrypted legacy v1/v2 indexes being reported as corrupt JSON instead
  of producing the required Force-sync migration notice.
- Separated index codec decoding, JSON parsing, and semantic version
  validation so legacy, epoch, and maintenance errors are not masked by the
  plaintext fallback.
- Added fail-closed startup handling and sanitized diagnostics for index
  snapshots that cannot be decoded with any permitted codec.
- Fixed overwritten-file backups inside the hidden Obsidian plugin directory
  by using the physical vault adapter instead of the Vault file cache.
- Made backup names collision-resistant and verified the written file type and
  size before allowing a destructive overwrite, delete, or rejected move to
  continue.
- Kept stale backups in place when system trash is unavailable instead of
  moving them into the vault-local `.trash` synchronization scope.

### Testing

- Added encrypted/plaintext legacy startup, wrong-key, corrupt-index,
  transition-codec, hidden-backup, concurrent-directory, backup-verification,
  cleanup, and blocked-overwrite regression coverage.

## 2.0.0-beta.2

### Fixed

- Fixed false canonical-index verification failures caused by optional
  `undefined` fields changing during JSON upload and read-back.
- Added byte-exact rollback of the acquired index lock for plaintext,
  encrypted, and encryption-transition transactions.
- Added explicit committed, rolled-back, concurrent, and ambiguous transaction
  outcomes. Force sync now succeeds only after canonical epoch, revision,
  logical content, and fingerprint are read back and verified.
- Added safe recovery when a final Yandex Disk move succeeds but its API
  response is lost. Ambiguous canonical/lock combinations are preserved for
  explicit recovery instead of being overwritten.
- Prevented unreadable stale locks from being published automatically.
- Restored realtime watcher and scheduler immediately after a successful Force
  migration from a legacy-blocked startup.
- Added verified Force-backup diagnostics and corrected failed-session logging
  so unsuccessful Force sync is not reported as completed successfully.
- Preserved safe Yandex Disk API error identifiers in sanitized debug logs.

### Testing

- Added JSON-roundtrip, optional metadata, transaction outcome, retry, raw
  rollback, and diagnostic-redaction regression coverage.

## 2.0.0-beta.1

### Breaking change

Version 2.0.0-beta.1 uses synchronization index v3 and is not compatible with plugin
1.1. Update every device before resuming synchronization. Create a backup, run
**Force sync → Local to remote** on the authoritative device, then run
**Remote to local** on the remaining devices. Normal startup and full sync are
blocked while a v1/v2 index exists.

### Added

- Added end-to-end encryption for file contents and file names using
  AES-256-GCM. Keys are derived locally from the user's password with
  PBKDF2-HMAC-SHA256; the password and encryption key are never uploaded.
- Added encrypted canonical index storage and a raw versioned remote manifest
  with salt, password verifier, and encryption revision for connecting
  additional devices.
- Added encryption enable, disable, and password rotation workflows. Each
  transition is serialized through distributed maintenance, survives crashes
  around the canonical commit, and removes the obsolete physical tree only
  through fingerprint-guarded cleanup.
- Added password verification and explicit synchronization blocking for a
  missing, incorrect, outdated, or transitional encryption state.

### Changed

- Added a single canonical index with revision-based merge and atomic
  rename-lock transactions.
- Added per-device FIFO mutation sequences, file tombstones, folder-prefix
  tombstones, durable physical-action queues, and resumable rename records.
- Committed deletion intent before physical deletion.
- Buffered user watcher events during full sync and encryption maintenance.
- Added exact-file delete and concurrent folder-delete conflict rules.
- Added guarded cleanup of rejected uploads using server fingerprints.
- Added paginated lock discovery, ambiguous orphan detection, and canonical
  fingerprint verification after every index transaction.
- Added retry handling for asynchronous Yandex Disk operations, 409 lock
  contention, and transient 423, 429, and 503 responses.
- Added correlated diagnostics for sync sessions, canonical transactions,
  durable mutations, physical actions, watcher replay, and encryption phases.
- Moved the rotating debug log into the excluded plugin data directory and
  serialized file flushes to prevent overlapping writes from losing entries.

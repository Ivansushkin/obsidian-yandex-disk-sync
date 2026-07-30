# Changelog

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

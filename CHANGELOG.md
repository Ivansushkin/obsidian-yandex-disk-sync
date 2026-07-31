# Changelog

## 2.0.0-beta.7

### Changed

- Unified startup with the existing coordinated full-sync path, so encryption
  validation, watcher buffering, index discovery, and reconciliation happen in
  one session.
- Added stable raw service-file reads guarded by content identity before and
  after download. Encryption manifests and canonical indexes reuse this single
  primitive without changing their remote formats.
- Reused the stable paginated root listing for canonical and lock discovery,
  and removed the separate startup existence probes.
- Parallelized independent remote-folder reads with bounded concurrency while
  preserving sequential pagination and excluding the protected `.backup` tree.
- Added per-session API read summaries and a cheap manifest-token validation
  before writes; strict no-op reconciliation skips the final validation read.

### Testing

- Added stable-read coverage for unchanged, changed, and resource-ID-only
  metadata, plus bounded tree traversal and protected backup exclusion.
- Added guard lifecycle coverage proving watcher pause precedes remote
  validation, strict no-op validates once, and dirty full sync validates again
  before commit.
- Added root-state identity coverage to stable pagination.

## 2.0.0-beta.6

### Fixed

- Made a successful full reconciliation an ID-based barrier for stale
  create/modify watcher uploads that were already durable before the full
  session started.
- Preserved uploads created during full sync, all delete/rename/folder events,
  and every captured event when full sync completes with errors.
- Settled pending puts against the state selected by full reconciliation:
  accepted hashes advance the existing FIFO watermark, while superseded puts
  become local no-ops without changing canonical files or index format.
- Prevented covered uploads from starting a redundant realtime session after
  full sync, including the extra encryption-manifest read in encrypted vaults.
- Changed expected structured watcher retries to a warning summary while
  retaining real persistence and API failures as errors.
- Invalidated the cached remote-folder view before full and Force
  reconciliation so externally removed folders are never assumed to exist.
- Removed obsolete single-file sync, sequential operation, legacy adapter/API
  helpers, unused UI state, translations, and styles superseded by the v3
  coordinator and durable watcher pipeline.

### Testing

- Added full-sync barrier coverage for pre-session and in-session events,
  failed full reconciliation, durable structured retries, and FIFO settlement
  of accepted and superseded puts.
- Added plaintext and encrypted full-reconciliation integration tests for a
  stale watcher upload with no remote write and a watermark-only pending put.
- Enabled TypeScript unused-local and unused-parameter checks for every build.

## 2.0.0-beta.5

### Fixed

- Fixed rapid create or modify followed by file rename/move. An unconfirmed
  source upload is now retargeted to the final path while preserving its FIFO
  sequence and causal baseline.
- Prevented missing stale upload events from retrying after a confirmed
  tombstone or move, while retaining genuinely unreadable files for retry.
- Added causal rename planning for unsynchronized, previously synchronized,
  concurrently created, and locally modified sources.
- Made guarded file moves recover a missing physical target from the verified
  local snapshot through an exclusive upload, verify ambiguous API outcomes,
  and update the target server fingerprint before completion.
- Added fingerprint-guarded cleanup for a stale physical source left by an
  upload that was retargeted before its canonical commit.
- Added a post-operation move recovery pass. A full reconciliation with
  unresolved causal moves now completes with errors and does not advance the
  observed revision.
- Confirmed the originating device mutation watermark in the same completion
  commit when full sync recovers an interrupted move.
- Serialized durable watcher replay, coalesced quick file rename chains, and
  acknowledged events by stable ID without duplicating failed entries.

### Testing

- Added plaintext and encrypted unsynchronized rename coverage, beta.4
  missing-target recovery, watcher queue normalization and coalescing,
  mutation retargeting, causal watermark, and stale-upload supersede tests.

## 2.0.0-beta.4

### Fixed

- Prevented folder deletion from creating remote physical actions for
  historical tombstones left by file rename operations.
- Required an exact server fingerprint match before remote deletion. Missing
  or changed fingerprints now defer destructive work to causal
  reconciliation.
- Added safe recovery for physical actions persisted by beta.3 without an
  expected fingerprint.
- Added folder-delete diagnostics for absorbed watcher events, live targets,
  skipped tombstones, and remaining physical actions.

### Testing

- Added plaintext and encrypted rename-to-folder-delete integration coverage,
  deep-path selection tests, and missing, changed, absent, and obsolete
  physical-action recovery cases.

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

# Changelog

## 2.0.0-beta.12

### Changed

- Made the coordinator-backed `SyncState` the single activity source for the
  status bar and user-visible synchronization Notice.
- Replaced synthetic percentage progress with named synchronization phases and
  determinate `N/M` counts only while processing a known set of work items.
- Made manual full, Force, and encryption-transition actions reuse one
  persistent Notice from preparation through the final success, error, or
  actionable blocking result.
- Switched the status bar to built-in Obsidian icons with an animated active
  state, and expanded its tooltip with session, phase, start time, progress,
  and last successful synchronization.
- Removed the settings-page connection probe before manual full sync. Access
  and authentication are now classified by the coordinated synchronization
  itself without a silent delay before UI activity appears.

### Testing

- Added UI-state coverage for phase progress reset, pre-watcher full activity,
  indeterminate formatting, and `N/M` formatting.
- Retained the beta.11 causal upload-to-rename, multi-device, Force,
  encryption-transition, physical cleanup, and startup regression coverage.

## 2.0.0-beta.11

### Fixed

- Preserved the causal relationship between a submitted upload and a rename
  that arrives while its canonical transaction is running. The rename now
  observes the accepted upload revision instead of publishing its target as an
  unrelated file and leaving the original path live.
- Retargeted uploads superseded before canonical commit while retaining their
  FIFO mutation sequence and guarded cleanup of any already-uploaded source.
- Recovered accepted upload receipts after restart from the durable mutation
  identity, canonical device watermark, epoch, and plaintext SHA-256.
- Made full sync drain upload events referenced by rename chains before
  reconciliation, preventing the old path from being downloaded while causal
  work remains unresolved.

### Performance

- Replaced the full remote-tree traversal after a realtime upload with targeted
  canonical and physical verification of only the accepted paths.

### Testing

- Added plaintext/encrypted coverage for rename before canonical commit,
  rename during commit, crash before watcher settlement, atomic handoff, and
  startup blocking of unresolved upload-to-rename chains.

## 2.0.0-beta.10

### Fixed

- Settled missing-target durable renames from the final logical state selected
  by a successful full reconciliation. Already-applied and obsolete events are
  acknowledged without remote operations, while ambiguous causal sources stay
  durable and make the full result unsuccessful.
- Prevented pre-full watcher retries from being replayed immediately after the
  same full or maintenance session. Only events created or changed while the
  watcher is paused are replayed automatically.
- Skipped the empty post-startup maintenance session when canonical contains no
  encryption cleanup work, and made watcher lifecycle diagnostics report the
  actual session kind.

### Testing

- Added plaintext/encrypted stale-rename settlement, already-applied target,
  ambiguous causal source, epoch replacement, concurrent source, and paused
  watcher replay coverage.
- Retained all beta.9 index transaction, multi-device causal, Force,
  encryption-transition, physical cleanup, and startup performance tests.

## 2.0.0-beta.9

### Fixed

- Serialized debounce, replay, file rename, and folder work through one durable
  watcher drain. Event acknowledgement is now persisted while the originating
  coordinator session still owns the queue.
- Added a pre-full watcher cutoff: older delete, rename, and folder events
  settle before reconciliation, while uploads remain covered by the existing
  ID-based full barrier and newer events stay durable.
- Rebased queued and running rename chains without treating a missing
  intermediate path as an API failure. Rename-to-delete and pre-snapshot target
  modifications now reduce without stale remote operations.
- Recognized already-applied rename targets after restart without another
  upload, move, delete, or canonical commit.
- Preserved confirmed server fingerprint, server mtime, and causal revision in
  the local baseline after `put-target`, preventing a redundant next-full
  download.

### Testing

- Added queued/running rename reducer, coordinator prepare/settle ordering,
  rename/delete, rename/modify, recreate, and already-applied recovery tests.
- Retained plaintext/encrypted rename, full barrier, multi-device causal,
  physical fingerprint, index transaction, Force, and encryption coverage.

## 2.0.0-beta.8

### Changed

- Consolidated enable, disable, rotate, interrupted-transition recovery, and
  Force recovery around one encryption transition executor while preserving
  canonical index v3 and encryption manifest v2.
- Unified service-file and physical-resource fingerprint rules. Existing
  beta.7 pending actions remain valid when their stored identity is SHA-256,
  MD5, resource ID, or server modification time.
- Reused one plugin-data snapshot builder for lifecycle persistence, one Force
  UI lifecycle, one watcher upload path, and one durable watcher drain.
- Reused shared ancestor traversal and baseline drift rules for ordinary sync,
  folder tombstones, and encryption cleanup.
- Consolidated index codec attempts, stale-lock observation, sync coordinator
  dispatch, Force bootstrap, and bulk upload paths without adding remote
  formats or API calls.
- Reused a resolve-once modal base lifecycle for all encryption dialogs.

### Testing

- Added compatibility coverage for beta.7 physical fingerprints and strict
  service-file fingerprints that never trust resource ID alone.
- Added shared encryption executor coverage for all three transition kinds and
  verified transition codecs are cleared after re-encode failure.
- Retained all beta.7 startup, Force, multi-device causal, encryption, watcher,
  and index transaction tests.

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

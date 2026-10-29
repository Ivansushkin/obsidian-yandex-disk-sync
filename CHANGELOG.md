# Changelog

## 2.1.0

Changes since `2.0.0`.

### Added

- Kazakh, Belarusian and Uzbek (Latin) interface translations alongside English
  and Russian. The language selector defaults to Obsidian's language and applies
  a saved manual override immediately, including commands, tooltips and status.
- Localized domain failure explanations and date/size formatting. Added a
  dictionary/reference/placeholder check with `npm run check:i18n`.

### Changed

- Mobile synchronization now rechecks storage after returning to Obsidian or an
  execution gap. Lifecycle hints share one bounded recovery request; hidden
  applications retain local events and defer new automatic workflows. Already
  admitted work can finish. Recovery waits for actual native request settlement
  and preserves manual-only mode, pauses and connection activation requirements.
- Native request diagnostics distinguish pending reads and writes without
  cancelling server operations. Exhausted read deadlines no longer report a
  misleading zero-second timeout.

- Connected devices request rotated passwords after sync settles and resume once
  connected. Cancel/wrong password waits for manual retry or a new target.
- New encryption passwords require 4–30 Unicode code points, with localized
  validation. Existing passwords remain usable; encryption formats are unchanged.
- Moved remote folder selection to the first step of Connection settings and
  clarified the required Yandex OAuth permissions. Masked the token input.
  Connection controls adapt to the panel width, and the Synchronize button keeps
  its size while displaying the connection or synchronization loader.
- New connections and token or remote folder changes now wait for an explicit
  **Synchronize** action. Connection checks, encrypted-vault password prompts and
  automatic sync wait until a manual full sync succeeds and its state is saved,
  including after restarting Obsidian. Existing connections keep automatic startup
  until their token or remote folder changes.
- While settings are open, one notification mirrors the indicator's status,
  progress, retries and errors; it hides when idle or when settings close.
- Replaced the built-in log viewer with a responsive group of **Copy logs**,
  **Open log file** and **Clear log file** buttons. Copying uses the latest 4,000
  sanitized characters; the tooltip updates the count on hover, focus and copy.
  Clearing requires confirmation. External opening reports missing files,
  unsupported Obsidian versions and opening errors.
- Added **Open log file** beside **Copy logs** in the expanded indicator. Log
  actions remain available during synchronization and prevent duplicate clicks
  without changing their labels or showing loaders. Indicator tooltips appear
  above the controls.
- Moved device information below the backup settings.

## 2.0.0

Changes since stable `1.1.0`.

### Breaking changes

- Raised the minimum supported Obsidian version from 0.15.0 to 1.0.0.
- Replaced the legacy synchronization format with one canonical index marked
  by `format: "sync-index"`: epochs, revisions, per-device mutation sequences,
  file and folder tombstones, pending moves, and durable physical-action queues.
  Local state uses `format: "plugin-data"`; encryption metadata uses
  `format: "encryption-manifest"`. These are semantic markers, not numbered
  format versions. Update every device before using 2.0.0; concurrent use with
  older builds is unsupported.
- Automatic local migration supports only plaintext stable 1.0.0/1.1.0 data
  and is irreversible. An existing stable remote index (`version: 1` or
  `version: 2`) requires explicitly confirmed Force synchronization with an
  optional archive. See the [upgrade guide](README.md#upgrading-from-110-to-200).
- Historical encrypted formats and unsupported or incomplete local state are
  rejected. Unsupported remote metadata blocks ordinary sync; Force local can
  rebuild destination metadata from a readable local source. Encrypted
  destination cleanup still requires an authenticated, supported filename codec.
- Ordinary destructive folder operations require valid causal mutation metadata;
  entries without `mutationSeq` cannot authorize them.

### Added

- Optional end-to-end encryption of file contents, remote file/folder names,
  and index contents: AES-256-GCM, deterministic RFC 5297 AES-SIV path segments,
  PBKDF2-HMAC-SHA256 (600,000 iterations), and HKDF-separated content/filename
  keys. Manifest algorithms, parameters, and the `hardened` profile are strictly
  validated before use.
- Encryption enable, disable, password changes, and recovery after interruption.
  These operations use the initiating device's local files as the reference
  within the selected filters; other devices receive the replacement before
  merging further changes. Each run offers its own archive choice.
- Self-contained `OYDSBKP!` encrypted backup envelopes with bounded,
  authenticated headers and archive-specific PBKDF2/AES-GCM parameters.
  Archives can be downloaded with their original password after the vault
  password changes or encryption is disabled.
- Persistent watcher events, per-device mutation FIFO, and resumable physical
  actions, saved together with the baseline and settings in one coherent local
  snapshot. Retries retain the original operation IDs and mutation sequences.
- A collapsible synchronization badge on desktop, Android, iPhone, and iPad,
  showing current activity, progress, last successful sync, and error details.
  On desktop it replaces the old status-bar item.
- A log viewer, optional debug logging, and diagnostics for sync phases,
  conflicts, retries, and timeouts.

### Changed

- Reworked conflict resolution around plaintext SHA-256, the device baseline,
  canonical revisions and mutation metadata, and server fingerprints, falling
  back to server mtime when a fingerprint is unavailable. Client clocks no
  longer choose the winner. Concurrent edits preserve conflict copies; ordinary
  local overwrite or deletion stops if a required protective copy fails.
- New devices first receive the existing cloud state, preserving displaced
  local content in protective copies, before publishing local changes.
- Full sync, realtime sync, Force, and encryption maintenance share one
  coordinator. Watcher events and unfinished operations survive restarts and
  retain their causal order.
- File and folder renames/moves are logical mutations backed by guarded physical
  actions. Rename chains and Obsidian's mechanical child events are coalesced
  without restoring obsolete paths.
- Ordinary index updates use an exclusive rename lock, stable JSON semantics,
  strict validation, read-back verification, byte-exact rollback, and stale-lock
  recovery. Ambiguous or competing lock states block synchronization rather
  than selecting an arbitrary index.
- Ordinary physical delete, move, and rejected-upload cleanup require fresh
  canonical authority and a matching physical fingerprint. New encryption
  transitions instead use a durable replacement descriptor, frozen filters,
  and a fresh epoch for recursive cleanup, preserving protected/excluded paths
  and verified target bytes. Legacy transition checkpoints retain fingerprint
  guards. Before encryption commit the source remains authoritative; after
  commit rollback is forbidden and target-mode cleanup is repeatable.
- Rebuilt Force local/remote as direct replacement of the selected destination,
  including empty folders. Both directions honor include/exclude filters,
  configuration-folder selection, `.backup`, and the running plugin's own data.
- Force uses one dialog for source checks, password entry, confirmation, and
  results. The archive option is off by default; a selected archive must be
  verified before deletion. Without it, Force creates no archive, staging,
  trash, or individual protective/conflict copies.
- Interrupted Force saves remaining work for the next manual, startup, or
  scheduled full sync without repeating completed broad deletion. Other devices
  with offline changes can accept the new state, preserve their changes, or
  defer. Successful completion restores watcher/scheduler readiness. Force
  publishes and verifies a rebuilt canonical in a new epoch directly at its
  final path, without ordinary rename locking. It does not fence requests
  already sent by other devices.
- Backup uploads use collision-resistant names, never overwrite existing
  archives, and verify both SHA-256 and exact downloaded bytes after success,
  timeout, or an ambiguous response. Historical plaintext ZIPs remain readable;
  unsupported historical encrypted archives are rejected.
- Settings take effect only after a successful local save. Scheduling, logging,
  and concurrency edits avoid unnecessary full sync or remote revalidation.
  Operation buttons show actual activity and block incompatible actions.
- Split synchronization, encryption, startup, and persistence into focused
  modules. Browser runtime dependencies are pinned and Obsidian is a
  development-only dependency. CI runs tests on Node 20 and 22, lint, formatting,
  build and bundle checks; release workflows additionally check dependency
  audits, release evidence, exact assets, and published asset hashes.

### Fixed

- Deleted files/folders no longer return through stale uploads, replayed events,
  or incomplete rename chains. Exact deletion wins over a concurrent stale edit;
  new or modified descendants survive a concurrent folder deletion.
- Rename chains and duplicate child events no longer recreate obsolete paths or
  produce avoidable conflicts. Files changed during a guarded move are preserved.
- Lost upload/commit responses are reconciled against verified remote state;
  unresolved work is retained instead of being acknowledged as synchronized.
- Unresolved causal work cannot advance the local observed revision or skip a
  gap in the per-device acknowledgement watermark. Same-device replay and
  interrupted settlement retain pending work instead of creating false success.
- Stale-lock recovery verifies an exclusive raw claim before publication and
  preserves renewed locks across MOVE races, retries, and restart.
- Interrupted downloads and transient read failures use bounded retries.
  Stalled native reads no longer block every later read; late results are ignored
  after timeout, cancellation, or a connection change.
- Downloaded service-file bytes are checked against the server content hash
  before index validation. Malformed metadata, unsafe paths, unsupported
  encryption, and corrupt ciphertext block unsafe writes.
- Incomplete scans or source read/decryption failures no longer become an empty
  source or authorize deletion. Corrective uploads recheck index and encryption
  state immediately before writing.
- Interrupted encryption rollback and cleanup retain recovery state. Connecting
  to an encrypted vault validates the password and index before saving the new
  configuration and resuming synchronization. Pre-commit rollback preserves
  source authority; post-commit recovery can be completed by another device
  that authenticates the target mode.
- Excluded encrypted resources retain their authenticated codec. Unsafe codec
  removal and file/folder replacements that would erase excluded descendants
  stop before writes; ciphertext-like filenames alone never authorize deletion.
- The plugin's credentials, local state, and logs are excluded from configuration
  sync and Force archives. Previously uploaded plugin data requires separate
  removal and OAuth token rotation; upgrading does not undo earlier exposure.

### Performance

- Avoided index writes and redundant manifest reads when nothing changed.
  Realtime verification uses targeted reads instead of full remote-tree scans.
- Overlapped independent local/remote scans and metadata reads, reused verified
  service reads, added stable paginated root discovery and bounded parallel
  traversal, and cached observed remote folders with invalidation after
  delete/move or connection, path, and codec changes.
  Default concurrency increased from 10 to 20; saved values are preserved.
- Batched independent renames and coalesced rename chains. Realtime uploads and
  deletes settle in windows of up to 32 events with an 8 MiB plaintext target;
  oversized files are handled separately, so this is not a total memory cap.
- Pass-local FIFO/path indexes and ancestry sets/maps reduce repeated scans
  without caching write authority. Digest-only verification releases each file
  buffer after hashing. ZIP creation still materializes file contents; these
  changes do not establish a lower memory limit for large archives.

## 1.1.0

Added explicit local-to-remote and remote-to-local Force synchronization with
confirmation, optional backup and progress reporting. Added the Force controls
to settings and reused the existing watcher pause/resume lifecycle.

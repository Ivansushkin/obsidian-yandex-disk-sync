# Changelog

## 2.5.0

Changes since `2.4.0`. Requires Obsidian `1.13.1` or later.

### Changed

- Local deletion during Force and reception after an encryption change follows
  Obsidian's deletion preference. Local replacement preserves files outside
  Obsidian's file tree and stops if a replacement would overwrite them.
- The vault root's `.trash` is excluded from sync, Force replacement and
  encryption changes on both sides, including recovery of older queued work.
- Force from Disk verifies and fetches independent files concurrently and
  applies local writes in order. Force and ordinary full sync group downloads
  by file size to limit how much content is held in memory at once.

### Fixed

- Force recovery after a lost response to the final index upload preserves
  revisions published later by another device. Regular full sync receives
  those edits before acknowledging their revision.
- A pending Force deletion holds back copies and folder creation at affected
  paths. A file or folder that changed type while awaiting deletion is preserved,
  and unrelated transfers continue.
- Recreating a deleted file offline preserves a concurrent edit at the original
  path and saves the recreated version in one conflict copy. If the published
  version has returned to its original contents, the recreated file keeps its
  original path.
- Late writes to the old encrypted trash stay outside the vault after key
  rotation or decryption. A device with the new password can finish interrupted
  rotation cleanup once it verifies that the old file is already absent.
- Full sync checks downloaded content before writing it locally. A stale
  response leaves the published version available for the next sync. Verified
  edits made directly on Disk still reach connected devices.
- If Disk returns stale bytes for the sync index, the plugin requests a fresh
  download link and verifies the index before applying it.
- A folder rename can now finish when another device last edited its files,
  including when identical copies already exist at the destination.
- Full sync records the last successful revision and time after saving the
  local state. A failed save leaves the sync available to retry.
- Avoid false conflict copies after an interrupted sync when only one device
  edited a file, including when Disk supplies only an MD5 checksum for the
  interrupted upload. Recover conflicts in queue order alongside pending uploads,
  moves and deletions, including retries after a conflict fails mid-batch.
- Preserve files created or edited by another device after an offline folder
  deletion. If a device deletes a folder while its peer is offline, the peer's
  new files and edits sync back on reconnect, including after a restart.
  Unchanged files stay deleted. Verified edits made directly on Disk can also
  survive the deletion.
- Preserve hidden files when deleting the last visible note in a folder.
  Ordinary sync asks the adapter to remove an empty parent non-recursively.
  If the adapter refuses, the folder stays and the note deletion still completes.
- Resume interrupted Force copies into hidden folders and keep a copy pending
  if Disk returns invalid file metadata or the local recovery state fails to save.
- Hidden names that differ only by case can coexist during Force recovery when
  they are outside the remaining destinations. A name or type collision with a
  remaining destination still blocks that write.
- Allow Force from Disk to skip directories left by an earlier encryption mode
  after verifying that the full subtree contains no files. Preserve exclusions
  from earlier encryption changes during recovery.
- Handle programmatic moves into and out of the vault root's `.trash` during
  realtime sync.

### Upgrade

- Existing sync indexes and encryption metadata retain their formats. Either
  direction of Force can replace a supported legacy index using the standard
  confirmation and optional archive. If an older saved Force operation cannot
  safely resume, the plugin asks for confirmation of a new replacement.

## 2.4.0

Changes since `2.3.0`. Requires Obsidian `1.13.1` or later.

### Added

- Find plugin settings through Obsidian's settings search. Results open the
  relevant section and match localized setting names.

### Fixed

- Backup downloads use the window that owns the backup dialog. Background
  timers use the plugin's window, and settings buttons fit narrow layouts.
- Settings sliders use Obsidian's inline values, and destructive actions use
  the current button API.

### Changed

- The Community Directory compatibility table now requires Obsidian
  `1.0.0` for the `1.1.0` fallback release.
- Backup, Force sync and encryption archives use a browser-compatible ZIP
  writer without dynamic code. Existing backups remain readable.
- Release validation checks that the tag, source manifest and packaged
  manifest agree. GitHub Actions attest `main.js` and `styles.css` and verify
  their provenance after publication.

## 2.3.0

Changes since `2.2.0`.

### Changed

- After OAuth or manual sign-in, synchronization waits for the first manual
  Sync, even across restarts. Automation is enabled when that run is accepted.
- The sync indicator can be hidden in settings without stopping synchronization;
  its visibility choice persists across restarts.
- Full sync requests less remote metadata. If the reduced response is incomplete
  or unsupported, it retries with full metadata and stops safely if that too is
  incomplete.
- Recovery after suspension now handles desktop focus as well as mobile return.
  It waits for outstanding requests, retries network failures and resumes after
  connectivity returns. Repeated manual requests share one pending run.

### Fixed

- Sync progress notices stay inside plugin settings instead of appearing over
  the workspace. Sync failures can still show a global notice; repeated identical
  failures are suppressed until the next successful exchange.
- Changes made during synchronization remain pending when earlier observations
  become stale. Folder moves preserve mutation order across restarts, and failed
  internal writes no longer suppress later edits.
- Incomplete remote inventories and temporarily missing service indexes are
  handled without treating missing data as an empty folder.
- Force recovery verifies written data and preserves later local changes rather
  than repeating a completed broad purge. Encryption transitions and replacement
  recovery also preserve later edits and protected copies through interruptions.
- Temporary startup and encryption-manifest read failures no longer leave a
  permanent block before a transition starts. OAuth recovery avoids repeated
  refresh requests; a rejected grant still requires signing in again.
- The indicator and settings notice distinguish pending work and failures from
  a successful exchange. The success time updates only after a fully settled sync,
  and screen readers receive the same status and reason.
- Diagnostic log write failures are reported, retained entries are bounded, and
  sensitive values are masked in messages and context.

### Diagnostics

- Added read-only probes for Disk revision availability and response size.
  Force logs its recovery phase and remaining work without file contents.

## 2.2.0

Changes since `2.1.0`.

### Added

- Shared Yandex sign-in uses an authorization code with PKCE S256 and a public
  Client ID. The flow uses an Obsidian callback on desktop, Android and iOS;
  real provider and device acceptance still requires manual verification. Each
  attempt has an isolated state, verifier and timeout.
- A local **Sign out** action for shared and manual connections removes saved
  credentials and the encryption password, then clears the active codec. It
  preserves the remote folder, synchronization history, offline work, encryption
  parameters and files. Encrypted vaults request the password after sign-in.
  Sign-out requires confirmation and is unavailable during unfinished encryption
  or Force recovery; it does not revoke access on Yandex's side.
- The expanded sync indicator has a pause/resume button alongside sync and log
  actions. Pause stops automatic work; resume runs a full sync before automation
  continues.

### Changed

- Existing manual connections remain available after updating. Starting shared
  sign-in explicitly clears their Client ID and token before opening the browser;
  cancellation does not restore them.
- For an existing connection, a new token is accepted only after the selected
  remote root matches its saved identity. Credential changes use the existing
  persistence queue and wait for active synchronization and native writes to
  settle. The first successful full sync after sign-in enables automatic
  synchronization.
- Connection settings separate the remote folder, authorization controls and
  synchronization action. The shared sign-in state is shown next to its controls,
  the sync button is hidden during sign-in, and the manual token input does not
  display a shared OAuth token. Controls adapt to narrow settings panels.
- After sign-out, status prompts for sign-in or a manual token. Sync, Force,
  backup and encryption actions stay unavailable until access is configured.
- In manual connection settings, **Sign in** starts normal synchronization after a
  token is entered. **Sign out** appears after the first successful full sync.
- Shared OAuth access is refreshed before it expires. After an HTTP 401, regular
  sync can refresh the token and retry through its normal queue. Temporary
  refresh failures retain pending work; a rejected grant requires sign-in again.
  Backup and Force still require an explicit retry after an error.
- Sync status and errors are shown in the shared indicator. The separate
  **Show sync status** command and dialog have been removed.
- Production builds require `YANDEX_OAUTH_CLIENT_SECRET` for token refresh. The
  secret is embedded in the bundle and does not protect users' tokens.
- Release validation no longer requires machine-readable scenario evidence files.
  Manual acceptance with two Obsidian profiles against real Yandex Disk remains
  required before release.

### Fixed

- An incorrect encryption password reopens the password dialog in the same
  connection attempt. Cancel closes it; other connection errors do not reopen it.
- An encryption password left in local data without a connection is cleared on
  load, and later snapshots cannot restore credentials after sign-out.

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

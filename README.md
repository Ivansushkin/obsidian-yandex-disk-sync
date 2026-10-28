# Yandex Disk Sync for Obsidian

A plugin for synchronizing Obsidian notes with Yandex Disk. Allows automatic synchronization of vault between multiple devices through Yandex's cloud storage.

**Interface languages:** English · Русский · Қазақша · Беларуская · O‘zbekcha.
The plugin follows Obsidian’s language by default. Choose an explicit language
at the top of plugin settings to apply it immediately.

Connection and scope changes take effect only after a coherent local save.
Active operations and unfinished recovery can block changes. See the
[documentation guide](docs/README.md) for architecture, scenarios and release checks.

## Connection setup

Choose the remote folder, configure OAuth and click **Synchronize**. Saving a
new token or remote folder waits for a successful manual full sync before starting
automatic synchronization, including after restarting Obsidian. Existing 2.0.0
connections keep automatic startup until these settings change. The token input
is masked; credentials remain stored locally.

While settings are open, one notification mirrors the synchronization status and
hides when idle or when settings close. Settings offer **Copy logs**, **Open log
file** and **Clear log file**; the indicator also offers copy and open. Copying
uses the latest 4,000 sanitized characters, with the count shown on hover or focus.
Clearing requires confirmation. External opening depends on Obsidian support;
the built-in log viewer has been removed.

## Upgrading from 1.1.0 to 2.0.0

Version 2.0.0 supports migration only from plaintext stable 1.0.0 and 1.1.0.
Local settings and baseline are saved immediately as current `plugin-data`
after installation identity initialization, before automation starts. Downgrading
the local format to 1.1 is unsupported; a failed save blocks synchronization.
A plaintext stable canonical with `version: 1`/`version: 2` requires explicit Force.
Force replaces selected destination files and offers an optional archive, off by default.
Old destination canonical/fingerprints do not select a winner; source is read
before clearing. Other devices adopt the new epoch through ordinary full and its
offline-edit decision. Stopping other devices is not a Force prerequisite, but
late requests from old clients may change the result. Resume does not bypass
ordinary startup blocks.

If stable 1.1 uploaded the sync plugin directory, ordinary migration blocks reading
that exposed data. Force omits its own credentials from source/archive and preserves protected remote
plugin copies without reading them. Remove previously exposed copies separately. Rotate a previously
exposed OAuth token separately; Force does not undo credential exposure.
Force remote omits plugin data and rejects ambiguous portable source paths before
local writes.

Encrypted legacy data and every other historical format are unsupported.
Invalid local data blocks startup and mutating workflows. Unsupported remote
formats block ordinary sync; confirmed Force local can replace destination
metadata from a readable local source without decoding the old destination.
Choose a clean remote path or reset the old data manually only after making an
independent backup. Current data is accepted only with the semantic markers
`sync-index`, `encryption-manifest`, and `plugin-data`; incompatible historical
data has no converter or recovery path.

Do not start an older plugin version after the transition: it can replace the
canonical index or restore deleted files. If that happens, disable sync everywhere,
select the most complete local vault, inspect backup/conflict copies, and
repeat Force local with an explicit archive choice.

> **Data safety**
> Use an independent backup for important vaults. Deletions propagate to other
> devices. Force replaces selected destination files and offers an explicit backup
> choice. OAuth tokens and encryption passwords are stored in plaintext in local
> plugin data; never share that directory or diagnostic data containing secrets.
> The plugin sends synchronized data to Yandex Disk and collects no telemetry.
> Use it at your own risk; see [LICENSE](LICENSE).

## Features

- **Real-time synchronization** — automatic upload of modified files when saving
- **Periodic full synchronization** — check and synchronize all files by timer
- **Two-way synchronization** — changes from any device are synchronized to all others
- **Conflict resolution** — causal SHA-256, server-mtime, and tombstone rules
  with preservation of displaced local content
- **Deletion synchronization** — deleted files are deleted on all devices
- **Flexible filters** — configurable include/exclude file patterns
- **Multi-device support** — work under one token on different devices
- **Backup system** — create ZIP backups of vault stored on Yandex Disk
- **Force synchronization** — confirmed replacement of selected destination files from local or remote files
- **End-to-end encryption** — AES-256-GCM content encryption and deterministic AES-SIV filenames with separated keys

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Ivansushkin/obsidian-yandex-disk-sync/releases)
2. Create `yandex-disk-sync` folder in `<Vault>/.obsidian/plugins/`
3. Copy downloaded files to created folder
4. Restart Obsidian
5. Enable plugin in **Settings → Community plugins**

### Via BRAT (for preview testing)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add repository through BRAT
3. Execute "Check for updates in BRAT"

## Setup

### Getting OAuth Token

1. Go to [Yandex OAuth](https://oauth.yandex.ru/)
2. Create an application with read and write access to Yandex Disk and access to the app folder on Disk
3. Get OAuth token
4. Paste token in plugin settings

### Plugin Settings

| Parameter                     | Description                                                      | Recommended Value         |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------- |
| **OAuth token**               | Token for Yandex Disk API access                                 | Obtained in settings      |
| **Remote path**               | Path to folder on Yandex Disk (e.g., `obsidian-sync/my-vault`)   | `obsidian-sync`           |
| **Real-time sync**            | Automatic synchronization when files are changed                 | Enabled                   |
| **Full sync interval**        | Full synchronization interval in minutes (0 = manual only)       | 5 minutes                 |
| **Sync delay**                | Delay before uploading file after change (debounce)              | 1000 ms                   |
| **Max concurrent operations** | Concurrent file operations and independent metadata reads (1–40) | 20                        |
| **Sync config folder**        | Synchronize Obsidian settings folder                             | Disabled (by default)     |
| **Include/Exclude patterns**  | Glob patterns for file filtering                                 | `**` (all syncable files) |
| **Force Sync**                | Replace selected destination files from local or remote files    | —                         |
| **Backup**                    | Create ZIP backups of synchronized files                         | Manual / per-run choice   |
| **Encryption**                | Enable end-to-end AES-256-GCM encryption                         | Disabled (by default)     |
| **Encryption info**           | Information about encryption and password storage                | —                         |
| **Change password**           | Change encryption password (when encryption is enabled)          | —                         |

The default concurrency is 20 when the setting is absent; saved values are preserved. Ordinary folder reads use the same limit. Canonical commits and causally dependent operations retain their required order.

## Commands

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `Sync now`          | Run full synchronization manually                  |
| `Pause/Resume sync` | Pause or resume synchronization                    |
| `Show sync status`  | Show status and statistics of last synchronization |
| `Create backup`     | Create backup copy of vault as ZIP archive         |

## Usage

### Synchronization indicator

A shared compact badge shows `YD`, a loader while working and a status icon.
On desktop it sits at the bottom right, 8 px above the status bar, replacing
the old YD item inside the bar. Click it to expand details upward; click again
to collapse. If the status bar is hidden, the badge stays above the window edge.
On Android, iPhone and iPad it stays at the top right, 8 px below the upper
controls and safe area. Tap to expand or collapse.

The current phase, known progress, last successful synchronization time and
error details appear only when expanded. Long details can be selected and
scrolled. Updates preserve the chosen view; errors do not expand it automatically.
Force, encryption and backup remain visible between internal stages.
Existing progress and blocking notices remain. Idle does not guarantee that
deferred changes or changes on another device have already been synchronized.

### First Launch

On first launch, the plugin will check for files locally and on Yandex Disk:

- **If local vault is empty and disk has files** — files will be downloaded
- **If disk is empty and local has files** — files will be uploaded
- **When connecting a new device to existing cloud data** — cloud versions are received first. Different local versions are preserved under `.obsidian/plugins/yandex-disk-sync/overwritten/`. Cloud deletions are applied with protective copies; local-only files are kept and uploaded after the initial receive. Later synchronization uses the normal two-way rules.

> **Recommendation**
>
> Before the first synchronization, create a manual backup of your vault. When working with cloud data, there is always a risk of information loss.

### Working on Multiple Devices

1. Set up plugin on first device and perform initial synchronization
2. On second device, install plugin with same token and path
3. Plugin will automatically download files from Yandex Disk

> **Important**
>
> Use the same token on all devices. If you change the token, you will need to reconfigure synchronization on all devices.

### Conflict Resolution

Local changes are detected by SHA-256; remote changes use server mtime and a
server fingerprint. If both sides changed, the plugin creates a conflict copy.
Sequential edits from the same plugin installation remain causal even when a
previous upload is still completing; they do not create conflict copies.
An exact-file deletion wins over a concurrent edit, but displaced local content
is first preserved in backup. A new or modified file inside a concurrently
deleted folder survives.

> **Warning**
>
> Deletions propagate to every device. Keep an independent backup for important
> vaults, especially before Force sync.

### Backup System

Plugin includes built-in backup system for creating ZIP archives of your vault:

- **Create backups**: Plugin settings → Backup section → "Create backup" button
- **Backup location**: Backups are stored in `.backup` folder on Yandex Disk
- **Backup format**:
  `backup_YYYY-MM-DD_HH-MM-SS-SSS_<96-bit-random>[.enc].zip`
- **Encrypted backup**: self-contained authenticated envelope; download saves
  a regular `.zip` and can request the archive's own password
- **Content**: All files subject to synchronization according to filters
- **Availability**: Every device reads the shared backup list directly from
  the protected remote `.backup` folder

**Note**: `.backup` folder is protected and excluded from synchronization operations.

### Force Synchronization

Force replaces selected destination files with the actual source directly.
Both directions honor include/exclude filters, protected paths and the Obsidian
configuration switch. Excluded files and this sync plugin remain untouched.

- **Local → Disk:** replace selected remote payloads and rebuild the index.
  An encrypted destination requires its verified password to classify exclusions;
  keeping encryption preserves its codec so excluded ciphertext stays readable.
- **Disk → local:** read/authenticate selected physical files and replace selected
  local files. Keep .backup, excluded files and this plugin; preserve source encryption.

Disabling encryption while excluded encrypted files remain is blocked; use the
dedicated encryption settings first. A corrupt destination manifest also blocks
scoped cleanup. File/folder collisions that would erase exclusions stop before writes.

An unreadable source is not empty. A successfully read empty selection clears only selected destination files. Force creates no temporary files, locks, trash or protective/conflict
copies. One confirmation offers an archive, off by default; archive errors remain
in that dialog until retry, disabling the archive or cancellation. Restart Obsidian
after replacing configuration.

Independent errors do not stop other actions. Partial results list failures;
ordinary manual/startup/scheduled full retries the remainder without repeating
the full purge. A new Force always starts a newly confirmed replacement.
Other devices need not stop; late foreign requests are not fenced.
See the [Force contract](docs/FORCE_SYNC.md).

## Encryption

New encrypted vaults use the `hardened` profile: PBKDF2-HMAC-SHA256 with
600,000 iterations derives a master key, then HKDF-SHA256 derives independent
AES-256-GCM content and AES-SIV filename keys.

Enable, disable and password rotation use **the initiating device's local files
as the reference** within the current sync filters. Remote-only files and older
offline edits on other devices are not merged into that reference. Other devices
automatically receive the selected generation, replacing their old queues and
selected local extras.

Do not edit the vault on any device until completion. Already-sent foreign requests
can finish after verification; there is no server fencing. Each target is downloaded
back and checked against its plaintext SHA-256. Failures retain recovery; foreign
completion and legacy checkpoint limits are covered in the
[encryption guide](docs/E2E_ENCRYPTION.md). Another device's password is saved only
after verifier and canonical authentication; wrong or cancelled credentials do not
replace active settings.

- **Content encryption**: each file gets a random 12-byte IV, ensuring unique ciphertext even for identical files
- **Filename encryption**: RFC 5297 AES-SIV with fixed domain AAD and canonical Base64URL; paths remain stable across devices and folder moves do not re-encode descendants
- **Key**: derived from your password + random 16-byte salt — the master key never leaves your device
- **Multi-device**: salt is stored in a shared file `.obsidian-encrypt.json` on Yandex Disk (raw, unencrypted). When encryption is enabled on a new device, it auto-detects encrypted data, prompts for the password, and verifies it before enabling

**How to enable**:

1. Go to **Settings → Encryption section**
2. Click the encryption toggle
3. Enter and confirm your password
4. Choose a full archive, continue without one, or cancel. A selected archive must pass exact byte verification
5. Leave files unchanged on every device until completion; selected local files are uploaded encrypted

**Password recovery**: The password is NOT recoverable. If you lose the password while encryption is enabled, your data on Yandex Disk becomes permanently inaccessible. Keep the password in a safe place (e.g., password manager).

**Password storage**: The password is stored in `data.json` (Obsidian plugin config) as a plaintext string. It is never sent to Yandex or any third party.

> **Warning**
> The transition replaces the selected Disk scope with the local reference.
> Source mode is authoritative before canonical commit; target mode is authoritative
> afterward, with no rollback. Protected/excluded paths are retained. Save any needed
> remote-only or offline edits separately before starting. Encrypted output requires
> its password.

Numeric historical manifests and historical encrypted backup formats are
unsupported. Non-envelope `.enc.zip`, encrypted legacy names, and
non-plaintext historical `.zip` bytes are rejected without a compatibility
decryption attempt. Plaintext historical ZIP archives remain downloadable.

## Development

Requires Node.js 20.19+ and npm.

```bash
npm install
npm test
npm run lint
npm run build
npm run format:check
```

Build assets go to `build/`; `npm run dev` enables incremental builds. Test-vault
configuration through `.env`, hooks, formatting and diagnostics are covered in the
[development guide](docs/README.md#разработка-и-проверки).
[AGENTS.md](AGENTS.md) defines code rules and the compact algorithm-test policy.
Native Obsidian acceptance uses the [smoke cases](docs/SMOKE_TESTS.md).

## Architecture

The normative catalogue of synchronization, multi-device, failure-recovery,
and encryption scenarios is maintained in
[`docs/SYNC_USER_SCENARIOS.md`](docs/SYNC_USER_SCENARIOS.md).

Start with the [documentation guide](docs/README.md) and [architecture](docs/ARCHITECTURE.md).

## Security

- OAuth token is stored as plaintext in local plugin data because Obsidian
  mobile plugins do not provide a portable OS keychain API
- Token is not logged and not transmitted to third parties
- Grant only the OAuth permissions needed to read and write the selected storage
- Removing local plugin data does not revoke the OAuth token; revoke unused tokens through Yandex OAuth
- All network requests use HTTPS with certificate verification
- User data is never collected or analyzed by the plugin developer
- **End-to-end encryption**: file content uses AES-256-GCM and filenames use AES-SIV; derived keys stay in device memory

## Limitations

- Ordinary sync does not transfer empty folders; direct Force does. Symlinks and special file attributes are not synchronized.
- Old and current plugin builds must not use the same remote storage concurrently.
- Provider quotas, file-size limits and throttling depend on Yandex Disk; check your
  current account limits. The plugin cannot raise them.
- ZIP creation retains the archive's files in memory. Realtime windows reduce retained
  content but do not impose a hard cap on device memory or an oversized file.
- Network failures leave durable work for recovery; an idle indicator does not prove
  that every device has converged. Real desktop/mobile release checks are separate
  from automated tests.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [Obsidian](https://obsidian.md) for excellent product and API
- [Yandex Disk](https://disk.yandex.ru) for cloud storage
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) for preview update testing
- Obsidian community for support and inspiration

---

**Last Updated**: October 27, 2026

**Version**: 2.0.0

**Supported Platforms**: Windows, macOS, Linux, iOS, Android

**Required Obsidian Version**: 1.0.0+

> **Developer Note**
>
> This plugin is created by the community for the community. It is not an official product of Obsidian or Yandex. All trademarks and copyrights belong to their respective owners.

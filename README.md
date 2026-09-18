# Yandex Disk Sync for Obsidian

A plugin for synchronizing Obsidian notes with Yandex Disk. Allows automatic synchronization of vault between multiple devices through Yandex's cloud storage.

## Upgrading from 1.1.0 to 2.0.0

Version 2.0.0 supports migration only from plaintext stable 1.0.0 and 1.1.0.
Their local `localIndex` is converted into the current baseline in memory, but
the original stable `data.json` shape remains rollback-readable until a
verified backup and explicit Force migration reach the local cutover boundary.
Plaintext canonical indexes carrying the exact stable `version: 1` or
`version: 2` shape require a backed-up explicit **Force sync**.

Before Force, update every device and stop stable 1.1 everywhere. A second
updated device that observes the replacement canonical must run Full manually;
it creates and verifies its own local backup before adopting the new epoch.
Missing/invalid tokens and migration state never start the watcher or scheduler.

If stable 1.1 synchronized the configuration directory and remote metadata
contains this plugin's directory, migration stops without downloading its
contents or adding it to a remote snapshot backup. Delete that remote plugin
directory and replace the OAuth token; a non-secret local remediation marker
keeps Force blocked across restart until the token changes. Rename any user
path that conflicts with a current service filename or current path rules.
Force remote also stops before local writes on NFC/case-insensitive path
collisions.

Encrypted legacy data and every other historical format are unsupported.
Numeric manifests and canonical formats, unmarked queues/transitions, and
incomplete current transition metadata block startup and all remote writes.
Choose a clean remote path or reset the old data manually only after making an
independent backup. Current data is accepted only with the semantic markers
`sync-index`, `encryption-manifest`, and `plugin-data`; incompatible historical
data has no converter or recovery path.

Do not start an older plugin version after the transition: it can replace the
canonical index or restore deleted files. If that happens, disable sync everywhere,
select the most complete local vault, inspect backup/conflict copies, and
repeat the backed-up Force local procedure.

> **⚠️ IMPORTANT WARNINGS AND LIMITATIONS**
>
> **Legal Liability**  
> The author is not responsible for the safety and security of your data. Install and use the plugin at your own risk. All plugin code is open source, and you can independently verify its security.
>
> **Data Security**  
> The OAuth token is stored as plaintext in local Obsidian plugin data and is
> not transmitted to third parties. Never share it with the developer or other
> persons. Use a token with minimal permissions (`cloud_api:disk.app_folder`).
>
> **Yandex Disk API Limitations (as of this document's writing)**
>
> - **Maximum file size**: 50 GB (requires active Yandex 360 plan), for free version — 2 GB
> - **Daily limit**: 750 GB of uploads per day per account
> - **Free storage**: 5 GB (can be increased to 200 GB, 1 TB, or 3 TB with Yandex 360 plan)
>
> **Synchronization Risks**
>
> - Conflicts create a separate conflict copy; a local version displaced by a
>   deletion is preserved in backup
> - Deleted files will be deleted on all devices during synchronization
> - Automatic synchronization may lead to data loss with unstable internet connection
> - Intensive API usage may lead to temporary account blocking by Yandex
>
> **Account Requirements**  
> To upload files larger than 2 GB, an active Yandex 360 plan is required. The free version has limitations on file size and total storage.
>
> **Privacy**  
> The plugin does not collect or transmit any of your data, file contents, or metadata to the developer. All operations occur locally on your device using the official Yandex Disk API.

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
- **Force synchronization** — unconditional one-way overwrite (local→remote or remote→local) for recovery or manual resync
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

> **⚠️ Important**  
> To upload files larger than 2 GB, an active Yandex 360 plan is required. The free version of Yandex Disk provides only 5 GB of storage.

1. Go to [Yandex OAuth](https://oauth.yandex.ru/)
2. Create application with `cloud_api:disk.app_folder` (recommended) or `cloud_api:disk.read` + `cloud_api:disk.write` permissions
3. Get OAuth token
4. Paste token in plugin settings

### Plugin Settings

| Parameter                    | Description                                                    | Recommended Value       |
| ---------------------------- | -------------------------------------------------------------- | ----------------------- |
| **OAuth token**              | Token for Yandex Disk API access                               | Obtained in settings    |
| **Remote path**              | Path to folder on Yandex Disk (e.g., `obsidian-sync/my-vault`) | `obsidian-sync`         |
| **Real-time sync**           | Automatic synchronization when files are changed               | Enabled                 |
| **Full sync interval**       | Full synchronization interval in minutes (0 = manual only)     | 5 minutes               |
| **Sync delay**               | Delay before uploading file after change (debounce)            | 1000 ms                 |
| **Max concurrent operations** | Bounded file-operation concurrency                             | 10                      |
| **Sync config folder**       | Synchronize Obsidian settings folder                           | Disabled (by default)   |
| **Include/Exclude patterns** | Glob patterns for file filtering                               | `*.md`, `attachments/*` |
| **Force Sync**               | Unconditional one-way overwrite (local→remote / remote→local)  | —                       |
| **Backup**                   | Create ZIP backups of synchronized files                       | Disabled (by default)   |
| **Encryption**               | Enable end-to-end AES-256-GCM encryption                       | Disabled (by default)   |
| **Encryption info**          | Information about encryption and password storage              | —                       |
| **Change password**          | Change encryption password (when encryption is enabled)        | —                       |

## Commands

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `Sync now`          | Run full synchronization manually                  |
| `Pause/Resume sync` | Pause or resume synchronization                    |
| `Show sync status`  | Show status and statistics of last synchronization |
| `Create backup`     | Create backup copy of vault as ZIP archive         |

## Usage

### First Launch

On first launch, the plugin will check for files locally and on Yandex Disk:

- **If local vault is empty and disk has files** — files will be downloaded
- **If disk is empty and local has files** — files will be uploaded
- **If files exist in both places** — the plugin will perform two-way merge synchronization

> **⚠️ Recommendation**  
> Before the first synchronization, create a manual backup of your vault. When working with cloud data, there is always a risk of information loss.

### Working on Multiple Devices

1. Set up plugin on first device and perform initial synchronization
2. On second device, install plugin with same token and path
3. Plugin will automatically download files from Yandex Disk

> **⚠️ Important**  
> Use the same token on all devices. If you change the token, you will need to reconfigure synchronization on all devices.

### Conflict Resolution

Local changes are detected by SHA-256; remote changes use server mtime and a
server fingerprint. If both sides changed, the plugin creates a conflict copy.
Sequential edits from the same plugin installation remain causal even when a
previous upload is still completing; they do not create conflict copies.
An exact-file deletion wins over a concurrent edit, but displaced local content
is first preserved in backup. A new or modified file inside a concurrently
deleted folder survives.

> **⚠️ Warning**  
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

The plugin includes a **Force Sync** feature for cases when normal two-way sync is not sufficient:

- **Sync from local → remote**: overwrites ALL files on Yandex Disk with local versions. Files not present locally are deleted from the remote.
- **Sync from remote → local**: overwrites ALL local files with versions from Yandex Disk. Files not present on the remote are deleted locally.

Force sync ignores timestamps, file hashes, and conflict resolver — it creates an exact copy in the chosen direction.

> **⚠️ Warning**
> Force sync is destructive. The overwritten side is fully replaced. The
> plugin requires a successful backup before it enables the operation. The
> source is checked again before replacement commit. After that commit,
> interrupted fingerprint-guarded cleanup is resumed by normal Full sync and
> Force must not be repeated.
>
> **Location**: Settings → Force Sync section.

### Encryption

New encrypted vaults use the `hardened` profile: PBKDF2-HMAC-SHA256 with
600,000 iterations derives a master key, then HKDF-SHA256 derives independent
AES-256-GCM content and AES-SIV filename keys.

While encryption is being enabled, disabled, or rotated, other devices block
normal synchronization. A target-capable device can finish fingerprint-guarded
post-commit cleanup from canonical metadata without the source password.
Passwords entered on another device remain candidate credentials until the
manifest verifier, transition/canonical coherence, and canonical decryption all
succeed. A wrong or cancelled password does not replace the active settings.
Every rewritten object is downloaded back and checked against its decoded
logical path and plaintext SHA-256 before its fingerprint can authorize commit
or cleanup.

- **Content encryption**: each file gets a random 12-byte IV, ensuring unique ciphertext even for identical files
- **Filename encryption**: RFC 5297 AES-SIV with fixed domain AAD and canonical Base64URL; paths remain stable across devices and folder moves do not re-encode descendants
- **Key**: derived from your password + random 16-byte salt — the master key never leaves your device
- **Multi-device**: salt is stored in a shared file `.obsidian-encrypt.json` on Yandex Disk (raw, unencrypted). When encryption is enabled on a new device, it auto-detects encrypted data, prompts for the password, and verifies it before enabling

**How to enable**:

1. Go to **Settings → Encryption section**
2. Click the encryption toggle
3. Enter and confirm your password
4. Wait while the plugin creates and byte-verifies the mandatory backup
5. Wait for the initial encryption sync (all files are re-uploaded encrypted)

**Password recovery**: The password is NOT recoverable. If you lose the password while encryption is enabled, your data on Yandex Disk becomes permanently inaccessible. Keep the password in a safe place (e.g., password manager).

**Password storage**: The password is stored in `data.json` (Obsidian plugin config) as a plaintext string. It is never sent to Yandex or any third party.

> **⚠️ Warning**
> Enabling encryption re-uploads every file in encrypted form. The old
> plaintext set remains authoritative until the canonical commit and is then
> deleted only by fingerprint-guarded cleanup. The resulting encrypted data
> cannot be read without the password.

Numeric historical manifests and historical encrypted backup formats are
unsupported. Non-envelope `.enc.zip`, encrypted legacy names, and
non-plaintext historical `.zip` bytes are rejected without a compatibility
decryption attempt. Plaintext historical ZIP archives remain downloadable.

## Development

### Requirements

- Node.js 20.19+
- npm

### Install Dependencies

```bash
npm install
```

### Development Mode

Create a local environment file once and set the absolute test-vault plugin
directory. The file is ignored by Git and its value takes precedence over any
shell variable with the same name:

```bash
cp .env.example .env
```

```dotenv
YANDEX_PLUGIN_PATH=/absolute/path/to/test-vault/.obsidian/plugins/obsidian-yandex-disk-sync
```

```bash
npm run dev
```

### Build

```bash
npm run build
```

Built files are written to `build/`. When `.env` contains
`YANDEX_PLUGIN_PATH`, the build also copies release artifacts to that
test-vault plugin directory. A clean checkout without `.env` only creates the
release artifacts.

### Linting

```bash
npm run lint
```

### Testing policy

Bulk unit-test generation is prohibited. Keep only compact tests of complex
algorithms and function interactions; avoid trivial checks, UI mocks, and
coverage-driven growth. A bug fix does not automatically require a new unit test.
Follow [AGENTS.md](AGENTS.md#documentation-and-testing) and verify user behavior
with the [real Obsidian smoke scenarios](docs/SMOKE_TESTS.md).

## Architecture

The normative catalogue of synchronization, multi-device, failure-recovery,
and encryption scenarios is maintained in
[`docs/SYNC_USER_SCENARIOS.md`](docs/SYNC_USER_SCENARIOS.md).

Detailed description of architecture and approaches see in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- OAuth token is stored as plaintext in local plugin data because Obsidian
  mobile plugins do not provide a portable OS keychain API
- Token is not logged and not transmitted to third parties
- Recommended to use token with minimal necessary permissions (`cloud_api:disk.app_folder`)
- When removing the plugin, the token is **not** automatically deleted — delete it manually from Obsidian settings
- All network requests use HTTPS with certificate verification
- User data is never collected or analyzed by the plugin developer
- **End-to-end encryption**: file content and filenames are encrypted with AES-256-GCM before upload; the encryption key never leaves your device

## Limitations

- **Maximum file size**: 50 GB (requires Yandex 360 plan), free version — 2 GB
- **Free storage**: 5 GB (Yandex Disk limitation)
- **Binary file synchronization** may be slower due to API limitations
- **Symlinks synchronization is not supported** and special file attributes
- **Daily traffic limit**: 750 GB of uploads per day per account (Yandex Disk limitation)
- **Frequent API requests** may lead to temporary account blocking

## License

MIT License

Copyright (c) 2024-2026 Ivansushkin

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Acknowledgments

- [Obsidian](https://obsidian.md) for excellent product and API
- [Yandex Disk](https://disk.yandex.ru) for cloud storage
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) for preview update testing
- Obsidian community for support and inspiration

---

**Last Updated**: August 27, 2026

**Version**: 2.0.0

**Supported Platforms**: Windows, macOS, Linux, iOS, Android

**Required Obsidian Version**: 1.0.0+

> **ℹ️ Developer Note**  
> This plugin is created by the community for the community. It is not an official product of Obsidian or Yandex. All trademarks and copyrights belong to their respective owners.

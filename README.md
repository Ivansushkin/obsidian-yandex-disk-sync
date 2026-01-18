# Yandex Disk Sync for Obsidian

A plugin for synchronizing Obsidian notes with Yandex Disk. Allows automatic synchronization of vault between multiple devices through Yandex's cloud storage.

## Features

- **Real-time synchronization** — automatic upload of modified files when saving
- **Periodic full synchronization** — check and synchronize all files by timer
- **Two-way synchronization** — changes from any device are synchronized to all others
- **Conflict resolution** — automatic conflict resolution (newer file wins)
- **Deletion synchronization** — deleted files are deleted on all devices
- **Flexible filters** — configurable include/exclude file patterns
- **Multi-device support** — work under one token on different devices
- **Backup system** — create ZIP backups of vault stored on Yandex Disk

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from [latest release](../../releases)
2. Create `yandex-disk-sync` folder in `<Vault>/.obsidian/plugins/`
3. Copy downloaded files to created folder
4. Restart Obsidian
5. Enable plugin in **Settings → Community plugins**

### Via BRAT (for beta testing)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add repository through BRAT

## Setup

### Getting OAuth Token

1. Go to [Yandex OAuth](https://oauth.yandex.ru/)
2. Create application with `cloud_api:disk.app_folder` or `cloud_api:disk.read` + `cloud_api:disk.write` permissions
3. Get OAuth token
4. Paste token in plugin settings

### Plugin Settings

| Parameter                     | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| **OAuth token**               | Token for Yandex Disk API access                                     |
| **Remote path**               | Path to folder on Yandex Disk (e.g., `obsidian-sync/my-vault`)       |
| **Real-time sync**            | Automatic synchronization when files are changed                    |
| **Full sync interval**        | Full synchronization interval in minutes (0 = manual only)           |
| **Sync delay**                | Delay before uploading file after change (debounce)                  |
| **Sync config folder**        | Synchronize Obsidian settings folder                                 |
| **Include/Exclude patterns**  | Glob patterns for file filtering                                     |
| **Backup**                    | Create ZIP backups of synchronized files                             |

## Commands

| Command              | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `Sync now`           | Run full synchronization manually                       |
| `Pause/Resume sync`  | Pause or resume synchronization                         |
| `Show sync status`   | Show status and statistics of last synchronization      |
| `Force upload all`   | Force upload all local files                            |
| `Force download all` | Force download all files from disk                      |

## Usage

### First Launch

On first launch, the plugin will check for files locally and on Yandex Disk:

- **If local vault is empty and disk has files** — files will be downloaded
- **If disk is empty and local has files** — files will be uploaded
- **If files exist in both places** — you will be prompted to choose synchronization strategy

### Working on Multiple Devices

1. Set up plugin on first device and perform initial synchronization
2. On second device, install plugin with same token and path
3. Plugin will automatically download files from Yandex Disk

### Conflict Resolution

When conflict occurs (file changed on multiple devices), plugin automatically selects newer version by modification time.

### Backup System

Plugin includes built-in backup system for creating ZIP archives of your vault:

- **Create backups**: Go to plugin settings → Backup section → "Create backup" button
- **Backup location**: Backups are stored in `.backup` folder on Yandex Disk
- **Backup format**: `backup_YYYY-MM-DD_HH-MM-SS.zip`
- **Content**: All synchronized files according to your include/exclude filters
- **Sync**: Last backup time is synchronized between all devices

**Note**: `.backup` folder is protected and excluded from synchronization operations.

## Development

### Requirements

- Node.js 18+
- npm

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

### Build

```bash
npm run build
```

Built files will be in `build/` folder and automatically copied to test vault.

### Linting

```bash
npm run lint
```

## Architecture

Detailed description of architecture and approaches see in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- OAuth token is stored locally in plugin settings
- Token is not logged and not transmitted to third parties
- Recommended to use token with minimal necessary permissions

## Limitations

- Maximum file size for upload: 50 MB (Yandex Disk API limitation)
- Binary file synchronization may be slower
- Symlinks synchronization is not supported

## License

MIT

## Acknowledgments

- [Obsidian](https://obsidian.md) for excellent product and API
- [Yandex Disk](https://disk.yandex.ru) for cloud storage
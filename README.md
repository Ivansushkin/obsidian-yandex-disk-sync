# Yandex Disk Sync for Obsidian

A plugin for synchronizing Obsidian notes with Yandex Disk. Allows automatic synchronization of vault between multiple devices through Yandex's cloud storage.

> **⚠️ IMPORTANT WARNINGS AND LIMITATIONS**  
> 
> **Legal Liability**  
> The author is not responsible for the safety and security of your data. Install and use the plugin at your own risk. All plugin code is open source, and you can independently verify its security.
> 
> **Data Security**  
> The OAuth token is stored locally in Obsidian settings and is not transmitted to third parties. Never share your token with the developer or other persons. It is recommended to use a token with minimal necessary permissions (`cloud_api:disk.app_folder`).
> 
> **Yandex Disk API Limitations (as of this document's writing)**  
> - **Maximum file size**: 50 GB (requires active Yandex 360 plan), for free version — 2 GB
> - **Daily limit**: 750 GB of uploads per day per account
> - **Free storage**: 5 GB (can be increased to 200 GB, 1 TB, or 3 TB with Yandex 360 plan)
> 
> **Synchronization Risks**  
> - In case of file conflicts, the newer version replaces the older one without creating copies
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
| **Full sync interval**       | Full synchronization interval in minutes (0 = manual only)     | 60                      |
| **Sync delay**               | Delay before uploading file after change (debounce)            | 5 seconds               |
| **Sync config folder**       | Synchronize Obsidian settings folder                           | Disabled (by default)   |
| **Include/Exclude patterns** | Glob patterns for file filtering                               | `*.md`, `attachments/*` |
| **Backup**                   | Create ZIP backups of synchronized files                       | Disabled (by default)   |

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

When conflict occurs (file changed on multiple devices), plugin automatically selects newer version by modification time.

> **⚠️ Warning**  
> The older version of the file will be overwritten without creating a copy. For important files, it is recommended to manually check changes before synchronization.

### Backup System

Plugin includes built-in backup system for creating ZIP archives of your vault:

- **Create backups**: Plugin settings → Backup section → "Create backup" button
- **Backup location**: Backups are stored in `.backup` folder on Yandex Disk
- **Backup format**: `backup_YYYY-MM-DD_HH-MM-SS.zip`
- **Content**: All files subject to synchronization according to filters
- **Sync**: Last backup time is synchronized between devices

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

- OAuth token is stored locally encrypted in Obsidian settings
- Token is not logged and not transmitted to third parties
- Recommended to use token with minimal necessary permissions (`cloud_api:disk.app_folder`)
- When removing the plugin, the token is **not** automatically deleted — delete it manually from Obsidian settings
- All network requests use HTTPS with certificate verification
- User data is never collected or analyzed by the plugin developer

## Limitations

- **Maximum file size**: 50 GB (requires Yandex 360 plan), free version — 2 GB
- **Free storage**: 5 GB (Yandex Disk limitation)
- **Binary file synchronization** may be slower due to API limitations
- **Symlinks synchronization is not supported** and special file attributes
- **Daily traffic limit**: 750 GB of uploads per day per account (Yandex Disk limitation)
- **Frequent API requests** may lead to temporary account blocking

## License

MIT License

Copyright (c) 2024 [Your Name]

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Acknowledgments

- [Obsidian](https://obsidian.md) for excellent product and API
- [Yandex Disk](https://disk.yandex.ru) for cloud storage
- [BRAT](https://github.com/TfTHacker/obsidian42-brat) for beta testing tool
- Obsidian community for support and inspiration

---

**Last Updated**: January 26, 2026  
**Version**: 1.0.0  
**Supported Platforms**: Windows, macOS, Linux, iOS, Android  
**Required Obsidian Version**: 1.0.0+  

> **ℹ️ Developer Note**  
> This plugin is created by the community for the community. It is not an official product of Obsidian or Yandex. All trademarks and copyrights belong to their respective owners.

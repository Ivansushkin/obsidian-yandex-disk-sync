# Yandex Disk Sync for Obsidian

[Русский](README_RU.md)

Synchronize your Obsidian vault between computers, phones and tablets through
Yandex Disk. The plugin works on Windows, macOS, Linux, iOS and Android.

> [!WARNING]
> **Use this plugin at your own risk. It does not guarantee the safety or
> preservation of your data. The author is not responsible for the safety or
> preservation of your data.** Errors or synchronization failures may cause data
> loss. Keep an independent backup of important files before using the plugin.
> Deletions propagate to other devices, and Force sync replaces destination files.
> Synchronization does not replace a backup.

**Privacy:** The plugin collects no metrics, usage analytics or telemetry. It does
not send your files, OAuth token or encryption password to the author. The author
has no access to your vault through the plugin.

**Interface languages:** English · Русский · Қазақша · Беларуская · O‘zbekcha.
The interface follows Obsidian's language. You can choose another language in
the plugin settings.

## Features

- Two-way synchronization, automatic uploads when files change and periodic full sync.
- Synchronization of deletions, with copies of displaced local content and conflict handling.
- Include/exclude filters and optional synchronization of Obsidian settings.
- ZIP backups stored on Yandex Disk.
- Force synchronization from a selected device or from the cloud.
- Optional end-to-end encryption of file contents and names.

## Installation

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/Ivansushkin/obsidian-yandex-disk-sync/releases/latest).
2. Create `<Vault>/.obsidian/plugins/yandex-disk-sync/` in your vault.
3. Copy the three files into that folder.
4. Restart Obsidian.
5. Enable **Yandex Disk Sync** in **Settings → Community plugins**.

### Preview testing with BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add
`Ivansushkin/obsidian-yandex-disk-sync` as a repository. Use BRAT to check for updates.

## First connection

1. Create a backup of your local vault.
2. Obtain a token through [Yandex OAuth](https://oauth.yandex.ru/): create an
   application with the read and write permissions needed for Yandex Disk and
   obtain its OAuth token.
3. Open the plugin settings and paste the token.
4. Choose a dedicated folder on Yandex Disk, for example `obsidian-sync/my-vault`.
   Use a separate remote folder for each vault.
5. Review the synchronization filters and whether to include Obsidian settings.
6. Run a full synchronization and wait for it to finish before connecting another device.

After changing the token or remote folder, run a successful manual full sync to
start automatic synchronization for that connection.

If the remote folder is empty, local files are uploaded. If the local vault is
empty, cloud files are downloaded. When a new device joins existing cloud data,
cloud versions are received first. Different local versions are preserved in
`.obsidian/plugins/yandex-disk-sync/overwritten/`; local-only files are kept and
uploaded after the initial receive.

To connect another device, install the plugin and use the same OAuth token and
remote folder. Run a full synchronization. For encrypted data, enter the same
encryption password when prompted.

Use the same plugin version on all devices. Older and newer builds must not work
with the same remote folder concurrently. Before upgrading an existing setup,
read the instructions accompanying the release and back up your vault.

## Everyday use

Enable real-time synchronization to upload local changes automatically. Periodic
full synchronization also checks for changes from other devices. You can run a
full sync manually whenever needed.

| Setting                   | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| Real-time sync            | Upload local changes automatically.                              |
| Full sync interval        | Set how often to check the whole vault; zero means manual only.  |
| Sync delay                | Wait briefly after an edit before uploading.                     |
| Max concurrent operations | Adjust the number of parallel file transfers and metadata reads. |
| Include/exclude patterns  | Choose which files to synchronize using glob patterns.           |
| Sync config folder        | Include Obsidian settings in synchronization.                    |

The plugin's own data and the remote `.backup` folder are protected and excluded
from synchronization.

The command palette offers full sync, pause/resume, sync status and backup
creation. Click or tap the `YD` indicator to see progress, the last successful
sync and errors. An idle indicator does not mean that changes on another device
have already reached this one.

### Conflicts and deletions

When both sides change a file, the plugin preserves a conflict copy. During
ordinary sync, a file deletion takes priority over a concurrent edit; displaced
local content is preserved before replacement or deletion. Review conflict and
protective copies before removing them.

For details, see [conflict handling](docs/CONFLICTS.md).

## Backups

Create a ZIP archive from the backup section in plugin settings or the command
palette. Archives contain files selected by the synchronization filters and are
stored in `.backup` inside the remote folder. The backup list is shared between
devices.

Encrypted archives require the password used when they were created. Downloading
one through the plugin decrypts it into a regular ZIP file. Keep independent
copies of important backups outside the synchronized storage.

See [backup documentation](docs/BACKUP.md).

## Force synchronization

Use Force only when you want to replace one side with the other:

- **Local → Disk:** replace selected cloud files with files from this device.
- **Disk → local:** replace selected local files with files from Yandex Disk.

Both directions respect include/exclude filters, the Obsidian settings switch
and protected paths. Excluded files and the running sync plugin are preserved.

> **Force replaces destination files**
>
> Check the direction and source before confirming. The confirmation dialog
> offers an archive, disabled by default. Without it, Force creates no protective
> or conflict copies. A readable empty source clears the selected destination.

An unreadable source blocks replacement. Partial failures can be retried by a
normal full sync. Other devices do not have to stop, but their late requests can
affect the result. Restart Obsidian after replacing its settings.

See [Force documentation](docs/FORCE_SYNC.md).

## Encryption

End-to-end encryption protects file contents and names on Yandex Disk. Local
vault files remain readable in Obsidian. File contents use AES-256-GCM and names
use AES-SIV.

To enable encryption, open the encryption section in plugin settings, enter and
confirm a password, then choose whether to create an archive before continuing.
Keep the password in a password manager: it cannot be recovered, and encrypted
cloud data cannot be read without it.

Enabling, disabling or changing the encryption password uses the initiating
device's local files as the reference within the sync filters. Cloud-only files
and older offline edits from other devices are not merged into that reference.
Save any needed copies separately, and do not edit the vault on any device until
the operation finishes.

See [encryption documentation](docs/E2E_ENCRYPTION.md).

## Security and limitations

- The OAuth token and encryption password are stored in plaintext in local plugin
  data. Do not share that directory or diagnostics containing secrets.
- The plugin sends synchronized data to Yandex Disk and collects no telemetry.
  The encryption password is never sent to Yandex Disk.
- Removing plugin data does not revoke the OAuth token; revoke unused tokens
  through Yandex OAuth.
- Ordinary sync does not transfer empty folders; Force does. Symlinks and special
  file attributes are not synchronized.
- Storage quotas, file-size limits and throttling depend on Yandex Disk.
- ZIP creation keeps archive files in memory; large vaults may exceed the memory
  available on a device.

For technical details and development instructions, see the
[documentation guide](docs/README.md).

## License

[MIT](LICENSE). This is a community plugin, not an official product of Obsidian
or Yandex.

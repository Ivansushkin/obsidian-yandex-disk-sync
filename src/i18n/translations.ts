/**
 * Translation dictionaries for Yandex Disk Sync plugin
 */

export type Language = "en" | "ru";

export const translations: Record<Language, Record<string, string>> = {
	en: {
		"storage.replacement": "Connect the recreated Force storage",
		"storage.replacement_description":
			"The folder at this path was recreated. A verified new canonical generation can be connected while preserving offline edits; transferring them requires a separate explicit choice.",
		"force.password_create": "Create encrypted destination",
		"force.password_description":
			"Enter the password for the selected Force operation. Cancel leaves the destination unchanged.",
		"force.source_mode_title": "Select remote source format",
		"force.source_mode_description":
			"The manifest is missing. Choose how to read the source. Encrypted reading requires the original salt/profile and a valid password; all source files are verified before replacement.",
		"force.plaintext": "Plaintext",
		"force.encrypted": "Encrypted",
		"force.backup_failed_title": "The archive could not be verified",
		"force.backup_failed_description":
			"Retry, explicitly continue without any protective copies, or cancel.",
		"force.retry": "Retry",
		"force.recovery_pending":
			"Force recovery is unfinished. Resume it before normal synchronization.",
		"force.confirm_details":
			"Source: {source}. Destination: {target}. Source files: {count}. Resulting mode: {mode}.",
		"force.empty_source":
			"The source is empty. All synchronized files in the destination will be deleted.",
		"force.epoch_title": "The remote storage was replaced",
		"force.epoch_description":
			"Your offline edits are preserved. Choose whether to accept the new remote state, transfer your edits, or decide later. Nothing is uploaded before this choice.",
		"force.epoch_accept": "Accept remote state",
		"force.epoch_preserve": "Transfer my edits",
		"force.epoch_later": "Decide later",
		"status.mobile.expand": "Expand synchronization details",
		"status.mobile.collapse": "Collapse synchronization details",
		"status.actions.copy_logs": "Copy logs",
		"status.actions.logs_copied": "Logs copied to clipboard",
		"status.actions.logs_empty": "No log entries to copy",
		"status.actions.copy_failed": "Could not copy logs to clipboard",
		"status.actions.sync_failed": "Could not start synchronization",
		"failure.stage.upload-verification": "upload result verification",
		"failure.stage.preflight": "preflight",
		"failure.stage.confirming": "confirmation",
		"failure.stage.protected-snapshot": "protected snapshot",
		"failure.stage.storage-admission": "storage verification",
		"failure.stage.startup": "startup verification",
		"failure.stage.download": "download",
		"failure.stage.upload": "upload",
		"failure.stage.delete_local": "local deletion",
		"failure.stage.delete_remote": "remote deletion",
		"failure.stage.conflict": "conflict resolution",
		"failure.stage.creating-backup": "backup creation",
		"failure.stage.uploading-backup": "backup upload",
		"failure.stage.verifying-backup": "backup verification",
		"failure.stage.protective-backup": "mandatory protective copy",
		"failure.stage.persisting": "local state persistence",
		"failure.stage.reconciling": "final reconciliation",
		"failure.stage.encryption": "encryption",
		"failure.stage.encryption-validation": "encryption verification",
		"failure.stage.encryption-rewrite": "encryption rewrite",
		"failure.stage.encryption-recovery": "encryption recovery",
		"failure.stage.physical-recovery": "pending physical actions",
		"failure.stage.backup": "backup",
		"failure.retry": "Retry {attempt}/{maxAttempts}",
		"failure.category.unavailable": "Remote temporarily unavailable",
		"failure.category.access": "Access denied",
		"failure.category.safety": "Safety condition failed",
		"failure.category.local": "Local operation failed",
		"failure.category.unknown": "Operation failed",
		"failure.stage": "Stage: {stage}",
		"failure.outcome.stopped-before-write":
			"Stopped before replacing synchronized files.",
		"failure.outcome.partial":
			"Partially completed; finalization is pending.",
		"failure.outcome.write-unconfirmed":
			"The write result needs verification.",
		"failure.outcome.unknown":
			"The operation did not complete; previous changes may have been applied.",
		"failure.next.unavailable":
			"Check the connection, then run normal synchronization.",
		"failure.next.access": "Check the token and folder permissions.",
		"failure.next.safety":
			"Check plugin status and resolve the safety block before retrying.",
		"failure.next.local":
			"Check local storage and backup access before retrying.",
		"failure.next.unknown":
			"Check plugin status and diagnostics before retrying.",
		"notice.force_phase_protected-snapshot": "Reading protected snapshot…",
		"storage.title": "Confirm synchronization storage",
		"storage.confirm_previous":
			"Is {path} your previous remote storage? Keeping history allows previous deletions to be applied to this folder. Confirm only if this is the same storage.",
		"storage.confirm_new":
			"The remote folder {path} differs from the folder associated with this synchronization history. Connect it as a new storage only after pending work has been resolved.",
		"storage.same": "This is the previous storage",
		"storage.new": "Connect different storage",
		"storage.blocked":
			"Synchronization is stopped. Check the remote folder and confirm its connection with manual synchronization. Pending operations must remain in their original storage.",
		"notice.configuration_busy":
			"The operation cannot start while synchronization, backup, or recovery work is pending.",
		"notice.force_busy": "Force synchronization is already in progress.",
		"notice.force_phase_preflight": "Checking before synchronization…",
		"notice.force_phase_confirming":
			"Waiting for Force synchronization confirmation…",
		"notice.force_phase_creating-backup": "Creating backup…",
		"notice.force_phase_uploading-backup": "Uploading backup…",
		"notice.force_phase_verifying-backup": "Verifying backup…",
		"notice.force_phase_syncing": "Force synchronization",
		"notice.force_phase_persisting": "Saving synchronization state…",
		"notice.force_phase_reconciling": "Final synchronization check",
		"notice.force_migration_completed":
			"Upgrade to 2.0.0 completed. Synchronization finished.",
		"notice.force_backup_failed":
			"Backup could not be verified. Force synchronization was not started.",
		"notice.force_finalization_pending":
			"The new snapshot is saved, but synchronization needs another check. Run normal synchronization; do not repeat Force.",
		"notice.force_flow_failed":
			"Force synchronization was interrupted. Check the connection and plugin status before starting a new attempt. Files already transferred may have changed.",
		// Commands
		"command.sync_now": "Sync with Yandex Disk now",
		"command.toggle_sync": "Pause/Resume synchronization",
		"command.show_status": "Show synchronization status",

		// Status bar
		"status.syncing": "Syncing...",
		"status.error": "Error",
		"status.paused": "Paused",
		"status.offline": "Offline",
		"status.initializing": "Initializing...",
		"status.encryption_required": "YD: Encryption password required",
		"status.migration_required": "YD: Migration required",
		"status.last_sync": "YD: {time}",
		"status.ready_full": "YD: Ready",
		"status.mobile.ready": "YD: Ready to synchronize",
		"status.mobile.last_sync": "YD: Last synchronization",
		"status.mobile.paused": "Synchronization paused",
		"status.mobile.error": "Synchronization error",
		"status.mobile.encryption": "Encryption operation...",
		"status.mobile.backup": "Creating backup...",

		// Status bar tooltips
		"status.tooltip.idle": "Status: Ready for synchronization",
		"status.tooltip.syncing": "Status: Synchronizing...",
		"status.tooltip.syncing_current": "Operation: {operation}",
		"status.tooltip.session": "Session: {session}",
		"status.tooltip.progress": "Progress: {completed}/{total}",
		"status.tooltip.started": "Started: {datetime}",
		"status.tooltip.error": "Status: Error",
		"status.tooltip.error_details": "Error: {message}",
		"status.tooltip.paused": "Status: Paused",
		"status.tooltip.offline": "Status: No connection",
		"status.tooltip.initializing": "Status: Initializing...",
		"status.tooltip.encryption_required":
			"Status: Synchronization is blocked until encryption password is entered",
		"status.tooltip.migration_required":
			"Status: Stable 1.1 data requires a verified Force migration",
		"status.tooltip.last_sync": "Last synchronization: {datetime}",
		"status.session.full": "Full sync",
		"status.session.force": "Force sync",
		"status.session.realtime": "Realtime sync",
		"status.session.maintenance": "Encryption maintenance",

		// Operation statuses
		"status.op.preparing_local": "Preparing local changes...",
		"status.op.queued": "Waiting for synchronization queue...",
		"status.op.validating": "Checking synchronization state...",
		"status.op.checking_remote_folder": "Checking remote folder...",
		"status.op.loading_remote_index": "Loading remote index...",
		"status.op.scanning_local_files": "Scanning local files...",
		"status.op.getting_remote_files": "Getting remote files list...",
		"status.op.analyzing_changes": "Analyzing changes...",
		"status.op.creating_folders": "Creating folders...",
		"status.op.uploading_files": "Uploading files...",
		"status.op.downloading_files": "Downloading files...",
		"status.op.deleting_files": "Deleting files...",
		"status.op.deleting_remote_files": "Deleting remote files...",
		"status.op.deleting_local_files": "Deleting local files...",
		"status.op.resolving_conflicts": "Resolving conflicts...",
		"status.op.saving_indexes": "Saving indexes...",
		"status.op.applying_changes": "Applying changes...",
		"status.op.applying_realtime": "Synchronizing local changes...",
		"status.op.renaming_file": "Moving file...",
		"status.op.reencoding_files": "Re-encoding files...",
		"status.op.cleanup": "Cleaning up old data...",
		"status.op.finalizing": "Finalizing synchronization...",
		"status.error_count": "Errors: {errors}",
		"status.op.conflict": "Conflict: {path}",

		// Notices
		"notice.sync_started": "Synchronization started...",
		"notice.sync_progress": "Synchronization: {operation}",
		"notice.sync_no_changes": "Synchronization completed: no changes",
		"notice.sync_exception": "Synchronization failed: {message}",
		"notice.force_sync_exception": "Force sync failed: {message}",
		"notice.force_backup_stale":
			"Force sync stopped because the canonical or protected data changed after preflight. Start a new attempt and choose the archive option again.",
		"notice.force_source_changed":
			"Force sync stopped because the selected source changed during the operation. Start a new attempt and choose the archive option again.",
		"notice.force_cleanup_pending":
			"The replacement snapshot is committed. Cleanup is incomplete and will resume during normal synchronization; do not repeat Force sync.",
		"notice.remote_recheck_required":
			"Token or remote path changed. Remote state must be checked again before synchronization.",
		"notice.remote_state_check_failed":
			"Remote state could not be checked. Synchronization remains blocked without remote changes.",
		"settings.migration_features_locked":
			"Encryption and current-only settings stay locked until the stable 1.1 migration has completed.",
		"notice.legacy_plugin_data_exposure":
			"Stable 1.1 may have copied this plugin's local settings to Yandex Disk. Remove the remote plugin directory and replace the OAuth token before migration.",
		"notice.legacy_token_rotation_required":
			"The exposed remote plugin directory is no longer present, but migration remains blocked until the OAuth token is replaced in settings.",
		"notice.legacy_service_collision":
			"A stable 1.1 user path conflicts with a current service name or path rule. Rename it before migration.",
		"notice.unsupported_historical_data":
			"Synchronization is blocked because unsupported historical data was detected. Use a clean remote path or reset the old data manually after creating an independent backup.",
		"notice.encryption_transition_error":
			"Encryption operation failed: {message}",
		"notice.legacy_index_blocked":
			"This plugin version detected a stable 1.x synchronization index. Update every device, choose the archive option and run Force sync once on the authoritative device to create the current canonical index.",
		"notice.unreadable_index_blocked":
			"The remote sync index cannot be decoded. Normal sync is blocked to protect your data. Use Force sync and choose the archive option to select the authoritative side.",
		"notice.invalid_index_blocked":
			"The current remote sync index has an invalid structure. Normal sync is blocked without changing remote data. Use Force sync and choose the archive option to select the authoritative side.",
		"notice.epoch_adopted":
			"The new remote snapshot was accepted and local changes were merged.",
		"notice.epoch_adopted_conflicts":
			"The new remote snapshot was accepted; local changes were merged with {conflicts} conflict copies.",
		"notice.ambiguous_index_blocked":
			"Several index locks were found. Normal sync is blocked; use Force sync and choose the archive option to choose the authoritative side.",
		"notice.sync_completed":
			"Synchronization completed! ({successful} operations)",
		"notice.sync_error": "Synchronization completed with errors: {errors}",
		"notice.sync_paused": "Synchronization paused",
		"notice.sync_resumed": "Synchronization resumed",
		"notice.token_invalid": "Error: invalid Yandex Disk token",
		"notice.token_missing":
			"Please configure Yandex Disk token in plugin settings",
		"notice.backup_started": "Creating backup...",
		"notice.backup_completed": "Backup created: {name}",

		// Modal titles
		"modal.status_title": "Synchronization status",

		// Modal descriptions
		"modal.operation_backup_title": "Backup before encryption change",
		"modal.operation_backup_description":
			"Create an optional full archive before continuing. Existing file conflict protection remains active.",
		"modal.continue_without_backup": "Continue without backup",
		"modal.cancel_button": "Cancel",
		"modal.force_sync_legacy_devices_title":
			"All stable 1.1 clients are stopped",
		"modal.force_sync_legacy_devices_desc":
			"Confirm that Obsidian with plugin 1.1 is disabled on every other device before Force migration.",
		"modal.close_button": "Close",
		"modal.status_no_sync": "Synchronization has not been performed yet",
		"modal.status_uploaded": "Uploaded: {count}",
		"modal.status_downloaded": "Downloaded: {count}",
		"modal.status_deleted": "Deleted: {count}",
		"modal.status_errors": "Errors: {count}",
		"modal.log_viewer_title": "Debug logs",
		"modal.log_viewer_label": "Log contents",
		"modal.log_viewer_desc": "Recent log entries for troubleshooting",
		"modal.log_viewer_refresh": "Refresh",
		"modal.log_viewer_copy": "Copy to clipboard",
		"modal.log_viewer_clear": "Clear logs",

		// Settings
		"settings.connection_section": "Connection",
		"settings.oauth_instruction_1": "1. Click 'Manage clients'",
		"settings.oauth_instruction_2":
			"2. Create and open a new Yandex OAuth app",
		"settings.oauth_instruction_3":
			"3. Copy Client ID from the app settings",
		"settings.oauth_instruction_4": "4. Paste Client ID in the input below",
		"settings.oauth_instruction_5": "5. Click 'Get token'",
		"settings.oauth_instruction_6":
			"6. Copy the received token and paste it in the input below",
		"settings.oauth_instruction_7": "7. Click 'Synchronize'",
		"settings.manage_clients": "Manage clients",
		"settings.get_token": "Get token",
		"settings.client_id": "Client ID",
		"settings.client_id_placeholder": "Enter Client ID",
		"settings.oauth_token": "OAuth token",
		"settings.oauth_token_placeholder": "Enter token",
		"settings.remote_path": "Remote path",
		"settings.remote_path_desc":
			"Folder on Yandex Disk for storing synchronized files",
		"settings.remote_path_placeholder": "obsidian-sync/my-vault",
		"settings.automatic_sync_section": "Automatic sync",
		"settings.realtime_sync": "Real-time sync",
		"settings.realtime_sync_desc":
			"Automatically sync files when they are created, modified, or deleted",
		"settings.full_sync_interval": "Full sync interval (minutes)",
		"settings.full_sync_interval_desc":
			"How often to perform full sync. 0 = manual only",
		"settings.sync_delay": "Sync delay (ms)",
		"settings.sync_delay_desc":
			"Time to wait after last change before uploading file",
		"settings.max_concurrency": "Max concurrent operations",
		"settings.max_concurrency_desc":
			"Number of files to sync simultaneously (1-20). Higher values = faster sync, but more API load",
		"settings.file_filters_section": "File filters",
		"settings.sync_config_folder": "Sync config folder",
		"settings.sync_config_folder_desc":
			"Include Obsidian settings, themes and plugins in sync",
		"settings.include_patterns": "Include patterns",
		"settings.include_patterns_desc":
			"Glob patterns for files to sync (one per line)",
		"settings.include_patterns_placeholder": "**/*",
		"settings.exclude_patterns": "Exclude patterns",
		"settings.exclude_patterns_desc":
			"Glob patterns for files to exclude from sync (one per line)",
		"settings.exclude_patterns_placeholder": "workspace*",
		"settings.logging_section": "Logging",
		"settings.enable_debug_logging": "Enable debug logging",
		"settings.enable_debug_logging_desc":
			"Log detailed debug information to console and file",
		"settings.log_to_file": "Write logs to file",
		"settings.log_to_file_desc":
			"Save logs to the plugin data folder for troubleshooting",
		"settings.view_logs_button": "View logs",
		"settings.clear_logs_button": "Clear logs",
		"settings.information_section": "Information",
		"settings.device_id": "Device ID",
		"settings.device_id_desc": "Unique identifier for this device",
		"settings.sync_button": "Synchronize",
		"settings.syncing_button": "Syncing...",
		"settings.backup_section": "Backup",
		"settings.backup_desc":
			"Backup will be saved as a ZIP archive in the .backup folder on disk",
		"settings.backup_never": "Never",
		"settings.backup_unavailable": "Backup status unavailable",
		"settings.backup_button": "Create backup",
		"settings.backup_show_all": "Show all backups",
		"settings.backup_in_progress": "Creating...",
		"settings.backup_success": "Backup created!",
		"settings.backup_error": "Backup failed",

		// Backup list modal
		"backup_list.title": "Available backups",
		"backup_list.loading": "Loading backups...",
		"backup_list.no_backups": "No backups found",
		"backup_list.date": "Date",
		"backup_list.size": "Size",
		"backup_list.actions": "Actions",
		"backup_list.download": "Download",

		// Backup download notices
		"notice.backup_download_started": "Downloading backup...",
		"notice.backup_download_completed": "Backup downloaded: {name}",
		"notice.backup_download_failed": "Failed to download backup",
		"notice.backup_list_load_failed": "Failed to load backup list",
		"notice.logs_cleared": "Logs cleared",

		// Generic strings
		// Encryption
		"settings.encryption_section": "Encryption",
		"settings.encryption_desc":
			"Enable end-to-end encryption for files on Yandex Disk",
		"settings.encryption_status_active": "Encryption active",
		"settings.encryption_change_password": "Change password",
		"modal.encryption_enable_title": "Enable encryption",
		"modal.encryption_enable_warning":
			"Enabling encryption will overwrite ALL files on Yandex Disk with encrypted versions. If you lose your password, access to your data will be permanently lost.",
		"modal.encryption_password_label": "Password",
		"modal.encryption_confirm_label": "Confirm password",
		"modal.encryption_password_mismatch": "Passwords do not match",
		"modal.encryption_enter_password": "Enter encryption password",
		"modal.encryption_disable_title": "Disable encryption",
		"modal.encryption_change_password_title": "Change encryption password",
		"modal.encryption_enter_current_password":
			"Enter current encryption password",
		"modal.encryption_change_password_button": "Change password",
		"modal.encryption_disable_warning":
			"Disabling encryption will re-upload all files to Yandex Disk as plaintext and remove the remote encryption marker.",
		"modal.encryption_connect_title": "Connect encrypted vault",
		"modal.encryption_connect_desc":
			"Encryption was enabled on another device. Enter the same encryption password to connect this device. Synchronization is stopped until the password is entered.",
		"modal.encryption_rotated_title": "Encryption password changed",
		"modal.encryption_rotated_desc":
			"The encryption password was changed on another device. Enter the new password to continue synchronization on this device.",
		"modal.encryption_recovery_title": "Complete encryption maintenance",
		"modal.encryption_recovery_desc":
			"Another device committed an encryption change. Enter the password for the transitional manifest to verify it and finish guarded recovery.",
		"modal.encryption_connect_button": "Connect",
		"modal.backup_password_title": "Open encrypted backup",
		"modal.backup_password_desc":
			"Enter the password used when this backup was created.",
		"modal.backup_password_button": "Open backup",
		"modal.encryption_connect_privacy":
			"The password is stored only on this device and is never sent to Yandex Disk.",
		"notice.encryption_enabled":
			"Encryption enabled. All files encrypted and synced.",
		"settings.encryption_info_title": "About encryption",
		"settings.encryption_info_how":
			"Hardened encryption uses PBKDF2 (600,000 iterations), HKDF-separated keys, AES-256-GCM file content, and deterministic AES-SIV filenames.",
		"settings.encryption_info_warning":
			"Warning: If you lose your password, encrypted files cannot be decrypted. There is no password recovery mechanism.",
		"settings.encryption_info_password":
			"The password is stored locally in plugin settings and is never sent to remote storage.",
		"notice.encryption_syncing":
			"Encryption enabled. Re-uploading files...",
		"notice.encryption_disabling":
			"Disabling encryption. Re-uploading files as plaintext...",
		"notice.encryption_disabled": "Encryption disabled",
		"notice.encryption_disabled_remotely":
			"Encryption was disabled on another device. Switched to plaintext mode.",
		"notice.encryption_wrong_password":
			"Wrong password. Files may appear corrupted.",
		"notice.encryption_password_required":
			"Encrypted vault detected. Enter the encryption password on this device to continue synchronization.",
		"notice.encryption_remote_busy":
			"Encryption setup is running on another device. Wait until it finishes and try again.",
		"notice.encryption_remote_missing":
			"Remote encryption marker is missing. Synchronization is blocked to prevent data corruption.",
		"notice.encryption_password_changed_remote":
			"Encryption password was changed on another device. Enter the new password to continue synchronization.",
		"notice.encryption_state_check_failed":
			"Failed to check remote encryption state: {error}",
		"notice.encryption_state_changed":
			"Remote encryption state changed during synchronization. The current session was stopped safely.",
		"notice.encryption_sync_failed":
			"Encryption sync failed with {errors} errors",
		"notice.encryption_disable_partial":
			"Encryption disabled with some errors. Please verify files on disk and locally — some remote API requests failed. If everything looks OK, run a manual sync to ensure full consistency.",
		"notice.encryption_connected":
			"Encrypted vault connected on this device",
		"notice.encryption_password_rotating":
			"Changing encryption password. Re-uploading encrypted files...",
		"notice.encryption_password_changed":
			"Encryption password changed. Other devices will ask for the new password.",
		"modal.encryption_enable_with_backup": "Continue",

		"generic.yes": "Yes",
		"generic.confirm": "Confirm",

		// Force sync
		"settings.force_sync_section": "Force Sync",
		"settings.force_sync_desc":
			"Force synchronization ignores all conditions (timestamps, file hashes, indexes). Creates an exact copy in the specified direction.",
		"settings.force_sync_from_local_button": "Sync from local → remote",
		"settings.force_sync_from_remote_button": "Sync from remote → local",
		"modal.force_sync_title": "Force sync confirmation",
		"modal.force_sync_from_local_text":
			"This operation will overwrite ALL files on Yandex Disk with local versions. Files that exist only on Yandex Disk will be permanently deleted.",
		"modal.force_sync_from_remote_text":
			"This operation will overwrite ALL local files with versions from Yandex Disk. Local files that do not exist on Yandex Disk will be permanently deleted.",
		"modal.force_sync_warning":
			"WARNING: This operation is destructive and cannot be undone. Changes made after the sync on the overwritten side may be lost.",
		"modal.force_sync_recommend_backup":
			"Choose a full archive or continue without one. Snapshot and file protection checks remain active.",
		"modal.force_sync_backup_button": "Create backup and proceed",
		"notice.force_sync_from_local_started":
			"Forcing sync from local to remote...",
		"notice.force_sync_from_remote_started":
			"Forcing sync from remote to local...",
		"notice.force_sync_completed":
			"Force sync completed! ({successful} operations)",
	},
	ru: {
		"storage.replacement": "Подключить пересозданное Force-хранилище",
		"storage.replacement_description":
			"Папка по этому пути пересоздана. Проверенное новое поколение можно подключить с сохранением офлайн-правок; их отправка потребует отдельного явного выбора.",
		"force.password_create": "Создание зашифрованного назначения",
		"force.password_description":
			"Введите пароль для выбранной операции Force. Отмена сохраняет назначение без изменений.",
		"force.source_mode_title": "Выберите формат источника на Диске",
		"force.source_mode_description":
			"Manifest отсутствует. Укажите формат чтения источника. Для шифрования нужны исходные salt/profile и верный пароль; все файлы проверяются до замены назначения.",
		"force.plaintext": "Без шифрования",
		"force.encrypted": "С шифрованием",
		"force.backup_failed_title": "Архив не прошёл проверку",
		"force.backup_failed_description":
			"Повторите попытку, явно продолжите без любых защитных копий или отмените операцию.",
		"force.retry": "Повторить",
		"force.recovery_pending":
			"Восстановление Force не завершено. Продолжите его перед обычной синхронизацией.",
		"force.confirm_details":
			"Источник: {source}. Назначение: {target}. Файлов в источнике: {count}. Итоговый режим: {mode}.",
		"force.empty_source":
			"Источник пуст. Все синхронизируемые файлы назначения будут удалены.",
		"force.epoch_title": "Хранилище на Диске заменено",
		"force.epoch_description":
			"Ваши офлайн-правки сохранены. Выберите: принять новое состояние Диска, перенести свои правки или решить позже. До выбора ничего не отправляется.",
		"force.epoch_accept": "Принять состояние Диска",
		"force.epoch_preserve": "Перенести мои правки",
		"force.epoch_later": "Решить позже",
		"status.mobile.expand": "Развернуть подробности синхронизации",
		"status.mobile.collapse": "Свернуть подробности синхронизации",
		"status.actions.copy_logs": "Копировать логи",
		"status.actions.logs_copied": "Логи скопированы в буфер обмена",
		"status.actions.logs_empty": "Нет записей для копирования",
		"status.actions.copy_failed":
			"Не удалось скопировать логи в буфер обмена",
		"status.actions.sync_failed": "Не удалось запустить синхронизацию",
		"failure.stage.upload-verification": "проверка результата загрузки",
		"failure.stage.preflight": "предварительная проверка",
		"failure.stage.confirming": "подтверждение",
		"failure.stage.protected-snapshot": "защищаемый снимок",
		"failure.stage.storage-admission": "проверка хранилища",
		"failure.stage.startup": "проверка при запуске",
		"failure.stage.download": "скачивание",
		"failure.stage.upload": "загрузка на Диск",
		"failure.stage.delete_local": "локальное удаление",
		"failure.stage.delete_remote": "удаление на Диске",
		"failure.stage.conflict": "разрешение конфликта",
		"failure.stage.creating-backup": "создание резервной копии",
		"failure.stage.uploading-backup": "загрузка резервной копии",
		"failure.stage.verifying-backup": "проверка резервной копии",
		"failure.stage.protective-backup": "обязательная защитная копия",
		"failure.stage.persisting": "сохранение локального состояния",
		"failure.stage.reconciling": "финальная сверка",
		"failure.stage.encryption": "шифрование",
		"failure.stage.encryption-validation": "проверка шифрования",
		"failure.stage.encryption-rewrite": "перекодирование",
		"failure.stage.encryption-recovery": "восстановление шифрования",
		"failure.stage.physical-recovery": "незавершённые физические операции",
		"failure.stage.backup": "резервная копия",
		"failure.retry": "Повтор {attempt}/{maxAttempts}",
		"failure.category.unavailable":
			"Удалённое хранилище временно недоступно",
		"failure.category.access": "Доступ запрещён",
		"failure.category.safety": "Не выполнено условие безопасности",
		"failure.category.local": "Ошибка локальной операции",
		"failure.category.unknown": "Ошибка операции",
		"failure.stage": "Этап: {stage}",
		"failure.outcome.stopped-before-write":
			"Остановлено до перезаписи синхронизируемых файлов.",
		"failure.outcome.partial":
			"Частично выполнено; требуется завершение операции.",
		"failure.outcome.write-unconfirmed":
			"Результат записи требует проверки.",
		"failure.outcome.unknown":
			"Операция не завершена; предыдущие изменения могли примениться.",
		"failure.next.unavailable":
			"Проверьте соединение и запустите обычную синхронизацию.",
		"failure.next.access": "Проверьте токен и права доступа к папке.",
		"failure.next.safety":
			"Проверьте статус плагина и устраните блокировку перед повтором.",
		"failure.next.local":
			"Проверьте локальное хранилище и доступ к резервным копиям.",
		"failure.next.unknown":
			"Проверьте статус плагина и диагностику перед повтором.",
		"notice.force_phase_protected-snapshot": "Чтение защищаемого снимка…",
		"storage.title": "Подтвердите хранилище синхронизации",
		"storage.confirm_previous":
			"{path} — ваше прежнее удалённое хранилище? Сохранение истории разрешит применение прежних удалений к этой папке. Подтверждайте только для того же хранилища.",
		"storage.confirm_new":
			"Удалённая папка {path} отличается от папки, связанной с историей синхронизации. Подключить её как новое хранилище можно после завершения ожидающих операций.",
		"storage.same": "Это прежнее хранилище",
		"storage.new": "Подключаю другое хранилище",
		"storage.blocked":
			"Синхронизация остановлена. Проверьте удалённую папку и подтвердите подключение ручной синхронизацией. Ожидающие операции должны оставаться в исходном хранилище.",
		"notice.configuration_busy":
			"Операция недоступна, пока не завершены синхронизация, архивирование или восстановление.",
		"notice.force_busy": "Принудительная синхронизация уже выполняется.",
		"notice.force_phase_preflight": "Проверка перед синхронизацией…",
		"notice.force_phase_confirming":
			"Ожидание подтверждения принудительной синхронизации…",
		"notice.force_phase_creating-backup": "Создание резервной копии…",
		"notice.force_phase_uploading-backup": "Загрузка резервной копии…",
		"notice.force_phase_verifying-backup": "Проверка резервной копии…",
		"notice.force_phase_syncing": "Принудительная синхронизация",
		"notice.force_phase_persisting": "Сохранение состояния синхронизации…",
		"notice.force_phase_reconciling": "Завершающая проверка синхронизации",
		"notice.force_migration_completed":
			"Переход на 2.0.0 завершён. Синхронизация выполнена.",
		"notice.force_backup_failed":
			"Резервная копия не подтверждена. Принудительная синхронизация не запущена.",
		"notice.force_finalization_pending":
			"Новый снимок сохранён, но завершение синхронизации требует повторной проверки. Запустите обычную синхронизацию; повторять Force не нужно.",
		"notice.force_flow_failed":
			"Принудительная синхронизация прервана. Проверьте соединение и статус плагина перед новым запуском. Уже переданные файлы могли измениться.",
		// Commands
		"command.sync_now": "Синхронизировать с Яндекс Диском сейчас",
		"command.toggle_sync": "Приостановить/возобновить синхронизацию",
		"command.show_status": "Показать статус синхронизации",

		// Status bar
		"status.syncing": "Синхронизация...",
		"status.error": "Ошибка",
		"status.paused": "Пауза",
		"status.offline": "Офлайн",
		"status.initializing": "Инициализация...",
		"status.encryption_required": "YD: Требуется пароль шифрования",
		"status.migration_required": "YD: Требуется миграция",
		"status.last_sync": "YD: {time}",
		"status.ready_full": "YD: Готов",
		"status.mobile.ready": "YD: Готов к синхронизации",
		"status.mobile.last_sync": "YD: Последняя синхронизация",
		"status.mobile.paused": "Синхронизация приостановлена",
		"status.mobile.error": "Ошибка синхронизации",
		"status.mobile.encryption": "Операция шифрования...",
		"status.mobile.backup": "Создание резервной копии...",

		// Status bar tooltips
		"status.tooltip.idle": "Статус: Готов к синхронизации",
		"status.tooltip.syncing": "Статус: Синхронизация...",
		"status.tooltip.syncing_current": "Операция: {operation}",
		"status.tooltip.session": "Сессия: {session}",
		"status.tooltip.progress": "Прогресс: {completed}/{total}",
		"status.tooltip.started": "Начало: {datetime}",
		"status.tooltip.error": "Статус: Ошибка",
		"status.tooltip.error_details": "Ошибка: {message}",
		"status.tooltip.paused": "Статус: Приостановлено",
		"status.tooltip.offline": "Статус: Нет подключения",
		"status.tooltip.initializing": "Статус: Инициализация...",
		"status.tooltip.encryption_required":
			"Статус: Синхронизация заблокирована до ввода пароля шифрования",
		"status.tooltip.migration_required":
			"Статус: Данные stable 1.1 требуют подтверждённой Force-миграции",
		"status.tooltip.last_sync": "Последняя синхронизация: {datetime}",
		"status.session.full": "Полная синхронизация",
		"status.session.force": "Принудительная синхронизация",
		"status.session.realtime": "Синхронизация изменений",
		"status.session.maintenance": "Обслуживание шифрования",

		// Operation statuses
		"status.op.preparing_local": "Подготовка локальных изменений...",
		"status.op.queued": "Ожидание очереди синхронизации...",
		"status.op.validating": "Проверка состояния синхронизации...",
		"status.op.checking_remote_folder": "Проверка удалённой папки...",
		"status.op.loading_remote_index": "Загрузка удалённого индекса...",
		"status.op.scanning_local_files": "Сканирование локальных файлов...",
		"status.op.getting_remote_files":
			"Получение списка удалённых файлов...",
		"status.op.analyzing_changes": "Анализ изменений...",
		"status.op.creating_folders": "Создание папок...",
		"status.op.uploading_files": "Загрузка файлов...",
		"status.op.downloading_files": "Скачивание файлов...",
		"status.op.deleting_files": "Удаление файлов...",
		"status.op.deleting_remote_files": "Удаление удалённых файлов...",
		"status.op.deleting_local_files": "Удаление локальных файлов...",
		"status.op.resolving_conflicts": "Разрешение конфликтов...",
		"status.op.saving_indexes": "Сохранение индексов...",
		"status.op.applying_changes": "Применение изменений...",
		"status.op.applying_realtime": "Синхронизация локальных изменений...",
		"status.op.renaming_file": "Перемещение файла...",
		"status.op.reencoding_files": "Перекодирование файлов...",
		"status.op.cleanup": "Очистка старых данных...",
		"status.op.finalizing": "Завершение синхронизации...",
		"status.error_count": "Ошибок: {errors}",
		"status.op.conflict": "Конфликт: {path}",

		// Notices
		"notice.sync_started": "Запуск синхронизации...",
		"notice.sync_progress": "Синхронизация: {operation}",
		"notice.sync_no_changes": "Синхронизация завершена: изменений нет",
		"notice.sync_exception": "Ошибка синхронизации: {message}",
		"notice.force_sync_exception":
			"Ошибка принудительной синхронизации: {message}",
		"notice.force_backup_stale":
			"Force sync остановлен: canonical или защищаемые данные изменились после предварительной проверки. Запустите новую попытку и снова выберите вариант архива.",
		"notice.force_source_changed":
			"Force sync остановлен: выбранный источник изменился во время операции. Запустите новую попытку и снова выберите вариант архива.",
		"notice.force_cleanup_pending":
			"Новое состояние уже зафиксировано. Очистка не завершена и продолжится обычной синхронизацией; не повторяйте Force sync.",
		"notice.remote_recheck_required":
			"Токен или удалённый путь изменился. Перед синхронизацией нужно заново проверить удалённое состояние.",
		"notice.remote_state_check_failed":
			"Удалённое состояние не удалось проверить. Синхронизация остаётся заблокированной без изменений на диске.",
		"settings.migration_features_locked":
			"Шифрование и настройки только для текущего формата заблокированы до завершения миграции stable 1.1.",
		"notice.legacy_plugin_data_exposure":
			"Stable 1.1 могла скопировать локальные настройки плагина на Яндекс Диск. Удалите удалённую директорию плагина и замените OAuth-токен до миграции.",
		"notice.legacy_token_rotation_required":
			"Удалённой директории плагина больше нет, но миграция остаётся заблокированной, пока OAuth-токен не будет заменён в настройках.",
		"notice.legacy_service_collision":
			"Пользовательский путь stable 1.1 конфликтует с текущим служебным именем или правилом пути. Переименуйте его до миграции.",
		"notice.unsupported_historical_data":
			"Синхронизация заблокирована: обнаружены неподдерживаемые исторические данные. Выберите чистый удалённый каталог или вручную сбросьте старые данные после создания независимого бекапа.",
		"notice.encryption_transition_error":
			"Ошибка операции шифрования: {message}",
		"notice.legacy_index_blocked":
			"Текущая версия плагина обнаружила индекс синхронизации stable 1.x. Обновите все устройства, выберите вариант архива и один раз выполните Force sync на авторитетном устройстве, чтобы создать текущий canonical index.",
		"notice.unreadable_index_blocked":
			"Удалённый индекс синхронизации не удалось декодировать. Обычная синхронизация заблокирована для защиты данных. Создайте резервную копию и выберите авторитетную сторону через Force sync.",
		"notice.invalid_index_blocked":
			"Текущий удалённый индекс синхронизации имеет недопустимую структуру. Обычная синхронизация заблокирована без изменения удалённых данных. Создайте резервную копию и выберите авторитетную сторону через Force sync.",
		"notice.epoch_adopted":
			"Новое удалённое состояние принято, локальные изменения объединены.",
		"notice.epoch_adopted_conflicts":
			"Новое удалённое состояние принято; локальные изменения объединены, создано конфликтных копий: {conflicts}.",
		"notice.ambiguous_index_blocked":
			"Обнаружено несколько lock-файлов индекса. Обычная синхронизация заблокирована; выберите авторитетную сторону и вариант архива через Force sync.",
		"notice.sync_completed":
			"Синхронизация завершена! ({successful} операций)",
		"notice.sync_error": "Синхронизация завершена с ошибками: {errors}",
		"notice.sync_paused": "Синхронизация приостановлена",
		"notice.sync_resumed": "Синхронизация возобновлена",
		"notice.token_invalid": "Ошибка: неверный токен Яндекс Диска",
		"notice.token_missing":
			"Настройте токен Яндекс Диска в настройках плагина",
		"notice.backup_started": "Создание бекапа...",
		"notice.backup_completed": "Бекап создан: {name}",

		// Modal titles
		"modal.status_title": "Статус синхронизации",

		// Modal descriptions
		"modal.operation_backup_title": "Архив перед изменением шифрования",
		"modal.operation_backup_description":
			"Можно создать полный архив перед продолжением. Существующая защита файлов при конфликтах остаётся включённой.",
		"modal.continue_without_backup": "Продолжить без архива",
		"modal.cancel_button": "Отмена",
		"modal.force_sync_legacy_devices_title":
			"Все клиенты stable 1.1 остановлены",
		"modal.force_sync_legacy_devices_desc":
			"Подтвердите, что Obsidian с плагином 1.1 отключён на всех остальных устройствах до Force-миграции.",
		"modal.close_button": "Закрыть",
		"modal.status_no_sync": "Синхронизация ещё не выполнялась",
		"modal.status_uploaded": "Загружено: {count}",
		"modal.status_downloaded": "Скачано: {count}",
		"modal.status_deleted": "Удалено: {count}",
		"modal.status_errors": "Ошибок: {count}",
		"modal.log_viewer_title": "Отладочные логи",
		"modal.log_viewer_label": "Содержимое логов",
		"modal.log_viewer_desc":
			"Последние записи логов для диагностики проблем",
		"modal.log_viewer_refresh": "Обновить",
		"modal.log_viewer_copy": "Копировать в буфер",
		"modal.log_viewer_clear": "Очистить логи",

		// Settings
		"settings.connection_section": "Подключение",
		"settings.oauth_instruction_1": "1. Нажмите 'Управление клиентами'",
		"settings.oauth_instruction_2":
			"2. Создайте и откройте новое приложение Yandex OAuth",
		"settings.oauth_instruction_3":
			"3. Скопируйте Client ID из настроек приложения",
		"settings.oauth_instruction_4": "4. Вставьте Client ID в инпут ниже",
		"settings.oauth_instruction_5": "5. Нажмите 'Получить токен'",
		"settings.oauth_instruction_6":
			"6. Скопируйте полученный токен и вставьте его в инпут ниже",
		"settings.oauth_instruction_7": "7. Нажмите на Синхронизировать",
		"settings.manage_clients": "Управление клиентами",
		"settings.get_token": "Получить токен",
		"settings.client_id": "Client ID",
		"settings.client_id_placeholder": "Введите Client ID",
		"settings.oauth_token": "OAuth токен",
		"settings.oauth_token_placeholder": "Введите токен",
		"settings.remote_path": "Путь на диске",
		"settings.remote_path_desc":
			"Папка на Яandex Disk для хранения синхронизируемых файлов",
		"settings.remote_path_placeholder": "obsidian-sync/my-vault",
		"settings.automatic_sync_section": "Автоматическая синхронизация",
		"settings.realtime_sync": "Реал-тайм синхронизация",
		"settings.realtime_sync_desc":
			"Автоматическая синхронизация файлов при их создании, изменении или удалении",
		"settings.full_sync_interval": "Интервал полной синхронизации (минуты)",
		"settings.full_sync_interval_desc":
			"Как часто выполнять полную синхронизацию. 0 = только вручную",
		"settings.sync_delay": "Задержка синхронизации (мс)",
		"settings.sync_delay_desc":
			"Время ожидания после последнего изменения перед загрузкой файла",
		"settings.max_concurrency": "Макс. параллельных операций",
		"settings.max_concurrency_desc":
			"Количество файлов для синхронизации одновременно (1-20). Больше = быстрее, но выше нагрузка на API",
		"settings.file_filters_section": "Фильтры файлов",
		"settings.sync_config_folder": "Синхронизировать папку настроек",
		"settings.sync_config_folder_desc":
			"Включить настройки Obsidian, темы и плагины в синхронизацию",
		"settings.include_patterns": "Паттерны включения",
		"settings.include_patterns_desc":
			"Glob паттерны для синхронизируемых файлов (по одному на строку)",
		"settings.include_patterns_placeholder": "**/*",
		"settings.exclude_patterns": "Паттерны исключения",
		"settings.exclude_patterns_desc":
			"Glob паттерны для исключения файлов из синхронизации (по одному на строку)",
		"settings.exclude_patterns_placeholder": "workspace*",
		"settings.logging_section": "Логирование",
		"settings.enable_debug_logging": "Включить отладочное логирование",
		"settings.enable_debug_logging_desc":
			"Записывать подробную отладочную информацию в консоль и файл",
		"settings.log_to_file": "Писать логи в файл",
		"settings.log_to_file_desc":
			"Сохранять логи в папку данных плагина для диагностики",
		"settings.view_logs_button": "Посмотреть логи",
		"settings.clear_logs_button": "Очистить логи",
		"settings.information_section": "Информация",
		"settings.device_id": "ID устройства",
		"settings.device_id_desc": "Уникальный идентификатор этого устройства",
		"settings.sync_button": "Синхронизировать",
		"settings.syncing_button": "Синхронизация...",
		"settings.backup_section": "Резервное копирование",
		"settings.backup_desc":
			"Бекап будет сохранен как zip архив в папку .backup на диске",
		"settings.backup_never": "Не создавался",
		"settings.backup_unavailable": "Статус резервных копий недоступен",
		"settings.backup_button": "Сделать бекап",
		"settings.backup_show_all": "Показать все бекапы",
		"settings.backup_in_progress": "Создание...",
		"settings.backup_success": "Бекап создан!",
		"settings.backup_error": "Ошибка бекапа",

		// Backup list modal
		"backup_list.title": "Доступные бекапы",
		"backup_list.loading": "Загрузка бекапов...",
		"backup_list.no_backups": "Бекапы не найдены",
		"backup_list.date": "Дата",
		"backup_list.size": "Размер",
		"backup_list.actions": "Действия",
		"backup_list.download": "Скачать",

		// Backup download notices
		"notice.backup_download_started": "Скачивание бекапа...",
		"notice.backup_download_completed": "Бекап скачан: {name}",
		"notice.backup_download_failed": "Ошибка скачивания бекапа",
		"notice.backup_list_load_failed": "Ошибка загрузки списка бекапов",
		"notice.logs_cleared": "Логи очищены",

		// Generic strings
		// Encryption
		"settings.encryption_section": "Шифрование",
		"settings.encryption_desc":
			"Включить сквозное шифрование для файлов на Яндекс.Диске",
		"settings.encryption_status_active": "Шифрование активно",
		"settings.encryption_change_password": "Сменить пароль",
		"modal.encryption_enable_title": "Включение шифрования",
		"modal.encryption_enable_warning":
			"Включение шифрования перезапишет ВСЕ файлы на Яндекс.Диске зашифрованными версиями. Если вы забудете пароль, доступ к данным будет безвозвратно утерян.",
		"modal.encryption_password_label": "Пароль",
		"modal.encryption_confirm_label": "Подтверждение пароля",
		"modal.encryption_password_mismatch": "Пароли не совпадают",
		"modal.encryption_enter_password": "Введите пароль шифрования",
		"modal.encryption_disable_title": "Отключение шифрования",
		"modal.encryption_change_password_title": "Смена пароля шифрования",
		"modal.encryption_enter_current_password":
			"Введите текущий пароль шифрования",
		"modal.encryption_change_password_button": "Сменить пароль",
		"modal.encryption_disable_warning":
			"Отключение шифрования заново загрузит все файлы на Яндекс.Диск в открытом виде и удалит удалённый маркер шифрования.",
		"modal.encryption_connect_title": "Подключить зашифрованное хранилище",
		"modal.encryption_connect_desc":
			"Шифрование было включено на другом устройстве. Введите тот же пароль шифрования, чтобы подключить это устройство. До ввода пароля синхронизация остановлена.",
		"modal.encryption_rotated_title": "Пароль шифрования изменён",
		"modal.encryption_rotated_desc":
			"Пароль шифрования был изменён на другом устройстве. Введите новый пароль, чтобы продолжить синхронизацию на этом устройстве.",
		"modal.encryption_recovery_title": "Завершить изменение шифрования",
		"modal.encryption_recovery_desc":
			"Другое устройство зафиксировало изменение шифрования. Введите пароль transition manifest, чтобы проверить его и безопасно завершить восстановление.",
		"modal.encryption_connect_button": "Подключить",
		"modal.backup_password_title": "Открыть зашифрованный backup",
		"modal.backup_password_desc":
			"Введите пароль, с которым был создан этот backup.",
		"modal.backup_password_button": "Открыть backup",
		"modal.encryption_connect_privacy":
			"Пароль хранится только на этом устройстве и никогда не отправляется на Яндекс.Диск.",
		"notice.encryption_enabled":
			"Шифрование включено. Все файлы зашифрованы и синхронизированы.",
		"settings.encryption_info_title": "О шифровании",
		"settings.encryption_info_how":
			"Усиленное шифрование использует PBKDF2 (600 000 итераций), разделённые HKDF-ключи, AES-256-GCM для содержимого и детерминированный AES-SIV для имён.",
		"settings.encryption_info_warning":
			"Предупреждение: При утере пароля зашифрованные файлы невозможно расшифровать. Механизма восстановления пароля нет.",
		"settings.encryption_info_password":
			"Пароль хранится локально в настройках плагина и никогда не отправляется в удалённое хранилище.",
		"notice.encryption_syncing":
			"Шифрование включено. Перезапись файлов...",
		"notice.encryption_disabling":
			"Шифрование отключается. Перезапись файлов в открытом виде...",
		"notice.encryption_disabled": "Шифрование отключено",
		"notice.encryption_disabled_remotely":
			"Шифрование было отключено на другом устройстве. Переключено в режим без шифрования.",
		"notice.encryption_wrong_password":
			"Неверный пароль. Файлы могут отображаться как повреждённые.",
		"notice.encryption_password_required":
			"Обнаружено зашифрованное хранилище. Введите пароль шифрования на этом устройстве, чтобы продолжить синхронизацию.",
		"notice.encryption_remote_busy":
			"Настройка шифрования выполняется на другом устройстве. Дождитесь завершения и повторите попытку.",
		"notice.encryption_remote_missing":
			"Удалённый маркер шифрования отсутствует. Синхронизация заблокирована, чтобы не повредить данные.",
		"notice.encryption_password_changed_remote":
			"Пароль шифрования был изменён на другом устройстве. Введите новый пароль, чтобы продолжить синхронизацию.",
		"notice.encryption_state_check_failed":
			"Не удалось проверить состояние шифрования на диске: {error}",
		"notice.encryption_state_changed":
			"Состояние шифрования на диске изменилось во время синхронизации. Текущая сессия безопасно остановлена.",
		"notice.encryption_sync_failed":
			"Синхронизация шифрования завершилась с ошибками: {errors}",
		"notice.encryption_disable_partial":
			"Шифрование выключено с ошибками. Проверьте файлы на диске и локально — часть удалённых API-запросов завершилась с ошибками. Если всё выглядит корректно, запустите синхронизацию вручную для полной сверки.",
		"notice.encryption_connected":
			"Зашифрованное хранилище подключено на этом устройстве",
		"notice.encryption_password_rotating":
			"Смена пароля шифрования. Перезапись зашифрованных файлов...",
		"notice.encryption_password_changed":
			"Пароль шифрования изменён. Другие устройства запросят новый пароль.",
		"modal.encryption_enable_with_backup": "Продолжить",

		"generic.yes": "Да",
		"generic.confirm": "Подтвердить",

		// Force sync
		"settings.force_sync_section": "Принудительная синхронизация",
		"settings.force_sync_desc":
			"Принудительная синхронизация игнорирует все условия (даты, хеши файлов, индексы). Создаёт точную копию в указанном направлении.",
		"settings.force_sync_from_local_button": "Синхр. локальное → удалённое",
		"settings.force_sync_from_remote_button":
			"Синхр. удалённое → локальное",
		"modal.force_sync_title": "Подтверждение принудительной синхронизации",
		"modal.force_sync_from_local_text":
			"Эта операция перезапишет ВСЕ файлы на Яндекс.Диске локальными версиями. Файлы, которые существуют только на Яндекс.Диске, будут безвозвратно удалены.",
		"modal.force_sync_from_remote_text":
			"Эта операция перезапишет ВСЕ локальные файлы версиями с Яндекс.Диска. Локальные файлы, которых нет на Яндекс.Диске, будут безвозвратно удалены.",
		"modal.force_sync_warning":
			"ВНИМАНИЕ: Операция является деструктивной и не может быть отменена. Изменения, сделанные после синхронизации на перезаписываемой стороне, могут быть потеряны.",
		"modal.force_sync_recommend_backup":
			"Выберите полный архив или продолжение без него. Проверки снимков и защита отдельных файлов сохраняются.",
		"modal.force_sync_backup_button": "Создать бекап и продолжить",
		"notice.force_sync_from_local_started":
			"Принудительная синхронизация из локального в удалённое...",
		"notice.force_sync_from_remote_started":
			"Принудительная синхронизация из удалённого в локальное...",
		"notice.force_sync_completed":
			"Принудительная синхронизация завершена! ({successful} операций)",
	},
};

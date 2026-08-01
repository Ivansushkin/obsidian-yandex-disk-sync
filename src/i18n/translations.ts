/**
 * Translation dictionaries for Yandex Disk Sync plugin
 */

export type Language = "en" | "ru";

export const translations: Record<Language, Record<string, string>> = {
	en: {
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
		"status.last_sync": "YD: {time}",
		"status.ready_full": "YD: Ready",

		// Status bar tooltips
		"status.tooltip.idle": "Status: Ready for synchronization",
		"status.tooltip.syncing": "Status: Synchronizing...",
		"status.tooltip.syncing_current": "Operation: {operation}",
		"status.tooltip.syncing_pending": "Remaining: {count} files",
		"status.tooltip.error": "Status: Error",
		"status.tooltip.error_details": "Error: {message}",
		"status.tooltip.paused": "Status: Paused",
		"status.tooltip.offline": "Status: No connection",
		"status.tooltip.initializing": "Status: Initializing...",
		"status.tooltip.encryption_required":
			"Status: Synchronization is blocked until encryption password is entered",
		"status.tooltip.last_sync": "Last synchronization: {datetime}",

		// Operation statuses
		"status.op.preparing": "Preparing...",
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
		"status.op.conflict": "Conflict: {path}",

		// Notices
		"notice.sync_started": "Synchronization started...",
		"notice.legacy_index_blocked":
			"Plugin 2.0.0-beta.11 detected an index from an older plugin version. Update every device, create a backup, then run Force sync from local or remote.",
		"notice.unreadable_index_blocked":
			"The remote sync index cannot be decoded. Normal sync is blocked to protect your data. Create a backup, then use Force sync to select the authoritative side.",
		"notice.epoch_mismatch_blocked":
			"The remote vault was reset by Force sync. Create a backup, then run Force sync from remote on this device.",
		"notice.ambiguous_index_blocked":
			"Several index locks were found. Normal sync is blocked; create a backup and use Force sync to choose the authoritative side.",
		"notice.sync_completed":
			"Synchronization completed! ({successful} operations)",
		"notice.sync_error": "Synchronization completed with errors: {errors}",
		"notice.sync_paused": "Synchronization paused",
		"notice.sync_resumed": "Synchronization resumed",
		"notice.token_invalid": "Error: invalid Yandex Disk token",
		"notice.token_missing":
			"Please configure Yandex Disk token in plugin settings",
		"notice.connection_test_success": "Connection successful",
		"notice.connection_check": "Checking connection to Yandex Disk...",
		"notice.backup_started": "Creating backup...",
		"notice.backup_completed": "Backup created: {name}",

		// Modal titles
		"modal.status_title": "Synchronization status",

		// Modal descriptions
		"modal.cancel_button": "Cancel",
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
		"notice.backup_encrypted_no_key":
			"This backup was encrypted. Enable E2E encryption or re-enter the encryption password to download it.",
		"notice.backup_old_key":
			"This backup was encrypted with an older password and cannot be downloaded after password rotation.",
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
		"modal.encryption_connect_button": "Connect",
		"modal.encryption_connect_privacy":
			"The password is stored only on this device and is never sent to Yandex Disk.",
		"notice.encryption_enabled":
			"Encryption enabled. All files encrypted and synced.",
		"settings.encryption_info_title": "About encryption",
		"settings.encryption_info_how":
			"Encryption uses AES-256-GCM with PBKDF2 key derivation (100,000 iterations). File contents and filenames are encrypted before upload and decrypted after download.",
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
		"modal.encryption_enable_with_backup":
			"Create backup and enable encryption",
		"modal.encryption_enable_without_backup":
			"Enable encryption without backup",

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
			"A successful backup is required before Force sync can start.",
		"modal.force_sync_backup_button": "Create backup and proceed",
		"notice.force_sync_from_local_started":
			"Forcing sync from local to remote...",
		"notice.force_sync_from_remote_started":
			"Forcing sync from remote to local...",
		"notice.force_sync_completed":
			"Force sync completed! ({successful} operations)",

	},
	ru: {
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
		"status.last_sync": "YD: {time}",
		"status.ready_full": "YD: Готов",

		// Status bar tooltips
		"status.tooltip.idle": "Статус: Готов к синхронизации",
		"status.tooltip.syncing": "Статус: Синхронизация...",
		"status.tooltip.syncing_current": "Операция: {operation}",
		"status.tooltip.syncing_pending": "Осталось: {count} файлов",
		"status.tooltip.error": "Статус: Ошибка",
		"status.tooltip.error_details": "Ошибка: {message}",
		"status.tooltip.paused": "Статус: Приостановлено",
		"status.tooltip.offline": "Статус: Нет подключения",
		"status.tooltip.initializing": "Статус: Инициализация...",
		"status.tooltip.encryption_required":
			"Статус: Синхронизация заблокирована до ввода пароля шифрования",
		"status.tooltip.last_sync": "Последняя синхронизация: {datetime}",

		// Operation statuses
		"status.op.preparing": "Подготовка...",
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
		"status.op.conflict": "Конфликт: {path}",

		// Notices
		"notice.sync_started": "Запуск синхронизации...",
		"notice.legacy_index_blocked":
			"Плагин 2.0.0-beta.11 обнаружил индекс более старой версии плагина. Обновите все устройства, создайте резервную копию и выполните принудительную синхронизацию из локального или удалённого хранилища.",
		"notice.unreadable_index_blocked":
			"Удалённый индекс синхронизации не удалось декодировать. Обычная синхронизация заблокирована для защиты данных. Создайте резервную копию и выберите авторитетную сторону через Force sync.",
		"notice.epoch_mismatch_blocked":
			"Удалённое хранилище было сброшено через Force sync. Создайте резервную копию и выполните Force sync из удалённого хранилища на этом устройстве.",
		"notice.ambiguous_index_blocked":
			"Обнаружено несколько lock-файлов индекса. Обычная синхронизация заблокирована; создайте бекап и выберите авторитетную сторону через Force sync.",
		"notice.sync_completed":
			"Синхронизация завершена! ({successful} операций)",
		"notice.sync_error": "Синхронизация завершена с ошибками: {errors}",
		"notice.sync_paused": "Синхронизация приостановлена",
		"notice.sync_resumed": "Синхронизация возобновлена",
		"notice.token_invalid": "Ошибка: неверный токен Яндекс Диска",
		"notice.token_missing":
			"Настройте токен Яндекс Диска в настройках плагина",
		"notice.connection_test_success": "Подключение успешно",
		"notice.connection_check": "Проверка подключения к Яндекс Диску...",
		"notice.backup_started": "Создание бекапа...",
		"notice.backup_completed": "Бекап создан: {name}",

		// Modal titles
		"modal.status_title": "Статус синхронизации",

		// Modal descriptions
		"modal.cancel_button": "Отмена",
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
		"notice.backup_encrypted_no_key":
			"Этот бекап зашифрован. Включите сквозное шифрование или введите пароль заново, чтобы скачать его.",
		"notice.backup_old_key":
			"Этот бекап зашифрован старым паролем и не может быть скачан после смены пароля.",
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
		"modal.encryption_connect_button": "Подключить",
		"modal.encryption_connect_privacy":
			"Пароль хранится только на этом устройстве и никогда не отправляется на Яндекс.Диск.",
		"notice.encryption_enabled":
			"Шифрование включено. Все файлы зашифрованы и синхронизированы.",
		"settings.encryption_info_title": "О шифровании",
		"settings.encryption_info_how":
			"Шифрование использует AES-256-GCM с выводом ключа через PBKDF2 (100 000 итераций). Содержимое файлов и их имена шифруются перед загрузкой и расшифровываются после скачивания.",
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
		"modal.encryption_enable_with_backup":
			"Сделать бекап и включить шифрование",
		"modal.encryption_enable_without_backup":
			"Включить шифрование без бекапа",

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
			"Перед запуском Force sync необходимо успешно создать бекап.",
		"modal.force_sync_backup_button": "Создать бекап и продолжить",
		"notice.force_sync_from_local_started":
			"Принудительная синхронизация из локального в удалённое...",
		"notice.force_sync_from_remote_started":
			"Принудительная синхронизация из удалённого в локальное...",
		"notice.force_sync_completed":
			"Принудительная синхронизация завершена! ({successful} операций)",

	},
};

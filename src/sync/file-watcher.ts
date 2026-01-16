/**
 * File change tracking for real-time synchronization
 */

import { App, TFile, EventRef } from "obsidian";
import { SyncEngine } from "./sync-engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";

export class FileWatcher {
	private app: App;
	private syncEngine: SyncEngine;
	private settings: YandexDiskSyncSettings;

	private eventRefs: EventRef[] = [];
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private isEnabled = false;
	private isLayoutReady = false;

	constructor(
		app: App,
		syncEngine: SyncEngine,
		settings: YandexDiskSyncSettings
	) {
		this.app = app;
		this.syncEngine = syncEngine;
		this.settings = settings;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		this.settings = settings;

		// Restart if settings changed
		if (this.isEnabled && !settings.enableRealtimeSync) {
			this.stop();
		} else if (!this.isEnabled && settings.enableRealtimeSync) {
			this.start();
		}
	}

	/**
	 * Start tracking
	 */
	start(): void {
		logger.info("[FileWatcher] Attempting to start FileWatcher");

		if (this.isEnabled) {
			logger.info("[FileWatcher] FileWatcher already running");
			return;
		}

		if (!this.settings.enableRealtimeSync) {
			logger.info("[FileWatcher] Real-time sync disabled in settings");
			return;
		}

		// Wait for layout to be ready
		if (!this.app.workspace.layoutReady) {
			this.app.workspace.onLayoutReady(() => {
				this.isLayoutReady = true;
				this.registerEvents();
			});
		} else {
			this.isLayoutReady = true;
			this.registerEvents();
		}

		this.isEnabled = true;
		logger.info("FileWatcher started");
	}

	/**
	 * Stop tracking
	 */
	stop(): void {
		if (!this.isEnabled) {
			return;
		}

		// Clear all debounce timers
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		// Unsubscribe from events
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
		}
		this.eventRefs = [];

		this.isEnabled = false;
		logger.info("FileWatcher stopped");
	}

	/**
	 * Register event handlers
	 */
	private registerEvents(): void {
		logger.info("[FileWatcher] Registering event handlers");

		// File creation
		const createRef = this.app.vault.on("create", (file) => {
			if (!this.isLayoutReady) return;
			if (file instanceof TFile) {
				this.handleFileCreate(file);
			}
		});
		this.eventRefs.push(createRef);

		// File modification
		const modifyRef = this.app.vault.on("modify", (file) => {
			if (!this.isLayoutReady) return;
			if (file instanceof TFile) {
				this.handleFileModify(file);
			}
		});
		this.eventRefs.push(modifyRef);

		// File deletion
		const deleteRef = this.app.vault.on("delete", (file) => {
			if (!this.isLayoutReady) return;
			if (file instanceof TFile) {
				this.handleFileDelete(file);
			}
		});
		this.eventRefs.push(deleteRef);

		// File rename
		const renameRef = this.app.vault.on("rename", (file, oldPath) => {
			if (!this.isLayoutReady) return;
			if (file instanceof TFile) {
				this.handleFileRename(file, oldPath);
			}
		});
		this.eventRefs.push(renameRef);
	}

	/**
	 * Handle file creation
	 */
	private handleFileCreate(file: TFile): void {
		logger.debug(`File created: ${file.path}`);
		this.scheduleSync(file.path, "upload");
	}

	/**
	 * Handle file modification
	 */
	private handleFileModify(file: TFile): void {
		logger.debug(`File modified: ${file.path}`);
		this.scheduleSync(file.path, "upload");
	}

	/**
	 * Handle file deletion
	 */
	private handleFileDelete(file: TFile): void {
		logger.info(`[FileWatcher] File deleted: ${file.path}`);
		// Cancel pending upload if exists
		this.cancelPendingSync(file.path);
		// Delete immediately (no debounce)
		logger.info(`[FileWatcher] Starting deletion from Yandex Disk: ${file.path}`);
		this.syncEngine.syncSingleFile(file.path, "delete").catch((e) => {
			logger.error(`Error deleting file ${file.path}:`, e);
		});
	}

	/**
	 * Handle file rename
	 */
	private handleFileRename(file: TFile, oldPath: string): void {
		logger.debug(`File renamed: ${oldPath} -> ${file.path}`);
		// Cancel pending sync for old path
		this.cancelPendingSync(oldPath);
		// Perform rename
		this.syncEngine.renameFile(oldPath, file.path).catch((e) => {
			logger.error(`Error renaming ${oldPath} -> ${file.path}:`, e);
		});
	}

	/**
	 * Schedule sync with debounce
	 */
	private scheduleSync(path: string, action: "upload" | "delete"): void {
		// Cancel previous timer for this file
		this.cancelPendingSync(path);

		// Create new timer
		const timer = setTimeout(() => {
			this.debounceTimers.delete(path);
			this.syncEngine.syncSingleFile(path, action).catch((e) => {
				logger.error(`Error synchronizing ${path}:`, e);
			});
		}, this.settings.debounceDelay);

		this.debounceTimers.set(path, timer);
	}

	/**
	 * Cancel pending sync
	 */
	private cancelPendingSync(path: string): void {
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
		}
	}

	/**
	 * Check if watcher is active
	 */
	isActive(): boolean {
		return this.isEnabled;
	}
}

/**
 * File change tracking for real-time synchronization
 */

import { App, TFile, TFolder, EventRef } from "obsidian";
import { SyncEngine } from "./sync-engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";

export type DeferredWatcherEvent =
	| { action: "upload" | "delete" | "delete-folder"; path: string }
	| {
			action: "rename";
			path: string;
			targetPath: string;
			kind: "file" | "folder";
	  };

export class FileWatcher {
	private app: App;
	private syncEngine: SyncEngine;
	private settings: YandexDiskSyncSettings;

	private eventRefs: EventRef[] = [];
	private debounceTimers = new Map<
		string,
		{
			timer: ReturnType<typeof setTimeout>;
			action: "upload" | "delete";
		}
	>();
	private readyFileEvents = new Map<string, "upload" | "delete">();
	private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private isEnabled = false;
	private isLayoutReady = false;
	private isPausedForSync = false;
	private syncPauseDepth = 0;
	private recentFolderDeletes = new Map<string, number>();
	private deferredEvents: DeferredWatcherEvent[] = [];
	private persistCallback: (() => void | Promise<void>) | null = null;

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

	loadDeferredEvents(events: DeferredWatcherEvent[] | undefined): void {
		this.deferredEvents = Array.isArray(events) ? [...events] : [];
		logger.info("Loaded durable watcher event queue", {
			pendingWatcherEvents: this.deferredEvents.length,
		});
	}

	getDeferredEvents(): DeferredWatcherEvent[] {
		return this.deferredEvents.map((event) => ({ ...event }));
	}

	setPersistCallback(callback: () => void | Promise<void>): void {
		this.persistCallback = callback;
	}

	/**
	 * Pause file watching during full synchronization
	 */
	pauseForSync(): void {
		if (!this.isEnabled) {
			return;
		}

		this.syncPauseDepth++;
		if (this.syncPauseDepth > 1) return;
		this.isPausedForSync = true;
		logger.info("[FileWatcher] Paused for full sync");

		for (const [path, pending] of this.debounceTimers) {
			clearTimeout(pending.timer);
			this.deferEvent({ action: pending.action, path });
		}
		this.debounceTimers.clear();
		for (const [path, action] of this.readyFileEvents) {
			this.deferEvent({ action, path });
		}
		this.readyFileEvents.clear();
		if (this.batchFlushTimer) {
			clearTimeout(this.batchFlushTimer);
			this.batchFlushTimer = null;
		}
	}

	/**
	 * Resume file watching after full synchronization
	 */
	resumeAfterSync(): void {
		if (!this.isEnabled) {
			return;
		}

		this.syncPauseDepth = Math.max(0, this.syncPauseDepth - 1);
		if (this.syncPauseDepth > 0) return;
		this.isPausedForSync = false;
		logger.info("[FileWatcher] Resumed after full sync");
		void this.flushDeferredEvents().catch((e) => {
			logger.error("Failed to flush deferred watcher events:", {
				error: e,
			});
		});
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
		for (const [path, pending] of this.debounceTimers) {
			clearTimeout(pending.timer);
			this.deferEvent({ action: pending.action, path });
		}
		this.debounceTimers.clear();
		for (const [path, action] of this.readyFileEvents) {
			this.deferEvent({ action, path });
		}
		this.readyFileEvents.clear();
		if (this.batchFlushTimer) {
			clearTimeout(this.batchFlushTimer);
			this.batchFlushTimer = null;
		}

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
			} else if (file instanceof TFolder) {
				this.handleFolderDelete(file);
			}
		});
		this.eventRefs.push(deleteRef);

		// File rename
		const renameRef = this.app.vault.on("rename", (file, oldPath) => {
			if (!this.isLayoutReady) return;
			if (file instanceof TFile) {
				this.handleFileRename(file, oldPath);
			} else if (file instanceof TFolder) {
				this.handleFolderRename(file, oldPath);
			}
		});
		this.eventRefs.push(renameRef);
	}

	/**
	 * Handle file creation
	 */
	private handleFileCreate(file: TFile): void {
		if (
			this.syncEngine.consumeInternalWatcherEvent(file.path, "upload")
		) {
			return;
		}
		if (this.isPausedForSync) {
			this.deferEvent({ action: "upload", path: file.path });
			return;
		}

		logger.debug(`File created: ${file.path}`);
		this.scheduleSync(file.path, "upload");
	}

	/**
	 * Handle file modification
	 */
	private handleFileModify(file: TFile): void {
		if (
			this.syncEngine.consumeInternalWatcherEvent(file.path, "upload")
		) {
			return;
		}
		if (this.isPausedForSync) {
			this.deferEvent({ action: "upload", path: file.path });
			return;
		}

		logger.debug(`File modified: ${file.path}`);
		this.scheduleSync(file.path, "upload");
	}

	/**
	 * Handle file deletion
	 */
	private handleFileDelete(file: TFile): void {
		const now = Date.now();
		for (const [prefix, expiresAt] of this.recentFolderDeletes) {
			if (expiresAt < now) {
				this.recentFolderDeletes.delete(prefix);
				continue;
			}
			if (file.path.startsWith(prefix)) return;
		}
		if (
			this.syncEngine.consumeInternalWatcherEvent(file.path, "delete")
		) {
			return;
		}
		if (this.isPausedForSync) {
			this.deferEvent({ action: "delete", path: file.path });
			return;
		}

		logger.info(`[FileWatcher] File deleted: ${file.path}`);
		// Cancel pending upload if exists
		this.cancelPendingSync(file.path);
		this.scheduleSync(file.path, "delete");
	}

	/**
	 * Handle file rename
	 */
	private handleFileRename(file: TFile, oldPath: string): void {
		if (this.isPausedForSync) {
			this.deferEvent({
				action: "rename",
				path: oldPath,
				targetPath: file.path,
				kind: "file",
			});
			return;
		}

		logger.debug(`File renamed: ${oldPath} -> ${file.path}`);
		// Cancel pending sync for old path
		this.cancelPendingSync(oldPath);
		// Perform rename
		this.syncEngine.renameFile(oldPath, file.path).catch((e) => {
			this.deferEvent({
				action: "rename",
				path: oldPath,
				targetPath: file.path,
				kind: "file",
			});
			logger.error(`Error renaming ${oldPath} -> ${file.path}:`, { error: e });
		});
	}

	private handleFolderDelete(folder: TFolder): void {
		this.recentFolderDeletes.set(
			`${folder.path.replace(/\/+$/, "")}/`,
			Date.now() + Math.max(2_000, this.settings.debounceDelay * 2),
		);
		this.cancelPendingDescendants(folder.path);
		if (this.isPausedForSync) {
			this.deferEvent({ action: "delete-folder", path: folder.path });
			return;
		}
		void this.syncEngine.deleteFolder(folder.path).catch((e) => {
			this.deferEvent({
				action: "delete-folder",
				path: folder.path,
			});
			logger.error(`Error deleting folder ${folder.path}:`, {
				error: e,
			});
		});
	}

	private handleFolderRename(folder: TFolder, oldPath: string): void {
		if (this.isPausedForSync) {
			this.deferEvent({
				action: "rename",
				path: oldPath,
				targetPath: folder.path,
				kind: "folder",
			});
			return;
		}
		void this.syncEngine.renameFolder(oldPath, folder.path).catch((e) => {
			this.deferEvent({
				action: "rename",
				path: oldPath,
				targetPath: folder.path,
				kind: "folder",
			});
			logger.error(
				`Error renaming folder ${oldPath} -> ${folder.path}:`,
				{ error: e },
			);
		});
	}

	private deferEvent(
		event: DeferredWatcherEvent,
	): void {
		const before = this.deferredEvents.length;
		if (event.action === "delete-folder") {
			const prefix = `${event.path.replace(/\/+$/, "")}/`;
			this.deferredEvents = this.deferredEvents.filter(
				(existing) => !existing.path.startsWith(prefix),
			);
		}
		this.deferredEvents = this.deferredEvents.filter(
			(existing) => existing.path !== event.path,
		);
		this.deferredEvents.push(event);
		logger.debug("Watcher event persisted for replay", {
			action: event.action,
			path: event.path,
			targetPath:
				event.action === "rename" ? event.targetPath : undefined,
			coalescedEvents:
				before + 1 - this.deferredEvents.length,
			pendingWatcherEvents: this.deferredEvents.length,
		});
		this.persistDeferredEvents();
	}

	private async flushDeferredEvents(): Promise<void> {
		const events = this.deferredEvents.splice(0);
		logger.info("Replaying durable watcher events", {
			watcherEvents: events.length,
		});
		this.persistDeferredEvents();
		let fileBatch: Array<{
			path: string;
			action: "upload" | "delete";
		}> = [];
		const flushFileBatch = async (): Promise<void> => {
			if (fileBatch.length === 0) return;
			const batch = fileBatch;
			fileBatch = [];
			logger.debug("Replaying watcher file batch", {
				batchSize: batch.length,
				events: batch,
			});
			if (!(await this.syncEngine.syncFileBatch(batch))) {
				for (const event of batch) {
					this.deferEvent(event);
				}
				throw new Error(
					"Realtime file batch was not fully reconciled",
				);
			}
		};

		for (const event of events) {
			try {
				logger.debug("Replaying watcher event", {
					action: event.action,
					path: event.path,
					targetPath:
						event.action === "rename"
							? event.targetPath
							: undefined,
				});
				if (event.action === "upload" || event.action === "delete") {
					fileBatch.push({
						path: event.path,
						action: event.action,
					});
					continue;
				}
				await flushFileBatch();
				if (event.action === "rename") {
					if (event.kind === "folder") {
						await this.syncEngine.renameFolder(
							event.path,
							event.targetPath,
						);
					} else {
						await this.syncEngine.renameFile(
							event.path,
							event.targetPath,
						);
					}
				} else if (event.action === "delete-folder") {
					await this.syncEngine.deleteFolder(event.path);
				}
			} catch (e) {
				this.deferEvent(event);
				logger.error(
					`Deferred watcher event failed for ${event.path}:`,
					{ error: e },
				);
			}
		}
		try {
			await flushFileBatch();
		} catch (error) {
			for (const event of events) {
				if (
					event.action === "upload" ||
					event.action === "delete"
				) {
					this.deferEvent(event);
				}
			}
			throw error;
		}
		this.persistDeferredEvents();
		logger.info("Durable watcher event replay completed", {
			replayedEvents: events.length,
			pendingWatcherEvents: this.deferredEvents.length,
		});
	}

	private persistDeferredEvents(): void {
		if (!this.persistCallback) return;
		const pendingWatcherEvents = this.deferredEvents.length;
		void Promise.resolve(this.persistCallback()).then(
			() => {
				logger.debug("Durable watcher event queue saved", {
					pendingWatcherEvents,
				});
			},
			(error) => {
				logger.error("Could not persist deferred watcher events:", {
					pendingWatcherEvents,
					error,
				});
			},
		);
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
			this.readyFileEvents.set(path, action);
			this.scheduleBatchFlush();
		}, this.settings.debounceDelay);

		this.debounceTimers.set(path, { timer, action });
		logger.debug("Watcher event scheduled for realtime batch", {
			action,
			path,
			debounceDelayMs: this.settings.debounceDelay,
			pendingDebounceEvents: this.debounceTimers.size,
		});
	}

	/**
	 * Cancel pending sync
	 */
	private cancelPendingSync(path: string): void {
		const pending = this.debounceTimers.get(path);
		if (pending) {
			clearTimeout(pending.timer);
			this.debounceTimers.delete(path);
		}
		this.readyFileEvents.delete(path);
	}

	private cancelPendingDescendants(folderPath: string): void {
		const prefix = `${folderPath.replace(/\/+$/, "")}/`;
		for (const [path, pending] of this.debounceTimers) {
			if (!path.startsWith(prefix)) continue;
			clearTimeout(pending.timer);
			this.debounceTimers.delete(path);
		}
		for (const path of this.readyFileEvents.keys()) {
			if (path.startsWith(prefix)) {
				this.readyFileEvents.delete(path);
			}
		}
	}

	private scheduleBatchFlush(): void {
		if (this.batchFlushTimer) return;
		this.batchFlushTimer = setTimeout(() => {
			this.batchFlushTimer = null;
			const events = Array.from(
				this.readyFileEvents,
				([path, action]) => ({ path, action }),
			);
			this.readyFileEvents.clear();
			void this.syncEngine
				.syncFileBatch(events)
				.then((completed) => {
					if (completed) return;
					for (const event of events) {
						this.deferEvent(event);
					}
				})
				.catch((e) => {
					for (const event of events) {
						this.deferEvent(event);
					}
					logger.error("Error synchronizing realtime file batch:", {
						error: e,
					});
				});
		}, 75);
	}

	/**
	 * Check if watcher is active
	 */
	isActive(): boolean {
		return this.isEnabled;
	}
}

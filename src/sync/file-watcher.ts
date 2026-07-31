/**
 * File change tracking for real-time synchronization
 */

import { App, TFile, TFolder, EventRef } from "obsidian";
import {
	SyncEngine,
	type SyncLifecycleContext,
	type SyncLifecycleOutcome,
} from "./sync-engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";
import {
	shouldRetainQueuedFileEvent,
	type RealtimeBatchResult,
	type RealtimeFileEvent,
	type WatcherCausalContext,
} from "./realtime-rules";

export type DeferredWatcherEvent =
	| RealtimeFileEvent
	| { action: "delete-folder"; path: string }
	| {
		action: "rename";
		path: string;
		targetPath: string;
		kind: "file" | "folder";
		id?: string;
		epoch?: string | null;
		baseRevision?: number | null;
		createdAt?: number;
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
			event: RealtimeFileEvent;
		}
	>();
	private readyFileEvents = new Map<string, RealtimeFileEvent>();
	private submittedFileEvents = new Map<string, RealtimeFileEvent>();
	private submittedWatcherEventIds = new Set<string>();
	private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private deferredReplayTimer: ReturnType<typeof setTimeout> | null = null;
	private deferredDrainPromise: Promise<void> | null = null;
	private deferredReplayRequested = false;
	private isEnabled = false;
	private isLayoutReady = false;
	private isPausedForSync = false;
	private syncPauseDepth = 0;
	private recentFolderDeletes = new Map<string, number>();
	private deferredEvents: DeferredWatcherEvent[] = [];
	private persistCallback: (() => void | Promise<void>) | null = null;
	private persistChain: Promise<void> = Promise.resolve();
	private persistError: unknown = null;
	private fullSyncBarrier: {
		sessionId: string;
		uploadEventIds: Set<string>;
	} | null = null;

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
		this.deferredEvents = Array.isArray(events)
			? events.map((event) => this.normalizeEvent(event))
			: [];
		logger.info("Loaded durable watcher event queue", {
			pendingWatcherEvents: this.deferredEvents.length,
		});
		if (this.deferredEvents.length > 0) {
			this.persistDeferredEvents();
		}
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
	async pauseForSync(context: SyncLifecycleContext): Promise<void> {
		if (!this.isEnabled) {
			return;
		}

		this.syncPauseDepth++;
		if (this.syncPauseDepth > 1) return;
		this.isPausedForSync = true;
		logger.info("[FileWatcher] Paused for full sync");

		this.drainPendingFileEvents();
		if (context.kind === "full") {
			this.captureFullSyncBarrier(context);
		}
		await this.waitForPersistence();
	}

	/**
	 * Resume file watching after full synchronization
	 */
	async resumeAfterSync(outcome: SyncLifecycleOutcome): Promise<void> {
		if (!this.isEnabled) {
			return;
		}

		this.syncPauseDepth = Math.max(0, this.syncPauseDepth - 1);
		if (this.syncPauseDepth > 0) return;
		this.completeFullSyncBarrier(outcome);
		await this.waitForPersistence();
		this.isPausedForSync = false;
		logger.info("[FileWatcher] Resumed after full sync");
		if (this.deferredEvents.length === 0) return;
		if (outcome.kind === "full" && !outcome.success) {
			logger.warn(
				"Deferred watcher replay postponed after failed full sync",
				{
					sessionId: outcome.sessionId,
					pendingWatcherEvents: this.deferredEvents.length,
				},
			);
			return;
		}
		void this.flushDeferredEvents().catch((e) => {
			logger.error("Failed to flush deferred watcher events:", {
				error: e,
			});
		});
	}

	/**
	 * Snapshot upload events that the upcoming full reconciliation will cover.
	 */
	private captureFullSyncBarrier(context: SyncLifecycleContext): void {
		const uploadEventIds = new Set(
			this.deferredEvents
				.filter(
					(event): event is RealtimeFileEvent =>
						event.action === "upload",
				)
				.map((event) => event.id),
		);
		this.fullSyncBarrier = {
			sessionId: context.sessionId,
			uploadEventIds,
		};
		logger.info("Full sync watcher barrier captured", {
			sessionId: context.sessionId,
			capturedUploads: uploadEventIds.size,
			pendingWatcherEvents: this.deferredEvents.length,
		});
	}

	/**
	 * Acknowledge only uploads included in a successful full reconciliation.
	 */
	private completeFullSyncBarrier(outcome: SyncLifecycleOutcome): void {
		const barrier = this.fullSyncBarrier;
		if (
			!barrier ||
			outcome.kind !== "full" ||
			outcome.sessionId !== barrier.sessionId
		) {
			return;
		}
		this.fullSyncBarrier = null;
		const currentUploadIds = new Set(
			this.deferredEvents
				.filter(
					(event): event is RealtimeFileEvent =>
						event.action === "upload",
				)
				.map((event) => event.id),
		);
		const acknowledgedIds = outcome.success
			? [...barrier.uploadEventIds].filter((id) =>
					currentUploadIds.has(id),
				)
			: [];
		if (acknowledgedIds.length > 0) {
			this.acknowledgeEvents(acknowledgedIds);
		}
		logger[outcome.success ? "info" : "warn"](
			"Full sync watcher barrier completed",
			{
				sessionId: outcome.sessionId,
				success: outcome.success,
				capturedUploads: barrier.uploadEventIds.size,
				acknowledgedUploads: acknowledgedIds.length,
				uploadsCreatedDuringFull: [...currentUploadIds].filter(
					(id) => !barrier.uploadEventIds.has(id),
				).length,
				pendingWatcherEvents: this.deferredEvents.length,
			},
		);
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

		this.drainPendingFileEvents();

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
		this.handleFileUpload(file, "created");
	}

	/**
	 * Handle file modification
	 */
	private handleFileModify(file: TFile): void {
		this.handleFileUpload(file, "modified");
	}

	/** Route create and modify events through one durable upload path. */
	private handleFileUpload(
		file: TFile,
		reason: "created" | "modified",
	): void {
		if (
			this.syncEngine.consumeInternalWatcherEvent(file.path, "upload")
		) {
			return;
		}
		if (this.isPausedForSync) {
			this.deferEvent(this.createFileEvent(file.path, "upload"));
			return;
		}

		logger.debug(`File ${reason}: ${file.path}`);
		this.scheduleSync(file.path, "upload");
	}

	/** Move queued file events into durable storage and cancel drain timers. */
	private drainPendingFileEvents(): void {
		for (const pending of this.debounceTimers.values()) {
			clearTimeout(pending.timer);
			this.deferEvent(pending.event);
		}
		this.debounceTimers.clear();
		for (const event of this.readyFileEvents.values()) {
			this.deferEvent(event);
		}
		this.readyFileEvents.clear();
		if (this.batchFlushTimer) {
			clearTimeout(this.batchFlushTimer);
			this.batchFlushTimer = null;
		}
		if (this.deferredReplayTimer) {
			clearTimeout(this.deferredReplayTimer);
			this.deferredReplayTimer = null;
		}
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
			const event = this.createFileEvent(file.path, "delete");
			this.deferEvent(event);
			this.cancelPendingSync(file.path);
			return;
		}

		logger.info(`[FileWatcher] File deleted: ${file.path}`);
		this.scheduleSync(file.path, "delete");
	}

	/**
	 * Handle file rename
	 */
	private handleFileRename(file: TFile, oldPath: string): void {
		const context = this.syncEngine.getWatcherCausalContext();
		const event: DeferredWatcherEvent = {
			action: "rename",
			path: oldPath,
			targetPath: file.path,
			kind: "file",
			id: this.createEventId(),
			...context,
			createdAt: Date.now(),
		};
		this.deferEvent(event);
		this.cancelPendingSync(oldPath);
		if (this.isPausedForSync) {
			return;
		}

		logger.debug(`File renamed: ${oldPath} -> ${file.path}`);
		this.scheduleDeferredReplay();
	}

	private handleFolderDelete(folder: TFolder): void {
		this.recentFolderDeletes.set(
			`${folder.path.replace(/\/+$/, "")}/`,
			Date.now() + Math.max(2_000, this.settings.debounceDelay * 2),
		);
		const absorbedDescendantEvents =
			this.cancelPendingDescendants(folder.path);
		logger.info(`[FileWatcher] Folder deleted: ${folder.path}`, {
			absorbedDescendantEvents,
		});
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
		event = this.normalizeEvent(event);
		const before = this.deferredEvents.length;
		if (event.action === "rename" && event.kind === "file") {
			const chainedIndex = this.deferredEvents.findIndex(
				(existing) =>
					existing.action === "rename" &&
					existing.kind === "file" &&
					existing.targetPath === event.path &&
					(!existing.id ||
						!this.submittedWatcherEventIds.has(existing.id)),
			);
			if (chainedIndex >= 0) {
				const chained = this.deferredEvents[chainedIndex];
				if (
					chained?.action === "rename" &&
					chained.kind === "file"
				) {
					this.deferredEvents[chainedIndex] = {
						...chained,
						targetPath: event.targetPath,
					};
					logger.debug("Watcher file rename chain coalesced", {
						eventId: chained.id,
						oldPath: chained.path,
						intermediatePath: event.path,
						targetPath: event.targetPath,
						pendingWatcherEvents: this.deferredEvents.length,
					});
					this.persistDeferredEvents();
					return;
				}
			}
		}
		if (event.action === "delete-folder") {
			const prefix = `${event.path.replace(/\/+$/, "")}/`;
			this.deferredEvents = this.deferredEvents.filter(
				(existing) => !existing.path.startsWith(prefix),
			);
		}
		if (event.action === "upload" || event.action === "delete") {
			const submittedIds = new Set(
				this.submittedFileEvents.keys(),
			);
			this.deferredEvents = this.deferredEvents.filter(
				(existing) =>
					existing.action !== "upload" &&
					existing.action !== "delete"
						? true
						: shouldRetainQueuedFileEvent(
								existing,
								event,
								submittedIds,
							),
			);
		} else {
			this.deferredEvents = this.deferredEvents.filter(
				(existing) =>
					existing.path !== event.path ||
					(existing.action === "upload" &&
						this.submittedFileEvents.has(existing.id)),
			);
		}
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
		if (this.deferredDrainPromise) {
			this.deferredReplayRequested = true;
			return await this.deferredDrainPromise;
		}
		const drain = this.flushDeferredEventsNow();
		this.deferredDrainPromise = drain;
		try {
			await drain;
		} finally {
			this.deferredDrainPromise = null;
			if (this.deferredReplayRequested && !this.isPausedForSync) {
				this.deferredReplayRequested = false;
				this.scheduleDeferredReplay();
			}
		}
	}

	private async flushDeferredEventsNow(): Promise<void> {
		await this.waitForPersistence();
		const events = this.deferredEvents.filter(
			(event) =>
				!(
					(event.action === "upload" || event.action === "delete") &&
					this.submittedFileEvents.has(event.id)
				) &&
				!(
					event.action === "rename" &&
					event.kind === "file" &&
					event.id &&
					this.submittedWatcherEventIds.has(event.id)
				),
		);
		logger.info("Replaying durable watcher events", {
			watcherEvents: events.length,
		});
		const replayResult: RealtimeBatchResult = {
			completed: [],
			superseded: [],
			retry: [],
		};
		let fileBatch: RealtimeFileEvent[] = [];
		const flushFileBatch = async (): Promise<void> => {
			if (fileBatch.length === 0) return;
			const batch = fileBatch;
			fileBatch = [];
			logger.debug("Replaying watcher file batch", {
				batchSize: batch.length,
				events: batch,
			});
			for (const event of batch) {
				this.submittedFileEvents.set(event.id, event);
			}
			try {
				const result = await this.syncEngine.syncFileBatch(batch);
				this.applyBatchResult(result);
				replayResult.completed.push(...result.completed);
				replayResult.superseded.push(...result.superseded);
				replayResult.retry.push(...result.retry);
			} finally {
				for (const event of batch) {
					this.submittedFileEvents.delete(event.id);
				}
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
					fileBatch.push(event);
					continue;
				}
				await flushFileBatch();
				if (event.action === "rename") {
					if (event.kind === "folder") {
						await this.syncEngine.renameFolder(
							event.path,
							event.targetPath,
						);
						this.acknowledgeLegacyEvent(event);
					} else {
						if (event.id) {
							this.submittedWatcherEventIds.add(event.id);
						}
						try {
							await this.syncEngine.renameFile(
								event.path,
								event.targetPath,
								this.getEventContext(event),
							);
							if (event.id) {
								this.acknowledgeEvents([event.id]);
							}
						} finally {
							if (event.id) {
								this.submittedWatcherEventIds.delete(event.id);
							}
						}
					}
				} else if (event.action === "delete-folder") {
					await this.syncEngine.deleteFolder(event.path);
					this.acknowledgeLegacyEvent(event);
				}
			} catch (e) {
				logger.error(
					`Deferred watcher event failed for ${event.path}:`,
					{ error: e },
				);
			}
		}
		await flushFileBatch();
		this.persistDeferredEvents();
		logger[replayResult.retry.length > 0 ? "warn" : "info"](
			"Durable watcher event replay completed",
			{
				replayedEvents: events.length,
				completed: replayResult.completed.length,
				superseded: replayResult.superseded.length,
				retry: replayResult.retry.length,
				pendingWatcherEvents: this.deferredEvents.length,
			},
		);
	}

	private persistDeferredEvents(): void {
		if (!this.persistCallback) return;
		const pendingWatcherEvents = this.deferredEvents.length;
		this.persistChain = this.persistChain.then(async () => {
			try {
				await this.persistCallback?.();
				this.persistError = null;
				logger.debug("Durable watcher event queue saved", {
					pendingWatcherEvents,
				});
			} catch (error) {
				this.persistError = error;
				logger.error("Could not persist deferred watcher events:", {
					pendingWatcherEvents,
					error,
				});
			}
		});
	}

	/**
	 * Wait until the durable event queue is confirmed on local storage.
	 */
	private async waitForPersistence(): Promise<void> {
		await this.persistChain;
		if (this.persistError) {
			throw new Error("Durable watcher event queue could not be saved");
		}
	}

	/**
	 * Schedule sync with debounce
	 */
	private scheduleSync(path: string, action: "upload" | "delete"): void {
		const event = this.createFileEvent(path, action);
		this.deferEvent(event);
		this.cancelPendingSync(path);

		const timer = setTimeout(() => {
			this.debounceTimers.delete(path);
			this.readyFileEvents.set(path, event);
			this.scheduleBatchFlush();
		}, this.settings.debounceDelay);

		this.debounceTimers.set(path, { timer, event });
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
			pending.event.superseded = true;
			this.acknowledgeEvents([pending.event.id]);
		}
		const ready = this.readyFileEvents.get(path);
		if (ready) {
			ready.superseded = true;
			this.readyFileEvents.delete(path);
			this.acknowledgeEvents([ready.id]);
		}
		for (const event of this.submittedFileEvents.values()) {
			if (event.path !== path) continue;
			event.superseded = true;
			this.acknowledgeEvents([event.id]);
		}
	}

	private cancelPendingDescendants(folderPath: string): number {
		const prefix = `${folderPath.replace(/\/+$/, "")}/`;
		let cancelled = 0;
		for (const [path, pending] of this.debounceTimers) {
			if (!path.startsWith(prefix)) continue;
			clearTimeout(pending.timer);
			this.debounceTimers.delete(path);
			pending.event.superseded = true;
			this.acknowledgeEvents([pending.event.id]);
			cancelled++;
		}
		for (const [path, event] of this.readyFileEvents) {
			if (path.startsWith(prefix)) {
				this.readyFileEvents.delete(path);
				event.superseded = true;
				this.acknowledgeEvents([event.id]);
				cancelled++;
			}
		}
		for (const event of this.submittedFileEvents.values()) {
			if (event.path.startsWith(prefix)) event.superseded = true;
		}
		return cancelled;
	}

	private scheduleBatchFlush(): void {
		if (this.batchFlushTimer) return;
		this.batchFlushTimer = setTimeout(() => {
			this.batchFlushTimer = null;
			const events = Array.from(this.readyFileEvents.values());
			this.readyFileEvents.clear();
			for (const event of events) {
				this.submittedFileEvents.set(event.id, event);
			}
			void this.waitForPersistence()
				.then(async () => await this.syncEngine.syncFileBatch(events))
				.then((result) => {
					this.applyBatchResult(result);
				})
				.catch((e) => {
					logger.error("Error synchronizing realtime file batch:", {
						error: e,
					});
				})
				.finally(() => {
					for (const event of events) {
						this.submittedFileEvents.delete(event.id);
					}
				});
		}, 75);
	}

	private scheduleDeferredReplay(): void {
		if (this.deferredReplayTimer || this.isPausedForSync) return;
		this.deferredReplayTimer = setTimeout(() => {
			this.deferredReplayTimer = null;
			void this.flushDeferredEvents().catch((error) => {
				logger.error("Could not drain durable watcher queue:", {
					error,
				});
			});
		}, 75);
	}

	/**
	 * Remove only events explicitly acknowledged by the sync engine.
	 */
	private applyBatchResult(result: RealtimeBatchResult): void {
		this.acknowledgeEvents([...result.completed, ...result.superseded]);
		logger[result.retry.length > 0 ? "warn" : "info"](
			"Realtime file batch reconciled",
			{
				completed: result.completed.length,
				superseded: result.superseded.length,
				retry: result.retry.length,
			},
		);
	}

	private acknowledgeEvents(ids: string[]): void {
		if (ids.length === 0) return;
		const acknowledged = new Set(ids);
		this.deferredEvents = this.deferredEvents.filter(
			(event) =>
				!("id" in event) ||
				!event.id ||
				!acknowledged.has(event.id),
		);
		this.persistDeferredEvents();
	}

	private acknowledgeLegacyEvent(event: DeferredWatcherEvent): void {
		const index = this.deferredEvents.indexOf(event);
		if (index >= 0) {
			this.deferredEvents.splice(index, 1);
			this.persistDeferredEvents();
		}
	}

	private getEventContext(event: {
		epoch?: string | null;
		baseRevision?: number | null;
	}): WatcherCausalContext {
		const current = this.syncEngine.getWatcherCausalContext();
		return {
			epoch: event.epoch === undefined ? current.epoch : event.epoch,
			baseRevision:
				event.baseRevision === undefined
					? current.baseRevision
					: event.baseRevision,
		};
	}

	private normalizeEvent(
		event: DeferredWatcherEvent,
	): DeferredWatcherEvent {
		if (event.action === "delete-folder") return { ...event };
		const context = this.getEventContext(event);
		return {
			...event,
			id: event.id ?? this.createEventId(),
			...context,
			createdAt: event.createdAt ?? Date.now(),
		};
	}

	private createEventId(): string {
		return (
			globalThis.crypto?.randomUUID?.() ??
			`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
		);
	}

	/**
	 * Capture the causal watermark together with a new watcher event.
	 */
	private createFileEvent(
		path: string,
		action: "upload" | "delete",
	): RealtimeFileEvent {
		return {
			id: this.createEventId(),
			path,
			action,
			createdAt: Date.now(),
			...this.syncEngine.getWatcherCausalContext(),
		};
	}

}

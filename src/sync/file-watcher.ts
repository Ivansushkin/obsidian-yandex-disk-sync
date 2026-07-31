/**
 * File change tracking for real-time synchronization
 */

import { App, TFile, TFolder, EventRef } from "obsidian";
import {
	SyncEngine,
	type SyncLifecycleContext,
	type SyncLifecycleOutcome,
} from "./sync-engine";
import type { SyncResult, YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";
import {
	reduceQueuedFileRename,
	shouldRetainQueuedFileEvent,
	type DurableFileRenameEvent,
	type FileRenameOutcome,
	type RealtimeBatchResult,
	type RealtimeFileEvent,
	type WatcherCausalContext,
} from "./realtime-rules";

export type DeferredWatcherEvent =
	| RealtimeFileEvent
	| {
		action: "delete-folder";
		path: string;
		id?: string;
		epoch?: string | null;
		baseRevision?: number | null;
		createdAt?: number;
	  }
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
	private isPreparingFullSync = false;
	private syncPauseDepth = 0;
	private recentFolderDeletes = new Map<string, number>();
	private deferredEvents: DeferredWatcherEvent[] = [];
	private persistCallback: (() => void | Promise<void>) | null = null;
	private persistChain: Promise<void> = Promise.resolve();
	private persistError: unknown = null;
	private fullSyncBarrier: {
		sessionId: string;
		uploadEventIds: Set<string>;
		renameCandidateIds: Set<string>;
		alreadyAppliedRenames: number;
		supersededRenames: number;
		unresolvedRenames: number;
	} | null = null;
	private preparedFullBarrier: {
		sessionId: string;
		uploadEventIds: Set<string>;
		cutoffEventIds: Set<string>;
		renameCandidateIds: Set<string>;
	} | null = null;
	private pausedEventSignatures: Map<string, string> | null = null;

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
	 * Freeze realtime scheduling and settle destructive work that predates a
	 * full-sync request before that full session enters the coordinator queue.
	 */
	async prepareForSync(context: SyncLifecycleContext): Promise<void> {
		if (!this.isEnabled || context.kind !== "full") return;
		this.isPreparingFullSync = true;
		this.drainPendingFileEvents();
		const cutoffEventIds = new Set(
			this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				return id ? [id] : [];
			}),
		);
		const uploadEventIds = new Set(
			this.deferredEvents.flatMap((event) =>
				event.action === "upload" && cutoffEventIds.has(event.id)
					? [event.id]
					: [],
			),
		);
		this.preparedFullBarrier = {
			sessionId: context.sessionId,
			uploadEventIds,
			cutoffEventIds,
			renameCandidateIds: new Set(),
		};
		logger.info("Full sync watcher drain prepared", {
			sessionId: context.sessionId,
			cutoffEvents: cutoffEventIds.size,
			capturedUploads: uploadEventIds.size,
		});

		try {
			await this.waitForPersistence();
			if (this.deferredDrainPromise) await this.deferredDrainPromise;
			const destructiveIds = new Set(
				[...cutoffEventIds].filter(
					(id) => !uploadEventIds.has(id),
				),
			);
			if (destructiveIds.size > 0) {
				await this.flushDeferredEvents(destructiveIds);
			}
			const unresolved = this.deferredEvents.filter((event) => {
				const id = this.getEventId(event);
				return id !== null && destructiveIds.has(id);
			});
			const reconcilableIds =
				this.preparedFullBarrier?.renameCandidateIds ?? new Set<string>();
			const blocking = unresolved.filter((event) => {
				const id = this.getEventId(event);
				return id === null || !reconcilableIds.has(id);
			});
			if (blocking.length > 0 && !context.startup) {
				throw new Error(
					`Pre-full watcher drain left ${blocking.length} unresolved event(s)`,
				);
			}
			if (blocking.length > 0) {
				logger.warn("Startup continues with durable watcher work blocked", {
					sessionId: context.sessionId,
					unresolvedEvents: blocking.length,
				});
			}
			if (reconcilableIds.size > 0) {
				logger.info("Watcher rename deferred to full reconciliation", {
					sessionId: context.sessionId,
					candidates: reconcilableIds.size,
				});
			}
		} catch (error) {
			this.preparedFullBarrier = null;
			this.isPreparingFullSync = false;
			throw error;
		}
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
		this.isPreparingFullSync = false;
		logger.info("[FileWatcher] Paused for sync session", {
			sessionKind: context.kind,
		});

		this.drainPendingFileEvents();
		this.pausedEventSignatures = new Map(
			this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				return id ? [[id, this.getEventSignature(event)]] : [];
			}),
		);
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
		const pausedEventSignatures = this.pausedEventSignatures;
		this.pausedEventSignatures = null;
		this.completeFullSyncBarrier(outcome);
		await this.waitForPersistence();
		this.isPausedForSync = false;
		this.isPreparingFullSync = false;
		const replayIds = new Set(
			this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				if (!id) return [];
				const previous = pausedEventSignatures?.get(id);
				return previous === undefined ||
					previous !== this.getEventSignature(event)
					? [id]
					: [];
			}),
		);
		logger.info("[FileWatcher] Resumed after sync session", {
			sessionKind: outcome.kind,
			newEventsReplayed: outcome.success ? replayIds.size : 0,
		});
		if (this.deferredEvents.length === 0) return;
		if (!outcome.success) {
			logger.warn(
				"Deferred watcher replay postponed after failed sync session",
				{
					sessionId: outcome.sessionId,
					sessionKind: outcome.kind,
					pendingWatcherEvents: this.deferredEvents.length,
				},
			);
			return;
		}
		if (replayIds.size === 0) return;
		void this.flushDeferredEvents(replayIds).catch((e) => {
			logger.error("Failed to flush deferred watcher events:", {
				error: e,
			});
		});
	}

	/**
	 * Snapshot upload events that the upcoming full reconciliation will cover.
	 */
	private captureFullSyncBarrier(context: SyncLifecycleContext): void {
		const prepared = this.preparedFullBarrier;
		const uploadEventIds =
			prepared?.sessionId === context.sessionId
				? prepared.uploadEventIds
				: new Set(
						this.deferredEvents.flatMap((event) =>
							event.action === "upload" ? [event.id] : [],
						),
					);
		this.preparedFullBarrier = null;
		this.fullSyncBarrier = {
			sessionId: context.sessionId,
			uploadEventIds,
			renameCandidateIds:
				prepared?.sessionId === context.sessionId
					? prepared.renameCandidateIds
					: new Set(),
			alreadyAppliedRenames: 0,
			supersededRenames: 0,
			unresolvedRenames: 0,
		};
		logger.info("Full sync watcher barrier captured", {
			sessionId: context.sessionId,
			cutoffEvents: prepared?.cutoffEventIds.size ?? 0,
			capturedUploads: uploadEventIds.size,
			renameCandidates:
				this.fullSyncBarrier.renameCandidateIds.size,
			pendingWatcherEvents: this.deferredEvents.length,
		});
	}

	/**
	 * Settle missing-target rename candidates from the logical state selected by
	 * full reconciliation before the observed revision can advance.
	 */
	async settleAfterReconciliation(
		context: SyncLifecycleContext,
		result: SyncResult,
	): Promise<void> {
		const barrier = this.fullSyncBarrier;
		if (
			context.kind !== "full" ||
			!barrier ||
			barrier.sessionId !== context.sessionId ||
			result.errors.length > 0
		) {
			return;
		}

		for (const eventId of barrier.renameCandidateIds) {
			const event = this.deferredEvents.find(
				(candidate): candidate is DurableFileRenameEvent =>
					this.isDurableFileRename(candidate) &&
					candidate.id === eventId,
			);
			if (!event) continue;
			const outcome = this.syncEngine.classifyPostFullRename(event);
			if (outcome.status === "completed") {
				this.acknowledgeEvents([event.id]);
				barrier.alreadyAppliedRenames++;
				continue;
			}
			if (outcome.status === "superseded") {
				this.acknowledgeEvents([event.id]);
				barrier.supersededRenames++;
				continue;
			}
			barrier.unresolvedRenames++;
			result.errors.push({
				path: event.path,
				operation: "none",
				code: "watcher-rename-unresolved",
				message: `Watcher rename remains ambiguous after full reconciliation: ${outcome.reason ?? "unknown"}`,
			});
		}
		await this.waitForPersistence();
		logger[
			barrier.unresolvedRenames > 0 ? "warn" : "info"
		]("Post-full watcher rename settlement completed", {
			sessionId: context.sessionId,
			candidates: barrier.renameCandidateIds.size,
			alreadyApplied: barrier.alreadyAppliedRenames,
			superseded: barrier.supersededRenames,
			unresolved: barrier.unresolvedRenames,
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
				renameCandidates: barrier.renameCandidateIds.size,
				alreadyAppliedRenames: barrier.alreadyAppliedRenames,
				supersededRenames: barrier.supersededRenames,
				unresolvedRenames: barrier.unresolvedRenames,
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
		if (this.isWatcherFrozen()) {
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
		if (this.isWatcherFrozen()) {
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
		if (this.isWatcherFrozen()) {
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
		this.deferEvent({ action: "delete-folder", path: folder.path });
		if (!this.isWatcherFrozen()) this.scheduleDeferredReplay();
	}

	private handleFolderRename(folder: TFolder, oldPath: string): void {
		this.deferEvent({
			action: "rename",
			path: oldPath,
			targetPath: folder.path,
			kind: "folder",
		});
		if (!this.isWatcherFrozen()) this.scheduleDeferredReplay();
	}

	private deferEvent(
		event: DeferredWatcherEvent,
	): boolean {
		event = this.normalizeEvent(event);
		const before = this.deferredEvents.length;
		if (event.action === "rename" && event.kind === "file") {
			const queuedRenames = this.deferredEvents.filter(
				(candidate): candidate is DurableFileRenameEvent =>
					this.isDurableFileRename(candidate),
			);
			const reduction = reduceQueuedFileRename(
				queuedRenames,
				event as DurableFileRenameEvent,
				this.submittedWatcherEventIds,
			);
			if (reduction.disposition === "rebased") {
				const predecessor = reduction.events.find(
					(candidate) => candidate.id === reduction.predecessorId,
				);
				const chainedIndex = this.deferredEvents.findIndex(
					(candidate) =>
						this.getEventId(candidate) === reduction.predecessorId,
				);
				if (predecessor && chainedIndex >= 0) {
					this.deferredEvents[chainedIndex] = predecessor;
					logger.info("Watcher file rename chain rebased", {
						eventId: predecessor.id,
						oldPath: predecessor.path,
						intermediatePath: event.path,
						targetPath: event.targetPath,
						state: "rebased",
						pendingWatcherEvents: this.deferredEvents.length,
					});
					this.persistDeferredEvents();
					return true;
				}
			} else if (reduction.disposition === "running") {
				logger.info("Watcher rename successor queued behind running event", {
					eventId: event.id,
					predecessorId: reduction.predecessorId,
					oldPath: event.path,
					targetPath: event.targetPath,
					state: "running",
				});
			}
		}
		if (event.action === "upload") {
			const queuedRename = this.deferredEvents.find(
				(candidate) =>
					this.isDurableFileRename(candidate) &&
					candidate.targetPath === event.path &&
					!this.submittedWatcherEventIds.has(candidate.id),
			);
			if (queuedRename) {
				logger.info("Watcher modify absorbed by queued rename", {
					eventId: event.id,
					renameEventId: queuedRename.id,
					path: event.path,
					state: "superseded",
				});
				return false;
			}
		}
		if (event.action === "delete") {
			const predecessorIndex = this.deferredEvents.findIndex(
				(candidate) =>
					this.isDurableFileRename(candidate) &&
					candidate.targetPath === event.path &&
					!this.submittedWatcherEventIds.has(candidate.id),
			);
			const predecessor = this.deferredEvents[predecessorIndex];
			if (
				predecessorIndex >= 0 &&
				predecessor &&
				this.isDurableFileRename(predecessor)
			) {
				this.deferredEvents.splice(predecessorIndex, 1);
				event = {
					...event,
					path: predecessor.path,
					epoch: predecessor.epoch,
					baseRevision: predecessor.baseRevision,
				};
				logger.info("Queued rename reduced to source deletion", {
					eventId: event.id,
					predecessorId: predecessor.id,
					path: event.path,
					state: "rebased",
				});
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
			eventId: this.getEventId(event),
			action: event.action,
			path: event.path,
			targetPath:
				event.action === "rename" ? event.targetPath : undefined,
			coalescedEvents:
				before + 1 - this.deferredEvents.length,
			pendingWatcherEvents: this.deferredEvents.length,
		});
		this.persistDeferredEvents();
		return true;
	}

	private async flushDeferredEvents(
		onlyIds?: ReadonlySet<string>,
	): Promise<void> {
		if (this.deferredDrainPromise) {
			this.deferredReplayRequested = true;
			return await this.deferredDrainPromise;
		}
		this.deferredReplayRequested = false;
		const drain = this.flushDeferredEventsNow(onlyIds);
		this.deferredDrainPromise = drain;
		try {
			await drain;
		} finally {
			this.deferredDrainPromise = null;
			if (this.deferredReplayRequested && !this.isWatcherFrozen()) {
				this.deferredReplayRequested = false;
				this.scheduleDeferredReplay();
			}
		}
	}

	private async flushDeferredEventsNow(
		onlyIds?: ReadonlySet<string>,
	): Promise<void> {
		await this.waitForPersistence();
		const events = this.deferredEvents.filter(
			(event) => {
				const id = this.getEventId(event);
				if (onlyIds && (!id || !onlyIds.has(id))) return false;
				if (
					(event.action === "upload" || event.action === "delete") &&
					this.debounceTimers.get(event.path)?.event.id === event.id
				) {
					return false;
				}
				return (
				!(
					(event.action === "upload" || event.action === "delete") &&
					this.submittedFileEvents.has(event.id)
				) &&
				!(
					event.action === "rename" &&
					event.kind === "file" &&
					event.id &&
					this.submittedWatcherEventIds.has(event.id)
				)
				);
			},
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
		const flushFileBatch = async (): Promise<boolean> => {
			if (fileBatch.length === 0) return true;
			const batch = fileBatch;
			fileBatch = [];
			logger.debug("Replaying watcher file batch", {
				batchSize: batch.length,
				events: batch,
			});
			for (const event of batch) {
				this.submittedFileEvents.set(event.id, event);
				if (this.readyFileEvents.get(event.path)?.id === event.id) {
					this.readyFileEvents.delete(event.path);
				}
			}
			try {
				let settled = false;
				const result = await this.syncEngine.syncFileBatch(
					batch,
					async (settledResult, lifecycle) => {
						settled = true;
						await this.settleFileBatch(
							settledResult,
							replayResult,
							lifecycle,
						);
					},
				);
				if (!settled) {
					await this.settleFileBatch(result, replayResult);
				}
				return result.retry.length === 0;
			} finally {
				for (const event of batch) {
					this.submittedFileEvents.delete(event.id);
				}
			}
		};

		for (const event of events) {
			try {
				logger.debug("Replaying watcher event", {
					eventId: this.getEventId(event),
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
				if (!(await flushFileBatch())) break;
				if (event.action === "rename") {
					if (event.kind === "folder") {
						let settled = false;
						await this.syncEngine.renameFolder(
							event.path,
							event.targetPath,
							async () => {
								settled = true;
								this.acknowledgeLegacyEvent(event);
								await this.waitForPersistence();
							},
						);
						if (!settled) this.acknowledgeLegacyEvent(event);
					} else {
						if (event.id) {
							this.submittedWatcherEventIds.add(event.id);
						}
						try {
							let settled = false;
							const outcome = await this.syncEngine.renameFile(
								event.path,
								event.targetPath,
								this.getEventContext(event),
								async (renameOutcome, lifecycle) => {
									settled = true;
									await this.settleRenameEvent(
										event as DurableFileRenameEvent,
										renameOutcome,
										lifecycle,
										replayResult,
									);
								},
							);
							if (!settled) {
								await this.settleRenameEvent(
									event as DurableFileRenameEvent,
									outcome,
									undefined,
									replayResult,
								);
							}
							if (
								outcome.status === "retry" &&
								this.deferredEvents.some(
									(candidate) =>
										this.getEventId(candidate) === event.id,
								)
							) {
								break;
							}
						} finally {
							if (event.id) {
								this.submittedWatcherEventIds.delete(event.id);
							}
						}
					}
				} else if (event.action === "delete-folder") {
					let settled = false;
					await this.syncEngine.deleteFolder(event.path, async () => {
						settled = true;
						this.acknowledgeLegacyEvent(event);
						await this.waitForPersistence();
					});
					if (!settled) this.acknowledgeLegacyEvent(event);
				}
			} catch (e) {
				const eventId = this.getEventId(event);
				if (eventId && !replayResult.retry.includes(eventId)) {
					replayResult.retry.push(eventId);
				}
				logger.error(
					`Deferred watcher event failed for ${event.path}:`,
					{ error: e },
				);
				break;
			}
		}
		await flushFileBatch();
		this.persistDeferredEvents();
		const deferredToFull =
			this.preparedFullBarrier?.renameCandidateIds.size ?? 0;
		logger[replayResult.retry.length > 0 ? "warn" : "info"](
			"Durable watcher event replay completed",
			{
				replayedEvents: events.length,
				completed: replayResult.completed.length,
				superseded: replayResult.superseded.length,
				retry: replayResult.retry.length,
				deferredToFull,
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
		const retained = this.deferEvent(event);
		this.cancelPendingSync(path);
		if (!retained) return;

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
			void this.flushDeferredEvents().catch((error) => {
				logger.error("Error synchronizing realtime watcher drain:", {
					error,
				});
			});
		}, 75);
	}

	private scheduleDeferredReplay(): void {
		if (this.deferredReplayTimer || this.isWatcherFrozen()) return;
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

	private async settleFileBatch(
		result: RealtimeBatchResult,
		replayResult: RealtimeBatchResult,
		lifecycle?: SyncLifecycleContext,
	): Promise<void> {
		this.applyBatchResult(result);
		replayResult.completed.push(...result.completed);
		replayResult.superseded.push(...result.superseded);
		replayResult.retry.push(...result.retry);
		await this.waitForPersistence();
		logger.debug("Realtime file batch settled in coordinator", {
			sessionId: lifecycle?.sessionId ?? null,
			completed: result.completed.length,
			superseded: result.superseded.length,
			retry: result.retry.length,
			pendingWatcherEvents: this.deferredEvents.length,
		});
	}

	private async settleRenameEvent(
		event: DurableFileRenameEvent,
		outcome: FileRenameOutcome,
		lifecycle?: SyncLifecycleContext,
		replayResult?: RealtimeBatchResult,
	): Promise<void> {
		const successor = this.deferredEvents.find(
			(candidate): candidate is DurableFileRenameEvent =>
				this.isDurableFileRename(candidate) &&
				candidate.id !== event.id &&
				candidate.path === event.targetPath,
		);
		if (
			outcome.status === "retry" &&
			!outcome.remoteStarted &&
			outcome.reason === "target-missing-before-remote" &&
			successor
		) {
			successor.path = event.path;
			successor.epoch = event.epoch;
			successor.baseRevision = event.baseRevision;
			this.acknowledgeEvents([event.id]);
			replayResult?.superseded.push(event.id);
			await this.waitForPersistence();
			logger.info("Running watcher rename safely rebased", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				successorId: successor.id,
				oldPath: event.path,
				targetPath: successor.targetPath,
				state: "rebased",
			});
			return;
		}
		if (
			outcome.status === "retry" &&
			!outcome.remoteStarted &&
			outcome.reason === "target-missing-before-remote" &&
			this.preparedFullBarrier?.cutoffEventIds.has(event.id)
		) {
			this.preparedFullBarrier.renameCandidateIds.add(event.id);
			logger.info("Watcher rename awaits post-full settlement", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				oldPath: event.path,
				targetPath: event.targetPath,
				reason: outcome.reason,
			});
			return;
		}

		if (outcome.status === "retry") {
			if (!replayResult?.retry.includes(event.id)) {
				replayResult?.retry.push(event.id);
			}
			logger.warn("Watcher rename remains durable for retry", {
				sessionId: lifecycle?.sessionId ?? null,
				eventId: event.id,
				oldPath: event.path,
				targetPath: event.targetPath,
				reason: outcome.reason,
				remoteStarted: outcome.remoteStarted,
			});
			return;
		}

		if (successor && outcome.canonicalRevision !== null) {
			successor.baseRevision = outcome.canonicalRevision;
			successor.epoch = outcome.epoch;
		}
		this.acknowledgeEvents([event.id]);
		if (outcome.status === "superseded") {
			replayResult?.superseded.push(event.id);
		} else {
			replayResult?.completed.push(event.id);
		}
		await this.waitForPersistence();
		logger.info("Watcher rename settled in coordinator", {
			sessionId: lifecycle?.sessionId ?? null,
			eventId: event.id,
			status: outcome.status,
			plan: outcome.plan,
			canonicalRevision: outcome.canonicalRevision,
			successorId: successor?.id ?? null,
			pendingWatcherEvents: this.deferredEvents.length,
		});
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
		const context = this.getEventContext(event);
		return {
			...event,
			id: event.id ?? this.createEventId(),
			...context,
			createdAt: event.createdAt ?? Date.now(),
		};
	}

	private getEventId(event: DeferredWatcherEvent): string | null {
		return "id" in event && event.id ? event.id : null;
	}

	private getEventSignature(event: DeferredWatcherEvent): string {
		return [
			event.action,
			event.path,
			event.action === "rename" ? event.targetPath : "",
			event.action === "rename" ? event.kind : "",
			"epoch" in event ? (event.epoch ?? "") : "",
			"baseRevision" in event
				? (event.baseRevision?.toString() ?? "")
				: "",
		].join("\u0000");
	}

	private isDurableFileRename(
		event: DeferredWatcherEvent,
	): event is DurableFileRenameEvent {
		return (
			event.action === "rename" &&
			event.kind === "file" &&
			typeof event.id === "string" &&
			typeof event.createdAt === "number" &&
			"epoch" in event &&
			"baseRevision" in event
		);
	}

	private isWatcherFrozen(): boolean {
		return this.isPausedForSync || this.isPreparingFullSync;
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

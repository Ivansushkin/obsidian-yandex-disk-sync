/**
 * File change tracking for real-time synchronization
 */

import { App, TFile, TFolder, EventRef } from "obsidian";
import type { SyncEngine } from "../engine";
import type { SyncLifecycleContext, SyncLifecycleOutcome } from "../contracts";
import type { SyncResult, YandexDiskSyncSettings } from "../../types";
import { logger } from "../../utils/logger";
import {
	independentRenamePrefix,
	MAX_RENAME_BATCH_EVENTS,
} from "./rename-batch";
import {
	type DurableFileRenameEvent,
	type DurableRenameEvent,
	type RenameBatchResult,
	type RealtimeBatchResult,
	type RealtimeFileEvent,
	type UploadCausalReceipt,
	type WatcherCausalContext,
} from "./rules";

import { WatcherSettlement } from "./settlement";
import {
	reduceWatcherQueue,
	reduceUploadCausalReceipts,
	partitionFolderRenameQueue,
	retargetFolderDescendants,
	type DeferredWatcherEvent,
	type WatcherQueueEvent,
	type WatcherQueueContext,
} from "./queue-rules";

export type { DeferredWatcherEvent } from "./queue-rules";

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
	private startGeneration = 0;
	private isEnabled = false;
	private isLayoutReady = false;
	private isPausedForSync = false;
	private isPreparingFullSync = false;
	private syncPauseDepth = 0;
	private recentFolderDeletes = new Map<
		string,
		{ expiresAt: number; successors: WeakSet<TFile> }
	>();
	private mechanicalFolderRenames = new Map<
		string,
		{ targetPath: string; eventId: string }
	>();
	private deferredEvents: WatcherQueueEvent[] = [];
	private persistCallback: (() => void | Promise<void>) | null = null;
	private fullSyncRequestCallback: (() => void | Promise<void>) | null = null;
	private epochReplacementObserved = false;
	private epochFullSyncRequest: Promise<void> | null = null;
	private persistPromise: Promise<void> | null = null;
	private dirtyPersistRevision = 0;
	private savedPersistRevision = 0;
	private persistFailure: { cause: unknown } | null = null;
	private fullSyncBarrier: {
		sessionId: string;
		initialReceive: boolean;
		cutoffEventIds: Set<string>;
		uploadEventIds: Set<string>;
		renameCandidateIds: Set<string>;
		alreadyAppliedRenames: number;
		supersededRenames: number;
		unresolvedRenames: number;
	} | null = null;
	private preparedFullBarrier: {
		sessionId: string;
		initialReceive: boolean;
		uploadEventIds: Set<string>;
		cutoffEventIds: Set<string>;
		renameCandidateIds: Set<string>;
		causalChainIds: Set<string>;
	} | null = null;
	private pausedEventSignatures: Map<string, string> | null = null;
	private readonly settlement = new WatcherSettlement({
		getEvents: () => this.deferredEvents,
		applyBatchResult: (result) => this.applyBatchResult(result),
		acknowledgeEvents: (ids) => this.acknowledgeEvents(ids),
		waitForPersistence: () => this.waitForPersistence(),
		observeEpochReplacement: () => {
			this.epochReplacementObserved = true;
		},
		deferRenameToFull: (eventId) => {
			if (!this.preparedFullBarrier?.cutoffEventIds.has(eventId)) {
				return false;
			}
			this.preparedFullBarrier.renameCandidateIds.add(eventId);
			return true;
		},
	});

	constructor(
		app: App,
		syncEngine: SyncEngine,
		settings: YandexDiskSyncSettings,
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
		if (!settings.enableRealtimeSync) {
			this.stop();
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

	/** Retire only events covered by the confirmed Force snapshot before releasing the coordinator. */
	async settleForceReplacement(cutoff: string[]): Promise<void> {
		this.acknowledgeEvents(cutoff);
		this.epochReplacementObserved = false;
		await this.waitForPersistence();
	}

	setPersistCallback(callback: () => void | Promise<void>): void {
		this.persistCallback = callback;
	}

	/** Request one coalesced full reconciliation after realtime sees a new epoch. */
	setFullSyncRequestCallback(callback: () => void | Promise<void>): void {
		this.fullSyncRequestCallback = callback;
	}

	/**
	 * Freeze realtime scheduling and settle destructive work that predates a
	 * full-sync request before that full session enters the coordinator queue.
	 */
	async prepareForSync(context: SyncLifecycleContext): Promise<void> {
		if (context.kind !== "full") {
			return;
		}
		this.isPreparingFullSync = true;
		this.drainPendingFileEvents();
		const cutoffEventIds = new Set(
			this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				return id ? [id] : [];
			}),
		);
		const causalChainIds = new Set(
			this.deferredEvents.flatMap((event) =>
				this.isDurableFileRename(event) &&
				event.predecessorUploadId &&
				cutoffEventIds.has(event.id)
					? [event.id, event.predecessorUploadId]
					: [],
			),
		);
		const uploadEventIds = new Set(
			this.deferredEvents.flatMap((event) =>
				event.action === "upload" &&
				cutoffEventIds.has(event.id) &&
				!causalChainIds.has(event.id)
					? [event.id]
					: [],
			),
		);
		this.preparedFullBarrier = {
			sessionId: context.sessionId,
			initialReceive:
				this.syncEngine.isInitialRemoteReceivePending?.() ?? false,
			uploadEventIds,
			cutoffEventIds,
			renameCandidateIds: new Set(),
			causalChainIds,
		};
		logger.info("Full sync watcher drain prepared", {
			sessionId: context.sessionId,
			cutoffEvents: cutoffEventIds.size,
			capturedUploads: uploadEventIds.size,
			causalChainEvents: causalChainIds.size,
		});
		this.syncEngine.showFullQueueWaitPhase(context.sessionId);

		try {
			await this.waitForPersistence();
			if (this.deferredDrainPromise) {
				await this.deferredDrainPromise;
			}
			const destructiveIds = new Set(
				this.preparedFullBarrier?.initialReceive
					? []
					: [...cutoffEventIds].filter(
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
				this.preparedFullBarrier?.renameCandidateIds ??
				new Set<string>();
			const blocking = unresolved.filter((event) => {
				const id = this.getEventId(event);
				return id === null || !reconcilableIds.has(id);
			});
			if (this.epochReplacementObserved) {
				blocking.length = 0;
				logger.info(
					"Pre-full watcher work deferred to epoch adoption",
					{
						sessionId: context.sessionId,
						cutoffEvents: cutoffEventIds.size,
					},
				);
			}
			const unresolvedCausalChain = blocking.some((event) => {
				const id = this.getEventId(event);
				return id !== null && causalChainIds.has(id);
			});
			if (
				blocking.length > 0 &&
				(!context.startup || unresolvedCausalChain)
			) {
				throw new Error(
					`Pre-full watcher drain left ${blocking.length} unresolved event(s)`,
				);
			}
			if (blocking.length > 0) {
				logger.warn(
					"Startup continues with durable watcher work blocked",
					{
						sessionId: context.sessionId,
						unresolvedEvents: blocking.length,
					},
				);
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
		this.syncPauseDepth++;
		if (this.syncPauseDepth > 1) {
			return;
		}
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
		this.syncPauseDepth = Math.max(0, this.syncPauseDepth - 1);
		if (this.syncPauseDepth > 0) {
			return;
		}
		const pausedEventSignatures = this.pausedEventSignatures;
		this.pausedEventSignatures = null;
		this.completeFullSyncBarrier(outcome);
		await this.waitForPersistence();
		this.isPausedForSync = false;
		this.isPreparingFullSync = false;
		const replayIds = new Set(
			this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				if (!id) {
					return [];
				}
				const previous = pausedEventSignatures?.get(id);
				return previous === undefined ||
					previous !== this.getEventSignature(event)
					? [id]
					: [];
			}),
		);
		if (outcome.success && outcome.epochAdopted) {
			const context = this.syncEngine.getWatcherCausalContext();
			for (const event of this.deferredEvents) {
				const id = this.getEventId(event);
				if (!id || !replayIds.has(id)) {
					continue;
				}
				event.epoch = context.epoch;
				event.baseRevision = context.baseRevision;
				if (event.action === "upload") {
					event.mutationId = undefined;
					event.mutationSeq = undefined;
				}
				if (
					event.action === "delete-folder" ||
					(event.action === "rename" && event.kind === "folder")
				) {
					event.mutationId = undefined;
					event.mutationSeq = undefined;
				}
				if (
					event.action === "rename" &&
					event.kind === "file" &&
					event.predecessorUploadId &&
					!this.deferredEvents.some(
						(candidate) =>
							this.getEventId(candidate) ===
							event.predecessorUploadId,
					)
				) {
					event.predecessorUploadId = undefined;
				}
			}
			this.persistDeferredEvents();
			await this.waitForPersistence();
		}
		logger.info("[FileWatcher] Resumed after sync session", {
			sessionKind: outcome.kind,
			newEventsReplayed: outcome.success ? replayIds.size : 0,
		});
		if (!this.isEnabled || this.deferredEvents.length === 0) {
			return;
		}
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
		if (replayIds.size === 0) {
			return;
		}
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
			initialReceive: prepared?.initialReceive ?? false,
			cutoffEventIds:
				prepared?.sessionId === context.sessionId
					? prepared.cutoffEventIds
					: new Set(),
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
			renameCandidates: this.fullSyncBarrier.renameCandidateIds.size,
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
		if (
			result.errors.some(
				(error) => error.code === "epoch-decision-required",
			)
		) {
			this.epochReplacementObserved = true;
		}
		const barrier = this.fullSyncBarrier;
		if (
			context.kind !== "full" ||
			!barrier ||
			barrier.sessionId !== context.sessionId ||
			result.errors.length > 0
		) {
			return;
		}
		if (result.epochAdopted) {
			this.acknowledgeEvents([...barrier.cutoffEventIds]);
			this.epochReplacementObserved = false;
			await this.waitForPersistence();
			logger.info("Watcher events settled by epoch adoption", {
				sessionId: context.sessionId,
				acknowledgedEvents: barrier.cutoffEventIds.size,
				pendingWatcherEvents: this.deferredEvents.length,
			});
			return;
		}
		if (barrier.initialReceive) {
			const settled = this.deferredEvents.flatMap((event) => {
				const id = this.getEventId(event);
				return id &&
					barrier.cutoffEventIds.has(id) &&
					this.pausedEventSignatures?.get(id) ===
						this.getEventSignature(event)
					? [id]
					: [];
			});
			this.acknowledgeEvents(settled);
			await this.waitForPersistence();
			return;
		}

		for (const eventId of barrier.renameCandidateIds) {
			const event = this.deferredEvents.find(
				(candidate): candidate is DurableFileRenameEvent =>
					this.isDurableFileRename(candidate) &&
					candidate.id === eventId,
			);
			if (!event) {
				continue;
			}
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
		logger[barrier.unresolvedRenames > 0 ? "warn" : "info"](
			"Post-full watcher rename settlement completed",
			{
				sessionId: context.sessionId,
				candidates: barrier.renameCandidateIds.size,
				alreadyApplied: barrier.alreadyAppliedRenames,
				superseded: barrier.supersededRenames,
				unresolved: barrier.unresolvedRenames,
				pendingWatcherEvents: this.deferredEvents.length,
			},
		);
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
		if (this.settings.manualSyncRequired) {
			return;
		}
		logger.info("[FileWatcher] Attempting to start FileWatcher");

		if (this.isEnabled) {
			logger.info("[FileWatcher] FileWatcher already running");
			return;
		}

		if (!this.settings.enableRealtimeSync) {
			logger.info("[FileWatcher] Real-time sync disabled in settings");
			return;
		}

		const generation = ++this.startGeneration;
		// Wait for layout to be ready
		if (!this.app.workspace.layoutReady) {
			this.app.workspace.onLayoutReady(() => {
				if (generation !== this.startGeneration || !this.isEnabled) {
					return;
				}
				this.isLayoutReady = true;
				this.registerEvents();
			});
		} else {
			this.isLayoutReady = true;
			this.registerEvents();
		}

		this.isEnabled = true;
		logger.info("FileWatcher started");
		if (this.deferredEvents.length > 0) {
			this.scheduleDeferredReplay();
		}
	}

	/**
	 * Stop tracking
	 */
	stop(): void {
		this.startGeneration++;
		if (!this.isEnabled) {
			return;
		}

		this.drainPendingFileEvents();

		// Unsubscribe from events
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
		}
		this.eventRefs = [];
		this.mechanicalFolderRenames.clear();
		this.recentFolderDeletes.clear();

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
			if (!this.isLayoutReady) {
				return;
			}
			if (file instanceof TFile) {
				this.handleFileCreate(file);
			}
		});
		this.eventRefs.push(createRef);

		// File modification
		const modifyRef = this.app.vault.on("modify", (file) => {
			if (!this.isLayoutReady) {
				return;
			}
			if (file instanceof TFile) {
				this.handleFileModify(file);
			}
		});
		this.eventRefs.push(modifyRef);

		// File deletion
		const deleteRef = this.app.vault.on("delete", (file) => {
			if (!this.isLayoutReady) {
				return;
			}
			if (file instanceof TFile) {
				this.handleFileDelete(file);
			} else if (file instanceof TFolder) {
				this.handleFolderDelete(file);
			}
		});
		this.eventRefs.push(deleteRef);

		// File rename
		const renameRef = this.app.vault.on("rename", (file, oldPath) => {
			if (!this.isLayoutReady) {
				return;
			}
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
		this.observeLiveDescendant(file);
		if (this.syncEngine.consumeInternalWatcherEvent(file.path, "upload")) {
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
		for (const [prefix, deletion] of this.recentFolderDeletes) {
			if (deletion.expiresAt < now) {
				this.recentFolderDeletes.delete(prefix);
				continue;
			}
			if (
				file.path.startsWith(prefix) &&
				!deletion.successors.has(file)
			) {
				return;
			}
		}
		if (this.syncEngine.consumeInternalWatcherEvent(file.path, "delete")) {
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
		this.observeLiveDescendant(file);
		if (this.isMechanicalFolderChild(oldPath, file.path)) {
			return;
		}
		const context = this.syncEngine.getWatcherCausalContext();
		const predecessorUpload = [...this.submittedFileEvents.values()]
			.filter(
				(event) => event.action === "upload" && event.path === oldPath,
			)
			.sort((left, right) => right.createdAt - left.createdAt)[0];
		const event: DeferredWatcherEvent = {
			action: "rename",
			path: oldPath,
			targetPath: file.path,
			kind: "file",
			id: this.createEventId(),
			...context,
			createdAt: Date.now(),
			predecessorUploadId: predecessorUpload?.id,
		};
		if (predecessorUpload) {
			predecessorUpload.superseded = true;
			predecessorUpload.supersededByRenameId = event.id;
		}
		this.deferEvent(event);
		this.cancelPendingSync(oldPath);
		if (this.isWatcherFrozen()) {
			return;
		}

		logger.debug(`File renamed: ${oldPath} -> ${file.path}`);
		this.scheduleDeferredReplay();
	}

	private handleFolderDelete(folder: TFolder): void {
		this.recentFolderDeletes.set(`${folder.path.replace(/\/+$/, "")}/`, {
			expiresAt:
				Date.now() + Math.max(2_000, this.settings.debounceDelay * 2),
			successors: new WeakSet(),
		});
		const absorbedDescendantEvents = this.cancelPendingDescendants(
			folder.path,
		);
		logger.info(`[FileWatcher] Folder deleted: ${folder.path}`, {
			absorbedDescendantEvents,
		});
		this.deferEvent({ action: "delete-folder", path: folder.path });
		if (!this.isWatcherFrozen()) {
			this.scheduleDeferredReplay();
		}
	}

	/** Exempt live successors while keeping late deletes of old file objects mechanical. */
	private observeLiveDescendant(entry: TFile | TFolder): void {
		if (this.recentFolderDeletes.size === 0) {
			return;
		}
		if (entry instanceof TFolder) {
			for (const child of entry.children) {
				if (child instanceof TFile || child instanceof TFolder) {
					this.observeLiveDescendant(child);
				}
			}
			return;
		}
		if (this.app.vault.getAbstractFileByPath(entry.path) !== entry) {
			return;
		}
		const now = Date.now();
		for (const [prefix, deletion] of this.recentFolderDeletes) {
			if (deletion.expiresAt < now) {
				this.recentFolderDeletes.delete(prefix);
			} else if (entry.path.startsWith(prefix)) {
				deletion.successors.add(entry);
			}
		}
	}

	/** Ignore descendant notifications already represented by a queued parent move. */
	private isMechanicalFolderChild(oldPath: string, newPath: string): boolean {
		for (const [source, move] of this.mechanicalFolderRenames) {
			if (
				!this.deferredEvents.some(
					(event) => this.getEventId(event) === move.eventId,
				)
			) {
				this.mechanicalFolderRenames.delete(source);
				continue;
			}
			if (
				oldPath.startsWith(`${source}/`) &&
				newPath === move.targetPath + oldPath.slice(source.length)
			) {
				return true;
			}
		}
		return false;
	}

	private handleFolderRename(folder: TFolder, oldPath: string): void {
		this.observeLiveDescendant(folder);
		if (this.isMechanicalFolderChild(oldPath, folder.path)) {
			return;
		}
		this.drainPendingFileEvents();
		const { retained, descendants, coalescedParent } =
			partitionFolderRenameQueue(
				this.deferredEvents,
				oldPath,
				this.queueContext(),
			);
		this.deferredEvents = retained;
		this.deferEvent({
			action: "rename",
			path: oldPath,
			targetPath: folder.path,
			kind: "folder",
		});
		const parent = this.deferredEvents.find(
			(event) =>
				event.action === "rename" &&
				event.kind === "folder" &&
				event.targetPath === folder.path,
		);
		if (parent?.id) {
			this.mechanicalFolderRenames.set(oldPath, {
				targetPath: folder.path,
				eventId: parent.id,
			});
		}
		const { predecessors, successors } = retargetFolderDescendants(
			descendants,
			oldPath,
			folder.path,
			parent?.id,
			coalescedParent,
		);
		for (const successor of successors) {
			this.deferEvent(successor);
		}
		if (parent && predecessors.length > 0) {
			this.deferredEvents.splice(
				this.deferredEvents.indexOf(parent),
				0,
				...predecessors,
			);
			this.persistDeferredEvents();
		}
		if (!this.isWatcherFrozen()) {
			this.scheduleDeferredReplay();
		}
	}

	private queueContext(): WatcherQueueContext {
		return {
			submittedFileIds: new Set(this.submittedFileEvents.keys()),
			submittedWatcherIds: this.submittedWatcherEventIds,
		};
	}

	private deferEvent(incoming: DeferredWatcherEvent): boolean {
		const event = this.normalizeEvent(incoming);
		const before = this.deferredEvents.length;
		const reduction = reduceWatcherQueue(
			this.deferredEvents,
			event,
			this.queueContext(),
		);
		this.deferredEvents = reduction.events;
		const reduced = reduction.event;
		if (reduction.folderChild?.ambiguous) {
			logger.warn("Child rename has ambiguous folder parent", {
				eventId: event.id,
				oldPath: event.path,
				targetPath:
					event.action === "rename" ? event.targetPath : undefined,
				parentEventId: reduction.folderChild.parentId,
			});
		}
		if (reduction.disposition === "absorbed") {
			logger.info(
				event.action === "upload"
					? "Watcher modify absorbed by queued rename"
					: "Mechanical child rename absorbed by folder move",
				{
					eventId: event.id,
					path: event.path,
					renameEventId: reduction.deletedRenameId,
					parentEventId: reduction.folderChild?.parentId,
					state: "superseded",
				},
			);
			return false;
		}
		if (reduction.chain && reduced.action === "rename") {
			logger.info(
				reduced.kind === "folder"
					? "Watcher folder rename chain reduced"
					: "Watcher file rename chain reduced",
				{
					eventId: reduced.id,
					predecessorId: reduction.chain.predecessorId,
					oldPath: reduced.path,
					intermediatePath: event.path,
					targetPath: reduced.targetPath,
					state: reduction.chain.disposition,
					absorbedChildren: reduction.absorbedChildren,
				},
			);
		}
		if (reduction.absorbedChildren > 0) {
			logger.info("Folder move absorbed mechanical child renames", {
				eventId: event.id,
				oldPath: event.path,
				absorbedChildren: reduction.absorbedChildren,
			});
		}
		if (reduction.deletedRenameId) {
			logger.info("Queued rename reduced to source deletion", {
				eventId: reduced.id,
				predecessorId: reduction.deletedRenameId,
				path: reduced.path,
				state: "rebased",
			});
		}
		if (reduction.absorbedDescendantEvents !== undefined) {
			logger.info("Folder delete absorbed earlier descendant events", {
				eventId: reduced.id,
				path: reduced.path,
				absorbedDescendantEvents: reduction.absorbedDescendantEvents,
			});
		}
		logger.debug("Watcher event persisted for replay", {
			eventId: reduced.id,
			action: reduced.action,
			path: reduced.path,
			targetPath:
				reduced.action === "rename" ? reduced.targetPath : undefined,
			coalescedEvents: before + 1 - this.deferredEvents.length,
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

	/** Submit adjacent independent events and persist their outcomes before releasing the session. */
	private async replayRenameBatch(
		events: WatcherQueueEvent[],
		start: number,
		replayResult: RealtimeBatchResult,
	): Promise<RenameBatchResult | null> {
		if (!this.syncEngine.renameBatch) {
			return null;
		}
		const adjacent: DurableRenameEvent[] = [];
		let queueIndex = this.deferredEvents.indexOf(events[start]!);
		for (
			let i = start;
			i < events.length && adjacent.length < MAX_RENAME_BATCH_EVENTS;
			i++, queueIndex++
		) {
			const candidate = events[i]!;
			if (
				candidate !== this.deferredEvents[queueIndex] ||
				candidate.action !== "rename" ||
				!candidate.id ||
				this.submittedWatcherEventIds.has(candidate.id)
			) {
				break;
			}
			adjacent.push(candidate as DurableRenameEvent);
		}
		const candidates = independentRenamePrefix(adjacent);
		if (candidates.length < 2) {
			return null;
		}
		const originals = new Map(
			candidates.map((candidate) => [candidate.id, candidate]),
		);
		for (const candidate of candidates) {
			this.submittedWatcherEventIds.add(candidate.id);
		}
		try {
			return await this.syncEngine.renameBatch(
				candidates,
				async (outcomes, lifecycle) => {
					for (const item of outcomes) {
						const original = originals.get(item.eventId)!;
						if (item.kind === "file") {
							await this.settlement.settleRenameEvent(
								original as DurableFileRenameEvent,
								item.outcome,
								lifecycle,
								replayResult,
							);
						} else {
							await this.settlement.settleFolderEvent(
								original,
								item.outcome,
								replayResult,
							);
						}
					}
				},
			);
		} finally {
			for (const candidate of candidates) {
				this.submittedWatcherEventIds.delete(candidate.id);
			}
		}
	}

	/** Submit one file prefix and durably settle it while its runtime references are protected. */
	private async replayFileBatch(
		batch: RealtimeFileEvent[],
		replayResult: RealtimeBatchResult,
	): Promise<boolean> {
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
					await this.settlement.settleFileBatch(
						settledResult,
						replayResult,
						lifecycle,
					);
				},
			);
			if (!settled) {
				await this.settlement.settleFileBatch(result, replayResult);
			}
			return result.retry.length === 0;
		} finally {
			for (const event of batch) {
				this.submittedFileEvents.delete(event.id);
			}
		}
	}

	private async flushDeferredEventsNow(
		onlyIds?: ReadonlySet<string>,
	): Promise<void> {
		await this.waitForPersistence();
		if (
			this.epochReplacementObserved ||
			this.syncEngine.isInitialRemoteReceivePending?.()
		) {
			return;
		}
		const events = this.deferredEvents.filter((event) => {
			const id = this.getEventId(event);
			if (onlyIds && (!id || !onlyIds.has(id))) {
				return false;
			}
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
		});
		logger.info("Replaying durable watcher events", {
			watcherEvents: events.length,
		});
		const replayResult: RealtimeBatchResult = {
			completed: [],
			superseded: [],
			retry: [],
			uploadReceipts: [],
		};
		let fileBatch: RealtimeFileEvent[] = [];
		const flushFileBatch = async (): Promise<boolean> => {
			if (fileBatch.length === 0) {
				return true;
			}
			const batch = fileBatch;
			fileBatch = [];
			return await this.replayFileBatch(batch, replayResult);
		};

		for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
			const event = events[eventIndex]!;
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
				if (!(await flushFileBatch())) {
					break;
				}
				if (event.action === "rename") {
					const batch = await this.replayRenameBatch(
						events,
						eventIndex,
						replayResult,
					);
					if (batch) {
						eventIndex += batch.length - 1;
						if (
							batch.some(
								(item) => item.outcome.status === "retry",
							)
						) {
							break;
						}
						continue;
					}
					if (event.kind === "folder") {
						if (event.id) {
							this.submittedWatcherEventIds.add(event.id);
						}
						try {
							const outcome = await this.syncEngine.renameFolder(
								event.path,
								event.targetPath,
								this.getEventContext(event),
								async (prepared) => {
									event.mutationId = prepared.mutationId;
									event.mutationSeq = prepared.mutationSeq;
									this.persistDeferredEvents();
									await this.waitForPersistence();
								},
							);
							await this.settlement.settleFolderEvent(
								event,
								outcome,
								replayResult,
							);
						} finally {
							if (event.id) {
								this.submittedWatcherEventIds.delete(event.id);
							}
						}
					} else {
						if (event.folderParentAmbiguous) {
							if (
								event.id &&
								!replayResult.retry.includes(event.id)
							) {
								replayResult.retry.push(event.id);
							}
							logger.warn(
								"Ambiguous child rename remains durable",
								{
									eventId: event.id,
									oldPath: event.path,
									targetPath: event.targetPath,
								},
							);
							break;
						}
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
									await this.settlement.settleRenameEvent(
										event,
										renameOutcome,
										lifecycle,
										replayResult,
									);
								},
							);
							if (!settled) {
								await this.settlement.settleRenameEvent(
									event,
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
					const outcome = await this.syncEngine.deleteFolder(
						event.path,
						this.getEventContext(event),
						async (prepared) => {
							event.mutationId = prepared.mutationId;
							event.mutationSeq = prepared.mutationSeq;
							this.persistDeferredEvents();
							await this.waitForPersistence();
						},
					);
					await this.settlement.settleFolderEvent(
						event,
						outcome,
						replayResult,
					);
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
		if (this.syncEngine.consumeEpochReplacementRequest?.()) {
			this.epochReplacementObserved = true;
			this.requestEpochFullSync();
		}
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

	private requestEpochFullSync(): void {
		if (!this.fullSyncRequestCallback || this.epochFullSyncRequest) {
			return;
		}
		const request = Promise.resolve(this.fullSyncRequestCallback()).then(
			() => undefined,
		);
		this.epochFullSyncRequest = request.finally(() => {
			if (this.epochFullSyncRequest === tracked) {
				this.epochFullSyncRequest = null;
			}
		});
		const tracked = this.epochFullSyncRequest;
	}

	/** Coalesce waiting requests while retaining a new revision for arrivals during a save. */
	private persistDeferredEvents(): void {
		if (!this.persistCallback) {
			return;
		}
		this.dirtyPersistRevision++;
		if (this.persistPromise) {
			return;
		}
		const save = Promise.resolve().then(async () => {
			try {
				while (this.savedPersistRevision < this.dirtyPersistRevision) {
					const revision = this.dirtyPersistRevision;
					const pendingWatcherEvents = this.deferredEvents.length;
					try {
						await this.persistCallback?.();
					} catch (error) {
						this.persistFailure = { cause: error };
						logger.error(
							"Could not persist deferred watcher events:",
							{
								pendingWatcherEvents,
								error,
							},
						);
						throw error;
					}
					this.savedPersistRevision = revision;
					this.persistFailure = null;
					logger.debug("Durable watcher event queue saved", {
						pendingWatcherEvents,
					});
				}
			} finally {
				// Release with the last dirty check, before another microtask can request a save.
				this.persistPromise = null;
			}
		});
		this.persistPromise = save;
		// Event handlers are synchronous; durability callers still receive the rejection.
		void save.catch(() => undefined);
	}

	/** Drain stopped watcher persistence before changing its connection context. */
	async waitForPendingPersistence(retryFailed = false): Promise<void> {
		if (retryFailed && this.persistFailure) {
			this.persistDeferredEvents();
		}
		await this.waitForPersistence();
		if (this.deferredDrainPromise) {
			await this.deferredDrainPromise;
		}
		await this.waitForPersistence();
	}

	/**
	 * Wait until the durable event queue is confirmed on local storage.
	 */
	private async waitForPersistence(): Promise<void> {
		while (this.savedPersistRevision < this.dirtyPersistRevision) {
			if (this.persistPromise) {
				await this.persistPromise;
			} else if (this.persistFailure) {
				throw this.persistFailure.cause;
			}
		}
	}

	/**
	 * Schedule sync with debounce
	 */
	private scheduleSync(path: string, action: "upload" | "delete"): void {
		const event = this.createFileEvent(path, action);
		const retained = this.deferEvent(event);
		this.cancelPendingSync(path);
		if (!retained) {
			return;
		}

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
			if (event.path !== path) {
				continue;
			}
			event.superseded = true;
		}
	}

	private cancelPendingDescendants(folderPath: string): number {
		const prefix = `${folderPath.replace(/\/+$/, "")}/`;
		let cancelled = 0;
		for (const [path, pending] of this.debounceTimers) {
			if (!path.startsWith(prefix)) {
				continue;
			}
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
			if (event.path.startsWith(prefix)) {
				event.superseded = true;
			}
		}
		return cancelled;
	}

	private scheduleBatchFlush(): void {
		if (this.batchFlushTimer) {
			return;
		}
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
		if (
			!this.isEnabled ||
			this.deferredReplayTimer ||
			this.isWatcherFrozen()
		) {
			return;
		}
		this.deferredReplayTimer = setTimeout(() => {
			this.deferredReplayTimer = null;
			if (!this.isEnabled) {
				return;
			}
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
		if (result.requiresFullSync === "epoch-replaced") {
			this.epochReplacementObserved = true;
		}
		this.applyUploadCausalReceipts(result);
		const settledIds = [...result.completed, ...result.superseded];
		for (const id of settledIds) {
			this.submittedFileEvents.delete(id);
		}
		this.acknowledgeEvents(settledIds);
		logger[result.retry.length > 0 ? "warn" : "info"](
			"Realtime file batch reconciled",
			{
				completed: result.completed.length,
				superseded: result.superseded.length,
				retry: result.retry.length,
				requiresFullSync: result.requiresFullSync ?? null,
			},
		);
	}

	/**
	 * Transfer a verified upload result to its durable rename successor before
	 * the predecessor event is acknowledged.
	 */
	private applyUploadCausalReceipts(result: RealtimeBatchResult): void {
		const reduction = reduceUploadCausalReceipts(
			this.deferredEvents,
			result,
		);
		const eventsById = new Map(
			this.deferredEvents.map((event) => [event.id, event]),
		);
		for (const effect of reduction.effects) {
			const current = eventsById.get(effect.event.id);
			if (current) {
				Object.assign(current, effect.event);
			}
			if (effect.kind === "rename") {
				this.logUploadHandoff(effect.event, effect.receipt);
			} else {
				logger.info("Watcher upload receipt advanced successor", {
					eventId: effect.event.id,
					predecessorUploadId: effect.receipt.eventId,
					path: effect.event.path,
					canonicalRevision: effect.receipt.canonicalRevision,
					mutationSeq: effect.event.mutationSeq ?? null,
					reason: effect.receipt.reason,
				});
			}
		}
	}

	private logUploadHandoff(
		rename: DurableFileRenameEvent,
		receipt: UploadCausalReceipt | undefined,
	): void {
		logger.info("Watcher upload handed off to rename", {
			eventId: rename.id,
			predecessorUploadId: receipt?.eventId ?? null,
			oldPath: rename.path,
			targetPath: rename.targetPath,
			state: receipt?.status ?? "not-committed",
			reason: receipt?.reason ?? "unresolved",
			canonicalRevision: receipt?.canonicalRevision ?? null,
			mutationId: receipt?.mutationId ?? null,
			mutationSeq: receipt?.mutationSeq ?? null,
		});
	}

	private acknowledgeEvents(ids: string[]): void {
		if (ids.length === 0) {
			return;
		}
		const acknowledged = new Set(ids);
		this.deferredEvents = this.deferredEvents.filter(
			(event) =>
				!("id" in event) || !event.id || !acknowledged.has(event.id),
		);
		this.persistDeferredEvents();
	}

	private getEventContext(event: {
		epoch?: string | null;
		baseRevision?: number | null;
		mutationId?: string;
		mutationSeq?: number;
	}): WatcherCausalContext {
		const current = this.syncEngine.getWatcherCausalContext();
		return {
			epoch: event.epoch === undefined ? current.epoch : event.epoch,
			baseRevision:
				event.baseRevision === undefined
					? current.baseRevision
					: event.baseRevision,
			mutationId: event.mutationId,
			mutationSeq: event.mutationSeq,
		};
	}

	private normalizeEvent(event: DeferredWatcherEvent): WatcherQueueEvent {
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
			event.action === "rename" && event.kind === "file"
				? (event.predecessorUploadId ?? "")
				: "",
			event.action === "rename" && event.kind === "file"
				? String(event.folderParentAmbiguous === true)
				: "",
			"mutationSeq" in event ? (event.mutationSeq?.toString() ?? "") : "",
			"predecessorFolderEventId" in event
				? (event.predecessorFolderEventId ?? "")
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
		return (
			this.epochReplacementObserved ||
			this.isPausedForSync ||
			this.isPreparingFullSync ||
			(this.syncEngine.isInitialRemoteReceivePending?.() ?? false)
		);
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

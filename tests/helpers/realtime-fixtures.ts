import type { App, TFile } from "obsidian";
import type { VaultAdapter } from "../../src/api/vault-adapter";
import type { YandexDiskClient } from "../../src/api/yandex-client";
import { IndexManager } from "../../src/sync/canonical/manager";
import type {
	SyncLifecycleContext,
	SyncLifecycleOutcome,
} from "../../src/sync/contracts";
import type { SyncEngine } from "../../src/sync/engine";
import type { LocalOperationStore } from "../../src/sync/local/operation-store";
import type {
	DurableFileRenameEvent,
	DurableFolderRenameEvent,
	RealtimeBatchResult,
	RealtimeFileEvent,
	WatcherCausalContext,
} from "../../src/sync/realtime/rules";
import type { WatcherSettlement } from "../../src/sync/realtime/settlement";
import {
	FileWatcher,
	type DeferredWatcherEvent,
} from "../../src/sync/realtime/watcher";
import type { Dependencies as ReconciliationDependencies } from "../../src/sync/reconciliation/context";
import {
	createEmptyIndex,
	DEFAULT_SETTINGS,
	type FileMetadata,
	type LocalSyncState,
	type SyncIndex,
	type SyncResult,
} from "../../src/types";
import { fileMetadata as metadata } from "./metadata";

export const causalContext: WatcherCausalContext = {
	epoch: "epoch-a",
	baseRevision: 7,
};

export function fileEvent(
	id: string,
	path: string,
	options: Partial<RealtimeFileEvent> = {},
): RealtimeFileEvent {
	return {
		...causalContext,
		createdAt: 1,
		action: "upload",
		id,
		path,
		...options,
	};
}

export function renameEvent(
	id: string,
	path: string,
	targetPath: string,
	options: Partial<DurableFileRenameEvent> = {},
): DurableFileRenameEvent {
	return {
		...causalContext,
		createdAt: 1,
		action: "rename",
		kind: "file",
		id,
		path,
		targetPath,
		...options,
	};
}

export function folderRenameEvent(
	id: string,
	path: string,
	targetPath: string,
): DurableFolderRenameEvent {
	return {
		...renameEvent(id, path, targetPath),
		kind: "folder",
		baseRevision: 12,
	};
}

export function fileMetadata(
	path: string,
	sha256: string,
	options: Partial<FileMetadata> = {},
): FileMetadata {
	return metadata(path, { sha256, ...options });
}

export function syncResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		conflicts: 0,
		errors: [],
		startTime: 1,
		endTime: 0,
	};
}

/** Keep private watcher access narrow while reusing the production event contracts. */
export interface WatcherAccess {
	isEnabled: boolean;
	submittedFileEvents: Map<string, RealtimeFileEvent>;
	submittedWatcherEventIds: Set<string>;
	deferEvent(event: DeferredWatcherEvent): boolean;
	handleFileRename(file: TFile, oldPath: string): void;
	drainPendingFileEvents(): void;
	flushDeferredEventsNow(): Promise<void>;
	flushDeferredEvents(onlyIds?: ReadonlySet<string>): Promise<void>;
	settlement: Pick<WatcherSettlement, "settleRenameEvent">;
	applyBatchResult(result: RealtimeBatchResult): void;
	cancelPendingSync(path: string): void;
	captureFullSyncBarrier(context: SyncLifecycleContext): void;
	completeFullSyncBarrier(outcome: SyncLifecycleOutcome): void;
}

export function watcherAccess(watcher: FileWatcher): WatcherAccess {
	return watcher as unknown as WatcherAccess;
}

/** Default causal context is shared; individual tests supply only the engine boundary they exercise. */
export function createWatcher(overrides: Partial<SyncEngine> = {}) {
	const engine = {
		getWatcherCausalContext: () => ({ ...causalContext }),
		...overrides,
	} as SyncEngine;
	const watcher = new FileWatcher({} as App, engine, DEFAULT_SETTINGS);
	return { watcher, access: watcherAccess(watcher) };
}

/** Real local/index operations with only canonical transport replaced by memory. */
export class MemoryIndex extends IndexManager {
	readonly index: SyncIndex;
	readonly local: LocalSyncState;
	readonly store: LocalOperationStore;
	readonly commits: number[] = [];
	beforeSave?: () => void;
	beforeRepairAuthorization?: () => void;
	beforeCanonicalRead?: () => void;

	constructor(deviceId = "device-a", epoch = "epoch-a") {
		super({} as YandexDiskClient, {} as VaultAdapter, {
			...DEFAULT_SETTINGS,
			deviceId,
		});
		const state = this as unknown as {
			remoteIndex: SyncIndex;
			loadedRemoteIndex: SyncIndex;
			operationStore: LocalOperationStore;
		};
		this.index = state.remoteIndex;
		Object.assign(this.index, createEmptyIndex(deviceId, epoch), {
			revision: 7,
		});
		Object.assign(state.loadedRemoteIndex, structuredClone(this.index));
		this.local = this.getLocalIndex();
		this.local.observedEpoch = epoch;
		this.local.observedRevision = 7;
		this.store = state.operationStore;
		this.store.loadMutations(undefined, 1);
	}

	get remoteSaveCount() {
		return this.commits.length;
	}

	override async readCanonicalIndex() {
		this.beforeCanonicalRead?.();
		this.beforeCanonicalRead = undefined;
		return structuredClone(this.index);
	}

	override async readCanonicalIndexForRepair() {
		const index = structuredClone(this.index);
		this.beforeRepairAuthorization?.();
		this.beforeRepairAuthorization = undefined;
		return index;
	}

	override async refreshCanonicalForMutation() {
		return await this.readCanonicalIndex();
	}

	override async saveRemoteIndex() {
		this.beforeSave?.();
		this.index.revision++;
		this.commits.push(this.index.revision);
		return {
			epoch: this.index.epoch,
			revision: this.index.revision,
			index: structuredClone(this.index),
			contentFingerprint: "md5:test",
		};
	}
}

export function reconciliationDependencies(engine: SyncEngine) {
	return (
		engine as unknown as {
			syncReconciliationDependencies(): ReconciliationDependencies;
		}
	).syncReconciliationDependencies();
}

export function eventIds(watcher: FileWatcher) {
	return watcher.getDeferredEvents().map((event) => event.id ?? event.path);
}

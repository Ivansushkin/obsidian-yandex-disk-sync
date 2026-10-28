import type { LocalEncryptionTransition } from "./crypto/encryption-transition";
import { OperationFailure, type FailureSummary } from "./errors";
import {
	loadPluginDataWithSource,
	PLUGIN_DATA_FORMAT,
	type PluginDataLoadResult,
} from "./plugin-data-loader";
import {
	prepareSettingsPatch,
	type UserSettingsPatch,
} from "./settings-workflow";
import type { DeferredWatcherEvent } from "./sync/realtime/watcher";
import type { ForceRecovery } from "./sync/workflows/force-state";
import type {
	LocalSyncState,
	PendingMutation,
	PendingPhysicalAction,
	YandexDiskSyncSettings,
} from "./types";

export interface PluginData {
	format: typeof PLUGIN_DATA_FORMAT;
	settings: YandexDiskSyncSettings;
	localState: Partial<LocalSyncState> | null;
	pendingMutations: PendingMutation[];
	pendingPhysicalActions: PendingPhysicalAction[];
	pendingWatcherEvents: DeferredWatcherEvent[];
	encryptionTransition: LocalEncryptionTransition | null;
	forceRecovery: ForceRecovery | null;
	lastSyncStats: {
		uploaded: number;
		downloaded: number;
		deleted: number;
		errors: number;
	};
}

interface PersistencePorts {
	read(): Promise<unknown>;
	save(data: PluginData): Promise<void>;
	snapshot(): PluginData;
	publish(patch: UserSettingsPatch): void;
	connectionActivated(): void;
	isUnloaded(): boolean;
	failed(failure: FailureSummary): void;
}

/** Own the single device snapshot queue and invalidate stale work before reload. */
export class PluginPersistence {
	private tail: Promise<void> = Promise.resolve();
	private generation = 0;
	private loaded = false;
	private saveFailed = false;
	private saveFailure: FailureSummary | undefined;
	private failureGeneration = 0;
	private data: PluginData | null = null;

	constructor(private readonly ports: PersistencePorts) {}

	get current(): PluginData | null {
		return this.data;
	}
	get failed(): boolean {
		return this.saveFailed;
	}
	get failure(): FailureSummary | undefined {
		return this.saveFailure;
	}
	get recoveryGeneration(): number | undefined {
		return this.saveFailure ? this.failureGeneration : undefined;
	}

	/** Retire a repaired failure only after reconciliation of that exact generation. */
	completeRecovery(generation: number): void {
		if (!this.saveFailed && generation === this.failureGeneration) {
			this.saveFailure = undefined;
		}
	}
	get canSaveOnUnload(): boolean {
		return this.loaded && !this.saveFailed;
	}

	/** Wait for queued storage work without swallowing errors returned to its callers. */
	async idle(): Promise<void> {
		let tail: Promise<void>;
		do {
			tail = this.tail;
			await tail;
		} while (tail !== this.tail);
	}

	/** Unload never retries a failed save, including a failure still in flight. */
	async saveOnUnload(): Promise<void> {
		await this.enqueue(undefined, true);
	}

	/** Load and initialize identity before the first coherent migration save. */
	async load(
		initialize: (loaded: PluginDataLoadResult<PluginData>) => void,
	): Promise<void> {
		this.loaded = false;
		const generation = ++this.generation;
		await this.tail;
		this.assertGeneration(generation);
		const loaded = loadPluginDataWithSource(
			(await this.ports.read()) as PluginData | null,
		);
		this.assertGeneration(generation);
		if (this.ports.isUnloaded()) {
			throw new Error("Plugin was unloaded during data load");
		}
		this.data = loaded.data;
		initialize(loaded);
		this.loaded = true;
		try {
			await this.persist();
			this.assertGeneration(generation);
			this.saveFailed = false;
			this.saveFailure = undefined;
		} catch (error) {
			if (generation === this.generation) {
				this.loaded = false;
			}
			throw error;
		}
	}

	/** Build the snapshot at execution time; publish a user draft only after save. */
	async persist(patch?: UserSettingsPatch): Promise<void> {
		this.requireLoaded();
		await this.enqueue(patch, false);
	}

	/** Activate this connection only after the successful full snapshot is durable. */
	async completeManualSync(assertCurrent: () => void): Promise<void> {
		this.requireLoaded();
		await this.enqueue(undefined, false, assertCurrent);
	}

	private async enqueue(
		patch: UserSettingsPatch | undefined,
		unloading: boolean,
		activateConnection?: () => void,
	): Promise<void> {
		const generation = this.generation;
		const persistence = this.tail.then(async () => {
			if (unloading && !this.canSaveOnUnload) {
				return;
			}
			this.requireLoaded();
			this.assertGeneration(generation);
			if (patch && this.ports.isUnloaded()) {
				throw new Error("Plugin was unloaded before settings save");
			}
			activateConnection?.();
			const current = this.ports.snapshot();
			if (patch) {
				current.settings = prepareSettingsPatch(
					current.settings,
					patch,
				).settings;
			}
			if (activateConnection) {
				current.settings = {
					...current.settings,
					manualSyncRequired: false,
				};
			}
			// Storage owns immutable bytes even if live encryption advances during the await.
			const snapshot = JSON.parse(JSON.stringify(current)) as PluginData;
			await this.saveSnapshot(snapshot, generation);
			if (activateConnection) {
				try {
					this.assertGeneration(generation);
					activateConnection();
				} catch (error) {
					const pending = {
						...snapshot,
						settings: {
							...snapshot.settings,
							manualSyncRequired: true,
						},
					};
					await this.saveSnapshot(pending, generation);
					if (generation === this.generation) {
						this.data = pending;
					}
					throw error;
				}
			}
			this.assertGeneration(generation);
			this.data = snapshot;
			if (activateConnection && !this.ports.isUnloaded()) {
				this.ports.connectionActivated();
			}
			if (patch) {
				if (this.ports.isUnloaded()) {
					throw new Error("Plugin was unloaded during settings save");
				}
				this.ports.publish(patch);
				this.saveFailed = false;
			}
		});
		this.tail = persistence.then(
			() => undefined,
			() => undefined,
		);
		await persistence;
	}

	/** Classify storage failures identically for ordinary and revoked activation snapshots. */
	private async saveSnapshot(
		snapshot: PluginData,
		generation: number,
	): Promise<void> {
		try {
			await this.ports.save(snapshot);
		} catch (error) {
			if (generation === this.generation) {
				this.saveFailed = true;
				this.failureGeneration++;
				this.saveFailure = new OperationFailure(
					error,
					{
						stage: "persisting",
						action: "local",
						outcome: "unknown",
					},
					{ category: "local", code: "local-persistence" },
				).summary;
				this.ports.failed(this.saveFailure);
			}
			throw error;
		}
	}

	/** A failed read must never turn defaults or stale memory into persisted data. */
	requireLoaded(): void {
		if (!this.loaded) {
			throw new Error(
				"Plugin data was not successfully loaded; saving is blocked",
			);
		}
	}

	private assertGeneration(generation: number): void {
		if (generation !== this.generation) {
			throw new Error(
				"Plugin data operation was superseded by a new load",
			);
		}
	}
}

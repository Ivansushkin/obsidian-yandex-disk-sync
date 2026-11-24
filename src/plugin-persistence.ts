import type { LocalEncryptionTransition } from "./crypto/encryption-transition";
import {
	captureAuthentication,
	prepareAuthenticationUpdate,
	type AuthenticationSettings,
	type AuthenticationChange,
} from "./auth/authentication-state";
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
import type { RemoteObservation } from "./sync/contracts";
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
}

interface PersistencePorts {
	read(): Promise<unknown>;
	save(data: PluginData): Promise<void>;
	snapshot(): PluginData;
	publish(patch: UserSettingsPatch): void;
	publishAuthentication?(
		authentication: AuthenticationSettings,
		clearEncryptionPassword: boolean,
	): void;
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
	private authenticationCommitted = false;
	private sensitiveLogoutCommitted = false;

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
		await this.enqueue({ unloading: true });
	}

	/** Load and initialize identity before the first coherent migration save. */
	async load(
		initialize: (loaded: PluginDataLoadResult<PluginData>) => void,
	): Promise<void> {
		this.loaded = false;
		this.authenticationCommitted = false;
		this.sensitiveLogoutCommitted = false;
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
		if (
			loaded.data?.settings.encryptionPassword &&
			!loaded.data.settings.yandexTokenSecret?.trim() &&
			!loaded.data.encryptionTransition &&
			!loaded.data.forceRecovery
		) {
			loaded.data = {
				...loaded.data,
				settings: { ...loaded.data.settings, encryptionPassword: null },
			};
			this.authenticationCommitted = true;
			this.sensitiveLogoutCommitted = true;
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
	async persist(
		patch?: UserSettingsPatch,
		observation?: RemoteObservation,
	): Promise<void> {
		this.requireLoaded();
		await this.enqueue({ patch, observation });
	}

	/** Save a validated credential bundle before publishing it to running components. */
	async persistAuthentication(
		update: AuthenticationChange,
		assertCurrent: () => void,
	): Promise<void> {
		this.requireLoaded();
		if (!this.ports.publishAuthentication) {
			throw new Error("Authorization publication is unavailable");
		}
		await this.enqueue({
			authentication: {
				update:
					update.kind !== "interactive" && update.kind !== "refresh"
						? { ...update }
						: {
								...update,
								authorization: { ...update.authorization },
							},
				assertCurrent,
			},
		});
	}

	/** Activate this connection only after the successful full snapshot is durable. */
	async completeManualSync(assertCurrent: () => void): Promise<void> {
		this.requireLoaded();
		await this.enqueue({ activateConnection: assertCurrent });
	}

	private async enqueue({
		patch,
		unloading,
		activateConnection,
		authentication,
		observation,
	}: {
		patch?: UserSettingsPatch;
		unloading?: boolean;
		activateConnection?: () => void;
		authentication?: {
			update: AuthenticationChange;
			assertCurrent(): void;
		};
		observation?: RemoteObservation;
	}): Promise<void> {
		const generation = this.generation;
		const persistence = this.tail.then(async () => {
			if (unloading && !this.canSaveOnUnload) {
				return;
			}
			this.requireLoaded();
			this.assertGeneration(generation);
			if ((patch || authentication) && this.ports.isUnloaded()) {
				throw new Error("Plugin was unloaded before settings save");
			}
			const assertPublication =
				activateConnection ?? observation?.assertCurrent;
			assertPublication?.();
			authentication?.assertCurrent();
			const current = this.currentData(observation);
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
			if (authentication) {
				current.settings = {
					...current.settings,
					...prepareAuthenticationUpdate(
						current.settings,
						authentication.update,
					),
				};
			}
			const snapshot = await this.saveSnapshot(current, generation);
			if (assertPublication) {
				try {
					this.assertGeneration(generation);
					assertPublication();
				} catch (error) {
					// Rebuild from live state so late events and the active scope survive revocation.
					const pending = this.currentData();
					if (activateConnection) {
						pending.settings = {
							...pending.settings,
							manualSyncRequired: true,
						};
					}
					const restored = await this.saveSnapshot(
						pending,
						generation,
					);
					if (generation === this.generation) {
						this.data = restored;
					}
					throw error;
				}
			}
			this.assertGeneration(generation);
			this.data = snapshot;
			observation?.publish();
			if (
				authentication ||
				(patch && ("yandexTokenSecret" in patch || "clientId" in patch))
			) {
				this.authenticationCommitted = true;
			}
			if (
				authentication?.update.kind === "logout" &&
				!authentication.update.preserveEncryptionPassword
			) {
				this.sensitiveLogoutCommitted = true;
			}
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
			if (authentication) {
				if (this.ports.isUnloaded()) {
					throw new Error(
						"Plugin was unloaded during authorization save",
					);
				}
				authentication.assertCurrent();
				this.ports.publishAuthentication?.(
					captureAuthentication(snapshot.settings),
					authentication.update.kind === "logout" &&
						!authentication.update.preserveEncryptionPassword,
				);
				this.saveFailed = false;
			}
		});
		this.tail = persistence.then(
			() => undefined,
			() => undefined,
		);
		await persistence;
	}

	/** Capture only published device state, optionally proposing one reconciled observation. */
	private currentData(observation?: RemoteObservation): PluginData {
		const current = this.ports.snapshot();
		if (observation) {
			current.localState = {
				...current.localState,
				...observation.state,
			};
		}
		if (this.authenticationCommitted && this.data) {
			current.settings = {
				...current.settings,
				...captureAuthentication(this.data.settings),
				...(this.sensitiveLogoutCommitted &&
				!this.data.settings.yandexTokenSecret
					? { encryptionPassword: null }
					: {}),
			};
		}
		return current;
	}

	/** Freeze the complete device snapshot before crossing the storage boundary. */
	private async saveSnapshot(
		current: PluginData,
		generation: number,
	): Promise<PluginData> {
		const snapshot = JSON.parse(JSON.stringify(current)) as PluginData;
		try {
			await this.ports.save(snapshot);
			return snapshot;
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

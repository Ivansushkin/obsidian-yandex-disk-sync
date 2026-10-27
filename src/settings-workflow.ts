import { t } from "./i18n/index";
import { withFailureContext } from "./errors";
import type { StartupInvocation, StartupState } from "./plugin-startup";
import type { SyncResult } from "./types";
import type { SyncEngine } from "./sync/engine";
import type { FileWatcher } from "./sync/realtime/watcher";
import type { YandexDiskSyncSettings } from "./types";

const USER_SETTING_KEYS = [
	"clientId",
	"yandexTokenSecret",
	"remotePath",
	"syncPatterns",
	"excludePatterns",
	"syncDotObsidian",
	"enableRealtimeSync",
	"syncInterval",
	"debounceDelay",
	"maxConcurrency",
	"enableDebugLogging",
	"logToFile",
] as const;

export type UserSettingsPatch = Partial<
	Pick<YandexDiskSyncSettings, (typeof USER_SETTING_KEYS)[number]>
>;

/** Validate a user draft without publishing it to running components. */
export function prepareSettingsPatch(
	current: YandexDiskSyncSettings,
	patch: UserSettingsPatch,
) {
	if (
		Object.keys(patch).some(
			(key) => !(USER_SETTING_KEYS as readonly string[]).includes(key),
		)
	) {
		throw new Error("Unsupported user setting");
	}
	for (const key of Object.keys(patch) as (keyof UserSettingsPatch)[]) {
		const value = patch[key];
		if (Array.isArray(current[key])) {
			if (
				!Array.isArray(value) ||
				value.some((item: unknown) => typeof item !== "string")
			) {
				throw new Error("Invalid setting value");
			}
		} else if (
			typeof value !== typeof current[key] ||
			(typeof value === "number" && !Number.isFinite(value))
		) {
			throw new Error("Invalid setting value");
		}
	}
	if (
		(patch.syncInterval !== undefined && patch.syncInterval < 0) ||
		(patch.debounceDelay !== undefined && patch.debounceDelay < 0) ||
		(patch.maxConcurrency !== undefined &&
			(!Number.isInteger(patch.maxConcurrency) ||
				patch.maxConcurrency < 1 ||
				patch.maxConcurrency > 40))
	) {
		throw new Error("Invalid scheduling setting");
	}
	const changed = USER_SETTING_KEYS.filter(
		(key) =>
			key in patch &&
			JSON.stringify(current[key]) !== JSON.stringify(patch[key]),
	);
	const scopeKeys = [
		"remotePath",
		"syncPatterns",
		"excludePatterns",
		"syncDotObsidian",
	];
	const changesConnection = changed.some(
		(key) => key === "remotePath" || key === "yandexTokenSecret",
	);
	const changesFileScope = changed.some(
		(key) => key !== "remotePath" && scopeKeys.includes(key),
	);
	return {
		settings: {
			...current,
			...patch,
			syncPatterns: [...(patch.syncPatterns ?? current.syncPatterns)],
			excludePatterns: [
				...(patch.excludePatterns ?? current.excludePatterns),
			],
		},
		hasChanges: changed.length > 0,
		requiresIdle: changed.some(
			(key) => key !== "enableDebugLogging" && key !== "logToFile",
		),
		changesConnection,
		changesFileScope,
		changesAutomation: changed.some(
			(key) => key === "syncInterval" || key === "enableRealtimeSync",
		),
		changesDestination: changed.includes("remotePath"),
		changesTransitionScope: changed.some((key) => scopeKeys.includes(key)),
		needsFull: changesConnection || changesFileScope,
	};
}

export type SettingsUpdateStage =
	"watcher-persistence" | "persisting" | "startup" | "sync";

interface SettingsWorkflowPorts {
	getSettings(): YandexDiskSyncSettings;
	persistenceFailed(): boolean;
	persistenceRecoveryGeneration?(): number | undefined;
	completePersistenceRecovery?(generation: number): void;
	isConfigurationBusy(): boolean;
	hasTransition(): boolean;
	hasDurableConfigurationWork(): boolean;
	isUnloaded(): boolean;
	isLayoutReady(): boolean;
	setUpdating(updating: boolean, synchronizing?: boolean): void;
	stopRegularSync(): void;
	startAutomation(): void;
	refreshAutomation?(): void;
	settingsSaveRejected(error: unknown, stage: SettingsUpdateStage): void;
	persistPluginData(patch: UserSettingsPatch): Promise<void>;
	runStartupInvocation?<T>(
		action: (invocation: StartupInvocation) => Promise<T>,
	): Promise<T>;
	refreshRemoteStartupState(
		prompt: boolean,
		recovery: boolean,
		invocation?: StartupInvocation,
	): Promise<StartupState>;
	reconcile(invocation?: StartupInvocation): Promise<SyncResult | null>;
	watcher?: Pick<FileWatcher, "waitForPendingPersistence" | "start">;
	engine?: Pick<
		SyncEngine,
		"hasPendingWork" | "setExternalBlock" | "isSyncPaused"
	>;
}

/** Drain watcher work before enqueueing a draft; publish and reclassify after save. */
export async function applyUserSettingsPatch(
	deps: SettingsWorkflowPorts,
	patch: UserSettingsPatch,
	invocation?: StartupInvocation,
): Promise<void> {
	if (!invocation && deps.runStartupInvocation) {
		return await deps.runStartupInvocation((owned) =>
			applyUserSettingsPatch(deps, patch, owned),
		);
	}
	const draft = prepareSettingsPatch(deps.getSettings(), patch);
	patch = {
		...patch,
		...(patch.syncPatterns
			? { syncPatterns: [...patch.syncPatterns] }
			: {}),
		...(patch.excludePatterns
			? { excludePatterns: [...patch.excludePatterns] }
			: {}),
	};
	const recoveringPersistence =
		deps.persistenceFailed() ||
		deps.persistenceRecoveryGeneration?.() !== undefined;
	if (!draft.hasChanges && !recoveringPersistence) {
		return;
	}
	let requiresIdle = draft.requiresIdle || recoveringPersistence;
	let stopsAutomation = draft.needsFull || recoveringPersistence;
	if (
		requiresIdle &&
		(deps.isConfigurationBusy() ||
			(deps.hasTransition() && draft.changesTransitionScope))
	) {
		throw new Error(t("notice.configuration_busy"));
	}
	if (draft.changesDestination && deps.hasDurableConfigurationWork()) {
		throw new Error(t("notice.configuration_busy"));
	}
	if (requiresIdle) {
		deps.setUpdating(true, stopsAutomation);
	}
	if (stopsAutomation) {
		deps.stopRegularSync();
	}
	let automationReady = false;
	let stage: SettingsUpdateStage = "watcher-persistence";
	try {
		if (stopsAutomation) {
			await deps.watcher?.waitForPendingPersistence(
				recoveringPersistence,
			);
			if (
				deps.engine?.hasPendingWork() ||
				(draft.changesDestination && deps.hasDurableConfigurationWork())
			) {
				throw new Error(t("notice.configuration_busy"));
			}
		}
		if (deps.isUnloaded()) {
			return;
		}
		stage = "persisting";
		await deps.persistPluginData(patch);
		if (deps.isUnloaded()) {
			return;
		}
		const recoveryGeneration = deps.persistenceRecoveryGeneration?.();
		const repairingPersistence =
			recoveringPersistence || recoveryGeneration !== undefined;
		if (repairingPersistence && !stopsAutomation) {
			// The shared queue may have failed after this draft was accepted.
			if (
				deps.engine?.hasPendingWork() ||
				(!requiresIdle && deps.isConfigurationBusy())
			) {
				return;
			}
			if (!requiresIdle) {
				requiresIdle = true;
			}
			deps.setUpdating(true, true);
			stopsAutomation = true;
			deps.stopRegularSync();
			stage = "watcher-persistence";
			await deps.watcher?.waitForPendingPersistence(true);
			if (deps.isUnloaded()) {
				return;
			}
		}
		if (repairingPersistence && !deps.persistenceFailed()) {
			deps.engine?.setExternalBlock("persistence", null);
		}
		if (stopsAutomation) {
			stage = "startup";
			const ready = await deps.refreshRemoteStartupState(
				draft.changesConnection &&
					deps.isLayoutReady() &&
					!deps.engine?.isSyncPaused(),
				false,
				invocation,
			);
			if (
				ready === "ready" &&
				!deps.isUnloaded() &&
				deps.isLayoutReady() &&
				!deps.engine?.isSyncPaused()
			) {
				if (draft.needsFull || repairingPersistence) {
					stage = "sync";
					const result = await deps.reconcile(invocation);
					if (!result?.success) {
						return;
					}
					if (recoveryGeneration !== undefined) {
						deps.completePersistenceRecovery?.(recoveryGeneration);
					}
				}
				automationReady = true;
			}
		}
	} catch (error) {
		withFailureContext(error, {
			stage,
			action: stage === "persisting" ? "local" : "unknown",
		});
		if (
			!deps.isUnloaded() &&
			(stopsAutomation || deps.persistenceFailed())
		) {
			deps.settingsSaveRejected(error, stage);
		}
		throw error;
	} finally {
		if (requiresIdle) {
			deps.setUpdating(false);
		}
		if (automationReady) {
			deps.startAutomation();
		} else if (
			!stopsAutomation &&
			draft.changesAutomation &&
			!deps.isUnloaded() &&
			!deps.persistenceFailed()
		) {
			deps.refreshAutomation?.();
		}
	}
}

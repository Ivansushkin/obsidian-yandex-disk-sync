import { t } from "./i18n/index";
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
	return {
		settings: {
			...current,
			...patch,
			syncPatterns: [...(patch.syncPatterns ?? current.syncPatterns)],
			excludePatterns: [
				...(patch.excludePatterns ?? current.excludePatterns),
			],
		},
		changesScope: changed.some(
			(key) => key !== "enableDebugLogging" && key !== "logToFile",
		),
		changesDestination: changed.includes("remotePath"),
		changesTransitionScope: changed.some(
			(key) => scopeKeys.includes(key) || key === "clientId",
		),
		needsFull: changed.some(
			(key) =>
				scopeKeys.includes(key) ||
				key === "yandexTokenSecret" ||
				key === "clientId",
		),
	};
}

interface SettingsWorkflowPorts {
	getSettings(): YandexDiskSyncSettings;
	persistenceFailed(): boolean;
	isConfigurationBusy(): boolean;
	hasTransition(): boolean;
	hasDurableConfigurationWork(): boolean;
	isUnloaded(): boolean;
	isLayoutReady(): boolean;
	setUpdating(updating: boolean): void;
	stopRegularSync(): void;
	startAutomation(): void;
	invalidateRemoteStateClassification(): void;
	settingsSaveRejected(): void;
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
	const recoveringPersistence = deps.persistenceFailed();
	const changesScope = draft.changesScope || recoveringPersistence;
	if (
		changesScope &&
		(deps.isConfigurationBusy() ||
			(deps.hasTransition() && draft.changesTransitionScope))
	) {
		throw new Error(t("notice.configuration_busy"));
	}
	if (draft.changesDestination && deps.hasDurableConfigurationWork()) {
		throw new Error(t("notice.configuration_busy"));
	}
	if (changesScope) {
		deps.setUpdating(true);
		deps.stopRegularSync();
		deps.engine?.setExternalBlock(
			"authentication",
			t("notice.configuration_busy"),
		);
	}
	let automationReady = false;
	try {
		if (changesScope) {
			await deps.watcher?.waitForPendingPersistence();
			if (
				deps.engine?.hasPendingWork() ||
				(draft.changesDestination && deps.hasDurableConfigurationWork())
			) {
				throw new Error(t("notice.configuration_busy"));
			}
		}
		await deps.persistPluginData(patch);
		if (deps.isUnloaded()) {
			return;
		}
		if (changesScope) {
			deps.invalidateRemoteStateClassification();
			const ready = await deps.refreshRemoteStartupState(
				false,
				false,
				invocation,
			);
			if (
				ready === "ready" &&
				!deps.isUnloaded() &&
				deps.isLayoutReady() &&
				!deps.engine?.isSyncPaused()
			) {
				if (draft.needsFull || recoveringPersistence) {
					const result = await deps.reconcile(invocation);
					if (!result?.success) {
						return;
					}
				}
				automationReady = true;
			}
		}
	} catch (error) {
		if (changesScope || deps.persistenceFailed()) {
			deps.settingsSaveRejected();
		}
		throw error;
	} finally {
		if (changesScope) {
			deps.setUpdating(false);
		}
		if (automationReady) {
			deps.startAutomation();
		}
	}
}

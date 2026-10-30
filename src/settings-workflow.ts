import { normalizeLanguagePreference, t } from "./i18n/index";
import { withFailureContext } from "./errors";
import type { SyncResult } from "./types";
import type { SyncEngine } from "./sync/engine";
import type { FileWatcher } from "./sync/realtime/watcher";
import type { YandexDiskSyncSettings } from "./types";
import type { RemoteStorageScope } from "./types";
import type { AuthenticationChange } from "./auth/authentication-state";
import {
	AuthorizationError,
	type AuthorizationAttempt,
} from "./auth/yandex-authorization";
import { sameRemoteStorageScope } from "./sync/local/storage-scope";

interface AuthenticationWorkflowPorts {
	getSettings(): YandexDiskSyncSettings;
	getExpectedScope(): RemoteStorageScope | null;
	hasHistory(): boolean;
	hasSensitiveRecovery(): boolean;
	isBusy(): boolean;
	isUnloaded(): boolean;
	nativeWrites(): number;
	subscribeActivity(listener: () => void): () => void;
	setUpdating(value: boolean): void;
	waitForWatcherPersistence(): Promise<void>;
	readCandidateRoot(
		token: string,
		path: string,
	): Promise<RemoteStorageScope | null>;
	persist(
		update: AuthenticationChange,
		assertCurrent: () => void,
	): Promise<void>;
}

/** Serialize credential changes; logout preserves local history and needs no remote access. */
export async function applyAuthenticationUpdate(
	deps: AuthenticationWorkflowPorts,
	update: AuthenticationChange,
	attempt: AuthorizationAttempt,
): Promise<void> {
	attempt.phase("waiting-idle");
	for (;;) {
		await waitForAuthenticationIdle(deps, attempt);
		attempt.assertCurrent();
		if (!deps.isBusy() && deps.nativeWrites() === 0) {
			break;
		}
	}
	deps.setUpdating(true);
	try {
		await deps.waitForWatcherPersistence();
		attempt.assertCurrent();
		if (deps.isUnloaded()) {
			throw new AuthorizationError("revoked");
		}
		if (update.kind === "logout") {
			if (
				!update.preserveEncryptionPassword &&
				deps.hasSensitiveRecovery()
			) {
				throw new Error(t("notice.logout_recovery_pending"));
			}
			await deps.persist(update, () => {
				attempt.assertCurrent();
			});
			return;
		}
		const path = deps.getSettings().remotePath;
		const expected = deps.getExpectedScope();
		if (!expected && deps.hasHistory()) {
			throw new AuthorizationError("root-unavailable");
		}
		attempt.phase("checking-root");
		let root: RemoteStorageScope | null;
		try {
			root = await deps.readCandidateRoot(update.token, path);
		} catch (error) {
			throw error instanceof AuthorizationError
				? error
				: new AuthorizationError("root-unavailable");
		}
		attempt.assertCurrent();
		if (expected && !root) {
			throw new AuthorizationError("root-unavailable");
		}
		if (expected && !sameRemoteStorageScope(expected, root)) {
			throw new AuthorizationError("root-mismatch");
		}
		let accepted = false;
		await deps.persist(update, () => {
			attempt.assertCurrent();
			if (!accepted) {
				attempt.accept();
				accepted = true;
			}
		});
	} finally {
		deps.setUpdating(false);
	}
}

/** Wake on settlement or cancellation; never hold a coordinator session while waiting. */
function waitForAuthenticationIdle(
	deps: AuthenticationWorkflowPorts,
	attempt: AuthorizationAttempt,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let finished = false;
		let unsubscribe = () => {};
		const check = () => {
			if (finished) {
				return;
			}
			try {
				attempt.assertCurrent();
				if (deps.isUnloaded()) {
					throw new AuthorizationError("revoked");
				}
				if (deps.isBusy() || deps.nativeWrites() > 0) {
					return;
				}
				finished = true;
				unsubscribe();
				resolve();
			} catch (error) {
				finished = true;
				unsubscribe();
				reject(
					error instanceof Error
						? error
						: new AuthorizationError("revoked"),
				);
			}
		};
		unsubscribe = deps.subscribeActivity(check);
		if (finished) {
			unsubscribe();
		} else {
			check();
		}
	});
}

const USER_SETTING_KEYS = [
	"language",
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
	if (
		patch.language !== undefined &&
		normalizeLanguagePreference(patch.language) !== patch.language
	) {
		throw new Error("Invalid language preference");
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
	const changesConnection =
		changed.some(
			(key) => key === "remotePath" || key === "yandexTokenSecret",
		) ||
		(("yandexTokenSecret" in patch || "clientId" in patch) &&
			current.authMethod === "oauth");
	const changesFileScope = changed.some(
		(key) => key !== "remotePath" && scopeKeys.includes(key),
	);
	return {
		settings: {
			...current,
			...patch,
			...("yandexTokenSecret" in patch || "clientId" in patch
				? {
						authMethod: "manual" as const,
						oauthAuthorization: null,
						yandexTokenSecret:
							patch.yandexTokenSecret ??
							(current.authMethod === "manual"
								? current.yandexTokenSecret
								: ""),
					}
				: {}),
			manualSyncRequired: current.manualSyncRequired || changesConnection,
			syncPatterns: [...(patch.syncPatterns ?? current.syncPatterns)],
			excludePatterns: [
				...(patch.excludePatterns ?? current.excludePatterns),
			],
		},
		hasChanges: changed.length > 0 || changesConnection,
		requiresIdle:
			changesConnection ||
			changed.some(
				(key) => key !== "enableDebugLogging" && key !== "logToFile",
			),
		changesConnection,
		changesFileScope,
		changesAutomation: changed.some(
			(key) => key === "syncInterval" || key === "enableRealtimeSync",
		),
		changesDestination: changed.includes("remotePath"),
		changesTransitionScope: changed.some((key) => scopeKeys.includes(key)),
	};
}

export type SettingsUpdateStage = "watcher-persistence" | "persisting";

interface SettingsWorkflowPorts {
	getSettings(): YandexDiskSyncSettings;
	persistenceFailed(): boolean;
	persistenceRecoveryGeneration?(): number | undefined;
	isConfigurationBusy(): boolean;
	hasTransition(): boolean;
	hasDurableConfigurationWork(): boolean;
	isUnloaded(): boolean;
	isLayoutReady(): boolean;
	setUpdating(updating: boolean): void;
	stopRegularSync(): void;
	refreshAutomation?(): void;
	settingsSaveRejected(error: unknown, stage: SettingsUpdateStage): void;
	persistPluginData(patch: UserSettingsPatch): Promise<void>;
	reconcile(): Promise<SyncResult | null>;
	watcher?: Pick<FileWatcher, "waitForPendingPersistence">;
	engine?: Pick<
		SyncEngine,
		"hasPendingWork" | "setExternalBlock" | "isSyncPaused"
	>;
}

/** Persist a draft locally; reconcile admitted scope changes after releasing the settings lock. */
export async function applyUserSettingsPatch(
	deps: SettingsWorkflowPorts,
	patch: UserSettingsPatch,
): Promise<void> {
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
	let stopsAutomation =
		draft.changesConnection ||
		draft.changesFileScope ||
		recoveringPersistence;
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
		deps.setUpdating(true);
	}
	if (stopsAutomation) {
		deps.stopRegularSync();
	}
	let reconcile = false;
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
			deps.setUpdating(true);
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
		reconcile =
			stopsAutomation &&
			!deps.getSettings().manualSyncRequired &&
			!deps.isUnloaded() &&
			deps.isLayoutReady() &&
			!deps.engine?.isSyncPaused();
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
		if (
			!stopsAutomation &&
			draft.changesAutomation &&
			!deps.isUnloaded() &&
			!deps.persistenceFailed()
		) {
			deps.refreshAutomation?.();
		}
	}
	if (reconcile) {
		await deps.reconcile();
	}
}

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
				patch.maxConcurrency < 1))
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

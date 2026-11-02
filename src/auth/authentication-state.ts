import type { YandexDiskSyncSettings } from "../types";

export interface OAuthAuthorization {
	clientId: string;
	grantId: string;
	refreshToken: string | null;
	expiresAt: number | null;
}

export type AuthenticationSettings = Pick<
	YandexDiskSyncSettings,
	| "clientId"
	| "yandexTokenSecret"
	| "authMethod"
	| "oauthAuthorization"
	| "manualSyncRequired"
>;

export interface AuthenticationUpdate {
	kind: "interactive" | "refresh";
	token: string;
	authorization: OAuthAuthorization;
}

export type AuthenticationChange =
	| AuthenticationUpdate
	| {
			kind: "logout";
			method?: "manual" | "oauth";
			preserveEncryptionPassword?: boolean;
	  };

/** Validate additive metadata without reclassifying a legacy token as a managed grant. */
export function normalizeAuthentication(
	settings: Partial<YandexDiskSyncSettings>,
): Pick<
	YandexDiskSyncSettings,
	"authMethod" | "oauthAuthorization" | "clientId"
> {
	const method =
		settings.authMethod === undefined
			? settings.yandexTokenSecret || settings.clientId
				? "manual"
				: "oauth"
			: settings.authMethod;
	const authorization = settings.oauthAuthorization ?? null;
	if (
		(method !== "manual" && method !== "oauth") ||
		(method === "manual" && authorization !== null) ||
		(authorization !== null && !isOAuthAuthorization(authorization)) ||
		(method === "oauth" &&
			Boolean(settings.yandexTokenSecret) &&
			authorization === null) ||
		(authorization !== null && !settings.yandexTokenSecret)
	) {
		throw new Error("Invalid local authorization state");
	}
	return {
		clientId: method === "manual" ? (settings.clientId ?? "") : "",
		authMethod: method,
		oauthAuthorization: authorization ? { ...authorization } : null,
	};
}

function isOAuthAuthorization(value: unknown): value is OAuthAuthorization {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.clientId === "string" &&
		record.clientId.trim().length > 0 &&
		typeof record.grantId === "string" &&
		record.grantId.length > 0 &&
		(record.refreshToken === null ||
			(typeof record.refreshToken === "string" &&
				record.refreshToken.length > 0)) &&
		(record.expiresAt === null ||
			(typeof record.expiresAt === "number" &&
				Number.isSafeInteger(record.expiresAt) &&
				record.expiresAt > 0))
	);
}

/** Copy credentials independently of mutable runtime settings and pending watcher snapshots. */
export function captureAuthentication(
	settings: YandexDiskSyncSettings,
): AuthenticationSettings {
	return {
		yandexTokenSecret: settings.yandexTokenSecret,
		...normalizeAuthentication(settings),
		manualSyncRequired: settings.manualSyncRequired,
	};
}

/** Prepare local credential changes; refresh cannot switch the committed grant. */
export function prepareAuthenticationUpdate(
	current: YandexDiskSyncSettings,
	update: AuthenticationChange,
): AuthenticationSettings & { encryptionPassword?: null } {
	if (update.kind === "logout") {
		return {
			clientId: "",
			yandexTokenSecret: "",
			authMethod: update.method ?? current.authMethod,
			oauthAuthorization: null,
			manualSyncRequired: true,
			...(update.preserveEncryptionPassword
				? {}
				: { encryptionPassword: null }),
		};
	}
	if (!update.token.trim() || !isOAuthAuthorization(update.authorization)) {
		throw new Error("Invalid authorization response");
	}
	if (
		update.kind === "refresh" &&
		(current.authMethod !== "oauth" ||
			current.oauthAuthorization?.grantId !==
				update.authorization.grantId ||
			current.oauthAuthorization.clientId !==
				update.authorization.clientId)
	) {
		throw new Error("Authorization grant changed");
	}
	return {
		clientId: "",
		yandexTokenSecret: update.token,
		authMethod: "oauth",
		oauthAuthorization: { ...update.authorization },
		manualSyncRequired:
			update.kind === "interactive" || current.manualSyncRequired,
	};
}

type OAuthPlatform = "desktop" | "ios" | "android";

/** Use owner-registered redirects; each enabled platform still requires native release acceptance. */
export const SHARED_YANDEX_OAUTH: {
	clientId: string;
	callbackPlatforms: readonly OAuthPlatform[];
} = {
	clientId: "3f240eda22134c36be1b8d1973e084de",
	callbackPlatforms: ["desktop"],
};

type OAuthPlatform = "desktop" | "ios" | "android";

/** Activate only an owner-registered public application with independently verified redirects. */
export const SHARED_YANDEX_OAUTH: {
	clientId: string;
	callbackPlatforms: readonly OAuthPlatform[];
} = {
	clientId: "",
	callbackPlatforms: [],
};

declare const __SYNC_BUILD_ID__: string;

/** Source identity supplied by the bundler; tests and unbundled tools use development. */
export const SYNC_BUILD_ID =
	typeof __SYNC_BUILD_ID__ === "string" ? __SYNC_BUILD_ID__ : "development";

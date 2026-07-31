/**
 * Path utilities
 */

/** System-protected paths that should never be synchronized */
const PROTECTED_PATHS = [
	'.backup',
	'.obsidian-sync-index.json',
	'.obsidian-encrypt.json',
];

const PROTECTED_PATH_PREFIXES = [".obsidian-sync-index.lock."];
const PLUGIN_DATA_DIRECTORY = "plugins/yandex-disk-sync";
const LEGACY_LOG_DIRECTORY = "yandex-disk-sync";

/**
 * Path normalization (remove leading/trailing slashes, replace backslashes)
 */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\/+/g, "/");
}

/**
 * Path parts joining
 */
export function joinPath(...parts: string[]): string {
	return normalizePath(parts.filter(Boolean).join("/"));
}

/**
 * Get file name from path
 */
export function getFileName(path: string): string {
	const normalized = normalizePath(path);
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

/**
 * Get directory from path
 */
export function getDirectory(path: string): string {
	const normalized = normalizePath(path);
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}

/**
 * Collect unique ancestor directories for file paths, deepest directories first.
 */
export function getAncestorDirectoriesDeepestFirst(
	filePaths: Iterable<string>,
): string[] {
	const directories = new Set<string>();
	for (const filePath of filePaths) {
		let directory = getDirectory(filePath);
		while (directory) {
			directories.add(directory);
			directory = getDirectory(directory);
		}
	}
	return [...directories].sort((left, right) => {
		const depthDifference =
			right.split("/").length - left.split("/").length;
		return depthDifference || left.localeCompare(right);
	});
}

/**
 * Get file extension
 */
export function getExtension(path: string): string {
	const fileName = getFileName(path);
	const lastDot = fileName.lastIndexOf(".");
	return lastDot >= 0 ? fileName.slice(lastDot + 1).toLowerCase() : "";
}

/**
 * Convert remote path to local path
 */
export function toLocalPath(
	fullRemotePath: string,
	remoteBasePath: string
): string {
	const normalized = normalizePath(fullRemotePath);
	const base = normalizePath(remoteBasePath);

	// Remove "disk:/" prefix if present
	const cleanPath = normalized.replace(/^disk:\//, "");
	const cleanBase = base.replace(/^disk:\//, "");

	if (cleanPath.startsWith(cleanBase + "/")) {
		return cleanPath.slice(cleanBase.length + 1);
	}
	if (cleanPath === cleanBase) {
		return "";
	}
	return cleanPath;
}

/**
 * Check if path is protected from synchronization
 */
export function isProtectedPath(path: string): boolean {
	const normalized = normalizePath(path);
	const parts = normalized.split("/");

	// Check if any part of the path matches protected paths
	return parts.some(
		(part) =>
			PROTECTED_PATHS.includes(part) ||
			PROTECTED_PATH_PREFIXES.some((prefix) => part.startsWith(prefix)),
	);
}

/**
 * Simple pattern matching (supports * and **)
 */
export function matchPattern(path: string, pattern: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);

	// Convert glob pattern to regular expression
	const regexPattern = normalizedPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
		.replace(/\*\*/g, "<<<GLOBSTAR>>>") // Temporary replacement for **
		.replace(/\*/g, "[^/]*") // * = any chars except /
		.replace(/<<<GLOBSTAR>>>/g, ".*"); // ** = any chars including /

	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(normalizedPath);
}

/**
 * Check if path matches any pattern in list
 */
export function matchesPatterns(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchPattern(path, pattern));
}

/**
 * Check if file should be synchronized
 */
export function shouldSyncFile(
	path: string,
	includePatterns: string[],
	excludePatterns: string[],
	syncDotObsidian: boolean,
	configDir?: string
): boolean {
	const normalized = normalizePath(path);

	// Check if path is protected (never sync)
	if (isProtectedPath(normalized)) {
		return false;
	}

	if (configDir) {
		const pluginDataPath = joinPath(configDir, PLUGIN_DATA_DIRECTORY);
		const legacyLogPath = joinPath(configDir, LEGACY_LOG_DIRECTORY);
		if (
			normalized === pluginDataPath ||
			normalized.startsWith(`${pluginDataPath}/`) ||
			normalized === legacyLogPath ||
			normalized.startsWith(`${legacyLogPath}/`)
		) {
			return false;
		}
	}

	// Check config directory
	if (configDir && normalized.startsWith(configDir)) {
		if (!syncDotObsidian) {
			return false;
		}
	}

	// Check exclusions
	if (matchesPatterns(normalized, excludePatterns)) {
		return false;
	}

	// Check inclusions
	if (includePatterns.length === 0) {
		return true;
	}

	return matchesPatterns(normalized, includePatterns);
}

/**
 * Encode path for URL
 */
export function encodePathForUrl(path: string): string {
	return normalizePath(path)
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

/**
 * Generate unique device ID
 */
export function generateDeviceId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `device_${uuid}`;
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `device_${timestamp}_${random}`;
}

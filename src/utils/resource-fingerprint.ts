import type { YandexResource } from "../types";

/**
 * Return a content identity suitable for stable service-file reads.
 * Resource IDs are excluded because Yandex Disk may preserve them on overwrite.
 */
export function getStableContentFingerprint(
	resource: YandexResource | null,
): string | null {
	if (!resource) return null;
	if (resource.sha256) return `sha256:${resource.sha256}`;
	if (resource.md5) return `md5:${resource.md5}`;
	if (resource.modified) {
		return `modified:${resource.modified}:size:${resource.size ?? -1}`;
	}
	return null;
}

/**
 * Match the strongest content identity available in two metadata snapshots.
 */
export function getMatchingStableContentFingerprint(
	before: YandexResource,
	after: YandexResource,
): string | null {
	if (before.sha256 && after.sha256) {
		return before.sha256 === after.sha256
			? `sha256:${after.sha256}`
			: null;
	}
	if (before.md5 && after.md5) {
		return before.md5 === after.md5 ? `md5:${after.md5}` : null;
	}
	if (before.modified && after.modified) {
		return before.modified === after.modified && before.size === after.size
			? `modified:${after.modified}:size:${after.size ?? -1}`
			: null;
	}
	return null;
}

/**
 * Select the canonical persisted identity for a physical user resource.
 * Resource IDs and server modification times remain compatibility fallbacks.
 */
export function getPhysicalResourceFingerprint(
	resource: YandexResource | null,
): string | null {
	if (!resource) return null;
	return (
		resource.sha256 ??
		resource.md5 ??
		resource.resource_id ??
		resource.modified ??
		null
	);
}

/**
 * Match any supported fingerprint persisted for a physical resource.
 */
export function matchesPhysicalResourceFingerprint(
	expected: string | undefined,
	resource: YandexResource | null,
): boolean {
	if (!expected || !resource) return false;
	return [
		resource.sha256,
		resource.md5,
		resource.resource_id,
		resource.modified,
	].some((candidate) => candidate === expected);
}

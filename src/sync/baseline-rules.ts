import type { FileMetadata } from "../types";

/**
 * Compare local plaintext content with the last confirmed device baseline.
 */
export function hasLocalContentChanged(
	local: FileMetadata,
	baseline: FileMetadata | null,
): boolean {
	return baseline === null || local.sha256 !== baseline.sha256;
}

/**
 * Compare canonical logical state with the last confirmed device baseline.
 */
export function hasCanonicalMetadataChanged(
	canonical: FileMetadata | null,
	baseline: FileMetadata,
): boolean {
	return (
		canonical === null ||
		canonical.deleted !== baseline.deleted ||
		canonical.changedRevision !== baseline.changedRevision ||
		canonical.sha256 !== baseline.sha256
	);
}

/**
 * Detect server-owned physical drift, or return null when metadata is insufficient.
 */
export function getRemotePhysicalDrift(
	remote: FileMetadata,
	baseline: FileMetadata | null,
): boolean | null {
	if (!baseline) return true;
	if (
		baseline.remoteFingerprint !== undefined &&
		remote.remoteFingerprint !== undefined
	) {
		return baseline.remoteFingerprint !== remote.remoteFingerprint;
	}
	if (
		typeof baseline.remoteMtime === "number" &&
		Number.isFinite(baseline.remoteMtime) &&
		typeof remote.remoteMtime === "number" &&
		Number.isFinite(remote.remoteMtime)
	) {
		return baseline.remoteMtime !== remote.remoteMtime;
	}
	return null;
}

/**
 * Build the durable local baseline for a path confirmed live on both sides.
 */
export function createConfirmedBaseline(
	local: FileMetadata,
	remote: FileMetadata,
	canonical?: FileMetadata,
): FileMetadata {
	return {
		...local,
		remoteMtime: remote.remoteMtime,
		remoteFingerprint: remote.remoteFingerprint,
		changedRevision: canonical?.changedRevision,
		baseRevision: canonical?.baseRevision,
		lastModifiedBy: canonical?.lastModifiedBy,
		deleted: false,
		deletedAt: undefined,
		deletedByFolder: undefined,
	};
}

/**
 * Replace only server-owned physical metadata while preserving logical
 * causality. Returns null when concurrent logical state invalidates rewrite.
 */
export function mergePhysicalMetadata(
	current: FileMetadata | undefined,
	baseline: FileMetadata | undefined,
	desired: FileMetadata,
): FileMetadata | null {
	if (
		!current ||
		!baseline ||
		current.deleted !== baseline.deleted ||
		current.sha256 !== baseline.sha256 ||
		current.changedRevision !== baseline.changedRevision
	) {
		return null;
	}
	return {
		...current,
		remoteMtime: desired.remoteMtime,
		remoteFingerprint: desired.remoteFingerprint,
	};
}

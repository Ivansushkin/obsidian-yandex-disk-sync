import type { FileMetadata } from "../types";

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

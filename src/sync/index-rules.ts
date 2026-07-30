import type { FileMetadata, FolderTombstone } from "../types";
import { CURRENT_INDEX_VERSION } from "../types";

/**
 * Classify an index version for startup and force-sync migration.
 */
export function classifyIndexVersion(
	version: unknown,
): "current" | "legacy" | "unsupported" {
	if (version === CURRENT_INDEX_VERSION) return "current";
	if (version === 1 || version === 2) return "legacy";
	return "unsupported";
}

/**
 * Check whether a path is equal to a folder or belongs to its subtree.
 */
export function isPathInsideFolder(path: string, folderPath: string): boolean {
	const normalizedFolder = folderPath.replace(/\/+$/, "");
	return (
		path === normalizedFolder || path.startsWith(`${normalizedFolder}/`)
	);
}

/**
 * Select the newest folder tombstone that contains a path.
 */
export function findFolderTombstone(
	path: string,
	tombstones: Record<string, FolderTombstone>,
): FolderTombstone | null {
	let result: FolderTombstone | null = null;
	const segments = path.replace(/\/+$/, "").split("/");
	for (let depth = 1; depth < segments.length; depth++) {
		const tombstone = tombstones[segments.slice(0, depth).join("/")];
		if (!tombstone) continue;
		if (
			!result ||
			tombstone.changedRevision > result.changedRevision
		) {
			result = tombstone;
		}
	}
	return result;
}

/**
 * Check whether a live child changed after the deleting device's baseline.
 */
export function shouldPreserveConcurrentFolderChild(
	metadata: FileMetadata,
	folderBaseRevision: number,
): boolean {
	return (
		!metadata.deleted &&
		(metadata.changedRevision ?? 0) > folderBaseRevision
	);
}

/**
 * Decide whether an incoming file state may replace the current state.
 *
 * Exact-file deletion wins over a concurrent put. A causally later put, whose
 * base revision already includes the deletion, is an intentional recreation.
 */
export function shouldApplyFileMutation(
	current: FileMetadata | undefined,
	incoming: FileMetadata,
	baseRevision: number,
): boolean {
	if (incoming.deleted) {
		if (
			incoming.deletedByFolder &&
				current &&
				!current.deleted &&
				(current.changedRevision ?? 0) > baseRevision
			) {
				return false;
		}
		return true;
	}
	if (
		current &&
		!current.deleted &&
		(current.changedRevision ?? 0) > baseRevision &&
		current.sha256 !== incoming.sha256
	) {
		return false;
	}
	if (!current?.deleted) return true;
	if (current.deletedByFolder) {
		return true;
	}
	return (current.changedRevision ?? 0) <= baseRevision;
}

/**
 * Merge one file mutation and stamp the accepting revision.
 */
export function mergeFileMutation(
	current: FileMetadata | undefined,
	incoming: FileMetadata,
	baseRevision: number,
	nextRevision: number,
	deviceId: string,
): FileMetadata | undefined {
	if (!shouldApplyFileMutation(current, incoming, baseRevision)) {
		return current;
	}
	return {
		...incoming,
		baseRevision,
		changedRevision: nextRevision,
		lastModifiedBy: deviceId,
	};
}

/**
 * Advance a device mutation watermark only for the next FIFO sequence.
 */
export function advanceMutationSequence(
	appliedMutationSeq: Record<string, number>,
	deviceId: string,
	sequence: number,
): boolean {
	const current = appliedMutationSeq[deviceId] || 0;
	if (sequence !== current + 1) return false;
	appliedMutationSeq[deviceId] = sequence;
	return true;
}

/**
 * Check whether a lock has remained unchanged beyond its recovery lease.
 */
export function isStableLockStale(
	firstSeenAt: number,
	now: number,
	staleAfterMs: number,
): boolean {
	return now - firstSeenAt >= staleAfterMs;
}

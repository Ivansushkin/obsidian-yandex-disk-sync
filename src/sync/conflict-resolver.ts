/**
 * Synchronization conflict resolution
 */

import type {
	FileMetadata,
	FolderTombstone,
	SyncOperation,
} from "../types";
import { getFileName, getDirectory, getExtension } from "../utils/path-utils";
import { logger } from "../utils/logger";
import { findFolderTombstone } from "./index-rules";

export interface ConflictInfo {
	path: string;
	localMeta: FileMetadata;
	remoteMeta: FileMetadata;
	reason: string;
}

export class ConflictResolver {
	/**
	 * Determine action for file based on metadata comparison
	 */
	resolveAction(
		path: string,
		localMeta: FileMetadata | null,
		remoteMeta: FileMetadata | null,
		localIndexMeta: FileMetadata | null,
		remoteIndexMeta: FileMetadata | null,
		syncStartTime?: number,
		pendingLocalDelete = false,
	): SyncOperation {
		// Case 1: File only local (not on disk and not in remote index)
		if (localMeta && !remoteMeta && !remoteIndexMeta) {
			return {
				action: "upload",
				path,
				reason: "New local file",
				localMeta,
			};
		}

		// Case 2: File only on disk (not local and not in local index)
		if (!localMeta && remoteMeta && !localIndexMeta) {
			return {
				action: "download",
				path,
				reason: "New remote file",
				remoteMeta,
			};
		}

		if (remoteIndexMeta?.deleted) {
			if (localMeta && pendingLocalDelete) {
				return {
					action: "delete_local",
					path,
					reason: "Resuming a committed local physical deletion",
					localMeta,
					remoteMeta: remoteMeta || undefined,
				};
			}
			if (localMeta && (!localIndexMeta || localIndexMeta.deleted)) {
				return {
					action: "upload",
					path,
					reason:
						"New file restores a previously deleted path",
					localMeta,
					remoteMeta: remoteMeta || undefined,
				};
			}
			if (localMeta) {
				return {
					action: "delete_local",
					path,
					reason: "Exact-file remote deletion wins",
					localMeta,
					remoteMeta: remoteMeta || undefined,
				};
			}
			if (remoteMeta) {
				return {
					action: "delete_remote",
					path,
					reason:
						"Removing a physical file rejected by its tombstone",
					remoteMeta,
				};
			}
		}

		// Case 3: File deleted locally (was in local index, exists on disk)
		if (!localMeta && remoteMeta && localIndexMeta?.deleted) {
			if (
				localIndexMeta.deletedByFolder &&
				remoteIndexMeta &&
				!remoteIndexMeta.deleted
			) {
				return {
					action: "download",
					path,
					reason:
						"Concurrent descendant survived folder deletion",
					remoteMeta,
				};
			}
			return {
				action: "delete_remote",
				path,
				reason: "File deleted locally",
				remoteMeta,
			};
		}

		// Case 4: File deleted on disk (was in remote index, exists locally)
		if (localMeta && !remoteMeta && remoteIndexMeta?.deleted) {
			return {
				action: "delete_local",
				path,
				reason: "File deleted on disk",
				localMeta,
			};
		}

		// Case 5: File was deleted locally, but not on disk (already synchronized)
		if (!localMeta && !remoteMeta) {
			if (localIndexMeta?.deleted && !remoteIndexMeta?.deleted) {
				return {
					action: "none",
					path,
					reason:
						"Stale local deletion has no pending causal mutation",
				};
			}
			if (remoteIndexMeta?.deleted && !localIndexMeta?.deleted) {
				return {
					action: "delete_local",
					path,
					reason: "Applying a committed remote deletion",
				};
			}
			return {
				action: "none",
				path,
				reason: "File deleted on both sides",
			};
		}

		// Case 6: Both files exist - compare them
		if (localMeta && remoteMeta) {
			return this.compareFiles(
				path,
				localMeta,
				remoteMeta,
				localIndexMeta,
				remoteIndexMeta,
				syncStartTime,
			);
		}

		// Case 7: File exists only locally, but was in remote index (deleted on disk)
		if (localMeta && !remoteMeta && remoteIndexMeta) {
			if (
				!remoteIndexMeta.deleted &&
				localMeta.sha256 === remoteIndexMeta.sha256
			) {
				return {
					action: "upload",
					path,
					reason:
						"Repairing a physical file missing from canonical state",
					localMeta,
				};
			}
			return {
				action: "delete_local",
				path,
				reason: "Exact-file remote deletion wins",
				localMeta,
			};
		}

		// Case 8: File exists only on disk, but was in local index (deleted locally)
		if (!localMeta && remoteMeta && localIndexMeta) {
			return {
				action: "delete_remote",
				path,
				reason: "Exact-file local deletion wins",
				remoteMeta,
			};
		}

		return {
			action: "none",
			path,
			reason: "Undefined state",
		};
	}

	/**
	 * Compare two existing files.
	 *
	 * When the remote index entry carries a server-side mtime
	 * ({@link FileMetadata.remoteMtime}), a two-sided comparison is used that
	 * detects local changes via content hash (both plaintext, works under
	 * encryption) and remote changes via server mtime (both from the Yandex
	 * clock, immune to device clock skew). When a server-mtime baseline is
	 * unavailable, server fingerprints are used if possible; otherwise the
	 * result is conservative and never compares client clocks.
	 */
	private compareFiles(
		path: string,
		localMeta: FileMetadata,
		remoteMeta: FileMetadata,
		localIndexMeta: FileMetadata | null,
		remoteIndexMeta: FileMetadata | null,
		_syncStartTime?: number,
	): SyncOperation {
		// Direct hash equality is available in plaintext mode.
		if (localMeta.sha256 === remoteMeta.sha256) {
			return {
				action: "none",
				path,
				reason: "Files are identical",
				localMeta,
				remoteMeta,
			};
		}

		if (!localIndexMeta) {
			if (
				remoteIndexMeta &&
				localMeta.sha256 === remoteIndexMeta.sha256 &&
				!this.hasPhysicalRemoteDrift(remoteMeta, remoteIndexMeta)
			) {
				return {
					action: "none",
					path,
					reason: "First sync found identical plaintext content",
					localMeta,
					remoteMeta,
				};
			}
			logger.warn(`First-sync conflict for file: ${path}`);
			return {
				action: "conflict",
				path,
				reason:
					"Different local and remote files share a path without a baseline",
				localMeta,
				remoteMeta,
			};
		}

		const localChanged =
			localMeta.sha256 !== localIndexMeta.sha256;
		const canonicalChanged =
			!remoteIndexMeta ||
			remoteIndexMeta.deleted !== localIndexMeta.deleted ||
			remoteIndexMeta.changedRevision !==
				localIndexMeta.changedRevision ||
			remoteIndexMeta.sha256 !== localIndexMeta.sha256;
		const remotelyChanged =
			canonicalChanged ||
			this.hasPhysicalRemoteDrift(remoteMeta, remoteIndexMeta);

		if (localChanged && remotelyChanged) {
			logger.warn(`Conflict for file: ${path}`);
			return {
				action: "conflict",
				path,
				reason:
					"Both local and canonical/remote changed since the device baseline",
				localMeta,
				remoteMeta,
			};
		}
		if (localChanged) {
			return {
				action: "upload",
				path,
				reason: "Only local content changed since the device baseline",
				localMeta,
				remoteMeta,
			};
		}
		if (remotelyChanged) {
			return {
				action: "download",
				path,
				reason:
					"Only canonical/remote content changed since the device baseline",
				localMeta,
				remoteMeta,
			};
		}
		return {
			action: "none",
			path,
			reason: "Neither side changed since the device baseline",
			localMeta,
			remoteMeta,
		};
	}

	/**
	 * Detect physical remote changes without comparing client and server clocks.
	 */
	private hasPhysicalRemoteDrift(
		remoteMeta: FileMetadata,
		remoteIndexMeta: FileMetadata | null,
	): boolean {
		if (!remoteIndexMeta) return true;
		if (
			remoteIndexMeta.remoteFingerprint !== undefined &&
			remoteMeta.remoteFingerprint !== undefined
		) {
			return (
				remoteIndexMeta.remoteFingerprint !==
				remoteMeta.remoteFingerprint
			);
		}
		if (
			typeof remoteIndexMeta.remoteMtime === "number" &&
			Number.isFinite(remoteIndexMeta.remoteMtime) &&
			typeof remoteMeta.remoteMtime === "number" &&
			Number.isFinite(remoteMeta.remoteMtime)
		) {
			return remoteIndexMeta.remoteMtime !== remoteMeta.remoteMtime;
		}
		return remoteMeta.sha256 !== remoteIndexMeta.sha256;
	}

	/**
	 * Generate name for conflict copy
	 */
	generateConflictName(path: string, deviceId: string): string {
		const dir = getDirectory(path);
		const fileName = getFileName(path);
		const ext = getExtension(path);
		const baseName = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;

		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, 19);

		const shortDeviceId = deviceId.slice(-6);
		const conflictName = `${baseName}_conflict_${timestamp}_${shortDeviceId}${
			ext ? "." + ext : ""
		}`;

		return dir ? `${dir}/${conflictName}` : conflictName;
	}

	/**
	 * Collect all files for synchronization from both sources
	 */
	collectAllPaths(
		localFiles: Map<string, FileMetadata>,
		remoteFiles: Map<string, FileMetadata>,
		localIndex: Record<string, FileMetadata>,
		remoteIndex: Record<string, FileMetadata>,
	): Set<string> {
		const allPaths = new Set<string>();

		for (const path of localFiles.keys()) {
			allPaths.add(path);
		}
		for (const path of remoteFiles.keys()) {
			allPaths.add(path);
		}
		for (const path of Object.keys(localIndex)) {
			allPaths.add(path);
		}
		for (const path of Object.keys(remoteIndex)) {
			allPaths.add(path);
		}

		return allPaths;
	}

	/**
	 * Determine all synchronization operations
	 */
	determineOperations(
		localFiles: Map<string, FileMetadata>,
		remoteFiles: Map<string, FileMetadata>,
		localIndex: Record<string, FileMetadata>,
		remoteIndex: Record<string, FileMetadata>,
		syncStartTime?: number,
		folderTombstones: Record<string, FolderTombstone> = {},
		pendingLocalDeletes: ReadonlySet<string> = new Set(),
	): SyncOperation[] {
		const allPaths = this.collectAllPaths(
			localFiles,
			remoteFiles,
			localIndex,
			remoteIndex,
		);

		const operations: SyncOperation[] = [];

		for (const path of allPaths) {
			const localMeta = localFiles.get(path) || null;
			const remoteMeta = remoteFiles.get(path) || null;
			const localIndexMeta = localIndex[path] || null;
			const remoteIndexMeta = remoteIndex[path] || null;
			const folderTombstone = findFolderTombstone(
				path,
				folderTombstones,
			);
			const tombstoneApplies =
				folderTombstone !== null &&
				(remoteIndexMeta?.changedRevision ?? 0) <
					folderTombstone.changedRevision;

			if (tombstoneApplies) {
				const localChanged =
					localMeta !== null &&
					(localIndexMeta === null ||
						localMeta.sha256 !== localIndexMeta.sha256);
				const remoteChanged =
					remoteMeta !== null &&
					(remoteIndexMeta === null ||
						(remoteMeta.remoteFingerprint !== undefined &&
							remoteIndexMeta.remoteFingerprint !== undefined &&
							remoteMeta.remoteFingerprint !==
								remoteIndexMeta.remoteFingerprint) ||
						(typeof remoteMeta.remoteMtime === "number" &&
							typeof remoteIndexMeta.remoteMtime === "number" &&
							remoteMeta.remoteMtime !==
								remoteIndexMeta.remoteMtime));
				if (localChanged && remoteChanged) {
					operations.push({
						action: "conflict",
						path,
						reason:
							"Both descendants changed during folder deletion",
						localMeta,
						remoteMeta,
					});
					continue;
				}
				if (localChanged) {
					operations.push({
						action: "upload",
						path,
						reason:
							"New or modified file survives concurrent folder deletion",
						localMeta,
						remoteMeta: remoteMeta || undefined,
					});
					continue;
				}
				if (remoteChanged) {
					operations.push({
						action: "download",
						path,
						reason:
							"New or modified remote file survives concurrent folder deletion",
						remoteMeta,
					});
					continue;
				}
				if (localMeta) {
					operations.push({
						action: "delete_local",
						path,
						reason: "Parent folder was deleted",
						localMeta,
						folderTombstonePath: folderTombstone?.path,
					});
					continue;
				}
				if (remoteMeta) {
					operations.push({
						action: "delete_remote",
						path,
						reason: "Parent folder was deleted",
						remoteMeta,
						folderTombstonePath: folderTombstone?.path,
					});
					continue;
				}
			}

			const operation = this.resolveAction(
				path,
				localMeta,
				remoteMeta,
				localIndexMeta,
					remoteIndexMeta,
					syncStartTime,
					pendingLocalDeletes.has(path),
				);

			if (operation.action !== "none") {
				operations.push(operation);
			}
		}

		return operations;
	}
}

/**
 * Synchronization conflict resolution
 */

import type { FileMetadata, SyncOperation } from "../types";
import { getFileName, getDirectory, getExtension } from "../utils/path-utils";
import { logger } from "../utils/logger";

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
		remoteIndexMeta: FileMetadata | null
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

		// Case 3: File deleted locally (was in local index, exists on disk)
		if (!localMeta && remoteMeta && localIndexMeta?.deleted) {
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
			return {
				action: "none",
				path,
				reason: "File deleted on both sides",
			};
		}

		// Case 6: Both files exist - compare them
		if (localMeta && remoteMeta) {
			return this.compareFiles(path, localMeta, remoteMeta);
		}

		// Case 7: File exists only locally, but was in remote index (deleted on disk)
		if (localMeta && !remoteMeta && remoteIndexMeta) {
			// Check if local file was modified after deletion on disk
			if (localMeta.mtime > (remoteIndexMeta.deletedAt || 0)) {
				return {
					action: "upload",
					path,
					reason: "Local file modified after deletion on disk",
					localMeta,
				};
			}
			return {
				action: "delete_local",
				path,
				reason: "File deleted on disk",
				localMeta,
			};
		}

		// Case 8: File exists only on disk, but was in local index (deleted locally)
		if (!localMeta && remoteMeta && localIndexMeta) {
			// Check if remote file was modified after local deletion
			if (remoteMeta.mtime > (localIndexMeta.deletedAt || 0)) {
				return {
					action: "download",
					path,
					reason: "Remote file modified after local deletion",
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

		return {
			action: "none",
			path,
			reason: "Undefined state",
		};
	}

	/**
	 * Compare two existing files
	 */
	private compareFiles(
		path: string,
		localMeta: FileMetadata,
		remoteMeta: FileMetadata
	): SyncOperation {
		// Hashes match - files are identical
		if (localMeta.sha256 === remoteMeta.sha256) {
			return {
				action: "none",
				path,
				reason: "Files are identical",
				localMeta,
				remoteMeta,
			};
		}

		// Hashes differ - determine direction by modification time
		const timeDiff = localMeta.mtime - remoteMeta.mtime;

		// 1 second tolerance for time inaccuracy
		const TIME_TOLERANCE = 1000;

		if (timeDiff > TIME_TOLERANCE) {
			// Local file is newer
			return {
				action: "upload",
				path,
				reason: "Local file is newer",
				localMeta,
				remoteMeta,
			};
		} else if (timeDiff < -TIME_TOLERANCE) {
			// Remote file is newer
			return {
				action: "download",
				path,
				reason: "Remote file is newer",
				localMeta,
				remoteMeta,
			};
		} else {
			// Times are approximately equal, but hashes differ - conflict
			logger.warn(`Conflict for file: ${path}`);
			return {
				action: "conflict",
				path,
				reason: "Same modification time but different content",
				localMeta,
				remoteMeta,
			};
		}
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
		const conflictName = `${baseName}_conflict_${timestamp}_${shortDeviceId}${ext ? "." + ext : ""
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
		remoteIndex: Record<string, FileMetadata>
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
		remoteIndex: Record<string, FileMetadata>
	): SyncOperation[] {
		const allPaths = this.collectAllPaths(
			localFiles,
			remoteFiles,
			localIndex,
			remoteIndex
		);

		const operations: SyncOperation[] = [];

		for (const path of allPaths) {
			const localMeta = localFiles.get(path) || null;
			const remoteMeta = remoteFiles.get(path) || null;
			const localIndexMeta = localIndex[path] || null;
			const remoteIndexMeta = remoteIndex[path] || null;

			const operation = this.resolveAction(
				path,
				localMeta,
				remoteMeta,
				localIndexMeta,
				remoteIndexMeta
			);

			if (operation.action !== "none") {
				operations.push(operation);
			}
		}

		return operations;
	}
}

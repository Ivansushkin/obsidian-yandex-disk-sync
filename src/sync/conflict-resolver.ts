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
		remoteIndexMeta: FileMetadata | null,
		syncStartTime?: number
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
			// When encryption is active, Yandex Disk API returns sha256 of encrypted content,
			// which never matches the local file's sha256 of plaintext content.
			// The remote index stores the correct plaintext sha256 from the last sync.
			// If local sha256 matches the remote index, the file hasn't changed.
			if (remoteIndexMeta && localMeta.sha256 === remoteIndexMeta.sha256) {
				return {
					action: "none",
					path,
					reason: "Files match index (encryption)",
					localMeta,
					remoteMeta,
				};
			}
			return this.compareFiles(path, localMeta, remoteMeta, syncStartTime);
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
		remoteMeta: FileMetadata,
		syncStartTime?: number
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
		const currentTime = Date.now();

		// Time tolerances
		const TIME_TOLERANCE = 1000;           // Original tolerance for exact matches
		const EXTENDED_TIME_TOLERANCE = 5000;  // Extended tolerance before creating conflicts
		const FRESH_FILE_THRESHOLD = 5000;     // Files modified within this time are considered fresh

		// Check if time difference is significant enough to determine winner
		if (Math.abs(timeDiff) > EXTENDED_TIME_TOLERANCE) {
			// Large time difference - use standard logic
			if (timeDiff > 0) {
				// Local file is significantly newer
				return {
					action: "upload",
					path,
					reason: "Local file is significantly newer",
					localMeta,
					remoteMeta,
				};
			} else {
				// Remote file is significantly newer
				return {
					action: "download",
					path,
					reason: "Remote file is significantly newer",
					localMeta,
					remoteMeta,
				};
			}
		}

		// Small time difference - check if file is "fresh" (actively being edited)
		const localFileAge = currentTime - localMeta.mtime;
		const remoteFileAge = currentTime - remoteMeta.mtime;
		const isLocalFresh = localFileAge < FRESH_FILE_THRESHOLD;
		const isRemoteFresh = remoteFileAge < FRESH_FILE_THRESHOLD;

		if (isLocalFresh || isRemoteFresh) {
			// At least one file is fresh - give priority to the newer one
			if (timeDiff > 0) {
				return {
					action: "upload",
					path,
					reason: "Fresh local file is newer",
					localMeta,
					remoteMeta,
				};
			} else {
				return {
					action: "download",
					path,
					reason: "Fresh remote file is newer",
					localMeta,
					remoteMeta,
				};
			}
		}

		// Files are not fresh and time difference is small - check for very close times
		if (Math.abs(timeDiff) <= TIME_TOLERANCE) {
			// Times are very close but content differs - create conflict
			logger.warn(`Conflict for file: ${path}`);
			return {
				action: "conflict",
				path,
				reason: "Very similar modification times but different content",
				localMeta,
				remoteMeta,
			};
		}

		// Small difference but not fresh - still determine winner based on time
		if (timeDiff > 0) {
			return {
				action: "upload",
				path,
				reason: "Local file is slightly newer",
				localMeta,
				remoteMeta,
			};
		} else {
			return {
				action: "download",
				path,
				reason: "Remote file is slightly newer",
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
		remoteIndex: Record<string, FileMetadata>,
		syncStartTime?: number
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
				remoteIndexMeta,
				syncStartTime
			);

			if (operation.action !== "none") {
				operations.push(operation);
			}
		}

		return operations;
	}
}

/**
 * Synchronization conflict resolution
 */

import type { FileMetadata, SyncOperation } from "../types";
import { getFileName, getDirectory, getExtension } from "../utils/path-utils";
import { logger } from "../utils/logger";

/**
 * Tolerance applied when comparing the server-side mtime of a remote resource
 * against the server-side mtime stored in the remote index. Both values come
 * from the Yandex Disk API clock, so this only needs to absorb minor jitter
 * (re-reads, caching, sub-second rounding) — not inter-device clock skew.
 */
const CONFLICT_REMOTE_MTIME_TOLERANCE = 5000;

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
			// When encryption is active, Yandex Disk returns the sha256 of the
			// *encrypted* content, which never matches the local plaintext
			// sha256. The remote index, however, stores the plaintext sha256
			// from the last sync. If the local sha256 still matches the remote
			// index, the local file has not changed since the last sync.
			if (
				remoteIndexMeta &&
				localMeta.sha256 === remoteIndexMeta.sha256
			) {
				// Local unchanged. But the remote may have been modified
				// externally (Yandex web UI, another client that did not update
				// the index, etc.). Detect that by comparing the *server* mtime
				// we stored in the remote index against the server mtime we now
				// observe. If we don't have a stored remote mtime (older plugin
				// wrote this entry, or it was never (re)synced by this version),
				// there is no reliable way to tell — keep the legacy behavior of
				// treating the file as unchanged.
				const indexRemoteMtime = remoteIndexMeta.remoteMtime;
				const currentRemoteMtime = remoteMeta.remoteMtime;
				const remotelyChanged =
					typeof indexRemoteMtime === "number" &&
					Number.isFinite(indexRemoteMtime) &&
					typeof currentRemoteMtime === "number" &&
					Number.isFinite(currentRemoteMtime) &&
					currentRemoteMtime - indexRemoteMtime >
						CONFLICT_REMOTE_MTIME_TOLERANCE;
				if (!remotelyChanged) {
					return {
						action: "none",
						path,
						reason: "Files match index (encryption)",
						localMeta,
						remoteMeta,
					};
				}
				// Fall through: remote changed externally, let compareFiles
				// decide the direction.
			}
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
	 * Compare two existing files.
	 *
	 * When the remote index entry carries a server-side mtime
	 * ({@link FileMetadata.remoteMtime}), a two-sided comparison is used that
	 * detects local changes via content hash (both plaintext, works under
	 * encryption) and remote changes via server mtime (both from the Yandex
	 * clock, immune to device clock skew). When the stored remote mtime is
	 * unavailable (entries written by an older plugin version or never
	 * re-synced by this version), the legacy mixed-clock comparison is used
	 * to avoid regressing existing behavior.
	 */
	private compareFiles(
		path: string,
		localMeta: FileMetadata,
		remoteMeta: FileMetadata,
		localIndexMeta: FileMetadata | null,
		remoteIndexMeta: FileMetadata | null,
		_syncStartTime?: number,
	): SyncOperation {
		// Hashes match - files are identical (covers the unencrypted case where
		// Yandex's sha256 is the plaintext sha256, and any case where content
		// hashes are directly comparable).
		if (localMeta.sha256 === remoteMeta.sha256) {
			return {
				action: "none",
				path,
				reason: "Files are identical",
				localMeta,
				remoteMeta,
			};
		}

		const indexRemoteMtime = remoteIndexMeta?.remoteMtime;
		const currentRemoteMtime = remoteMeta.remoteMtime;
		const remoteMtimeKnown =
			!!remoteIndexMeta &&
			typeof indexRemoteMtime === "number" &&
			Number.isFinite(indexRemoteMtime) &&
			typeof currentRemoteMtime === "number" &&
			Number.isFinite(currentRemoteMtime);

		if (remoteMtimeKnown) {
			// Local change detection — content based. Both hashes are of the
			// plaintext (local filesystem + index), so this is reliable under
			// encryption too. When there is no local index entry, treat the
			// local file as changed (conservative: we don't know its last
			// synced state, so we must not silently drop it).
			const localChanged =
				!localIndexMeta || localMeta.sha256 !== localIndexMeta.sha256;

			// Remote change detection — server mtime based. Both timestamps
			// come from Yandex Disk, so this is immune to client clock skew and
			// to the local/server mtime semantic mismatch that plagued the
			// legacy comparison.
			const remotelyChanged =
				currentRemoteMtime - indexRemoteMtime >
				CONFLICT_REMOTE_MTIME_TOLERANCE;

			if (localChanged && remotelyChanged) {
				logger.warn(`Conflict for file: ${path}`);
				return {
					action: "conflict",
					path,
					reason: "Both local and remote changed since last sync (server mtime)",
					localMeta,
					remoteMeta,
				};
			}
			if (localChanged) {
				return {
					action: "upload",
					path,
					reason: "Local file changed since last sync",
					localMeta,
					remoteMeta,
				};
			}
			if (remotelyChanged) {
				return {
					action: "download",
					path,
					reason: "Remote file changed since last sync",
					localMeta,
					remoteMeta,
				};
			}
			return {
				action: "none",
				path,
				reason: "Neither side changed since last sync",
				localMeta,
				remoteMeta,
			};
		}

		// Legacy fallback: no reliable server-side mtime baseline. Preserve the
		// previous mixed-clock behavior so we don't regress on indexes written
		// by older plugin versions.
		return this.compareFilesLegacy(path, localMeta, remoteMeta);
	}

	/**
	 * Legacy mixed-clock comparison used when the remote index entry does not
	 * carry a server-side mtime. Retained verbatim for behavioral parity with
	 * plugin versions that did not populate {@link FileMetadata.remoteMtime}.
	 */
	private compareFilesLegacy(
		path: string,
		localMeta: FileMetadata,
		remoteMeta: FileMetadata,
	): SyncOperation {
		const timeDiff = localMeta.mtime - remoteMeta.mtime;
		const currentTime = Date.now();

		const TIME_TOLERANCE = 1000;
		const EXTENDED_TIME_TOLERANCE = 5000;
		const FRESH_FILE_THRESHOLD = 5000;

		if (Math.abs(timeDiff) > EXTENDED_TIME_TOLERANCE) {
			if (timeDiff > 0) {
				return {
					action: "upload",
					path,
					reason: "Local file is significantly newer",
					localMeta,
					remoteMeta,
				};
			}
			return {
				action: "download",
				path,
				reason: "Remote file is significantly newer",
				localMeta,
				remoteMeta,
			};
		}

		const localFileAge = currentTime - localMeta.mtime;
		const remoteFileAge = currentTime - remoteMeta.mtime;
		const isLocalFresh = localFileAge < FRESH_FILE_THRESHOLD;
		const isRemoteFresh = remoteFileAge < FRESH_FILE_THRESHOLD;

		if (isLocalFresh || isRemoteFresh) {
			if (timeDiff > 0) {
				return {
					action: "upload",
					path,
					reason: "Fresh local file is newer",
					localMeta,
					remoteMeta,
				};
			}
			return {
				action: "download",
				path,
				reason: "Fresh remote file is newer",
				localMeta,
				remoteMeta,
			};
		}

		if (Math.abs(timeDiff) <= TIME_TOLERANCE) {
			logger.warn(`Conflict for file: ${path}`);
			return {
				action: "conflict",
				path,
				reason: "Very similar modification times but different content",
				localMeta,
				remoteMeta,
			};
		}

		if (timeDiff > 0) {
			return {
				action: "upload",
				path,
				reason: "Local file is slightly newer",
				localMeta,
				remoteMeta,
			};
		}
		return {
			action: "download",
			path,
			reason: "Remote file is slightly newer",
			localMeta,
			remoteMeta,
		};
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

			const operation = this.resolveAction(
				path,
				localMeta,
				remoteMeta,
				localIndexMeta,
				remoteIndexMeta,
				syncStartTime,
			);

			if (operation.action !== "none") {
				operations.push(operation);
			}
		}

		return operations;
	}
}

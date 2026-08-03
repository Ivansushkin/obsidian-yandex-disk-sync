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
import {
	getRemotePhysicalDrift,
	hasCanonicalMetadataChanged,
	hasLocalContentChanged,
} from "./baseline-rules";

export class ConflictResolver {
	/**
	 * Reconcile a replacement canonical epoch against the last fully applied
	 * device baseline. Revisions are intentionally ignored across epochs;
	 * content and existence form the three-way merge boundary.
	 */
	determineEpochAdoptionOperations(
		localFiles: Map<string, FileMetadata>,
		remoteFiles: Map<string, FileMetadata>,
		previousBaseline: Record<string, FileMetadata>,
		canonicalFiles: Record<string, FileMetadata>,
	): SyncOperation[] {
		const allPaths = this.collectAllPaths(
			localFiles,
			remoteFiles,
			previousBaseline,
			canonicalFiles,
		);
		const operations: SyncOperation[] = [];
		for (const path of allPaths) {
			const local = localFiles.get(path) ?? null;
			const physical = remoteFiles.get(path) ?? null;
			const baseline = previousBaseline[path] ?? null;
			const canonicalEntry = canonicalFiles[path] ?? null;
			const remoteLive = canonicalEntry && !canonicalEntry.deleted
				? {
						...canonicalEntry,
						remoteMtime:
							physical?.remoteMtime ?? canonicalEntry.remoteMtime,
						remoteFingerprint:
							physical?.remoteFingerprint ??
							canonicalEntry.remoteFingerprint,
					}
				: null;

			const baselineLive = baseline !== null && !baseline.deleted;
			const localChanged = baselineLive
				? local === null || local.sha256 !== baseline.sha256
				: local !== null;
			const logicalRemoteChanged = baselineLive
				? remoteLive === null || remoteLive.sha256 !== baseline.sha256
				: remoteLive !== null;
			const physicalRemoteChanged = remoteLive
				? physical === null ||
					(getRemotePhysicalDrift(physical, canonicalEntry) ?? false)
				: false;
			const remoteChanged =
				logicalRemoteChanged || physicalRemoteChanged;

			let operation: SyncOperation;
			if (
				local &&
				remoteLive &&
				!physical &&
				local.sha256 === remoteLive.sha256
			) {
				operation = {
					action: "upload",
					path,
					reason: "Repairing physical content in replacement epoch",
					localMeta: local,
				};
			} else if (
				local &&
				remoteLive &&
				local.sha256 === remoteLive.sha256 &&
				!physicalRemoteChanged
			) {
				operation = {
					action: "none",
					path,
					reason: "Replacement epoch contains identical content",
					localMeta: local,
					remoteMeta: remoteLive,
				};
			} else if (localChanged && remoteChanged) {
				operation = this.resolveConcurrentEpochChange(
					path,
					local,
					remoteLive,
				);
			} else if (localChanged) {
				operation = local
					? {
							action: "upload",
							path,
							reason: "Local change is reapplied to replacement epoch",
							localMeta: local,
							remoteMeta: remoteLive ?? undefined,
						}
					: remoteLive
						? {
								action: "delete_remote",
								path,
								reason: "Local deletion is reapplied to replacement epoch",
								remoteMeta: remoteLive,
							}
						: { action: "none", path, reason: "Path is absent" };
			} else if (remoteChanged) {
				operation = remoteLive
					? {
							action: "download",
							path,
							reason: "Replacement epoch changed remote content",
							localMeta: local ?? undefined,
							remoteMeta: remoteLive,
						}
					: local
						? {
								action: "delete_local",
								path,
								reason: "Replacement epoch deleted the path",
								localMeta: local,
							}
						: { action: "none", path, reason: "Path is absent" };
			} else {
				operation = { action: "none", path, reason: "Path is unchanged" };
			}
			if (operation.action !== "none") operations.push(operation);
		}
		return operations.map((operation) =>
			this.withCausalOrigin(operation, canonicalFiles[operation.path]),
		);
	}

	private resolveConcurrentEpochChange(
		path: string,
		local: FileMetadata | null,
		remote: FileMetadata | null,
	): SyncOperation {
		if (local && remote) {
			return {
				action: "conflict",
				path,
				reason: "Local and replacement epoch both changed the file",
				localMeta: local,
				remoteMeta: remote,
			};
		}
		if (local) {
			return {
				action: "upload",
				path,
				reason: "Local content restores a remotely deleted path",
				localMeta: local,
			};
		}
		if (remote) {
			return {
				action: "delete_remote",
				path,
				reason: "Local deletion wins in the replacement epoch",
				remoteMeta: remote,
			};
		}
		return { action: "none", path, reason: "Path is absent" };
	}

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

		const localChanged = hasLocalContentChanged(
			localMeta,
			localIndexMeta,
		);
		const canonicalChanged = hasCanonicalMetadataChanged(
			remoteIndexMeta,
			localIndexMeta,
		);
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
		return (
			getRemotePhysicalDrift(remoteMeta, remoteIndexMeta) ??
			remoteMeta.sha256 !== remoteIndexMeta?.sha256
		);
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
					hasLocalContentChanged(localMeta, localIndexMeta);
				const remoteChanged =
					remoteMeta !== null &&
					(getRemotePhysicalDrift(remoteMeta, remoteIndexMeta) ??
						false);
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

		return operations.map((operation) =>
			this.withCausalOrigin(operation, remoteIndex[operation.path]),
		);
	}

	/** Classify whether reconciliation creates logic or only applies known state. */
	private withCausalOrigin(
		operation: SyncOperation,
		canonical: FileMetadata | undefined,
	): SyncOperation {
		if (
			operation.reason.startsWith("Repairing") ||
			operation.reason.startsWith("Resuming") ||
			operation.reason.startsWith("Removing a physical")
		) {
			return { ...operation, causalOrigin: "physical-repair" };
		}
		if (
			operation.folderTombstonePath !== undefined ||
			canonical?.deleted === true ||
			operation.action === "download"
		) {
			return { ...operation, causalOrigin: "apply-canonical" };
		}
		return { ...operation, causalOrigin: "new-local-operation" };
	}
}

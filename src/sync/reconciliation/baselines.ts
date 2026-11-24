import type { FileMetadata, PendingMutation, SyncOperation } from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { joinPath, PathAncestryIndex } from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	matchesListedFile,
} from "../../utils/resource-fingerprint";
import { getPublishedFolderDeletion } from "../canonical/mutation-rules";
import type { SyncGuardResult } from "../contracts";
import * as fileOperations from "../files/operations";
import {
	PendingPutLookup,
	createConfirmedBaseline,
	isPublishedRemoteVersion,
	getRemotePhysicalDrift,
} from "../local/baseline-rules";
import type { Dependencies as ReconciliationDependencies } from "./context";
export type Dependencies = Pick<
	ReconciliationDependencies,
	| "fileOperations"
	| "getSyncGuardResult"
	| "indexManager"
	| "settings"
	| "yandexClient"
>;

/** Resolve metadata uncertainty using stable plaintext without retaining vault-sized buffers. */
export async function verifyRemoteContentCandidates(
	deps: Dependencies,
	localFiles: Map<string, FileMetadata>,
	remoteFiles: Map<string, FileMetadata>,
): Promise<{ metadataChanged: boolean; hashVerifiedPaths: Set<string> }> {
	let metadataChanged = false;
	const hashVerifiedPaths = new Set<string>();
	const index = deps.indexManager.getRemoteIndex();
	let guard: SyncGuardResult | undefined;
	for (const [path, remote] of remoteFiles) {
		const local = localFiles.get(path);
		const canonical = index.files[path];
		if (canonical?.deleted) {
			// A fresh ciphertext may still contain the deleted plaintext, even without a local copy.
			if (
				!getPublishedFolderDeletion(
					path,
					canonical,
					index.folderTombstones,
				) ||
				getRemotePhysicalDrift(remote, canonical) === false
			) {
				continue;
			}
		} else if (
			!local ||
			(local.sha256 === remote.sha256 &&
				canonical?.sha256 === local.sha256 &&
				canonical.remoteFingerprint === remote.remoteFingerprint &&
				canonical.remoteMtime === remote.remoteMtime)
		) {
			continue;
		}
		if (
			canonical &&
			!canonical.deleted &&
			remote.sha256 &&
			canonical.remoteFingerprint === remote.sha256 &&
			canonical.remoteMtime === remote.remoteMtime
		) {
			remoteFiles.set(path, { ...remote, sha256: canonical.sha256 });
			continue;
		}
		guard ??= await deps.getSyncGuardResult(false);
		if (guard.blockReason) {
			throw new Error(guard.blockReason);
		}
		const snapshot = await deps.yandexClient.downloadStableLogicalFile(
			joinPath(deps.settings.remotePath, path),
		);
		if (!snapshot || !matchesListedFile(remote, snapshot.resource)) {
			throw new Error(
				"Remote content cannot be verified for reconciliation",
			);
		}
		const sha256 = await computeSha256(snapshot.content);
		const published = isPublishedRemoteVersion(remote, canonical);
		if (
			published
				? canonical?.sha256 !== sha256
				: !snapshot.verifiedRawHashAlgorithm
		) {
			throw new Error(
				"Remote file bytes could not be verified for reconciliation",
			);
		}
		await fileOperations.assertDownloadLocalUnchanged(
			deps.fileOperations,
			path,
			local?.sha256 ?? null,
		);
		remoteFiles.set(path, {
			...remote,
			sha256,
			remoteFingerprint:
				getPhysicalResourceFingerprint(snapshot.resource) ?? undefined,
			remoteMtime: new Date(snapshot.resource.modified).getTime(),
		});
		if (snapshot.verifiedRawHashAlgorithm) {
			hashVerifiedPaths.add(path);
		}
		if (canonical && !canonical.deleted && canonical.sha256 === sha256) {
			const verified = remoteFiles.get(path)!;
			if (
				canonical.remoteFingerprint !== verified.remoteFingerprint ||
				canonical.remoteMtime !== verified.remoteMtime
			) {
				index.files[path] = {
					...canonical,
					remoteFingerprint: verified.remoteFingerprint,
					remoteMtime: verified.remoteMtime,
				};
				metadataChanged = true;
			}
		}
	}
	if (guard) {
		const current = await deps.getSyncGuardResult(
			false,
			guard.validationToken,
		);
		if (current.blockReason) {
			throw new Error(current.blockReason);
		}
		await deps.indexManager.assertCanonicalEpoch(index.epoch);
	}
	return { metadataChanged, hashVerifiedPaths };
}

/** Identify physical versions from this installation's unfinished uploads. */
export function findVerifiedUploadPredecessors(
	deps: Pick<Dependencies, "indexManager" | "settings">,
	operations: readonly SyncOperation[],
	hashVerifiedPaths: ReadonlySet<string>,
): Map<string, PendingMutation> {
	const predecessors = new Map<string, PendingMutation>();
	if (hashVerifiedPaths.size === 0) {
		return predecessors;
	}
	const index = deps.indexManager.getRemoteIndex();
	const local = deps.indexManager.getLocalIndex();
	const deviceId = deps.settings.deviceId;
	if (local.observedEpoch !== index.epoch) {
		return predecessors;
	}
	const pending = deps.indexManager.getPendingMutations();
	const bySequence = new Map(
		pending.map((mutation) => [mutation.seq, mutation]),
	);
	const applied = index.appliedMutationSeq[deviceId] ?? 0;
	for (const { path, action, remoteMeta } of operations) {
		if (action !== "conflict" || !hashVerifiedPaths.has(path)) {
			continue;
		}
		const receipt = local.files[path];
		const mutation = bySequence.get(receipt?.mutationSeq ?? 0);
		if (
			!receipt ||
			receipt.deleted ||
			receipt.lastModifiedBy !== deviceId ||
			mutation?.type !== "put" ||
			mutation.path !== path ||
			mutation.epoch !== index.epoch ||
			mutation.seq <= applied ||
			mutation.baseRevision === null ||
			mutation.baseRevision > index.revision ||
			mutation.sha256 !== receipt.sha256 ||
			receipt.sha256 !== remoteMeta?.sha256
		) {
			continue;
		}
		const canonical = index.files[path];
		if (
			canonical?.sha256 === mutation.baselineSha256 &&
			(!canonical ||
				(!canonical.deleted &&
					typeof canonical.changedRevision === "number" &&
					canonical.changedRevision <= mutation.baseRevision))
		) {
			predecessors.set(path, mutation);
		}
	}

	// A pending delete or move owns the interpretation of paths it touches.
	if (predecessors.size > 0) {
		const ancestry = new PathAncestryIndex(predecessors.keys());
		for (const mutation of pending) {
			if (
				mutation.type === "delete-file" ||
				(mutation.type === "move" && mutation.resourceKind === "file")
			) {
				predecessors.delete(mutation.path);
				if (mutation.targetPath) {
					predecessors.delete(mutation.targetPath);
				}
			} else if (
				mutation.type === "delete-folder" ||
				mutation.type === "move"
			) {
				for (const affected of [mutation.path, mutation.targetPath]) {
					if (affected) {
						for (const path of ancestry.get(
							affected.replace(/\/+$/, ""),
						) ?? []) {
							predecessors.delete(path);
						}
					}
				}
			}
		}
	}
	return predecessors;
}

/** Persist a local baseline for every path whose two live copies were confirmed equal and canonicalize an untracked physical match. */
export function recordConfirmedBaselines(
	deps: Dependencies,
	localFiles: Map<string, FileMetadata>,
	remoteFiles: Map<string, FileMetadata>,
	operations: SyncOperation[],
): boolean {
	const operatedPaths = new Set(
		operations.map((operation) => operation.path),
	);
	const remoteIndex = deps.indexManager.getRemoteIndex();
	let canonicalChanged = false;
	let pending: PendingPutLookup | undefined;

	for (const [path, localMeta] of localFiles) {
		if (operatedPaths.has(path)) {
			continue;
		}
		const remoteMeta = remoteFiles.get(path);
		if (!remoteMeta) {
			continue;
		}
		const canonical = remoteIndex.files[path];
		const previousBaseline = deps.indexManager.getLocalIndex().files[path];
		const baseline = createConfirmedBaseline(
			localMeta,
			remoteMeta,
			canonical,
		);
		deps.indexManager.updateLocalFile(path, baseline);
		if (
			!canonical ||
			canonical.deleted ||
			canonical.sha256 !== baseline.sha256
		) {
			pending ??= new PendingPutLookup(
				deps.indexManager.getPendingMutations(),
			);
			const existing = pending.get(path, baseline.sha256);
			const mutation =
				existing ??
				deps.indexManager.enqueueMutation("put", path, {
					sha256: baseline.sha256,
					baselineSha256: previousBaseline?.sha256,
					baseRevision: remoteIndex.revision,
				});
			pending.add(mutation);
			const causalBaseline = {
				...baseline,
				lastModifiedBy: deps.settings.deviceId,
				mutationSeq: mutation.seq,
				baseRevision: mutation.baseRevision ?? 0,
			};
			deps.indexManager.updateLocalFile(path, causalBaseline);
			deps.indexManager.updateRemoteFile(path, causalBaseline);
			canonicalChanged = true;
		}
	}
	return canonicalChanged;
}

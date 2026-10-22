import type { FileMetadata, SyncOperation } from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { joinPath } from "../../utils/path-utils";
import { getPhysicalResourceFingerprint } from "../../utils/resource-fingerprint";
import type { SyncGuardResult } from "../contracts";
import * as fileOperations from "../files/operations";
import {
	PendingPutLookup,
	createConfirmedBaseline,
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
): Promise<boolean> {
	let changed = false;
	const index = deps.indexManager.getRemoteIndex();
	let guard: SyncGuardResult | undefined;
	for (const [path, local] of localFiles) {
		const remote = remoteFiles.get(path);
		const canonical = index.files[path];
		if (
			!remote ||
			canonical?.deleted ||
			(local.sha256 === remote.sha256 &&
				canonical?.sha256 === local.sha256 &&
				canonical.remoteFingerprint === remote.remoteFingerprint &&
				canonical.remoteMtime === remote.remoteMtime)
		) {
			continue;
		}
		if (
			canonical &&
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
		if (!snapshot) {
			throw new Error(
				"Remote content cannot be verified for reconciliation",
			);
		}
		const sha256 = await computeSha256(snapshot.content);
		await fileOperations.assertDownloadLocalUnchanged(
			deps.fileOperations,
			path,
			local.sha256,
		);
		remoteFiles.set(path, {
			...remote,
			sha256,
			remoteFingerprint:
				getPhysicalResourceFingerprint(snapshot.resource) ?? undefined,
			remoteMtime: new Date(snapshot.resource.modified).getTime(),
		});
		if (canonical && canonical.sha256 === sha256) {
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
				changed = true;
			}
		}
	}
	if (!guard) {
		return changed;
	}
	const current = await deps.getSyncGuardResult(false, guard.validationToken);
	if (current.blockReason) {
		throw new Error(current.blockReason);
	}
	await deps.indexManager.assertCanonicalEpoch(index.epoch);
	return changed;
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

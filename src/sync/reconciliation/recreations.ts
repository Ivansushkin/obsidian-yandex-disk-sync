import type {
	FileMetadata,
	PendingMutation,
	SyncOperation,
	SyncResult,
} from "../../types";
import type { SyncRunOptions } from "../contracts";
import type { Dependencies } from "../workflows/full";
import { computeSha256 } from "../../utils/hash-utils";
import { joinPath } from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	isHashStableContentFingerprint,
	matchesStableContentFingerprint,
	matchesListedFile,
} from "../../utils/resource-fingerprint";
import { sameIndexValue } from "../canonical/transaction-rules";
import { RemoteIndexConcurrentModificationError } from "../canonical/errors";
import * as fileOperations from "../files/operations";
import * as reconcileConflictSettlement from "./conflict-settlement";
import * as syncReconciliation from "./commits";
import * as reconcileAcceptedUploads from "./accepted-uploads";

export interface ReplayedExactDeletion {
	published: FileMetadata;
	seq: number;
	baseRevision: number | null;
	baselineSha256?: string;
	uploadedPredecessor?: string;
	deletions: Set<number>;
	lastDeletion: number;
}

export interface FullRecreation extends ReplayedExactDeletion {
	operation: SyncOperation;
	put: PendingMutation;
	foreign: boolean;
	copyPath?: string;
	verifiedPhysical?: { fingerprint: string; sha256: string };
}

/** Capture published state and original delete baselines before replay can change either. */
export function collectReplayedDeletions(
	deps: Dependencies,
): Map<string, ReplayedExactDeletion> {
	const localStateBeforeAdoption = deps.indexManager.getLocalIndex();
	const replayedExactDeletions = new Map<string, ReplayedExactDeletion>();
	const canonical = deps.indexManager.getRemoteIndex();
	const applied = canonical.appliedMutationSeq[deps.settings.deviceId] ?? 0;
	const pending = deps.indexManager.getPendingMutations();
	const bySeq = new Map(pending.map((mutation) => [mutation.seq, mutation]));
	const nextByPath = new Map<string, PendingMutation>();
	const successors = new Map<number, PendingMutation>();
	for (const mutation of [...pending].reverse()) {
		if (mutation.type !== "noop") {
			const next = nextByPath.get(mutation.path);
			if (next) {
				successors.set(mutation.seq, next);
			}
			nextByPath.set(mutation.path, mutation);
		}
	}
	for (const mutation of pending) {
		const file = canonical.files[mutation.path];
		if (
			mutation.type === "delete-file" &&
			mutation.epoch === canonical.epoch &&
			mutation.seq > applied &&
			file &&
			!file.deleted
		) {
			const previous = replayedExactDeletions.get(mutation.path);
			if (previous) {
				if (
					previous.baseRevision === mutation.baseRevision &&
					previous.baselineSha256 &&
					previous.baselineSha256 === mutation.baselineSha256 &&
					successors.get(previous.lastDeletion)?.seq === mutation.seq
				) {
					previous.deletions.add(mutation.seq);
					previous.lastDeletion = mutation.seq;
				}
				continue;
			}
			const local =
				deps.indexManager.getLocalIndex().files[mutation.path];
			const receipt = bySeq.get(local?.mutationSeq ?? 0);
			const confirmedLocal =
				local &&
				local.changedRevision !== undefined &&
				mutation.baseRevision !== null &&
				local.changedRevision <= mutation.baseRevision &&
				localStateBeforeAdoption.observedEpoch === canonical.epoch &&
				(!local.deleted ||
					(local.lastModifiedBy === deps.settings.deviceId &&
						local.mutationSeq === mutation.seq &&
						!local.deletedByFolder) ||
					(local.changedRevision === file.changedRevision &&
						local.sha256 === file.sha256));
			const nextPut = successors.get(mutation.seq);
			const putBaseline =
				nextPut?.type === "put" &&
				nextPut.epoch === mutation.epoch &&
				nextPut.baseRevision === mutation.baseRevision
					? nextPut.baselineSha256
					: undefined;
			replayedExactDeletions.set(mutation.path, {
				published: { ...file },
				seq: mutation.seq,
				deletions: new Set([mutation.seq]),
				lastDeletion: mutation.seq,
				baseRevision: mutation.baseRevision,
				baselineSha256:
					mutation.baselineSha256 ??
					putBaseline ??
					(confirmedLocal ? local.sha256 : undefined),
				uploadedPredecessor:
					receipt?.type === "put" &&
					!local?.deleted &&
					local?.lastModifiedBy === deps.settings.deviceId &&
					receipt.path === mutation.path &&
					receipt.epoch === mutation.epoch &&
					receipt.seq > mutation.seq &&
					receipt.sha256 === local.sha256
						? receipt.sha256
						: undefined,
			});
		}
	}
	return replayedExactDeletions;
}

/** Pair each selected recreation with its original FIFO and the still published predecessor. */
export function planFullRecreations(
	deps: Dependencies,
	uploads: SyncOperation[],
	fullUploadMutations: PendingMutation[],
	replayedExactDeletions: ReadonlyMap<string, ReplayedExactDeletion>,
): Map<string, FullRecreation> {
	const canonical = deps.indexManager.getRemoteIndex();
	const expectedEpoch = canonical.epoch;
	const putByPath = new Map(
		fullUploadMutations.map((mutation) => [mutation.path, mutation]),
	);
	const recreations = new Map<string, FullRecreation>();
	for (const operation of uploads) {
		const { path } = operation;
		const predecessor = replayedExactDeletions.get(path);
		const tombstone = canonical.files[path];
		const put = putByPath.get(path);
		if (
			!predecessor ||
			!tombstone?.deleted ||
			tombstone.deletedByFolder ||
			tombstone.lastModifiedBy !== deps.settings.deviceId ||
			tombstone.mutationSeq !== predecessor.seq
		) {
			continue;
		}
		if (
			!put ||
			put.seq <= predecessor.lastDeletion ||
			put.epoch !== expectedEpoch
		) {
			throw new Error("Recreation has no later put in this epoch");
		}
		const published = predecessor.published;
		const foreign =
			published.sha256 !== put.sha256 &&
			published.sha256 !== predecessor.baselineSha256;
		recreations.set(path, { ...predecessor, operation, put, foreign });
	}
	return recreations;
}

/** Keep a foreign winner at its published path and prepare its deterministic conflict copy. */
export async function prepareRecreationVersions(
	deps: Dependencies,
	recreations: ReadonlyMap<string, FullRecreation>,
): Promise<void> {
	const canonical = deps.indexManager.getRemoteIndex();
	for (const [path, plan] of recreations) {
		const { operation, put, published } = plan;
		if (plan.foreign) {
			const winner =
				await reconcileConflictSettlement.readVerifiedRemoteVersion(
					deps.syncReconciliation,
					path,
					{
						remoteMeta: operation.remoteMeta,
						expectedDownloadSha256: published.sha256,
					},
				);
			plan.verifiedPhysical = {
				fingerprint: winner.snapshot.fingerprint,
				sha256: winner.sha256,
			};
			const bytes = await deps.fileOperations.vaultAdapter.readFile(path);
			if ((await computeSha256(bytes)) !== put.sha256) {
				throw new Error("Recreated local file changed after selection");
			}
			plan.copyPath =
				await reconcileConflictSettlement.preserveLocalConflictCopy(
					deps.syncReconciliation,
					path,
					bytes,
				);
			await reconcileConflictSettlement.uploadCausalConflictCopy(
				deps.syncReconciliation,
				plan.copyPath,
				bytes,
			);
			canonical.files[path] = { ...published };
		} else {
			const physical = await deps.yandexClient.downloadStableLogicalFile(
				joinPath(deps.settings.remotePath, path),
			);
			if (physical) {
				plan.verifiedPhysical = {
					fingerprint: physical.fingerprint,
					sha256: await computeSha256(physical.content),
				};
			}
			deps.indexManager.updateRemoteFile(path, {
				...operation.localMeta!,
				baseRevision: put.baseRevision ?? undefined,
				lastModifiedBy: deps.settings.deviceId,
				mutationSeq: put.seq,
			});
		}
	}
}

/** Arbitrate the selected original under its canonical transaction and then apply verified winners. */
export async function commitRecreatedFiles(
	deps: Dependencies,
	recreations: ReadonlyMap<string, FullRecreation>,
	uploads: SyncOperation[],
	result: SyncResult,
	options: SyncRunOptions | undefined,
	expectedEpoch: string,
	validationToken?: string,
): Promise<boolean> {
	const proof = await syncReconciliation.saveRemoteIndexOrAbort(
		deps.syncReconciliation,
		result,
		true,
		async (latest, assertOwnership) => {
			for (const [path, plan] of recreations) {
				if (
					latest.epoch !== expectedEpoch ||
					latest.maintenance ||
					!sameIndexValue(latest.files[path], plan.published) ||
					(plan.copyPath &&
						latest.files[plan.copyPath] &&
						(latest.files[plan.copyPath]?.deleted ||
							latest.files[plan.copyPath]?.sha256 !==
								plan.put.sha256))
				) {
					throw new RemoteIndexConcurrentModificationError(
						"Canonical changed before committing full recreation",
					);
				}
			}
			const assertActive = async () => {
				deps.canonicalReadSession?.assertCurrent();
				const guard = await deps.getSyncGuardResult(
					options?.skipEncryptionGuard,
					validationToken,
					options?.validateThroughExternalEncryptionBlock,
				);
				if (guard.blockReason) {
					throw new Error(guard.blockReason);
				}
				await assertOwnership();
				deps.canonicalReadSession?.assertCurrent();
			};
			for (const plan of recreations.values()) {
				await applyLockedRecreation(deps, plan, assertActive);
			}
		},
	);
	if (!proof) {
		return false;
	}
	for (const [path, plan] of recreations) {
		if (plan.copyPath) {
			await reconcileConflictSettlement.assertRetainedConflictCopy(
				deps.syncReconciliation,
				plan.copyPath,
				plan.put.sha256!,
				expectedEpoch,
			);
			const selection = {
				remoteMeta: plan.operation.remoteMeta,
				expectedDownloadSha256: plan.published.sha256,
			};
			const winner =
				await reconcileConflictSettlement.readVerifiedRemoteVersion(
					deps.syncReconciliation,
					path,
					selection,
				);
			if (
				winner.canonical.epoch !== expectedEpoch ||
				!sameIndexValue(winner.canonical.files[path], plan.published)
			) {
				throw new RemoteIndexConcurrentModificationError(
					"Published recreation winner changed after copy verification",
				);
			}
			await fileOperations.applyDownloadedContent(
				deps.fileOperations,
				path,
				winner.snapshot.content,
				{
					expectedSha256: plan.published.sha256,
					remoteFingerprint: getPhysicalResourceFingerprint(
						winner.snapshot.resource,
					),
					serverMtime: Date.parse(winner.snapshot.resource.modified),
				},
				plan.put.sha256,
			);
			result.conflicts++;
		} else {
			result.uploaded++;
		}
	}
	await reconcileAcceptedUploads.repairMissingAcceptedUploads(
		deps.syncReconciliation,
		uploads
			.filter(({ path }) => !recreations.get(path)?.foreign)
			.map(({ path }) => path),
		proof,
		validationToken,
	);
	return true;
}

/** Apply only the physical version chosen against the owned ordinary canonical lock. */
async function applyLockedRecreation(
	deps: Dependencies,
	plan: FullRecreation,
	assertActive: () => Promise<void>,
): Promise<void> {
	const { path, remoteMeta } = plan.operation;
	const remotePath = joinPath(deps.settings.remotePath, path);
	const read = () => deps.yandexClient.downloadStableLogicalFile(remotePath);
	await assertActive();
	let resource = await deps.yandexClient.getLogicalResource(remotePath);
	const prepared = plan.verifiedPhysical;
	let physicalSha: string | null = null;
	if (resource) {
		if (
			prepared &&
			isHashStableContentFingerprint(prepared.fingerprint) &&
			matchesStableContentFingerprint(prepared.fingerprint, resource)
		) {
			physicalSha = prepared.sha256;
		} else {
			const snapshot = await read();
			resource = snapshot?.resource ?? null;
			physicalSha = snapshot && (await computeSha256(snapshot.content));
		}
	}
	if (plan.foreign) {
		if (physicalSha !== plan.published.sha256) {
			throw new RemoteIndexConcurrentModificationError(
				"Published recreation winner is not physically available",
			);
		}
		await assertActive();
		return;
	}
	const sha = plan.put.sha256!;
	if (physicalSha !== sha) {
		if (
			resource
				? !remoteMeta ||
					!matchesListedFile(remoteMeta, resource) ||
					(physicalSha !== plan.published.sha256 &&
						physicalSha !== plan.uploadedPredecessor)
				: remoteMeta
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Physical recreation predecessor changed",
			);
		}
		const bytes = await deps.fileOperations.vaultAdapter.readFile(path);
		if ((await computeSha256(bytes)) !== sha) {
			throw new Error("Recreated local file changed after selection");
		}
		await deps.yandexClient.uploadFile(
			remotePath,
			bytes,
			true,
			false,
			true,
			async () => {
				await assertActive();
				const current =
					await deps.yandexClient.getLogicalResource(remotePath);
				if (
					remoteMeta
						? !current || !matchesListedFile(remoteMeta, current)
						: current !== null
				) {
					throw new RemoteIndexConcurrentModificationError(
						"Physical recreation predecessor changed",
					);
				}
				await assertActive();
			},
			async () => {
				await assertActive();
				const snapshot = await read();
				await assertActive();
				return (
					!!snapshot &&
					(await computeSha256(snapshot.content)) === sha
				);
			},
		);
		const snapshot = await read();
		resource = snapshot?.resource ?? null;
		physicalSha = snapshot && (await computeSha256(snapshot.content));
	}
	if (!resource || physicalSha !== sha) {
		throw new RemoteIndexConcurrentModificationError(
			"Recreation upload was not verified",
		);
	}
	await assertActive();
	const metadata = {
		...deps.indexManager.getRemoteIndex().files[path]!,
		remoteFingerprint:
			getPhysicalResourceFingerprint(resource) ?? undefined,
		remoteMtime: Date.parse(resource.modified),
	};
	deps.indexManager.updateRemoteFile(path, metadata);
	deps.indexManager.updateLocalFile(path, metadata);
	await deps.indexSaveCallback?.();
	await fileOperations.assertDownloadLocalUnchanged(
		deps.fileOperations,
		path,
		sha,
	);
}

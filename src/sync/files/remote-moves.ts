import { VaultAdapter } from "../../api/vault-adapter";
import { YandexDiskClient } from "../../api/yandex-client";
import type {
	FileMetadata,
	IndexMove,
	YandexDiskSyncSettings,
	YandexResource,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
	getStableContentFingerprint,
	isHashStableContentFingerprint,
	matchesStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import { IndexManager } from "../canonical/manager";
export interface Dependencies {
	indexManager: IndexManager;
	settings: YandexDiskSyncSettings;
	yandexClient: YandexDiskClient;
	vaultAdapter: VaultAdapter;
}

/** Execute a committed move without overwriting a concurrent target and verify the final physical state before acknowledging local work. */
export async function executeGuardedRemoteMove(
	deps: Dependencies,
	fromPath: string,
	toPath: string,
	actionId?: string,
	snapshot?: { content: ArrayBuffer; sha256: string },
): Promise<void> {
	const action =
		(actionId
			? deps.indexManager
					.getPendingPhysicalActions()
					.find((candidate) => candidate.id === actionId)
			: undefined) ??
		deps.indexManager.getPendingPhysicalAction("move-remote", fromPath);
	const actionContext = {
		actionId: action?.id ?? actionId ?? null,
		actionType: "move-remote",
		origin: action?.origin ?? "move",
		epoch: shortenDiagnosticValue(action?.epoch),
		canonicalRevision: action?.canonicalRevision ?? null,
		parentMutationId: action?.parentMutationId ?? null,
		expectedFingerprint: shortenDiagnosticValue(
			action?.expectedFingerprint,
		),
		fromPath,
		toPath,
	};
	logger.info("Guarded remote move started", actionContext);
	const remoteFrom = joinPath(deps.settings.remotePath, fromPath);
	const remoteTo = joinPath(deps.settings.remotePath, toPath);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const move = Object.values(canonical.moves).find(
		(candidate) =>
			candidate.pending &&
			((candidate.fromPath === fromPath && candidate.toPath === toPath) ||
				(candidate.kind === "folder" &&
					fromPath.startsWith(
						`${candidate.fromPath.replace(/\/+$/, "")}/`,
					) &&
					toPath ===
						`${candidate.toPath.replace(/\/+$/, "")}/${fromPath.slice(candidate.fromPath.replace(/\/+$/, "").length + 1)}`)),
	);
	const canonicalSource = canonical.files[fromPath];
	const canonicalTarget = canonical.files[toPath];
	const sourceRetainsMoveIntent =
		canonicalSource?.deleted === true &&
		canonicalSource.lastModifiedBy === move?.lastModifiedBy &&
		canonicalSource.mutationSeq === move?.mutationSeq;
	const targetMoveAuthorized =
		move?.kind !== "folder" ||
		(canonicalTarget?.deleted !== true &&
			canonicalTarget?.lastModifiedBy === move.lastModifiedBy &&
			canonicalTarget?.mutationSeq === move.mutationSeq);
	if (!move || canonicalTarget?.deleted || !targetMoveAuthorized) {
		if (action) {
			deps.indexManager.completePhysicalAction(action.id);
		}
		logger.warn("Cancelled obsolete guarded remote move", {
			...actionContext,
			currentRevision: canonical.revision,
			movePending: move?.pending ?? false,
			targetDeleted: canonical.files[toPath]?.deleted ?? null,
			targetMoveAuthorized,
		});
		return;
	}

	const observations = await Promise.allSettled([
		deps.yandexClient.getLogicalResource(remoteFrom),
		deps.yandexClient.getLogicalResource(remoteTo),
	]);
	if (observations[0].status === "rejected") {
		throw observations[0].reason;
	}
	if (observations[1].status === "rejected") {
		throw observations[1].reason;
	}
	const source = observations[0].value;
	const target = observations[1].value;

	if (!sourceRetainsMoveIntent) {
		if (target) {
			if (
				!(await remoteResourceMatchesCanonical(
					deps,
					toPath,
					target,
					canonicalTarget,
				))
			) {
				throw new Error(
					`Move target does not match canonical: ${toPath}`,
				);
			}
			completeMovedTarget(deps, toPath, target, snapshot, action?.id);
			return;
		}
		const repairSnapshot =
			(snapshot?.sha256 === canonicalTarget?.sha256
				? snapshot
				: undefined) ??
			(await readMatchingLocalSnapshot(
				deps,
				toPath,
				canonicalTarget?.sha256,
			));
		if (!repairSnapshot || !canonicalTarget || canonicalTarget.deleted) {
			throw new Error(
				`Restored move source requires a target snapshot: ${toPath}`,
			);
		}
		const { resource: writtenTarget } = await materializeMoveTarget(
			deps,
			toPath,
			repairSnapshot,
			canonicalTarget,
		);
		completeMovedTarget(
			deps,
			toPath,
			writtenTarget,
			repairSnapshot,
			action?.id,
		);
		return;
	}
	if (!source && target) {
		if (
			!(await remoteResourceMatchesCanonical(
				deps,
				toPath,
				target,
				canonicalTarget,
			))
		) {
			throw new Error(`Move target does not match canonical: ${toPath}`);
		}
		const targetSnapshot =
			(snapshot?.sha256 === canonical.files[toPath]?.sha256
				? snapshot
				: undefined) ??
			(await readMatchingLocalSnapshot(
				deps,
				toPath,
				canonical.files[toPath]?.sha256,
			));
		completeMovedTarget(deps, toPath, target, targetSnapshot, action?.id);
		logger.info("Guarded remote move already complete", actionContext);
		return;
	}
	if (!source) {
		const targetMetadata = canonicalTarget;
		const repairSnapshot =
			(snapshot?.sha256 === targetMetadata?.sha256
				? snapshot
				: undefined) ??
			(await readMatchingLocalSnapshot(
				deps,
				toPath,
				targetMetadata?.sha256,
			));
		if (!repairSnapshot || !targetMetadata || targetMetadata.deleted) {
			throw new Error(`Move source is missing: ${fromPath}`);
		}
		const { resource: repairedTarget } = await materializeMoveTarget(
			deps,
			toPath,
			repairSnapshot,
			targetMetadata,
		);
		completeMovedTarget(
			deps,
			toPath,
			repairedTarget,
			repairSnapshot,
			action?.id,
		);
		logger.info("Missing move source repaired from local target", {
			...actionContext,
			plan: "materialize-target",
		});
		return;
	}
	if (target) {
		if (
			!(await remoteResourceMatchesCanonical(
				deps,
				toPath,
				target,
				canonical.files[toPath],
			))
		) {
			throw new Error(`Move target already exists: ${toPath}`);
		}
		await deleteMoveSourceIfUnchanged(
			deps,
			fromPath,
			source,
			action,
			canonical.files[fromPath],
			toPath,
			move,
			canonical.epoch,
		);
		completeMovedTarget(deps, toPath, target, snapshot, action?.id);
		logger.info(
			"Materialized move source cleanup confirmed",
			actionContext,
		);
		return;
	}
	const sourceFingerprint = getPhysicalResourceFingerprint(source);
	if (
		action?.expectedFingerprint &&
		!matchesPhysicalResourceFingerprint(action.expectedFingerprint, source)
	) {
		logger.warn("Guarded remote move source fingerprint changed", {
			...actionContext,
			currentFingerprint: shortenDiagnosticValue(sourceFingerprint),
		});
		throw new Error(`Move source changed after commit: ${fromPath}`);
	}

	const targetMetadata = canonicalTarget;
	const sourceMetadata = canonicalSource;
	const requiresMaterialization =
		targetMetadata &&
		sourceMetadata &&
		targetMetadata.sha256 !== sourceMetadata.sha256;
	if (requiresMaterialization) {
		const repairSnapshot =
			(snapshot?.sha256 === targetMetadata.sha256
				? snapshot
				: undefined) ??
			(await readMatchingLocalSnapshot(
				deps,
				toPath,
				targetMetadata.sha256,
			));
		if (!repairSnapshot) {
			throw new Error(
				`Changed move target cannot be materialized: ${toPath}`,
			);
		}
		const { resource: writtenTarget, verifiedRawSha256 } =
			await materializeMoveTarget(
				deps,
				toPath,
				repairSnapshot,
				targetMetadata,
			);
		await deleteMoveSourceIfUnchanged(
			deps,
			fromPath,
			source,
			action,
			sourceMetadata,
			toPath,
			move,
			canonical.epoch,
			{
				resource: writtenTarget,
				metadata: targetMetadata,
				configurationVersion:
					deps.yandexClient.getReadConfigurationVersion(),
				rawSha256: verifiedRawSha256,
			},
		);
		completeMovedTarget(
			deps,
			toPath,
			writtenTarget,
			repairSnapshot,
			action?.id,
		);
		logger.info("Changed move target materialized", {
			...actionContext,
			plan: "materialize-target",
		});
		return;
	}

	if (
		!action?.expectedFingerprint &&
		!(await remoteMoveSourceMatchesCanonical(
			deps,
			fromPath,
			source,
			sourceMetadata,
		))
	) {
		throw new Error(`Move source cannot be verified: ${fromPath}`);
	}
	try {
		await deps.yandexClient.moveResource(remoteFrom, remoteTo, false);
	} catch (error) {
		const [remainingSource, ambiguousTarget] = await Promise.all([
			deps.yandexClient.getLogicalResource(remoteFrom),
			deps.yandexClient.getLogicalResource(remoteTo),
		]);
		if (
			remainingSource ||
			!ambiguousTarget ||
			!(await remoteResourceMatchesCanonical(
				deps,
				toPath,
				ambiguousTarget,
				targetMetadata,
			))
		) {
			throw error;
		}
		completeMovedTarget(
			deps,
			toPath,
			ambiguousTarget,
			snapshot,
			action?.id,
		);
		logger.info("Ambiguous remote move confirmed by final state", {
			...actionContext,
			targetFingerprint: shortenDiagnosticValue(
				getPhysicalResourceFingerprint(ambiguousTarget),
			),
		});
		return;
	}
	const [remainingSource, writtenTarget] = await Promise.all([
		deps.yandexClient.getLogicalResource(remoteFrom),
		deps.yandexClient.getLogicalResource(remoteTo),
	]);
	if (remainingSource || !writtenTarget) {
		throw new Error(
			`Move result could not be confirmed: ${fromPath} -> ${toPath}`,
		);
	}
	if (
		!(await remoteResourceMatchesCanonical(
			deps,
			toPath,
			writtenTarget,
			targetMetadata,
		))
	) {
		throw new Error(`Moved target does not match canonical: ${toPath}`);
	}
	completeMovedTarget(deps, toPath, writtenTarget, snapshot, action?.id);
	if (actionId && action?.id !== actionId) {
		deps.indexManager.completePhysicalAction(actionId);
	}
	logger.info("Guarded remote move confirmed", {
		...actionContext,
		targetFingerprint: shortenDiagnosticValue(
			getPhysicalResourceFingerprint(writtenTarget),
		),
	});
}

/** Read a local snapshot only when it still matches the canonical move hash. */
export async function readMatchingLocalSnapshot(
	deps: Pick<Dependencies, "vaultAdapter">,
	path: string,
	expectedSha256: string | undefined,
): Promise<{ content: ArrayBuffer; sha256: string } | undefined> {
	if (!expectedSha256 || !deps.vaultAdapter.fileExists(path)) {
		return undefined;
	}
	const content = await deps.vaultAdapter.readFile(path);
	const sha256 = await computeSha256(content);
	return sha256 === expectedSha256 ? { content, sha256 } : undefined;
}

/** Upload a missing move target exclusively and verify its logical content. */
export async function materializeMoveTarget(
	deps: Pick<Dependencies, "yandexClient" | "settings">,
	path: string,
	snapshot: { content: ArrayBuffer; sha256: string },
	metadata: FileMetadata,
): Promise<{ resource: YandexResource; verifiedRawSha256?: string }> {
	const remotePath = joinPath(deps.settings.remotePath, path);
	let uploadFailure: unknown;
	try {
		await deps.yandexClient.uploadFileExclusive(
			remotePath,
			snapshot.content,
		);
	} catch (error) {
		uploadFailure = error;
	}
	const written =
		await deps.yandexClient.downloadStableLogicalFile(remotePath);
	if (
		!written ||
		(await computeSha256(written.content)) !== metadata.sha256
	) {
		if (uploadFailure instanceof Error) {
			throw uploadFailure;
		}
		throw new Error(`Move target upload could not be verified: ${path}`);
	}
	return {
		resource: written.resource,
		verifiedRawSha256: written.verifiedRawSha256,
	};
}

/** Compare a physical remote object with canonical metadata without trusting client clocks. */
export async function remoteResourceMatchesCanonical(
	deps: Pick<Dependencies, "yandexClient" | "settings">,
	path: string,
	resource: YandexResource,
	metadata: FileMetadata | undefined,
): Promise<boolean> {
	if (!metadata || metadata.deleted) {
		return false;
	}
	return remoteContentMatchesCanonical(deps, path, resource, metadata);
}

/** Verify a move source against retained logical content, including tombstones. */
export async function remoteMoveSourceMatchesCanonical(
	deps: Pick<Dependencies, "yandexClient" | "settings">,
	path: string,
	resource: YandexResource,
	metadata: FileMetadata | undefined,
): Promise<boolean> {
	if (!metadata) {
		return false;
	}
	return remoteContentMatchesCanonical(deps, path, resource, metadata);
}

/** Compare retained content after the caller has admitted its live or tombstoned metadata. */
async function remoteContentMatchesCanonical(
	deps: Pick<Dependencies, "yandexClient" | "settings">,
	path: string,
	resource: YandexResource,
	metadata: FileMetadata,
): Promise<boolean> {
	if (
		metadata.remoteFingerprint &&
		matchesPhysicalResourceFingerprint(metadata.remoteFingerprint, resource)
	) {
		return true;
	}
	try {
		const content = await deps.yandexClient.downloadFile(
			joinPath(deps.settings.remotePath, path),
		);
		return (await computeSha256(content)) === metadata.sha256;
	} catch {
		return false;
	}
}

class MoveCleanupAuthorityError extends Error {
	constructor() {
		super("Move cleanup authority or physical snapshot changed");
	}
}

/** Delete a move source only while its staged identity remains unchanged. */
export async function deleteMoveSourceIfUnchanged(
	deps: Pick<Dependencies, "indexManager" | "yandexClient" | "settings">,
	path: string,
	resource: YandexResource,
	action: ReturnType<IndexManager["getPendingPhysicalAction"]>,
	metadata: FileMetadata | undefined,
	toPath: string,
	move: IndexMove,
	epoch: string,
	verifiedTarget?: {
		resource: YandexResource;
		metadata: FileMetadata;
		configurationVersion: number;
		rawSha256?: string;
	},
): Promise<void> {
	const matchesExpected =
		action?.expectedFingerprint !== undefined &&
		matchesPhysicalResourceFingerprint(
			action.expectedFingerprint,
			resource,
		);
	if (
		!matchesExpected &&
		!(await remoteMoveSourceMatchesCanonical(
			deps,
			path,
			resource,
			metadata,
		))
	) {
		throw new Error(`Move source changed before cleanup: ${path}`);
	}
	const remotePath = joinPath(deps.settings.remotePath, path);
	const expectedFingerprint =
		action?.expectedFingerprint ?? getPhysicalResourceFingerprint(resource);
	const revalidate = async (): Promise<void> => {
		const canonical = await deps.indexManager.readCanonicalIndex();
		const current = canonical.moves[move.id];
		const source = canonical.files[path];
		const target = canonical.files[toPath];
		if (
			canonical.epoch !== epoch ||
			canonical.maintenance ||
			!current?.pending ||
			current.fromPath !== move.fromPath ||
			current.toPath !== move.toPath ||
			current.mutationSeq !== move.mutationSeq ||
			current.lastModifiedBy !== move.lastModifiedBy ||
			!source?.deleted ||
			source.changedRevision !== metadata?.changedRevision ||
			!target ||
			target.deleted
		) {
			throw new MoveCleanupAuthorityError();
		}
		const physicalTarget = await deps.yandexClient.getLogicalResource(
			joinPath(deps.settings.remotePath, toPath),
		);
		const proofFingerprint = verifiedTarget
			? getStableContentFingerprint(verifiedTarget.resource)
			: null;
		const proofMatches =
			verifiedTarget &&
			verifiedTarget.rawSha256 !== undefined &&
			proofFingerprint === `sha256:${verifiedTarget.rawSha256}` &&
			verifiedTarget.configurationVersion ===
				deps.yandexClient.getReadConfigurationVersion() &&
			isHashStableContentFingerprint(proofFingerprint) &&
			matchesStableContentFingerprint(proofFingerprint, physicalTarget) &&
			verifiedTarget.metadata.sha256 === target.sha256 &&
			verifiedTarget.metadata.changedRevision ===
				target.changedRevision &&
			verifiedTarget.metadata.lastModifiedBy === target.lastModifiedBy &&
			verifiedTarget.metadata.mutationSeq === target.mutationSeq;
		if (
			!physicalTarget ||
			(!proofMatches &&
				!(await remoteResourceMatchesCanonical(
					deps,
					toPath,
					physicalTarget,
					target,
				)))
		) {
			throw new MoveCleanupAuthorityError();
		}
		const physicalSource =
			await deps.yandexClient.getLogicalResource(remotePath);
		if (
			physicalSource &&
			(!expectedFingerprint ||
				!matchesPhysicalResourceFingerprint(
					expectedFingerprint,
					physicalSource,
				))
		) {
			throw new MoveCleanupAuthorityError();
		}
	};
	try {
		await deps.yandexClient.deleteResource(
			remotePath,
			false,
			false,
			revalidate,
		);
	} catch (error) {
		if (
			error instanceof MoveCleanupAuthorityError ||
			(await deps.yandexClient.getLogicalResource(remotePath))
		) {
			throw error;
		}
	}
	if (await deps.yandexClient.getLogicalResource(remotePath)) {
		throw new Error(`Move source cleanup could not be confirmed: ${path}`);
	}
}

/** Persist verified target identity into canonical and local baselines. */
export function stampMovedTarget(
	deps: Pick<Dependencies, "indexManager" | "vaultAdapter">,
	path: string,
	resource: YandexResource,
	localSnapshot?: { content: ArrayBuffer; sha256: string },
): void {
	const current = deps.indexManager.getRemoteIndex().files[path];
	if (!current || current.deleted) {
		return;
	}
	const remoteMtime = new Date(resource.modified).getTime();
	const stamped: FileMetadata = {
		...current,
		remoteFingerprint:
			getPhysicalResourceFingerprint(resource) ?? undefined,
		remoteMtime: Number.isFinite(remoteMtime)
			? remoteMtime
			: current.remoteMtime,
	};
	deps.indexManager.updateRemoteFile(path, stamped);
	const local = deps.indexManager.getLocalIndex().files[path];
	if (local && !local.deleted && local.sha256 === stamped.sha256) {
		deps.indexManager.updateLocalFile(path, {
			...local,
			remoteFingerprint: stamped.remoteFingerprint,
			remoteMtime: stamped.remoteMtime,
		});
	} else if (localSnapshot?.sha256 === stamped.sha256) {
		deps.indexManager.updateLocalFile(path, {
			...stamped,
			mtime: deps.vaultAdapter.getFileMtime(path) || stamped.mtime,
			syncedAt: Date.now(),
		});
	}
}

/** Stamp a verified target before retiring its durable physical action. */
function completeMovedTarget(
	deps: Pick<Dependencies, "indexManager" | "vaultAdapter">,
	path: string,
	resource: YandexResource,
	snapshot: { content: ArrayBuffer; sha256: string } | undefined,
	actionId: string | undefined,
): void {
	stampMovedTarget(deps, path, resource, snapshot);
	if (actionId) {
		deps.indexManager.completePhysicalAction(actionId);
	}
}

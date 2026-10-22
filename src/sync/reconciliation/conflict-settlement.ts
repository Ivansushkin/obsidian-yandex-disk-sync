import { LocalFileChangedError } from "../../api/vault-adapter";
import { type StableLogicalFileSnapshot } from "../../api/yandex-client";
import type {
	FileMetadata,
	PendingMutation,
	SyncIndex,
	SyncOperation,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger } from "../../utils/logger";
import { getExtension, joinPath } from "../../utils/path-utils";
import { getPhysicalResourceFingerprint } from "../../utils/resource-fingerprint";
import * as fileOperations from "../files/operations";
import { saveRemoteIndexBestEffort } from "./commits";
import type { Dependencies as ReconciliationDependencies } from "./context";
export type Dependencies = Pick<
	ReconciliationDependencies,
	| "conflictResolver"
	| "epochReplacementPending"
	| "expectWatcherEvent"
	| "fileOperations"
	| "getSyncGuardResult"
	| "indexManager"
	| "indexSaveCallback"
	| "realtimeGuardValidationToken"
	| "setBlockedState"
	| "settings"
	| "vaultAdapter"
	| "yandexClient"
>;

/** Verify one plaintext version while canonical authority and codec remain stable. */
export async function readVerifiedRemoteVersion(
	deps: Dependencies,
	path: string,
): Promise<{
	canonical: SyncIndex;
	snapshot: StableLogicalFileSnapshot;
	sha256: string;
}> {
	const guard = await deps.getSyncGuardResult(false);
	if (guard.blockReason) {
		throw new Error(guard.blockReason);
	}
	const before = await deps.indexManager.readCanonicalIndex();
	const snapshot = await deps.yandexClient.downloadStableLogicalFile(
		joinPath(deps.settings.remotePath, path),
	);
	if (!snapshot) {
		throw new Error("Remote conflict version is not physically available");
	}
	const canonical = await deps.indexManager.readCanonicalIndex();
	const expected = before.files[path];
	const current = canonical.files[path];
	if (
		before.epoch !== canonical.epoch ||
		expected?.sha256 !== current?.sha256 ||
		expected?.changedRevision !== current?.changedRevision ||
		expected?.deleted !== current?.deleted
	) {
		throw new Error("Canonical changed during content verification");
	}
	const unchanged = await deps.getSyncGuardResult(
		false,
		guard.validationToken,
	);
	if (unchanged.blockReason) {
		throw new Error(unchanged.blockReason);
	}
	return {
		canonical,
		snapshot,
		sha256: await computeSha256(snapshot.content),
	};
}

/** Require accepted logical and physical copy bytes before replacing another version. */
export async function assertRetainedConflictCopy(
	deps: Dependencies,
	path: string,
	sha256: string,
	epoch: string,
): Promise<void> {
	const retained = await readVerifiedRemoteVersion(deps, path);
	const canonical = retained.canonical.files[path];
	if (
		retained.canonical.epoch !== epoch ||
		!canonical ||
		canonical.deleted ||
		canonical.sha256 !== sha256 ||
		retained.sha256 !== sha256
	) {
		throw new Error(
			"Conflict copy was not retained by canonical and physical storage",
		);
	}
}

/** Handle conflict */
export async function handleConflict(
	deps: Dependencies,
	op: SyncOperation,
): Promise<void> {
	logger.warn(`Handling conflict: ${op.path}`);

	if (!op.localMeta || !op.remoteMeta) {
		return;
	}
	const localContent = await deps.vaultAdapter.readFile(op.path);
	const localSha256 = await computeSha256(localContent);
	if (localSha256 !== op.localMeta.sha256) {
		throw new Error("Local file changed after conflict classification");
	}
	logger.debug("Conflict stage", { stage: "read-remote-version" });
	const remote = await readVerifiedRemoteVersion(deps, op.path);
	if (remote.canonical.files[op.path]?.deleted) {
		throw new Error("Canonical deletion superseded the conflict");
	}
	if (remote.sha256 === localSha256) {
		logger.debug("Conflict stage", { stage: "apply-winner" });
		await fileOperations.applyDownloadedContent(
			deps.fileOperations,
			op.path,
			remote.snapshot.content,
			{
				remoteFingerprint:
					getPhysicalResourceFingerprint(remote.snapshot.resource) ??
					undefined,
				serverMtime: new Date(
					remote.snapshot.resource.modified,
				).getTime(),
			},
			localSha256,
		);
		return;
	}
	logger.debug("Conflict stage", { stage: "preserve-local-copy" });
	const conflictPath = await preserveLocalConflictCopy(
		deps,
		op.path,
		localContent,
	);
	logger.debug("Conflict stage", { stage: "upload-copy" });
	await uploadCausalConflictCopy(deps, conflictPath, localContent);
	logger.debug("Conflict stage", { stage: "commit-copy" });
	if (!(await saveRemoteIndexBestEffort(deps))) {
		throw new Error("Conflict copy could not be committed");
	}
	logger.debug("Conflict stage", { stage: "verify-copy" });
	await assertRetainedConflictCopy(
		deps,
		conflictPath,
		localSha256,
		remote.canonical.epoch,
	);
	logger.debug("Conflict stage", { stage: "reread-winner" });
	const winner = await readVerifiedRemoteVersion(deps, op.path);
	if (
		winner.canonical.epoch !== remote.canonical.epoch ||
		winner.canonical.files[op.path]?.deleted ||
		winner.sha256 !== remote.sha256
	) {
		throw new Error("Winner changed after preserving conflict copy");
	}
	logger.debug("Conflict stage", { stage: "apply-winner" });
	await fileOperations.applyDownloadedContent(
		deps.fileOperations,
		op.path,
		winner.snapshot.content,
		{
			remoteFingerprint:
				getPhysicalResourceFingerprint(winner.snapshot.resource) ??
				undefined,
			serverMtime: new Date(winner.snapshot.resource.modified).getTime(),
		},
		localSha256,
	);
	logger.info(`Conflict resolved, copy retained: ${conflictPath}`);
}

/** Preserve a local version without overwriting a conflict copy edited since its canonical commit. */
export async function preserveLocalConflictCopy(
	deps: Dependencies,
	path: string,
	content: ArrayBuffer,
): Promise<string> {
	const sha256 = await computeSha256(content);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const key = await computeSha256(
		new TextEncoder().encode(`${path}\0${sha256}`).buffer,
	);
	const base = deps.conflictResolver.generateConflictName(path, key);
	const extension = getExtension(base);
	const suffix = extension ? base.slice(-(extension.length + 1)) : "";
	const stem = suffix ? base.slice(0, -suffix.length) : base;
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = attempt === 0 ? base : `${stem}_${attempt}${suffix}`;
		if (deps.vaultAdapter.folderExists(candidate)) {
			continue;
		}
		const physical = await deps.yandexClient.getLogicalResource(
			joinPath(deps.settings.remotePath, candidate),
		);
		if (physical?.type === "dir") {
			continue;
		}
		if (physical) {
			const verified = await deps.yandexClient.downloadStableLogicalFile(
				joinPath(deps.settings.remotePath, candidate),
				physical,
			);
			if (!verified) {
				throw new Error(
					"Conflict candidate changed while being reserved",
				);
			}
			if ((await computeSha256(verified.content)) !== sha256) {
				continue;
			}
		}
		if (deps.vaultAdapter.fileExists(candidate)) {
			if (
				(await computeSha256(
					await deps.vaultAdapter.readFile(candidate),
				)) === sha256 &&
				(!canonical.files[candidate] ||
					(!canonical.files[candidate]?.deleted &&
						canonical.files[candidate]?.sha256 === sha256))
			) {
				return candidate;
			}
			continue;
		}
		if (
			canonical.files[candidate] &&
			(canonical.files[candidate]?.deleted ||
				canonical.files[candidate]?.sha256 !== sha256)
		) {
			continue;
		}
		try {
			await deps.vaultAdapter.writeFile(candidate, content, {
				expectedSha256: null,
				validateBeforeWrite: () =>
					deps.indexManager.assertRemoteScope(),
				beforeWrite: () => deps.expectWatcherEvent(candidate, "upload"),
			});
			return candidate;
		} catch (error) {
			if (!(error instanceof LocalFileChangedError)) {
				throw error;
			}
			if (
				deps.vaultAdapter.fileExists(candidate) &&
				(await computeSha256(
					await deps.vaultAdapter.readFile(candidate),
				)) === sha256
			) {
				return candidate;
			}
		}
	}
	throw new Error("Could not reserve a free conflict path");
}

/** Confirm one retained version without replacing a competing physical copy. */
export async function uploadCausalConflictCopy(
	deps: Dependencies,
	path: string,
	content: ArrayBuffer,
): Promise<PendingMutation | null> {
	const sha256 = await computeSha256(content);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const retained = canonical.files[path];
	if (retained?.deleted || (retained && retained.sha256 !== sha256)) {
		throw new Error(
			"Conflict path is reserved by another canonical version",
		);
	}
	const remotePath = joinPath(deps.settings.remotePath, path);
	let physical =
		await deps.yandexClient.downloadStableLogicalFile(remotePath);
	if (!physical) {
		try {
			await deps.yandexClient.uploadFileExclusive(remotePath, content);
		} catch (error) {
			physical =
				await deps.yandexClient.downloadStableLogicalFile(remotePath);
			if (!physical) {
				throw error;
			}
		}
		physical ??=
			await deps.yandexClient.downloadStableLogicalFile(remotePath);
	}
	if (!physical || (await computeSha256(physical.content)) !== sha256) {
		throw new Error("Conflict copy changed before confirmation");
	}
	const existing = deps.indexManager.findPendingMatchingPut(
		path,
		sha256,
		"first",
	);
	if (retained && !existing) {
		deps.indexManager.updateLocalFile(path, retained);
		return null;
	}
	const mutation =
		existing ?? deps.indexManager.enqueueMutation("put", path, { sha256 });
	const metadata: FileMetadata = {
		path,
		sha256,
		size: content.byteLength,
		mtime: deps.vaultAdapter.getFileMtime(path) || Date.now(),
		syncedAt: Date.now(),
		remoteFingerprint:
			getPhysicalResourceFingerprint(physical.resource) ?? undefined,
		remoteMtime: new Date(physical.resource.modified).getTime(),
		mutationSeq: mutation.seq,
	};
	deps.indexManager.updateLocalFile(path, metadata);
	deps.indexManager.updateRemoteFile(path, {
		...metadata,
		baseRevision: mutation.baseRevision ?? canonical.revision,
	});
	deps.indexManager.stageMutation(mutation);
	if (deps.indexSaveCallback) {
		await deps.indexSaveCallback();
	}
	return mutation;
}

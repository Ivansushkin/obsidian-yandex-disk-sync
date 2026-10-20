import { createSyncError } from "../errors";
import { VaultAdapter } from "../../api/vault-adapter";
import { YandexApiError, YandexDiskClient } from "../../api/yandex-client";
import { t } from "../../i18n";
import type {
	FileMetadata,
	SyncPhase,
	SyncProgress,
	SyncResult,
	YandexDiskSyncSettings,
} from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { logger } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import { setRecordValue } from "../../utils/record-utils";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import * as fileOperations from "../files/operations";
import { IndexManager } from "../canonical/manager";
import type { PhysicalRewriteUploadProof, SyncRunOptions } from "../contracts";
import * as syncReconciliation from "../reconciliation/commits";
export interface Dependencies {
	yandexClient: YandexDiskClient;
	setSyncPhase: (
		phase: SyncPhase,
		currentOperation?: string,
		progress?: SyncProgress,
	) => void;
	indexManager: IndexManager;
	vaultAdapter: VaultAdapter;
	settings: YandexDiskSyncSettings;
	reportProgress: (processedOps: number, totalOps: number) => void;
	fileOperations: fileOperations.Dependencies;
	syncReconciliation: syncReconciliation.Dependencies;
}

/** Treat every upload response as untrusted until exact read-back succeeds. */
export async function uploadPhysicalRewriteTarget(
	deps: Dependencies,
	remotePath: string,
	content: ArrayBuffer,
	verify: () => Promise<PhysicalRewriteUploadProof>,
): Promise<PhysicalRewriteUploadProof> {
	try {
		await deps.yandexClient.uploadFileExclusive(remotePath, content, true);
	} catch (error) {
		logger.warn("Encryption target upload response was not conclusive", {
			status: error instanceof YandexApiError ? error.status : undefined,
			error,
		});
	}
	return await verify();
}

/** Re-encode live canonical files with exclusive uploads and exact target proofs. */
export async function rewriteRemoteFiles(
	deps: Dependencies,
	options: SyncRunOptions,
	result: SyncResult,
): Promise<void> {
	deps.setSyncPhase("scanning-local");
	const localFiles = await deps.indexManager.buildLocalIndex();
	const canonical = deps.indexManager.getRemoteIndex();
	const liveCanonical = Object.entries(canonical.files).filter(
		([, metadata]) => !metadata.deleted,
	);
	for (const [path, metadata] of liveCanonical) {
		const local = localFiles.get(path);
		if (!local || local.sha256 !== metadata.sha256) {
			throw new Error(
				`Encryption preflight baseline is incomplete for ${path}`,
			);
		}
	}

	await fileOperations.ensureFoldersExist(
		deps.fileOperations,
		liveCanonical.map(([path]) => ({
			action: "upload",
			path,
			reason: "Encryption transition",
		})),
	);

	const tasks = liveCanonical.map(([path, logicalMetadata]) => async () => {
		const content = await deps.vaultAdapter.readFile(path);
		const sha256 = await computeSha256(content);
		if (sha256 !== logicalMetadata.sha256) {
			throw new Error(
				`File changed during encryption transition: ${path}`,
			);
		}
		const stamp = await uploadPhysicalRewriteTarget(
			deps,
			joinPath(deps.settings.remotePath, path),
			content,
			async () =>
				await options.verifyPhysicalRewriteUpload!(path, sha256),
		);
		const rewritten: FileMetadata = {
			...logicalMetadata,
			size: content.byteLength,
			sha256,
			remoteMtime: stamp.remoteMtime,
			remoteFingerprint: stamp.remoteFingerprint,
		};
		setRecordValue(canonical.files, path, rewritten);
		deps.indexManager.updateLocalFile(path, {
			...rewritten,
		});
	});
	deps.setSyncPhase("applying", t("status.op.reencoding_files"));
	const settled = await runWithConcurrencySettled(
		tasks,
		Math.max(1, deps.settings.maxConcurrency || 5),
		(completed, total) => deps.reportProgress(completed, total),
	);
	for (let index = 0; index < settled.length; index++) {
		const outcome = settled[index];
		if (outcome?.status === "fulfilled") {
			result.uploaded++;
			continue;
		}
		const path = liveCanonical[index]?.[0] ?? "";
		result.errors.push(
			createSyncError(
				outcome?.reason,
				path,
				"upload",
				"encryption-rewrite",
			),
		);
	}
	if (result.errors.length > 0) {
		return;
	}
	deps.setSyncPhase("saving-index");
	await options?.beforeIndexCommit?.();
	deps.indexManager.updateSyncTime();
	deps.indexManager.beginPhysicalRewriteCommit();
	try {
		await syncReconciliation.saveRemoteIndexOrAbort(
			deps.syncReconciliation,
			result,
			false,
		);
	} finally {
		deps.indexManager.cancelPhysicalRewriteCommit();
	}
}

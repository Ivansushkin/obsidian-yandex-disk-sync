import { computeSha256 } from "../../utils/hash-utils";
import { logger } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import { matchesPhysicalResourceFingerprint } from "../../utils/resource-fingerprint";
import * as fileOperations from "../files/operations";
import { saveRemoteIndexBestEffort } from "./commits";
import {
	assertRetainedConflictCopy,
	preserveLocalConflictCopy,
	uploadCausalConflictCopy,
} from "./conflict-settlement";
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

/** Remove a put rejected by a concurrent tombstone only when the live server object is still the exact upload that lost the merge. */
export async function cleanupRejectedUploads(
	deps: Dependencies,
): Promise<void> {
	for (const rejected of deps.indexManager.consumeRejectedPuts()) {
		if (rejected.reason === "conflict") {
			await preserveRejectedConcurrentPut(deps, rejected.path);
			continue;
		}
		if (deps.vaultAdapter.fileExists(rejected.path)) {
			deps.indexManager.enqueuePhysicalAction(
				"delete-local",
				rejected.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					origin: "rejected-upload",
					baselineSha256: rejected.baselineSha256,
				},
			);
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			const outcome = await fileOperations.deleteLocalFile(
				deps.fileOperations,
				rejected.path,
			);
			if (outcome === "completed") {
				deps.indexManager.markLocalFileDeleted(rejected.path);
			}
			if (deps.indexSaveCallback) {
				await deps.indexSaveCallback();
			}
			if (outcome !== "completed") {
				continue;
			}
		}
		try {
			deps.indexManager.enqueuePhysicalAction(
				"delete-remote",
				rejected.path,
				{
					canonicalRevision:
						deps.indexManager.getRemoteIndex().revision,
					expectedFingerprint: rejected.remoteFingerprint,
					origin: "rejected-upload",
				},
			);
			await fileOperations.deleteRemoteFile(
				deps.fileOperations,
				rejected.path,
			);
		} catch (e) {
			logger.warn(
				`Could not clean up rejected upload ${rejected.path}:`,
				{ error: e },
			);
		}
	}
}

/** Preserve the losing side of a concurrent live put as a conflict copy, then restore the canonical winner at the original path. */
async function preserveRejectedConcurrentPut(
	deps: Dependencies,
	path: string,
): Promise<void> {
	if (!deps.vaultAdapter.fileExists(path)) {
		return;
	}
	const localContent = await deps.vaultAdapter.readFile(path);
	const localSha256 = await computeSha256(localContent);
	const currentCanonical = await deps.indexManager.readCanonicalIndex();
	const conflictPath = await preserveLocalConflictCopy(
		deps,
		path,
		localContent,
	);
	const retained = currentCanonical.files[conflictPath];
	if (!retained || retained.deleted || retained.sha256 !== localSha256) {
		const mutation = await uploadCausalConflictCopy(
			deps,
			conflictPath,
			localContent,
		);
		if (!(await saveRemoteIndexBestEffort(deps))) {
			throw new Error(`Could not commit conflict copy for ${path}`);
		}
		if (mutation) {
			deps.indexManager.confirmMutation(mutation.id);
		}
	}

	await assertRetainedConflictCopy(
		deps,
		conflictPath,
		localSha256,
		currentCanonical.epoch,
	);
	const canonical = await deps.indexManager.readCanonicalIndex();
	const winner = canonical.files[path];
	if (!winner || winner.deleted) {
		return;
	}
	const remotePath = joinPath(deps.settings.remotePath, path);
	const physical = await deps.yandexClient.getLogicalResource(remotePath);
	if (
		!physical ||
		(winner.remoteFingerprint &&
			!matchesPhysicalResourceFingerprint(
				winner.remoteFingerprint,
				physical,
			))
	) {
		throw new Error(
			`Canonical winner for ${path} is not physically available yet`,
		);
	}
	await fileOperations.downloadFile(
		deps.fileOperations,
		path,
		new Date(physical.modified).getTime(),
	);
}

import { computeSha256 } from "../../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { joinPath } from "../../utils/path-utils";
import { setRecordValue } from "../../utils/record-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import type { CanonicalCommitProof } from "../canonical/transaction";
import * as fileOperations from "../files/operations";
import { createConfirmedBaseline } from "../local/baseline-rules";
import {
	saveMoveCompletionBestEffort,
	saveRemoteIndexBestEffort,
} from "./commits";
import {
	assertRetainedConflictCopy,
	preserveLocalConflictCopy,
	readVerifiedRemoteVersion,
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

/** Repair only a missing physical object after its put won the canonical merge. A changed existing object is left for causal reconciliation. */
export async function repairMissingAcceptedUploads(
	deps: Dependencies,
	items: Array<
		| string
		| {
				path: string;
				snapshot?: { content: ArrayBuffer; sha256: string };
		  }
	>,
	commitProof?: CanonicalCommitProof,
	validationToken = deps.realtimeGuardValidationToken,
): Promise<void> {
	if (items.length === 0) {
		return;
	}
	const canonical =
		await deps.indexManager.readCanonicalIndexForRepair(commitProof);
	let repaired = false;
	const snapshots = new Map<
		string,
		{ content: ArrayBuffer; sha256: string }
	>();
	for (const item of items) {
		if (typeof item !== "string" && item.snapshot) {
			snapshots.set(item.path, item.snapshot);
		}
	}
	const paths = new Set(
		items.map((item) => (typeof item === "string" ? item : item.path)),
	);
	for (const path of paths) {
		let accepted = canonical.files[path];
		if (!accepted || accepted.deleted) {
			continue;
		}
		const remotePath = joinPath(deps.settings.remotePath, path);
		const physical = await deps.yandexClient.getLogicalResource(remotePath);
		let repairFingerprint =
			getPhysicalResourceFingerprint(physical) ?? undefined;
		let retainedCopy: { path: string; sha256: string } | undefined;
		const physicalMatches =
			physical !== null &&
			accepted.remoteFingerprint !== undefined &&
			matchesPhysicalResourceFingerprint(
				accepted.remoteFingerprint,
				physical,
			);
		if (physicalMatches) {
			continue;
		}
		let snapshot = snapshots.get(path);
		if (!snapshot && deps.vaultAdapter.fileExists(path)) {
			const content = await deps.vaultAdapter.readFile(path);
			snapshot = { content, sha256: await computeSha256(content) };
		}
		if (!snapshot || snapshot.sha256 !== accepted.sha256) {
			continue;
		}
		const freshCanonical = await deps.indexManager.readCanonicalIndex();
		const currentlyAuthorized = freshCanonical.files[path];
		if (freshCanonical.maintenance !== undefined) {
			throw new Error(
				"Encryption maintenance started before physical upload repair",
			);
		}
		if (
			freshCanonical.epoch !== canonical.epoch ||
			!currentlyAuthorized ||
			currentlyAuthorized.deleted ||
			currentlyAuthorized.sha256 !== accepted.sha256
		) {
			logger.info(
				"Post-commit upload repair cancelled by newer canonical state",
				{
					committedEpoch: shortenDiagnosticValue(canonical.epoch),
					currentEpoch: shortenDiagnosticValue(freshCanonical.epoch),
					committedRevision: canonical.revision,
					currentRevision: freshCanonical.revision,
				},
			);
			continue;
		}
		if (validationToken !== undefined) {
			const guard = await deps.getSyncGuardResult(false, validationToken);
			if (guard.blockReason) {
				throw new Error(
					"Encryption state changed before physical upload repair",
				);
			}
		}
		accepted = currentlyAuthorized;
		if (physical) {
			const verified = await readVerifiedRemoteVersion(deps, path);
			repairFingerprint =
				getPhysicalResourceFingerprint(verified.snapshot.resource) ??
				undefined;
			const remoteContent = verified.snapshot.content;
			const remoteSha256 = verified.sha256;
			if (remoteSha256 !== accepted.sha256) {
				const conflictPath = await preserveLocalConflictCopy(
					deps,
					path,
					remoteContent,
				);
				await uploadCausalConflictCopy(
					deps,
					conflictPath,
					remoteContent,
				);
				if (!(await saveRemoteIndexBestEffort(deps))) {
					throw new Error(
						"Physical repair conflict copy was not committed",
					);
				}
				retainedCopy = { path: conflictPath, sha256: remoteSha256 };
			} else {
				const remoteFingerprint =
					getPhysicalResourceFingerprint(physical) ?? undefined;
				const remoteMtime = new Date(physical.modified).getTime();
				setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
					...accepted,
					remoteMtime: Number.isFinite(remoteMtime)
						? remoteMtime
						: accepted.remoteMtime,
					remoteFingerprint,
				});
				repaired = true;
				continue;
			}
		}
		setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
			...accepted,
		});
		const uploadGuard = await deps.getSyncGuardResult(
			false,
			validationToken,
		);
		if (uploadGuard.blockReason) {
			throw new Error(uploadGuard.blockReason);
		}
		const uploadValidationToken =
			validationToken ?? uploadGuard.validationToken;
		const assertAuthority = async () => {
			if (retainedCopy) {
				await assertRetainedConflictCopy(
					deps,
					retainedCopy.path,
					retainedCopy.sha256,
					canonical.epoch,
				);
			}
			const guard = await deps.getSyncGuardResult(
				false,
				uploadValidationToken,
			);
			if (guard.blockReason) {
				throw new Error(guard.blockReason);
			}
			const latest = await deps.indexManager.readCanonicalIndex();
			const current = latest.files[path];
			if (
				latest.maintenance ||
				latest.epoch !== canonical.epoch ||
				!current ||
				current.deleted ||
				current.sha256 !== accepted.sha256 ||
				current.changedRevision !== accepted.changedRevision
			) {
				throw new Error("Canonical changed before corrective upload");
			}
		};
		const uploaded = await fileOperations.materializeUploadedFile(
			deps.fileOperations,
			path,
			snapshot,
			false,
			true,
			async () => {
				await assertAuthority();
				const actual =
					await deps.yandexClient.getLogicalResource(remotePath);
				if (
					physical
						? !matchesPhysicalResourceFingerprint(
								repairFingerprint,
								actual,
							)
						: actual !== null
				) {
					throw new Error(
						"Physical version changed before corrective upload",
					);
				}
			},
			() =>
				fileOperations.confirmUploadedSnapshot(
					deps.fileOperations,
					path,
					snapshot.sha256,
					assertAuthority,
					uploadValidationToken,
				),
		);
		deps.indexManager.updateLocalFile(
			path,
			createConfirmedBaseline(uploaded, uploaded, accepted),
		);
		setRecordValue(deps.indexManager.getRemoteIndex().files, path, {
			...accepted,
			remoteFingerprint: uploaded.remoteFingerprint,
			remoteMtime: uploaded.remoteMtime,
		});
		repaired = true;
	}
	if (repaired && !(await saveMoveCompletionBestEffort(deps))) {
		throw new Error(
			"Repaired uploads could not be confirmed in canonical index",
		);
	}
}

import type { Dependencies } from "./full";
import type { SyncResult, SyncIndex } from "../../types";
import { isRemoteReadTimeout } from "../../api/yandex-client";
import { computeSha256 } from "../../utils/hash-utils";
import { joinPath } from "../../utils/path-utils";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../../utils/resource-fingerprint";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { stableSerialize } from "../canonical/transaction-rules";
import { createConfirmedBaseline } from "../local/baseline-rules";
import { createSyncError } from "../errors";
import * as fileOperations from "../files/operations";
import { t } from "../../i18n";
import { logger } from "../../utils/logger";

/** Receive an existing canonical before allowing a pristine installation to publish local files. */
export async function receiveInitialRemoteState(
	deps: Dependencies,
	result: SyncResult,
	validationToken?: string,
): Promise<void> {
	const index = deps.indexManager;
	const canonical = JSON.parse(
		JSON.stringify(index.getRemoteIndex()),
	) as SyncIndex;
	const signature = stableSerialize(canonical);
	const paths = Object.entries(canonical.files).filter(([path]) =>
		deps.fileOperations.vaultAdapter.shouldSync(path),
	);
	const assertAuthority = async () => {
		await index.assertRemoteScope();
		const guard = await deps.getSyncGuardResult(false, validationToken);
		if (guard.blockReason) {
			throw new Error(guard.blockReason);
		}
		if (stableSerialize(await index.readCanonicalIndex()) !== signature) {
			throw new Error(
				"Canonical changed during initial remote receive; retry required",
			);
		}
	};
	// Binding the epoch does not acknowledge a revision or a successful receive.
	index.getLocalIndex().observedEpoch = canonical.epoch;
	await deps.indexSaveCallback?.();
	deps.setSyncPhase("scanning-local");
	const local = await index.buildLocalIndex();
	fileOperations.assertPortableLocalTree(deps.fileOperations, [
		...local.keys(),
		...paths.filter(([, value]) => !value.deleted).map(([path]) => path),
	]);
	const live = paths.filter(([, value]) => !value.deleted);
	deps.setSyncPhase("applying", t("status.op.downloading_files"), {
		completed: 0,
		total: live.length,
	});
	logger.info("Initial remote receive started", {
		files: live.length,
		revision: canonical.revision,
	});
	const outcomes = await runWithConcurrencySettled(
		live.map(([path, target]) => async () => {
			const expected = local.get(path)?.sha256 ?? null;
			try {
				await assertAuthority();
				const remotePath = joinPath(deps.settings.remotePath, path);
				const budget = deps.yandexClient.createDownloadBudget();
				const resource =
					expected === target.sha256
						? await deps.yandexClient.getLogicalResource(
								remotePath,
								budget,
							)
						: undefined;
				if (
					expected === target.sha256 &&
					matchesPhysicalResourceFingerprint(
						target.remoteFingerprint,
						resource ?? null,
					)
				) {
					await assertAuthority();
					await fileOperations.assertDownloadLocalUnchanged(
						deps.fileOperations,
						path,
						expected,
					);
					index.updateLocalFile(
						path,
						createConfirmedBaseline(
							local.get(path)!,
							{
								...target,
								remoteFingerprint:
									getPhysicalResourceFingerprint(
										resource ?? null,
									) ?? undefined,
							},
							target,
						),
					);
				} else {
					const snapshot =
						await deps.yandexClient.downloadStableLogicalFile(
							remotePath,
							resource ?? undefined,
							budget,
						);
					if (
						!snapshot ||
						(await computeSha256(snapshot.content)) !==
							target.sha256
					) {
						throw new Error(
							"Physical file does not match canonical content during initial receive",
						);
					}
					await fileOperations.applyDownloadedContent(
						deps.fileOperations,
						path,
						snapshot.content,
						{
							serverMtime: Date.parse(snapshot.resource.modified),
							remoteFingerprint:
								getPhysicalResourceFingerprint(
									snapshot.resource,
								) ?? undefined,
						},
						expected,
						assertAuthority,
					);
					result.downloaded++;
				}
				await deps.indexSaveCallback?.();
			} catch (error) {
				const syncError = createSyncError(error, path, "download");
				result.errors.push(syncError);
				deps.fileOperations.onOperationError?.(syncError);
				throw error;
			}
		}),
		Math.max(1, deps.settings.maxConcurrency || 5),
		(completed) => deps.reportProgress(completed, live.length),
		{ stopOnError: isRemoteReadTimeout },
	);
	if (outcomes.some((outcome) => outcome.status === "rejected")) {
		await deps.indexSaveCallback?.();
		return;
	}
	// Only exact tombstones apply here; unknown local descendants remain new files.
	for (const [path, target] of paths) {
		if (!target.deleted) {
			continue;
		}
		try {
			await assertAuthority();
			const expected = local.get(path)?.sha256 ?? null;
			await fileOperations.assertDownloadLocalUnchanged(
				deps.fileOperations,
				path,
				expected,
			);
			if (expected !== null) {
				const content =
					await deps.fileOperations.vaultAdapter.readFile(path);
				await deps.fileOperations.vaultAdapter.backupOverwrittenFile(
					path,
					content,
				);
				await fileOperations.assertDownloadLocalUnchanged(
					deps.fileOperations,
					path,
					expected,
				);
				index.enqueuePhysicalAction("delete-local", path, {
					canonicalRevision: canonical.revision,
					expectedChangedRevision: target.changedRevision,
					baselineSha256: expected,
					origin: "exact-delete",
				});
				await deps.indexSaveCallback?.();
				const outcome = await fileOperations.deleteLocalFile(
					deps.fileOperations,
					path,
					assertAuthority,
				);
				if (outcome !== "completed") {
					throw new Error("Initial local deletion was not completed");
				}
				result.deleted++;
			} else {
				const pending = index.getPendingPhysicalAction(
					"delete-local",
					path,
				);
				if (pending) {
					index.completePhysicalAction(pending.id);
				}
			}
			index.updateLocalFile(path, { ...target });
			await deps.indexSaveCallback?.();
		} catch (error) {
			result.errors.push(createSyncError(error, path, "delete_local"));
			return;
		}
	}
	await assertAuthority();
	// Recheck every received path after all concurrent tasks and backups have settled.
	for (const [path, target] of paths) {
		await fileOperations.assertDownloadLocalUnchanged(
			deps.fileOperations,
			path,
			target.deleted ? null : target.sha256,
		);
	}
	await assertAuthority();
	const previous = index.captureLocalCausalState();
	try {
		index.markRemoteObserved();
		await deps.indexSaveCallback?.();
	} catch (error) {
		index.restoreLocalCausalState(previous);
		throw error;
	}
	logger.info("Initial remote receive completed", {
		files: live.length,
		revision: canonical.revision,
	});
}

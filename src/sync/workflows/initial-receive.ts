import type { Dependencies } from "./full";
import type {
	FileMetadata,
	SyncResult,
	SyncIndex,
	YandexResource,
} from "../../types";
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
	const readCanonical =
		deps.canonicalReadSession ??
		index.createCanonicalReadSession(() => {
			deps.canonicalReadSession?.assertCurrent();
			assertSession();
		});
	const configurationVersion =
		deps.yandexClient.getReadConfigurationVersion();
	const remotePath = deps.settings.remotePath;
	const assertSession = () => {
		deps.canonicalReadSession?.assertCurrent();
		if (deps.isPaused) {
			throw new Error("Synchronization is paused");
		}
		if (
			deps.yandexClient.getReadConfigurationVersion() !==
				configurationVersion ||
			deps.settings.remotePath !== remotePath
		) {
			throw new Error("Initial receive configuration changed");
		}
	};
	const paths = Object.entries(canonical.files).filter(([path]) =>
		deps.fileOperations.vaultAdapter.shouldSync(path),
	);
	let authorityTail: Promise<void> = Promise.resolve();
	const assertAuthority = (
		captureRoot?: (resources: YandexResource[]) => void,
	) => {
		// Each queued evaluation owns a new stable root pair and its validators.
		const check = authorityTail.then(async () => {
			assertSession();
			const current = await readCanonical(async (observation) => {
				const guard = await deps.getSyncGuardResult(
					false,
					validationToken,
					false,
					observation,
				);
				if (guard.blockReason) {
					throw new Error(guard.blockReason);
				}
				captureRoot?.(index.getObservedRootResources(observation));
			});
			if (stableSerialize(current) !== signature) {
				throw new Error(
					"Canonical changed during initial remote receive; retry required",
				);
			}
			assertSession();
		});
		authorityTail = check;
		return check;
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
	deps.setSyncPhase("applying", t("status.op.receiving_initial_files"), {
		completed: 0,
		total: live.length,
	});
	logger.info("Initial remote receive started", {
		files: live.length,
		revision: canonical.revision,
	});
	const concurrency = Math.max(1, deps.settings.maxConcurrency || 5);
	const identical = live.filter(
		([path, target]) => local.get(path)?.sha256 === target.sha256,
	);
	const confirmed = new Map<string, FileMetadata>();
	const received = new Set<string>();
	/** Finish a protected receive without extending its original read deadline. */
	const receiveFile = async (
		path: string,
		target: FileMetadata,
		resource?: YandexResource,
		budget = deps.yandexClient.createDownloadBudget(),
	): Promise<void> => {
		assertSession();
		const expected = local.get(path)?.sha256 ?? null;
		const snapshot = await deps.yandexClient.downloadStableLogicalFile(
			joinPath(remotePath, path),
			resource,
			budget,
		);
		assertSession();
		if (
			!snapshot ||
			(await computeSha256(snapshot.content)) !== target.sha256
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
					getPhysicalResourceFingerprint(snapshot.resource) ??
					undefined,
			},
			expected,
			() => assertAuthority(),
		);
		result.downloaded++;
		await deps.indexSaveCallback?.();
		received.add(path);
	};
	if (identical.length > 0) {
		let observedResources: YandexResource[] = [];
		await assertAuthority((resources) => {
			observedResources = resources;
		});
		const targets = new Map(
			identical.map(([path, target]) => [
				joinPath(remotePath, path),
				{ path, target },
			]),
		);
		try {
			await deps.yandexClient.collectLogicalMetadata(
				[...targets.keys()],
				concurrency,
				async (fullPath, resource, budget) => {
					const { path, target } = targets.get(fullPath)!;
					try {
						assertSession();
						if (
							!matchesPhysicalResourceFingerprint(
								target.remoteFingerprint,
								resource,
							)
						) {
							await receiveFile(
								path,
								target,
								resource ?? undefined,
								budget,
							);
							return;
						}
						await fileOperations.assertDownloadLocalUnchanged(
							deps.fileOperations,
							path,
							target.sha256,
						);
						assertSession();
						confirmed.set(
							path,
							createConfirmedBaseline(
								local.get(path)!,
								{
									...target,
									remoteFingerprint:
										getPhysicalResourceFingerprint(
											resource,
										) ?? undefined,
								},
								target,
							),
						);
					} catch (error) {
						const syncError = createSyncError(
							error,
							path,
							"download",
						);
						result.errors.push(syncError);
						deps.fileOperations.onOperationError?.(syncError);
						throw error;
					}
				},
				{ observedResources, assertCurrent: assertSession },
			);
		} catch (error) {
			if (result.errors.length === 0) {
				result.errors.push(createSyncError(error, "", "download"));
			}
			return;
		}

		// These observations only establish baselines; physical writes keep their own guards.
		await assertAuthority();
		const previous = index.captureLocalCausalState();
		try {
			for (const [path, baseline] of confirmed) {
				index.updateLocalFile(path, baseline);
			}
			await deps.indexSaveCallback?.();
		} catch (error) {
			index.restoreLocalCausalState(previous);
			throw error;
		}
		deps.reportProgress(confirmed.size + received.size, live.length);
	}
	const completedBeforePending = confirmed.size + received.size;
	const pending = live.filter(
		([path]) => !confirmed.has(path) && !received.has(path),
	);
	const outcomes = await runWithConcurrencySettled(
		pending.map(([path, target]) => async () => {
			try {
				await assertAuthority();
				await receiveFile(path, target);
			} catch (error) {
				const syncError = createSyncError(error, path, "download");
				result.errors.push(syncError);
				deps.fileOperations.onOperationError?.(syncError);
				throw error;
			}
		}),
		concurrency,
		(completed) =>
			deps.reportProgress(
				completedBeforePending + completed,
				live.length,
			),
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
					() => assertAuthority(),
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
		matchedFiles: confirmed.size,
		concurrency,
		revision: canonical.revision,
	});
}

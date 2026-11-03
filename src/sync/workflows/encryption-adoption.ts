import type { FileMetadata, SyncResult } from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import {
	getDirectory,
	getFileName,
	hasPortablePathCollision,
	joinPath,
} from "../../utils/path-utils";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { isReplacementPath } from "../../crypto/replacement";
import { LocalFileChangedError } from "../../api/vault-adapter";
import { getRecordValue, protectRecord } from "../../utils/record-utils";
import { sameIndexValue } from "../canonical/transaction-rules";
import { preserveLocalConflictCopy } from "../reconciliation/conflict-settlement";
import type { Dependencies, FullSyncContext } from "./full";

/** Receive the selected authoritative generation without consulting stale local baselines. */
export async function receiveEncryptionReplacement(
	deps: Dependencies,
	adoption: FullSyncContext,
	result: SyncResult,
): Promise<boolean> {
	const index = deps.indexManager;
	const canonical = structuredClone(index.getRemoteIndex());
	const receipt = canonical.epochAdoption;
	if (
		!receipt ||
		!index.getObservedEpoch() ||
		index.getObservedEpoch() === canonical.epoch
	) {
		return false;
	}
	if (canonical.maintenance) {
		throw new Error("Authoritative reception waits for encryption cleanup");
	}
	adoption.adoptionSnapshot = index.captureLocalCausalState();
	adoption.adoptedEpoch = canonical.epoch;
	index.beginEpochAdoption(canonical.epoch, false);
	const selected = (path: string) =>
		isReplacementPath(path, receipt.scope) &&
		deps.fileOperations.vaultAdapter.shouldSync(path);
	const targets = Object.entries(canonical.files).filter(
		([path, file]) => !file.deleted && selected(path),
	);
	const reader =
		deps.canonicalReadSession ?? index.createCanonicalReadSession();
	const assertAuthority = async () => {
		const current = await reader();
		if (deps.isPaused || !sameIndexValue(current, canonical)) {
			throw new Error("Encryption replacement changed during reception");
		}
		reader.assertCurrent();
	};
	const state = index.getLocalIndex();
	let progress = state.replacementReceive;
	if (!progress) {
		progress = {
			operationId: receipt.operationId,
			epoch: canonical.epoch,
			scope: structuredClone(index.getEncryptionReplacementScope()),
			initial: Object.fromEntries(
				[...(await index.buildLocalIndex())].map(([path, file]) => [
					path,
					file.sha256,
				]),
			),
			applied: {},
			watcherBoundary: { ...deps.watcherBoundary },
		};
		state.replacementReceive = progress;
		await deps.indexSaveCallback?.();
	}
	if (
		!sameIndexValue(progress.scope, index.getEncryptionReplacementScope())
	) {
		throw new Error(
			"Local replacement receipt no longer matches its scope",
		);
	}
	if (
		progress.operationId !== receipt.operationId ||
		progress.epoch !== canonical.epoch
	) {
		progress = {
			...progress,
			operationId: receipt.operationId,
			epoch: canonical.epoch,
			initial: { ...progress.initial, ...progress.applied },
			applied: {},
		};
		state.replacementReceive = progress;
		await deps.indexSaveCallback?.();
	}
	protectRecord(progress.initial);
	protectRecord(progress.applied);
	const expectedHash = (path: string) =>
		getRecordValue(progress.applied, path) ??
		getRecordValue(progress.initial, path) ??
		null;
	const assertUnchanged = async (path: string) => {
		const actual = deps.fileOperations.vaultAdapter.fileExists(path)
			? await computeSha256(
					await deps.fileOperations.vaultAdapter.readFile(path),
				)
			: null;
		if (actual !== expectedHash(path)) {
			throw new LocalFileChangedError();
		}
	};
	try {
		await prepareReceptionStructure(
			deps,
			targets,
			selected,
			assertAuthority,
			async (path, directory) => {
				const tree =
					await deps.fileOperations.vaultAdapter.getForceTree(false);
				const inventory = (value: typeof tree) =>
					[
						...value.files.map((file) => `f:${file}`),
						...value.directories.map((folder) => `d:${folder}`),
					]
						.filter(
							(entry) =>
								entry.slice(2) === path ||
								entry.slice(2).startsWith(`${path}/`),
						)
						.sort();
				const hashes = new Map<string, string>();
				for (const file of directory
					? tree.files.filter((file) => file.startsWith(`${path}/`))
					: [path]) {
					const content =
						await deps.fileOperations.vaultAdapter.readFile(file);
					const hash = await computeSha256(content);
					if (hash !== expectedHash(file)) {
						const alias = directory
							? joinPath(
									getDirectory(path),
									`${getFileName(path)}_${file.slice(path.length + 1).replace(/\//g, "_")}`,
								)
							: path;
						const copy = await preserveLocalConflictCopy(
							deps.syncReconciliation,
							alias,
							content,
						);
						if (
							!selected(copy) ||
							hasPortablePathCollision([
								...targets.map(([target]) => target),
								copy,
							])
						) {
							throw new Error(
								"A retained structural conflict copy is outside the selected scope",
							);
						}
						hashes.set(copy, hash);
					}
					hashes.set(file, hash);
				}
				const assertObserved =
					deps.fileOperations.vaultAdapter.captureLocalObservation([
						path,
						...hashes.keys(),
					]);
				await assertAuthority();
				for (const [file, hash] of hashes) {
					if (
						(await computeSha256(
							await deps.fileOperations.vaultAdapter.readFile(
								file,
							),
						)) !== hash
					) {
						throw new LocalFileChangedError();
					}
				}
				if (
					!sameIndexValue(
						inventory(tree),
						inventory(
							await deps.fileOperations.vaultAdapter.getForceTree(
								false,
							),
						),
					)
				) {
					throw new LocalFileChangedError();
				}
				return assertObserved;
			},
		);
		const outcomes = await runWithConcurrencySettled(
			targets.map(([path, file]) => async () => {
				let skipLocalWrite = false;
				try {
					await assertUnchanged(path);
				} catch (error) {
					if (error instanceof LocalFileChangedError) {
						skipLocalWrite = true;
					} else {
						throw error;
					}
				}
				if (getRecordValue(progress.applied, path) === file.sha256) {
					skipLocalWrite = true;
				}
				await assertAuthority();
				if (skipLocalWrite) {
					const physical = await deps.yandexClient.getLogicalResource(
						joinPath(deps.settings.remotePath, path),
					);
					if (
						physical?.sha256 &&
						physical.sha256 === file.remoteFingerprint
					) {
						await assertAuthority();
						return;
					}
				}
				const snapshot =
					await deps.yandexClient.downloadStableLogicalFile(
						joinPath(deps.settings.remotePath, path),
					);
				if (
					!snapshot ||
					(await computeSha256(snapshot.content)) !== file.sha256
				) {
					throw new Error(
						"Authoritative reception found unverified target bytes",
					);
				}
				await assertAuthority();
				if (skipLocalWrite) {
					return;
				}
				try {
					await deps.fileOperations.vaultAdapter.writeFile(
						path,
						snapshot.content,
						{
							expectedSha256: expectedHash(path),
							validateBeforeWrite: assertAuthority,
							beforeWrite: () =>
								deps.fileOperations.expectWatcherEvent(
									path,
									"upload",
								),
						},
					);
				} catch (error) {
					if (error instanceof LocalFileChangedError) {
						return;
					}
					throw error;
				}
				Object.defineProperty(progress.applied, path, {
					value: file.sha256,
					enumerable: true,
					writable: true,
					configurable: true,
				});
				result.downloaded++;
				await deps.indexSaveCallback?.();
			}),
			Math.max(1, Math.min(deps.settings.maxConcurrency, 4)),
			undefined,
			{ stopOnError: () => true },
		);
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") {
				throw outcome.reason;
			}
		}
		for (const path of Object.keys(progress.initial)) {
			if (
				selected(path) &&
				(!canonical.files[path] || canonical.files[path].deleted)
			) {
				try {
					await deps.fileOperations.vaultAdapter.deleteForcePath(
						path,
						async () => {
							await assertAuthority();
							await assertUnchanged(path);
						},
						() =>
							deps.fileOperations.expectWatcherEvent(
								path,
								"delete",
							),
					);
				} catch (error) {
					if (error instanceof LocalFileChangedError) {
						continue;
					}
					throw error;
				}
				result.deleted++;
				delete progress.initial[path];
				delete progress.applied[path];
				await deps.indexSaveCallback?.();
			}
		}
		await assertAuthority();
		const baseline: Record<string, FileMetadata> = Object.fromEntries(
			targets.map(([path, file]) => [path, { ...file }]),
		);
		index.finishEncryptionReplacement(baseline);
		result.settledWatcherEvents = progress.watcherBoundary;
		delete state.replacementReceive;
		try {
			await deps.indexSaveCallback?.();
		} catch (error) {
			state.replacementReceive = progress;
			throw error;
		}
		result.epochAdopted = true;
		return true;
	} finally {
		if (!deps.canonicalReadSession) {
			reader.close();
		}
	}
}

/** Clear only selected structural blockers, after verifying the affected target bytes. */
async function prepareReceptionStructure(
	deps: Dependencies,
	targets: [string, FileMetadata][],
	selected: (path: string) => boolean,
	assertAuthority: () => Promise<void>,
	assertLocal: (path: string, directory: boolean) => Promise<() => void>,
): Promise<void> {
	const adapter = deps.fileOperations.vaultAdapter;
	const tree = await adapter.getForceTree(false);
	const conflicts = (target: string, path: string, directory: boolean) =>
		directory
			? hasPortablePathCollision([target], [path])
			: hasPortablePathCollision([target, path]);
	const candidates = [
		...tree.files.map((path) => ({ path, directory: false })),
		...tree.directories.map((path) => ({ path, directory: true })),
	]
		.filter((entry) =>
			targets.some(([target]) =>
				conflicts(target, entry.path, entry.directory),
			),
		)
		.sort(
			(left, right) =>
				left.path.split("/").length - right.path.split("/").length,
		);
	const removed: string[] = [];
	const prepared = new Set<string>();
	const inside = (path: string, root: string) =>
		path === root || path.startsWith(`${root}/`);
	const ownerScope = deps.indexManager.getRemoteIndex().epochAdoption!.scope;
	const localScope = deps.indexManager.getEncryptionReplacementScope();
	for (const entry of candidates) {
		if (removed.some((root) => inside(entry.path, root))) {
			continue;
		}
		const assertRemovable = (current: typeof tree) => {
			if (
				entry.directory
					? current.files.some(
							(path) =>
								inside(path, entry.path) && !selected(path),
						) ||
						current.directories.some(
							(path) =>
								inside(path, entry.path) &&
								(!isReplacementPath(path, {
									...ownerScope,
									syncPatterns: [],
								}) ||
									!isReplacementPath(path, {
										...localScope,
										syncPatterns: [],
									})),
						)
					: !selected(entry.path)
			) {
				throw new Error(
					"A retained local descendant blocks authoritative reception",
				);
			}
		};
		assertRemovable(tree);
		const [path, file] = targets.find(([target]) =>
			conflicts(target, entry.path, entry.directory),
		)!;
		if (!prepared.has(path)) {
			await assertAuthority();
			const snapshot = await deps.yandexClient.downloadStableLogicalFile(
				joinPath(deps.settings.remotePath, path),
			);
			if (
				!snapshot ||
				(await computeSha256(snapshot.content)) !== file.sha256
			) {
				throw new Error("Structural reception target is unverified");
			}
			prepared.add(path);
		}
		await assertAuthority();
		await adapter.deleteForcePath(
			entry.path,
			async () => {
				await assertAuthority();
				assertRemovable(await adapter.getForceTree(false));
				return await assertLocal(entry.path, entry.directory);
			},
			() => deps.fileOperations.expectWatcherEvent(entry.path, "delete"),
		);
		removed.push(entry.path);
	}
}

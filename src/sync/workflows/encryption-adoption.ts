import type { FileMetadata, SyncResult } from "../../types";
import { computeSha256 } from "../../utils/hash-utils";
import { hasPortablePathCollision, joinPath } from "../../utils/path-utils";
import { runWithConcurrencySettled } from "../../utils/semaphore";
import { isReplacementPath } from "../../crypto/replacement";
import { sameIndexValue } from "../canonical/transaction-rules";
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
	try {
		await prepareReceptionStructure(
			deps,
			targets,
			selected,
			assertAuthority,
		);
		const outcomes = await runWithConcurrencySettled(
			targets.map(([path, file]) => async () => {
				await assertAuthority();
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
				deps.fileOperations.expectWatcherEvent(path, "upload");
				await deps.fileOperations.vaultAdapter.writeFile(
					path,
					snapshot.content,
					{
						expectedSha256:
							deps.fileOperations.vaultAdapter.fileExists(path)
								? await computeSha256(
										await deps.fileOperations.vaultAdapter.readFile(
											path,
										),
									)
								: null,
						validateBeforeWrite: assertAuthority,
					},
				);
				result.downloaded++;
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
		const actual = await index.buildLocalIndex();
		for (const path of actual.keys()) {
			if (
				selected(path) &&
				(!canonical.files[path] || canonical.files[path].deleted)
			) {
				await assertAuthority();
				deps.fileOperations.expectWatcherEvent(path, "delete");
				await deps.fileOperations.vaultAdapter.deleteForcePath(
					path,
					assertAuthority,
				);
				result.deleted++;
			}
		}
		const verified = await index.buildLocalIndex();
		if (
			targets.some(
				([path, file]) => verified.get(path)?.sha256 !== file.sha256,
			) ||
			[...verified.keys()].some(
				(path) =>
					selected(path) &&
					(!canonical.files[path] || canonical.files[path].deleted),
			)
		) {
			throw new Error(
				"Local files changed during authoritative reception",
			);
		}
		await assertAuthority();
		const baseline: Record<string, FileMetadata> = Object.fromEntries(
			targets.map(([path, file]) => [
				path,
				{ ...verified.get(path)!, ...file },
			]),
		);
		index.finishEncryptionReplacement(baseline);
		await deps.indexSaveCallback?.();
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
		deps.fileOperations.expectWatcherEvent(entry.path, "delete");
		await adapter.deleteForcePath(entry.path, async () => {
			await assertAuthority();
			assertRemovable(await adapter.getForceTree(false));
		});
		removed.push(entry.path);
	}
}

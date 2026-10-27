import type { EncryptionContext } from "./context";
import type { EncryptionCodec } from "./encryption";
import {
	EncryptionReplacementRevokedError,
	isPreservedRawPath,
	isReplacementPath,
	isReplacementSubtree,
} from "./replacement";
import { planRecursiveDeletes } from "../sync/files/deletion-cover";
import {
	getAncestorDirectories,
	isProtectedPath,
	joinPath,
	shouldInspectRawSyncPath,
	toLocalPath,
} from "../utils/path-utils";
import { computeSha256 } from "../utils/hash-utils";
import { getPhysicalResourceFingerprint } from "../utils/resource-fingerprint";
import { runWithConcurrencySettled } from "../utils/semaphore";
import { sameIndexValue } from "../sync/canonical/transaction-rules";
import type {
	RecursiveDeleteAction,
	SyncIndex,
	YandexResource,
} from "../types";
import type { CanonicalReadSession } from "../sync/canonical/manager";
import type { YandexDiskClient } from "../api/yandex-client";

/** Delete the selected obsolete namespace, then prove the target reference again. */
export async function cleanupEncryptionReplacement(
	context: EncryptionContext,
	sourceCodec: EncryptionCodec | null | undefined,
): Promise<void> {
	const index = context.index;
	const initial = index.getMaintenance();
	const replacement = initial?.replacement;
	if (!initial || !replacement || initial.phase !== "cleanup") {
		throw new Error("Authoritative cleanup has no committed authority");
	}
	const epoch = index.getRemoteIndex().epoch;
	const root = context.getSettings().remotePath;
	const configuration = context.client.getReadConfigurationVersion();
	const lifetime = context.engine.createReadLifetimeGuard();
	const assertCurrent = () => {
		try {
			lifetime();
			context.assertConnectionAllowed();
		} catch {
			throw new EncryptionReplacementRevokedError(
				"Encryption replacement lifetime ended",
			);
		}
		if (
			configuration !== context.client.getReadConfigurationVersion() ||
			root !== context.getSettings().remotePath
		) {
			throw new EncryptionReplacementRevokedError(
				"Encryption replacement configuration changed",
			);
		}
	};
	let reader = index.createCanonicalReadSession(assertCurrent);
	const renewReader = () => {
		reader.close();
		reader = index.createCanonicalReadSession(assertCurrent);
	};
	const readAuthority = async () => {
		assertCurrent();
		const current = await index.assertMaintenanceAuthority(
			epoch,
			index.getMaintenance()!,
			reader,
		);
		if (
			current.maintenance?.id !== initial.id ||
			current.maintenance.replacement?.targetEpoch !== epoch
		) {
			throw new Error("Encryption replacement authority changed");
		}
		return current;
	};
	try {
		await context.client.withWriteGuard(assertCurrent, async () => {
			for (let pass = 0; pass < 4; pass++) {
				const canonical = await readAuthority();
				const targets = new Map<string, string>();
				for (const [path, file] of Object.entries(canonical.files)) {
					if (!file.deleted) {
						targets.set(
							toLocalPath(
								await context.client.getPhysicalPath(
									joinPath(root, path),
								),
								root,
							),
							path,
						);
					}
				}
				const preserved = new Set([
					...replacement.preservedRawPaths,
					...targets.keys(),
				]);
				const directoryPages = new Map<string, number>();
				const resources = await context.client.getResourcesRecursive(
					root,
					true,
					4,
					true,
					(path) => {
						const raw = toLocalPath(path, root);
						if (isProtectedPath(raw)) {
							if (raw.includes("/")) {
								preserved.add(raw);
							}
							return false;
						}
						return !isPreservedRawPath(
							raw,
							replacement.preservedRawPaths,
						);
					},
					false,
					(path, pages) => {
						directoryPages.set(path, pages);
					},
				);
				assertCurrent();
				const entries: RecursiveDeleteAction[] = resources.map(
					(resource) => ({
						path: toLocalPath(resource.path, root),
						kind: resource.type,
					}),
				);
				const populatedDirectories = getAncestorDirectories(
					entries
						.filter((entry) => entry.kind === "file")
						.map((entry) => entry.path),
				);
				const removable = new Set<string>();
				const collapsible = new Set<string>();
				for (const resource of resources) {
					const raw = toLocalPath(resource.path, root);
					// Empty raw trees can outlive their codec; ordinary sync has no empty-folder state.
					if (
						resource.type === "dir" &&
						!populatedDirectories.has(raw)
					) {
						continue;
					}
					if (
						targets.has(raw) ||
						(resource.type === "dir" &&
							[...targets.keys(), ...preserved].some((path) =>
								path.startsWith(`${raw}/`),
							))
					) {
						continue;
					}
					if (
						!shouldInspectRawSyncPath(
							raw,
							replacement.scope.syncPatterns,
							replacement.scope.excludePatterns,
							replacement.scope.syncDotObsidian,
							replacement.scope.configDir,
							sourceCodec !== null,
						)
					) {
						if (resource.type === "file") {
							preserved.add(raw);
						}
						continue;
					}
					if (
						sourceCodec === undefined &&
						context.getTransition()?.source.enabled === false
					) {
						sourceCodec = null;
					}
					if (
						sourceCodec === undefined &&
						resource.type === "file" &&
						!replacement.deletions.some(
							(action) =>
								raw === action.path ||
								raw.startsWith(`${action.path}/`),
						)
					) {
						const source = context.getTransition()?.source;
						if (source?.enabled && source.salt && source.password) {
							const candidate = await context.manager.createCodec(
								"hardened",
								source.salt,
								source.password,
							);
							if (
								!initial.source.verifier ||
								!(await candidate.verifyVerifier(
									initial.source.verifier,
								))
							) {
								throw new Error(
									"Source recovery authentication failed",
								);
							}
							await readAuthority();
							sourceCodec = candidate;
						}
					}
					if (sourceCodec === undefined) {
						if (
							replacement.deletions.some(
								(action) =>
									raw === action.path ||
									raw.startsWith(`${action.path}/`),
							)
						) {
							if (resource.type === "file") {
								removable.add(raw);
							} else if (
								replacement.deletions.some(
									(action) =>
										action.kind === "dir" &&
										(raw === action.path ||
											raw.startsWith(`${action.path}/`)),
								)
							) {
								collapsible.add(raw);
							}
							continue;
						}
						if (resource.type === "dir") {
							continue;
						}
						throw new Error(
							"Late source objects require source-capable recovery",
						);
					}
					const logical = await context.client.decodePhysicalUserPath(
						raw,
						sourceCodec,
					);
					if (resource.type === "dir") {
						if (isReplacementSubtree(logical, replacement.scope)) {
							collapsible.add(raw);
						}
					} else if (isReplacementPath(logical, replacement.scope)) {
						removable.add(raw);
					} else {
						preserved.add(raw);
					}
				}
				const deletions = planRecursiveDeletes(
					entries,
					removable,
					preserved,
					(path) => collapsible.has(path),
				);
				if (
					(deletions.length > 0 &&
						!sameIndexValue(deletions, replacement.deletions)) ||
					[...preserved].some(
						(path) =>
							!targets.has(path) &&
							!replacement.preservedRawPaths.includes(path),
					)
				) {
					replacement.deletions = deletions;
					replacement.preservedRawPaths = [...preserved]
						.filter((path) => !targets.has(path))
						.sort();
					index.setMaintenance({
						...initial,
						replacement: structuredClone(replacement),
					});
					const receipt = index.getRemoteIndex().epochAdoption;
					if (receipt) {
						receipt.preservedRawPaths = [
							...replacement.preservedRawPaths,
						];
					}
					reader.close();
					await index.saveRemoteIndex();
					renewReader();
					const transition = context.getTransition();
					if (transition?.id === initial.id) {
						transition.replacement = structuredClone(replacement);
					}
					await context.persist();
				}
				await deleteReplacementGroup(
					context,
					epoch,
					root,
					deletions,
					[...targets.keys(), ...replacement.preservedRawPaths],
					reader,
					assertCurrent,
				);
				const { repaired, stamped } = await verifyReplacementTargets(
					context,
					canonical,
					targets,
					root,
					readAuthority,
					assertCurrent,
					directoryPages,
				);
				if (stamped) {
					reader.close();
					await index.saveRemoteIndex();
					renewReader();
				}
				if (deletions.length === 0 && !repaired) {
					const transition = context.getTransition();
					if (
						transition?.id === initial.id &&
						transition.referenceFiles
					) {
						const actual = await index.buildLocalIndex();
						if (
							!sameIndexValue(
								index.getEncryptionReplacementScope(),
								replacement.scope,
							) ||
							actual.size !==
								Object.keys(transition.referenceFiles).length ||
							[...actual].some(
								([path, file]) =>
									transition.referenceFiles?.[path]
										?.sha256 !== file.sha256,
							)
						) {
							throw new Error(
								"The initiating local reference changed during cleanup",
							);
						}
					}
					await readAuthority();
					return;
				}
			}
			throw new Error(
				"Concurrent writes prevented encryption replacement verification",
			);
		});
	} finally {
		reader.close();
	}
}

/** Join every admitted DELETE before exposing the first failure to recovery. */
async function deleteReplacementGroup(
	context: EncryptionContext,
	epoch: string,
	root: string,
	deletions: RecursiveDeleteAction[],
	retained: string[],
	reader: CanonicalReadSession,
	assertCurrent: () => void,
): Promise<void> {
	const index = context.index;
	let failed = false;
	let firstFailure: unknown;
	let cursor = 0;
	const workers = Math.max(
		1,
		Math.min(context.getSettings().maxConcurrency, 4, deletions.length),
	);
	await runWithConcurrencySettled(
		Array.from({ length: workers }, (_, worker) => async () => {
			const session =
				worker === 0
					? reader
					: index.createCanonicalReadSession(assertCurrent);
			try {
				while (!failed && cursor < deletions.length) {
					const action = deletions[cursor++]!;
					const guard = async () => {
						assertCurrent();
						if (failed) {
							throw firstFailure;
						}
						const current = await index.assertMaintenanceAuthority(
							epoch,
							index.getMaintenance()!,
							session,
						);
						if (
							!current.maintenance?.replacement?.deletions.some(
								(entry) => sameIndexValue(entry, action),
							) ||
							retained.some(
								(path) =>
									path === action.path ||
									path.startsWith(`${action.path}/`),
							)
						) {
							throw new Error(
								"Encryption subtree is no longer removable",
							);
						}
					};
					await deleteReplacementPath(
						context,
						joinPath(root, action.path),
						guard,
					);
				}
			} catch (error) {
				if (!failed) {
					failed = true;
					firstFailure = error;
				}
				throw error;
			} finally {
				if (worker !== 0) {
					session.close();
				}
			}
		}),
		workers,
	);
	if (failed) {
		throw firstFailure;
	}
}

/** A refused guard cannot be settled as an ambiguous sent request. */
async function deleteReplacementPath(
	context: EncryptionContext,
	path: string,
	guard: () => Promise<void>,
): Promise<void> {
	let guardRejected = false;
	try {
		await context.client.deleteResource(path, false, true, async () => {
			try {
				await guard();
			} catch (error) {
				guardRejected = true;
				throw error;
			}
		});
	} catch (error) {
		if (guardRejected) {
			throw error;
		}
		await guard();
		if (await context.client.getResource(path, 1, 0, true)) {
			throw error;
		}
	}
	await guard();
	if (await context.client.getResource(path, 1, 0, true)) {
		throw new Error("Encryption subtree deletion is incomplete");
	}
	await context.persist();
}

/** Repair drift only from pinned local plaintext and commit the verified physical stamps. */
async function verifyReplacementTargets(
	context: EncryptionContext,
	canonical: SyncIndex,
	targets: Map<string, string>,
	root: string,
	readAuthority: () => Promise<SyncIndex>,
	assertCurrent: () => void,
	directoryPages: ReadonlyMap<string, number>,
): Promise<{ repaired: boolean; stamped: boolean }> {
	const index = context.index;
	const service = context.getService();
	const assertVerificationCurrent = () => {
		assertCurrent();
		if (context.getService() !== service) {
			throw new EncryptionReplacementRevokedError(
				"Target verification codec changed",
			);
		}
	};
	const authority = await readAuthority();
	if (!sameIndexValue(authority.files, canonical.files)) {
		throw new Error(
			"Target reference changed before metadata verification",
		);
	}
	const assertAuthority = async () => {
		const current = await readAuthority();
		assertVerificationCurrent();
		if (!sameIndexValue(current, authority)) {
			throw new Error(
				"Target authority changed during metadata verification",
			);
		}
	};
	const metadata = new Map<
		string,
		{
			resource: YandexResource | null;
			budget: ReturnType<YandexDiskClient["createDownloadBudget"]>;
		}
	>();
	await context.client.collectLogicalMetadata(
		[...targets.values()].map((path) => joinPath(root, path)),
		Math.max(1, Math.min(context.getSettings().maxConcurrency, 4)),
		async (path, resource, budget) => {
			metadata.set(path, { resource, budget });
		},
		{
			assertCurrent: assertVerificationCurrent,
			knownDirectoryPages: directoryPages,
		},
	);
	await assertAuthority();
	let repaired = false;
	let stamped = false;
	for (const [raw, path] of targets) {
		assertVerificationCurrent();
		const file = canonical.files[path]!;
		const observation = metadata.get(joinPath(root, path))!;
		let resource = observation.resource;
		if (resource && resource.type !== "file") {
			throw new Error("Target verification encountered a directory");
		}
		if (
			resource &&
			file.remoteFingerprint &&
			(resource.sha256 === file.remoteFingerprint ||
				resource.md5 === file.remoteFingerprint)
		) {
			continue;
		}
		const snapshot = await context.client.downloadStableRawFile(
			joinPath(root, raw),
			resource ?? undefined,
			observation.budget,
		);
		assertVerificationCurrent();
		let matches = false;
		if (snapshot) {
			try {
				const content = service
					? await service.decrypt(snapshot.raw)
					: snapshot.raw;
				matches = (await computeSha256(content)) === file.sha256;
			} catch {
				/* Unauthenticated bytes are replaced from the pinned local reference. */
			}
		}
		if (!matches) {
			const content = await context.readLocalFile?.(path);
			if (!content || (await computeSha256(content)) !== file.sha256) {
				throw new Error(
					"Target repair requires the initiating reference bytes",
				);
			}
			await context.client.uploadFile(
				joinPath(root, path),
				content,
				false,
				false,
				true,
				async () => {
					await assertAuthority();
				},
			);
			const verified = await context.client.downloadStableRawFile(
				joinPath(root, raw),
			);
			const plaintext =
				verified &&
				(service ? await service.decrypt(verified.raw) : verified.raw);
			if (
				!plaintext ||
				(await computeSha256(plaintext)) !== file.sha256
			) {
				throw new Error("Target repair read-back failed");
			}
			resource = verified.resource;
			repaired = true;
		} else {
			resource = snapshot!.resource;
		}
		await assertAuthority();
		index.getRemoteIndex().files[path] = {
			...file,
			remoteFingerprint:
				getPhysicalResourceFingerprint(resource) ?? undefined,
			remoteMtime: Number.isFinite(new Date(resource.modified).getTime())
				? new Date(resource.modified).getTime()
				: undefined,
		};
		stamped = true;
	}
	await assertAuthority();
	return { repaired, stamped };
}

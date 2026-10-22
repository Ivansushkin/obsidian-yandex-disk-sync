import {
	ForceRecoveryPendingError,
	type ForceRecovery,
} from "../workflows/force-state";
import {
	getStableContentFingerprint,
	matchesStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import type { SyncIndex, YandexResource } from "../../types";
import type { YandexDiskClient } from "../../api/yandex-client";
import type { EncryptionCodec } from "../../crypto/encryption";
import {
	joinPath,
	isRootIndexLockPath,
	REMOTE_INDEX_LOCK_PREFIX,
} from "../../utils/path-utils";

import { computeSha256 } from "../../utils/hash-utils";
import { cloneIndex, sameIndexValue } from "./transaction-rules";

import { isJsonRecord } from "../../utils/record-utils";
import {
	validateCurrentIndexShape,
	validateCurrentIndexCausality,
} from "./schema";
import type { IndexSnapshotReader } from "./transaction";

export interface ForcePublicationDependencies {
	client: Pick<
		YandexDiskClient,
		| "getResource"
		| "downloadStableRawFile"
		| "moveResourceExclusive"
		| "uploadFile"
		| "deleteResource"
	>;
	getRemotePath(): string;
	getCanonicalPath(): string;
	getDeviceId(): string;
	getCurrentIndex(): Readonly<SyncIndex>;
	isScoped(): boolean;
	assertRemoteScope(): Promise<void>;
	getStableRootListing(): Promise<{
		resources: YandexResource[];
		rootExists: boolean;
	}>;
	readSnapshot: IndexSnapshotReader;
	serialize(index: SyncIndex): string;
	createTransactionId(): string;
	acceptPublishedIndex(index: SyncIndex): void;
}

/** Publish and recover one scoped Force operation using raw destination identity. */
export class ForcePublication {
	constructor(private readonly deps: ForcePublicationDependencies) {}
	/** Require matching operation authority before every Force write and retry. */
	async assertForceAuthority(
		id: string,
		epoch: string,
		codec: EncryptionCodec | null,
	): Promise<SyncIndex> {
		await this.deps.assertRemoteScope();
		const snapshot = await this.deps.client.downloadStableRawFile(
			this.deps.getCanonicalPath(),
		);
		if (!snapshot) {
			throw new Error("Force canonical authority is missing");
		}
		let index: unknown;
		try {
			const content = codec
				? await codec.decrypt(snapshot.raw)
				: snapshot.raw;
			index = JSON.parse(new TextDecoder().decode(content));
		} catch {
			throw new ForceRecoveryPendingError(
				"Force canonical authority is unreadable or superseded",
			);
		}
		if (!isJsonRecord(index)) {
			throw new Error("Force authority is invalid");
		}
		validateCurrentIndexShape(index);
		validateCurrentIndexCausality(index);
		if (
			index.epoch !== epoch ||
			index.maintenance?.kind !== "force" ||
			index.maintenance.id !== id ||
			index.maintenance.initiatedBy !== this.deps.getDeviceId()
		) {
			throw new Error("Force operation was superseded");
		}
		return index;
	}

	/** Replace raw destination metadata under an exclusive lock without decoding its old content. */
	async publishForceCanonical(
		desired: SyncIndex,
		codec: EncryptionCodec | null,
		initial = false,
		beforeCommit?: () => Promise<void>,
	): Promise<NonNullable<ForceRecovery["completion"]>> {
		if (!this.deps.isScoped()) {
			throw new Error(
				"Force replacement requires its scoped transaction",
			);
		}
		await this.deps.assertRemoteScope();
		const id =
			desired.maintenance?.id ??
			this.deps.getCurrentIndex().maintenance?.id;
		if (!id) {
			throw new Error("Force operation ID is missing");
		}
		const canonicalPath = this.deps.getCanonicalPath();
		const oldResource = await this.deps.client.getResource(
			canonicalPath,
			1,
			0,
			true,
		);
		if (!initial) {
			const latest = await this.assertForceAuthority(
				id,
				desired.epoch,
				codec,
			);
			desired.revision = latest.revision + 1;
		}
		if (desired.maintenance?.kind === "force") {
			desired.maintenance.targetRevision = desired.revision;
		}
		validateCurrentIndexShape(
			desired as unknown as Record<string, unknown>,
		);
		validateCurrentIndexCausality(desired);
		const nonce = this.deps.createTransactionId();
		const oldPath = joinPath(
			this.deps.getRemotePath(),
			`${REMOTE_INDEX_LOCK_PREFIX}${id}.${nonce}.previous`,
		);
		const targetPath = joinPath(
			this.deps.getRemotePath(),
			`${REMOTE_INDEX_LOCK_PREFIX}${id}.${nonce}.target`,
		);
		const fingerprint = getStableContentFingerprint(oldResource);
		let displaced = false;
		const leaseIndex = desired.maintenance
			? desired
			: this.deps.getCurrentIndex();
		const lease = await this.maintainForceLease(
			leaseIndex,
			codec,
			async () => {
				const canonical = await this.deps.client.getResource(
					canonicalPath,
					1,
					0,
					true,
				);
				if (!displaced && !canonical && oldResource) {
					const moved = await this.deps.client.getResource(
						oldPath,
						1,
						0,
						true,
					);
					if (
						moved &&
						matchesStableContentFingerprint(fingerprint, moved)
					) {
						displaced = true;
					}
				}
				if (!displaced) {
					if (
						getStableContentFingerprint(canonical) !== fingerprint
					) {
						throw new Error(
							"Force canonical changed before lock acquisition",
						);
					}
				} else {
					const previous = await this.deps.client.getResource(
						oldPath,
						1,
						0,
						true,
					);
					if (
						canonical ||
						(oldResource &&
							(!previous ||
								!matchesStableContentFingerprint(
									fingerprint,
									previous,
								)))
					) {
						throw new Error("Force transaction was superseded");
					}
				}
			},
		);
		try {
			if (oldResource) {
				try {
					await this.deps.client.moveResourceExclusive(
						canonicalPath,
						oldPath,
					);
				} catch (error) {
					const [canonical, moved] = await Promise.all([
						this.deps.client.getResource(canonicalPath, 1, 0, true),
						this.deps.client.getResource(oldPath, 1, 0, true),
					]);
					if (
						canonical ||
						!moved ||
						!matchesStableContentFingerprint(fingerprint, moved)
					) {
						throw error;
					}
				}
				const moved = await this.deps.client.getResource(
					oldPath,
					1,
					0,
					true,
				);
				if (
					!moved ||
					!matchesStableContentFingerprint(fingerprint, moved)
				) {
					if (
						moved &&
						!(await this.deps.client.getResource(
							canonicalPath,
							1,
							0,
							true,
						))
					) {
						await this.deps.client.moveResourceExclusive(
							oldPath,
							canonicalPath,
						);
					}
					throw new Error("Force lock changed while being acquired");
				}
			}
			displaced = true;
			let published = false;
			try {
				const plain = new TextEncoder().encode(
					this.deps.serialize(desired),
				).buffer;
				const raw = codec ? await codec.encrypt(plain) : plain;
				const hash = await computeSha256(raw);
				let uploadError: unknown;
				try {
					await this.deps.client.uploadFile(
						targetPath,
						raw,
						false,
						true,
						false,
					);
				} catch (error) {
					uploadError = error;
				}
				const written =
					await this.deps.client.downloadStableRawFile(targetPath);
				if (!written || (await computeSha256(written.raw)) !== hash) {
					throw uploadError instanceof Error
						? uploadError
						: new Error("Force lock upload could not be verified");
				}
				await lease.stop();
				try {
					await this.deps.client.moveResourceExclusive(
						targetPath,
						canonicalPath,
						beforeCommit,
					);
				} catch (error) {
					const [canonical, lock] = await Promise.all([
						this.deps.client.getResource(canonicalPath, 1, 0, true),
						this.deps.client.getResource(targetPath, 1, 0, true),
					]);
					if (
						!canonical ||
						lock ||
						!matchesStableContentFingerprint(
							written.fingerprint,
							canonical,
						)
					) {
						throw error;
					}
				}
				const final =
					await this.deps.client.downloadStableRawFile(canonicalPath);
				if (!final || (await computeSha256(final.raw)) !== hash) {
					throw new Error(
						"Force canonical publication could not be verified",
					);
				}
				published = true;
				this.deps.acceptPublishedIndex(desired);
				// Only this exact displaced version is owned by this transaction.
				if (oldResource) {
					await this.deps.client.deleteResource(
						oldPath,
						true,
						true,
						async () => {
							const resource = await this.deps.client.getResource(
								oldPath,
								1,
								0,
								true,
							);
							if (
								resource &&
								!matchesStableContentFingerprint(
									fingerprint,
									resource,
								)
							) {
								throw new Error("Force displaced lock changed");
							}
						},
					);
				}
				return {
					epoch: desired.epoch,
					revision: desired.revision,
					canonicalSha256: hash,
				};
			} catch (error) {
				// Never overwrite a canonical created by another operation during an ambiguous reply.
				if (
					!published &&
					oldResource &&
					!(await this.deps.client.getResource(
						canonicalPath,
						1,
						0,
						true,
					))
				) {
					const old = await this.deps.client.getResource(
						oldPath,
						1,
						0,
						true,
					);
					if (
						old &&
						matchesStableContentFingerprint(fingerprint, old)
					) {
						await this.deps.client.moveResourceExclusive(
							oldPath,
							canonicalPath,
						);
					}
				}
				throw error;
			}
		} finally {
			await lease.cleanup();
		}
	}

	/** Renew a scoped Force lease while a canonical transaction waits on remote I/O. */
	private async maintainForceLease(
		index: Readonly<SyncIndex>,
		codec: EncryptionCodec | null,
		assertOwner: () => Promise<void>,
	): Promise<{ stop(): Promise<void>; cleanup(): Promise<void> }> {
		const id = index.maintenance?.id;
		if (!id) {
			throw new Error("Force lease requires maintenance authority");
		}
		const path = joinPath(
			this.deps.getRemotePath(),
			`${REMOTE_INDEX_LOCK_PREFIX}${id}.${this.deps.createTransactionId()}.lease`,
		);
		let fingerprint: string | null = null;
		let failure: unknown;
		let active = true;
		let running: Promise<void> | null = null;
		const renew = async () => {
			await this.deps.assertRemoteScope();
			await assertOwner();
			const current = await this.deps.client.getResource(
				path,
				1,
				0,
				true,
			);
			if (
				current &&
				(!fingerprint ||
					!matchesStableContentFingerprint(fingerprint, current))
			) {
				throw new Error("Force lease ownership changed");
			}
			const lease = cloneIndex(index);
			lease.lastSyncTime = Date.now();
			const plain = new TextEncoder().encode(
				this.deps.serialize(lease),
			).buffer;
			const raw = codec ? await codec.encrypt(plain) : plain;
			const hash = await computeSha256(raw);
			let writeError: unknown;
			try {
				await this.deps.client.uploadFile(
					path,
					raw,
					false,
					true,
					fingerprint !== null,
					async () => {
						await assertOwner();
					},
				);
			} catch (error) {
				writeError = error;
			}
			const observed = await this.deps.client.downloadStableRawFile(path);
			if (!observed || (await computeSha256(observed.raw)) !== hash) {
				throw writeError instanceof Error
					? writeError
					: new Error("Force lease renewal was not verified");
			}
			fingerprint = observed.fingerprint;
		};
		await renew();
		const timer = setInterval(() => {
			if (!active || running) {
				return;
			}
			running = renew()
				.catch((error) => {
					failure = error;
					active = false;
					clearInterval(timer);
				})
				.finally(() => {
					running = null;
				});
		}, 30_000);
		const stop = async () => {
			active = false;
			clearInterval(timer);
			await running;
			if (failure) {
				throw failure instanceof Error
					? failure
					: new Error("Force lease renewal failed");
			}
		};
		return {
			stop,
			cleanup: async () => {
				active = false;
				clearInterval(timer);
				await running;
				await this.deps.client.deleteResource(
					path,
					true,
					true,
					async () => {
						const current = await this.deps.client.getResource(
							path,
							1,
							0,
							true,
						);
						if (
							current &&
							!matchesStableContentFingerprint(
								fingerprint,
								current,
							)
						) {
							throw new Error(
								"Force lease cleanup proof changed",
							);
						}
					},
				);
				if (await this.deps.client.getResource(path, 1, 0, true)) {
					throw new Error("Force lease cleanup remains pending");
				}
			},
		};
	}

	/** Resolve own staged publications after restart, without reading displaced destination bytes. */
	async recoverForcePublication(
		state: import("../workflows/force-state").ForceRecovery,
		codec: EncryptionCodec | null,
		beforeCommit?: () => Promise<void>,
	): Promise<SyncIndex | null> {
		const path = this.deps.getCanonicalPath();
		let resource = await this.deps.client.getResource(path, 1, 0, true);
		if (!resource && state.completion) {
			throw new ForceRecoveryPendingError(
				"Completed Force canonical is unavailable; refusing stale promotion",
			);
		}
		const listing = await this.deps.getStableRootListing();
		const ownedPrefix = `${REMOTE_INDEX_LOCK_PREFIX}${state.id}.`;
		if (!resource) {
			if (
				listing.resources.some(
					(item) =>
						isRootIndexLockPath(item.name) &&
						!item.name.startsWith(ownedPrefix) &&
						!state.serviceCleanup.some(
							(proof) => proof.path === item.name,
						),
				)
			) {
				throw new Error("Force recovery has a competing transaction");
			}
			const candidates: { path: string; index: SyncIndex }[] = [];
			for (const lock of listing.resources.filter(
				(item) =>
					item.name.startsWith(ownedPrefix) &&
					item.name.endsWith(".target"),
			)) {
				const lockPath = joinPath(state.remotePath, lock.name);
				const snapshot = await this.deps.readSnapshot(
					lockPath,
					false,
					codec,
				);
				if (
					snapshot.index.epoch === state.epoch &&
					(snapshot.index.maintenance?.id === state.id ||
						!snapshot.index.maintenance)
				) {
					candidates.push({ path: lockPath, index: snapshot.index });
				}
			}
			candidates.sort(
				(left, right) => right.index.revision - left.index.revision,
			);
			if (candidates[0]) {
				if (!beforeCommit) {
					throw new ForceRecoveryPendingError(
						"Staged Force publication requires source validation",
					);
				}
				await this.deps.client.moveResourceExclusive(
					candidates[0].path,
					path,
					beforeCommit,
				);
				resource = await this.deps.client.getResource(path, 1, 0, true);
			}
		}
		if (!resource && state.phase === "prepared") {
			const displaced = listing.resources.find(
				(item) =>
					item.name.startsWith(ownedPrefix) &&
					item.name.endsWith(".previous") &&
					matchesStableContentFingerprint(
						state.originalCanonicalFingerprint,
						item,
					),
			);
			if (displaced) {
				if (!beforeCommit) {
					throw new ForceRecoveryPendingError(
						"Force rollback requires source validation",
					);
				}
				await this.deps.client.moveResourceExclusive(
					joinPath(state.remotePath, displaced.name),
					path,
					beforeCommit,
				);
				resource = await this.deps.client.getResource(path, 1, 0, true);
			}
		}
		if (
			state.phase === "prepared" &&
			getStableContentFingerprint(resource) ===
				state.originalCanonicalFingerprint
		) {
			return null;
		}
		if (!resource) {
			throw new Error(
				"Force recovery cannot resolve its missing canonical",
			);
		}
		const snapshot = await this.deps.readSnapshot(
			path,
			false,
			codec,
			undefined,
			resource,
		);
		if (state.completion) {
			const receipt = state.completion;
			if (snapshot.index.epoch !== receipt.epoch) {
				throw new ForceRecoveryPendingError(
					"Completed Force was superseded by another epoch; explicitly confirm a new operation",
				);
			}
			if (
				snapshot.index.revision < receipt.revision ||
				(snapshot.index.revision === receipt.revision &&
					(await computeSha256(snapshot.raw)) !==
						receipt.canonicalSha256)
			) {
				throw new ForceRecoveryPendingError(
					"Force completion receipt does not match canonical",
				);
			}
			if (snapshot.index.maintenance) {
				throw new ForceRecoveryPendingError(
					"A successor maintenance must finish before local Force recovery",
				);
			}
			this.deps.acceptPublishedIndex(snapshot.index);
			return snapshot.index;
		}
		if (
			snapshot.index.epoch !== state.epoch ||
			(snapshot.index.maintenance &&
				(snapshot.index.maintenance.kind !== "force" ||
					snapshot.index.maintenance.id !== state.id))
		) {
			throw new Error("Force recovery was superseded");
		}
		if (
			!snapshot.index.maintenance &&
			(!sameIndexValue(snapshot.index.files, state.files) ||
				Object.keys(snapshot.index.moves).length ||
				Object.keys(snapshot.index.folderTombstones).length ||
				Object.keys(snapshot.index.appliedMutationSeq).length ||
				snapshot.index.deviceId !== this.deps.getDeviceId())
		) {
			throw new ForceRecoveryPendingError(
				"Completed Force canonical changed before recovery",
			);
		}

		if (!snapshot.index.maintenance) {
			state.completion = {
				epoch: snapshot.index.epoch,
				revision: snapshot.index.revision,
				canonicalSha256: await computeSha256(snapshot.raw),
			};
		}

		this.deps.acceptPublishedIndex(snapshot.index);
		return snapshot.index;
	}

	/** Clear only pinned service leftovers after the new operation has published authority. */
	async cleanupForceServiceLocks(
		state: import("../workflows/force-state").ForceRecovery,
		codec: EncryptionCodec | null,
		completed = false,
	): Promise<void> {
		const authority = async () => {
			if (completed) {
				const index = await this.recoverForcePublication(state, codec);
				if (!index || index.maintenance) {
					throw new Error(
						"Force service cleanup lost completed authority",
					);
				}
			} else {
				await this.assertForceAuthority(state.id, state.epoch, codec);
			}
		};
		await authority();
		const listing = await this.deps.getStableRootListing();
		const proofs = new Map(
			state.serviceCleanup.map((action) => [
				action.path,
				action.expectedFingerprint,
			]),
		);
		for (const item of listing.resources) {
			if (proofs.has(item.name) && item.name.endsWith(".lease")) {
				proofs.set(item.name, getStableContentFingerprint(item)!);
			}
			if (
				item.name.startsWith(`${REMOTE_INDEX_LOCK_PREFIX}${state.id}.`)
			) {
				proofs.set(item.name, getStableContentFingerprint(item)!);
			}
		}
		for (const [name, fingerprint] of proofs) {
			if (!isRootIndexLockPath(name) || !fingerprint) {
				throw new Error("Force service cleanup proof is invalid");
			}
			const path = joinPath(state.remotePath, name);
			await this.deps.client.deleteResource(
				path,
				true,
				true,
				async () => {
					await authority();
					const resource = await this.deps.client.getResource(
						path,
						1,
						0,
						true,
					);
					if (
						resource &&
						!matchesStableContentFingerprint(fingerprint, resource)
					) {
						throw new Error("Force service lock changed");
					}
				},
			);
			if (await this.deps.client.getResource(path, 1, 0, true)) {
				throw new Error("Force service cleanup remains pending");
			}
		}
	}
}

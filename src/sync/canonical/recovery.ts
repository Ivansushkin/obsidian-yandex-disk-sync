import {
	getStableContentFingerprint,
	matchesStableContentFingerprint,
	isHashStableContentFingerprint,
} from "../../utils/resource-fingerprint";
import type { SyncIndex, YandexResource } from "../../types";
import type { YandexDiskClient } from "../../api/yandex-client";
import type { EncryptionCodec } from "../../crypto/encryption";
import {
	joinPath,
	normalizePath,
	isRootIndexLockPath,
	REMOTE_INDEX_LOCK_PREFIX,
} from "../../utils/path-utils";
import { logger, shortenDiagnosticValue } from "../../utils/logger";
import { computeSha256FromString } from "../../utils/hash-utils";
import {
	cloneIndex,
	stableSerialize,
	sameIndexValue,
} from "./transaction-rules";

import { createEmptyIndex } from "../../types";
import { isJsonRecord } from "../../utils/record-utils";
import { decideRecovery, OperationFailure } from "../../errors";
import { isStableLockStale } from "./mutation-rules";
import {
	collectStablePaginatedItems,
	UnstablePaginationError,
	isOrphanIndexAmbiguous,
} from "./transaction-rules";
import {
	classifyIndexMoveRecovery,
	rawBuffersEqual,
	rollbackRawIndexSnapshot,
	type CanonicalCommitProof,
	type IndexCodec,
	type IndexFileSnapshot,
	type IndexLockObservation,
	type IndexTransactionOutcome,
	type CanonicalMoveResolution,
	type IndexSnapshotReader,
	type IndexSnapshotDecoder,
} from "./transaction";
import {
	RemoteIndexConcurrentModificationError,
	AmbiguousRemoteIndexStateError,
	AmbiguousRemoteIndexLockError,
	RemoteIndexLockedError,
	InvalidCurrentIndexError,
	UnreadableRemoteIndexError,
} from "./errors";

export const REMOTE_INDEX_FILENAME = ".obsidian-sync-index.json";
const INDEX_LOCK_STALE_MS = 2 * 60 * 1000;
export const INDEX_LOCK_RETRY_MS = 750;
export const INDEX_LOCK_ATTEMPTS =
	Math.ceil(INDEX_LOCK_STALE_MS / INDEX_LOCK_RETRY_MS) + 10;

export interface StableRootListing {
	resources: YandexResource[];
	root: YandexResource | null;
	rootExists: boolean;
}

export interface CanonicalRecoveryDependencies {
	client: Pick<
		YandexDiskClient,
		| "getResource"
		| "downloadStableRawFile"
		| "decodeServiceFileContent"
		| "moveResourceExclusive"
		| "uploadFileExclusive"
		| "deleteResource"
		| "downloadFile"
		| "uploadFile"
	>;
	getRemotePath(): string;
	getCanonicalPath(): string;
	getDeviceId(): string;
	getReadOptions(): {
		allowLegacy: boolean;
		source: EncryptionCodec | null | undefined;
		target: EncryptionCodec | null | undefined;
	};
	isReplacing(): boolean;
	readSnapshot: IndexSnapshotReader;
	decodeSnapshot: IndexSnapshotDecoder;
	serialize(index: SyncIndex): string;
	isLockContention(error: unknown): boolean;
}

/** Resolve canonical discovery, lock recovery and commit evidence without owning causal state. */
export class CanonicalRecovery {
	private observedLocks = new Map<
		string,
		{ fingerprint: string; firstSeenAt: number }
	>();
	constructor(private readonly deps: CanonicalRecoveryDependencies) {}

	/** Wait for the canonical name while preserving legacy discovery admission. */
	async waitForCanonicalIndex(): Promise<string | null> {
		const canonicalPath = this.deps.getCanonicalPath();
		for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
			const canonical = await this.deps.client.getResource(
				canonicalPath,
				1000,
				0,
				true,
			);
			if (canonical) {
				if (!this.deps.isReplacing()) {
					await this.cleanupStaleOrphanLocks();
				}
				return canonicalPath;
			}

			const locks = await this.getIndexLocks();
			if (locks.length === 0) {
				return null;
			}
			if (this.deps.isReplacing()) {
				return null;
			}
			if (locks.length > 1) {
				throw new AmbiguousRemoteIndexLockError(
					"Multiple remote index locks require an explicit force sync",
				);
			}

			if (attempt === 0) {
				logger.info("Waiting for canonical index lock", {
					lockCount: locks.length,
					stableLeaseMs: INDEX_LOCK_STALE_MS,
				});
			}
			await this.recoverStaleLock(locks);
			await waitForIndexRetry(INDEX_LOCK_RETRY_MS);
		}
		throw new RemoteIndexLockedError(
			"Remote index is locked by another device",
		);
	}

	/** Discover canonical and locks through two matching fully paginated listings. */
	async waitForCanonicalIndexFromStableRoot(
		assertCurrent: () => void = () => {},
		validate: (
			listing: StableRootListing,
		) => Promise<void> = async () => {},
	): Promise<{
		path: string | null;
		resource?: YandexResource;
		rootExists: boolean;
		locks: YandexResource[];
	}> {
		const canonicalPath = this.deps.getCanonicalPath();
		for (let attempt = 0; attempt < INDEX_LOCK_ATTEMPTS; attempt++) {
			const listing = await this.getStableRootListing(assertCurrent);
			await validate(listing);
			assertCurrent();
			const { resources, rootExists } = listing;
			const canonical = resources.find(
				(resource) =>
					resource.type === "file" &&
					resource.name === REMOTE_INDEX_FILENAME,
			);
			const locks = this.selectIndexLocks(resources);
			if (canonical) {
				if (!this.deps.isReplacing()) {
					await this.cleanupStaleOrphanLocks(locks);
				}
				return {
					path: canonicalPath,
					resource: canonical,
					rootExists,
					locks,
				};
			}
			if (locks.length === 0 || this.deps.isReplacing()) {
				return { path: null, rootExists, locks };
			}
			if (locks.length > 1) {
				throw new AmbiguousRemoteIndexLockError(
					"Multiple remote index locks require an explicit force sync",
				);
			}
			if (attempt === 0) {
				logger.info("Waiting for canonical index lock", {
					lockCount: locks.length,
					stableLeaseMs: INDEX_LOCK_STALE_MS,
				});
			}
			await this.recoverStaleLock(locks);
			await waitForIndexRetry(INDEX_LOCK_RETRY_MS);
		}
		throw new RemoteIndexLockedError(
			"Remote index is locked by another device",
		);
	}

	async ensureCanonicalIndex(): Promise<SyncIndex | null> {
		const existing = await this.waitForCanonicalIndex();
		if (existing) {
			return null;
		}

		return await this.initializeCanonicalIndex();
	}

	/** Create a valid exclusive seed without adopting it into desired/local state. */
	async initializeCanonicalIndex(): Promise<SyncIndex | null> {
		const initial = createEmptyIndex(this.deps.getDeviceId());
		const content = this.deps.serialize(initial);
		try {
			await this.deps.client.uploadFileExclusive(
				this.deps.getCanonicalPath(),
				content,
				false,
				false,
			);
			return initial;
		} catch (e) {
			if (this.deps.isLockContention(e)) {
				return null;
			}
			const recovery = decideRecovery(
				new OperationFailure(e, {
					stage: "canonical-initialize",
					action: "put",
				}),
				{ attemptsRemaining: 0, remainingMs: Infinity },
			);
			if (recovery.confirm) {
				const resource = await this.deps.client.getResource(
					this.deps.getCanonicalPath(),
					1,
					0,
					true,
				);
				if (resource) {
					const snapshot = await this.deps.readSnapshot(
						this.deps.getCanonicalPath(),
						false,
						undefined,
						undefined,
						resource,
					);
					return sameIndexValue(snapshot.index, initial)
						? initial
						: null;
				}
			}
			throw e;
		}
	}

	async getIndexLocks(): Promise<YandexResource[]> {
		return this.selectIndexLocks(
			(await this.getStableRootListing()).resources,
		);
	}

	/** Read a stable root observation without caching it across operations. */
	async getStableRootListing(
		assertCurrent: () => void = () => {},
	): Promise<StableRootListing> {
		let root: YandexResource | null = null;
		let identity: string | undefined;
		let total = 0;
		const paths = new Set<string>();
		const remotePath = normalizePath(
			this.deps.getRemotePath().replace(/^disk:\//, ""),
		);
		const resources = await collectStablePaginatedItems(
			async (limit, offset) => {
				assertCurrent();
				const pageRoot = await this.deps.client.getResource(
					this.deps.getRemotePath(),
					limit,
					offset,
					true,
				);
				assertCurrent();
				if (
					pageRoot &&
					(pageRoot.type !== "dir" ||
						!pageRoot.resource_id ||
						typeof pageRoot.path !== "string" ||
						normalizePath(pageRoot.path.replace(/^disk:\//, "")) !==
							remotePath)
				) {
					throw new UnstablePaginationError(
						"Remote root identity is unavailable",
					);
				}
				const pageIdentity = pageRoot
					? `${pageRoot.path}:${pageRoot.resource_id}`
					: "missing";
				if (identity !== undefined && identity !== pageIdentity) {
					throw new UnstablePaginationError(
						"Remote root changed during observation",
					);
				}
				identity = pageIdentity;
				root = pageRoot;
				if (!pageRoot) {
					return { items: [], total: 0 };
				}
				const embedded = pageRoot._embedded;
				if (
					!embedded ||
					!Array.isArray(embedded.items) ||
					!Number.isSafeInteger(embedded.total) ||
					embedded.total < 0
				) {
					throw new UnstablePaginationError(
						"Remote root listing is incomplete",
					);
				}
				if (offset === 0) {
					total = embedded.total;
					paths.clear();
				}
				if (
					embedded.total !== total ||
					embedded.items.length > limit ||
					offset + embedded.items.length > total ||
					(offset < total && embedded.items.length === 0)
				) {
					throw new UnstablePaginationError(
						"Remote root pagination is incomplete",
					);
				}
				for (const resource of embedded.items) {
					if (
						!resource ||
						!resource.name ||
						!resource.path ||
						normalizePath(resource.path.replace(/^disk:\//, "")) !==
							joinPath(remotePath, resource.name) ||
						!["file", "dir"].includes(resource.type)
					) {
						throw new UnstablePaginationError(
							"Remote root item identity is unavailable",
						);
					}
					if (paths.has(resource.path)) {
						throw new UnstablePaginationError(
							"Remote root listing contains duplicate items",
						);
					}
					paths.add(resource.path);
					const service =
						resource.name === REMOTE_INDEX_FILENAME ||
						resource.name === ".obsidian-encrypt.json" ||
						isRootIndexLockPath(resource.name);
					if (
						service &&
						(resource.type !== "file" ||
							!getStableContentFingerprint(resource))
					) {
						throw new UnstablePaginationError(
							"Remote service identity is unavailable",
						);
					}
				}
				return { items: embedded.items, total };
			},
			(resource) => resource.path,
			(resource) =>
				[
					resource.type,
					resource.name,
					resource.resource_id || "",
					getStableContentFingerprint(resource) || "",
				].join(":"),
			4,
			() => identity ?? "unknown",
		);
		if (resources.length !== total) {
			throw new UnstablePaginationError(
				"Remote root listing contains duplicate or missing items",
			);
		}
		return { resources, root, rootExists: root !== null };
	}

	selectIndexLocks(resources: YandexResource[]): YandexResource[] {
		return resources.filter(
			(resource) =>
				resource.type === "file" && isRootIndexLockPath(resource.name),
		);
	}

	/** Use service content identity, never resource_id, to pin the observed locks. */
	observeIndexLocks(resources: YandexResource[]): IndexLockObservation[] {
		return this.selectIndexLocks(resources)
			.map((resource) => {
				const fingerprint = getStableContentFingerprint(resource);
				if (!fingerprint) {
					throw new AmbiguousRemoteIndexLockError(
						"Index lock has no stable content identity",
					);
				}
				return { name: resource.name, fingerprint };
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Observe one lock lease using content identity that changes on overwrite.
	 */
	private isObservedLockStale(resource: YandexResource): boolean {
		const fingerprint = getStableContentFingerprint(resource);
		if (!fingerprint) {
			throw new AmbiguousRemoteIndexLockError(
				"Index lock has no stable content identity",
			);
		}
		const now = Date.now();
		const observed = this.observedLocks.get(resource.name);
		if (!observed || observed.fingerprint !== fingerprint) {
			this.observedLocks.set(resource.name, {
				fingerprint,
				firstSeenAt: now,
			});
			return false;
		}
		return isStableLockStale(
			observed.firstSeenAt,
			now,
			INDEX_LOCK_STALE_MS,
		);
	}

	/** Restore a stale snapshot through a unique claim before publishing canonical. */
	async recoverStaleLock(knownLocks?: YandexResource[]): Promise<void> {
		const locks = knownLocks ?? (await this.getIndexLocks());
		if (locks.length > 1) {
			throw new AmbiguousRemoteIndexLockError(
				"Multiple remote index locks require an explicit force sync",
			);
		}
		const resource = locks[0];
		if (!resource || !this.isObservedLockStale(resource)) {
			return;
		}
		const lockPath = joinPath(this.deps.getRemotePath(), resource.name);
		const raw = await this.assertStaleLockReadable(lockPath, resource);
		if (!raw) {
			return;
		}
		const original = this.observeIndexLocks([resource])[0]!;
		const claimName = `${REMOTE_INDEX_LOCK_PREFIX}recovery.${crypto.randomUUID()}`;
		const claimPath = joinPath(this.deps.getRemotePath(), claimName);
		let claimError: unknown;
		try {
			await this.moveObservedIndexLock(original, claimPath, true);
		} catch (error) {
			claimError = error;
		}
		const claimedRoot = await this.getStableRootListing();
		const claimResource = claimedRoot.resources.find(
			(item) => item.name === claimName,
		);
		if (!claimResource) {
			if (
				claimError instanceof RemoteIndexLockedError ||
				this.deps.isLockContention(claimError)
			) {
				return;
			}
			if (claimError instanceof Error) {
				throw claimError;
			}
			throw new AmbiguousRemoteIndexStateError(
				"Stale index claim could not be verified",
				"move-attempted",
				claimError,
			);
		}
		const claimed = await this.deps.client.downloadStableRawFile(
			claimPath,
			claimResource,
		);
		if (!claimed) {
			throw new AmbiguousRemoteIndexLockError(
				"Stale index claim disappeared while being read",
			);
		}
		const claim = { name: claimName, fingerprint: claimed.fingerprint };
		if (!rawBuffersEqual(raw, claimed.raw)) {
			// Renewal during the claim must never become canonical. Restore without replacing a successor.
			let restoreError: unknown;
			try {
				await this.moveObservedIndexLock(claim, lockPath);
			} catch (error) {
				restoreError = error;
			}
			if (
				!(await this.isOnlyRawIndexResource(resource.name, claimed.raw))
			) {
				throw new AmbiguousRemoteIndexStateError(
					"Renewed index lock remains in recovery claim",
					"move-attempted",
					restoreError,
				);
			}
			this.observedLocks.delete(resource.name);
			const restored = await this.deps.client.getResource(
				lockPath,
				1,
				0,
				true,
			);
			if (restored) {
				this.isObservedLockStale(restored);
			}
			return;
		}
		let moveError: unknown;
		try {
			await this.moveObservedIndexLock(
				claim,
				this.deps.getCanonicalPath(),
			);
		} catch (error) {
			moveError = error;
		}
		if (!(await this.isOnlyRawIndexResource(REMOTE_INDEX_FILENAME, raw))) {
			throw new AmbiguousRemoteIndexStateError(
				"Stale index lock publication could not be verified",
				"move-attempted",
				moveError,
			);
		}
		this.observedLocks.delete(resource.name);
		logger.warn(`Recovered stale index lock: ${resource.name}`);
	}

	/** Revalidate the sole pinned source and absent canonical before each exclusive move attempt. */
	private async moveObservedIndexLock(
		lock: IndexLockObservation,
		toPath: string,
		requireStale = false,
	): Promise<void> {
		await this.deps.client.moveResourceExclusive(
			joinPath(this.deps.getRemotePath(), lock.name),
			toPath,
			async () => {
				const { resources } = await this.getStableRootListing();
				const locks = this.selectIndexLocks(resources);
				if (locks.length > 1) {
					throw new AmbiguousRemoteIndexLockError(
						"Multiple remote index locks prevent stale recovery",
					);
				}
				const current = locks.find((item) => item.name === lock.name);
				if (!current) {
					this.observedLocks.delete(lock.name);
				}
				const stale =
					!requireStale ||
					(current && this.isObservedLockStale(current));
				if (
					!stale ||
					!matchesStableContentFingerprint(
						lock.fingerprint,
						current ?? null,
					) ||
					resources.some(
						(item) => item.name === REMOTE_INDEX_FILENAME,
					)
				) {
					throw new RemoteIndexLockedError(
						"Index lock observation changed before stale recovery",
					);
				}
			},
		);
	}

	/** Confirm exact raw publication or restoration without selecting another codec or overwriting bytes. */
	private async isOnlyRawIndexResource(
		name: string,
		raw: ArrayBuffer,
	): Promise<boolean> {
		const observe = async () => {
			const { resources } = await this.getStableRootListing();
			const services = resources.filter(
				(item) =>
					item.name === REMOTE_INDEX_FILENAME ||
					isRootIndexLockPath(item.name),
			);
			const current = services[0];
			return services.length === 1 &&
				current?.type === "file" &&
				current.name === name
				? current
				: null;
		};
		const current = await observe();
		if (!current) {
			return false;
		}
		const snapshot = await this.deps.client.downloadStableRawFile(
			joinPath(this.deps.getRemotePath(), name),
			current,
		);
		return (
			!!snapshot &&
			rawBuffersEqual(raw, snapshot.raw) &&
			matchesStableContentFingerprint(
				snapshot.fingerprint,
				await observe(),
			)
		);
	}

	/** Decode the pinned raw observation once; renewal starts a new lease instead of recovery. */
	private async assertStaleLockReadable(
		lockPath: string,
		expected: YandexResource,
	): Promise<ArrayBuffer | null> {
		const snapshot = await this.deps.client.downloadStableRawFile(lockPath);
		if (!snapshot) {
			throw new AmbiguousRemoteIndexLockError(
				"Stale index lock disappeared while being read",
			);
		}
		if (
			!matchesStableContentFingerprint(
				getStableContentFingerprint(expected),
				snapshot.resource,
			)
		) {
			this.isObservedLockStale(snapshot.resource);
			return null;
		}
		const candidates: Array<{
			service: EncryptionCodec | null | undefined;
			codec: IndexCodec;
		}> = [
			{
				service: this.deps.getReadOptions().source,
				codec: "source",
			},
			{
				service: this.deps.getReadOptions().target,
				codec: "target",
			},
			{ service: undefined, codec: "current" },
		];
		for (const candidate of candidates) {
			try {
				await this.deps.decodeSnapshot(
					snapshot.raw,
					true,
					candidate.service,
					candidate.codec,
					snapshot.fingerprint,
				);
				return snapshot.raw;
			} catch (error) {
				if (!(error instanceof UnreadableRemoteIndexError)) {
					throw error;
				}
			}
		}
		throw new AmbiguousRemoteIndexLockError(
			"Stale index lock is unreadable and cannot be published automatically",
		);
	}

	/** Remove only stale orphan snapshots proven compatible with the live canonical. */
	private async cleanupStaleOrphanLocks(
		knownLocks?: YandexResource[],
	): Promise<void> {
		const locks = knownLocks ?? (await this.getIndexLocks());
		const staleLocks = locks.filter((resource) =>
			this.isObservedLockStale(resource),
		);
		if (locks.length > 1 && staleLocks.length !== locks.length) {
			throw new AmbiguousRemoteIndexLockError(
				"Multiple orphan index locks require an explicit force sync",
			);
		}
		if (staleLocks.length === 0) {
			return;
		}
		const canonical = (
			await this.deps.readSnapshot(this.deps.getCanonicalPath(), false)
		).index;
		const obsolete: IndexLockObservation[] = [];
		for (const resource of staleLocks) {
			const snapshot = await this.deps.client.downloadStableRawFile(
				joinPath(this.deps.getRemotePath(), resource.name),
				resource,
			);
			if (!snapshot) {
				throw new AmbiguousRemoteIndexLockError(
					"Orphan lock disappeared during recovery",
				);
			}
			try {
				const orphan = await this.deps.decodeSnapshot(
					snapshot.raw,
					false,
				);
				if (
					locks.length > 1 ||
					isOrphanIndexAmbiguous(canonical, orphan.index)
				) {
					throw new AmbiguousRemoteIndexLockError(
						"An orphan lock conflicts with the canonical index",
					);
				}
			} catch (error) {
				if (
					!(error instanceof InvalidCurrentIndexError) ||
					canonical.revision === 0 ||
					canonical.maintenance
				) {
					throw error;
				}
				// Old bootstrap wrote exactly this empty shape; it contains no causal state.
				const data: unknown = JSON.parse(
					new TextDecoder().decode(
						await this.deps.client.decodeServiceFileContent(
							snapshot.raw,
						),
					),
				);
				if (
					!isJsonRecord(data) ||
					typeof data.epoch !== "string" ||
					!data.epoch ||
					!sameIndexValue(data, createEmptyIndex("", data.epoch))
				) {
					throw error;
				}
			}
			obsolete.push({
				name: resource.name,
				fingerprint: snapshot.fingerprint,
			});
		}
		for (const lock of obsolete) {
			await this.deleteObservedIndexLock(lock, canonical);
			this.observedLocks.delete(lock.name);
			logger.warn(`Removed stale orphan index lock: ${lock.name}`);
		}
	}

	/** Revalidate canonical authority and exact lock content before every delete retry. */
	/** Revalidate canonical authority and pinned lock content before each deletion attempt. */
	async deleteObservedIndexLock(
		lock: IndexLockObservation,
		expectedCanonical: SyncIndex,
	): Promise<void> {
		const path = joinPath(this.deps.getRemotePath(), lock.name);
		await this.deps.client.deleteResource(path, false, true, async () => {
			const canonical = (
				await this.deps.readSnapshot(
					this.deps.getCanonicalPath(),
					false,
				)
			).index;
			if (!sameIndexValue(canonical, expectedCanonical)) {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical changed before orphan lock cleanup",
					"committed",
					false,
				);
			}
			const current = await this.deps.client.getResource(
				path,
				1,
				0,
				true,
			);
			if (
				current &&
				!matchesStableContentFingerprint(lock.fingerprint, current)
			) {
				throw new AmbiguousRemoteIndexLockError(
					"Index lock changed before cleanup",
				);
			}
		});
	}

	async wasLockAcquiredDespiteError(
		lockPath: string,
		canonicalPath: string,
	): Promise<boolean> {
		try {
			const [lock, canonical] = await Promise.all([
				this.deps.client.getResource(lockPath, 1, 0, true),
				this.deps.client.getResource(canonicalPath, 1, 0, true),
			]);
			return lock !== null && canonical === null;
		} catch {
			return false;
		}
	}

	private async inspectExpectedIndex(
		path: string,
		expected: SyncIndex,
		serviceOverride?: EncryptionCodec | null,
		codecLabel?: IndexCodec,
		expectedResource?: YandexResource,
	): Promise<{
		exists: boolean;
		readable: boolean;
		matches: boolean;
		snapshot: IndexFileSnapshot | null;
	}> {
		const resource =
			expectedResource ??
			(await this.deps.client.getResource(path, 1, 0, true));
		if (!resource) {
			return {
				exists: false,
				readable: false,
				matches: false,
				snapshot: null,
			};
		}
		try {
			const snapshot = await this.deps.readSnapshot(
				path,
				this.deps.getReadOptions().allowLegacy,
				serviceOverride,
				codecLabel,
				resource,
			);
			return {
				exists: true,
				readable: true,
				matches: sameIndexValue(snapshot.index, expected),
				snapshot,
			};
		} catch {
			return {
				exists: true,
				readable: false,
				matches: false,
				snapshot: null,
			};
		}
	}

	/** Resolve a lost final move response and retain its proof within this resolution. */
	async recoverAmbiguousFinalMove(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<CanonicalMoveResolution> {
		const [canonical, lock] = await Promise.all([
			this.inspectExpectedIndex(
				canonicalPath,
				expected,
				this.deps.getReadOptions().target,
				"target",
			),
			this.inspectExpectedIndex(
				lockPath,
				expected,
				this.deps.getReadOptions().target,
				"target",
			),
		]);
		let decision = classifyIndexMoveRecovery({
			canonicalExists: canonical.exists,
			lockExists: lock.exists,
			canonicalReadable: canonical.readable,
			lockReadable: lock.readable,
			canonicalMatchesExpected: canonical.matches,
			lockMatchesExpected: lock.matches,
		});
		if (
			decision === "committed" &&
			isHashStableContentFingerprint(expectedFingerprint) &&
			canonical.snapshot?.fingerprint !== expectedFingerprint
		) {
			decision = "ambiguous";
		}
		if (decision === "retry-move") {
			try {
				await this.deps.client.moveResourceExclusive(
					lockPath,
					canonicalPath,
				);
			} catch {
				// The read-back below is authoritative for an ambiguous API reply.
			}
			try {
				const proof = await this.verifyCanonicalCommit(
					lockPath,
					canonicalPath,
					expected,
					expectedFingerprint,
				);
				return { outcome: "committed", proof };
			} catch (error) {
				if (error instanceof RemoteIndexConcurrentModificationError) {
					return { outcome: "concurrent" };
				}
				return { outcome: "ambiguous" };
			}
		}
		if (decision === "committed") {
			return canonical.snapshot?.fingerprint
				? {
						outcome: "committed",
						proof: this.createCanonicalCommitProof(
							expected,
							canonical.snapshot.fingerprint,
						),
					}
				: { outcome: "ambiguous" };
		}
		return { outcome: decision };
	}

	/** Prove the final canonical by hash or stable semantic read without changing local state. */
	async verifyCanonicalCommit(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<CanonicalCommitProof> {
		const [canonicalResource, lock] = await Promise.all([
			this.deps.client.getResource(canonicalPath, 1, 0, true),
			this.deps.client.getResource(lockPath, 1, 0, true),
		]);
		if (
			canonicalResource &&
			!lock &&
			isHashStableContentFingerprint(expectedFingerprint) &&
			matchesStableContentFingerprint(
				expectedFingerprint,
				canonicalResource,
			)
		) {
			logger.debug("Canonical commit verified from content hash", {
				commitVerification: "hash-fast",
				canonicalRevision: expected.revision,
				canonicalFingerprint:
					shortenDiagnosticValue(expectedFingerprint),
			});
			return this.createCanonicalCommitProof(
				expected,
				expectedFingerprint,
			);
		}

		const canonical = canonicalResource
			? await this.inspectExpectedIndex(
					canonicalPath,
					expected,
					this.deps.getReadOptions().target,
					"target",
					canonicalResource,
				)
			: {
					exists: false,
					readable: false,
					matches: false,
					snapshot: null,
				};
		if (
			canonical.exists &&
			canonical.readable &&
			canonical.matches &&
			!lock &&
			(!isHashStableContentFingerprint(expectedFingerprint) ||
				canonical.snapshot?.fingerprint === expectedFingerprint) &&
			canonical.snapshot?.fingerprint
		) {
			logger.debug("Canonical commit verified semantically", {
				commitVerification: "semantic-fallback",
				canonicalRevision: expected.revision,
				canonicalFingerprint: shortenDiagnosticValue(
					canonical.snapshot.fingerprint,
				),
			});
			return this.createCanonicalCommitProof(
				expected,
				canonical.snapshot.fingerprint,
			);
		}
		if (
			canonical.exists &&
			canonical.readable &&
			!canonical.matches &&
			!lock
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Canonical index contains a different logical state",
				"move-attempted",
				false,
			);
		}
		throw new AmbiguousRemoteIndexStateError(
			"Canonical index commit could not be verified",
			"move-attempted",
		);
	}

	private createCanonicalCommitProof(
		index: SyncIndex,
		contentFingerprint: string,
	): CanonicalCommitProof {
		return {
			epoch: index.epoch,
			revision: index.revision,
			index: cloneIndex(index),
			contentFingerprint,
		};
	}

	/** Return the already verified commit proof, or leave failure handling to the caller. */
	async isExpectedCanonicalCommitted(
		lockPath: string,
		canonicalPath: string,
		expected: SyncIndex,
		expectedFingerprint: string | null,
	): Promise<CanonicalCommitProof | null> {
		try {
			return await this.verifyCanonicalCommit(
				lockPath,
				canonicalPath,
				expected,
				expectedFingerprint,
			);
		} catch {
			return null;
		}
	}

	/** Restore exact source bytes and report an explicit outcome without acknowledging work. */
	async rollbackOwnedLock(
		lockPath: string,
		canonicalPath: string,
		original: IndexFileSnapshot,
		context: Record<string, unknown>,
	): Promise<IndexTransactionOutcome> {
		try {
			const outcome = await rollbackRawIndexSnapshot(
				{
					exists: async (path) =>
						(await this.deps.client.getResource(
							path,
							1,
							0,
							true,
						)) !== null,
					readRaw: async (path) =>
						await this.deps.client.downloadFile(path, true),
					writeRaw: async (path, raw) =>
						await this.deps.client.uploadFile(
							path,
							raw,
							true,
							true,
							true,
						),
					moveExclusive: async (fromPath, toPath) =>
						await this.deps.client.moveResourceExclusive(
							fromPath,
							toPath,
						),
				},
				lockPath,
				canonicalPath,
				original.raw,
				async (raw) => {
					await this.deps.decodeSnapshot(
						raw,
						true,
						this.deps.getReadOptions().source,
						"source",
					);
				},
			);
			if (outcome !== "rolled-back") {
				return outcome;
			}
			logger.warn("Canonical index transaction rolled back", {
				...context,
				outcome: "rolled-back",
				restoredRevision: original.index.revision,
				restoredEpoch: shortenDiagnosticValue(original.index.epoch),
				restoredFingerprint: shortenDiagnosticValue(
					original.fingerprint,
				),
			});
			return outcome;
		} catch (rollbackError) {
			logger.error("Canonical index rollback is ambiguous", {
				...context,
				outcome: "ambiguous",
				error: rollbackError,
			});
			return "ambiguous";
		}
	}

	/** Report changed index sections by size and short digest, never their content. */
	async logSemanticIndexMismatch(
		expected: SyncIndex,
		actual: SyncIndex,
		context: Record<string, unknown>,
	): Promise<void> {
		const sections: Array<Record<string, unknown>> = [];
		const keys = new Set([
			...Object.keys(expected),
			...Object.keys(actual),
		]);
		for (const key of keys) {
			const expectedValue = stableSerialize(
				(expected as unknown as Record<string, unknown>)[key],
			);
			const actualValue = stableSerialize(
				(actual as unknown as Record<string, unknown>)[key],
			);
			if (expectedValue === actualValue) {
				continue;
			}
			const [expectedHash, actualHash] = await Promise.all([
				computeSha256FromString(expectedValue),
				computeSha256FromString(actualValue),
			]);
			sections.push({
				section: key,
				expectedSize: expectedValue.length,
				actualSize: actualValue.length,
				expectedSha256: expectedHash.slice(0, 12),
				actualSha256: actualHash.slice(0, 12),
			});
		}
		logger.error("Written index differs after JSON roundtrip", {
			...context,
			sections,
		});
	}
}

/** Preserve the canonical lock retry delay in discovery and commit. */
export function waitForIndexRetry(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

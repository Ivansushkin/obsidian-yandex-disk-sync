import { t } from "../i18n/index";
import { RemoteIndexConcurrentModificationError } from "../sync/canonical/errors";
import type {
	EncryptionManifest,
	EncryptionModeDescriptor,
	EncryptionTransitionPhase,
	IndexMaintenance,
} from "../types";
import { computeSha256 } from "../utils/hash-utils";
import { logger, shortenDiagnosticValue } from "../utils/logger";
import { joinPath, toLocalPath } from "../utils/path-utils";
import type { EncryptionContext } from "./context";
import { type EncryptionCodec } from "./encryption";
import {
	createTargetRawMapping,
	EncryptionTransitionController,
	hasPendingEncryptionCleanup,
	type EncryptionBackupProof,
	type LocalEncryptionSnapshot,
	type LocalEncryptionTransition,
} from "./encryption-transition";

/** Owns canonical maintenance, strict cleanup proofs and snapshot publication. */
export class EncryptionMaintenance {
	constructor(
		private readonly context: EncryptionContext,
		private readonly controller: EncryptionTransitionController,
	) {}

	async createEncryptionManifest(
		service: EncryptionCodec,
		salt: string,
		state: EncryptionManifest["state"],
		revision: number,
		transition?: LocalEncryptionTransition,
	): Promise<EncryptionManifest> {
		return await this.context.manager.createManifest({
			service,
			salt,
			state,
			revision,
			deviceId: this.context.getSettings().deviceId,
			transition,
			maintenance: this.context.index.getMaintenance(),
		});
	}

	/** Build a reusable publisher for one transition manifest state. */
	createEncryptionManifestPublisher(
		service: EncryptionCodec,
		salt: string,
		state: EncryptionManifest["state"],
		revision: number,
		transition: LocalEncryptionTransition,
	): () => Promise<void> {
		return async () =>
			await this.context.index.uploadEncryptionManifest(
				await this.createEncryptionManifest(
					service,
					salt,
					state,
					revision,
					transition,
				),
			);
	}

	captureEncryptionSnapshot(): LocalEncryptionSnapshot {
		return this.context.manager.captureSnapshot(this.context.getSettings());
	}

	async applyEncryptionSnapshot(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionCodec | null> {
		const service = await this.context.manager.applySnapshot(
			this.context.getSettings(),
			snapshot,
		);
		this.context.setService(service);
		this.context.client.setEncryptionService(service);
		await this.context.persist();
		return service;
	}

	async beginEncryptionTransition(
		kind: LocalEncryptionTransition["kind"],
		source: LocalEncryptionSnapshot,
		target: LocalEncryptionSnapshot,
		sourceRawPaths: string[],
		sourceFingerprints: Record<string, string>,
		backupProof: EncryptionBackupProof | null,
	): Promise<LocalEncryptionTransition> {
		const transition: LocalEncryptionTransition = {
			id: `${this.context.getSettings().deviceId}:${kind}:${Date.now().toString(36)}`,
			kind,
			phase: "prepared",
			source,
			target,
			sourceRawPaths,
			targetRawByLogicalPath: {},
			sourceFingerprints,
			targetFingerprints: {},
			sourceCanonicalRevision:
				this.context.index.getRemoteIndex().revision,
			backupProof,
		};
		this.context.setTransition(transition);
		this.context.ui.setBlock(t("notice.encryption_remote_busy"), false);
		await this.context.persist();
		logger.info("Encryption transition prepared locally", {
			...this.getEncryptionTransitionLogContext(transition),
			sourceFiles: transition.sourceRawPaths.length,
		});
		return transition;
	}

	/**
	 * Build a secret-free correlation context for encryption transition logs.
	 */
	getEncryptionTransitionLogContext(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase = transition.phase,
	): Record<string, unknown> {
		return {
			transitionId: shortenDiagnosticValue(transition.id),
			transitionKind: transition.kind,
			transitionPhase: phase,
			sourceCanonicalRevision: transition.sourceCanonicalRevision,
			sourceEncrypted: transition.source.enabled,
			targetEncrypted: transition.target.enabled,
			sourceEncryptionRevision: transition.source.revision,
			targetEncryptionRevision: transition.target.revision,
			sourceRawPaths: transition.sourceRawPaths.length,
			targetRawPaths: Object.keys(transition.targetRawByLogicalPath)
				.length,
		};
	}

	private async createEncryptionModeDescriptor(
		snapshot: LocalEncryptionSnapshot,
	): Promise<EncryptionModeDescriptor> {
		return await this.context.manager.createModeDescriptor(snapshot);
	}

	private async getLogicalVaultSnapshotDigest(): Promise<string> {
		return await this.context.getLocalSnapshotDigest();
	}

	/** Claim the selected source revision without silently refreshing its archive. */
	async claimEncryptionMaintenance(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const canonical = await this.context.index.readCanonicalIndex();
		if (
			canonical.revision !== transition.sourceCanonicalRevision ||
			canonical.epoch !== this.context.index.getRemoteIndex().epoch ||
			canonical.maintenance
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Encryption source changed before claim",
			);
		}
		await this.assertTransitionSourceUnchanged(transition);
		const proof = transition.backupProof;
		if (proof !== null) {
			if (
				proof.epoch !== canonical.epoch ||
				proof.canonicalRevision !== canonical.revision ||
				proof.localSnapshotDigest !==
					(await this.getLogicalVaultSnapshotDigest())
			) {
				throw new Error(
					"Encryption backup snapshot changed; start a new operation",
				);
			}
			const backup = await this.context.client.downloadStableRawFile(
				proof.path,
			);
			if (!backup || (await computeSha256(backup.raw)) !== proof.sha256) {
				throw new Error(
					"Selected encryption backup is missing or changed",
				);
			}
		}
		await this.commitCanonicalMaintenance(transition, "prepared");
	}

	async stageCanonicalMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup: IndexMaintenance["cleanup"] = [],
	): Promise<void> {
		const existing = this.context.index.getMaintenance();
		const maintenance: IndexMaintenance = {
			id: transition.id,
			kind: transition.kind,
			phase,
			initiatedBy: this.context.getSettings().deviceId,
			sourceRevision: transition.sourceCanonicalRevision,
			targetRevision:
				phase === "index-committed" ||
				phase === "cleanup" ||
				phase === "stable"
					? (existing?.targetRevision ??
						this.context.index.getRemoteIndex().revision + 1)
					: null,
			source:
				existing?.source ??
				(await this.createEncryptionModeDescriptor(transition.source)),
			target:
				existing?.target ??
				(await this.createEncryptionModeDescriptor(transition.target)),
			cleanup,
		};
		this.context.index.setMaintenance(maintenance);
		logger.debug("Encryption maintenance staged in memory", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			targetCanonicalRevision: maintenance.targetRevision,
			cleanupActions: cleanup.length,
		});
	}

	async commitCanonicalMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup: IndexMaintenance["cleanup"] = [],
	): Promise<void> {
		await this.stageCanonicalMaintenance(transition, phase, cleanup);
		logger.info("Committing encryption maintenance phase", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			cleanupActions: cleanup.length,
		});
		await this.context.index.saveRemoteIndex();
		await this.setEncryptionTransitionPhase(phase);
		logger.info("Encryption maintenance phase committed", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			canonicalRevision: this.context.index.getRemoteIndex().revision,
			cleanupActions: cleanup.length,
		});
	}

	private async finishCanonicalMaintenance(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		logger.info("Finishing canonical encryption maintenance", {
			...this.getEncryptionTransitionLogContext(transition),
		});
		this.context.index.clearMaintenance(transition.id);
		await this.context.index.saveRemoteIndex();
		logger.info("Canonical encryption maintenance finished", {
			...this.getEncryptionTransitionLogContext(transition, "stable"),
			canonicalRevision: this.context.index.getRemoteIndex().revision,
		});
	}

	async finishCanonicalMaintenanceIfCleanupComplete(
		transition: LocalEncryptionTransition,
	): Promise<boolean> {
		const cleanupPending = this.hasPendingGuardedCleanup();
		if (!cleanupPending) {
			await this.finishCanonicalMaintenance(transition);
			return true;
		}
		return false;
	}

	hasPendingGuardedCleanup(): boolean {
		const currentEpoch = this.context.index.getRemoteIndex().epoch;
		return hasPendingEncryptionCleanup(
			this.context.index.getPendingPhysicalActions(),
			currentEpoch,
		);
	}

	async setEncryptionTransitionPhase(
		phase: EncryptionTransitionPhase,
	): Promise<void> {
		const transition = this.context.getTransition();
		if (!transition) {
			return;
		}
		const previousPhase = transition.phase;
		transition.phase = phase;
		await this.context.persist();
		logger.info("Local encryption transition phase saved", {
			...this.getEncryptionTransitionLogContext(transition, phase),
			previousPhase,
		});
	}

	async resolveTransitionTargetPaths(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const logicalPaths = Object.entries(
			this.context.index.getRemoteIndex().files,
		)
			.filter(([, metadata]) => !metadata.deleted)
			.map(([logicalPath]) => logicalPath)
			.sort();
		const targetEntries: Array<readonly [string, string]> = [];
		for (const logicalPath of logicalPaths) {
			const rawPath = toLocalPath(
				await this.context.client.getPhysicalPath(
					joinPath(
						this.context.getSettings().remotePath,
						logicalPath,
					),
				),
				this.context.getSettings().remotePath,
			);
			targetEntries.push([logicalPath, rawPath]);
		}
		transition.targetRawByLogicalPath = createTargetRawMapping(
			targetEntries,
			transition.sourceRawPaths,
		);
		await this.context.persist();
	}

	async assertTransitionSourceUnchanged(
		transition: LocalEncryptionTransition,
	): Promise<void> {
		const snapshots = await this.context.index.getRemoteRawFileSnapshots();
		const current = new Map(
			snapshots.map((snapshot) => [snapshot.path, snapshot.fingerprint]),
		);
		for (const sourcePath of transition.sourceRawPaths) {
			if (
				current.get(sourcePath) !==
				transition.sourceFingerprints[sourcePath]
			) {
				throw new Error(
					`Source changed during encryption transition: ${sourcePath}`,
				);
			}
		}
		const allowed = new Set([
			...transition.sourceRawPaths,
			...Object.values(transition.targetRawByLogicalPath),
		]);
		const unexpected = snapshots.find(
			(snapshot) => !allowed.has(snapshot.path),
		);
		if (unexpected) {
			throw new Error(
				`Unexpected remote file appeared during encryption transition: ${unexpected.path}`,
			);
		}
	}

	async publishStableEncryptionSnapshot(
		snapshot: LocalEncryptionSnapshot,
	): Promise<void> {
		if (!snapshot.enabled || !snapshot.salt) {
			await this.context.index.deleteEncryptionManifest();
			return;
		}
		const service = await this.applyEncryptionSnapshot(snapshot);
		if (!service) {
			throw new Error("Could not initialize the stable encryption key");
		}
		await this.context.index.uploadEncryptionManifest(
			await this.createEncryptionManifest(
				service,
				snapshot.salt,
				"enabled",
				snapshot.revision ?? 1,
			),
		);
	}

	async prepareGuardedCleanup(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void> {
		const transition = this.context.getTransition();
		logger.info("Persisting guarded encryption cleanup actions", {
			...(transition
				? this.getEncryptionTransitionLogContext(transition)
				: {}),
			cleanupActions: paths.length,
		});
		for (const path of paths) {
			const expectedFingerprint = fingerprints[path];
			if (
				typeof expectedFingerprint !== "string" ||
				!expectedFingerprint
			) {
				throw new Error(`Missing cleanup fingerprint for ${path}`);
			}
			this.context.index.enqueuePhysicalAction("guarded-cleanup", path, {
				expectedFingerprint,
				origin: "encryption-cleanup",
			});
		}
		await this.context.persist();
	}

	completeGuardedCleanup(path: string): void {
		const action = this.context.index.getPendingPhysicalAction(
			"guarded-cleanup",
			path,
		);
		if (action?.epoch === this.context.index.getRemoteIndex().epoch) {
			this.context.index.completePhysicalAction(action.id);
		}
	}

	async requireCanonicalMaintenanceCleanupComplete(): Promise<void> {
		if (await this.resumeCanonicalMaintenanceCleanup()) {
			return;
		}
		this.context.ui.setBlock(t("notice.encryption_remote_busy"));
		throw new Error("Encryption cleanup is incomplete");
	}

	async resumeCanonicalMaintenanceCleanup(): Promise<boolean> {
		return await this.controller.resumeCanonicalCleanup();
	}

	async deleteRemoteRawPaths(
		paths: string[],
		expectedFingerprints: Record<string, string> = {},
	): Promise<void> {
		await this.controller.cleanupRawPaths(paths, expectedFingerprints);
	}

	async deleteRemoteRawFolders(rawFilePaths: string[]): Promise<void> {
		await this.controller.cleanupRawFolders(rawFilePaths);
	}
}

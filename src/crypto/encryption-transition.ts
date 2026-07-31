import type { EncryptionService } from "./encryption";
import type { IndexManager } from "../sync/index-manager";
import type { SyncEngine } from "../sync/sync-engine";
import type {
	EncryptionTransitionPhase,
	IndexMaintenance,
} from "../types";

export interface LocalEncryptionSnapshot {
	enabled: boolean;
	salt: string | null;
	password: string | null;
	revision: number | null;
}

export interface LocalEncryptionTransition {
	id: string;
	kind: "enable" | "disable" | "rotate";
	phase: EncryptionTransitionPhase;
	source: LocalEncryptionSnapshot;
	target: LocalEncryptionSnapshot;
	sourceRawPaths: string[];
	targetRawPaths: string[];
	sourceFingerprints: Record<string, string>;
	targetFingerprints: Record<string, string>;
	sourceCanonicalRevision: number;
}

interface EncryptionTransitionLifecycle {
	claim(transition: LocalEncryptionTransition): Promise<void>;
	applyTarget(snapshot: LocalEncryptionSnapshot): Promise<EncryptionService | null>;
	resolveTargetPaths(transition: LocalEncryptionTransition): Promise<void>;
	assertSourceUnchanged(transition: LocalEncryptionTransition): Promise<void>;
	captureTargetFingerprints(transition: LocalEncryptionTransition): Promise<void>;
	setPhase(phase: EncryptionTransitionPhase): Promise<void>;
	stageMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
	): Promise<void>;
	commitMaintenance(
		transition: LocalEncryptionTransition,
		phase: EncryptionTransitionPhase,
		cleanup?: IndexMaintenance["cleanup"],
	): Promise<void>;
	publishStable(snapshot: LocalEncryptionSnapshot): Promise<void>;
	prepareCleanup(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void>;
	deletePaths(
		paths: string[],
		fingerprints: Record<string, string>,
	): Promise<void>;
	deleteFolders(paths: string[]): Promise<void>;
	finishMaintenance(transition: LocalEncryptionTransition): Promise<void>;
	clearLocalTransition(): Promise<void>;
	recover(): Promise<void>;
	clearBlock(): void;
	createSyncFailure(errorCount: number): Error;
}

export interface EncryptionRewriteOptions {
	transition: LocalEncryptionTransition;
	sourceService: EncryptionService | null;
	beforeApplyTarget?(): Promise<void>;
	publishPrepared?(): Promise<void>;
	publishFilesCopied?(): Promise<void>;
	publishIndexCommitted?(): Promise<void>;
}

/**
 * Executes the shared causal workflow for enable, disable, and key rotation.
 * Mode-specific callers only provide manifest publication policy.
 */
export class EncryptionTransitionController {
	constructor(
		private readonly indexManager: IndexManager,
		private readonly syncEngine: SyncEngine,
		private readonly lifecycle: EncryptionTransitionLifecycle,
	) {}

	async execute(options: EncryptionRewriteOptions): Promise<void> {
		const { transition } = options;
		try {
			await this.lifecycle.claim(transition);
			await options.beforeApplyTarget?.();
			const targetService = await this.lifecycle.applyTarget(
				transition.target,
			);
			await this.lifecycle.resolveTargetPaths(transition);
			await options.publishPrepared?.();

			this.indexManager.setIndexTransitionServices(
				options.sourceService,
				targetService,
			);
			let result: Awaited<
				ReturnType<SyncEngine["reencodeRemoteFiles"]>
			>;
			try {
				result = await this.syncEngine.reencodeRemoteFiles({
					skipEncryptionGuard: true,
					skipMaintenanceGuard: true,
					beforeIndexCommit: async () => {
						await this.lifecycle.assertSourceUnchanged(transition);
						await this.lifecycle.captureTargetFingerprints(transition);
						await this.lifecycle.setPhase("files-copied");
						await this.lifecycle.stageMaintenance(
							transition,
							"index-committed",
						);
						await options.publishFilesCopied?.();
					},
				});
			} finally {
				this.indexManager.clearIndexTransitionServices();
			}

			if (!result.success) {
				throw this.lifecycle.createSyncFailure(result.errors.length);
			}
			await this.lifecycle.setPhase("index-committed");
			await options.publishIndexCommitted?.();
			await this.completeTarget(transition);
		} catch (error) {
			await this.lifecycle.recover();
			throw error;
		}
	}

	/** Complete the post-commit target publication and guarded cleanup. */
	async completeTarget(transition: LocalEncryptionTransition): Promise<void> {
		const cleanup = transition.sourceRawPaths.flatMap((path) => {
			const expectedFingerprint = transition.sourceFingerprints[path];
			return expectedFingerprint ? [{ path, expectedFingerprint }] : [];
		});
		await this.lifecycle.commitMaintenance(
			transition,
			"cleanup",
			cleanup,
		);
		await this.lifecycle.publishStable(transition.target);
		await this.lifecycle.prepareCleanup(
			transition.sourceRawPaths,
			transition.sourceFingerprints,
		);
		await this.lifecycle.deletePaths(
			transition.sourceRawPaths,
			transition.sourceFingerprints,
		);
		await this.lifecycle.deleteFolders(transition.sourceRawPaths);
		await this.lifecycle.finishMaintenance(transition);
		await this.lifecycle.clearLocalTransition();
		this.lifecycle.clearBlock();
	}
}

export type EncryptionRecoveryDecision =
	| "finish-target"
	| "rollback-source"
	| "blocked";

/**
 * Select the only safe recovery direction around the canonical index commit.
 */
export function decideEncryptionRecovery(
	phase: EncryptionTransitionPhase,
	targetReadable: boolean,
	sourceReadable: boolean,
): EncryptionRecoveryDecision {
	if (
		phase === "index-committed" ||
		phase === "stable" ||
		phase === "cleanup" ||
		targetReadable
	) {
		return "finish-target";
	}
	return sourceReadable ? "rollback-source" : "blocked";
}

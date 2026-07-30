import type {
	PendingMutation,
	PendingMutationType,
	PendingPhysicalAction,
	PendingPhysicalActionOrigin,
	PendingPhysicalActionType,
} from "../types";
import { advanceMutationSequence } from "./index-rules";
import { logger, shortenDiagnosticValue } from "../utils/logger";

interface MutationOptions {
	targetPath?: string;
	resourceKind?: "file" | "folder";
	sha256?: string;
	baselineSha256?: string;
}

interface PhysicalActionOptions {
	targetPath?: string;
	canonicalRevision?: number;
	expectedFingerprint?: string;
	expectedChangedRevision?: number;
	expectedTargetFingerprint?: string;
	baselineSha256?: string;
	epoch?: string | null;
	origin?: PendingPhysicalActionOrigin;
}

/**
 * Owns durable logical mutations and post-commit physical actions for one
 * device while preserving their FIFO and idempotency guarantees.
 */
export class LocalOperationStore {
	private deviceId: string;
	private pendingMutations: PendingMutation[] = [];
	private pendingPhysicalActions: PendingPhysicalAction[] = [];
	private nextMutationSeq = 1;

	constructor(deviceId: string) {
		this.deviceId = deviceId;
	}

	updateDeviceId(deviceId: string): void {
		this.deviceId = deviceId;
	}

	loadMutations(
		mutations: PendingMutation[] | undefined,
		nextMutationSeq: number,
	): void {
		this.pendingMutations = Array.isArray(mutations)
			? mutations.map((mutation, index) => {
					const sequence = mutation.seq || index + 1;
					return {
						...mutation,
						seq: sequence,
						epoch: mutation.epoch ?? null,
						id:
							mutation.seq > 0
								? mutation.id
								: `${this.deviceId}:${sequence}`,
					};
				})
			: [];
		this.nextMutationSeq =
			Math.max(
				Math.max(0, nextMutationSeq - 1),
				this.pendingMutations.reduce(
					(maximum, mutation) =>
						Math.max(maximum, mutation.seq),
					0,
				),
			) + 1;
		logger.debug("Loaded durable mutation queue", {
			pendingMutations: this.pendingMutations.length,
			nextMutationSeq: this.nextMutationSeq,
		});
	}

	getMutations(): PendingMutation[] {
		return this.pendingMutations.map((mutation) => ({ ...mutation }));
	}

	enqueueMutation(
		type: PendingMutationType,
		path: string,
		epoch: string | null,
		baseRevision: number | null,
		options?: MutationOptions,
	): PendingMutation {
		const mutation: PendingMutation = {
			id: `${this.deviceId}:${this.nextMutationSeq}`,
			seq: this.nextMutationSeq++,
			epoch,
			type,
			baseRevision,
			path,
			targetPath: options?.targetPath,
			resourceKind: options?.resourceKind,
			sha256: options?.sha256,
			baselineSha256: options?.baselineSha256,
			createdAt: Date.now(),
		};
		this.pendingMutations.push(mutation);
		logger.debug("Mutation persisted", {
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			mutationType: mutation.type,
			epoch: shortenDiagnosticValue(mutation.epoch),
			baseRevision: mutation.baseRevision,
			path: mutation.path,
			targetPath: mutation.targetPath,
			sha256: shortenDiagnosticValue(mutation.sha256),
		});
		return mutation;
	}

	getNextMutationSeq(): number {
		return this.nextMutationSeq;
	}

	/**
	 * Drop work from a superseded Force epoch and restart the device FIFO.
	 */
	resetForEpoch(epoch: string): void {
		this.pendingMutations = [];
		this.pendingPhysicalActions = this.pendingPhysicalActions.filter(
			(action) => action.epoch === epoch,
		);
		this.nextMutationSeq = 1;
	}

	findLatestPutBaseRevision(
		path: string,
	): number | null | undefined {
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const mutation = this.pendingMutations[index];
			if (mutation?.type === "put" && mutation.path === path) {
				return mutation.baseRevision;
			}
		}
		return undefined;
	}

	findLatestPutBaselineSha(path: string): string | undefined {
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const mutation = this.pendingMutations[index];
			if (mutation?.type === "put" && mutation.path === path) {
				return mutation.baselineSha256;
			}
		}
		return undefined;
	}

	/**
	 * Retarget an unconfirmed put while preserving its FIFO sequence and
	 * causal baseline.
	 */
	retargetLatestPut(
		oldPath: string,
		newPath: string,
		sha256: string,
		baselineSha256?: string,
	): PendingMutation | undefined {
		for (let index = this.pendingMutations.length - 1; index >= 0; index--) {
			const mutation = this.pendingMutations[index];
			if (mutation?.type !== "put" || mutation.path !== oldPath) continue;
			mutation.path = newPath;
			mutation.sha256 = sha256;
			if (baselineSha256 !== undefined) {
				mutation.baselineSha256 = baselineSha256;
			}
			logger.debug("Pending put retargeted", {
				mutationId: mutation.id,
				mutationSeq: mutation.seq,
				baseRevision: mutation.baseRevision,
				oldPath,
				newPath,
			});
			return mutation;
		}
		return undefined;
	}

	/**
	 * Convert an uncommitted put into a delete without introducing a FIFO gap.
	 */
	replacePutWithDelete(id: string): PendingMutation | undefined {
		const mutation = this.pendingMutations.find(
			(candidate) => candidate.id === id && candidate.type === "put",
		);
		if (!mutation) return undefined;
		mutation.type = "delete-file";
		mutation.targetPath = undefined;
		mutation.resourceKind = undefined;
		mutation.sha256 = undefined;
		logger.debug("Pending put superseded by delete", {
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			baseRevision: mutation.baseRevision,
			path: mutation.path,
		});
		return mutation;
	}

	/**
	 * Convert a full-sync-covered put into a watermark-only FIFO mutation.
	 */
	replacePutWithNoop(id: string): PendingMutation | undefined {
		const mutation = this.pendingMutations.find(
			(candidate) => candidate.id === id && candidate.type === "put",
		);
		if (!mutation) return undefined;
		mutation.type = "noop";
		mutation.targetPath = undefined;
		mutation.resourceKind = undefined;
		mutation.sha256 = undefined;
		mutation.baselineSha256 = undefined;
		logger.debug("Pending put settled as no-op", {
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			baseRevision: mutation.baseRevision,
			path: mutation.path,
		});
		return mutation;
	}

	stageMutation(
		appliedMutationSeq: Record<string, number>,
		mutation: PendingMutation,
	): boolean {
		const staged = advanceMutationSequence(
			appliedMutationSeq,
			this.deviceId,
			mutation.seq,
		);
		logger.debug("Mutation staged in canonical reducer", {
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			mutationType: mutation.type,
			baseRevision: mutation.baseRevision,
			staged,
			appliedSequence: appliedMutationSeq[this.deviceId] ?? 0,
			path: mutation.path,
			targetPath: mutation.targetPath,
		});
		return staged;
	}

	stagePendingMutations(
		appliedMutationSeq: Record<string, number>,
	): void {
		for (const mutation of [...this.pendingMutations].sort(
			(left, right) => left.seq - right.seq,
		)) {
			this.stageMutation(appliedMutationSeq, mutation);
		}
	}

	confirmMutation(
		id: string,
		appliedMutationSeq: Record<string, number>,
	): void {
		const mutation = this.pendingMutations.find((item) => item.id === id);
		if (!mutation) return;
		const applied = appliedMutationSeq[this.deviceId] || 0;
		if (mutation.seq > applied) return;
		this.pendingMutations = this.pendingMutations.filter(
			(item) => item.id !== id,
		);
		logger.debug("Mutation confirmed by canonical watermark", {
			mutationId: mutation.id,
			mutationSeq: mutation.seq,
			appliedSequence: applied,
		});
	}

	discardNewestMutation(id: string): void {
		const discarded = this.pendingMutations.find(
			(mutation) => mutation.id === id,
		);
		if (!discarded || discarded.seq !== this.nextMutationSeq - 1) return;
		this.pendingMutations = this.pendingMutations.filter(
			(mutation) => mutation.id !== id,
		);
		this.nextMutationSeq--;
	}

	confirmAppliedMutations(
		appliedMutationSeq: Record<string, number>,
	): void {
		const applied = appliedMutationSeq[this.deviceId] || 0;
		const before = this.pendingMutations.length;
		this.pendingMutations = this.pendingMutations.filter(
			(mutation) => mutation.seq > applied,
		);
		if (before !== this.pendingMutations.length) {
			logger.debug("Confirmed durable mutation prefix", {
				appliedSequence: applied,
				confirmedCount: before - this.pendingMutations.length,
				pendingMutations: this.pendingMutations.length,
			});
		}
	}

	loadPhysicalActions(
		actions: PendingPhysicalAction[] | undefined,
	): void {
		this.pendingPhysicalActions = Array.isArray(actions)
				? actions.map((action) => ({
						...action,
						epoch: action.epoch ?? null,
						origin: action.origin ?? "exact-delete",
					}))
			: [];
		logger.debug("Loaded durable physical action queue", {
			pendingPhysicalActions: this.pendingPhysicalActions.length,
		});
	}

	getPhysicalActions(): PendingPhysicalAction[] {
		return this.pendingPhysicalActions.map((action) => ({ ...action }));
	}

	findPhysicalAction(
		type: PendingPhysicalActionType,
		path: string,
	): PendingPhysicalAction | undefined {
		return this.pendingPhysicalActions.find(
			(action) => action.type === type && action.path === path,
		);
	}

	getPendingLocalDeletePaths(): Set<string> {
		return new Set(
			this.pendingPhysicalActions
				.filter((action) => action.type === "delete-local")
				.map((action) => action.path),
		);
	}

	enqueuePhysicalAction(
		type: PendingPhysicalActionType,
		path: string,
		defaultCanonicalRevision: number,
		options?: PhysicalActionOptions,
	): PendingPhysicalAction {
		const existing = this.pendingPhysicalActions.find(
			(action) =>
				action.type === type &&
				action.path === path &&
				action.targetPath === options?.targetPath,
		);
		if (existing) {
			existing.epoch = options?.epoch ?? existing.epoch;
			existing.origin = options?.origin ?? existing.origin;
			existing.canonicalRevision =
				options?.canonicalRevision ?? existing.canonicalRevision;
			existing.expectedFingerprint =
				options?.expectedFingerprint ??
				existing.expectedFingerprint;
			existing.expectedChangedRevision =
				options?.expectedChangedRevision ??
				existing.expectedChangedRevision;
			existing.expectedTargetFingerprint =
				options?.expectedTargetFingerprint ??
				existing.expectedTargetFingerprint;
			existing.baselineSha256 =
				options?.baselineSha256 ?? existing.baselineSha256;
			logger.debug("Physical action refreshed", {
				actionId: existing.id,
				actionType: existing.type,
				origin: existing.origin,
				epoch: shortenDiagnosticValue(existing.epoch),
				canonicalRevision: existing.canonicalRevision,
				expectedChangedRevision:
					existing.expectedChangedRevision,
				expectedFingerprint: shortenDiagnosticValue(
					existing.expectedFingerprint,
				),
				path: existing.path,
				targetPath: existing.targetPath,
			});
			return existing;
		}
		const action: PendingPhysicalAction = {
			id: `${this.deviceId}:physical:${Date.now().toString(36)}:${Math.random()
				.toString(36)
				.slice(2, 10)}`,
			type,
			epoch: options?.epoch ?? null,
			origin: options?.origin ?? "exact-delete",
			path,
			targetPath: options?.targetPath,
			canonicalRevision:
				options?.canonicalRevision ?? defaultCanonicalRevision,
			expectedFingerprint: options?.expectedFingerprint,
			expectedChangedRevision: options?.expectedChangedRevision,
			expectedTargetFingerprint: options?.expectedTargetFingerprint,
			baselineSha256: options?.baselineSha256,
			createdAt: Date.now(),
		};
		this.pendingPhysicalActions.push(action);
		logger.debug("Physical action persisted", {
			actionId: action.id,
			actionType: action.type,
			origin: action.origin,
			epoch: shortenDiagnosticValue(action.epoch),
			canonicalRevision: action.canonicalRevision,
			expectedChangedRevision: action.expectedChangedRevision,
			expectedFingerprint: shortenDiagnosticValue(
				action.expectedFingerprint,
			),
			path: action.path,
			targetPath: action.targetPath,
		});
		return action;
	}

	completePhysicalAction(id: string): void {
		const action = this.pendingPhysicalActions.find(
			(item) => item.id === id,
		);
		this.pendingPhysicalActions = this.pendingPhysicalActions.filter(
			(action) => action.id !== id,
		);
		if (action) {
			logger.debug("Physical action confirmed", {
				actionId: action.id,
				actionType: action.type,
				origin: action.origin,
				epoch: shortenDiagnosticValue(action.epoch),
				canonicalRevision: action.canonicalRevision,
				path: action.path,
				targetPath: action.targetPath,
			});
		}
	}
}

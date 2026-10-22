import type { SyncIndex, PendingMutation } from "../../types";
import { PathAncestryIndex } from "../../utils/path-utils";
import { getRecordValue, setRecordValue } from "../../utils/record-utils";
import { mergePhysicalMetadata } from "../local/baseline-rules";
import {
	InvalidCurrentIndexError,
	RemoteIndexConcurrentModificationError,
} from "./errors";
import {
	classifyFileMutation,
	mergeFileMutation,
	shouldPreserveConcurrentFolderChild,
	type FileMutationDecision,
} from "./mutation-rules";
import {
	cloneIndex,
	didCanonicalChangeBeforeMaintenanceClaim,
	isTargetRecoveryIndex,
	stableSerialize,
} from "./transaction-rules";

/** Existing transaction authority, resolved by the manager before reduction. */
export type CanonicalMergeMode =
	| { kind: "normal" }
	| { kind: "physical-rewrite" }
	| { kind: "target-recovery"; maintenanceId: string }
	| { kind: "replacement"; replacementDeletedAt: number };

export interface CanonicalMergeInput {
	latest: Readonly<SyncIndex>;
	loadedBase: Readonly<SyncIndex>;
	desired: Readonly<SyncIndex>;
	deviceId: string;
	baseRevision: number;
	mode: CanonicalMergeMode;
	completedMoveIds: ReadonlySet<string>;
	putBaselines: readonly Pick<
		PendingMutation,
		"type" | "path" | "baselineSha256"
	>[];
}

export interface RejectedCanonicalPut {
	path: string;
	reason: "delete" | "conflict";
	remoteFingerprint: string;
	baselineSha256?: string;
}

/** Metadata-only reduction events; the caller shortens device IDs before logging. */
export interface CanonicalMergeDiagnostic {
	path: string;
	decision: FileMutationDecision;
	baseRevision: number;
	currentRevision: number | null;
	mutationSeq: number | null;
	deviceId: string;
}

export interface CanonicalMergeResult {
	index: SyncIndex;
	rejectedPuts: RejectedCanonicalPut[];
	diagnostics: CanonicalMergeDiagnostic[];
}

/** Reduce snapshots in causal order without changing inputs or performing I/O. */
export function mergeDesiredIndex(
	input: CanonicalMergeInput,
): CanonicalMergeResult {
	const {
		latest,
		loadedBase,
		desired: desiredIndex,
		deviceId,
		baseRevision,
		mode,
	} = input;
	const rejectedPuts: RejectedCanonicalPut[] = [];
	const diagnostics: CanonicalMergeDiagnostic[] = [];
	const nextRevision = latest.revision + 1;
	if (mode.kind === "replacement") {
		const replacement = cloneIndex(desiredIndex);
		replacement.revision = nextRevision;
		for (const [path, previous] of Object.entries(latest.files)) {
			if (getRecordValue(replacement.files, path) !== undefined) {
				continue;
			}
			setRecordValue(replacement.files, path, {
				...previous,
				deleted: true,
				deletedAt: previous.deletedAt ?? mode.replacementDeletedAt,
				deletedByFolder: undefined,
			});
		}
		for (const meta of Object.values(replacement.files)) {
			meta.changedRevision = nextRevision;
			meta.baseRevision = latest.revision;
			meta.lastModifiedBy = deviceId;
			meta.mutationSeq = 0;
		}
		for (const tombstone of Object.values(replacement.folderTombstones)) {
			tombstone.changedRevision = nextRevision;
			tombstone.baseRevision = latest.revision;
			tombstone.lastModifiedBy = deviceId;
			tombstone.mutationSeq = 0;
		}
		for (const move of Object.values(replacement.moves)) {
			move.changedRevision = nextRevision;
			move.baseRevision = latest.revision;
			move.lastModifiedBy = deviceId;
			move.mutationSeq = 0;
		}
		return { index: replacement, rejectedPuts, diagnostics };
	}

	const merged = cloneIndex(latest);
	let changed = false;
	const desiredMaintenance = desiredIndex.maintenance;
	if (
		loadedBase.maintenance &&
		!sameValue(loadedBase.maintenance, latest.maintenance)
	) {
		throw new RemoteIndexConcurrentModificationError(
			"Maintenance changed since it was observed",
		);
	}
	if (mode.kind === "target-recovery") {
		if (
			!isTargetRecoveryIndex(latest, mode.maintenanceId) ||
			latest.epoch !== loadedBase.epoch ||
			(desiredMaintenance && desiredMaintenance.id !== mode.maintenanceId)
		) {
			throw new RemoteIndexConcurrentModificationError(
				"Target recovery authority changed before commit",
			);
		}
		if (!sameValue(desiredMaintenance, latest.maintenance)) {
			if (desiredMaintenance) {
				merged.maintenance = cloneValue(desiredMaintenance);
			} else {
				delete merged.maintenance;
			}
			merged.revision = nextRevision;
		}
		return { index: merged, rejectedPuts, diagnostics };
	}
	if (
		desiredMaintenance?.phase === "prepared" &&
		!sameValue(desiredMaintenance, loadedBase.maintenance) &&
		didCanonicalChangeBeforeMaintenanceClaim(
			loadedBase.revision,
			latest.revision,
		)
	) {
		throw new RemoteIndexConcurrentModificationError(
			"Canonical revision changed before encryption maintenance ownership was acquired",
		);
	}

	const putBaselines = new Map<string, string | undefined>();
	for (const mutation of input.putBaselines) {
		if (mutation.type === "put") {
			putBaselines.set(mutation.path, mutation.baselineSha256);
		}
	}

	for (const [path, desired] of Object.entries(desiredIndex.files)) {
		const baseline = loadedBase.files[path];
		if (sameValue(desired, baseline)) {
			continue;
		}

		const current = merged.files[path];
		if (mode.kind === "physical-rewrite") {
			const physical = mergePhysicalMetadata(current, baseline, desired);
			if (!physical) {
				throw new RemoteIndexConcurrentModificationError(
					`Logical state changed during physical rewrite: ${path}`,
				);
			}
			setRecordValue(merged.files, path, physical);
			changed = true;
			continue;
		}
		if (
			baseline &&
			!baseline.deleted &&
			sameValue(
				{
					...desired,
					remoteFingerprint: baseline.remoteFingerprint,
					remoteMtime: baseline.remoteMtime,
				},
				baseline,
			)
		) {
			if (sameValue(current, desired)) {
				continue;
			}
			const physical = sameValue(current, baseline)
				? mergePhysicalMetadata(current, baseline, desired)
				: null;
			if (!physical) {
				throw new RemoteIndexConcurrentModificationError(
					"Canonical file changed before physical metadata refresh",
				);
			}
			setRecordValue(merged.files, path, physical);
			changed = true;
			continue;
		}
		const logicalChange =
			baseline === undefined ||
			desired.sha256 !== baseline.sha256 ||
			desired.deleted !== baseline.deleted ||
			desired.deletedByFolder !== baseline.deletedByFolder;
		if (logicalChange && desired.mutationSeq === undefined) {
			throw new InvalidCurrentIndexError(
				"files",
				"new logical state is missing mutationSeq",
			);
		}
		if (logicalChange && desired.mutationSeq === 0) {
			throw new InvalidCurrentIndexError(
				"files",
				"normal logical mutation must have mutationSeq greater than zero",
			);
		}
		const mutationBase = desired.baseRevision ?? baseRevision;
		const mutationDevice = desired.lastModifiedBy ?? deviceId;
		const causalContext = {
			baselineSha256: putBaselines.get(path),
			currentWatermark: latest.appliedMutationSeq[mutationDevice] ?? 0,
			desiredWatermark:
				desiredIndex.appliedMutationSeq[mutationDevice] ?? 0,
		};
		const decision = classifyFileMutation(
			current,
			desired,
			mutationBase,
			causalContext,
		);
		if (decision === "fifo-gap" || decision === "invalid-sequence") {
			throw new InvalidCurrentIndexError(
				"files",
				`causal mutation rejected: ${decision}`,
			);
		}
		const next = mergeFileMutation(
			current,
			desired,
			mutationBase,
			nextRevision,
			deviceId,
			causalContext,
			decision,
		);
		if (next === current || !next) {
			if (
				decision === "concurrent-foreign" &&
				desired.deletedByFolder &&
				current &&
				!current.deleted
			) {
				setRecordValue(merged.files, path, {
					...current,
					changedRevision: nextRevision,
				});
				changed = true;
				continue;
			}
			if (
				!desired.deleted &&
				current &&
				desired.remoteFingerprint &&
				(decision === "concurrent-foreign" ||
					decision === "rejected-by-delete")
			) {
				rejectedPuts.push({
					path,
					reason:
						decision === "rejected-by-delete"
							? "delete"
							: "conflict",
					remoteFingerprint: desired.remoteFingerprint,
					baselineSha256: putBaselines.get(path),
				});
			}
			diagnostics.push({
				path,
				decision,
				baseRevision: mutationBase,
				currentRevision: current?.changedRevision ?? null,
				mutationSeq: desired.mutationSeq ?? null,
				deviceId: mutationDevice,
			});
			continue;
		}

		setRecordValue(merged.files, path, next);
		changed = true;
	}

	let ancestry: PathAncestryIndex | undefined;
	for (const [path, tombstone] of Object.entries(
		desiredIndex.folderTombstones,
	)) {
		if (sameValue(tombstone, loadedBase.folderTombstones[path])) {
			continue;
		}
		if (
			tombstone.mutationSeq === undefined ||
			tombstone.mutationSeq === 0
		) {
			throw new InvalidCurrentIndexError(
				"folderTombstones",
				"new logical state requires mutationSeq greater than zero",
			);
		}
		if (
			(desiredIndex.appliedMutationSeq[tombstone.lastModifiedBy] ?? 0) <
			tombstone.mutationSeq
		) {
			throw new InvalidCurrentIndexError(
				"folderTombstones",
				"mutationSeq exceeds its staged device watermark",
			);
		}
		setRecordValue(merged.folderTombstones, path, {
			...tombstone,
			baseRevision: tombstone.baseRevision ?? baseRevision,
			changedRevision: nextRevision,
			lastModifiedBy: deviceId,
			mutationSeq: tombstone.mutationSeq,
		});
		const mutationBase = tombstone.baseRevision ?? baseRevision;
		ancestry ??= new PathAncestryIndex(Object.keys(merged.files));
		for (const filePath of ancestry.get(path.replace(/\/+$/, "")) ?? []) {
			const current = merged.files[filePath]!;
			if (
				!shouldPreserveConcurrentFolderChild(
					current,
					mutationBase,
					tombstone.lastModifiedBy,
					tombstone.mutationSeq,
				)
			) {
				continue;
			}
			setRecordValue(merged.files, filePath, {
				...current,
				changedRevision: nextRevision,
			});
		}
		changed = true;
	}

	for (const [id, move] of Object.entries(desiredIndex.moves)) {
		if (sameValue(move, loadedBase.moves[id])) {
			continue;
		}
		if (move.mutationSeq === undefined || move.mutationSeq === 0) {
			throw new InvalidCurrentIndexError(
				"moves",
				"new logical state requires mutationSeq greater than zero",
			);
		}
		if (
			(desiredIndex.appliedMutationSeq[move.lastModifiedBy] ?? 0) <
			move.mutationSeq
		) {
			throw new InvalidCurrentIndexError(
				"moves",
				"mutationSeq exceeds its staged device watermark",
			);
		}
		setRecordValue(merged.moves, id, {
			...move,
			changedRevision: nextRevision,
			lastModifiedBy: deviceId,
			mutationSeq: move.mutationSeq,
		});
		changed = true;
	}
	for (const id of input.completedMoveIds) {
		if (!merged.moves[id]) {
			continue;
		}
		delete merged.moves[id];
		changed = true;
	}

	for (const [deviceId, sequence] of Object.entries(
		desiredIndex.appliedMutationSeq,
	)) {
		const current = merged.appliedMutationSeq[deviceId] || 0;
		if (sequence <= current) {
			continue;
		}
		setRecordValue(merged.appliedMutationSeq, deviceId, sequence);
		changed = true;
	}

	if (!sameValue(desiredIndex.maintenance, loadedBase.maintenance)) {
		if (desiredIndex.maintenance) {
			merged.maintenance = cloneValue(desiredIndex.maintenance);
		} else {
			delete merged.maintenance;
		}
		changed = true;
	}

	merged.revision = changed ? nextRevision : latest.revision;
	return { index: merged, rejectedPuts, diagnostics };
}

function cloneValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function sameValue(left: unknown, right: unknown): boolean {
	return stableSerialize(left) === stableSerialize(right);
}

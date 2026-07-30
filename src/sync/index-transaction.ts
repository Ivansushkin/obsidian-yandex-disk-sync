import type { SyncIndex } from "../types";

export type IndexTransactionStage =
	| "acquired"
	| "written"
	| "verified"
	| "move-attempted"
	| "committed";

export type IndexTransactionOutcome =
	| "committed"
	| "rolled-back"
	| "concurrent"
	| "ambiguous";

export type IndexCodec = "current" | "source" | "target" | "plaintext";

export interface IndexFileSnapshot {
	raw: ArrayBuffer;
	index: SyncIndex;
	fingerprint: string | null;
	codec: IndexCodec;
}

export type IndexMoveRecoveryDecision =
	| "committed"
	| "retry-move"
	| "concurrent"
	| "ambiguous";

export interface IndexMoveObservation {
	canonicalExists: boolean;
	lockExists: boolean;
	canonicalReadable: boolean;
	lockReadable: boolean;
	canonicalMatchesExpected: boolean;
	lockMatchesExpected: boolean;
}

export interface RawIndexTransactionBackend {
	exists(path: string): Promise<boolean>;
	readRaw(path: string): Promise<ArrayBuffer>;
	writeRaw(path: string, raw: ArrayBuffer): Promise<void>;
	moveExclusive(fromPath: string, toPath: string): Promise<void>;
}

/**
 * Classify the observable state after an index move returned ambiguously.
 */
export function classifyIndexMoveRecovery(
	observation: IndexMoveObservation,
): IndexMoveRecoveryDecision {
	if (
		observation.canonicalExists &&
		!observation.lockExists &&
		observation.canonicalReadable
	) {
		return observation.canonicalMatchesExpected
			? "committed"
			: "concurrent";
	}
	if (
		!observation.canonicalExists &&
		observation.lockExists &&
		observation.lockReadable &&
		observation.lockMatchesExpected
	) {
		return "retry-move";
	}
	return "ambiguous";
}

/**
 * Retry only contention or a transaction whose original canonical state was
 * conclusively restored.
 */
export function shouldRetryIndexTransaction(
	outcome: IndexTransactionOutcome,
	lockContention = false,
): boolean {
	return lockContention || outcome === "rolled-back";
}

/**
 * Compare raw index snapshots without decoding or re-encrypting them.
 */
export function rawBuffersEqual(
	left: ArrayBuffer,
	right: ArrayBuffer,
): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	for (let index = 0; index < leftBytes.length; index++) {
		if (leftBytes[index] !== rightBytes[index]) return false;
	}
	return true;
}

/**
 * Restore the original canonical bytes after a captured lock was modified.
 * The final read-back, not the transport response, determines the outcome.
 */
export async function rollbackRawIndexSnapshot(
	backend: RawIndexTransactionBackend,
	lockPath: string,
	canonicalPath: string,
	originalRaw: ArrayBuffer,
	assertReadable: (raw: ArrayBuffer) => Promise<void>,
): Promise<IndexTransactionOutcome> {
	const [canonicalExists, lockExists] = await Promise.all([
		backend.exists(canonicalPath),
		backend.exists(lockPath),
	]);
	if (canonicalExists) {
		if (lockExists) return "ambiguous";
		const canonicalRaw = await backend.readRaw(canonicalPath);
		return rawBuffersEqual(canonicalRaw, originalRaw)
			? "rolled-back"
			: "concurrent";
	}
	if (!lockExists) return "ambiguous";

	try {
		await backend.writeRaw(lockPath, originalRaw);
	} catch {
		// Verify the lock bytes because the upload may have succeeded remotely.
	}
	const restoredLock = await backend.readRaw(lockPath);
	if (!rawBuffersEqual(restoredLock, originalRaw)) return "ambiguous";
	await assertReadable(restoredLock);
	try {
		await backend.moveExclusive(lockPath, canonicalPath);
	} catch {
		// The path read-back below resolves a lost or ambiguous move response.
	}

	const [restoredCanonicalExists, remainingLockExists] =
		await Promise.all([
			backend.exists(canonicalPath),
			backend.exists(lockPath),
		]);
	if (!restoredCanonicalExists || remainingLockExists) return "ambiguous";
	const restoredCanonical = await backend.readRaw(canonicalPath);
	if (!rawBuffersEqual(restoredCanonical, originalRaw)) {
		return "concurrent";
	}
	await assertReadable(restoredCanonical);
	return "rolled-back";
}

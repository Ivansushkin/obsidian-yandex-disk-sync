import type { PendingPhysicalAction, SyncIndex } from "../types";

export type PhysicalDeleteFingerprintDecision =
	| "match"
	| "missing-expected"
	| "missing-current"
	| "mismatch";

/**
 * Decide whether a durable deletion is still authorized by canonical state.
 */
export function isPhysicalDeleteAuthorized(
	action: PendingPhysicalAction,
	canonical: SyncIndex,
): boolean {
	if (action.epoch !== canonical.epoch) return false;
	const metadata = canonical.files[action.path];
	if (action.origin === "force-reset") {
		return metadata === undefined;
	}
	if (action.origin === "rejected-upload") {
		const target = action.targetPath
			? canonical.files[action.targetPath]
			: undefined;
		return (
			metadata === undefined &&
			target !== undefined &&
			!target.deleted &&
			(action.baselineSha256 === undefined ||
				target.sha256 === action.baselineSha256)
		);
	}
	return metadata?.deleted === true;
}

/**
 * Require an exact server fingerprint match before destructive remote work.
 */
export function classifyPhysicalDeleteFingerprint(
	expectedFingerprint: string | undefined,
	currentFingerprint: string | undefined,
): PhysicalDeleteFingerprintDecision {
	if (!expectedFingerprint) return "missing-expected";
	if (!currentFingerprint) return "missing-current";
	return expectedFingerprint === currentFingerprint ? "match" : "mismatch";
}

/**
 * Require a backup whenever the current content is not proven equal to the
 * device baseline. An absent baseline is unknown, not unchanged.
 */
export function shouldBackupLocalDelete(
	currentSha256: string,
	baselineSha256: string | undefined,
): boolean {
	return (
		baselineSha256 === undefined ||
		currentSha256 !== baselineSha256
	);
}

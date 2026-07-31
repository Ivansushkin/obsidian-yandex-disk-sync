import type {
	PendingPhysicalAction,
	SyncIndex,
	YandexResource,
} from "../types";
import {
	getPhysicalResourceFingerprint,
	matchesPhysicalResourceFingerprint,
} from "../utils/resource-fingerprint";

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
 * Classify a destructive guard against current Yandex resource metadata.
 * Legacy beta fingerprints may refer to any server identity field.
 */
export function classifyPhysicalDeleteResource(
	expectedFingerprint: string | undefined,
	resource: YandexResource | null,
): PhysicalDeleteFingerprintDecision {
	if (!expectedFingerprint) return "missing-expected";
	if (!getPhysicalResourceFingerprint(resource)) return "missing-current";
	return matchesPhysicalResourceFingerprint(expectedFingerprint, resource)
		? "match"
		: "mismatch";
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

import type { PendingPhysicalAction, SyncIndex } from "../types";

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
	return metadata?.deleted === true;
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

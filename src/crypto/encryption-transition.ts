import type { EncryptionTransitionPhase } from "../types";

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

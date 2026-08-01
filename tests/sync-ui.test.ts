import assert from "node:assert/strict";
import test from "node:test";
import { formatSyncActivity } from "../src/ui/status-bar";
import type { SyncState } from "../src/types";

function createSyncingState(partial: Partial<SyncState> = {}): SyncState {
	return {
		status: "syncing",
		currentOperation: "Applying changes",
		...partial,
	};
}

test("activity formatting omits determinate progress when total is unknown", () => {
	assert.equal(formatSyncActivity(createSyncingState()), "Applying changes");
	assert.equal(
		formatSyncActivity(
			createSyncingState({
				progress: { completed: 0, total: 0 },
			}),
		),
		"Applying changes",
	);
});

test("activity formatting reports completed units instead of a percentage", () => {
	assert.equal(
		formatSyncActivity(
			createSyncingState({
				progress: { completed: 2, total: 5 },
			}),
		),
		"Applying changes 2/5",
	);
});

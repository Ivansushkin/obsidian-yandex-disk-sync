import assert from "node:assert/strict";
import test from "node:test";
import { SyncCoordinator } from "../src/sync/sync-coordinator";
import { logger } from "../src/utils/logger";

logger.configure({ consoleEnabled: false });

test("coordinator never overlaps sessions across kinds", async () => {
	const coordinator = new SyncCoordinator();
	let active = 0;
	let maximum = 0;
	const run = async (): Promise<void> => {
		active++;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
	};

	await Promise.all([
		coordinator.run("full", run),
		coordinator.run("maintenance", run),
		coordinator.run("realtime", run),
	]);
	assert.equal(maximum, 1);
});

test("concurrent full requests share one execution", async () => {
	const coordinator = new SyncCoordinator();
	let executions = 0;
	const task = async (): Promise<number> => {
		executions++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return 42;
	};

	const [first, second] = await Promise.all([
		coordinator.run("full", task),
		coordinator.run("full", task),
	]);
	assert.equal(first, 42);
	assert.equal(second, 42);
	assert.equal(executions, 1);

	assert.equal(await coordinator.run("full", task), 42);
	assert.equal(executions, 2);
});

test("coordinator exposes and clears correlation metadata", async () => {
	const coordinator = new SyncCoordinator();
	let observedId: string | null = null;
	await coordinator.run("realtime", async () => {
		const active = coordinator.getActiveSession();
		assert.equal(active?.kind, "realtime");
		observedId = active?.id ?? null;
	});

	assert.match(observedId ?? "", /^realtime-/);
	assert.equal(coordinator.getActiveSession(), null);
});

test("coordinator clears active metadata when enter hook fails", async () => {
	const coordinator = new SyncCoordinator({
		onEnter: () => {
			throw new Error("enter failed");
		},
	});
	await assert.rejects(
		coordinator.run("full", async () => undefined),
		/enter failed/,
	);
	assert.equal(coordinator.getActiveSession(), null);
	assert.equal(coordinator.getActiveKind(), null);
});

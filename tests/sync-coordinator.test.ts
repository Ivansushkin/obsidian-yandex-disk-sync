import assert from "node:assert/strict";
import test from "node:test";
import { SyncCoordinator } from "../src/sync/sync-coordinator";
import { SyncEngine, type SyncRunOptions } from "../src/sync/sync-engine";
import { DEFAULT_SETTINGS, type SyncState } from "../src/types";
import type { YandexDiskClient } from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { IndexManager } from "../src/sync/index-manager";
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

test("full preparation and execution are shared by concurrent callers", async () => {
	const coordinator = new SyncCoordinator();
	let prepares = 0;
	let executions = 0;
	const hooks = {
		prepare: async () => {
			prepares++;
			await Promise.resolve();
		},
	};

	await Promise.all([
		coordinator.run("full", async () => ++executions, hooks),
		coordinator.run("full", async () => ++executions, hooks),
	]);
	assert.equal(prepares, 1);
	assert.equal(executions, 1);
});

test("settlement completes before the next session starts", async () => {
	const coordinator = new SyncCoordinator();
	const order: string[] = [];
	const first = coordinator.run(
		"realtime",
		async () => {
			order.push("task");
			return 1;
		},
		{
			settle: async () => {
				order.push("settle-start");
				await Promise.resolve();
				order.push("settle-end");
			},
		},
	);
	const second = coordinator.run("full", async () => {
		order.push("next");
	});
	await Promise.all([first, second]);

	assert.deepEqual(order, ["task", "settle-start", "settle-end", "next"]);
});

test("Force session progress ignores foreign activity and unsubscribes after settlement", async () => {
	const engine = new SyncEngine({} as YandexDiskClient, {} as VaultAdapter, {} as IndexManager, DEFAULT_SETTINGS);
	const access = engine as unknown as {
		runCoordinatedSession(kind: "force", options: SyncRunOptions, task: () => Promise<void>): Promise<void>;
		updateState(state: Partial<SyncState>): void;
		eventListeners: unknown[];
	};
	const observed: SyncState[] = [];
	await access.runCoordinatedSession("force", { onActivity: (state) => observed.push(state) }, async () => {
		const own = engine.getState();
		access.updateState({ status: "syncing", sessionId: "foreign", currentOperation: "foreign progress" });
		access.updateState({ ...own, currentOperation: "owned progress" });
	});
	assert.ok(observed.some((state) => state.currentOperation === "owned progress"));
	assert.ok(observed.every((state) => state.sessionId !== "foreign"));
	assert.equal(access.eventListeners.length, 0);
});

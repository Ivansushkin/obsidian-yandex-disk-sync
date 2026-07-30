import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { FileWatcher, type DeferredWatcherEvent } from "../src/sync/file-watcher";
import type { SyncEngine } from "../src/sync/sync-engine";
import { DEFAULT_SETTINGS } from "../src/types";

interface FileWatcherTestAccess {
	deferEvent(event: DeferredWatcherEvent): void;
}

function createWatcher(): FileWatcher {
	const syncEngine = {
		getWatcherCausalContext: () => ({
			epoch: "epoch-a",
			baseRevision: 7,
		}),
	} as unknown as SyncEngine;
	return new FileWatcher(
		{} as App,
		syncEngine,
		DEFAULT_SETTINGS,
	);
}

test("legacy watcher file events receive durable causal metadata", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([
		{
			action: "upload",
			path: "A.md",
		} as DeferredWatcherEvent,
	]);

	const [loaded] = watcher.getDeferredEvents();
	assert.ok(loaded);
	assert.equal(loaded.action, "upload");
	assert.equal("id" in loaded, true);
	assert.equal("epoch" in loaded ? loaded.epoch : undefined, "epoch-a");
	assert.equal(
		"baseRevision" in loaded ? loaded.baseRevision : undefined,
		7,
	);
	assert.equal(
		"createdAt" in loaded && typeof loaded.createdAt === "number",
		true,
	);
});

test("quick file rename chain coalesces to the final target", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.deferEvent({
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
	});
	access.deferEvent({
		action: "rename",
		path: "B.md",
		targetPath: "deep/С.md",
		kind: "file",
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => ({
			action: event.action,
			path: event.path,
			targetPath:
				event.action === "rename" ? event.targetPath : undefined,
		})),
		[
			{
				action: "rename",
				path: "A.md",
				targetPath: "deep/С.md",
			},
		],
	);
});

test("new file at the old path survives a queued rename", () => {
	const watcher = createWatcher();
	watcher.loadDeferredEvents([]);
	const access = watcher as unknown as FileWatcherTestAccess;

	access.deferEvent({
		action: "rename",
		path: "A.md",
		targetPath: "B.md",
		kind: "file",
	});
	access.deferEvent({
		id: "new-a",
		action: "upload",
		path: "A.md",
		epoch: "epoch-a",
		baseRevision: 7,
		createdAt: 2,
	});

	assert.deepEqual(
		watcher.getDeferredEvents().map((event) => event.action),
		["rename", "upload"],
	);
});

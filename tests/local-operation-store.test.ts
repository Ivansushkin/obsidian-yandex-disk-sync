import assert from "node:assert/strict";
import test from "node:test";
import { LocalOperationStore } from "../src/sync/local-operation-store";

test("mutation replay advances and confirms only a contiguous FIFO prefix", () => {
	const store = new LocalOperationStore("device-a");
	store.loadMutations(undefined, 1);
	const first = store.enqueueMutation("put", "a.md", "epoch-a", 0);
	const second = store.enqueueMutation(
		"delete-file",
		"b.md",
		"epoch-a",
		0,
	);
	const applied: Record<string, number> = {};

	assert.equal(store.stageMutation(applied, second), false);
	store.confirmMutation(second.id, applied);
	assert.equal(store.getMutations().length, 2);

	store.stagePendingMutations(applied);
	assert.equal(applied["device-a"], 2);
	store.confirmAppliedMutations(applied);
	assert.deepEqual(store.getMutations(), []);
	assert.equal(first.seq, 1);
	assert.equal(second.seq, 2);
});

test("reloaded mutation sequence continues after the durable watermark", () => {
	const store = new LocalOperationStore("device-a");
	store.loadMutations(undefined, 8);
	const mutation = store.enqueueMutation(
		"put",
		"note.md",
		"epoch-a",
		7,
	);
	assert.equal(mutation.seq, 8);
	assert.equal(mutation.id, "device-a:8");
	assert.equal(mutation.epoch, "epoch-a");
});

test("put mutation retains the pre-upload baseline hash", () => {
	const store = new LocalOperationStore("device-a");
	store.loadMutations(undefined, 1);
	store.enqueueMutation("put", "note.md", "epoch-a", 3, {
		sha256: "new",
		baselineSha256: "old",
	});
	assert.equal(store.findLatestPutBaselineSha("note.md"), "old");
});

test("physical actions are idempotent and survive local reload", () => {
	const firstStore = new LocalOperationStore("device-a");
	const first = firstStore.enqueuePhysicalAction(
		"delete-local",
		"folder/note.md",
		4,
		{ epoch: "epoch-a", origin: "folder-delete" },
	);
	const duplicate = firstStore.enqueuePhysicalAction(
		"delete-local",
		"folder/note.md",
		5,
		{ epoch: "epoch-a", origin: "folder-delete" },
	);
	assert.equal(duplicate.id, first.id);

	const secondStore = new LocalOperationStore("device-a");
	secondStore.loadPhysicalActions(firstStore.getPhysicalActions());
	assert.equal(
		secondStore.findPhysicalAction(
			"delete-local",
			"folder/note.md",
		)?.canonicalRevision,
		4,
	);
	assert.equal(
		secondStore.findPhysicalAction(
			"delete-local",
			"folder/note.md",
		)?.origin,
		"folder-delete",
	);
	secondStore.completePhysicalAction(first.id);
	assert.deepEqual(secondStore.getPhysicalActions(), []);
});

test("force epoch reset clears old FIFO work and preserves new-epoch cleanup", () => {
	const store = new LocalOperationStore("device-a");
	store.loadMutations(undefined, 8);
	store.enqueueMutation("put", "old.md", "old-epoch", 7);
	store.enqueuePhysicalAction("delete-remote", "old.md", 8, {
		epoch: "old-epoch",
	});
	store.enqueuePhysicalAction("delete-remote", "remote-only.md", 1, {
		epoch: "new-epoch",
		origin: "force-reset",
	});

	store.resetForEpoch("new-epoch");

	assert.deepEqual(store.getMutations(), []);
	assert.deepEqual(
		store.getPhysicalActions().map((action) => action.path),
		["remote-only.md"],
	);
	const next = store.enqueueMutation(
		"put",
		"new.md",
		"new-epoch",
		1,
	);
	assert.equal(next.seq, 1);
});

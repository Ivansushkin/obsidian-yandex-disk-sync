import assert from "node:assert/strict";
import test from "node:test";
import { LocalOperationStore } from "../src/sync/local/operation-store";

test("mutation replay advances only a contiguous FIFO prefix from its durable allocation floor", () => {
	for (const firstSeq of [1, 8]) {
		const label = `allocation floor ${firstSeq}`;
		const store = new LocalOperationStore("device-a");
		store.loadMutations(undefined, firstSeq);
		const first = store.enqueueMutation("put", "a.md", "epoch-a", 7);
		const second = store.enqueueMutation(
			"delete-file",
			"b.md",
			"epoch-a",
			7,
		);
		const applied = { "device-a": firstSeq - 1 };
		assert.equal(first.id, `device-a:${firstSeq}`, label);
		assert.equal(second.seq, firstSeq + 1, label);
		assert.equal(store.stageMutation(applied, second), false, label);
		store.confirmMutation(second.id, applied);
		assert.equal(store.getMutations().length, 2, label);
		store.stagePendingMutations(applied);
		assert.equal(applied["device-a"], firstSeq + 1, label);
		store.confirmAppliedMutations(applied);
		assert.deepEqual(store.getMutations(), [], label);
	}
});

test("retargeted put preserves FIFO sequence and causal baseline", () => {
	const store = new LocalOperationStore("device-a");
	store.loadMutations(undefined, 1);
	const original = store.enqueueMutation("put", "A.md", "epoch-a", 7, {
		sha256: "old-content",
		baselineSha256: "baseline",
	});

	assert.equal(store.findLatestPutBaselineSha("A.md"), "baseline");
	const retargeted = store.retargetLatestPut(
		"A.md",
		"folder/B.md",
		"new-content",
	);

	assert.equal(retargeted?.id, original.id);
	assert.equal(retargeted?.seq, original.seq);
	assert.equal(retargeted?.baseRevision, original.baseRevision);
	assert.equal(retargeted?.baselineSha256, "baseline");
	assert.equal(retargeted?.path, "folder/B.md");
	assert.equal(retargeted?.sha256, "new-content");
	assert.equal(store.getNextMutationSeq(), 2);
});

test("superseded puts become delete or no-op without FIFO gaps across reload", () => {
	for (const replacement of ["delete-file", "noop"] as const) {
		const store = new LocalOperationStore("device-a");
		store.loadMutations(undefined, 1);
		const put = store.enqueueMutation("put", "A.md", "epoch-a", 7, {
			sha256: "obsolete",
			baselineSha256: "baseline",
		});
		const replaced =
			replacement === "noop"
				? store.replacePutWithNoop(put.id)
				: store.replacePutWithDelete(put.id);
		assert.ok(replaced, replacement);
		assert.equal(replaced.id, put.id, replacement);
		assert.equal(replaced.seq, put.seq, replacement);
		assert.equal(replaced.epoch, put.epoch, replacement);
		assert.equal(replaced.baseRevision, put.baseRevision, replacement);
		assert.equal(replaced.type, replacement, replacement);
		assert.equal(replaced.sha256, undefined, replacement);
		if (replacement === "noop") {
			assert.equal(replaced.baselineSha256, undefined, replacement);
		}
		const reloaded = new LocalOperationStore("device-a");
		reloaded.loadMutations(
			store.getMutations(),
			store.getNextMutationSeq(),
		);
		const applied: Record<string, number> = {};
		reloaded.stagePendingMutations(applied);
		reloaded.confirmAppliedMutations(applied);
		assert.equal(applied["device-a"], 1, replacement);
		assert.deepEqual(reloaded.getMutations(), [], replacement);
		assert.equal(reloaded.getNextMutationSeq(), 2, replacement);
	}
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
		secondStore.findPhysicalAction("delete-local", "folder/note.md")
			?.canonicalRevision,
		4,
	);
	assert.equal(
		secondStore.findPhysicalAction("delete-local", "folder/note.md")
			?.origin,
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
	const next = store.enqueueMutation("put", "new.md", "new-epoch", 1);
	assert.equal(next.seq, 1);
});

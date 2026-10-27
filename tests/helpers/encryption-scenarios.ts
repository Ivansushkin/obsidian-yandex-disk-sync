import assert from "node:assert/strict";
import type { SyncIndex } from "../../src/types";
import { encryptionFlow } from "./encryption-flow";
import { bytes, type device, type MemoryDisk } from "./sync-flow";

export type TransitionKind = "enable" | "disable" | "rotate";
type Device = ReturnType<typeof device>;
type Flow = ReturnType<typeof encryptionFlow>;

/** Run each public transition through the real maintenance coordinator. */
export function transition(
	a: Device,
	flow: Flow,
	kind: TransitionKind,
	password = "target-password",
) {
	const { workflow } = flow;
	const backup = "without-backup";
	const operations = {
		enable: () => workflow.enableEncryptionNow(password, backup),
		disable: () =>
			workflow.disableEncryptionNow({ reuploadPlaintext: true }, backup),
		rotate: () => workflow.rotateEncryptionPasswordNow(password, backup),
	};
	return a.engine.runExclusiveMaintenance<void | { hadErrors: boolean }>(
		operations[kind],
	);
}

/** Seed bytes and, when needed, establish the encrypted source state. */
export async function transitionSource(
	a: Device,
	flow: Flow,
	kind: TransitionKind,
	expected: Record<string, string>,
) {
	for (const [path, content] of Object.entries(expected)) {
		a.vault.put(path, bytes(content));
	}
	await a.full();
	if (kind !== "enable") {
		await transition(a, flow, "enable", "source-password");
	}
	return a.canonical();
}

/** Verify a new authoritative generation, or the unchanged history of a legacy rewrite. */
export function assertTransitionIdentity(after: SyncIndex, before: SyncIndex) {
	if (after.epochAdoption) {
		assert.notEqual(after.epoch, before.epoch);
		assert.equal(after.epochAdoption.kind, "encryption-replacement");
		assert.deepEqual(after.appliedMutationSeq, {});
		assert.deepEqual(after.moves, {});
		assert.deepEqual(after.folderTombstones, {});
		for (const file of Object.values(after.files)) {
			assert.equal(file.mutationSeq, 0);
			assert.equal(file.lastModifiedBy, after.epochAdoption.initiatedBy);
			assert.ok(
				file.changedRevision! > before.revision &&
					file.changedRevision! <= after.revision,
			);
			assert.ok(file.baseRevision! >= before.revision);
		}
		return;
	}
	assert.equal(after.epoch, before.epoch);
	assert.deepEqual(after.appliedMutationSeq, before.appliedMutationSeq);
	for (const path of Object.keys(before.files)) {
		for (const field of [
			"mutationSeq",
			"changedRevision",
			"lastModifiedBy",
			"baseRevision",
		] as const) {
			assert.equal(after.files[path]![field], before.files[path]![field]);
		}
	}
}

/** Leave one copied target and a durable prepared checkpoint for rollback attacks. */
export async function interruptTransition(
	disk: MemoryDisk,
	a: Device,
	flow: Flow,
	kind: "enable" | "rotate",
) {
	a.settings.maxConcurrency = 1;
	await transitionSource(a, flow, kind, { "A.md": "alpha", "B.md": "beta" });
	let writes = 0;
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			!path.includes(".obsidian-")
		) {
			writes++;
			if (writes > 1) {
				throw new Error("synthetic second-target failure");
			}
		}
		if (method === "DELETE" && !path.includes(".obsidian-")) {
			throw new Error("synthetic rollback unavailable");
		}
	};
	try {
		await assert.rejects(transition(a, flow, kind));
	} finally {
		disk.beforeRequest = undefined;
	}
}

/** Observe real PBKDF2 calls and restore the original property exactly. */
export function observeDerivations() {
	const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
	const descriptor = Object.getOwnPropertyDescriptor(
		crypto.subtle,
		"deriveBits",
	);
	const observer = {
		count: 0,
		restore() {
			if (descriptor) {
				Object.defineProperty(crypto.subtle, "deriveBits", descriptor);
			} else {
				Reflect.deleteProperty(crypto.subtle, "deriveBits");
			}
		},
	};
	crypto.subtle.deriveBits = (
		...args: Parameters<SubtleCrypto["deriveBits"]>
	) => {
		if ((args[0] as Algorithm).name === "PBKDF2") {
			observer.count++;
		}
		return derive(...args);
	};
	return observer;
}

/** Retry recovery in a fresh maintenance session for every invocation. */
export function recoverTransition(a: Device, flow: Flow) {
	return a.engine.runExclusiveMaintenance(() =>
		flow.workflow.recovery.recoverEncryptionTransition(),
	);
}

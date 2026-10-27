import assert from "node:assert/strict";
import test from "node:test";
import { YandexApiError } from "../src/api/yandex-client";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	legacyEncryptionFlow as encryptionFlow,
	startupFlow,
} from "./helpers/encryption-flow";
import { MemoryDisk, bytes, device, managedDevices } from "./helpers/sync-flow";
import { isRemoteReadTimeout, OperationFailure } from "../src/errors";
import { SyncScheduler } from "../src/sync/scheduler";
import { EncryptionManager } from "../src/crypto/encryption-manager";
import type { StartupReadSession } from "../src/sync/canonical/manager";
import { InvalidCurrentIndexError } from "../src/sync/canonical/errors";

import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";
import {
	assertTransitionIdentity,
	transition as runTransition,
	interruptTransition,
	observeDerivations,
	recoverTransition,
	transitionSource,
} from "./helpers/encryption-scenarios";

test("encryption recovery only falls back after a canonical decode mismatch", async (t) => {
	const gate = deferred();
	afterTest(t, () => gate.resolve());
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "device-a", null);
	const ea = encryptionFlow(a);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	const lateReply = deferred();
	await interruptTransition(disk, a, ea, "rotate");
	const transition = structuredClone(ea.context.getTransition());
	assert.equal(transition?.phase, "prepared");
	const before = structuredClone(disk.files);
	const sourceCanonical = await a.canonical();
	const local = a.index.captureLocalCausalState();
	let downloads = 0;
	let manifests = 0;
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (endpoint === "/download" && path === canonicalPath) {
			downloads++;
			await gate.promise;
		}
	};
	disk.afterRequest = async (_method, endpoint, path) => {
		if (endpoint === "/download" && path === canonicalPath) {
			lateReply.resolve();
		}
		if (
			endpoint === "/download" &&
			path === "vault/.obsidian-encrypt.json"
		) {
			manifests++;
		}
	};
	const recover = () => recoverTransition(a, ea);
	const readStable = a.client.downloadStableRawFile.bind(a.client);
	const expectedCanonical = await a.client.getResource(
		canonicalPath,
		1,
		0,
		true,
	);
	assert.ok(expectedCanonical);
	a.client.downloadStableRawFile = (path, expected, budget) =>
		readStable(
			path,
			path === canonicalPath ? expectedCanonical : expected,
			path === canonicalPath
				? { deadline: Date.now() + 15, timeoutMs: 15 }
				: budget,
		);
	try {
		await assert.rejects(recover(), (error) => {
			const failure = new OperationFailure(error, {
				stage: "encryption-recovery",
				action: "read",
			});
			assert.equal(failure.summary.code, "remote-read-timeout");
			assert.equal(failure.summary.requestState, "unresolved");
			return isRemoteReadTimeout(error);
		});
	} finally {
		a.client.downloadStableRawFile = readStable;
	}
	assert.equal(manifests, 1);
	assert.equal(downloads, 1);
	gate.resolve();
	await lateReply.promise;
	assert.deepEqual(disk.files, before);
	assert.deepEqual(ea.context.getTransition(), transition);
	assert.deepEqual(a.index.captureLocalCausalState(), local);
	disk.afterRequest = undefined;
	downloads = 0;
	disk.beforeRequest = async (_method, endpoint, path) => {
		if (endpoint === "/download" && path === canonicalPath) {
			downloads++;
		}
	};
	const persist = ea.context.persist.bind(ea.context);
	const failure = new Error("synthetic codec persistence failure");
	ea.context.persist = async () => {
		throw failure;
	};
	try {
		await assert.rejects(recover(), (error) => error === failure);
		assert.equal(downloads, 0);
	} finally {
		ea.context.persist = persist;
	}
	const invalid = { ...sourceCanonical, deviceId: "" };
	const malformed = await ea.context
		.getService()!
		.encrypt(bytes(JSON.stringify(invalid)));
	disk.files.set(canonicalPath, malformed);
	await assert.rejects(recover(), InvalidCurrentIndexError);
	assert.equal(downloads, 1);
	assert.deepEqual(disk.files.get(canonicalPath), malformed);
	assert.deepEqual(ea.context.getTransition(), transition);
	disk.files.set(canonicalPath, before.get(canonicalPath)!);
	disk.beforeRequest = undefined;
	await recover();
	assert.equal(ea.context.getTransition(), null);
	assert.equal((await a.canonical()).maintenance, undefined);
	await a.full();
	await a.assertSettled({ "A.md": "alpha", "B.md": "beta" });
});

// The existing controller tests do not execute mode preparation, snapshot ports,
// admission and coherent restart together. These flows protect that domain boundary.
test("encryption workflow preserves exact bytes through enable rotate restart and disable", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const b = device(disk, "device-b", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	try {
		a.vault.put("Folder/Note.md", bytes("authoritative bytes"));
		await a.full();
		await runTransition(a, ea, "enable", "first-password");
		await a.assertSettled({ "Folder/Note.md": "authoritative bytes" });
		assert.equal(ea.context.getTransition(), null);
		const firstPath = await a.client.getPhysicalPath(
			"vault/Folder/Note.md",
		);
		const before = structuredClone(disk.files);
		const settings = structuredClone(b.settings);
		await assert.rejects(eb.workflow.connectForSync("wrong-password"));
		assert.deepEqual(b.settings, settings);
		assert.equal(eb.context.getService(), null);
		assert.deepEqual(disk.files, before);
		await runTransition(a, ea, "rotate", "second-password");
		assert.equal(disk.files.has(firstPath), false);
		await a.assertSettled({ "Folder/Note.md": "authoritative bytes" });
		await eb.workflow.connectForSync("second-password");
		await b.full();
		await b.assertSettled({ "Folder/Note.md": "authoritative bytes" });
		const saved = await eb.saved();
		await b.stop();
		const restarted = device(disk, "device-b", null, b.vault, saved.device);
		Object.assign(restarted.settings, saved.settings);
		const er = encryptionFlow(restarted);
		er.context.setTransition(saved.transition);
		try {
			await er.workflow.initEncryption();
			await restarted.full();
			await restarted.assertSettled({
				"Folder/Note.md": "authoritative bytes",
			});
			assert.deepEqual(await runTransition(a, ea, "disable"), {
				hadErrors: false,
			});
			assert.equal(
				await er.workflow.admission.ensureEncryptionReady({
					prompt: false,
					allowRecovery: false,
				}),
				false,
			);
			assert.equal(restarted.settings.enableEncryption, true);
			assert.equal(
				await er.workflow.admission.ensureEncryptionReady({
					prompt: true,
				}),
				true,
			);
			await restarted.full();
			await a.assertSettled({ "Folder/Note.md": "authoritative bytes" });
			await restarted.assertSettled({
				"Folder/Note.md": "authoritative bytes",
			});
			assert.deepEqual(
				disk.files.get("vault/Folder/Note.md"),
				bytes("authoritative bytes"),
			);
			assert.equal(
				[...disk.files.keys()].some((path) =>
					path.includes("/.backup/"),
				),
				false,
			);
		} finally {
			await restarted.stop();
		}
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("encryption admission shares a prompt and rejects revoked password or derivation results", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const ea = encryptionFlow(a);
	try {
		a.vault.put("Note.md", bytes("kept"));
		await a.full();
		await runTransition(a, ea, "enable", "password");
		const manifest = await a.index.downloadEncryptionManifest();
		assert.ok(manifest);
		const before = structuredClone(disk.files);
		for (const { boundary, revoke } of [
			{ boundary: "password", revoke: "unload" },
			{ boundary: "derivation", revoke: "unload" },
			{ boundary: "password", revoke: "token" },
			{ boundary: "password", revoke: "path" },
			{ boundary: "password", revoke: "codec" },
			{ boundary: "password", revoke: "pause" },
			{ boundary: "derivation", revoke: "pause" },
		]) {
			const b = device(disk, "device-b", null);
			const eb = encryptionFlow(b);
			try {
				const saved = await eb.saved();
				let shown = 0;
				const password = deferred<string>();
				eb.context.ui.requestPassword = () => {
					shown++;
					return password.promise;
				};
				const entered = deferred();
				const gate = deferred();
				const create = eb.context.manager.createCodec.bind(
					eb.context.manager,
				);
				if (boundary === "derivation") {
					eb.context.manager.createCodec = async (...args) => {
						const codec = await create(...args);
						entered.resolve();
						await gate.promise;
						return codec;
					};
				}
				const first = eb.workflow.admission.ensureEncryptionReady(
					{ prompt: true, allowRecovery: false },
					{ manifest },
				);
				const second = eb.workflow.admission.ensureEncryptionReady(
					{ prompt: true, allowRecovery: false },
					{ manifest },
				);
				assert.equal(shown, 1);
				if (boundary === "derivation") {
					password.resolve("password");
					await entered.promise;
				}
				if (revoke === "unload") {
					eb.cancel();
				} else if (revoke === "token") {
					b.client.setToken("replacement-token");
				} else if (revoke === "path") {
					b.client.setRemotePath("another-vault");
				} else if (revoke === "codec") {
					b.client.setEncryptionService(ea.context.getService());
				} else {
					b.engine.pause();
					b.engine.resume();
				}
				password.resolve("password");
				gate.resolve();
				assert.deepEqual(await Promise.all([first, second]), [
					false,
					false,
				]);
				assert.deepEqual(await eb.saved(), saved);
				assert.deepEqual(disk.files, before);
				assert.equal(eb.context.getService(), null);
			} finally {
				await b.stop();
			}
		}
	} finally {
		await a.stop();
	}
});

test("committed encryption workflow recovers on another device before replaying offline work", async (t) => {
	const createDevice = managedDevices(t);
	for (const kind of ["enable", "disable"] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "device-a", null);
		const b = createDevice(disk, "device-b", null);
		const ea = encryptionFlow(a);
		const eb = encryptionFlow(b);
		a.vault.put("Note.md", bytes("target survives"));
		await a.full();
		await b.full();
		if (kind === "disable") {
			await runTransition(a, ea, "enable", "source-password");
		}
		b.vault.put("Offline.md", bytes("offline addition"));
		b.index.enqueueMutation("put", "Offline.md", {
			sha256: await computeSha256(bytes("offline addition")),
		});
		await b.saved();
		const causal = b.index.captureLocalCausalState();
		let committed = false;
		let manifestRemoved = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				method === "POST" &&
				endpoint.endsWith("/resources/move") &&
				path === "vault/.obsidian-sync-index.json" &&
				a.index.getMaintenance()?.phase === "index-committed"
			) {
				committed = true;
			}
			if (
				committed &&
				method === "DELETE" &&
				path === "vault/.obsidian-encrypt.json"
			) {
				manifestRemoved = true;
			}
		};
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				kind === "enable" &&
				committed &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path === "vault/.obsidian-encrypt.json"
			) {
				throw new Error(
					"synthetic publication interrupted after commit",
				);
			}
			if (
				kind === "disable" &&
				manifestRemoved &&
				method === "DELETE" &&
				!path.includes(".obsidian-")
			) {
				throw new Error(
					"synthetic offline cleanup after manifest deletion",
				);
			}
		};
		if (kind === "enable") {
			await assert.rejects(runTransition(a, ea, kind));
		} else {
			assert.deepEqual(await runTransition(a, ea, kind), {
				hadErrors: true,
			});
			assert.equal(manifestRemoved, true);
			assert.equal(disk.files.has("vault/.obsidian-encrypt.json"), false);
		}
		assert.equal(committed, true);
		assert.equal(
			ea.context.getTransition()?.phase,
			kind === "enable" ? "index-committed" : "cleanup",
		);
		const saved = await ea.saved();
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		assert.equal(disk.files.has("vault/Note.md"), true);
		if (kind === "enable") {
			const manifest = await a.index.downloadEncryptionManifest();
			assert.ok(manifest);
			const savedBefore = await eb.saved();
			const stable =
				await ea.workflow.maintenance.createEncryptionManifest(
					ea.context.getService()!,
					manifest.salt,
					"enabled",
					manifest.revision,
				);
			for (const candidateManifest of [manifest, stable]) {
				await a.index.uploadEncryptionManifest(candidateManifest);
				const remoteBefore = structuredClone(disk.files);
				await assert.rejects(
					eb.workflow.connectForSync(
						"target-password",
						candidateManifest,
						{ allowRecovery: false },
					),
				);
				assert.deepEqual(await eb.saved(), savedBefore);
				assert.deepEqual(disk.files, remoteBefore);
				assert.equal(eb.context.getService(), null);
			}
			await a.index.uploadEncryptionManifest(manifest);
			await eb.workflow.connectForSync("target-password");
		} else {
			assert.equal(b.settings.encryptionPassword, null);
			assert.equal(
				await eb.workflow.recovery.tryRecoverRemoteTargetTransition(),
				true,
			);
		}
		assert.equal((await b.canonical()).maintenance, undefined);
		assert.equal(disk.files.has("vault/Note.md"), kind === "disable");
		assert.deepEqual(b.index.captureLocalCausalState(), causal);
		assert.deepEqual(
			await b.client.downloadFile("vault/Note.md"),
			bytes("target survives"),
		);
		assert.equal((await b.canonical()).files["Offline.md"], undefined);
		await a.stop();
		const restarted = createDevice(
			disk,
			"device-a",
			null,
			a.vault,
			saved.device,
		);
		Object.assign(restarted.settings, saved.settings);
		const er = encryptionFlow(restarted);
		er.context.setTransition(saved.transition);
		await er.workflow.initEncryption();
		if (kind === "disable") {
			const rawSource = `vault/${saved.transition!.sourceRawPaths[0]!}`;
			disk.files.set(rawSource, bytes("late foreign source"));
			const physical = structuredClone(disk.files);
			const retry = () => recoverTransition(restarted, er);
			await assert.rejects(retry(), /physical source/);
			assert.deepEqual(disk.files, physical);
			assert.ok(restarted.index.getPendingPhysicalActions().length > 0);
			disk.files.delete(rawSource);
			const load = restarted.index.loadRemoteIndex.bind(restarted.index);
			const lock = "vault/.obsidian-sync-index.lock.foreign.1";
			restarted.index.loadRemoteIndex = async (...args) => {
				const index = await load(...args);
				disk.files.set(
					lock,
					disk.files.get("vault/.obsidian-sync-index.json")!.slice(0),
				);
				return index;
			};
			let retirementWrites = 0;
			disk.beforeRequest = async (method) => {
				if (method !== "GET") {
					retirementWrites++;
				}
			};
			await assert.rejects(retry(), /locked/);
			assert.equal(retirementWrites, 0);
			assert.equal(disk.files.has(lock), true);
			assert.ok(restarted.index.getPendingPhysicalActions().length > 0);
			restarted.index.loadRemoteIndex = load;
			disk.beforeRequest = undefined;
			disk.files.delete(lock);
			const causal = restarted.index.captureLocalCausalState();
			const persist = er.context.persist.bind(er.context);
			er.context.persist = async () => {
				throw new Error("synthetic checkpoint persistence failure");
			};
			await assert.rejects(retry(), /checkpoint persistence failure/);
			er.context.persist = persist;
			assert.deepEqual(restarted.index.captureLocalCausalState(), causal);
			assert.equal(er.context.getTransition()?.id, saved.transition?.id);
		}
		const startup = startupFlow(restarted, er);
		await startup.runInvocation(async (invocation) => {
			const staleReads = invocation.reads!;
			assert.equal(
				await startup.refresh(false, true, invocation),
				"ready",
			);
			assert.notEqual(invocation.reads, staleReads);
			assert.throws(
				() => staleReads.assertCurrent(),
				/invocation ended|configuration changed/,
			);
		});
		assert.equal(er.context.getTransition(), null);
		await b.full();
		await restarted.full();
		const expected = {
			"Note.md": "target survives",
			"Offline.md": "offline addition",
		};
		await b.assertSettled(expected);
		await restarted.assertSettled(expected);
		assert.equal(
			[...disk.files.keys()].some((path) => path.includes("/.backup/")),
			false,
		);
	}
});

test("precommit rollback survives partial copy restart and ambiguous deletion without changing source work", async () => {
	for (const kind of ["enable", "disable"] as const) {
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", null);
		const b = device(disk, "device-b", null);
		const ea = encryptionFlow(a);
		const eb = encryptionFlow(b);
		let restarted: ReturnType<typeof device> | undefined;
		try {
			a.settings.maxConcurrency = 1;
			a.vault.put("Folder/A.md", bytes("alpha"));
			a.vault.put("Folder/B.md", bytes("beta"));
			await a.full();
			if (kind === "disable") {
				await runTransition(a, ea, "enable", "source-password");
				await eb.workflow.connectForSync("source-password");
			}
			await b.full();
			b.vault.put("OfflineB.md", bytes("offline b"));
			const sourceCanonical = await a.canonical();
			const sourcePaths = await Promise.all(
				["Folder/A.md", "Folder/B.md"].map((path) =>
					a.client.getPhysicalPath(`vault/${path}`),
				),
			);
			const sourceBytes = sourcePaths.map((path) =>
				disk.files.get(path)!.slice(0),
			);
			let writes = 0;
			let removedTarget: string | undefined;
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
					if (kind === "disable") {
						disk.files.delete(path);
						removedTarget = path;
					}
					throw new Error(
						"synthetic rollback DELETE response unavailable",
					);
				}
				if (method === "GET" && path === removedTarget) {
					throw new Error(
						"synthetic read-back unavailable after DELETE",
					);
				}
			};
			if (kind === "enable") {
				await assert.rejects(
					runTransition(a, ea, "enable", "target-password"),
				);
			} else {
				assert.deepEqual(await runTransition(a, ea, "disable"), {
					hadErrors: true,
				});
			}
			disk.beforeRequest = undefined;
			a.vault.put("OfflineA.md", bytes("offline a"));
			a.index.enqueueMutation("put", "OfflineA.md", {
				sha256: await computeSha256(bytes("offline a")),
			});
			const saved = await ea.saved();
			assert.equal(saved.transition?.phase, "prepared");
			assert.equal(
				Object.keys(saved.transition.targetFingerprints).length,
				1,
			);
			assert.equal(
				saved.device.pendingPhysicalActions.filter(
					(action) => action.origin === "encryption-cleanup",
				).length,
				1,
			);
			const id = saved.transition.id;
			const canonical = await a.canonical();
			assert.equal(canonical.maintenance?.id, id);
			assert.equal(canonical.maintenance?.targetRevision, null);
			assert.deepEqual(canonical.maintenance?.cleanup, []);
			assert.deepEqual(canonical.files, sourceCanonical.files);
			await a.stop();
			restarted = device(disk, "device-a", null, a.vault, saved.device);
			Object.assign(restarted.settings, saved.settings);
			const er = encryptionFlow(restarted);
			er.context.setTransition(saved.transition);
			await er.workflow.initEncryption();
			let lostResponse = false;
			disk.afterRequest = async (method, _endpoint, path) => {
				if (
					kind === "enable" &&
					method === "DELETE" &&
					!path.includes(".obsidian-") &&
					!lostResponse
				) {
					lostResponse = true;
					throw new Error("synthetic lost committed DELETE response");
				}
			};
			await recoverTransition(restarted, er);
			disk.afterRequest = undefined;
			assert.equal(
				kind === "enable" ? lostResponse : Boolean(removedTarget),
				true,
			);
			assert.equal(er.context.getTransition(), null);
			assert.equal(er.block(), null);
			const recovered = await restarted.canonical();
			assert.equal(recovered.maintenance, undefined);
			assert.equal(recovered.epoch, sourceCanonical.epoch);
			assert.deepEqual(recovered.files, sourceCanonical.files);
			assert.deepEqual(
				recovered.appliedMutationSeq,
				sourceCanonical.appliedMutationSeq,
			);
			const after = await restarted.saved();
			assert.deepEqual(after.localState, saved.device.localState);
			assert.deepEqual(
				after.pendingMutations,
				saved.device.pendingMutations,
			);
			assert.deepEqual(
				after.pendingWatcherEvents,
				saved.device.pendingWatcherEvents,
			);
			assert.deepEqual(after.pendingPhysicalActions, []);
			for (const [index, path] of sourcePaths.entries()) {
				assert.deepEqual(disk.files.get(path), sourceBytes[index]);
			}
			for (const path of Object.values(
				saved.transition.targetRawByLogicalPath,
			)) {
				assert.equal(disk.files.has(`vault/${path}`), false);
			}
			const manifest = await restarted.index.downloadEncryptionManifest();
			assert.equal(
				manifest?.state ?? null,
				kind === "enable" ? null : "enabled",
			);
			assert.equal(
				restarted.settings.enableEncryption,
				kind === "disable",
			);
			await restarted.full();
			await b.full();
			await restarted.full();
			const expected = {
				"Folder/A.md": "alpha",
				"Folder/B.md": "beta",
				"OfflineA.md": "offline a",
				"OfflineB.md": "offline b",
			};
			await restarted.assertSettled(expected);
			await b.assertSettled(expected);
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
			await restarted?.stop();
		}
	}
});

test("concurrent transition cleanup joins failed work before recovery and converges after restart", async (t) => {
	const createDevice = managedDevices(t);
	for (const kind of ["enable", "disable", "rotate"] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "cleanup-device", null);
		const flow = encryptionFlow(a);
		const expected = { "A.md": "alpha", "B.md": "beta", "C.md": "gamma" };
		const first = deferred();
		const other = deferred();
		const source = await transitionSource(a, flow, kind, expected);
		a.settings.maxConcurrency = 2;
		const started: string[] = [];
		const two = deferred<boolean>();
		const failureRead = deferred();
		let firstFailed = false;
		let recoveryCalls = 0;
		let settled = false;
		flow.workflow.recovery.recoverEncryptionTransition = async () => {
			recoveryCalls++;
			throw new Error("synthetic offline recovery");
		};
		disk.beforeRequest = async (method, _endpoint, path) => {
			if (
				method !== "DELETE" ||
				path.includes(".obsidian-") ||
				a.index.getMaintenance()?.phase !== "cleanup"
			) {
				return;
			}
			started.push(path);
			if (started.length === 1) {
				await first.promise;
				firstFailed = true;
				throw new Error("synthetic first DELETE failure");
			}
			two.resolve(true);
			await other.promise;
		};
		disk.afterRequest = async (method, _endpoint, path) => {
			if (firstFailed && method === "GET" && path === started[0]) {
				failureRead.resolve();
			}
		};
		const operation = runTransition(a, flow, kind)
			.then(
				(result) => {
					if (kind === "disable") {
						assert.deepEqual(result, { hadErrors: true });
					}
					return null;
				},
				(error: unknown) => error,
			)
			.finally(() => {
				settled = true;
			});
		const timeout = setTimeout(() => two.resolve(false), 1000);
		let concurrent: boolean;
		try {
			concurrent = await two.promise;
			if (concurrent) {
				first.resolve();
				await failureRead.promise;
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(
					settled,
					false,
					"in-flight DELETE still belongs to the transition",
				);
				assert.equal(
					recoveryCalls,
					0,
					"recovery must wait for sibling work",
				);
				assert.equal(started.length, 2);
			}
		} finally {
			clearTimeout(timeout);
			first.resolve();
			other.resolve();
		}
		const failure = await operation;
		assert.equal(
			concurrent,
			true,
			`${kind} cleanup should overlap independent DELETEs`,
		);
		if (kind !== "disable") {
			assert.match(String(failure), /first DELETE failure/);
		}
		assert.equal(started.length, 2, "failure must stop the third path");
		assert.equal(recoveryCalls, 1);
		assert.equal(flow.context.getTransition()?.phase, "cleanup");
		assert.ok(a.index.getPendingPhysicalActions().length > 0);
		const saved = await flow.saved();
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		await a.stop();
		const restarted = createDevice(
			disk,
			"cleanup-device",
			null,
			a.vault,
			saved.device,
		);
		Object.assign(restarted.settings, saved.settings);
		const recovered = encryptionFlow(restarted);
		recovered.context.setTransition(saved.transition);
		await recovered.workflow.initEncryption();
		await recoverTransition(restarted, recovered);
		await restarted.full();
		await restarted.assertSettled(expected);
		assertTransitionIdentity(await restarted.canonical(), source);
	}
});

test("cleanup lifetime rejects late DELETE after configuration ABA or host unload", async (t) => {
	const createDevice = managedDevices(t);
	for (const boundary of ["configuration", "unload"] as const) {
		const disk = new MemoryDisk();
		let stopped = false;
		const a = createDevice(
			disk,
			"lifetime-device",
			null,
			undefined,
			undefined,
			{},
			undefined,
			() => stopped,
		);
		const flow = encryptionFlow(a);
		const pending = deferred();
		const waiting = deferred();
		a.vault.put("Note.md", bytes("preserved"));
		await a.full();
		let deletes = 0;
		disk.beforeRequest = async (method, _endpoint, path) => {
			if (method === "DELETE" && !path.includes(".obsidian-")) {
				deletes++;
			}
		};
		a.client.setWriteGuard(async () => {
			await a.index.assertRemoteScope();
			if (
				a.index
					.getPendingPhysicalActions()
					.some((action) => action.origin === "encryption-cleanup")
			) {
				waiting.resolve();
				await pending.promise;
			}
		});
		flow.workflow.recovery.recoverEncryptionTransition = async () => {
			throw new Error("synthetic stopped recovery");
		};
		const operation = runTransition(a, flow, "enable", "password");
		await waiting.promise;
		const physical = structuredClone(disk.files);
		try {
			if (boundary === "configuration") {
				a.client.setRemotePath("other");
				a.client.setRemotePath("vault");
			} else {
				stopped = true;
				flow.cancel();
			}
		} finally {
			pending.resolve();
		}
		await assert.rejects(operation, /configuration changed|interrupted/);
		assert.equal(deletes, 0);
		assert.deepEqual(disk.files, physical);
		assert.equal(flow.context.getTransition()?.phase, "cleanup");
		assert.ok(a.index.getPendingPhysicalActions().length > 0);
	}
});

test("source rollback preserves rewritten targets and stops DELETE retry after authority revocation", async (t) => {
	const createDevice = managedDevices(t);
	for (const attack of ["rewritten", "revoked"] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "device-a", null, undefined, undefined, {
			maxRetries: 1,
		});
		const ea = encryptionFlow(a);
		await interruptTransition(disk, a, ea, "enable");
		const transition = ea.context.getTransition()!;
		const [target, fingerprint] = Object.entries(
			transition.targetFingerprints,
		)[0]!;
		const rawPath = `vault/${target}`;
		const canonical = await a.canonical();
		let deleteAttempts = 0;
		if (attack === "rewritten") {
			const codec = await ea.context.manager.createCodec(
				transition.target.profileId!,
				transition.target.salt!,
				transition.target.password!,
			);
			disk.files.set(rawPath, await codec.encrypt(bytes("alpha")));
		} else {
			disk.beforeRequest = async (method, _endpoint, path) => {
				if (method === "DELETE" && path === rawPath) {
					deleteAttempts++;
					disk.files.set(
						"vault/.obsidian-sync-index.json",
						bytes(
							JSON.stringify({
								...canonical,
								maintenance: {
									...canonical.maintenance,
									id: "foreign-operation",
								},
							}),
						),
					);
					throw new YandexApiError(
						"synthetic transient DELETE failure",
						503,
					);
				}
			};
		}
		const targetBytes = disk.files.get(rawPath)!.slice(0);
		await assert.rejects(
			recoverTransition(a, ea),
			attack === "rewritten"
				? /fingerprint.*changed/i
				: /authority changed/i,
		);
		assert.equal(deleteAttempts, attack === "revoked" ? 1 : 0);
		assert.deepEqual(disk.files.get(rawPath), targetBytes);
		assert.deepEqual(disk.files.get("vault/A.md"), bytes("alpha"));
		assert.deepEqual(disk.files.get("vault/B.md"), bytes("beta"));
		assert.equal(ea.context.getTransition()?.id, transition.id);
		assert.equal(ea.context.getTransition()?.phase, "prepared");
		assert.equal(transition.targetFingerprints[target], fingerprint);
		assert.ok(ea.block());
		assert.equal(
			a.index
				.getPendingPhysicalActions()
				.filter((action) => action.origin === "encryption-cleanup")
				.length,
			1,
		);
	}
});

test("completed source rollback retires its stale checkpoint without acquiring deletion authority", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "device-a", null);
	const ea = encryptionFlow(a);
	await interruptTransition(disk, a, ea, "enable");
	let checkpoint = await ea.saved();
	const transitionId = checkpoint.transition!.id;
	const target = Object.keys(checkpoint.transition!.targetFingerprints)[0]!;
	const pinnedBytes = disk.files.get(`vault/${target}`)!.slice(0);
	ea.context.persist = async () => {
		if (!ea.context.getTransition()) {
			throw new Error("synthetic final local save failure");
		}
		checkpoint = await ea.saved();
	};
	await assert.rejects(recoverTransition(a, ea), /final local save failure/);
	assert.equal((await a.canonical()).maintenance, undefined);
	assert.equal(ea.context.getTransition()?.id, transitionId);
	assert.equal(checkpoint.transition!.id, transitionId);
	assert.equal(checkpoint.transition!.phase, "prepared");
	assert.deepEqual(checkpoint.device.pendingPhysicalActions, []);
	await a.stop();
	const restarted = createDevice(
		disk,
		"device-a",
		null,
		a.vault,
		checkpoint.device,
	);
	Object.assign(restarted.settings, checkpoint.settings);
	const er = encryptionFlow(restarted);
	er.context.setTransition(checkpoint.transition);
	await er.workflow.initEncryption();
	const rawPath = `vault/${target}`;
	disk.files.set(rawPath, pinnedBytes);
	const pinned = structuredClone(disk.files);
	await assert.rejects(
		recoverTransition(restarted, er),
		/no canonical authority/,
	);
	assert.deepEqual(disk.files, pinned);
	disk.files.set(rawPath, bytes("foreign replacement"));
	const foreign = structuredClone(disk.files);
	await assert.rejects(recoverTransition(restarted, er));
	assert.deepEqual(disk.files, foreign);
	assert.equal(er.context.getTransition()?.id, transitionId);
	disk.files.delete(rawPath);
	const completed = structuredClone(disk.files);
	await recoverTransition(restarted, er);
	assert.deepEqual(disk.files, completed);
	assert.equal(er.context.getTransition(), null);
	assert.deepEqual(await restarted.saved(), checkpoint.device);
	await restarted.full();
	await restarted.assertSettled({ "A.md": "alpha", "B.md": "beta" });
});

test("authenticated startup candidate installs once and rejects wrong credentials before persistence", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const b = device(disk, "device-b", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	let derivations: ReturnType<typeof observeDerivations> | undefined;
	try {
		a.vault.put("Note.md", bytes("preserved plaintext"));
		await a.full();
		await runTransition(a, ea, "enable", "target-password");
		derivations = observeDerivations();
		await eb.workflow.connectForSync("target-password");
		assert.equal(
			derivations.count,
			1,
			"install must reuse the authenticated candidate",
		);
		const active = eb.context.getService();
		const saved = await eb.saved();
		derivations.count = 0;
		await eb.workflow.connectForSync("target-password");
		assert.equal(
			derivations.count,
			0,
			"matching active candidate needs no PBKDF2",
		);
		assert.equal(eb.context.getService(), active);
		const persist = eb.context.persist.bind(eb.context);
		const failure = new Error("synthetic install save failure");
		eb.context.persist = async () => {
			throw failure;
		};
		await assert.rejects(
			eb.workflow.connectForSync("target-password"),
			(error) => error === failure,
		);
		assert.equal(eb.context.getService(), active);
		assert.deepEqual(await eb.saved(), saved);
		eb.context.persist = persist;
		const foreign = await new EncryptionManager().createCodec(
			"hardened",
			b.settings.encryptionSalt!,
			"wrong-password",
		);
		const installed = await eb.context.manager.applySnapshot(
			{ ...b.settings },
			eb.context.manager.captureSnapshot(b.settings),
			foreign,
		);
		assert.notEqual(installed, foreign);
		const manifest = await b.index.downloadEncryptionManifest();
		assert.equal(await installed!.verifyVerifier(manifest!.verifier), true);
		await assert.rejects(eb.workflow.connectForSync("wrong-password"));
		assert.equal(eb.context.getService(), active);
		assert.deepEqual(await eb.saved(), saved);
		await b.full();
		await b.assertSettled({ "Note.md": "preserved plaintext" });
	} finally {
		derivations?.restore();
		await a.stop();
		await b.stop();
	}
});

test("startup invocation shares authenticated service bytes and expires before drift or a future full", async () => {
	const derivations = observeDerivations();
	try {
		for (const encrypted of [false, true]) {
			const disk = new MemoryDisk();
			const a = device(disk, "device-a", null);
			const ea = encryptionFlow(a);
			try {
				a.vault.put("Note.md", bytes("unchanged"));
				await a.full();
				if (encrypted) {
					await runTransition(a, ea, "enable", "target-password");
				}
				const startup = startupFlow(a, ea);
				if (!encrypted) {
					const raw = disk.files.get(
						"vault/.obsidian-sync-index.json",
					)!;
					disk.files.set("vault/.obsidian-sync-index.lock.a.1", raw);
					disk.files.set("vault/.obsidian-sync-index.lock.b.1", raw);
					const before = structuredClone(disk.files);
					assert.equal(
						await startup.refresh(false, false),
						"ready",
						"read-only startup classification must not enter lock recovery",
					);
					assert.deepEqual(disk.files, before);
					disk.files.delete("vault/.obsidian-sync-index.lock.a.1");
					disk.files.delete("vault/.obsidian-sync-index.lock.b.1");
				}
				let canonicalBodies = 0,
					manifestBodies = 0;
				const observeReads: NonNullable<
					MemoryDisk["beforeRequest"]
				> = async (_method, endpoint, path) => {
					if (
						endpoint === "/download" &&
						path.endsWith(".obsidian-sync-index.json")
					) {
						canonicalBodies++;
					}
					if (
						endpoint === "/download" &&
						path.endsWith(".obsidian-encrypt.json")
					) {
						manifestBodies++;
					}
				};
				disk.beforeRequest = observeReads;
				for (let run = 1; run <= 2; run++) {
					startup.validated = false;
					derivations.count = 0;
					let expired: StartupReadSession | undefined;
					await startup.runInvocation(async (invocation) => {
						assert.equal(
							await startup.refresh(false, true, invocation),
							"ready",
						);
						expired = invocation.reads!;
						const result = await a.engine.fullSync(
							undefined,
							invocation.reads,
						);
						assert.equal(result.success, true);
					});
					assert.throws(
						() => expired!.assertCurrent(),
						/invocation ended|configuration changed/,
					);
					assert.equal(
						derivations.count,
						0,
						"stable startup must not derive the matching active codec again",
					);
					assert.equal(canonicalBodies, run);
					assert.equal(manifestBodies, encrypted ? run : 0);
					disk.beforeRequest = undefined;
					await a.assertSettled({ "Note.md": "unchanged" });
					disk.beforeRequest = observeReads;
				}
				// Exercise the actual scheduler timer, whose admission goes directly through engine full.
				const scheduler = new SyncScheduler(a.engine, {
					...a.settings,
					syncInterval: 0.001,
				});
				const full = a.engine.fullSync.bind(a.engine);
				const tick = deferred<boolean>();
				a.engine.fullSync = async (...args) => {
					try {
						const result = await full(...args);
						tick.resolve(result.success);
						return result;
					} catch (error) {
						tick.resolve(false);
						throw error;
					}
				};
				const counts = [canonicalBodies, manifestBodies];
				derivations.count = 0;
				try {
					scheduler.start();
					assert.equal(await tick.promise, true);
				} finally {
					scheduler.stop();
					a.engine.fullSync = full;
				}
				assert.equal(canonicalBodies, counts[0]! + 1);
				assert.equal(manifestBodies, counts[1]! + (encrypted ? 1 : 0));
				assert.equal(derivations.count, 0);
				const local = a.index.captureLocalCausalState();
				for (const boundary of ["token", "pause"]) {
					await startup.runInvocation(async (invocation) => {
						await invocation.reads!.manifest();
						if (boundary === "token") {
							a.client.setToken("changed");
							a.client.setToken("synthetic");
						} else {
							a.engine.pause();
							a.engine.resume();
						}
						await assert.rejects(
							invocation.reads!.manifest(),
							/configuration changed|interrupted/,
						);
					});
				}
				assert.deepEqual(a.index.captureLocalCausalState(), local);
				if (encrypted) {
					const resource = disk.resource.bind(disk);
					disk.resource = async (path) => {
						const item = await resource(path);
						if (item && path.endsWith(".obsidian-encrypt.json")) {
							delete item.sha256;
						}
						return item;
					};
					const beforeBodies = manifestBodies;
					await startup.runInvocation(async (invocation) => {
						await invocation.reads!.manifest();
						await invocation.reads!.manifest();
					});
					assert.equal(
						manifestBodies,
						beforeBodies + 2,
						"mtime/size must not authorize manifest byte reuse",
					);
					disk.resource = resource;
					await startup.runInvocation(async (invocation) => {
						await invocation.reads!.manifest();
						await invocation.reads!.load();
						const manifest =
							await a.index.downloadEncryptionManifest();
						const wrong = await ea.context.manager.createCodec(
							"hardened",
							manifest!.salt,
							"wrong-password",
						);
						disk.files.set(
							"vault/.obsidian-encrypt.json",
							bytes(
								JSON.stringify({
									...manifest,
									verifier: await wrong.createVerifier(),
								}),
							),
						);
						const before = structuredClone(disk.files);
						const result = await a.engine.fullSync(
							undefined,
							invocation.reads,
						);
						assert.equal(result.success, false);
						assert.deepEqual(disk.files, before);
						assert.deepEqual(
							a.index.captureLocalCausalState(),
							local,
						);
					});
				} else {
					await a.assertSettled({ "Note.md": "unchanged" });
				}
			} finally {
				disk.beforeRequest = undefined;
				await a.stop();
			}
		}
	} finally {
		derivations.restore();
	}
});

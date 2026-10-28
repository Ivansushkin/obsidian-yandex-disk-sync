import assert from "node:assert/strict";
import { loadPluginData, PLUGIN_DATA_FORMAT } from "../src/plugin-data-loader";
import { computeSha256 } from "../src/utils/hash-utils";
import test from "node:test";
import { bytes, MemoryDisk, managedDevices } from "./helpers/sync-flow";
import { encryptionFlow, startupFlow } from "./helpers/encryption-flow";
import {
	transition,
	recoverTransition,
	transitionSource,
	type TransitionKind,
} from "./helpers/encryption-scenarios";
import { deferred } from "./helpers/deferred";
import { afterTest } from "./helpers/test-context";

test("manual admission rechecks rotated credentials after cached startup validation", async (t) => {
	const make = managedDevices(t);
	const disk = new MemoryDisk();
	const a = make(disk, "rotation-a", null);
	const b = make(disk, "rotation-b", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	a.vault.put("Note.md", bytes("preserved content"));
	await a.full();
	await transition(a, ea, "enable", "old-password");
	await eb.workflow.connectForSync("old-password");
	await b.full();
	const startup = startupFlow(b, eb);
	assert.equal(await startup.refresh(true), "ready");
	let shown = 0;
	eb.context.ui.requestPassword = async (_manifest, mode) => {
		assert.equal(mode, "rotated");
		shown++;
		return "new-password";
	};
	await transition(a, ea, "rotate", "new-password");
	assert.equal(await startup.refresh(true), "ready");
	assert.equal(shown, 1);
	await b.full();
	await b.assertSettled({ "Note.md": "preserved content" });
});

test("automatic password cancellation stays blocked and stale deferred requests cannot prompt", async (t) => {
	const make = managedDevices(t);
	for (const interruption of [
		"cancel",
		"wrong",
		"pause",
		"configuration",
		"unload",
	] as const) {
		const disk = new MemoryDisk();
		const a = make(disk, "rotation-a", null);
		const b = make(disk, "rotation-b", null);
		const ea = encryptionFlow(a);
		const eb = encryptionFlow(b);
		a.vault.put("Note.md", bytes("kept"));
		await a.full();
		await transition(a, ea, "enable", "old-password");
		await eb.workflow.connectForSync("old-password");
		await b.full();
		const startup = startupFlow(b, eb);
		await startup.refresh(true);
		await transition(a, ea, "rotate", "new-password");
		let shown = 0;
		eb.context.ui.requestPassword = async () => {
			shown++;
			return interruption === "cancel" ? null : "wrong-password";
		};
		eb.workflow.admission.configureAutomaticPasswordRequests({
			isAllowed: () => true,
			isBusy: () => b.engine.hasPendingWork(),
			runExclusive: async (action) => await action(),
			resume: async () => {
				throw new Error("Rejected credentials must not resume");
			},
		});
		assert.equal(
			await eb.workflow.admission.ensureEncryptionReady({
				prompt: false,
			}),
			false,
		);
		const remote = structuredClone(disk.files);
		const saved = await eb.saved();
		if (interruption === "pause") {
			b.engine.pause();
			b.engine.resume();
		} else if (interruption === "configuration") {
			b.client.setToken("replacement-synthetic-token");
		} else if (interruption === "unload") {
			eb.cancel();
		}
		await eb.workflow.admission.flushAutomaticPasswordRequest();
		await eb.workflow.admission.flushAutomaticPasswordRequest();
		const canRetry = interruption === "cancel" || interruption === "wrong";
		assert.equal(shown, canRetry ? 1 : 0);
		assert.deepEqual(disk.files, remote);
		assert.deepEqual(await eb.saved(), saved);
		if (canRetry) {
			await eb.workflow.admission.ensureEncryptionReady({
				prompt: false,
			});
			await eb.workflow.admission.flushAutomaticPasswordRequest();
			assert.equal(shown, 1);
			eb.context.ui.requestPassword = async () => {
				shown++;
				return "new-password";
			};
			assert.equal(await startup.refresh(true), "ready");
			assert.equal(shown, 2);
			await b.full();
			await b.assertSettled({ "Note.md": "kept" });
		}
	}
});

test("late verifier results cannot recreate a revoked automatic password request", async (t) => {
	const a = managedDevices(t)(new MemoryDisk(), "verifier-owner", null);
	const flow = encryptionFlow(a);
	await a.full();
	await transition(a, flow, "enable", "password");
	const manifest = await a.index.downloadEncryptionManifest();
	assert.ok(manifest);
	let shown = 0;
	flow.context.ui.requestPassword = async () => {
		shown++;
		return null;
	};
	flow.workflow.admission.configureAutomaticPasswordRequests({
		isAllowed: () => true,
		isBusy: () => false,
		runExclusive: async (action) => await action(),
		resume: async () => {
			throw new Error("Revoked validation must not resume");
		},
	});
	for (const boundary of ["pause", "configuration"] as const) {
		flow.workflow.admission.resetAutomaticPasswordRequests();
		const entered = deferred();
		const verifier = deferred<boolean>();
		const service = flow.context.getService()!;
		service.verifyVerifier = async () => {
			entered.resolve();
			return await verifier.promise;
		};
		const checking = flow.workflow.admission.ensureEncryptionReady(
			{ prompt: false },
			{ manifest },
		);
		await entered.promise;
		if (boundary === "pause") {
			a.engine.pause();
			a.engine.resume();
		} else {
			a.client.setToken("replacement-synthetic-token");
			flow.workflow.admission.resetAutomaticPasswordRequests();
		}
		verifier.resolve(false);
		assert.equal(await checking, false);
		await flow.workflow.admission.flushAutomaticPasswordRequest();
		assert.equal(shown, 0);
	}
});

test("new password rejection preserves transition sources before backup", async (t) => {
	const make = managedDevices(t);
	const disk = new MemoryDisk();
	const owner = make(disk, "password-owner", null);
	const flow = encryptionFlow(owner);
	owner.vault.put("Заметка.md", bytes("preserved content"));
	await owner.full();
	for (const kind of ["enable", "rotate"] as const) {
		const before = await flow.saved();
		const remote = structuredClone(disk.files);
		const local = structuredClone(owner.vault.files);
		const password = kind === "enable" ? "abc" : "🔐".repeat(31);
		await assert.rejects(
			owner.engine.runExclusiveMaintenance(() =>
				kind === "enable"
					? flow.workflow.enableEncryptionNow(password, "with-backup")
					: flow.workflow.rotateEncryptionPasswordNow(
							password,
							"with-backup",
						),
			),
			/4.*30/,
		);
		assert.deepEqual(disk.files, remote);
		assert.deepEqual(owner.vault.files, local);
		assert.deepEqual(await flow.saved(), before);
		await transition(
			owner,
			flow,
			kind,
			"🔐".repeat(kind === "enable" ? 4 : 30),
		);
		await owner.assertSettled({ "Заметка.md": "preserved content" });
	}
});

test("authoritative transitions keep the local reference and replace stale device work", async (t) => {
	const createDevice = managedDevices(t);
	for (const kind of ["enable", "disable", "rotate"] as TransitionKind[]) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const b = createDevice(disk, "b", null);
		const ea = encryptionFlow(a);
		const eb = encryptionFlow(b);
		startupFlow(a, ea);
		startupFlow(b, eb);
		a.vault.put("Folder/Note.md", bytes("reference"));
		await a.full();
		if (kind !== "enable") {
			await transition(a, ea, "enable", "source-password");
			await eb.workflow.connectForSync("source-password");
		}
		await b.full();
		b.vault.put("Foreign.md", bytes("remote-only"));
		await b.full();
		b.vault.put("Folder/Note.md", bytes("discarded local edit"));
		a.vault.put("Local.md", bytes("local-only"));
		a.watcher.loadDeferredEvents([
			{
				id: "owner-local",
				action: "upload",
				path: "Local.md",
				epoch: a.index.getObservedEpoch(),
				baseRevision: a.index.getLocalIndex().observedRevision,
				createdAt: 1,
			},
			{
				id: "owner-folder",
				action: "delete-folder",
				path: "Gone",
				epoch: a.index.getObservedEpoch(),
				baseRevision: a.index.getLocalIndex().observedRevision,
				createdAt: 2,
			},
		]);
		const before = await a.canonical();
		await transition(a, ea, kind);
		const canonical = await a.canonical();
		assert.notEqual(canonical.epoch, before.epoch);
		assert.equal(canonical.epochAdoption?.kind, "encryption-replacement");
		assert.deepEqual(Object.keys(canonical.files).sort(), [
			"Folder/Note.md",
			"Local.md",
		]);
		if (kind !== "disable") {
			await eb.workflow.connectForSync("target-password");
		}
		await b.full();
		await a.full();
		assert.equal(a.watcher.getDeferredEvents().length, 0);
		await b.assertSettled({
			"Folder/Note.md": "reference",
			"Local.md": "local-only",
		});
		assert.equal(b.vault.files.has("Foreign.md"), false);
	}
});

test("late full uploads are discarded by collapsed cleanup and cannot return from stale queues", async (t) => {
	const createDevice = managedDevices(t);
	for (const kind of ["enable", "disable", "rotate"] as TransitionKind[]) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const b = createDevice(disk, "b", null);
		const ea = encryptionFlow(a);
		const eb = encryptionFlow(b);
		startupFlow(a, ea);
		startupFlow(b, eb);
		const expected = {
			"Folder/Note.md": "reference",
			"Other/Keep.md": "keep",
			"Root.md": "root",
		};
		for (const [path, content] of Object.entries(expected)) {
			a.vault.put(path, bytes(content));
		}
		await a.full();
		if (kind !== "enable") {
			await transition(a, ea, "enable", "source-password");
			await eb.workflow.connectForSync("source-password");
		}
		await b.full();
		const changes = ["Folder/Note.md", "Folder/New.md", "NewFolder/New.md"];
		const sourcePaths = await Promise.all(
			changes.map((path) => b.client.getPhysicalPath(`vault/${path}`)),
		);
		for (const path of changes) {
			b.vault.put(path, bytes("discarded"));
		}
		const entered = deferred();
		const release = deferred();
		const deleting = deferred();
		const continueDelete = deferred();
		afterTest(t, () => {
			release.resolve();
			continueDelete.resolve();
		});
		let uploads = 0;
		let heldDelete = false;
		const deletes: string[] = [];
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				sourcePaths.includes(path)
			) {
				if (++uploads === changes.length) {
					entered.resolve();
				}
				await release.promise;
			}
			if (method === "DELETE" && !path.includes(".obsidian-")) {
				deletes.push(path);
				if (!heldDelete) {
					heldDelete = true;
					deleting.resolve();
					await continueDelete.promise;
				}
			}
		};
		const full = b.engine.fullSync();
		await Promise.race([
			entered.promise,
			full.then(() => {
				throw new Error("Full finished before its PUT barrier");
			}),
		]);
		const replacement = transition(a, ea, kind);
		await Promise.race([
			deleting.promise,
			replacement.then(() => {
				throw new Error("Replacement finished before DELETE barrier");
			}),
		]);
		release.resolve();
		assert.equal((await full).success, false);
		assert.equal(b.index.getPendingMutations().length, changes.length);
		const targetPath = await a.client.getPhysicalPath(
			"vault/Folder/Note.md",
		);
		disk.files.set(targetPath, bytes("late target overwrite"));
		continueDelete.resolve();
		await replacement;
		disk.beforeRequest = undefined;
		assert.ok(
			deletes.some(
				(path) =>
					path ===
					sourcePaths[0]!.slice(0, sourcePaths[0]!.lastIndexOf("/")),
			),
		);
		assert.equal(deletes.includes(sourcePaths[0]!), false);
		if (kind !== "disable") {
			await eb.workflow.connectForSync("target-password");
		}
		await b.full();
		await a.full();
		await a.assertSettled(expected);
		await b.assertSettled(expected);
		assert.equal(b.vault.files.has("Folder/New.md"), false);
		assert.equal(b.vault.files.has("NewFolder/New.md"), false);
	}
});

test("authoritative cleanup resumes after restart in its new epoch", async (t) => {
	const createDevice = managedDevices(t);
	for (const kind of ["enable", "disable", "rotate"] as TransitionKind[]) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		const expected = {
			"Folder/Note.md": "reference",
			"Folder/Other.md": "other reference",
		};
		for (const [path, content] of Object.entries(expected)) {
			a.vault.put(path, bytes(content));
		}
		await a.full();
		disk.folders.add("vault/LegacyEmpty");
		disk.folders.add("vault/LegacyEmpty/Nested");
		if (kind !== "enable") {
			await transition(a, flow, "enable", "source-password");
		}
		let damaged = false;
		let hashless = "";
		const resource = disk.resource.bind(disk);
		disk.resource = async (path) => {
			const current = await resource(path);
			if (path === hashless && current) {
				delete current.sha256;
				delete current.md5;
			}
			return current;
		};
		const collect = a.client.collectLogicalMetadata.bind(a.client);
		a.client.collectLogicalMetadata = async (...args) => {
			if (!damaged && a.index.getMaintenance()?.phase === "cleanup") {
				damaged = true;
				const missing = await a.client.getPhysicalPath(
					"vault/Folder/Note.md",
				);
				hashless = await a.client.getPhysicalPath(
					"vault/Folder/Other.md",
				);
				disk.files.delete(missing);
				disk.files.set(hashless, bytes("foreign unverified bytes"));
			}
			return collect(...args);
		};
		const upload = a.client.uploadFile.bind(a.client);
		a.client.uploadFile = async (...args) => {
			if (damaged && args[0] === "vault/Folder/Note.md") {
				throw new Error("synthetic repair interruption");
			}
			return upload(...args);
		};
		try {
			await transition(a, flow, kind);
		} catch {
			/* The interrupted operation retains recovery. */
		}
		const saved = await flow.saved();
		assert.equal(saved.transition?.phase, "cleanup");
		assert.doesNotThrow(() =>
			loadPluginData({
				format: PLUGIN_DATA_FORMAT,
				settings: saved.settings,
				...saved.device,
				encryptionTransition: saved.transition,
				forceRecovery: null,
				lastSyncStats: {},
			}),
		);
		assert.notEqual(
			saved.device.localState.observedEpoch,
			saved.transition.replacement!.targetEpoch,
		);
		assert.equal(damaged, true);
		await a.stop();
		const restarted = createDevice(disk, "a", null, a.vault, saved.device);
		Object.assign(restarted.settings, saved.settings);
		const recovery = encryptionFlow(restarted);
		recovery.context.setTransition(saved.transition);
		await recovery.workflow.initEncryption();
		await recoverTransition(restarted, recovery);
		assert.equal(recovery.context.getTransition(), null);
		await restarted.assertSettled(expected);
	}
});

test("replacement preserves excluded old-codec bytes and protected descendants across all modes", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const flow = encryptionFlow(a);
	a.vault.put("Mixed/Note.md", bytes("reference"));
	a.vault.put("Mixed/Excluded.md", bytes("excluded"));
	await a.full();
	disk.folders.add("vault/Mixed/.backup");
	disk.files.set("vault/Mixed/.backup/Keep.md", bytes("protected"));
	await transition(a, flow, "enable", "source-password");
	assert.deepEqual(
		disk.files.get("vault/Mixed/.backup/Keep.md"),
		bytes("protected"),
	);
	const excludedRaw = await a.client.getPhysicalPath(
		"vault/Mixed/Excluded.md",
	);
	const excludedBytes = disk.files.get(excludedRaw)!.slice(0);
	a.settings.excludePatterns = ["Mixed/Excluded.md"];
	disk.folders.add("vault/Mixed");
	disk.folders.add("vault/Mixed/.backup");
	disk.files.set("vault/Mixed/.backup/Keep.md", bytes("protected"));
	await transition(a, flow, "rotate");
	await transition(a, flow, "disable");
	assert.deepEqual(disk.files.get(excludedRaw), excludedBytes);
	assert.deepEqual(
		disk.files.get("vault/Mixed/.backup/Keep.md"),
		bytes("protected"),
	);
	assert.equal((await a.engine.fullSync()).success, true);
	assert.deepEqual(Object.keys((await a.canonical()).files), [
		"Mixed/Note.md",
	]);
});

test("a second device completes committed disable without the source key and the owner retires read-only", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const b = createDevice(disk, "b", null);
	const flow = encryptionFlow(a);
	const foreign = encryptionFlow(b);
	startupFlow(b, foreign);
	a.vault.put("Folder/Note.md", bytes("reference"));
	await a.full();
	await b.full();
	await transition(a, flow, "enable", "source-password");
	disk.beforeRequest = async (method, _endpoint, path) => {
		if (method === "DELETE" && !path.includes(".obsidian-")) {
			throw new Error("synthetic interruption");
		}
	};
	await transition(a, flow, "disable");
	const saved = await flow.saved();
	assert.equal(saved.transition?.phase, "cleanup");
	assert.equal(disk.files.has("vault/.obsidian-encrypt.json"), false);
	disk.beforeRequest = undefined;
	b.vault.put("Offline.md", bytes("discarded"));
	await foreign.workflow.recovery.recoverRemotePlaintextTargetTransition(
		null,
		null,
	);
	assert.equal((await a.canonical()).maintenance, undefined);
	await recoverTransition(a, flow);
	assert.equal(flow.context.getTransition(), null);
	await a.assertSettled({ "Folder/Note.md": "reference" });
	await b.full();
	await b.assertSettled({ "Folder/Note.md": "reference" });
	assert.equal(b.vault.files.has("Offline.md"), false);
});

test("target metadata checks overlap within the transition limit", async (t) => {
	const createDevice = managedDevices(t);
	for (const [kind, limit] of [
		["enable", 1],
		["enable", 4],
		["disable", 4],
		["rotate", 4],
	] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		const expected = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [
				`Folder${i}/Note.md`,
				`reference${i}`,
			]),
		);
		await transitionSource(a, flow, kind, expected);
		a.settings.maxConcurrency = limit;
		const entered = deferred();
		const release = deferred();
		afterTest(t, () => release.resolve());
		let active = 0;
		let peak = 0;
		const get = a.client.getResource.bind(a.client);
		a.client.getResource = async (...args) => {
			if (
				a.index.getMaintenance()?.phase !== "cleanup" ||
				!disk.files.has(args[0]) ||
				args[0].includes(".obsidian-")
			) {
				return get(...args);
			}
			active++;
			peak = Math.max(peak, active);
			entered.resolve();
			try {
				await release.promise;
				return await get(...args);
			} finally {
				active--;
			}
		};
		const operation = transition(a, flow, kind);
		await Promise.race([
			entered.promise,
			operation.then(() => {
				throw new Error("No target metadata check");
			}),
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const observedPeak = peak;
		release.resolve();
		await operation;
		assert.equal(
			observedPeak,
			limit,
			`${kind}: target metadata must overlap`,
		);
		assert.ok(peak <= limit);
		await a.assertSettled(expected);
	}
});

test("metadata failure joins reads before revocation and retains restartable target authority", async (t) => {
	const createDevice = managedDevices(t);
	for (const [kind, interruption] of [
		["enable", "configuration"],
		["disable", "pause"],
		["rotate", "unload"],
	] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		const expected = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [
				`Folder${i}/Note.md`,
				`reference${i}`,
			]),
		);
		await transitionSource(a, flow, kind, expected);
		a.settings.maxConcurrency = 4;
		const admitted = deferred();
		const failed = deferred();
		const release = deferred();
		afterTest(t, () => release.resolve());
		let started = 0;
		let finished = false;
		let revoked = false;
		let lateWrites = 0;
		const get = a.client.getLogicalResource.bind(a.client);
		a.client.getLogicalResource = async (...args) => {
			const ordinal = started++;
			if (started === 4) {
				admitted.resolve();
			}
			await admitted.promise;
			if (ordinal === 0) {
				failed.resolve();
				throw new Error("first metadata failure");
			}
			await release.promise;
			return get(...args);
		};
		disk.beforeRequest = async (method) => {
			lateWrites += Number(revoked && method !== "GET");
		};
		const operation = transition(a, flow, kind).finally(() => {
			finished = true;
		});
		const outcome =
			kind === "disable"
				? operation.then((result) =>
						assert.deepEqual(result, { hadErrors: true }),
					)
				: assert.rejects(operation);
		await Promise.race([
			failed.promise,
			operation.then(() => {
				throw new Error("No metadata failure barrier");
			}),
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(started, 4);
		assert.equal(finished, false);
		if (interruption === "configuration") {
			const codec = flow.context.getService();
			a.client.setEncryptionService(null);
			a.client.setEncryptionService(codec);
		} else if (interruption === "pause") {
			a.engine.pause();
			a.engine.resume();
		} else {
			flow.cancel();
		}
		revoked = true;
		release.resolve();
		await outcome;
		assert.equal(
			lateWrites,
			0,
			"revocation cannot start recovery under a new lifetime",
		);
		assert.equal(flow.context.getTransition()?.phase, "cleanup");
		const saved = await flow.saved();
		disk.beforeRequest = undefined;
		await a.stop();
		const restarted = createDevice(disk, "a", null, a.vault, saved.device);
		Object.assign(restarted.settings, saved.settings);
		const recovery = encryptionFlow(restarted);
		recovery.context.setTransition(saved.transition);
		await recovery.workflow.initEncryption();
		await recoverTransition(restarted, recovery);
		assert.equal(recovery.context.getTransition(), null);
		await restarted.assertSettled(expected);
	}
});

test("collapsed cleanup caps dispatch, joins in-flight deletes and replays ambiguous results", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const flow = encryptionFlow(a);
	const expected = Object.fromEntries(
		Array.from({ length: 6 }, (_, i) => [
			`Folder${i}/Note.md`,
			`reference${i}`,
		]),
	);
	for (const [path, content] of Object.entries(expected)) {
		a.vault.put(path, bytes(content));
	}
	await a.full();
	a.settings.maxConcurrency = 20;
	const entered = deferred();
	const release = deferred();
	const firstFailed = deferred();
	afterTest(t, () => release.resolve());
	let active = 0;
	let peak = 0;
	const dispatched: string[] = [];
	disk.beforeRequest = async (method, _endpoint, path) => {
		if (method !== "DELETE" || path.includes(".obsidian-")) {
			return;
		}
		dispatched.push(path);
		active++;
		peak = Math.max(peak, active);
		if (active === 4) {
			entered.resolve();
		}
		if (path === "vault/Folder0") {
			await entered.promise;
			firstFailed.resolve();
			throw new Error("synthetic rejected deletion");
		}
		await release.promise;
		active--;
	};
	let finished = false;
	const operation = transition(a, flow, "enable").finally(() => {
		finished = true;
	});
	await Promise.race([
		firstFailed.promise,
		operation.then(() => {
			throw new Error("No concurrent DELETE group");
		}),
	]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(finished, false, "recovery must wait for sent requests");
	assert.equal(peak, 4);
	assert.equal(dispatched.length, 4, "no admissions after the first failure");
	release.resolve();
	await assert.rejects(operation);
	assert.equal(flow.context.getTransition()?.phase, "cleanup");
	disk.beforeRequest = undefined;
	let lost = false;
	disk.afterRequest = async (method, _endpoint, path) => {
		if (method === "DELETE" && !path.includes(".obsidian-") && !lost) {
			lost = true;
			throw new Error("synthetic lost DELETE response");
		}
	};
	await recoverTransition(a, flow);
	assert.equal(lost, true);
	disk.afterRequest = undefined;
	await a.assertSettled(expected);
});

test("a rejected cleanup guard cannot acknowledge absence after configuration ABA or unload", async (t) => {
	const createDevice = managedDevices(t);
	for (const invalidation of ["configuration", "unload"] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		a.vault.put("Folder/Note.md", bytes("reference"));
		await a.full();
		const entered = deferred();
		const release = deferred();
		afterTest(t, () => release.resolve());
		const remove = a.client.deleteResource.bind(a.client);
		let intercepted = false;
		let sent = 0;
		disk.beforeRequest = async (method, _endpoint, path) => {
			if (method === "DELETE" && path === "vault/Folder") {
				sent++;
			}
		};
		a.client.deleteResource = async (path, permanent, raw, guard) => {
			if (raw && guard && !path.includes(".obsidian-") && !intercepted) {
				intercepted = true;
				entered.resolve();
				await release.promise;
				return remove(path, permanent, raw, guard);
			}
			return remove(path, permanent, raw, guard);
		};
		const operation = transition(a, flow, "enable");
		await Promise.race([
			entered.promise,
			operation.then(() => {
				throw new Error("No cleanup guard barrier");
			}),
		]);
		disk.files.delete("vault/Folder/Note.md");
		disk.folders.delete("vault/Folder");
		if (invalidation === "configuration") {
			const codec = flow.context.getService();
			a.client.setEncryptionService(null);
			a.client.setEncryptionService(codec);
		} else {
			flow.cancel();
		}
		release.resolve();
		await assert.rejects(operation);
		assert.equal(sent, 0);
		assert.equal(flow.context.getTransition()?.phase, "cleanup");
		assert.equal((await a.canonical()).maintenance?.phase, "cleanup");
	}
});

test("failed authoritative reception keeps old queues and retries after restart without uploading them", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const b = createDevice(disk, "b", null);
	const flow = encryptionFlow(a);
	a.vault.put("Folder/Note.md", bytes("reference"));
	await a.full();
	await b.full();
	const oldEpoch = b.index.getObservedEpoch()!;
	b.vault.put("Offline.md", bytes("discarded"));
	b.index.enqueueMutation("put", "Offline.md", {
		sha256: await computeSha256(bytes("discarded")),
	});
	b.watcher.loadDeferredEvents([
		{
			id: "offline-upload",
			action: "upload",
			path: "Offline.md",
			epoch: oldEpoch,
			baseRevision: b.index.getLocalIndex().observedRevision,
			createdAt: 1,
		},
		{
			id: "offline-delete",
			action: "delete-folder",
			path: "Folder",
			epoch: oldEpoch,
			baseRevision: b.index.getLocalIndex().observedRevision,
			createdAt: 2,
		},
	]);
	await transition(a, flow, "enable");
	await transition(a, flow, "disable");
	b.engine.setIndexSaveCallback(async () => {
		if (b.index.getObservedEpoch() !== oldEpoch) {
			throw new Error("synthetic adoption save failure");
		}
	});
	assert.equal((await b.engine.fullSync()).success, false);
	assert.equal(b.index.getObservedEpoch(), oldEpoch);
	assert.ok(
		b.index
			.getPendingMutations()
			.some(
				(mutation) =>
					mutation.path === "Offline.md" &&
					mutation.epoch === oldEpoch,
			),
	);
	assert.ok(
		b.index
			.getPendingMutations()
			.every((mutation) => mutation.epoch === oldEpoch),
	);
	assert.equal(b.watcher.getDeferredEvents().length, 2);
	const saved = await b.saved();
	await b.stop();
	const restarted = createDevice(disk, "b", null, b.vault, saved);
	await restarted.full();
	await restarted.assertSettled({ "Folder/Note.md": "reference" });
	assert.equal(restarted.vault.files.has("Offline.md"), false);
});

test("a realtime window cannot dispatch its next PUT after encryption claims maintenance", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const b = createDevice(disk, "b", null);
	const owner = encryptionFlow(a);
	const foreign = encryptionFlow(b);
	startupFlow(a, owner);
	startupFlow(b, foreign);
	a.vault.put("Folder/A.md", bytes("reference A"));
	a.vault.put("Folder/B.md", bytes("reference B"));
	await a.full();
	await b.full();
	b.vault.put("Folder/A.md", bytes("discard A"));
	b.vault.put("Folder/B.md", bytes("discard B"));
	const putEntered = deferred();
	const releasePut = deferred();
	const deleting = deferred();
	const releaseDelete = deferred();
	afterTest(t, () => {
		releasePut.resolve();
		releaseDelete.resolve();
	});
	const writes: string[] = [];
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			path.startsWith("vault/Folder/")
		) {
			writes.push(path);
			if (path === "vault/Folder/A.md") {
				putEntered.resolve();
				await releasePut.promise;
			}
		}
		if (method === "DELETE" && path === "vault/Folder") {
			deleting.resolve();
			await releaseDelete.promise;
		}
	};
	const realtime = b.engine.syncFileBatch(
		["A", "B"].map((name) => ({
			id: `edit-${name}`,
			action: "upload" as const,
			path: `Folder/${name}.md`,
			createdAt: 1,
			epoch: b.index.getObservedEpoch(),
			baseRevision: b.index.getLocalIndex().observedRevision,
		})),
	);
	await Promise.race([
		putEntered.promise,
		realtime.then(() => {
			throw new Error("No first realtime PUT");
		}),
	]);
	const replacement = transition(a, owner, "enable");
	await Promise.race([
		deleting.promise,
		replacement.then(() => {
			throw new Error("No maintenance DELETE");
		}),
	]);
	releasePut.resolve();
	const result = await realtime;
	assert.equal(result.completed.length, 0);
	assert.deepEqual(writes, ["vault/Folder/A.md"]);
	releaseDelete.resolve();
	await replacement;
	disk.beforeRequest = undefined;
	await foreign.workflow.connectForSync("target-password");
	await b.full();
	await b.assertSettled({
		"Folder/A.md": "reference A",
		"Folder/B.md": "reference B",
	});
});

test("pre-commit rollback proves locally new target files without widening the source reference", async (t) => {
	const createDevice = managedDevices(t);
	const disk = new MemoryDisk();
	const a = createDevice(disk, "a", null);
	const flow = encryptionFlow(a);
	a.vault.put("Original.md", bytes("old source"));
	await a.full();
	const source = await a.canonical();
	a.vault.put("Original.md", bytes("local reference"));
	a.vault.put("Added.md", bytes("local only"));
	a.settings.maxConcurrency = 1;
	let writes = 0;
	disk.beforeRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			!path.includes(".obsidian-") &&
			++writes > 1
		) {
			throw new Error("synthetic second target unavailable");
		}
	};
	await assert.rejects(transition(a, flow, "enable"));
	assert.equal(flow.context.getTransition(), null);
	const unchanged = await a.canonical();
	assert.equal(unchanged.epoch, source.epoch);
	assert.equal(unchanged.maintenance, undefined);
	assert.deepEqual(unchanged.files, source.files);
	assert.deepEqual(
		[...disk.files.keys()].filter((path) => !path.includes(".obsidian-")),
		["vault/Original.md"],
	);
	a.assertLocal("Original.md", "local reference");
	a.assertLocal("Added.md", "local only");
	disk.beforeRequest = undefined;
	await transition(a, flow, "enable");
	await a.assertSettled({
		"Original.md": "local reference",
		"Added.md": "local only",
	});
});

test("pre-commit revocation stops writes and failed manifest publication leaves retryable source authority", async (t) => {
	const createDevice = managedDevices(t);
	for (const failure of ["configuration", "manifest"] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		a.vault.put("A.md", bytes("alpha"));
		a.vault.put("B.md", bytes("beta"));
		await a.full();
		const source = await a.canonical();
		a.settings.maxConcurrency = 1;
		let revoked = false;
		let writesAfterRevocation = 0;
		const upload = a.client.uploadFile.bind(a.client);
		if (failure === "configuration") {
			a.client.uploadFile = async (...args) => {
				if (args[0] === "vault/B.md") {
					const codec = flow.context.getService();
					a.client.setEncryptionService(null);
					a.client.setEncryptionService(codec);
					revoked = true;
				}
				return upload(...args);
			};
			disk.beforeRequest = async (method) => {
				if (revoked && method !== "GET") {
					writesAfterRevocation++;
				}
			};
		} else {
			const publisher =
				flow.workflow.maintenance.createEncryptionManifestPublisher.bind(
					flow.workflow.maintenance,
				);
			flow.workflow.maintenance.createEncryptionManifestPublisher = (
				...args
			) => {
				const publish = publisher(...args);
				return async () => {
					if (
						flow.context.getTransition()?.phase === "files-copied"
					) {
						throw new Error("synthetic manifest unavailable");
					}
					await publish();
				};
			};
		}
		await assert.rejects(transition(a, flow, "enable"));
		assert.equal(writesAfterRevocation, 0);
		a.client.uploadFile = upload;
		disk.beforeRequest = undefined;
		await recoverTransition(a, flow);
		assert.equal(flow.context.getTransition(), null);
		const canonical = await a.canonical();
		assert.equal(canonical.epoch, source.epoch);
		assert.deepEqual(canonical.files, source.files);
		assert.equal(canonical.maintenance, undefined);
	}
});

test("authoritative reception resolves selected file-directory conflicts while retaining excluded descendants", async (t) => {
	const createDevice = managedDevices(t);
	for (const collision of [
		"file-to-directory",
		"directory-to-file",
		"excluded-descendant",
		"late-excluded-descendant",
	] as const) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const b = createDevice(disk, "b", null);
		const flow = encryptionFlow(a);
		a.vault.put("Note.md", bytes("reference"));
		a.vault.put("Folder/Note.md", bytes("child"));
		await a.full();
		await b.full();
		if (collision === "directory-to-file") {
			b.vault.remove("Folder");
			b.vault.put("Folder", bytes("discarded"));
		} else {
			b.vault.remove("Note.md");
			b.vault.put(
				`Note.md/${collision === "excluded-descendant" ? "Keep.bin" : "Offline.md"}`,
				bytes("offline"),
			);
			if (
				collision === "excluded-descendant" ||
				collision === "late-excluded-descendant"
			) {
				b.settings.excludePatterns = ["**/*.bin"];
			}
		}
		await transition(a, flow, "enable");
		await transition(a, flow, "disable");
		if (collision === "late-excluded-descendant") {
			const download = b.client.downloadStableLogicalFile.bind(b.client);
			b.client.downloadStableLogicalFile = async (...args) => {
				const snapshot = await download(...args);
				b.vault.put("Note.md/Keep.bin", bytes("offline"));
				return snapshot;
			};
		}
		const result = await b.engine.fullSync();
		if (
			collision === "excluded-descendant" ||
			collision === "late-excluded-descendant"
		) {
			assert.equal(result.success, false);
			b.assertLocal("Note.md/Keep.bin", "offline");
			assert.notEqual(
				b.index.getObservedEpoch(),
				(await a.canonical()).epoch,
			);
		} else {
			assert.equal(result.success, true, JSON.stringify(result.errors));
			await b.assertSettled({
				"Note.md": "reference",
				"Folder/Note.md": "child",
			});
		}
	}
});

test("disable cleanup ignores empty old-mode directories without treating undecodable files as empty", async (t) => {
	const createDevice = managedDevices(t);
	for (const lateFile of [false, true]) {
		const disk = new MemoryDisk();
		const a = createDevice(disk, "a", null);
		const flow = encryptionFlow(a);
		a.vault.put("Note.md", bytes("reference"));
		await a.full();
		disk.folders.add("vault/Unused");
		disk.folders.add("vault/Unused/Nested");
		await transition(a, flow, "enable");
		assert.equal(disk.folders.has("vault/Unused/Nested"), true);
		if (lateFile) {
			const cleanup = flow.workflow.maintenance.deleteRemoteRawPaths.bind(
				flow.workflow.maintenance,
			);
			flow.workflow.maintenance.deleteRemoteRawPaths = async (
				...args
			) => {
				disk.files.set(
					"vault/Unused/Nested/Unknown.md",
					bytes("retain undecodable file"),
				);
				await cleanup(...args);
			};
		}
		const result = await transition(a, flow, "disable");
		assert.deepEqual(result, { hadErrors: lateFile });
		if (lateFile) {
			assert.equal(flow.context.getTransition()?.phase, "cleanup");
			assert.deepEqual(
				disk.files.get("vault/Unused/Nested/Unknown.md"),
				bytes("retain undecodable file"),
			);
			assert.equal(disk.files.has("vault/.obsidian-encrypt.json"), false);
		} else {
			assert.equal(flow.context.getTransition(), null);
			await a.assertSettled({ "Note.md": "reference" });
			assert.equal(disk.folders.has("vault/Unused/Nested"), true);
		}
	}
});

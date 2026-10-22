import assert from "node:assert/strict";
import test from "node:test";
import { YandexApiError } from "../src/api/yandex-client";
import { computeSha256 } from "../src/utils/hash-utils";
import { encryptionFlow } from "./helpers/encryption-flow";
import { MemoryDisk, bytes, device } from "./helpers/sync-flow";
import { isRemoteReadTimeout, OperationFailure } from "../src/errors";
import { InvalidCurrentIndexError } from "../src/sync/canonical/errors";

test("encryption recovery only falls back after a canonical decode mismatch", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const ea = encryptionFlow(a);
	const canonicalPath = "vault/.obsidian-sync-index.json";
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let complete!: () => void;
	const lateReply = new Promise<void>((resolve) => {
		complete = resolve;
	});
	try {
		a.settings.maxConcurrency = 1;
		a.vault.put("A.md", bytes("alpha"));
		a.vault.put("B.md", bytes("beta"));
		await a.full();
		await a.engine.runExclusiveMaintenance(() =>
			ea.workflow.enableEncryptionNow(
				"source-password",
				"without-backup",
			),
		);
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
				throw new Error("synthetic unavailable rollback");
			}
		};
		await assert.rejects(
			a.engine.runExclusiveMaintenance(() =>
				ea.workflow.rotateEncryptionPasswordNow(
					"target-password",
					"without-backup",
				),
			),
		);
		disk.beforeRequest = undefined;
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
				await gate;
			}
		};
		disk.afterRequest = async (_method, endpoint, path) => {
			if (endpoint === "/download" && path === canonicalPath) {
				complete();
			}
			if (
				endpoint === "/download" &&
				path === "vault/.obsidian-encrypt.json"
			) {
				manifests++;
			}
		};
		const recover = () =>
			a.engine.runExclusiveMaintenance(() =>
				ea.workflow.recovery.recoverEncryptionTransition(),
			);
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
		release();
		await lateReply;
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
	} finally {
		release();
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		await a.stop();
	}
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
		await a.engine.runExclusiveMaintenance(() =>
			ea.workflow.enableEncryptionNow("first-password", "without-backup"),
		);
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
		await a.engine.runExclusiveMaintenance(() =>
			ea.workflow.rotateEncryptionPasswordNow(
				"second-password",
				"without-backup",
			),
		);
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
			assert.deepEqual(
				await a.engine.runExclusiveMaintenance(() =>
					ea.workflow.disableEncryptionNow(
						{ reuploadPlaintext: true },
						"without-backup",
					),
				),
				{ hadErrors: false },
			);
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

test("encryption admission shares a prompt and rejects its late password after unload", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const b = device(disk, "device-b", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	try {
		a.vault.put("Note.md", bytes("kept"));
		await a.full();
		await a.engine.runExclusiveMaintenance(() =>
			ea.workflow.enableEncryptionNow("password", "without-backup"),
		);
		const manifest = await a.index.downloadEncryptionManifest();
		assert.ok(manifest);
		const before = structuredClone(disk.files);
		const saved = await eb.saved();
		let resolvePassword!: (password: string) => void;
		let shown = 0;
		const password = new Promise<string>((resolve) => {
			resolvePassword = resolve;
		});
		eb.context.ui.requestPassword = () => {
			shown++;
			return password;
		};
		const first = eb.workflow.admission.ensureEncryptionReady(
			{ prompt: true },
			{ manifest },
		);
		const second = eb.workflow.admission.ensureEncryptionReady(
			{ prompt: true },
			{ manifest },
		);
		assert.equal(shown, 1);
		eb.cancel();
		resolvePassword("password");
		assert.deepEqual(await Promise.all([first, second]), [false, false]);
		assert.deepEqual(await eb.saved(), saved);
		assert.deepEqual(disk.files, before);
		assert.equal(eb.context.getService(), null);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("committed encryption workflow recovers on another device before replaying offline work", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const b = device(disk, "device-b", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	try {
		a.vault.put("Note.md", bytes("target survives"));
		await a.full();
		await b.full();
		b.vault.put("Offline.md", bytes("offline addition"));
		const { computeSha256 } = await import("../src/utils/hash-utils");
		b.index.enqueueMutation("put", "Offline.md", {
			sha256: await computeSha256(bytes("offline addition")),
		});
		await b.saved();
		const causal = b.index.captureLocalCausalState();
		let committed = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				method === "POST" &&
				endpoint.endsWith("/resources/move") &&
				path === "vault/.obsidian-sync-index.json" &&
				a.index.getMaintenance()?.phase === "index-committed"
			) {
				committed = true;
			}
		};
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				committed &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path === "vault/.obsidian-encrypt.json"
			) {
				throw new Error(
					"synthetic publication interrupted after commit",
				);
			}
		};
		await assert.rejects(
			a.engine.runExclusiveMaintenance(() =>
				ea.workflow.enableEncryptionNow(
					"target-password",
					"without-backup",
				),
			),
		);
		assert.equal(committed, true);
		assert.equal(ea.context.getTransition()?.phase, "index-committed");
		const saved = await ea.saved();
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		assert.equal(disk.files.has("vault/Note.md"), true);
		await eb.workflow.connectForSync("target-password");
		assert.equal((await b.canonical()).maintenance, undefined);
		assert.equal(disk.files.has("vault/Note.md"), false);
		assert.deepEqual(b.index.captureLocalCausalState(), causal);
		assert.deepEqual(
			await b.client.downloadFile("vault/Note.md"),
			bytes("target survives"),
		);
		assert.equal((await b.canonical()).files["Offline.md"], undefined);
		await a.stop();
		const restarted = device(disk, "device-a", null, a.vault, saved.device);
		Object.assign(restarted.settings, saved.settings);
		const er = encryptionFlow(restarted);
		er.context.setTransition(saved.transition);
		try {
			await er.workflow.initEncryption();
			await restarted.engine.runExclusiveMaintenance(() =>
				er.workflow.recovery.recoverEncryptionTransition(),
			);
			assert.equal(er.context.getTransition(), null);
			await b.full();
			await restarted.full();
			await b.assertSettled({
				"Note.md": "target survives",
				"Offline.md": "offline addition",
			});
			await restarted.assertSettled({
				"Note.md": "target survives",
				"Offline.md": "offline addition",
			});
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
		disk.beforeRequest = undefined;
		disk.afterRequest = undefined;
		await a.stop();
		await b.stop();
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
				await a.engine.runExclusiveMaintenance(() =>
					ea.workflow.enableEncryptionNow(
						"source-password",
						"without-backup",
					),
				);
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
					a.engine.runExclusiveMaintenance(() =>
						ea.workflow.enableEncryptionNow(
							"target-password",
							"without-backup",
						),
					),
				);
			} else {
				assert.deepEqual(
					await a.engine.runExclusiveMaintenance(() =>
						ea.workflow.disableEncryptionNow(
							{ reuploadPlaintext: true },
							"without-backup",
						),
					),
					{ hadErrors: true },
				);
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
			await restarted.engine.runExclusiveMaintenance(() =>
				er.workflow.recovery.recoverEncryptionTransition(),
			);
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

test("source rollback preserves rewritten targets and stops DELETE retry after authority revocation", async () => {
	for (const attack of ["rewritten", "revoked"] as const) {
		const disk = new MemoryDisk();
		const a = device(disk, "device-a", null, undefined, undefined, {
			maxRetries: 1,
		});
		const ea = encryptionFlow(a);
		try {
			a.settings.maxConcurrency = 1;
			a.vault.put("A.md", bytes("alpha"));
			a.vault.put("B.md", bytes("beta"));
			await a.full();
			let writes = 0;
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "PUT" &&
					endpoint === "/upload" &&
					!path.includes(".obsidian-")
				) {
					writes++;
					if (writes > 1) {
						throw new Error("synthetic partial target copy");
					}
				}
				if (method === "DELETE" && !path.includes(".obsidian-")) {
					throw new Error("synthetic unavailable DELETE");
				}
			};
			await assert.rejects(
				a.engine.runExclusiveMaintenance(() =>
					ea.workflow.enableEncryptionNow(
						"target-password",
						"without-backup",
					),
				),
			);
			disk.beforeRequest = undefined;
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
				a.engine.runExclusiveMaintenance(() =>
					ea.workflow.recovery.recoverEncryptionTransition(),
				),
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
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
		}
	}
});

test("completed source rollback retires its stale checkpoint without acquiring deletion authority", async () => {
	const disk = new MemoryDisk();
	const a = device(disk, "device-a", null);
	const ea = encryptionFlow(a);
	let restarted: ReturnType<typeof device> | undefined;
	try {
		a.settings.maxConcurrency = 1;
		a.vault.put("A.md", bytes("alpha"));
		a.vault.put("B.md", bytes("beta"));
		await a.full();
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
		await assert.rejects(
			a.engine.runExclusiveMaintenance(() =>
				ea.workflow.enableEncryptionNow(
					"target-password",
					"without-backup",
				),
			),
		);
		disk.beforeRequest = undefined;
		let checkpoint = await ea.saved();
		const transitionId = checkpoint.transition!.id;
		const target = Object.keys(
			checkpoint.transition!.targetFingerprints,
		)[0]!;
		const pinnedBytes = disk.files.get(`vault/${target}`)!.slice(0);
		ea.context.persist = async () => {
			if (!ea.context.getTransition()) {
				throw new Error("synthetic final local save failure");
			}
			checkpoint = await ea.saved();
		};
		await assert.rejects(
			a.engine.runExclusiveMaintenance(() =>
				ea.workflow.recovery.recoverEncryptionTransition(),
			),
			/final local save failure/,
		);
		assert.equal((await a.canonical()).maintenance, undefined);
		assert.equal(ea.context.getTransition()?.id, transitionId);
		assert.equal(checkpoint.transition!.id, transitionId);
		assert.equal(checkpoint.transition!.phase, "prepared");
		assert.deepEqual(checkpoint.device.pendingPhysicalActions, []);
		await a.stop();
		restarted = device(disk, "device-a", null, a.vault, checkpoint.device);
		Object.assign(restarted.settings, checkpoint.settings);
		const er = encryptionFlow(restarted);
		er.context.setTransition(checkpoint.transition);
		await er.workflow.initEncryption();
		const rawPath = `vault/${target}`;
		disk.files.set(rawPath, pinnedBytes);
		const pinned = structuredClone(disk.files);
		await assert.rejects(
			restarted.engine.runExclusiveMaintenance(() =>
				er.workflow.recovery.recoverEncryptionTransition(),
			),
			/no canonical authority/,
		);
		assert.deepEqual(disk.files, pinned);
		disk.files.set(rawPath, bytes("foreign replacement"));
		const foreign = structuredClone(disk.files);
		await assert.rejects(
			restarted.engine.runExclusiveMaintenance(() =>
				er.workflow.recovery.recoverEncryptionTransition(),
			),
		);
		assert.deepEqual(disk.files, foreign);
		assert.equal(er.context.getTransition()?.id, transitionId);
		disk.files.delete(rawPath);
		const completed = structuredClone(disk.files);
		await restarted.engine.runExclusiveMaintenance(() =>
			er.workflow.recovery.recoverEncryptionTransition(),
		);
		assert.deepEqual(disk.files, completed);
		assert.equal(er.context.getTransition(), null);
		assert.deepEqual(await restarted.saved(), checkpoint.device);
		await restarted.full();
		await restarted.assertSettled({ "A.md": "alpha", "B.md": "beta" });
	} finally {
		disk.beforeRequest = undefined;
		await a.stop();
		await restarted?.stop();
	}
});

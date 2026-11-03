import assert from "node:assert/strict";
import test from "node:test";
import {
	bytes,
	codecFor,
	managedDevices,
	MemoryDisk,
} from "./helpers/sync-flow";
import { encryptionFlow } from "./helpers/encryption-flow";
import { recoverTransition, transition } from "./helpers/encryption-scenarios";
import {
	applyForceReplacement,
	prepareForceReplacement,
	resumeForceReplacement,
} from "../src/sync/workflows/force-replacement";
import type { ForceRecovery } from "../src/sync/workflows/force-state";
import { ConcurrentSyncChangeError } from "../src/errors";
import { logger } from "../src/utils/logger";

type Device = ReturnType<ReturnType<typeof managedDevices>>;

/** Persist a Force remainder in memory while exercising the real replacement flow. */
function forceHarness(device: Device) {
	let saved: ForceRecovery | null = null;
	const ports = {
		persist: async (state: ForceRecovery | null) => {
			saved = structuredClone(state);
		},
		getRecovery: () => saved,
		password: async () => null,
	};
	return {
		ports,
		deps: {
			client: device.client,
			adapter: device.adapter,
			index: device.index,
			settings: device.settings,
			...ports,
		},
		get saved() {
			return saved;
		},
	};
}

/** Prepare independent device states before an encrypted authoritative receive. */
async function encryptedReceiver(
	t: Parameters<typeof managedDevices>[0],
	files: Record<string, string>,
	password = "target-password",
) {
	const disk = new MemoryDisk();
	const make = managedDevices(t);
	const a = make(disk, "owner", null);
	const b = make(disk, "receiver", null);
	const ea = encryptionFlow(a);
	const eb = encryptionFlow(b);
	for (const [path, content] of Object.entries(files)) {
		a.vault.put(path, bytes(content));
	}
	await a.full();
	await b.full();
	await transition(a, ea, "enable", password);
	await eb.workflow.connectForSync(password);
	return { disk, make, a, b, ea, eb };
}

test("a full upload superseded by a folder move closes its FIFO across restart", async (t) => {
	const make = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = make(disk, "moving-owner", codec);
		a.vault.put("Folder/A.md", bytes("base"));
		await a.full();
		a.vault.put("Folder/A.md", bytes("latest"));
		a.start();
		const read = a.adapter.readFile.bind(a.adapter);
		let moved = false;
		a.adapter.readFile = async (path) => {
			if (!moved && path === "Folder/A.md") {
				moved = true;
				a.vault.rename("Folder", "Deep/Folder");
			}
			return await read(path);
		};
		await a.engine.fullSync();
		a.adapter.readFile = read;
		const saved = await a.saved();
		await a.stop();
		const restarted = make(disk, "moving-owner", codec, a.vault, saved);
		await restarted.full();
		await restarted.assertSettled({ "Deep/Folder/A.md": "latest" });
		assert.equal(restarted.vault.files.has("Folder/A.md"), false);
		const other = make(disk, "offline-reader", await codecFor(encrypted));
		await other.full();
		await other.assertSettled({ "Deep/Folder/A.md": "latest" });
	}
});

test("encryption cleanup completes its verified target while retaining later local edits", async (t) => {
	const make = managedDevices(t);
	for (const kind of ["enable", "disable", "rotate"] as const) {
		const disk = new MemoryDisk();
		const a = make(disk, `owner-${kind}`, null);
		const flow = encryptionFlow(a);
		a.vault.put("A.md", bytes("reference"));
		await a.full();
		if (kind !== "enable") {
			await transition(a, flow, "enable", "source-password");
		}
		let edited = false;
		disk.beforeRequest = async (method, _endpoint, path) => {
			if (
				!edited &&
				method === "DELETE" &&
				!path.includes(".obsidian-")
			) {
				edited = true;
				a.vault.put("A.md", bytes("late edit"));
				a.vault.put("New.md", bytes("late create"));
			}
		};
		await transition(a, flow, kind);
		disk.beforeRequest = undefined;
		await recoverTransition(a, flow);
		assert.equal(edited, true);
		assert.equal(flow.context.getTransition(), null);
		a.assertLocal("A.md", "late edit");
		await a.full();
		await a.assertSettled({ "A.md": "late edit", "New.md": "late create" });
	}
});

test("authoritative reception preserves creations edits and moves made during its download", async (t) => {
	for (const change of ["create", "edit", "move"] as const) {
		const { disk, b } = await encryptedReceiver(t, { "A.md": "reference" });
		b.start();
		let changed = false;
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				!changed &&
				method === "GET" &&
				endpoint === "/download" &&
				!path.includes(".obsidian-")
			) {
				changed = true;
				if (change === "create") {
					b.vault.put("Late.md", bytes("late create"));
				} else if (change === "edit") {
					b.vault.put("A.md", bytes("late edit"));
				} else {
					b.vault.rename("A.md", "Moved/A.md");
				}
			}
		};
		await b.engine.fullSync();
		disk.beforeRequest = undefined;
		assert.equal(changed, true);
		const expected: Record<string, string> =
			change === "move"
				? { "Moved/A.md": "reference" }
				: change === "edit"
					? { "A.md": "late edit" }
					: { "A.md": "reference", "Late.md": "late create" };
		for (const [path, value] of Object.entries(expected)) {
			b.assertLocal(path, value);
		}
		await b.full();
		await b.drain();
		await b.full();
		await b.assertSettled(expected);
	}
});

test("a failed authoritative write cannot suppress the next real user modification", async (t) => {
	const { b } = await encryptedReceiver(t, { "A.md": "base" });
	b.start();
	const write = b.adapter.writeFile.bind(b.adapter);
	b.adapter.writeFile = async () => {
		throw new Error("synthetic local write failure");
	};
	const result = await b.engine.fullSync();
	assert.equal(result.success, false);
	b.adapter.writeFile = write;
	b.vault.put("A.md", bytes("late user edit"));
	assert.ok(
		b.watcher
			.getDeferredEvents()
			.some(
				(event) => event.path === "A.md" && event.action === "upload",
			),
	);
});

test("Force retires a confirmed missing source instead of blocking ordinary full forever", async (t) => {
	const make = managedDevices(t);
	for (const direction of ["from_local", "from_remote"] as const) {
		for (const change of ["move", "folder"] as const) {
			const disk = new MemoryDisk(),
				a = make(disk, "force-owner", null);
			a.vault.put("A.md", bytes("chosen"));
			await a.full();
			const force = forceHarness(a);
			const plan = await prepareForceReplacement(force.deps, direction);
			assert.ok(plan);
			let moved = false;
			disk.afterRequest = async (method, endpoint, path) => {
				if (
					!moved &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path.endsWith(".obsidian-sync-index.json")
				) {
					moved = true;
					if (direction === "from_local") {
						if (change === "move") {
							a.vault.rename("A.md", "Moved.md");
						} else {
							a.vault.remove("A.md");
							a.vault.put("A.md/child.md", bytes("chosen"));
						}
					} else {
						disk.files.set(
							change === "move"
								? "vault/Moved.md"
								: "vault/A.md/child.md",
							disk.files.get("vault/A.md")!,
						);
						disk.files.delete("vault/A.md");
						if (change === "folder") {
							disk.folders.add("vault/A.md");
						}
					}
				}
			};
			await applyForceReplacement(force.deps, plan, "without-backup");
			disk.afterRequest = undefined;
			a.engine.setForceReplacementPorts(force.ports);
			await a.full();
			assert.equal(force.saved, null);
			await a.assertSettled({
				[change === "move" ? "Moved.md" : "A.md/child.md"]: "chosen",
			});
		}
	}
});

test("an upload invalidated by a local edit is deferred without a false error or lost work", async (t) => {
	const disk = new MemoryDisk(),
		a = managedDevices(t)(disk, "editing", null);
	a.vault.put("A.md", bytes("base"));
	await a.full();
	const lastSuccess = a.engine.getState().lastSyncTime;
	a.vault.put("A.md", bytes("planned"));
	const read = a.adapter.readFile.bind(a.adapter);
	let edited = false;
	a.adapter.readFile = async (path) => {
		if (!edited && path === "A.md") {
			edited = true;
			a.vault.put(path, bytes("latest"));
		}
		return await read(path);
	};
	const result = await a.engine.fullSync();
	assert.deepEqual(result.errors, []);
	assert.equal(result.success, false);
	assert.equal(result.deferred, true);
	assert.equal(a.engine.getState().lastSyncTime, lastSuccess);
	assert.equal(a.engine.getState().lastOutcome, "deferred");
	await a.engine.runExclusiveMaintenance(async () => undefined);
	assert.equal(a.engine.getState().lastOutcome, "deferred");
	assert.equal(a.engine.getState().lastSyncTime, lastSuccess);
	a.adapter.readFile = read;
	await a.full();
	await a.assertSettled({ "A.md": "latest" });
	assert.equal(a.engine.getState().lastOutcome, "success");
	assert.ok(a.engine.getState().lastSyncTime! >= lastSuccess!);
});

test("canonical discovery repeats a service read that briefly disappears after download", async (t) => {
	const disk = new MemoryDisk(),
		a = managedDevices(t)(disk, "reading", null);
	a.vault.put("A.md", bytes("base"));
	await a.full();
	const get = a.client.getResource.bind(a.client);
	let disappeared = false;
	a.client.getResource = async (...args) => {
		if (!disappeared && args[0] === "vault/.obsidian-sync-index.json") {
			disappeared = true;
			return null;
		}
		return await get(...args);
	};
	await a.full();
	assert.equal(disappeared, true);
	await a.assertSettled({ "A.md": "base" });
});

test("an encryption rewrite captures each readable version without requiring later local equality", async (t) => {
	const make = managedDevices(t);
	for (const timing of ["before", "after", "delete"] as const) {
		const disk = new MemoryDisk(),
			a = make(disk, "reference-owner", null),
			flow = encryptionFlow(a);
		a.vault.put("A.md", bytes("reference"));
		await a.full();
		const read = a.adapter.readFile.bind(a.adapter);
		let edited = false;
		a.adapter.readFile = async (path) => {
			if (!edited && path === "A.md") {
				edited = true;
				if (timing === "delete") {
					a.vault.remove(path);
					return await read(path);
				}
				if (timing === "before") {
					a.vault.put(path, bytes("late edit"));
					return await read(path);
				}
				const content = await read(path);
				a.vault.put(path, bytes("late edit"));
				return content;
			}
			return await read(path);
		};
		await transition(a, flow, "enable");
		a.adapter.readFile = read;
		assert.equal(edited, true);
		assert.equal(flow.context.getTransition(), null);
		a.assertLocal("A.md", timing === "delete" ? undefined : "late edit");
		await a.full();
		await a.assertSettled(
			timing === "delete" ? {} : { "A.md": "late edit" },
		);
	}
});

test("replacement receive resumes its original boundary and preserves edits to already applied files", async (t) => {
	const { disk, make, b, eb } = await encryptedReceiver(t, {
		"A.md": "reference A",
		"B.md": "reference B",
	});
	b.settings.maxConcurrency = 1;
	const write = b.adapter.writeFile.bind(b.adapter);
	b.adapter.writeFile = async (...args) => {
		if (args[0] === "B.md") {
			throw new Error("synthetic interrupted second receive");
		}
		await write(...args);
	};
	assert.equal((await b.engine.fullSync()).success, false);
	assert.ok(b.index.getLocalIndex().replacementReceive?.applied["A.md"]);
	b.vault.put("A.md", bytes("late A"));
	b.vault.put("Late.md", bytes("late creation"));
	const saved = await b.saved();
	await b.stop();
	const restarted = make(
		disk,
		"receiver",
		eb.context.getService(),
		b.vault,
		saved,
	);
	await restarted.full();
	restarted.assertLocal("A.md", "late A");
	restarted.assertLocal("Late.md", "late creation");
	assert.equal(restarted.index.getLocalIndex().replacementReceive, undefined);
	await restarted.full();
	await restarted.assertSettled({
		"A.md": "late A",
		"B.md": "reference B",
		"Late.md": "late creation",
	});
});

test("replacement receive verifies a remote target even when a late local edit skips its write", async (t) => {
	const {
		disk,
		a: owner,
		b: receiver,
	} = await encryptedReceiver(t, {
		"A.md": "reference",
	});
	const readLocal = receiver.adapter.readFile.bind(receiver.adapter);
	let edited = false;
	receiver.adapter.readFile = async (path) => {
		if (!edited && path === "A.md") {
			edited = true;
			receiver.vault.put(path, bytes("late local edit"));
		}
		return await readLocal(path);
	};
	const rawPath = (
		await owner.client.getLogicalResource("vault/A.md")
	)?.path.replace(/^disk:\//, "");
	assert.ok(rawPath);
	const targetBytes = disk.files.get(rawPath)!;
	disk.files.set(rawPath, bytes("corrupt remote target"));
	const result = await receiver.engine.fullSync();
	receiver.adapter.readFile = readLocal;
	assert.equal(edited, true);
	assert.equal(result.success, false);
	receiver.assertLocal("A.md", "late local edit");
	assert.ok(receiver.index.getLocalIndex().replacementReceive);
	disk.files.set(rawPath, targetBytes);
	await receiver.full();
	await receiver.full();
	await receiver.assertSettled({ "A.md": "late local edit" });
});

test("Force remote preserves a new local edit made after purge while the source is downloading", async (t) => {
	const disk = new MemoryDisk(),
		a = managedDevices(t)(disk, "receiving-force", null);
	a.vault.put("A.md", bytes("reference"));
	await a.full();
	const force = forceHarness(a);
	const plan = await prepareForceReplacement(force.deps, "from_remote");
	assert.ok(plan);
	let edited = false;
	disk.beforeRequest = async (method, endpoint) => {
		if (
			!edited &&
			method === "GET" &&
			endpoint === "/download" &&
			!a.vault.files.has("A.md")
		) {
			edited = true;
			a.vault.put("A.md", bytes("late user edit"));
		}
	};
	const result = await applyForceReplacement(
		force.deps,
		plan,
		"without-backup",
	);
	disk.beforeRequest = undefined;
	assert.equal(result.completed, true);
	assert.equal(force.saved, null);
	assert.equal(edited, true);
	a.assertLocal("A.md", "late user edit");
	await a.full();
	await a.assertSettled({ "A.md": "late user edit" });
});

test("Force engine observes late edits and suppresses its own recursive purge", async (t) => {
	for (const change of ["edit", "directory", "late-write"] as const) {
		const disk = new MemoryDisk(),
			a = managedDevices(t)(disk, "force-observer", null);
		a.vault.put("Folder/A.md", bytes("reference"));
		a.vault.folder("Folder/Empty");
		await a.full();
		let saved: ForceRecovery | null = null;
		const ports = {
			persist: async (value: ForceRecovery | null) => {
				saved = structuredClone(value);
			},
			getRecovery: () => saved,
			password: async () => null,
			watcherCutoff: () =>
				a.watcher
					.getDeferredEvents()
					.flatMap((event) => (event.id ? [event.id] : [])),
			watcherBoundary: () => a.watcher.getEventBoundary(),
			hasLocalChanges: (path: string, boundary: Record<string, string>) =>
				a.watcher.hasLocalChanges(path, boundary),
			retireWatcherEvents: (
				ids: string[],
				boundary?: Record<string, string>,
			) => a.watcher.settleForceReplacement(ids, boundary),
		};
		a.engine.setForceReplacementPorts(ports);
		const plan = await prepareForceReplacement(
			{
				client: a.client,
				adapter: a.adapter,
				index: a.index,
				settings: a.settings,
				...ports,
			},
			"from_remote",
		);
		assert.ok(plan);
		let edited = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				change !== "late-write" &&
				!edited &&
				method === "PUT" &&
				endpoint === "/upload" &&
				path.endsWith(".obsidian-sync-index.json")
			) {
				edited = true;
				if (change === "edit") {
					a.vault.put("Folder/A.md", bytes("late edit"));
				} else {
					a.vault.rename("Folder/Empty", "Folder/New");
				}
			}
		};
		const stat = a.vault.adapter.stat.bind(a.vault.adapter);
		let downloaded = false,
			statCount = 0;
		const after = disk.afterRequest;
		disk.afterRequest = async (method, endpoint, path) => {
			await after?.(method, endpoint, path);
			if (
				method === "GET" &&
				endpoint === "/download" &&
				path === "vault/Folder/A.md" &&
				!a.vault.files.has("Folder/A.md")
			) {
				downloaded = true;
			}
		};
		a.vault.adapter.stat = async (path) => {
			if (
				change === "late-write" &&
				downloaded &&
				path === "Folder/A.md" &&
				++statCount === 2
			) {
				edited = true;
				a.vault.put(path, bytes("late edit"));
			}
			return await stat(path);
		};
		const result = await a.engine.forceSyncFromRemote({
			forceReplacement: { plan, backupMode: "without-backup" },
		});
		disk.afterRequest = undefined;
		a.vault.adapter.stat = stat;
		if (change === "late-write") {
			assert.equal(edited, true);
			assert.equal(result.deferred, true);
		} else {
			assert.equal(result.success, true);
		}
		a.assertLocal(
			"Folder/A.md",
			change === "edit" || change === "late-write"
				? "late edit"
				: "reference",
		);
		await a.full();
		await a.assertSettled({
			"Folder/A.md":
				change === "edit" || change === "late-write"
					? "late edit"
					: "reference",
		});
	}
});

test("Force source races retain recovery without reporting success", async (t) => {
	const disk = new MemoryDisk(),
		a = managedDevices(t)(disk, "force-deferred", null);
	a.vault.put("A.md", bytes("reference"));
	await a.full();
	const force = forceHarness(a);
	a.engine.setForceReplacementPorts(force.ports);
	const plan = await prepareForceReplacement(force.deps, "from_local");
	assert.ok(plan);
	const read = a.adapter.readForceFile.bind(a.adapter);
	disk.afterRequest = async (method, endpoint, path) => {
		if (
			method === "PUT" &&
			endpoint === "/upload" &&
			path.endsWith(".obsidian-sync-index.json")
		) {
			a.adapter.readForceFile = async () => {
				throw new ConcurrentSyncChangeError("synthetic source race");
			};
		}
	};
	const result = await a.engine.forceSyncFromLocal({
		forceReplacement: { plan, backupMode: "without-backup" },
	});
	disk.afterRequest = undefined;
	a.adapter.readForceFile = read;
	assert.equal(result.success, false);
	assert.equal(result.deferred, true);
	assert.notEqual(result.epochAdopted, true);
	assert.ok(force.saved);
	await a.full();
	await a.assertSettled({ "A.md": "reference" });
});

test("Force does not retire a source after an unverified destination write", async (t) => {
	const outcomes: unknown[] = [];
	const originalInfo = logger.info.bind(logger);
	logger.info = function (message, context) {
		if (message === "Direct Force outcome") {
			outcomes.push(context?.outcome);
		}
		originalInfo(message, context);
	};
	try {
		const disk = new MemoryDisk(),
			a = managedDevices(t)(disk, "force-unverified", null);
		a.vault.put("A.md", bytes("reference"));
		const force = forceHarness(a);
		const plan = await prepareForceReplacement(force.deps, "from_local");
		assert.ok(plan);
		const sourceHash = plan.recovery.source[0]!.sha256;
		const getResource = a.client.getResource.bind(a.client);
		let uploaded = false;
		disk.afterRequest = async (method, endpoint, path) => {
			if (
				method === "PUT" &&
				endpoint === "/upload" &&
				path === "vault/A.md"
			) {
				uploaded = true;
				a.vault.remove("A.md");
			}
		};
		a.client.getResource = async (...args) => {
			if (uploaded && args[0] === "vault/A.md") {
				return null;
			}
			return await getResource(...args);
		};
		const result = await applyForceReplacement(
			force.deps,
			plan,
			"without-backup",
		);
		disk.afterRequest = undefined;
		a.client.getResource = getResource;
		assert.equal(uploaded, true);
		assert.equal(disk.files.has("vault/A.md"), true);
		assert.equal(result.completed, false);
		assert.ok(force.saved);
		assert.ok(plan.recovery.direct?.pendingFiles.includes("A.md"));
		const resumed = await resumeForceReplacement(force.deps, plan.recovery);
		const settled = await applyForceReplacement(
			force.deps,
			resumed,
			"without-backup",
		);
		assert.equal(settled.completed, true);
		assert.deepEqual(outcomes, ["error", "completed"]);
		const canonical = await a.index.readCanonicalIndex();
		assert.equal(canonical.files["A.md"]?.sha256, sourceHash);
		await a.full();
		await a.assertSettled({});
	} finally {
		logger.info = originalInfo;
	}
});

test("replacement reception preserves late structural edits outside the blocking root", async (t) => {
	for (const arrival of ["create", "edit"] as const) {
		const disk = new MemoryDisk(),
			make = managedDevices(t);
		const a = make(disk, "structure-owner", null),
			b = make(disk, "structure-receiver", null);
		const ea = encryptionFlow(a),
			eb = encryptionFlow(b);
		a.vault.put("A/note.md", bytes("original"));
		await a.full();
		await b.full();
		a.vault.remove("A");
		a.vault.put("A", bytes("reference"));
		await transition(a, ea, "enable", "target-password");
		await eb.workflow.connectForSync("target-password");
		let edited = false,
			copied = false,
			arrived = false;
		const write = b.adapter.writeFile.bind(b.adapter),
			tree = b.adapter.getForceTree.bind(b.adapter);
		b.adapter.writeFile = async (...args) => {
			await write(...args);
			if (!copied && args[0].includes("_conflict_")) {
				copied = true;
				if (arrival === "create") {
					arrived = true;
					b.vault.put("A/new.md", bytes("late creation"));
				}
			}
		};
		b.adapter.getForceTree = async (...args) => {
			if (arrival === "edit" && copied && !arrived) {
				arrived = true;
				b.vault.put("A/note.md", bytes("latest edit after copy"));
			}
			return await tree(...args);
		};
		disk.beforeRequest = async (method, endpoint, path) => {
			if (
				!edited &&
				method === "GET" &&
				endpoint === "/download" &&
				!path.includes(".obsidian-")
			) {
				edited = true;
				b.vault.put("A/note.md", bytes("late edit"));
			}
		};
		const result = await b.engine.fullSync();
		disk.beforeRequest = undefined;
		b.adapter.writeFile = write;
		b.adapter.getForceTree = tree;
		assert.equal(arrived, true);
		assert.equal(result.deferred, true);
		b.assertLocal(
			arrival === "create" ? "A/new.md" : "A/note.md",
			arrival === "create" ? "late creation" : "latest edit after copy",
		);
		await b.full();
		b.assertLocal("A", "reference");
		const copies = Object.fromEntries(
			[...b.vault.files]
				.filter(([path]) => path.includes("_conflict_"))
				.map(([path, content]) => [
					path,
					new TextDecoder().decode(content),
				]),
		);
		assert.deepEqual(
			Object.values(copies).sort(),
			[
				"late edit",
				arrival === "create"
					? "late creation"
					: "latest edit after copy",
			].sort(),
		);
		await b.full();
		await b.assertSettled({ A: "reference", ...copies });
	}
});

test("a newer replacement supersedes an interrupted receipt without losing late edits", async (t) => {
	const { a, b, ea, eb } = await encryptedReceiver(
		t,
		{ "A.md": "reference" },
		"first-password",
	);
	const write = b.adapter.writeFile.bind(b.adapter);
	b.adapter.writeFile = async () => {
		throw new Error("synthetic interrupted receive");
	};
	assert.equal((await b.engine.fullSync()).success, false);
	b.adapter.writeFile = write;
	b.vault.put("A.md", bytes("late edit"));
	await transition(a, ea, "rotate", "second-password");
	await eb.workflow.connectForSync("second-password");
	await b.full();
	assert.equal(b.index.getLocalIndex().replacementReceive, undefined);
	b.assertLocal("A.md", "late edit");
	await b.full();
	await b.assertSettled({ "A.md": "late edit" });
});

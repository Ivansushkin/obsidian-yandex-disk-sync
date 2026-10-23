import assert from "node:assert/strict";
import test from "node:test";
import { prepareSettingsPatch } from "../src/settings-workflow";
import {
	MemoryDisk,
	bytes,
	codecFor,
	managedDevices,
} from "./helpers/sync-flow";

test("ordinary remote inventory honors configured read concurrency without changing device state", async (t) => {
	const device = managedDevices(t);
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const desktop = device(disk, "desktop", codec);
		const phone = device(disk, "phone", codec);
		for (let n = 0; n < 42; n++) {
			desktop.vault.put(
				`folder-${n}/nested/note.md`,
				bytes(`content-${n}`),
			);
		}
		await desktop.full();
		disk.folders.add("vault/.backup");
		disk.files.set("vault/.backup/kept.zip", bytes("protected archive"));
		const remote = structuredClone([...disk.files]);
		const local = await phone.saved();
		for (const limit of [1, 20, 40]) {
			Object.assign(
				phone.settings,
				prepareSettingsPatch(phone.settings, { maxConcurrency: limit })
					.settings,
			);
			let active = 0;
			let peak = 0;
			const slowFolder =
				await phone.client.getPhysicalPath("vault/folder-0");
			const childPaths = new Set(
				await Promise.all(
					Array.from({ length: 42 }, (_, n) =>
						phone.client.getPhysicalPath(
							`vault/folder-${n}/nested`,
						),
					),
				),
			);
			let slowPending = false;
			let childOverlapped = false;
			let releaseSlow!: () => void;
			const slow = new Promise<void>((resolve) => {
				releaseSlow = resolve;
			});
			let timeout: ReturnType<typeof setTimeout> | undefined;
			disk.beforeRequest = async (method, endpoint, path) => {
				assert.equal(method, "GET");
				assert.equal(endpoint, "/v1/disk/resources");
				assert.ok(!path.startsWith("vault/.backup"));
				if (childPaths.has(path) && slowPending) {
					childOverlapped = true;
					releaseSlow();
				}
				active++;
				peak = Math.max(peak, active);
				if (path === slowFolder && limit > 1) {
					slowPending = true;
					timeout = setTimeout(releaseSlow, 500);
					await slow;
					slowPending = false;
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			};
			disk.afterRequest = async () => {
				active--;
			};
			const files = await phone.index.getRemoteFiles();
			clearTimeout(timeout);
			assert.equal(active, 0);
			assert.equal(
				childOverlapped,
				limit > 1,
				"A discovered child uses a free slot before a slow sibling finishes",
			);
			assert.equal(peak, limit, `encrypted=${encrypted}, limit=${limit}`);
			assert.equal(files.size, 42);
			for (let n = 0; n < 42; n++) {
				const path = `folder-${n}/nested/note.md`;
				assert.equal(
					files.get(path)?.sha256,
					desktop.index.getLocalIndex().files[path]
						?.remoteFingerprint,
				);
			}
			assert.deepEqual([...disk.files], remote);
			assert.deepEqual(await phone.saved(), local);
			assert.equal(phone.vault.files.size, 0);
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
		}
		// A failed directory cannot release the invocation while a sibling is still running.
		const getResource = phone.client.getResource.bind(phone.client);
		const orderedFolders = (
			await Promise.all(
				Array.from({ length: 42 }, (_, n) =>
					phone.client.getPhysicalPath(`vault/folder-${n}`),
				),
			)
		).sort();
		const slowPath = orderedFolders[0]!;
		const failedPath = orderedFolders[1]!;
		let release!: () => void;
		let started!: () => void;
		let failed!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const failureObserved = new Promise<void>((resolve) => {
			failed = resolve;
		});
		const visited: string[] = [];
		phone.client.getResource = async (path, ...args) => {
			visited.push(path.replace(/^disk:\//, ""));
			if (path.replace(/^disk:\//, "") === slowPath) {
				started();
				await gate;
			}
			if (path.replace(/^disk:\//, "") === failedPath) {
				await slowStarted;
				failed();
				throw new Error("synthetic directory failure");
			}
			return await getResource(path, ...args);
		};
		let settled = false;
		const traversal = phone.client
			.getResourcesRecursive("vault", true, 2)
			.finally(() => {
				settled = true;
			});
		const rejected = assert.rejects(
			traversal,
			/synthetic directory failure/,
		);
		await failureObserved;
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(settled, false);
		release();
		await rejected;
		phone.client.getResource = getResource;
		assert.deepEqual(visited, ["vault", slowPath, failedPath]);
		assert.deepEqual([...disk.files], remote);
		assert.deepEqual(await phone.saved(), local);

		for (const invalid of [0, 41, 1.5, NaN, Infinity]) {
			assert.throws(() =>
				prepareSettingsPatch(phone.settings, {
					maxConcurrency: invalid,
				}),
			);
		}
	}
});

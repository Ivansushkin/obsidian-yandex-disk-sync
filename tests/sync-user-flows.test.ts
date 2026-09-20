import assert from "node:assert/strict";
import { BackupManager } from "../src/backup/backup-manager";
import {
	captureLogicalVaultSnapshot,
	captureRemoteRawSnapshot,
} from "../src/backup/backup-snapshot";
import type { ForcePreflightProof } from "../src/sync/contracts";
import JSZip from "jszip";
import test from "node:test";
import { computeSha256 } from "../src/utils/hash-utils";
import { MemoryDisk, bytes, codecFor, device } from "./helpers/sync-flow";

test("canonical reads reuse stable root metadata without weakening snapshot checks", async () => {
	for (const encrypted of [false, true]) {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		const b = device(
			disk,
			"device-b",
			encrypted ? null : await codecFor(true),
		);
		const path = "vault/.obsidian-sync-index.json";
		try {
			a.vault.put("__proto__", bytes("kept"));
			await a.full();
			const raw = disk.files.get(path)!.slice(0);
			let requests = 0;
			disk.beforeRequest = async (method) => {
				assert.equal(method, "GET");
				requests++;
			};
			const canonical = await a.index.readCanonicalIndex();
			assert.equal(
				canonical.files["__proto__"]?.sha256,
				await computeSha256(bytes("kept")),
			);
			assert.equal(requests, 5);
			requests = 0;
			assert.deepEqual(
				await b.index.readCanonicalIndexWithCodecIfPresent(codec),
				canonical,
			);
			assert.equal(requests, 5);
			assert.deepEqual(disk.files.get(path), raw);

			// Change raw bytes after download, before the final metadata observation.
			disk.afterRequest = async (_method, endpoint, resourcePath) => {
				if (endpoint === "/download" && resourcePath === path) {
					const changed = new Uint8Array(raw.slice(0));
					changed[0] = (changed[0] ?? 0) ^ 1;
					disk.files.set(path, changed.buffer);
				}
			};
			await assert.rejects(
				a.index.readCanonicalIndex(),
				/changed while being read/,
			);
			disk.afterRequest = undefined;
			disk.files.set(path, raw);
			assert.deepEqual(await a.index.readCanonicalIndex(), canonical);

			const locks = [
				"vault/.obsidian-sync-index.lock.a.1",
				"vault/.obsidian-sync-index.lock.b.2",
			];
			for (const lock of locks) {
				disk.files.set(lock, raw);
			}
			await assert.rejects(
				a.index.readCanonicalIndex(),
				/Multiple orphan index locks/,
			);
			for (const lock of locks) {
				disk.files.delete(lock);
			}
			disk.files.delete(path);
			assert.equal(
				await b.index.readCanonicalIndexWithCodecIfPresent(codec),
				null,
			);
			await assert.rejects(
				a.index.readCanonicalIndex(),
				/Canonical index is missing/,
			);
			assert.equal(disk.files.has(path), false);
			disk.files.set(path, raw);
			assert.deepEqual(a.vault.files.get("__proto__"), bytes("kept"));
			assert.deepEqual(a.index.getPendingMutations(), []);
			assert.deepEqual(a.index.getPendingPhysicalActions(), []);
		} finally {
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
			await b.stop();
		}
	}
});

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(`${mode} absent foreign tombstones stay read-only across restart`, async () => {
		const disk = new MemoryDisk();
		const codec = await codecFor(encrypted);
		const a = device(disk, "device-a", codec);
		let b = device(disk, "device-b", codec);
		const known = "Папка/известный #?&+.md";
		const unknown = "Папка/📝 %2F/__proto__.md";
		const expected = { "Keep.md": "keep" };
		try {
			a.vault.put("Keep.md", bytes("keep"));
			a.vault.put(known, bytes("known"));
			await a.full();
			await b.full();
			b.vault.remove(known);
			a.vault.put(unknown, bytes("unseen"));
			await a.full();
			a.vault.remove(known);
			a.vault.remove(unknown);
			await a.full();
			const committed = disk.files
				.get("vault/.obsidian-sync-index.json")!
				.slice(0);
			let writes = 0;
			disk.beforeRequest = async (method) => {
				if (method !== "GET") {
					writes++;
				}
			};
			for (let pass = 0; pass < 2; pass++) {
				const result = await b.full();
				assert.equal(result.deleted, 0);
				assert.equal(writes, 0);
				assert.deepEqual(
					disk.files.get("vault/.obsidian-sync-index.json"),
					committed,
				);
				assert.equal(
					b.index.getLocalIndex().files[known]?.deleted,
					true,
				);
				assert.equal(b.index.getLocalIndex().files[unknown], undefined);
				await b.assertSettled(expected);
				const saved = await b.saved();
				await b.stop();
				b = device(disk, "device-b", codec, b.vault, saved);
			}

			// A scan read failure and an existing folder are not proof of absence.
			b.vault.put(unknown, bytes("unreadable local file"));
			const read = b.vault.readBinary.bind(b.vault);
			b.vault.readBinary = async (file) => {
				if (file.path === unknown) {
					throw new Error("synthetic local read failure");
				}
				return await read(file);
			};
			assert.equal((await b.engine.fullSync()).success, false);
			assert.deepEqual(
				b.vault.files.get(unknown),
				bytes("unreadable local file"),
			);
			assert.equal(writes, 0);
			b.vault.readBinary = read;
			b.vault.remove(unknown);
			b.vault.folder(unknown);
			assert.equal((await b.engine.fullSync()).success, false);
			assert.equal(b.adapter.folderExists(unknown), true);
			assert.equal(writes, 0);
			b.vault.remove(unknown);

			// A failed local save cannot turn a read-only reconciliation into success.
			b.engine.setIndexSaveCallback(async () => {
				throw new Error("synthetic persistence failure");
			});
			assert.equal((await b.engine.fullSync()).success, false);
			assert.equal(writes, 0);
			const saved = await b.saved();
			await b.stop();
			b = device(disk, "device-b", codec, b.vault, saved);

			// The local scan is already finished when the physical tree is requested.
			const list = b.index.getRemoteFiles.bind(b.index);
			b.index.getRemoteFiles = async () => {
				const files = await list();
				b.vault.put(unknown, bytes("late create"));
				return files;
			};
			const late = await b.engine.fullSync();
			assert.equal(late.success, false);
			assert.equal(late.deleted, 0);
			assert.deepEqual(b.vault.files.get(unknown), bytes("late create"));
			assert.equal(writes, 0);
			assert.deepEqual(b.index.getPendingPhysicalActions(), []);
			b.index.getRemoteFiles = list;
			disk.beforeRequest = undefined;
			await b.full();
			await a.full();
			await b.assertSettled({ ...expected, [unknown]: "late create" });
			await a.assertSettled({ ...expected, [unknown]: "late create" });
		} finally {
			disk.beforeRequest = undefined;
			await a.stop();
			await b.stop();
		}
	});
	test(
		`${mode} real transactions drain rapid note and folder operations`,
		{ timeout: 30_000 },
		async () => {
			const disk = new MemoryDisk();
			const a = device(disk, "device-a", await codecFor(encrypted));
			try {
				a.vault.put("Без названия.md", bytes("initial"));
				await a.full();
				a.start();
				a.vault.put("Без названия.md", bytes("edited while renaming"));
				a.vault.rename("Без названия.md", "Новая.md");
				await a.drain();
				await a.assertSettled({ "Новая.md": "edited while renaming" });
				a.vault.folder("Папка/Вложенная");
				a.vault.rename("Новая.md", "Папка/Вложенная/Новая.md");
				a.vault.put("Папка/Копия.md", bytes("copy"));
				a.vault.put(
					"Папка/Вложенная/Без названия.md",
					bytes("nested copy"),
				);
				a.vault.rename(
					"Папка/Вложенная/Без названия.md",
					"Папка/Вложенная/Копия.md",
				);
				await a.drain();
				await a.assertSettled({
					"Папка/Вложенная/Новая.md": "edited while renaming",
					"Папка/Копия.md": "copy",
					"Папка/Вложенная/Копия.md": "nested copy",
				});
				a.vault.rename("Папка", "Промежуточная");
				a.vault.rename("Промежуточная", "Итог");
				a.vault.rename(
					"Итог/Вложенная/Копия.md",
					"Итог/Вложенная/Другое имя.md",
				);
				a.vault.put("Итог/Копия.md", bytes("latest edit"));
				await a.drain();
				await a.assertSettled({
					"Итог/Вложенная/Новая.md": "edited while renaming",
					"Итог/Копия.md": "latest edit",
					"Итог/Вложенная/Другое имя.md": "nested copy",
				});
				a.vault.remove("Итог/Вложенная");
				a.vault.put("Черновик.md", bytes("never synchronized"));
				a.vault.rename("Черновик.md", "Итог/Удалить.md");
				a.vault.remove("Итог/Удалить.md");
				await a.drain();
				await a.assertSettled({ "Итог/Копия.md": "latest edit" });
				a.vault.put("Draft/Deep/A.md", bytes("pending copy"));
				a.vault.put("Draft/B.md", bytes("second copy"));
				a.vault.rename("Draft", "Moved");
				a.vault.rename("Moved/Deep/A.md", "Moved/Deep/Final.md");
				await a.drain();
				await a.assertSettled({
					"Итог/Копия.md": "latest edit",
					"Moved/Deep/Final.md": "pending copy",
					"Moved/B.md": "second copy",
				});
				a.vault.remove("Moved");
				await a.drain();
				const uploadingPath = await a.client.getPhysicalPath(
					"vault/InFlight/Note.md",
				);
				let release!: () => void, entered!: () => void;
				const requestStarted = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const continueRequest = new Promise<void>((resolve) => {
					release = resolve;
				});
				disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === uploadingPath
					) {
						disk.beforeRequest = undefined;
						entered();
						await continueRequest;
					}
				};
				a.vault.put("InFlight/Note.md", bytes("upload snapshot"));
				const running = a.drain();
				await requestStarted;
				a.vault.rename("InFlight/Note.md", "InFlight/Renamed.md");
				a.vault.rename("InFlight", "AfterFlight");
				a.vault.put(
					"AfterFlight/Renamed.md",
					bytes("edited during upload"),
				);
				a.vault.put(
					"AfterFlight/Copy.md",
					bytes("copied during upload"),
				);
				release();
				await running;
				await a.drain();
				await a.assertSettled({
					"Итог/Копия.md": "latest edit",
					"AfterFlight/Renamed.md": "edited during upload",
					"AfterFlight/Copy.md": "copied during upload",
				});
				const movedPath = await a.client.getPhysicalPath(
					"vault/AfterFlight/Final.md",
				);
				let lostResponse = false;
				disk.afterRequest = async (method, endpoint, path) => {
					if (
						method === "POST" &&
						endpoint.endsWith("/resources/move") &&
						path === movedPath
					) {
						disk.afterRequest = undefined;
						lostResponse = true;
						throw new Error(
							"Synthetic lost response after physical move",
						);
					}
				};
				a.vault.rename(
					"AfterFlight/Renamed.md",
					"AfterFlight/Final.md",
				);
				await a.drain();
				assert.equal(lostResponse, true);
				await a.assertSettled({
					"Итог/Копия.md": "latest edit",
					"AfterFlight/Final.md": "edited during upload",
					"AfterFlight/Copy.md": "copied during upload",
				});
				a.vault.remove("AfterFlight");
				await a.drain();
				const folderUploadPath = await a.client.getPhysicalPath(
					"vault/PendingFolder/One.md",
				);
				const folderRequestStarted = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const continueFolderRequest = new Promise<void>((resolve) => {
					release = resolve;
				});
				disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === folderUploadPath
					) {
						disk.beforeRequest = undefined;
						entered();
						await continueFolderRequest;
					}
				};
				a.vault.put("PendingFolder/One.md", bytes("one"));
				a.vault.put("PendingFolder/Two.md", bytes("two"));
				const folderRunning = a.drain();
				await folderRequestStarted;
				a.vault.rename("PendingFolder", "Step");
				a.vault.rename("Step", "Ready");
				a.vault.rename("Ready/One.md", "Ready/Final.md");
				a.vault.remove("Ready/Two.md");
				a.vault.put("Ready/Three.md", bytes("three"));
				release();
				await folderRunning;
				await a.drain();
				await a.assertSettled({
					"Итог/Копия.md": "latest edit",
					"Ready/Final.md": "one",
					"Ready/Three.md": "three",
				});
				a.vault.remove("Ready");
				await a.drain();
				const b = device(disk, "device-b", await codecFor(encrypted));
				try {
					await b.full();
					await b.assertSettled({ "Итог/Копия.md": "latest edit" });
					b.vault.put("Итог/Копия.md", bytes("offline B edit"));
					a.vault.put("Итог/Копия.md", bytes("online A edit"));
					await a.drain();
					await b.full();
					await a.full();
					await b.full();
					const expected: Record<string, string> = {};
					for (const file of b.adapter.getAllSyncableFiles()) {
						expected[file.path] = new TextDecoder().decode(
							await b.adapter.readFile(file.path),
						);
					}
					assert.deepEqual(
						new Set(Object.values(expected)),
						new Set(["offline B edit", "online A edit"]),
					);
					await a.assertSettled(expected);
					await b.assertSettled(expected);
					a.vault.put("Restored.md", bytes("before deletion"));
					await a.drain();
					await b.full();
					a.vault.remove("Restored.md");
					await a.drain();
					await b.full();
					assert.equal(b.vault.files.has("Restored.md"), false);
					b.vault.put("Restored.md", bytes("explicitly restored"));
					await b.full();
					await a.full();
					expected["Restored.md"] = "explicitly restored";
					await a.assertSettled(expected);
					await b.assertSettled(expected);
					const backup = new BackupManager(
						a.client,
						a.adapter,
						{
							...a.settings,
							encryptionPassword: encrypted
								? "synthetic-flow-password"
								: null,
						},
						"2.0.0",
					);
					const created = await a.engine.runExclusiveMaintenance(() =>
						backup.createBackup(),
					);
					assert.equal(created.success, true, created.error);
					const zip = await JSZip.loadAsync(
						await backup.downloadBackup(
							`vault/.backup/${created.backupName}`,
						),
					);
					for (const [path, text] of Object.entries(expected)) {
						assert.equal(
							await zip.file(path)!.async("string"),
							text,
						);
					}
				} finally {
					await b.stop();
				}
			} finally {
				await a.stop();
			}
		},
	);
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(
		`${mode} real transactions recover a failed rename and its blocked copies after restart`,
		{ timeout: 30_000 },
		async () => {
			const disk = new MemoryDisk(),
				codec = await codecFor(encrypted);
			let a = device(disk, "device-a", codec);
			try {
				a.vault.put("Source.md", bytes("old"));
				await a.full();
				a.start();
				disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path.includes(".lock.")
					) {
						throw new Error(
							"Synthetic connection lost before commit",
						);
					}
				};
				a.vault.put("Source.md", bytes("new"));
				a.vault.rename("Source.md", "Renamed.md");
				await a.drain();
				// Older builds accumulated these target puts on each failed rename retry.
				for (let retry = 0; retry < 2; retry++) {
					a.index.enqueueMutation("put", "Renamed.md", {
						sha256: await computeSha256(
							bytes("obsolete retry snapshot"),
						),
						...a.engine.getWatcherCausalContext(),
					});
				}
				a.vault.put("Folder/Deep/Copy.md", bytes("copy"));
				await a.stop();
				const saved = await a.saved();
				if (saved.pendingMutations.length !== 3) {
					throw new Error(
						"Failure must retain the original move and both old retry puts",
					);
				}
				disk.beforeRequest = undefined;
				a = device(disk, "device-a", codec, a.vault, saved);
				a.start();
				await a.drain();
				await a.assertSettled({
					"Renamed.md": "new",
					"Folder/Deep/Copy.md": "copy",
				});
				await a.full();
				await a.assertSettled({
					"Renamed.md": "new",
					"Folder/Deep/Copy.md": "copy",
				});
				await a.stop();
				const context = a.engine.getWatcherCausalContext();
				const b = device(disk, "device-b", codec);
				try {
					await b.full();
					b.vault.put("Rejected.md", bytes("new"));
					await b.full();
					b.vault.remove("Rejected.md");
					await b.full();
					a.vault.rename("Renamed.md", "Rejected.md");
					const writeBackup = a.vault.adapter.writeBinary;
					let raced = false;
					a.vault.adapter.writeBinary = async (path, content) => {
						await writeBackup(path, content);
						if (!raced) {
							raced = true;
							a.vault.put(
								"Rejected.md",
								bytes(
									"late edit during rejected rename backup",
								),
							);
						}
					};
					const outcome = await a.engine.renameFile(
						"Renamed.md",
						"Rejected.md",
						context,
					);
					assert.equal(raced, true);
					assert.equal(
						new TextDecoder().decode(
							a.vault.files.get("Rejected.md"),
						),
						"late edit during rejected rename backup",
					);
					assert.equal(outcome.status, "retry");
					assert.equal(
						(await a.canonical()).files["Rejected.md"]?.deleted,
						true,
					);
					assert.ok(
						a.index
							.getPendingPhysicalActions()
							.some(
								(action) =>
									action.type === "delete-local" &&
									action.path === "Rejected.md",
							),
					);
					await a.stop();
					a = device(
						disk,
						"device-a",
						codec,
						a.vault,
						await a.saved(),
					);
					await a.full();
					assert.ok(
						[...a.vault.files.values()].some(
							(content) =>
								new TextDecoder().decode(content) ===
								"late edit during rejected rename backup",
						),
						"Late bytes remain in a verified protective copy after recovery",
					);
					await a.assertSettled({ "Folder/Deep/Copy.md": "copy" });
				} finally {
					await b.stop();
				}
			} finally {
				disk.beforeRequest = undefined;
				await a.stop();
			}
		},
	);
}

for (const encrypted of [false, true]) {
	const mode = encrypted ? "encrypted" : "plaintext";
	test(
		`${mode} real Force replacement and foreign adoption preserve offline edits`,
		{ timeout: 30_000 },
		async () => {
			for (const withBackup of [false, true]) {
				const disk = new MemoryDisk();
				const a = device(disk, "device-a", await codecFor(encrypted));
				let b = device(disk, "device-b", await codecFor(encrypted));
				try {
					a.vault.put("Keep.md", bytes("initial"));
					await a.full();
					await b.full();
					b.vault.put("Keep.md", bytes("offline edit"));
					a.vault.remove("Keep.md");
					a.vault.put("Authoritative.md", bytes("force local"));
					const backup = new BackupManager(
						a.client,
						a.adapter,
						{
							...a.settings,
							encryptionPassword: encrypted
								? "synthetic-flow-password"
								: null,
						},
						"2.0.0",
					);
					for (const direction of [
						"from_local",
						"from_remote",
					] as const) {
						const canonical =
							await a.index.captureForceCanonicalProof();
						const snapshot =
							direction === "from_local"
								? await captureRemoteRawSnapshot(
										a.client,
										"vault",
									)
								: await captureLogicalVaultSnapshot(a.adapter);
						const proof: ForcePreflightProof = {
							direction,
							canonical,
							snapshotDigest: snapshot.digest,
							backup: null,
						};
						if (withBackup) {
							const archive =
								direction === "from_local"
									? await backup.createRemoteSnapshotBackup()
									: await backup.createBackup();
							assert.equal(archive.success, true, archive.error);
							assert.equal(
								archive.snapshotDigest,
								proof.snapshotDigest,
							);
							proof.backup = {
								backupName: archive.backupName!,
								backupSha256: archive.sha256!,
							};
						}
						const result =
							direction === "from_local"
								? await a.engine.forceSyncFromLocal({
										forcePreflightProof: proof,
									})
								: await a.engine.forceSyncFromRemote({
										forcePreflightProof: proof,
									});
						assert.equal(
							result.success,
							true,
							JSON.stringify(result.errors),
						);
						await a.full();
						if (direction === "from_local") {
							await a.assertSettled({
								"Authoritative.md": "force local",
							});
							if (!withBackup) {
								const before = await b.saved();
								disk.beforeRequest = async (
									method,
									endpoint,
									path,
								) => {
									if (
										method === "PUT" &&
										endpoint === "/upload" &&
										path.includes(".lock.")
									) {
										throw new Error(
											"Synthetic failed adoption commit",
										);
									}
								};
								assert.equal(
									(await b.engine.fullSync()).success,
									false,
								);
								await b.stop();
								const failed = await b.saved();
								assert.deepEqual(
									failed.localState.files,
									before.localState.files,
								);
								assert.equal(
									failed.localState.observedEpoch,
									before.localState.observedEpoch,
								);
								assert.deepEqual(
									failed.pendingMutations,
									before.pendingMutations,
								);
								disk.beforeRequest = undefined;
								b = device(
									disk,
									"device-b",
									await codecFor(encrypted),
									b.vault,
									failed,
								);
							}
							await b.full();
							await a.full();
							await a.assertSettled({
								"Authoritative.md": "force local",
								"Keep.md": "offline edit",
							});
							a.vault.put(
								"Authoritative.md",
								bytes("discarded local edit"),
							);
							a.vault.put(
								"Discard.md",
								bytes("discarded local addition"),
							);
						} else {
							await a.assertSettled({
								"Authoritative.md": "force local",
								"Keep.md": "offline edit",
							});
							await b.full();
							await b.assertSettled({
								"Authoritative.md": "force local",
								"Keep.md": "offline edit",
							});
						}
					}
					for (const current of [a, b]) {
						const settled = await current.full();
						assert.deepEqual(
							[
								settled.uploaded,
								settled.downloaded,
								settled.deleted,
								settled.conflicts,
							],
							[0, 0, 0, 0],
						);
					}
				} finally {
					disk.beforeRequest = undefined;
					await a.stop();
					await b.stop();
				}
			}
		},
	);
}

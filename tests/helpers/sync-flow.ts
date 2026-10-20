import assert from "node:assert/strict";
import { App, TFile, TFolder, type RequestUrlParam } from "obsidian";
import { YandexDiskClient } from "../../src/api/yandex-client";
import { VaultAdapter } from "../../src/api/vault-adapter";
import { IndexManager } from "../../src/sync/canonical/manager";
import { SyncEngine } from "../../src/sync/engine";
import {
	FileWatcher,
	type DeferredWatcherEvent,
} from "../../src/sync/realtime/watcher";
import {
	DEFAULT_SETTINGS,
	type LocalSyncState,
	type PendingMutation,
	type PendingPhysicalAction,
	type SyncIndex,
} from "../../src/types";
import {
	EncryptionService,
	type EncryptionCodec,
	SALT_LENGTH,
} from "../../src/crypto/encryption";
import { computeSha256 } from "../../src/utils/hash-utils";
import { logger } from "../../src/utils/logger";

export const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const parent = (path: string) =>
	path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Synthetic HTTP storage: only transport is replaced, never commits or codecs. */
export class MemoryDisk {
	readonly identity = crypto.randomUUID();
	files = new Map<string, ArrayBuffer>();
	folders = new Set(["", "vault"]);
	beforeRequest?: (
		method: string,
		endpoint: string,
		path: string,
	) => Promise<void>;
	afterRequest?: (
		method: string,
		endpoint: string,
		path: string,
	) => Promise<void>;
	async resource(path: string): Promise<Record<string, unknown> | null> {
		const content = this.files.get(path);
		if (!content && !this.folders.has(path)) {
			return null;
		}
		return {
			path: `disk:/${path}`,
			name: path.split("/").at(-1),
			type: content ? "file" : "dir",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
			resource_id: `${this.identity}:${path}`,
			size: content?.byteLength ?? 0,
			...(content ? { sha256: await computeSha256(content) } : {}),
		};
	}
	async request(params: RequestUrlParam) {
		const url = new URL(params.url);
		const path = (url.searchParams.get("path") ?? "").replace(
			/^disk:\//,
			"",
		);
		const endpoint = url.pathname;
		const method = params.method ?? "GET";
		await this.beforeRequest?.(method, endpoint, path);
		let status = 200;
		let json: Record<string, unknown> = {};
		let arrayBuffer = new ArrayBuffer(0);
		if (endpoint === "/download") {
			const content = this.files.get(path);
			if (content) {
				arrayBuffer = content.slice(0);
			} else {
				status = 404;
			}
		} else if (endpoint === "/upload") {
			if (!this.folders.has(parent(path))) {
				status = 404;
			} else if (
				this.files.has(path) &&
				url.searchParams.get("overwrite") !== "true"
			) {
				status = 409;
			} else {
				this.files.set(path, (params.body as ArrayBuffer).slice(0));
				status = 201;
			}
		} else if (endpoint.endsWith("/resources/upload")) {
			json = {
				href: `https://synthetic.invalid/upload?path=${encodeURIComponent(path)}&overwrite=${url.searchParams.get("overwrite")}`,
				method: "PUT",
				templated: false,
			};
		} else if (endpoint.endsWith("/resources/download")) {
			if (!this.files.has(path)) {
				status = 404;
			} else {
				json = {
					href: `https://synthetic.invalid/download?path=${encodeURIComponent(path)}`,
					method: "GET",
					templated: false,
				};
			}
		} else if (endpoint.endsWith("/resources/move")) {
			const from = url.searchParams.get("from")!;
			if (!this.files.has(from) && !this.folders.has(from)) {
				status = 404;
			} else if (this.files.has(path) || this.folders.has(path)) {
				status = 409;
			} else {
				for (const [name, content] of [...this.files]) {
					if (name === from || name.startsWith(`${from}/`)) {
						this.files.delete(name);
						this.files.set(path + name.slice(from.length), content);
					}
				}
				for (const name of [...this.folders]) {
					if (name === from || name.startsWith(`${from}/`)) {
						this.folders.delete(name);
						this.folders.add(path + name.slice(from.length));
					}
				}
				status = 201;
			}
		} else if (endpoint.endsWith("/resources") && method === "PUT") {
			if (this.folders.has(path) || this.files.has(path)) {
				status = 409;
			} else if (!this.folders.has(parent(path))) {
				status = 404;
			} else {
				this.folders.add(path);
				status = 201;
			}
		} else if (endpoint.endsWith("/resources") && method === "DELETE") {
			if (!this.folders.has(path) && !this.files.has(path)) {
				status = 404;
			} else {
				for (const name of [...this.files.keys()]) {
					if (name === path || name.startsWith(`${path}/`)) {
						this.files.delete(name);
					}
				}
				for (const name of [...this.folders]) {
					if (name === path || name.startsWith(`${path}/`)) {
						this.folders.delete(name);
					}
				}
				status = 204;
			}
		} else if (endpoint.endsWith("/resources") && method === "GET") {
			const resource = await this.resource(path);
			if (!resource) {
				status = 404;
			} else {
				json = resource;
				if (this.folders.has(path)) {
					const names = [...this.files.keys(), ...this.folders]
						.filter(
							(name) => name !== path && parent(name) === path,
						)
						.sort();
					const limit = Number(url.searchParams.get("limit") ?? 1000),
						offset = Number(url.searchParams.get("offset") ?? 0);
					json._embedded = {
						items: await Promise.all(
							names
								.slice(offset, offset + limit)
								.map((name) => this.resource(name)),
						),
						total: names.length,
						limit,
						offset,
						path,
						sort: "",
					};
				}
			}
		} else {
			throw new Error(
				`Unsupported synthetic endpoint: ${method} ${endpoint}`,
			);
		}
		if (status >= 400) {
			json = {
				error:
					status === 404
						? "DiskNotFoundError"
						: "DiskPathPointsToExistentDirectoryError",
				description: `Synthetic HTTP ${status}`,
			};
		}
		await this.afterRequest?.(method, endpoint, path);
		return {
			status,
			json,
			arrayBuffer,
			text: JSON.stringify(json),
			headers: {},
		};
	}
	install() {
		(
			globalThis as unknown as {
				__obsidianRequestUrl: (p: RequestUrlParam) => Promise<unknown>;
			}
		).__obsidianRequestUrl = (p) => this.request(p);
	}
}

/** Minimal Obsidian filesystem and events; the production VaultAdapter handles writes. */
export class MemoryVault {
	configDir = ".obsidian";
	files = new Map<string, ArrayBuffer>();
	entries = new Map<string, TFile | TFolder>();
	listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	adapter = {
		exists: async (path: string) => this.entries.has(path),
		mkdir: async (path: string) => {
			this.folder(path);
		},
		writeBinary: async (path: string, content: ArrayBuffer) => {
			this.put(path, content, false);
		},
		stat: async (path: string) =>
			this.files.has(path)
				? {
						type: "file",
						size: this.files.get(path)!.byteLength,
						mtime: 1,
						ctime: 1,
					}
				: null,
	};
	getName() {
		return "synthetic";
	}
	getFiles() {
		return [...this.entries.values()].filter(
			(entry) => entry instanceof TFile,
		);
	}
	getAllLoadedFiles() {
		return [...this.entries.values()];
	}
	getAbstractFileByPath(path: string) {
		return this.entries.get(path) ?? null;
	}
	on(name: string, callback: (...args: unknown[]) => void) {
		const listeners = this.listeners.get(name) ?? new Set();
		listeners.add(callback);
		this.listeners.set(name, listeners);
		return { name, callback };
	}
	offref(ref: { name: string; callback: (...args: unknown[]) => void }) {
		this.listeners.get(ref.name)?.delete(ref.callback);
	}
	emit(name: string, ...args: unknown[]) {
		for (const fn of this.listeners.get(name) ?? []) {
			fn(...args);
		}
	}
	folder(path: string) {
		if (!path || this.entries.has(path)) {
			return;
		}
		this.folder(parent(path));
		const folder = Object.assign(new TFolder(), {
			path,
			name: path.split("/").at(-1),
		});
		Object.defineProperty(folder, "children", {
			get: () =>
				[...this.entries.values()].filter(
					(entry) => parent(entry.path) === folder.path,
				),
		});
		this.entries.set(path, folder);
		this.emit("create", folder);
	}
	put(path: string, content: ArrayBuffer, emit = true) {
		this.folder(parent(path));
		const existing = this.entries.get(path);
		const file = Object.assign(existing ?? new TFile(), {
			path,
			name: path.split("/").at(-1),
			stat: { mtime: Date.now(), ctime: 1, size: content.byteLength },
		});
		this.entries.set(path, file);
		this.files.set(path, content.slice(0));
		if (emit) {
			this.emit(existing ? "modify" : "create", file);
		}
	}
	async readBinary(file: TFile) {
		assert.ok(this.files.has(file.path), `Missing local ${file.path}`);
		return this.files.get(file.path)!.slice(0);
	}
	async createBinary(path: string, content: ArrayBuffer) {
		assert.ok(!this.entries.has(path));
		this.put(path, content);
	}
	async modifyBinary(file: TFile, content: ArrayBuffer) {
		this.put(file.path, content);
	}
	async createFolder(path: string) {
		this.folder(path);
	}
	rename(from: string, to: string) {
		const source = this.entries.get(from);
		assert.ok(source, from);
		this.folder(parent(to));
		const pairs = [...this.entries].filter(
			([path]) => path === from || path.startsWith(`${from}/`),
		);
		for (const [path, entry] of pairs) {
			const target = to + path.slice(from.length);
			this.entries.delete(path);
			entry.path = target;
			this.entries.set(target, entry);
			const content = this.files.get(path);
			if (content) {
				this.files.delete(path);
				this.files.set(target, content);
			}
		}
		this.emit("rename", source, from);
		for (const [path, entry] of pairs) {
			if (path !== from) {
				this.emit("rename", entry, path);
			}
		}
	}
	remove(path: string) {
		const source = this.entries.get(path);
		if (!source) {
			return;
		}
		for (const name of [...this.entries.keys()]) {
			if (name === path || name.startsWith(`${path}/`)) {
				this.entries.delete(name);
				this.files.delete(name);
			}
		}
		this.emit("delete", source);
	}
}

export interface SavedDevice {
	localState: LocalSyncState;
	pendingMutations: PendingMutation[];
	pendingPhysicalActions: PendingPhysicalAction[];
	pendingWatcherEvents: DeferredWatcherEvent[];
}

export async function codecFor(
	encrypted: boolean,
): Promise<EncryptionCodec | null> {
	if (!encrypted) {
		return null;
	}
	const codec = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(12));
	await codec.initializeKey("synthetic-flow-password");
	return codec;
}

/** Compose the same sync components and persistence callbacks as the plugin. */
export function device(
	disk: MemoryDisk,
	id: string,
	codec: EncryptionCodec | null,
	vault = new MemoryVault(),
	saved?: SavedDevice,
) {
	disk.install();
	logger.configure({ consoleEnabled: false, fileEnabled: false });
	const settings = {
		...DEFAULT_SETTINGS,
		deviceId: id,
		remotePath: "vault",
		debounceDelay: 1,
		logToFile: false,
		enableRealtimeSync: true,
	};
	const app = {
		vault,
		workspace: { layoutReady: true },
		fileManager: {
			trashFile: async (file: TFile | TFolder) => vault.remove(file.path),
		},
	} as unknown as App;
	const adapter = new VaultAdapter(app, settings);
	const client = new YandexDiskClient({
		token: "synthetic",
		retryDelay: 0,
		maxRetries: 0,
	});
	client.setRemotePath("vault");
	client.setEncryptionService(codec);
	const index = new IndexManager(client, adapter, settings);
	client.setWriteGuard(() => index.assertRemoteScope());
	if (saved) {
		index.loadLocalIndexFromData(saved.localState);
		index.loadPendingMutations(saved.pendingMutations);
		index.loadPendingPhysicalActions(saved.pendingPhysicalActions);
	}
	const engine = new SyncEngine(client, adapter, index, settings);
	const watcher = new FileWatcher(app, engine, settings);
	if (saved) {
		watcher.loadDeferredEvents(saved.pendingWatcherEvents);
	}
	let persisted: SavedDevice;
	const persist = async () => {
		persisted = JSON.parse(
			JSON.stringify({
				localState: index.getLocalIndexData(),
				pendingMutations: index.getPendingMutations(),
				pendingPhysicalActions: index.getPendingPhysicalActions(),
				pendingWatcherEvents: watcher.getDeferredEvents(),
			}),
		) as SavedDevice;
	};
	engine.setIndexSaveCallback(persist);
	watcher.setPersistCallback(persist);
	engine.onSyncPrepare((c) => watcher.prepareForSync(c));
	engine.onSyncPause((c) => watcher.pauseForSync(c));
	engine.onSyncFinalize((c, r) => watcher.settleAfterReconciliation(c, r));
	engine.onSyncResume((c) => watcher.resumeAfterSync(c));
	return {
		settings,
		vault,
		adapter,
		client,
		index,
		engine,
		watcher,
		start: () => watcher.start(),
		async stop() {
			watcher.stop();
			await watcher.waitForPendingPersistence();
			await persist();
		},
		async saved() {
			await watcher.waitForPendingPersistence();
			await persist();
			return structuredClone(persisted);
		},
		lastSaved: () => structuredClone(persisted),
		async full() {
			const result = await engine.fullSync();
			assert.equal(result.success, true, JSON.stringify(result.errors));
			return result;
		},
		async drain() {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const access = watcher as unknown as {
				drainPendingFileEvents(): void;
				flushDeferredEvents(): Promise<void>;
			};
			access.drainPendingFileEvents();
			await access.flushDeferredEvents();
			await watcher.waitForPendingPersistence();
		},
		async canonical(): Promise<SyncIndex> {
			return await index.readCanonicalIndex();
		},
		async assertSettled(expected: Record<string, string>) {
			const canonical = await index.readCanonicalIndex();
			assert.equal(canonical.maintenance, undefined);
			assert.equal(index.getObservedEpoch(), canonical.epoch);
			assert.deepEqual(
				Object.keys(canonical.files)
					.filter((path) => !canonical.files[path]?.deleted)
					.sort(),
				Object.keys(expected).sort(),
			);
			for (const [path, text] of Object.entries(expected)) {
				assert.equal(
					new TextDecoder().decode(
						await client.downloadFile(`vault/${path}`),
					),
					text,
					`Remote bytes: ${path}`,
				);
				assert.equal(
					new TextDecoder().decode(vault.files.get(path)),
					text,
					`Local bytes: ${path}`,
				);
				assert.equal(
					canonical.files[path]?.sha256,
					await computeSha256(bytes(text)),
				);
				assert.equal(
					index.getLocalIndex().files[path]?.sha256,
					canonical.files[path]?.sha256,
				);
				assert.equal(
					Boolean(index.getLocalIndex().files[path]?.deleted),
					false,
				);
			}
			assert.deepEqual(index.getPendingMutations(), []);
			assert.deepEqual(index.getPendingPhysicalActions(), []);
			assert.deepEqual(watcher.getDeferredEvents(), []);
			assert.deepEqual(canonical.moves, {});
			assert.deepEqual(
				[...disk.files.keys()].filter((path) =>
					path.includes(".obsidian-sync-index.lock."),
				),
				[],
			);
			const expectedPhysical = await Promise.all(
				Object.keys(expected).map((path) =>
					client.getPhysicalPath(`vault/${path}`),
				),
			);
			assert.deepEqual(
				[...disk.files.keys()]
					.filter(
						(path) =>
							!path.startsWith("vault/.backup/") &&
							!path.startsWith("vault/.obsidian-sync-index") &&
							!path.endsWith("/.obsidian-sync-encryption.json"),
					)
					.sort(),
				expectedPhysical.sort(),
				"No orphan physical files",
			);
			assert.deepEqual(
				adapter
					.getAllSyncableFiles()
					.map((file) => file.path)
					.sort(),
				Object.keys(expected).sort(),
				"No orphan local files",
			);
		},
	};
}

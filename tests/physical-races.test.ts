import assert from "node:assert/strict";
import test from "node:test";
import { TFile, type App } from "obsidian";
import { VaultAdapter } from "../src/api/vault-adapter";
import { YandexDiskClient } from "../src/api/yandex-client";
import {
	applyDownloadedContent,
	deleteLocalFile,
	deleteRemoteFile,
	pruneRemoteFolders,
	type Dependencies,
} from "../src/sync/files/operations";
import {
	DEFAULT_SETTINGS,
	createEmptyIndex,
	type PendingPhysicalAction,
} from "../src/types";
import { logger } from "../src/utils/logger";
import {
	preserveLocalConflictCopy,
	type Dependencies as ReconciliationDependencies,
} from "../src/sync/reconciliation/commits";
import { computeSha256 } from "../src/utils/hash-utils";
import {
	deleteMoveSourceIfUnchanged,
	type Dependencies as MoveDependencies,
} from "../src/sync/files/remote-moves";
import { EncryptionService, SALT_LENGTH } from "../src/crypto/encryption";

logger.configure({ consoleEnabled: false, fileEnabled: false });
const bytes = (text: string) => new TextEncoder().encode(text).buffer;

test("conflict preservation retains edited copies and reuses its own bytes after restart", async () => {
	for (const race of [false, true]) {
		let raced = false;
		const preferred = "note_conflict_existing.md";
		const files = new Map([[preferred, bytes("offline conflict edit")]]);
		const canonical = createEmptyIndex("device", "E");
		canonical.files[preferred] = {
			path: preferred,
			sha256: await computeSha256(bytes("losing version")),
			size: 1,
			mtime: 1,
			syncedAt: 1,
		};
		const vault = {
			getAbstractFileByPath: (path: string) =>
				files.has(path) ? Object.assign(new TFile(), { path }) : null,
			getAllLoadedFiles: () =>
				[...files.keys()].map((path) =>
					Object.assign(new TFile(), { path }),
				),
			readBinary: async (file: TFile) => files.get(file.path)!,
			createBinary: async (path: string, content: ArrayBuffer) => {
				if (race && !raced) {
					raced = true;
					files.set(path, bytes("concurrent creation"));
					throw new Error("File already exists");
				}
				assert.equal(files.has(path), false);
				files.set(path, content);
			},
			modifyBinary: async () => {
				assert.fail("Existing conflict was overwritten");
			},
		};
		const deps = {
			vaultAdapter: new VaultAdapter(
				{ vault } as unknown as App,
				DEFAULT_SETTINGS,
			),
			indexManager: { readCanonicalIndex: async () => canonical },
			expectWatcherEvent: () => {},
		} as unknown as ReconciliationDependencies;
		const target = await preserveLocalConflictCopy(
			deps,
			"note.md",
			bytes("losing version"),
			preferred,
		);
		assert.notEqual(target, preferred);
		assert.equal(
			new TextDecoder().decode(files.get(preferred)),
			"offline conflict edit",
		);
		assert.equal(
			new TextDecoder().decode(files.get(target)),
			"losing version",
		);
		assert.equal(
			await preserveLocalConflictCopy(
				{ ...deps },
				"note.md",
				bytes("losing version"),
				preferred,
			),
			target,
		);
		assert.equal(files.size, race ? 3 : 2);
		if (race) {
			assert.equal(
				new TextDecoder().decode(
					files.get("note_conflict_existing_1.md"),
				),
				"concurrent creation",
			);
		}
	}
});

test("guarded local creation preserves a file created while parents are prepared", async () => {
	let content: ArrayBuffer | null = null;
	let suppressed = false;
	const file = Object.assign(new TFile(), { path: "folder/note.md" });
	const vault = {
		getAbstractFileByPath: () => (content ? file : null),
		getAllLoadedFiles: () => (content ? [file] : []),
		createFolder: async () => {
			content = bytes("late local creation");
		},
		readBinary: async () => content!,
		modifyBinary: async (_file: TFile, value: ArrayBuffer) => {
			content = value;
		},
		createBinary: async (_path: string, value: ArrayBuffer) => {
			content = value;
		},
	};
	const adapter = new VaultAdapter(
		{ vault } as unknown as App,
		DEFAULT_SETTINGS,
	);
	await assert.rejects(
		adapter.writeFile("folder/note.md", bytes("remote"), {
			expectedSha256: null,
			beforeWrite: () => {
				suppressed = true;
			},
		}),
		/Local file changed/,
	);
	assert.equal(new TextDecoder().decode(content!), "late local creation");
	assert.equal(suppressed, false);
});

test("local delete retains edits made during protective backup and its durable action", async () => {
	let content = bytes("before backup");
	let protectedBytes = "";
	let completed = false;
	const action = {
		id: "delete",
		epoch: "E",
		type: "delete-local",
		path: "note.md",
		origin: "force-reset",
	};
	const deps = {
		indexManager: {
			getPendingPhysicalAction: () => action,
			readCanonicalIndex: async () => createEmptyIndex("device", "E"),
			getLocalIndex: () => ({ files: {} }),
			completePhysicalAction: () => {
				completed = true;
			},
		},
		vaultAdapter: {
			fileExists: () => true,
			readFile: async () => content,
			backupOverwrittenFile: async (
				_path: string,
				value: ArrayBuffer,
			) => {
				protectedBytes = new TextDecoder().decode(value);
				content = bytes("late edit");
			},
			deleteFile: async () => {
				content = bytes("");
			},
			pruneEmptyLocalAncestors: async () => {},
		},
		expectWatcherEvent: () => {},
	} as unknown as Dependencies;
	await deleteLocalFile(deps, "note.md");
	assert.equal(new TextDecoder().decode(content), "late edit");
	assert.equal(protectedBytes, "before backup");
	assert.equal(completed, false);
});

test("physical delete retry preserves a foreign restored file", async () => {
	const codec = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(17));
	await codec.initializeKey("synthetic-race-password");
	for (const service of [null, codec]) {
		const canonical = createEmptyIndex("device", "E");
		let physicalBytes: ArrayBuffer | null = service
			? await service.encrypt(bytes("old"))
			: bytes("old");
		const oldSha = await computeSha256(physicalBytes);
		let resource: {
			sha256: string;
			modified: string;
			size: number;
		} | null = {
			sha256: oldSha,
			modified: "2026-01-01",
			size: physicalBytes.byteLength,
		};
		let attempts = 0;
		let completed = false;
		const action: PendingPhysicalAction = {
			id: "delete",
			epoch: "E",
			type: "delete-remote",
			path: "note.md",
			origin: "force-reset",
			expectedFingerprint: oldSha,
			canonicalRevision: 1,
			createdAt: 1,
		};
		const client = new YandexDiskClient({
			token: "synthetic",
			maxRetries: 1,
			retryDelay: 0,
		});
		client.setRemotePath("vault");
		client.setEncryptionService(service);
		client.getLogicalResource = async () =>
			resource as Awaited<
				ReturnType<YandexDiskClient["getLogicalResource"]>
			>;
		const runtime = globalThis as typeof globalThis & {
			__obsidianRequestUrl?: (params: {
				method?: string;
			}) => Promise<unknown>;
		};
		runtime.__obsidianRequestUrl = async ({ method }) => {
			assert.equal(method, "DELETE");
			attempts++;
			if (attempts === 1) {
				canonical.files["note.md"] = {
					path: "note.md",
					sha256: "new",
					mtime: 1,
					size: 3,
					syncedAt: 1,
				};
				physicalBytes = service
					? await service.encrypt(bytes("new"))
					: bytes("new");
				resource = {
					sha256: await computeSha256(physicalBytes),
					modified: "2026-01-02",
					size: physicalBytes.byteLength,
				};
			} else {
				resource = null;
				physicalBytes = null;
			}
			return {
				status: attempts === 1 ? 503 : 204,
				json: {},
				text: "",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
			};
		};
		try {
			await deleteRemoteFile(
				{
					settings: { ...DEFAULT_SETTINGS, remotePath: "vault" },
					yandexClient: client,
					indexManager: {
						getPendingPhysicalAction: () => action,
						readCanonicalIndex: async () => canonical,
						completePhysicalAction: () => {
							completed = true;
						},
					},
				} as unknown as Dependencies,
				"note.md",
			);
			assert.notEqual(physicalBytes, null);
			assert.equal(
				new TextDecoder().decode(
					service
						? await service.decrypt(physicalBytes)
						: physicalBytes,
				),
				"new",
			);
			assert.equal(canonical.files["note.md"]?.sha256, "new");
			assert.equal(attempts, 1);
			assert.equal(completed, true);
		} finally {
			delete runtime.__obsidianRequestUrl;
		}
	}
});

test("download protects differing local bytes without a baseline", async () => {
	let local = bytes("unsynced local");
	const incoming = bytes("canonical remote");
	const sha256 = await computeSha256(incoming);
	let protectedBytes: ArrayBuffer | undefined;
	let baseline: { sha256: string } | undefined;
	const vault = {
		fileExists: () => true,
		readFile: async () => local,
		getFileMtime: () => 1,
		backupOverwrittenFile: async (_path: string, content: ArrayBuffer) => {
			protectedBytes = content;
		},
		writeFile: async (_path: string, content: ArrayBuffer) => {
			local = content;
		},
	};
	await applyDownloadedContent(
		{
			vaultAdapter: vault,
			indexManager: {
				getLocalIndex: () => ({ files: {} }),
				getRemoteIndex: () => ({ files: { "note.md": { sha256 } } }),
				updateLocalFile: (
					_path: string,
					metadata: { sha256: string },
				) => {
					baseline = metadata;
				},
			},
			expectWatcherEvent: () => {},
		} as unknown as Dependencies,
		"note.md",
		incoming,
		{ remoteFingerprint: "synthetic" },
	);
	assert.equal(new TextDecoder().decode(protectedBytes), "unsynced local");
	assert.deepEqual(local, incoming);
	assert.equal(baseline?.sha256, sha256);
});

test("move source retry requires current move authority and an intact target", async () => {
	for (const change of ["move", "target", "fingerprint"] as const) {
		const canonical = createEmptyIndex("device", "E");
		const move = {
			id: "move",
			fromPath: "old.md",
			toPath: "new.md",
			kind: "file" as const,
			baseRevision: 1,
			changedRevision: 2,
			pending: true,
			lastModifiedBy: "device",
			mutationSeq: 1,
		};
		canonical.moves[move.id] = move;
		const metadata = {
			path: "old.md",
			deleted: true,
			sha256: "content",
			size: 1,
			mtime: 1,
			syncedAt: 1,
			changedRevision: 2,
		};
		canonical.files["old.md"] = metadata;
		canonical.files["new.md"] = {
			...metadata,
			path: "new.md",
			deleted: false,
			remoteFingerprint: "target-fingerprint",
		};
		const source = {
			type: "file" as const,
			path: "vault/old.md",
			name: "old.md",
			sha256: "source-fingerprint",
			modified: "2026-01-01",
			created: "2026-01-01",
			size: 1,
		};
		const target = {
			...source,
			path: "vault/new.md",
			name: "new.md",
			sha256: "target-fingerprint",
		};
		let targetExists = true;
		let attempts = 0;
		const client = new YandexDiskClient({
			token: "synthetic",
			maxRetries: 1,
			retryDelay: 0,
		});
		client.getLogicalResource = async (path) =>
			path.endsWith("old.md") ? source : targetExists ? target : null;
		const runtime = globalThis as typeof globalThis & {
			__obsidianRequestUrl?: (params: {
				method?: string;
			}) => Promise<unknown>;
		};
		runtime.__obsidianRequestUrl = async ({ method }) => {
			assert.equal(method, "DELETE");
			attempts++;
			if (change === "move") {
				move.pending = false;
			}
			if (change === "target") {
				targetExists = false;
			}
			if (change === "fingerprint") {
				source.sha256 = "changed-source";
			}
			return {
				status: 503,
				json: {},
				text: "",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
			};
		};
		try {
			await assert.rejects(
				deleteMoveSourceIfUnchanged(
					{
						settings: { ...DEFAULT_SETTINGS, remotePath: "vault" },
						yandexClient: client,
						indexManager: {
							readCanonicalIndex: async () => canonical,
						},
					} as unknown as MoveDependencies,
					"old.md",
					source,
					{
						id: "cleanup",
						type: "move-remote",
						path: "old.md",
						epoch: "E",
						origin: "move",
						expectedFingerprint: "source-fingerprint",
						canonicalRevision: 2,
						createdAt: 1,
					},
					metadata,
					"new.md",
					move,
					"E",
				),
				/authority or physical snapshot changed/,
			);
			assert.equal(attempts, 1);
			assert.equal(
				await client.getLogicalResource("vault/old.md"),
				source,
			);
		} finally {
			delete runtime.__obsidianRequestUrl;
		}
	}
});

test("folder cleanup retry preserves new canonical and excluded descendants", async () => {
	for (const excluded of [false, true]) {
		const canonical = createEmptyIndex("device", "E");
		let childExists = false;
		let attempts = 0;
		const client = new YandexDiskClient({
			token: "synthetic",
			maxRetries: 1,
			retryDelay: 0,
		});
		client.isFolderEmpty = async () => !childExists;
		const runtime = globalThis as typeof globalThis & {
			__obsidianRequestUrl?: (params: {
				method?: string;
			}) => Promise<unknown>;
		};
		runtime.__obsidianRequestUrl = async ({ method }) => {
			assert.equal(method, "DELETE");
			attempts++;
			childExists = true;
			if (!excluded) {
				canonical.files["folder/new.md"] = {
					path: "folder/new.md",
					sha256: "new",
					size: 1,
					mtime: 1,
					syncedAt: 1,
				};
			}
			return {
				status: 503,
				json: {},
				text: "",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
			};
		};
		try {
			await pruneRemoteFolders(
				{
					settings: { ...DEFAULT_SETTINGS, remotePath: "vault" },
					yandexClient: client,
					indexManager: {
						getRemoteIndex: () => canonical,
						readCanonicalIndex: async () => canonical,
					},
				} as unknown as Dependencies,
				["folder/deleted.md"],
			);
			assert.equal(attempts, 1);
			assert.equal(childExists, true);
		} finally {
			delete runtime.__obsidianRequestUrl;
		}
	}
});

test("guarded local update does not recreate a file deleted during identity verification", async () => {
	const content = bytes("original");
	const expectedSha256 = await computeSha256(content);
	const file = Object.assign(new TFile(), { path: "note.md" });
	let exists = true;
	let writes = 0;
	const vault = {
		getAbstractFileByPath: () => (exists ? file : null),
		getAllLoadedFiles: () => (exists ? [file] : []),
		readBinary: async () => {
			exists = false;
			return content;
		},
		createBinary: async () => {
			writes++;
		},
		modifyBinary: async () => {
			writes++;
		},
	};
	const adapter = new VaultAdapter(
		{ vault } as unknown as App,
		DEFAULT_SETTINGS,
	);
	await assert.rejects(
		adapter.writeFile("note.md", bytes("remote"), {
			expectedSha256,
			beforeWrite: () =>
				assert.fail("Rejected write must not suppress watcher events"),
		}),
		/Local file changed/,
	);
	assert.equal(writes, 0);
	assert.equal(exists, false);
});

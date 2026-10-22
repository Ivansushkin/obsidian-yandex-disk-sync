import assert from "node:assert/strict";
import { YandexApiError, YandexDiskClient } from "../src/api/yandex-client";
import { DEFAULT_SETTINGS, type YandexResource } from "../src/types";
import { IndexManager } from "../src/sync/canonical/manager";
import type { VaultAdapter } from "../src/api/vault-adapter";
import { captureRemoteRawSnapshot } from "../src/backup/backup-snapshot";
import { MemoryDisk, bytes } from "./helpers/sync-flow";

import {
	createClient,
	fileResource,
	httpTest as test,
	requestGlobal,
	response,
} from "./helpers/client-fixtures";

test("remote snapshot retries server listing errors and preserves persistent failures", async () => {
	for (const [status, failures, invalidBody] of [
		[500, 1, false],
		[503, 1, true],
		[502, 1, false],
		[504, 1],
		[500, 9],
	] as const) {
		const disk = new MemoryDisk();
		disk.files.set("vault/note.md", bytes("remote bytes"));
		let listings = 0;
		requestGlobal.__obsidianRequestUrl = async (params) => {
			if (params.url.includes("/resources?")) {
				listings++;
				if (listings <= failures) {
					if (invalidBody) {
						return Object.defineProperty(response(status), "json", {
							get: () => {
								throw new Error(
									"synthetic non-JSON provider body",
								);
							},
						});
					}
					return response(status, {
						error: "InternalServerError",
						description: "synthetic server failure",
					});
				}
			}
			return await disk.request(params);
		};
		const client = createClient({ maxRetries: 2 });
		if (failures === 9) {
			await assert.rejects(
				captureRemoteRawSnapshot(client, "vault"),
				(error) =>
					error instanceof YandexApiError && error.status === 500,
			);
			assert.equal(listings, 3);
		} else {
			const snapshot = await captureRemoteRawSnapshot(client, "vault");
			assert.deepEqual(snapshot.files, [
				{ path: "note.md", content: bytes("remote bytes") },
			]);
			assert.equal(listings, 2);
		}
	}
});

function directory(path: string, items: YandexResource[] = []): YandexResource {
	return {
		...fileResource(path),
		type: "dir",
		_embedded: {
			items,
			total: items.length,
			limit: 1000,
			offset: 0,
			path,
			sort: "",
		},
	};
}

class StableReadClient extends YandexDiskClient {
	private readIndex = 0;

	constructor(private readonly resources: Array<YandexResource | null>) {
		super({ token: "test", maxRetries: 0 });
	}

	override async getResource(): Promise<YandexResource | null> {
		return this.resources[this.readIndex++] ?? null;
	}

	override async downloadFile(): Promise<ArrayBuffer> {
		return new Uint8Array([1, 2, 3, 4]).buffer;
	}
}

test("stable raw read accepts unchanged content identity", async () => {
	const client = new StableReadClient([
		fileResource("vault/index", { md5: "same" }),
		fileResource("vault/index", { md5: "same", sha256: "strong" }),
	]);
	const snapshot = await client.downloadStableRawFile("vault/index");
	assert.ok(snapshot);
	assert.equal(snapshot.fingerprint, "sha256:strong");
	assert.equal(snapshot.raw.byteLength, 4);
});

test("stable raw read rejects content changed during download", async () => {
	const client = new StableReadClient([
		fileResource("vault/index", { md5: "before" }),
		fileResource("vault/index", { md5: "after" }),
	]);
	await assert.rejects(
		client.downloadStableRawFile("vault/index"),
		/changed while being read/,
	);
});

test("stable raw read reuses caller metadata as its before observation", async () => {
	const before = fileResource("vault/index", { md5: "same" });
	const client = new StableReadClient([
		fileResource("vault/index", { md5: "same", sha256: "strong" }),
	]);
	const snapshot = await client.downloadStableRawFile("vault/index", before);
	assert.ok(snapshot);
	assert.equal(snapshot.fingerprint, "sha256:strong");
});

test("resource id alone cannot prove stable service-file content", async () => {
	const withoutContentIdentity = {
		...fileResource("vault/index"),
		modified: "",
		resource_id: "stable-resource-id",
	};
	const client = new StableReadClient([
		withoutContentIdentity,
		withoutContentIdentity,
	]);
	await assert.rejects(
		client.downloadStableRawFile("vault/index"),
		/no stable content fingerprint/,
	);
});

class TreeClient extends YandexDiskClient {
	readonly visited: string[] = [];
	maxActive = 0;
	private active = 0;

	constructor() {
		super({ token: "test", maxRetries: 0 });
	}

	override async getResource(path: string): Promise<YandexResource | null> {
		this.visited.push(path);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		await Promise.resolve();
		this.active--;
		const children: Record<string, YandexResource[]> = {
			vault: [
				directory("vault/a"),
				directory("vault/b"),
				directory("vault/.backup"),
			],
			"vault/a": [fileResource("vault/a/a.md", { md5: "a" })],
			"vault/b": [fileResource("vault/b/b.md", { md5: "b" })],
		};
		const items = children[path];
		if (!items) {
			return null;
		}
		return directory(path, items);
	}
}

test("remote tree uses bounded folder concurrency and skips backup", async () => {
	const client = new TreeClient();
	const resources = await client.getResourcesRecursive("vault", true, 2);
	assert.deepEqual(
		resources.map((resource) => resource.path),
		["vault/a/a.md", "vault/b/b.md"],
	);
	assert.equal(client.visited.includes("vault/.backup"), false);
	assert.equal(client.maxActive, 2);
});

const cacheCases = [
	{
		name: "observed remote folders skip redundant mkdir",
		puts: 0,
		invalidate: async () => {},
	},
	{
		name: "confirmed delete and credential change invalidate folder observations",
		puts: 2,
		invalidate: async (client: YandexDiskClient) => {
			await client.deleteResource("vault", false, true);
			await client.createFolder("vault");
			client.setToken("second");
		},
	},
	{
		name: "not-found delete invalidates a cached folder observation",
		puts: 1,
		deleteStatus: 404,
		invalidate: async (client: YandexDiskClient) => {
			await client.deleteResource("vault", false, true);
		},
	},
	{
		name: "encryption codec change invalidates folder observations",
		puts: 1,
		invalidate: async (client: YandexDiskClient) => {
			client.setEncryptionService({} as never);
		},
	},
];
for (const scenario of cacheCases) {
	test(scenario.name, async () => {
		let puts = 0;
		requestGlobal.__obsidianRequestUrl = async ({ method }) => {
			if (method === "PUT") {
				puts++;
			}
			return method === "DELETE"
				? response(scenario.deleteStatus ?? 204)
				: response(method === "PUT" ? 201 : 200, directory("vault"));
		};
		const client = createClient();
		await client.getResource("vault", 1, 0, true);
		await scenario.invalidate(client);
		await client.createFolderRecursive("vault");
		assert.equal(puts, scenario.puts);
	});
}

test("unknown folder conflict requires directory readback", async () => {
	requestGlobal.__obsidianRequestUrl = async (params) => {
		const method = params.method ?? "GET";
		if (method === "PUT") {
			return response(409, {
				error: "UnknownConflict",
				description: "Path is occupied",
			});
		}
		return response(200, fileResource("vault"));
	};
	const client = createClient();
	await assert.rejects(client.createFolder("vault"), /Path is occupied/);
});

test("exclusive upload conflict never retries through folder creation", async () => {
	const calls: string[] = [];
	requestGlobal.__obsidianRequestUrl = async (params) => {
		calls.push(`${params.method ?? "GET"} ${params.url}`);
		return response(409, {
			error: "DiskResourceAlreadyExistsError",
			description: "Upload target exists",
		});
	};
	const client = createClient();
	await assert.rejects(
		client.uploadFile(
			"vault/file.md",
			new ArrayBuffer(0),
			true,
			true,
			false,
		),
		/Upload target exists/,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.includes("/resources/upload?"), true);
});

test("missing cached upload parent is recreated before retry", async () => {
	let uploadLinkAttempts = 0;
	let folderCreates = 0;
	let contentUploads = 0;
	requestGlobal.__obsidianRequestUrl = async (params) => {
		const method = params.method ?? "GET";
		if (params.url.includes("/resources/upload?")) {
			uploadLinkAttempts++;
			return uploadLinkAttempts === 1
				? response(404, {
						error: "DiskNotFoundError",
						description: "Parent folder is missing",
					})
				: response(200, { href: "https://upload.test/file" });
		}
		if (params.url === "https://upload.test/file") {
			contentUploads++;
			return response(201);
		}
		if (method === "PUT") {
			folderCreates++;
			return response(201);
		}
		return response(200, directory("vault/folder"));
	};
	const client = createClient();
	await client.getResource("vault/folder", 1, 0, true);
	await client.uploadFile(
		"vault/folder/file.md",
		new ArrayBuffer(0),
		true,
		true,
	);
	assert.equal(uploadLinkAttempts, 2);
	assert.equal(folderCreates, 1);
	assert.equal(contentUploads, 1);
});

for (const stage of ["guard", "verification"] as const) {
	test(`upload ${stage} 404 cannot trigger parent recovery or confirm a write`, async () => {
		const original = bytes("current remote version");
		let remoteBytes = original;
		let puts = 0;
		let mkdirs = 0;
		let checks = 0;
		const failure = new YandexApiError("authority read failed", 404);
		requestGlobal.__obsidianRequestUrl = async (params) => {
			if (params.url.includes("/resources/upload?")) {
				return response(200, { href: "https://upload.test/file" });
			}
			if (params.url === "https://upload.test/file") {
				puts++;
				if (stage === "verification" && puts === 1) {
					return response(503);
				}
				remoteBytes = params.body as ArrayBuffer;
				return response(201);
			}
			if (params.method === "PUT") {
				mkdirs++;
				return response(201);
			}
			return response(200, directory("vault/folder"));
		};
		const client = createClient();
		await client.getResource("vault/folder", 1, 0, true);
		await assert.rejects(
			client.uploadFile(
				"vault/folder/file.md",
				bytes("stale replacement"),
				stage === "guard",
				true,
				true,
				async () => {
					checks++;
					if (stage === "guard" && checks === 2) {
						throw failure;
					}
				},
				async () => {
					throw failure;
				},
			),
			(error) => error === failure,
		);
		assert.deepEqual(remoteBytes, original);
		assert.equal(mkdirs, 0);
		assert.equal(puts, stage === "guard" ? 0 : 1);
	});
}

test("DELETE retry revalidates revoked authority before sending another request", async () => {
	const original = new TextEncoder().encode("current plaintext").buffer;
	let remoteBytes = original;
	let authorized = true;
	let requests = 0;
	requestGlobal.__obsidianRequestUrl = async () => {
		requests++;
		if (requests === 1) {
			authorized = false;
			return response(503);
		}
		remoteBytes = new ArrayBuffer(0);
		return response(204);
	};
	const client = createClient({ maxRetries: 2 });
	await assert.rejects(
		client.deleteResource("vault/note.md", false, true, async () => {
			if (!authorized) {
				throw new Error("cleanup authority revoked");
			}
		}),
		/authority revoked/,
	);
	assert.equal(requests, 1);
	assert.deepEqual(remoteBytes, original);
});

test("DELETE guard failures are not treated as resource absence", async () => {
	const client = createClient({ maxRetries: 1 });
	for (const priorAttempts of [0, 1]) {
		for (const failure of [
			new YandexApiError("canonical disappeared", 404),
			new YandexApiError("authentication failed", 401),
			new Error("decryption failed"),
		]) {
			let sent = 0;
			requestGlobal.__obsidianRequestUrl = async () => {
				sent++;
				return response(503);
			};
			await assert.rejects(
				client.deleteResource(
					"vault/note.md",
					false,
					true,
					async () => {
						if (sent === priorAttempts) {
							throw failure;
						}
					},
				),
				(error) => error === failure,
			);
			assert.equal(sent, priorAttempts);
		}
	}
	let checked = false;
	requestGlobal.__obsidianRequestUrl = async () => {
		assert.equal(checked, true);
		return response(404);
	};
	await client.deleteResource("vault/note.md", false, true, async () => {
		checked = true;
	});
	requestGlobal.__obsidianRequestUrl = async (params) =>
		params.method === "DELETE"
			? response(202, { href: "https://synthetic.invalid/operation" })
			: response(404);
	await assert.rejects(
		client.deleteResource("vault/note.md", false, true),
		(error) => error instanceof YandexApiError && error.status === 404,
	);
});

test("direct download retries transient transfer failures with fresh links and stops at final errors", async () => {
	const content = new TextEncoder().encode("complete download").buffer;
	for (const kind of [
		"network",
		503,
		500,
		502,
		504,
		"exhausted",
		"authentication",
	] as const) {
		let links = 0;
		let transfers = 0;
		requestGlobal.__obsidianRequestUrl = async (params) => {
			if (params.url.includes("/resources/download?")) {
				links++;
				return response(200, {
					href: `https://synthetic.invalid/content/${links}`,
				});
			}
			transfers++;
			assert.equal(
				params.url,
				`https://synthetic.invalid/content/${transfers}`,
			);
			if (kind === "authentication") {
				return response(401);
			}
			if (
				kind === "exhausted" ||
				(kind === "network" && transfers === 1)
			) {
				throw new Error(
					"Request Failed. SocketException Software caused connection abort",
				);
			}
			if (typeof kind === "number" && transfers === 1) {
				return response(kind);
			}
			return { ...response(200), arrayBuffer: content };
		};
		const client = createClient({ maxRetries: 2 });
		if (kind === "exhausted") {
			await assert.rejects(
				client.downloadFile("vault/note.md"),
				/connection abort/,
			);
		} else if (kind === "authentication") {
			await assert.rejects(
				client.downloadFile("vault/note.md"),
				(error) =>
					error instanceof YandexApiError && error.status === 401,
			);
		} else {
			assert.deepEqual(
				await client.downloadFile("vault/note.md"),
				content,
			);
		}
		assert.equal(
			transfers,
			kind === "exhausted" ? 3 : kind === "authentication" ? 1 : 2,
		);
		assert.equal(links, transfers);
	}
});

test("signed download 404 cannot classify a present encryption manifest as absent", async () => {
	requestGlobal.__obsidianRequestUrl = async (params) => {
		if (params.url.includes("/resources/download?")) {
			return response(200, { href: "https://synthetic.invalid/content" });
		}
		if (params.url.includes("/resources?")) {
			return response(
				200,
				fileResource("vault/.obsidian-encrypt.json", {
					sha256: "present",
				}),
			);
		}
		return response(404);
	};
	const client = createClient();
	const manager = new IndexManager(client, {} as VaultAdapter, {
		...DEFAULT_SETTINGS,
		remotePath: "vault",
	});
	await assert.rejects(
		manager.downloadEncryptionManifestForGuard(),
		/Download HTTP 404/,
	);
});

test("download budget includes metadata, fresh links and completed network failures", async () => {
	const originalNow = Date.now;
	for (const kind of ["raw", "logical", "retries"] as const) {
		let now = originalNow();
		Date.now = () => now;
		let transfers = 0;
		requestGlobal.__obsidianRequestUrl = async (params) => {
			now += 20;
			if (params.url.includes("/resources/download?")) {
				return response(200, {
					href: "https://synthetic.invalid/content",
				});
			}
			if (params.url.includes("/resources?")) {
				return response(
					200,
					fileResource("vault/note.md", { sha256: "stable" }),
				);
			}
			transfers++;
			if (kind === "retries") {
				throw new Error("synthetic completed network failure");
			}
			return response(200);
		};
		try {
			const client = new YandexDiskClient({
				token: "synthetic",
				retryDelay: 0,
				readTimeoutMs: 1000,
				downloadTimeoutMs: 50,
			});
			await assert.rejects(
				kind === "raw"
					? client.downloadStableRawFile("vault/note.md")
					: kind === "logical"
						? client.downloadStableLogicalFile("vault/note.md")
						: client.downloadFile("vault/note.md"),
				/Remote read timed out/,
			);
			assert.equal(
				transfers,
				1,
				"Budget exhaustion cannot start another transfer",
			);
		} finally {
			Date.now = originalNow;
			delete requestGlobal.__obsidianRequestUrl;
		}
	}
});

test("stalled remote reads expire without retrying an unresolved native request", async () => {
	for (const stage of ["link", "bytes", "metadata"] as const) {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blockedRequests = 0;
		requestGlobal.__obsidianRequestUrl = async (params) => {
			const link = params.url.includes("/resources/download?");
			if (
				(stage === "link" && link) ||
				stage === "metadata" ||
				(stage === "bytes" && !link)
			) {
				blockedRequests++;
				await gate;
			}
			return link
				? response(200, { href: "https://synthetic.invalid/content" })
				: response(200);
		};
		let safetyTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const client = new YandexDiskClient({
				token: "synthetic",
				maxRetries: 3,
				retryDelay: 0,
				readTimeoutMs: 10,
			});
			const operation =
				stage === "metadata"
					? client.getResource("vault/note.md")
					: client.downloadFile("vault/note.md");
			await assert.rejects(
				Promise.race([
					operation,
					new Promise((_, reject) => {
						safetyTimer = setTimeout(
							() => reject(new Error("test safety deadline")),
							250,
						);
					}),
				]),
				/Remote read timed out/,
			);
			assert.equal(blockedRequests, 1);
		} finally {
			clearTimeout(safetyTimer);
			release();
			delete requestGlobal.__obsidianRequestUrl;
		}
	}
});

test("unknown response decoding failure stops snapshot capture without transport retry", async () => {
	let requests = 0;
	const cause = new Error("synthetic invalid provider response");
	requestGlobal.__obsidianRequestUrl = async () => {
		requests++;
		return Object.defineProperty(response(200), "json", {
			get: () => {
				throw cause;
			},
		});
	};
	const client = new YandexDiskClient({
		token: "synthetic",
		maxRetries: 3,
		retryDelay: 0,
	});
	await assert.rejects(
		captureRemoteRawSnapshot(client, "vault"),
		(error) => error === cause,
	);
	assert.equal(requests, 1);
});

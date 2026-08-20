import assert from "node:assert/strict";
import test from "node:test";
import {
	YandexDiskClient,
} from "../src/api/yandex-client";
import type { YandexResource } from "../src/types";

interface TestRequestParams {
	url: string;
	method?: string;
}

interface TestResponse {
	status: number;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	text: string;
}

const requestGlobal = globalThis as typeof globalThis & {
	__obsidianRequestUrl?: (
		params: TestRequestParams,
	) => Promise<TestResponse>;
};

function response(status: number, json: unknown = {}): TestResponse {
	return {
		status,
		json,
		arrayBuffer: new ArrayBuffer(0),
		text: "",
	};
}

function fileResource(
	path: string,
	identity: Partial<YandexResource> = {},
): YandexResource {
	return {
		name: path.split("/").pop() ?? path,
		path,
		type: "file",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		size: 4,
		...identity,
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
	const snapshot = await client.downloadStableRawFile(
		"vault/index",
		before,
	);
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
				this.directory("vault/a"),
				this.directory("vault/b"),
				this.directory("vault/.backup"),
			],
			"vault/a": [fileResource("vault/a/a.md", { md5: "a" })],
			"vault/b": [fileResource("vault/b/b.md", { md5: "b" })],
		};
		const items = children[path];
		if (!items) return null;
		return this.directory(path, items);
	}

	private directory(path: string, items: YandexResource[] = []): YandexResource {
		return {
			name: path.split("/").pop() ?? path,
			path,
			type: "dir",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
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

test("observed remote folders skip redundant mkdir", async () => {
	const calls: string[] = [];
	requestGlobal.__obsidianRequestUrl = async (params) => {
		calls.push(`${params.method ?? "GET"} ${params.url}`);
		return response(
			200,
			{
				...fileResource("vault"),
				type: "dir",
				_embedded: { items: [], total: 0, limit: 1, offset: 0 },
			},
		);
	};
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
		await client.getResource("vault", 1, 0, true);
		await client.createFolderRecursive("vault");
		assert.equal(calls.filter((call) => call.startsWith("PUT ")).length, 0);
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
});

test("confirmed delete and credential change invalidate folder observations", async () => {
	const methods: string[] = [];
	requestGlobal.__obsidianRequestUrl = async (params) => {
		const method = params.method ?? "GET";
		methods.push(method);
		if (method === "GET") {
			return response(200, {
				...fileResource("vault"),
				type: "dir",
				_embedded: { items: [], total: 0, limit: 1, offset: 0 },
			});
		}
		return response(method === "DELETE" ? 204 : 201);
	};
	try {
		const client = new YandexDiskClient({ token: "first", maxRetries: 0 });
		await client.getResource("vault", 1, 0, true);
		await client.deleteResource("vault", false, true);
		await client.createFolder("vault");
		client.setToken("second");
		await client.createFolder("vault");
		assert.equal(methods.filter((method) => method === "PUT").length, 2);
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
});

test("not-found delete invalidates a cached folder observation", async () => {
	let folderCreates = 0;
	requestGlobal.__obsidianRequestUrl = async (params) => {
		const method = params.method ?? "GET";
		if (method === "DELETE") {
			return response(404, {
				error: "DiskNotFoundError",
				description: "Resource is absent",
			});
		}
		if (method === "PUT") {
			folderCreates++;
			return response(201);
		}
		return response(200, {
			...fileResource("vault/folder"),
			type: "dir",
			_embedded: { items: [], total: 0, limit: 1, offset: 0 },
		});
	};
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
		await client.getResource("vault/folder", 1, 0, true);
		await client.deleteResource("vault/folder", false, true);
		await client.createFolder("vault/folder");
		assert.equal(folderCreates, 1);
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
});

test("encryption codec change invalidates folder observations", async () => {
	const methods: string[] = [];
	requestGlobal.__obsidianRequestUrl = async (params) => {
		const method = params.method ?? "GET";
		methods.push(method);
		if (method === "GET") {
			return response(200, {
				...fileResource("vault"),
				type: "dir",
				_embedded: { items: [], total: 0, limit: 1, offset: 0 },
			});
		}
		return response(201);
	};
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
		await client.getResource("vault", 1, 0, true);
		client.setEncryptionService({} as never);
		await client.createFolder("vault");
		assert.equal(methods.filter((method) => method === "PUT").length, 1);
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
});

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
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
		await assert.rejects(client.createFolder("vault"), /Path is occupied/);
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
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
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
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
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
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
		return response(200, {
			...fileResource("vault/folder"),
			type: "dir",
			_embedded: { items: [], total: 0, limit: 1, offset: 0 },
		});
	};
	try {
		const client = new YandexDiskClient({ token: "test", maxRetries: 0 });
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
	} finally {
		delete requestGlobal.__obsidianRequestUrl;
	}
});

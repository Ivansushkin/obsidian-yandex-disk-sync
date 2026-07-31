import assert from "node:assert/strict";
import test from "node:test";
import {
	YandexDiskClient,
} from "../src/api/yandex-client";
import type { YandexResource } from "../src/types";

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

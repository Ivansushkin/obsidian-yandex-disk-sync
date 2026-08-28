import assert from "node:assert/strict";
import test from "node:test";
import {
	YandexApiError,
	type YandexDiskClient,
} from "../src/api/yandex-client";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { IndexManager } from "../src/sync/index-manager";
import { SyncEngine } from "../src/sync/sync-engine";
import { DEFAULT_SETTINGS } from "../src/types";

function createEngine(upload: () => Promise<void>): SyncEngine {
	return new SyncEngine(
		{ uploadFileExclusive: upload } as unknown as YandexDiskClient,
		{} as VaultAdapter,
		{} as IndexManager,
		{ ...DEFAULT_SETTINGS, remotePath: "vault" },
	);
}

test("encryption rewrite never overwrites a colliding target path", async () => {
	let attempts = 0;
	const access = createEngine(async () => {
		attempts++;
		throw new YandexApiError("already exists", 409);
	}) as unknown as {
		uploadPhysicalRewriteTarget(
			path: string,
			content: ArrayBuffer,
			verify: () => Promise<{ remoteFingerprint: string }>,
		): Promise<{ remoteFingerprint: string }>;
	};

	let verified = 0;
	assert.deepEqual(
		await access.uploadPhysicalRewriteTarget(
			"vault/raw",
			new ArrayBuffer(1),
			async () => {
				verified++;
				return { remoteFingerprint: "sha256:proven" };
			},
		),
		{ remoteFingerprint: "sha256:proven" },
	);
	assert.equal(attempts, 1);
	assert.equal(verified, 1);

	const failed = createEngine(async () => {
		throw new YandexApiError("locked", 423);
	}) as unknown as typeof access;
	await assert.rejects(
		failed.uploadPhysicalRewriteTarget(
			"vault/raw",
			new ArrayBuffer(1),
			async () => {
				throw new Error("read-back proof failed");
			},
		),
		/read-back proof failed/,
	);
});

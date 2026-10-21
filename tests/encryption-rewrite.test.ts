import * as encryptionRewrite from "../src/sync/workflows/encryption-rewrite";
import assert from "node:assert/strict";
import test from "node:test";
import {
	YandexApiError,
	type YandexDiskClient,
} from "../src/api/yandex-client";
function deps(upload: () => Promise<void>): encryptionRewrite.Dependencies {
	return {
		yandexClient: {
			uploadFileExclusive: upload,
		} as unknown as YandexDiskClient,
	} as encryptionRewrite.Dependencies;
}

test("encryption rewrite never overwrites a colliding target path", async () => {
	let attempts = 0;
	const access = deps(async () => {
		attempts++;
		throw new YandexApiError("already exists", 409);
	});

	let verified = 0;
	assert.deepEqual(
		await encryptionRewrite.uploadPhysicalRewriteTarget(
			access,
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

	const failed = deps(async () => {
		throw new YandexApiError("locked", 423);
	});
	await assert.rejects(
		encryptionRewrite.uploadPhysicalRewriteTarget(
			failed,
			"vault/raw",
			new ArrayBuffer(1),
			async () => {
				throw new Error("read-back proof failed");
			},
		),
		/read-back proof failed/,
	);
});

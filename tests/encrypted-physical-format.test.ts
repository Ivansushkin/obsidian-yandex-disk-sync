import assert from "node:assert/strict";
import test from "node:test";
import { YandexDiskClient } from "../src/api/yandex-client";
import { EncryptionService, SALT_LENGTH } from "../src/crypto/encryption";
import { fileResource } from "./helpers/client-fixtures";

test("encrypted path mapping preserves raw services and descendant identity while rejecting invalid names", async () => {
	const service = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(7));
	await service.initializeKey("current-password");
	const client = new YandexDiskClient({ token: "test-token" });
	client.setRemotePath("vault");
	client.setEncryptionService(service);
	const deep = Array.from(
		{ length: 20 },
		(_, index) => `папка-${index}`,
	).join("/");
	for (const relative of [
		"Папка/deep/Заметка.md",
		`${deep}/${"x".repeat(180)}.md`,
	]) {
		const logical = `vault/${relative}`;
		const physical = await client.getPhysicalPath(logical);
		assert.equal(
			physical.split("/").length,
			logical.split("/").length,
			relative,
		);
		assert.equal(physical.startsWith("vault/"), true, relative);
		assert.equal(await client.getPhysicalPath(logical), physical, relative);
		for (const [index, segment] of relative.split("/").entries()) {
			assert.notEqual(physical.split("/")[index + 1], segment, relative);
		}
	}
	const canonical = "vault/.obsidian-sync-index.json";
	assert.equal(await client.getPhysicalPath(canonical), canonical);
	const oldPath = await client.getPhysicalPath(
		"vault/old-parent/deep/emoji-🧪.md",
	);
	const newPath = await client.getPhysicalPath(
		"vault/new-parent/deep/emoji-🧪.md",
	);
	assert.notEqual(oldPath.split("/")[1], newPath.split("/")[1]);
	assert.deepEqual(oldPath.split("/").slice(2), newPath.split("/").slice(2));
	await assert.rejects(
		client.toLogicalResource(fileResource("disk:/vault/not+ciphertext")),
		/Base64URL/,
	);
});

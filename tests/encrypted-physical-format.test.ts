import assert from "node:assert/strict";
import test from "node:test";
import { YandexDiskClient } from "../src/api/yandex-client";
import { EncryptionService, SALT_LENGTH } from "../src/crypto/encryption";

async function createEncryptedClient(): Promise<{
	client: YandexDiskClient;
	service: EncryptionService;
}> {
	const salt = new Uint8Array(SALT_LENGTH);
	salt.fill(7);
	const service = new EncryptionService(salt);
	await service.initializeKey("current-password");
	const client = new YandexDiskClient({ token: "test-token" });
	client.setRemotePath("vault");
	client.setEncryptionService(service);
	return { client, service };
}

test("current encryption transforms every user path segment and content", async () => {
	const { client, service } = await createEncryptedClient();
	const logicalPath = "vault/Папка/deep/Заметка.md";
	const physicalPath = await client.getPhysicalPath(logicalPath);
	assert.notEqual(physicalPath, logicalPath);
	assert.equal(physicalPath.startsWith("vault/"), true);
	assert.equal(physicalPath.includes("Папка"), false);
	assert.equal(physicalPath.includes("Заметка.md"), false);
	assert.equal(await client.getPhysicalPath(logicalPath), physicalPath);

	const plaintext = new TextEncoder().encode("encrypted payload").buffer;
	const ciphertext = await service.encrypt(plaintext);
	assert.notDeepEqual(new Uint8Array(ciphertext), new Uint8Array(plaintext));
	assert.deepEqual(
		new Uint8Array(await service.decrypt(ciphertext)),
		new Uint8Array(plaintext),
	);
});

test("canonical service path stays raw while its content may be encrypted", async () => {
	const { client } = await createEncryptedClient();
	const canonical = "vault/.obsidian-sync-index.json";
	assert.equal(await client.getPhysicalPath(canonical), canonical);
});

test("invalid encrypted resource name never falls back to a logical path", async () => {
	const { client } = await createEncryptedClient();
	await assert.rejects(
		client.toLogicalResource({
			name: "not+ciphertext",
			path: "disk:/vault/not+ciphertext",
			type: "file",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
		}),
		/Base64URL/,
	);
});

test("hardened folder moves keep descendant physical segments unchanged", async () => {
	const service = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(9));
	await service.initializeKey("password");
	const client = new YandexDiskClient({ token: "test-token" });
	client.setRemotePath("vault");
	client.setEncryptionService(service);
	const oldPath = await client.getPhysicalPath(
		"vault/old-parent/deep/emoji-🧪.md",
	);
	const newPath = await client.getPhysicalPath(
		"vault/new-parent/deep/emoji-🧪.md",
	);
	assert.notEqual(oldPath.split("/")[1], newPath.split("/")[1]);
	assert.deepEqual(oldPath.split("/").slice(2), newPath.split("/").slice(2));

	const deepLogical = `vault/${Array.from(
		{ length: 20 },
		(_, index) => `папка-${index}`,
	).join("/")}/${"x".repeat(180)}.md`;
	const deepPhysical = await client.getPhysicalPath(deepLogical);
	assert.equal(deepPhysical.split("/").length, deepLogical.split("/").length);
});

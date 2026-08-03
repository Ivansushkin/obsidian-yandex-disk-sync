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
	await service.initializeKey("beta-2-test-password");
	const client = new YandexDiskClient({ token: "test-token" });
	client.setRemotePath("vault");
	client.setEncryptionService(service);
	return { client, service };
}

test("real encryption service transforms physical paths and content", async () => {
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

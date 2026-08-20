import assert from "node:assert/strict";
import test from "node:test";
import { aessiv } from "@noble/ciphers/aes.js";
import {
	EncryptionService,
	HardenedEncryptionService,
	SALT_LENGTH,
} from "../src/crypto/encryption";

function hex(value: string): Uint8Array {
	return Uint8Array.from(
		value.match(/../g)!.map((part) => Number.parseInt(part, 16)),
	);
}

test("AES-SIV matches the RFC 5297 deterministic vector", () => {
	const key = hex(
		"fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
	);
	const aad = hex("101112131415161718191a1b1c1d1e1f2021222324252627");
	const plaintext = hex("112233445566778899aabbccddee");
	assert.equal(
		Buffer.from(aessiv(key, aad).encrypt(plaintext)).toString("hex"),
		"85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c",
	);
});

test("legacy v2 filename format remains readable", async () => {
	const salt = new Uint8Array(SALT_LENGTH).fill(7);
	const service = new EncryptionService(salt);
	await service.initializeKey("legacy-password");
	const filename = "Заметка.md";
	const encrypted = await service.encryptFilename(filename);
	assert.equal(await service.decryptFilename(encrypted), filename);

	const publicIv = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${filename}:iv:${EncryptionService.bytesToBase64(salt)}`,
			),
		),
	).slice(0, 12);
	assert.deepEqual(
		EncryptionService.base64UrlDecode(encrypted).slice(0, 12),
		publicIv,
	);
});

const hardenedServicePromise = (async () => {
	const service = new HardenedEncryptionService(
		new Uint8Array(SALT_LENGTH).fill(11),
	);
	await service.initializeKey("hardened-password");
	return service;
})();

test("hardened v3 encrypts content and deterministic Unicode filenames", async () => {
	const service = await hardenedServicePromise;
	const plaintext = new TextEncoder().encode("content").buffer;
	const ciphertext = await service.encrypt(plaintext);
	assert.deepEqual(
		new Uint8Array(await service.decrypt(ciphertext)),
		new Uint8Array(plaintext),
	);

	for (const filename of [
		"Заметка.md",
		"emoji-🧪.md",
		".dotfile",
		"e\u0301.md",
		"é.md",
	]) {
		const first = await service.encryptFilename(filename);
		const second = await service.encryptFilename(filename);
		assert.equal(first, second);
		assert.equal(await service.decryptFilename(first), filename);
	}
});

test("hardened filename ciphertext does not expose the legacy public IV", async () => {
	const salt = new Uint8Array(SALT_LENGTH).fill(11);
	const service = await hardenedServicePromise;
	const filename = "guessable.md";
	const encrypted = EncryptionService.base64UrlDecode(
		await service.encryptFilename(filename),
	);
	const legacyPublicIv = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${filename}:iv:${EncryptionService.bytesToBase64(salt)}`,
			),
		),
	).slice(0, 12);
	assert.notDeepEqual(encrypted.slice(0, 12), legacyPublicIv);
});

test("encrypted filenames fail closed on invalid paths and ciphertext", async () => {
	const service = await hardenedServicePromise;
	for (const invalid of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
		await assert.rejects(service.encryptFilename(invalid));
	}
	await assert.rejects(service.decryptFilename("not+base64url"));
	const valid = EncryptionService.base64UrlDecode(
		await service.encryptFilename("safe.md"),
	);
	valid[valid.length - 1] = valid[valid.length - 1]! ^ 1;
	await assert.rejects(
		service.decryptFilename(EncryptionService.base64UrlEncode(valid)),
	);
});

test("hardened filename decryption rejects authenticated invalid UTF-8", async () => {
	const salt = new Uint8Array(SALT_LENGTH).fill(11);
	const passwordKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode("hardened-password"),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const masterBytes = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: 600_000,
			salt,
		},
		passwordKey,
		256,
	);
	const masterKey = await crypto.subtle.importKey(
		"raw",
		masterBytes,
		"HKDF",
		false,
		["deriveBits"],
	);
	const filenameKey = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt,
				info: new TextEncoder().encode(
					"obsidian-yandex-disk-sync:filename-key:v3",
				),
			},
			masterKey,
			512,
		),
	);
	const invalidUtf8 = aessiv(
		filenameKey,
		new TextEncoder().encode("obsidian-yandex-disk-sync:filename:v3"),
	).encrypt(new Uint8Array([0xff]));
	await assert.rejects(
		(await hardenedServicePromise).decryptFilename(
			EncryptionService.base64UrlEncode(invalidUtf8),
		),
		/encoded data|encoding/i,
	);
});

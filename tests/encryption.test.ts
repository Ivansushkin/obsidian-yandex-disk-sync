import assert from "node:assert/strict";
import test from "node:test";
import { aessiv } from "@noble/ciphers/aes.js";
import { EncryptionService, SALT_LENGTH } from "../src/crypto/encryption";

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

const hardenedServicePromise = (async () => {
	const service = new EncryptionService(new Uint8Array(SALT_LENGTH).fill(11));
	await service.initializeKey("hardened-password");
	return service;
})();

test("hardened encryption round-trips content and deterministic Unicode filenames", async () => {
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

test("hardened verifier uses the unnumbered verifier and content-key domains", async () => {
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
	const contentBytes = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: new TextEncoder().encode(
				"obsidian-yandex-disk-sync:content-key",
			),
		},
		masterKey,
		256,
	);
	const contentKey = await crypto.subtle.importKey(
		"raw",
		contentBytes,
		"AES-GCM",
		false,
		["decrypt"],
	);
	const verifier = EncryptionService.base64ToBytes(
		await (await hardenedServicePromise).createVerifier(),
	);
	const payload = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: verifier.slice(0, 12) },
		contentKey,
		verifier.slice(12),
	);
	assert.equal(
		new TextDecoder().decode(payload),
		"obsidian-yandex-disk-sync:encryption-verifier",
	);
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
					"obsidian-yandex-disk-sync:filename-key",
				),
			},
			masterKey,
			512,
		),
	);
	const invalidUtf8 = aessiv(
		filenameKey,
		new TextEncoder().encode("obsidian-yandex-disk-sync:filename"),
	).encrypt(new Uint8Array([0xff]));
	await assert.rejects(
		(await hardenedServicePromise).decryptFilename(
			EncryptionService.base64UrlEncode(invalidUtf8),
		),
		/encoded data|encoding/i,
	);
});

test("hardened codec rejects content and filename ciphertext from numbered historical domains", async () => {
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
	const historicalFilenameKey = new Uint8Array(
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
	const historicalCiphertext = aessiv(
		historicalFilenameKey,
		new TextEncoder().encode("obsidian-yandex-disk-sync:filename:v3"),
	).encrypt(new TextEncoder().encode("note.md"));

	await assert.rejects(
		(await hardenedServicePromise).decryptFilename(
			EncryptionService.base64UrlEncode(historicalCiphertext),
		),
	);

	const historicalContentBytes = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: new TextEncoder().encode(
				"obsidian-yandex-disk-sync:content:v3",
			),
		},
		masterKey,
		256,
	);
	const historicalContentKey = await crypto.subtle.importKey(
		"raw",
		historicalContentBytes,
		"AES-GCM",
		false,
		["encrypt"],
	);
	const iv = new Uint8Array(12).fill(4);
	const encryptedContent = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		historicalContentKey,
		new TextEncoder().encode("historical content"),
	);
	const historicalContent = new Uint8Array(
		iv.length + encryptedContent.byteLength,
	);
	historicalContent.set(iv);
	historicalContent.set(new Uint8Array(encryptedContent), iv.length);
	await assert.rejects(
		(await hardenedServicePromise).decrypt(historicalContent.buffer),
	);
});

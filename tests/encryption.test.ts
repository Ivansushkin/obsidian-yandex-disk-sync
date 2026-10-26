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

const salt = new Uint8Array(SALT_LENGTH).fill(11);
const password = "hardened-password";

const testMasterKey = (async () => {
	const passwordKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const masterBytes = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt },
		passwordKey,
		256,
	);
	return crypto.subtle.importKey("raw", masterBytes, "HKDF", false, [
		"deriveBits",
	]);
})();

/** Derive independent oracle keys without repeating the expensive password KDF. */
async function deriveTestKey(
	domain: string,
	bits: number,
): Promise<ArrayBuffer> {
	return crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt,
			info: new TextEncoder().encode(
				`obsidian-yandex-disk-sync:${domain}`,
			),
		},
		await testMasterKey,
		bits,
	);
}

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
		const legacyPublicIv = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					`${filename}:iv:${EncryptionService.bytesToBase64(salt)}`,
				),
			),
		).slice(0, 12);
		assert.notDeepEqual(
			EncryptionService.base64UrlDecode(first).slice(0, 12),
			legacyPublicIv,
			filename,
		);
	}
});

test("hardened verifier uses the unnumbered verifier and content-key domains", async () => {
	const contentBytes = await deriveTestKey("content-key", 256);
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

test("encrypted filenames reject unsafe paths, tampering and authenticated invalid UTF-8", async () => {
	const service = await hardenedServicePromise;
	for (const invalid of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
		await assert.rejects(
			service.encryptFilename(invalid),
			Error,
			JSON.stringify(invalid),
		);
	}
	const tampered = EncryptionService.base64UrlDecode(
		await service.encryptFilename("safe.md"),
	);
	tampered[tampered.length - 1]! ^= 1;
	const invalidUtf8 = aessiv(
		new Uint8Array(await deriveTestKey("filename-key", 512)),
		new TextEncoder().encode("obsidian-yandex-disk-sync:filename"),
	).encrypt(new Uint8Array([0xff]));
	for (const [label, ciphertext, error] of [
		["noncanonical encoding", "not+base64url", /Base64URL/],
		["modified tag", EncryptionService.base64UrlEncode(tampered), Error],
		[
			"authenticated invalid UTF-8",
			EncryptionService.base64UrlEncode(invalidUtf8),
			/encoded data|encoding/i,
		],
	] as const) {
		await assert.rejects(service.decryptFilename(ciphertext), error, label);
	}
});

test("hardened codec rejects content and filename ciphertext from numbered historical domains", async () => {
	const historicalFilenameKey = new Uint8Array(
		await deriveTestKey("filename-key:v3", 512),
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

	const historicalContentBytes = await deriveTestKey("content:v3", 256);
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

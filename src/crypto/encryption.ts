/**
 * Browser-compatible hardened encryption used by remote storage and transition
 * recovery. Historical encryption formats are unsupported.
 */

import { aessiv } from "@noble/ciphers/aes.js";

export type EncryptionProfileId = "hardened";

export interface EncryptionCodec {
	readonly profileId: EncryptionProfileId;
	initializeKey(password: string): Promise<void>;
	encrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
	decrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
	createVerifier(): Promise<string>;
	verifyVerifier(verifierBase64: string): Promise<boolean>;
	encryptFilename(originalPath: string): Promise<string>;
	decryptFilename(encryptedName: string): Promise<string>;
}

export const HARDENED_PBKDF2_ITERATIONS = 600_000;
export const AES_KEY_LENGTH = 256;
export const FILENAME_KEY_LENGTH = 512;
export const IV_LENGTH = 12;
export const SALT_LENGTH = 16;

const VERIFIER_PAYLOAD = "obsidian-yandex-disk-sync:encryption-verifier";
const CONTENT_KEY_INFO = new TextEncoder().encode(
	"obsidian-yandex-disk-sync:content-key",
);
const FILENAME_KEY_INFO = new TextEncoder().encode(
	"obsidian-yandex-disk-sync:filename-key",
);
const FILENAME_AAD = new TextEncoder().encode(
	"obsidian-yandex-disk-sync:filename",
);

/** Reject decrypted path segments before they can reach the vault adapter. */
export function assertValidLogicalPathSegment(segment: string): string {
	if (
		segment.length === 0 ||
		segment === "." ||
		segment === ".." ||
		segment.includes("/") ||
		segment.includes("\\") ||
		segment.includes("\0")
	) {
		throw new Error("Encrypted filename contains an invalid path segment");
	}
	return segment;
}

/** Hardened profile with separated content and filename keys. */
export class EncryptionService implements EncryptionCodec {
	readonly profileId = "hardened" as const;
	private contentKey: CryptoKey | null = null;
	private filenameKey: Uint8Array | null = null;
	private readonly salt: Uint8Array;
	private filenameEncCache = new Map<string, string>();
	private filenameDecCache = new Map<string, string>();

	constructor(salt: Uint8Array) {
		assertSalt(salt);
		this.salt = salt.slice();
	}

	static generateSalt(): Uint8Array {
		return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	}

	static bytesToBase64(bytes: Uint8Array): string {
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}

	static base64ToBytes(base64: string): Uint8Array {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	static base64UrlEncode(bytes: Uint8Array): string {
		return EncryptionService.bytesToBase64(bytes)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}

	static base64UrlDecode(base64url: string): Uint8Array {
		if (!/^[A-Za-z0-9_-]+$/.test(base64url)) {
			throw new Error("Encrypted filename is not canonical Base64URL");
		}
		let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
		while (base64.length % 4 !== 0) base64 += "=";
		const decoded = EncryptionService.base64ToBytes(base64);
		if (EncryptionService.base64UrlEncode(decoded) !== base64url) {
			throw new Error("Encrypted filename is not canonical Base64URL");
		}
		return decoded;
	}

	async initializeKey(password: string): Promise<void> {
		const passwordKey = await importPassword(password);
		const masterBytes = await crypto.subtle.deriveBits(
			{
				name: "PBKDF2",
				salt: this.salt,
				iterations: HARDENED_PBKDF2_ITERATIONS,
				hash: "SHA-256",
			},
			passwordKey,
			AES_KEY_LENGTH,
		);
		const masterKey = await crypto.subtle.importKey(
			"raw",
			masterBytes,
			"HKDF",
			false,
			["deriveBits"],
		);
		const contentBytes = await deriveSubkey(
			masterKey,
			this.salt,
			CONTENT_KEY_INFO,
			AES_KEY_LENGTH,
		);
		const filenameBytes = await deriveSubkey(
			masterKey,
			this.salt,
			FILENAME_KEY_INFO,
			FILENAME_KEY_LENGTH,
		);
		this.contentKey = await crypto.subtle.importKey(
			"raw",
			contentBytes,
			{ name: "AES-GCM" },
			false,
			["encrypt", "decrypt"],
		);
		this.filenameKey = new Uint8Array(filenameBytes);
	}

	async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		return await encryptContent(this.getContentKey(), data);
	}

	async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		return await decryptContent(this.getContentKey(), data);
	}

	async createVerifier(): Promise<string> {
		return await createVerifier(this);
	}

	async verifyVerifier(verifierBase64: string): Promise<boolean> {
		return await verifyVerifier(this, verifierBase64);
	}

	async encryptFilename(originalPath: string): Promise<string> {
		assertValidLogicalPathSegment(originalPath);
		const cached = this.filenameEncCache.get(originalPath);
		if (cached !== undefined) return cached;
		const encrypted = aessiv(this.getFilenameKey(), FILENAME_AAD).encrypt(
			new TextEncoder().encode(originalPath),
		);
		const result = EncryptionService.base64UrlEncode(encrypted);
		this.filenameEncCache.set(originalPath, result);
		return result;
	}

	async decryptFilename(encryptedName: string): Promise<string> {
		const cached = this.filenameDecCache.get(encryptedName);
		if (cached !== undefined) return cached;
		const ciphertext = EncryptionService.base64UrlDecode(encryptedName);
		if (ciphertext.length <= 16) {
			throw new Error("Encrypted filename is truncated");
		}
		const decrypted = aessiv(
			this.getFilenameKey(),
			FILENAME_AAD,
		).decrypt(ciphertext);
		const result = assertValidLogicalPathSegment(
			new TextDecoder("utf-8", { fatal: true }).decode(decrypted),
		);
		this.filenameDecCache.set(encryptedName, result);
		return result;
	}

	private getContentKey(): CryptoKey {
		if (!this.contentKey) {
			throw new Error("Hardened encryption is not initialized");
		}
		return this.contentKey;
	}

	private getFilenameKey(): Uint8Array {
		if (!this.filenameKey) {
			throw new Error("Hardened encryption is not initialized");
		}
		return this.filenameKey;
	}
}

export function createEncryptionCodec(
	profileId: EncryptionProfileId,
	salt: Uint8Array,
): EncryptionCodec {
	if (profileId !== "hardened") {
		throw new Error("Unsupported encryption profile");
	}
	return new EncryptionService(salt);
}

async function importPassword(password: string): Promise<CryptoKey> {
	return await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits", "deriveKey"],
	);
}

async function deriveSubkey(
	masterKey: CryptoKey,
	salt: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<ArrayBuffer> {
	return await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info },
		masterKey,
		length,
	);
}

async function encryptContent(
	key: CryptoKey,
	data: ArrayBuffer,
): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		data,
	);
	const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), IV_LENGTH);
	return result.buffer;
}

async function decryptContent(
	key: CryptoKey,
	data: ArrayBuffer,
): Promise<ArrayBuffer> {
	if (data.byteLength < IV_LENGTH + 16) {
		throw new Error("Encrypted content is truncated");
	}
	const bytes = new Uint8Array(data);
	return await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(0, IV_LENGTH) },
		key,
		bytes.slice(IV_LENGTH),
	);
}

async function createVerifier(codec: EncryptionCodec): Promise<string> {
	const payload = new TextEncoder().encode(VERIFIER_PAYLOAD);
	const encrypted = await codec.encrypt(payload.buffer);
	return EncryptionService.bytesToBase64(new Uint8Array(encrypted));
}

async function verifyVerifier(
	codec: EncryptionCodec,
	verifierBase64: string,
): Promise<boolean> {
	const encrypted = EncryptionService.base64ToBytes(verifierBase64);
	const decrypted = await codec.decrypt(encrypted.buffer);
	return (
		new TextDecoder("utf-8", { fatal: true }).decode(decrypted) ===
		VERIFIER_PAYLOAD
	);
}

function assertSalt(salt: Uint8Array): void {
	if (salt.length !== SALT_LENGTH) {
		throw new Error(`Salt must be ${SALT_LENGTH} bytes`);
	}
}

import { HARDENED_PBKDF2_ITERATIONS } from "../crypto/encryption";

const MAGIC = new TextEncoder().encode("OYDSBKP!");
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_LENGTH = 16 * 1024;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type BackupKind = "logical-vault" | "remote-raw";

export interface BackupEnvelopeHeader {
	kind: BackupKind;
	createdAt: number;
	pluginVersion: string;
	fileCount: number;
	kdf: {
		name: "PBKDF2";
		hash: "SHA-256";
		iterations: 600000;
		salt: string;
	};
	cipher: {
		name: "AES-GCM";
		keyLength: 256;
		iv: string;
	};
}

export interface OpenedBackupEnvelope {
	header: BackupEnvelopeHeader;
	content: ArrayBuffer;
}

export class BackupEnvelopeAuthenticationError extends Error {
	readonly cause: unknown;

	constructor(cause: unknown) {
		super("Backup envelope authentication failed");
		this.name = "BackupEnvelopeAuthenticationError";
		this.cause = cause;
	}
}

/** Seal ZIP bytes with parameters stored independently from vault encryption. */
export async function sealBackupEnvelope(
	content: ArrayBuffer,
	password: string,
	metadata: {
		kind: BackupKind;
		createdAt: number;
		pluginVersion: string;
		fileCount: number;
	},
): Promise<ArrayBuffer> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const header: BackupEnvelopeHeader = {
		kind: metadata.kind,
		createdAt: metadata.createdAt,
		pluginVersion: metadata.pluginVersion,
		fileCount: metadata.fileCount,
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: HARDENED_PBKDF2_ITERATIONS,
			salt: bytesToBase64(salt),
		},
		cipher: {
			name: "AES-GCM",
			keyLength: 256,
			iv: bytesToBase64(iv),
		},
	};
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	if (headerBytes.length > MAX_HEADER_LENGTH) {
		throw new Error("Backup envelope header is too large");
	}
	const key = await deriveBackupKey(password, salt);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: headerBytes },
		key,
		content,
	);
	const result = new Uint8Array(
		MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length + ciphertext.byteLength,
	);
	result.set(MAGIC, 0);
	new DataView(result.buffer).setUint32(MAGIC.length, headerBytes.length, false);
	result.set(headerBytes, MAGIC.length + HEADER_LENGTH_BYTES);
	result.set(
		new Uint8Array(ciphertext),
		MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length,
	);
	return result.buffer;
}

/** Open an envelope after strict, bounded header validation. */
export async function openBackupEnvelope(
	data: ArrayBuffer,
	password: string,
): Promise<OpenedBackupEnvelope> {
	const bytes = new Uint8Array(data);
	if (!isBackupEnvelope(data)) throw new Error("Unsupported backup envelope");
	if (bytes.length < MAGIC.length + HEADER_LENGTH_BYTES) {
		throw new Error("Backup envelope is truncated");
	}
	const headerLength = new DataView(data).getUint32(MAGIC.length, false);
	if (headerLength === 0 || headerLength > MAX_HEADER_LENGTH) {
		throw new Error("Invalid backup envelope header length");
	}
	const headerStart = MAGIC.length + HEADER_LENGTH_BYTES;
	const ciphertextStart = headerStart + headerLength;
	if (ciphertextStart + TAG_LENGTH > bytes.length) {
		throw new Error("Backup envelope is truncated");
	}
	const headerBytes = bytes.slice(headerStart, ciphertextStart);
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(headerBytes),
		);
	} catch {
		throw new Error("Invalid backup envelope header");
	}
	const header = parseHeader(parsed);
	const salt = decodeSizedBase64(header.kdf.salt, SALT_LENGTH, "salt");
	const iv = decodeSizedBase64(header.cipher.iv, IV_LENGTH, "IV");
	const key = await deriveBackupKey(password, salt);
	let content: ArrayBuffer;
	try {
		content = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv, additionalData: headerBytes },
			key,
			bytes.slice(ciphertextStart),
		);
	} catch (error) {
		throw new BackupEnvelopeAuthenticationError(error);
	}
	return { header, content };
}

export function isBackupEnvelope(data: ArrayBuffer): boolean {
	const bytes = new Uint8Array(data);
	return (
		bytes.length >= MAGIC.length &&
		MAGIC.every((byte, index) => bytes[index] === byte)
	);
}

function parseHeader(value: unknown): BackupEnvelopeHeader {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid backup envelope header");
	}
	const header = value as Record<string, unknown>;
	const kdf = header.kdf as Record<string, unknown> | undefined;
	const cipher = header.cipher as Record<string, unknown> | undefined;
	if (
		!hasExactKeys(header, [
			"kind",
			"createdAt",
			"pluginVersion",
			"fileCount",
			"kdf",
			"cipher",
		]) ||
		!kdf ||
		!hasExactKeys(kdf, ["name", "hash", "iterations", "salt"]) ||
		!cipher ||
		!hasExactKeys(cipher, ["name", "keyLength", "iv"]) ||
		(header.kind !== "logical-vault" && header.kind !== "remote-raw") ||
		typeof header.createdAt !== "number" ||
		!Number.isSafeInteger(header.createdAt) ||
		header.createdAt < 0 ||
		typeof header.pluginVersion !== "string" ||
		header.pluginVersion.length === 0 ||
		header.pluginVersion.length > 100 ||
		typeof header.fileCount !== "number" ||
		!Number.isSafeInteger(header.fileCount) ||
		header.fileCount < 0 ||
		kdf?.name !== "PBKDF2" ||
		kdf.hash !== "SHA-256" ||
		kdf.iterations !== HARDENED_PBKDF2_ITERATIONS ||
		typeof kdf.salt !== "string" ||
		cipher?.name !== "AES-GCM" ||
		cipher.keyLength !== 256 ||
		typeof cipher.iv !== "string"
	) {
		throw new Error("Invalid backup envelope header");
	}
	return value as BackupEnvelopeHeader;
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: string[],
): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		sortedExpected.every((key, index) => actual[index] === key)
	);
}

async function deriveBackupKey(
	password: string,
	salt: Uint8Array,
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return await crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: HARDENED_PBKDF2_ITERATIONS,
			salt,
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function decodeSizedBase64(
	value: string,
	expectedLength: number,
	label: string,
): Uint8Array {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		throw new Error(`Invalid backup envelope ${label}`);
	}
	const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (result.length !== expectedLength || bytesToBase64(result) !== value) {
		throw new Error(`Invalid backup envelope ${label}`);
	}
	return result;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

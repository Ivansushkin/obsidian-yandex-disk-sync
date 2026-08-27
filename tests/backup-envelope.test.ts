import assert from "node:assert/strict";
import test from "node:test";
import {
	BackupEnvelopeAuthenticationError,
	isBackupEnvelope,
	openBackupEnvelope,
	sealBackupEnvelope,
} from "../src/backup/backup-envelope";

const plaintext = new TextEncoder().encode("PK\u0003\u0004 test ZIP bytes").buffer;

test("backup envelope is self-contained and authenticated", async () => {
	const envelope = await sealBackupEnvelope(plaintext, "backup-password", {
		kind: "logical-vault",
		createdAt: 1_787_155_200_000,
		pluginVersion: "2.0.0",
		fileCount: 7,
	});
	assert.equal(isBackupEnvelope(envelope), true);
	const opened = await openBackupEnvelope(envelope, "backup-password");
	assert.deepEqual(new Uint8Array(opened.content), new Uint8Array(plaintext));
	assert.equal(opened.header.kind, "logical-vault");
	assert.equal(opened.header.fileCount, 7);
	assert.equal("version" in opened.header, false);
});

test("backup envelope rejects wrong password and modified ciphertext", async () => {
	const envelope = await sealBackupEnvelope(plaintext, "right-password", {
		kind: "remote-raw",
		createdAt: 1,
		pluginVersion: "2.0.0",
		fileCount: 1,
	});
	await assert.rejects(
		openBackupEnvelope(envelope, "wrong-password"),
		BackupEnvelopeAuthenticationError,
	);
	const corrupted = new Uint8Array(envelope.slice(0));
	corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
	await assert.rejects(
		openBackupEnvelope(corrupted.buffer, "right-password"),
		BackupEnvelopeAuthenticationError,
	);
});

test("backup envelope rejects unbounded or unsupported headers before KDF", async () => {
	const oversized = new Uint8Array(12);
	oversized.set(new TextEncoder().encode("OYDSBKP!"));
	new DataView(oversized.buffer).setUint32(8, 16 * 1024 + 1, false);
	await assert.rejects(
		openBackupEnvelope(oversized.buffer, "unused"),
		/header length/,
	);

	const envelope = new Uint8Array(
		await sealBackupEnvelope(plaintext, "password", {
			kind: "logical-vault",
			createdAt: 1,
			pluginVersion: "2.0.0",
			fileCount: 1,
		}),
	);
	const headerLength = new DataView(envelope.buffer).getUint32(8, false);
	const header = JSON.parse(
		new TextDecoder().decode(envelope.slice(12, 12 + headerLength)),
	) as { kdf: { iterations: number } };
	header.kdf.iterations = 700_000;
	const encoded = new TextEncoder().encode(JSON.stringify(header));
	assert.equal(encoded.length, headerLength);
	envelope.set(encoded, 12);
	await assert.rejects(openBackupEnvelope(envelope.buffer, "password"), /header/);
});

test("numbered historical backup magic is not accepted as a current envelope", () => {
	const historical = new TextEncoder().encode("OYDSBKP2").buffer;
	assert.equal(isBackupEnvelope(historical), false);
});

test("backup envelope rejects a numbered authenticated header field", async () => {
	const envelope = new Uint8Array(
		await sealBackupEnvelope(plaintext, "password", {
			kind: "logical-vault",
			createdAt: 1,
			pluginVersion: "2.0.0",
			fileCount: 1,
		}),
	);
	const headerLength = new DataView(envelope.buffer).getUint32(8, false);
	const header = JSON.parse(
		new TextDecoder().decode(envelope.slice(12, 12 + headerLength)),
	) as Record<string, unknown>;
	header.version = 2;
	const encoded = new TextEncoder().encode(JSON.stringify(header));
	const resized = new Uint8Array(
		12 + encoded.length + envelope.length - 12 - headerLength,
	);
	resized.set(envelope.slice(0, 8));
	new DataView(resized.buffer).setUint32(8, encoded.length, false);
	resized.set(encoded, 12);
	resized.set(envelope.slice(12 + headerLength), 12 + encoded.length);
	await assert.rejects(openBackupEnvelope(resized.buffer, "password"), /header/);
});

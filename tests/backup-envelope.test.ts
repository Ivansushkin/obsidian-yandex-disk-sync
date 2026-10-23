import assert from "node:assert/strict";
import test from "node:test";
import {
	BackupEnvelopeAuthenticationError,
	isBackupEnvelope,
	openBackupEnvelope,
	sealBackupEnvelope,
} from "../src/backup/backup-envelope";

const plaintext = new TextEncoder().encode(
	"PK\u0003\u0004 test ZIP bytes",
).buffer;

const backupMetadata = {
	kind: "logical-vault" as const,
	createdAt: 1,
	pluginVersion: "2.0.0",
	fileCount: 1,
};

test("backup envelope is self-contained and authenticated", async () => {
	const envelope = await sealBackupEnvelope(plaintext, "backup-password", {
		...backupMetadata,
		createdAt: 1_787_155_200_000,
		fileCount: 7,
	});
	assert.equal(isBackupEnvelope(envelope), true);
	const opened = await openBackupEnvelope(envelope, "backup-password");
	assert.deepEqual(new Uint8Array(opened.content), new Uint8Array(plaintext));
	assert.equal(opened.header.kind, "logical-vault");
	assert.equal(opened.header.fileCount, 7);
	assert.equal("version" in opened.header, false);
	const corrupted = new Uint8Array(envelope.slice(0));
	corrupted[corrupted.length - 1]! ^= 1;
	for (const [label, data, password] of [
		["wrong password", envelope, "wrong-password"],
		["modified ciphertext", corrupted.buffer, "backup-password"],
	] as const) {
		await assert.rejects(
			openBackupEnvelope(data, password),
			BackupEnvelopeAuthenticationError,
			label,
		);
	}
});

test("backup envelope rejects unbounded or unsupported headers before KDF", async () => {
	assert.equal(
		isBackupEnvelope(new TextEncoder().encode("OYDSBKP2").buffer),
		false,
	);
	const oversized = new Uint8Array(12);
	oversized.set(new TextEncoder().encode("OYDSBKP!"));
	new DataView(oversized.buffer).setUint32(8, 16 * 1024 + 1, false);
	await assert.rejects(
		openBackupEnvelope(oversized.buffer, "unused"),
		/header length/,
	);

	const envelope = new Uint8Array(
		await sealBackupEnvelope(plaintext, "password", backupMetadata),
	);
	for (const patch of [
		(header: Record<string, unknown>) => {
			(header.kdf as { iterations: number }).iterations = 700_000;
		},
		(header: Record<string, unknown>) => {
			header.version = 2;
		},
	]) {
		const length = new DataView(envelope.buffer).getUint32(8, false);
		const header = JSON.parse(
			new TextDecoder().decode(envelope.slice(12, 12 + length)),
		) as Record<string, unknown>;
		patch(header);
		const encoded = new TextEncoder().encode(JSON.stringify(header));
		const resized = new Uint8Array(
			12 + encoded.length + envelope.length - 12 - length,
		);
		resized.set(envelope.slice(0, 8));
		new DataView(resized.buffer).setUint32(8, encoded.length, false);
		resized.set(encoded, 12);
		resized.set(envelope.slice(12 + length), 12 + encoded.length);
		await assert.rejects(
			openBackupEnvelope(resized.buffer, "password"),
			/header/,
		);
	}
});

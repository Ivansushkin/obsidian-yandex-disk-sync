import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { VaultAdapter } from "../src/api/vault-adapter";
import type { YandexDiskClient } from "../src/api/yandex-client";
import {
	captureLogicalVaultDigest,
	captureLogicalVaultSnapshot,
	captureRemoteRawDigest,
	captureRemoteRawSnapshot,
} from "../src/backup/backup-snapshot";
import { fileResource } from "./helpers/client-fixtures";

test("digest-only snapshots preserve exact materialized identities for both source kinds", async () => {
	const source = [
		{ path: "Я/е́.md", content: new Uint8Array([0, 255, 13, 10]).buffer },
		{ path: "a.md", content: new ArrayBuffer(0) },
		{
			path: ".obsidian-sync-index.json",
			content: new Uint8Array([9]).buffer,
		},
		{ path: "É.md", content: new TextEncoder().encode("данные").buffer },
	];
	for (const entries of [source, []]) {
		const adapter = {
			getAllSyncableFiles: () => entries.map(({ path }) => ({ path })),
			readFile: async (path: string) =>
				entries.find((file) => file.path === path)!.content.slice(0),
		} as unknown as VaultAdapter;
		const client = {
			getResourcesRecursive: async (_root: string, raw: boolean) => {
				assert.equal(raw, true);
				return [
					...entries.map(({ path }) =>
						fileResource(`disk:/vault/${path}`),
					),
					fileResource("disk:/vault/.backup/archive.zip"),
					fileResource("disk:/vault/.backup"),
					fileResource("disk:/vault/folder", { type: "dir" }),
				];
			},
			downloadFile: async (path: string, raw: boolean) => {
				assert.equal(raw, true);
				return entries
					.find((file) => `disk:/vault/${file.path}` === path)!
					.content.slice(0);
			},
		} as unknown as YandexDiskClient;
		const ordered = [...entries].sort((left, right) =>
			left.path.localeCompare(right.path),
		);
		const identities = ordered.map(({ path, content }) => ({
			path,
			size: content.byteLength,
			sha256: createHash("sha256")
				.update(new Uint8Array(content))
				.digest("hex"),
		}));
		for (const [kind, snapshot, digest] of [
			[
				"logical-vault",
				await captureLogicalVaultSnapshot(adapter),
				await captureLogicalVaultDigest(adapter),
			],
			[
				"remote-raw",
				await captureRemoteRawSnapshot(client, "vault"),
				await captureRemoteRawDigest(client, "vault"),
			],
		] as const) {
			const expected = createHash("sha256")
				.update(JSON.stringify({ kind, files: identities }))
				.digest("hex");
			assert.equal(digest, expected);
			assert.equal(snapshot.digest, expected);
			assert.deepEqual(snapshot.files, ordered);
			assert.equal(
				snapshot.totalSize,
				identities.reduce((total, file) => total + file.size, 0),
			);
		}
	}
});

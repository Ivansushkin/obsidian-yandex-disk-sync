import type { YandexDiskClient } from "../api/yandex-client";
import type { VaultAdapter } from "../api/vault-adapter";
import { computeSha256, computeSha256FromString } from "../utils/hash-utils";
import { toLocalPath } from "../utils/path-utils";

export interface BackupSnapshotFile {
	path: string;
	content: ArrayBuffer;
}

export interface BackupSnapshot {
	files: BackupSnapshotFile[];
	totalSize: number;
	digest: string;
}

/** Capture the exact logical bytes that a local-vault backup protects. */
export async function captureLogicalVaultSnapshot(
	vaultAdapter: VaultAdapter,
): Promise<BackupSnapshot> {
	const files: BackupSnapshotFile[] = [];
	for (const file of [...vaultAdapter.getAllSyncableFiles()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		files.push({
			path: file.path,
			content: await vaultAdapter.readFile(file.path),
		});
	}
	return await finalizeSnapshot("logical-vault", files);
}

/** Capture raw remote bytes while excluding the protected backup namespace. */
export async function captureRemoteRawSnapshot(
	yandexClient: YandexDiskClient,
	remotePath: string,
): Promise<BackupSnapshot> {
	const resources = await yandexClient.getResourcesRecursive(remotePath, true);
	const remoteFiles = resources
		.filter((resource) => {
			if (resource.type !== "file") return false;
			const relative = toLocalPath(resource.path, remotePath);
			return relative !== ".backup" && !relative.startsWith(".backup/");
		})
		.sort((left, right) => left.path.localeCompare(right.path));
	const files: BackupSnapshotFile[] = [];
	for (const file of remoteFiles) {
		files.push({
			path: toLocalPath(file.path, remotePath),
			content: await yandexClient.downloadFile(file.path, true),
		});
	}
	return await finalizeSnapshot("remote-raw", files);
}

async function finalizeSnapshot(
	kind: "logical-vault" | "remote-raw",
	files: BackupSnapshotFile[],
): Promise<BackupSnapshot> {
	const identities = await Promise.all(
		files.map(async (file) => ({
			path: file.path,
			size: file.content.byteLength,
			sha256: await computeSha256(file.content),
		})),
	);
	return {
		files,
		totalSize: identities.reduce((total, file) => total + file.size, 0),
		digest: await computeSha256FromString(
			JSON.stringify({ kind, files: identities }),
		),
	};
}

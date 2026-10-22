import type { YandexDiskClient } from "../api/yandex-client";
import type { VaultAdapter } from "../api/vault-adapter";
import { computeSha256, computeSha256FromString } from "../utils/hash-utils";
import { isLegacyPluginDataPath, toLocalPath } from "../utils/path-utils";

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
	return await captureLogicalVault(vaultAdapter, []);
}

/** Hash the logical backup scope without retaining file contents. */
export async function captureLogicalVaultDigest(
	vaultAdapter: VaultAdapter,
): Promise<string> {
	return (await captureLogicalVault(vaultAdapter)).digest;
}

async function captureLogicalVault(
	vaultAdapter: VaultAdapter,
	files?: BackupSnapshotFile[],
): Promise<BackupSnapshot> {
	const paths = [...vaultAdapter.getAllSyncableFiles()]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => file.path);
	return await captureSnapshot(
		"logical-vault",
		paths,
		(path) => vaultAdapter.readFile(path),
		files,
	);
}

/** Capture raw remote bytes while excluding the protected backup namespace. */
export async function captureRemoteRawSnapshot(
	yandexClient: YandexDiskClient,
	remotePath: string,
): Promise<BackupSnapshot> {
	return await captureRemoteRaw(yandexClient, remotePath, []);
}

/** Hash raw remote backup bytes without retaining file contents. */
export async function captureRemoteRawDigest(
	yandexClient: YandexDiskClient,
	remotePath: string,
): Promise<string> {
	return (await captureRemoteRaw(yandexClient, remotePath)).digest;
}

/** Reject exposed plugin storage before reading either remote snapshot form. */
async function captureRemoteRaw(
	yandexClient: YandexDiskClient,
	remotePath: string,
	files?: BackupSnapshotFile[],
): Promise<BackupSnapshot> {
	const resources = await yandexClient.getResourcesRecursive(
		remotePath,
		true,
	);
	if (
		resources.some((resource) =>
			isLegacyPluginDataPath(toLocalPath(resource.path, remotePath)),
		)
	) {
		throw new Error(
			"Remote plugin data must be removed before a snapshot backup",
		);
	}
	const remoteFiles = resources
		.filter((resource) => {
			if (resource.type !== "file") {
				return false;
			}
			const relative = toLocalPath(resource.path, remotePath);
			return relative !== ".backup" && !relative.startsWith(".backup/");
		})
		.sort((left, right) => left.path.localeCompare(right.path));
	return await captureSnapshot(
		"remote-raw",
		remoteFiles.map((file) => file.path),
		(path) => yandexClient.downloadFile(path, true),
		files,
		(path) => toLocalPath(path, remotePath),
	);
}

/** Hash ordered identities and release each buffer before the next read unless archiving. */
async function captureSnapshot(
	kind: "logical-vault" | "remote-raw",
	paths: string[],
	readFile: (path: string) => Promise<ArrayBuffer>,
	files?: BackupSnapshotFile[],
	toSnapshotPath: (path: string) => string = (path) => path,
): Promise<BackupSnapshot> {
	const identities: { path: string; size: number; sha256: string }[] = [];
	for (const sourcePath of paths) {
		const path = toSnapshotPath(sourcePath);
		let content: ArrayBuffer | undefined = await readFile(sourcePath);
		const size = content.byteLength;
		const sha256 = await computeSha256(content);
		files?.push({ path, content });
		content = undefined;
		identities.push({ path, size, sha256 });
	}
	return {
		files: files ?? [],
		totalSize: identities.reduce((total, file) => total + file.size, 0),
		digest: await computeSha256FromString(
			JSON.stringify({ kind, files: identities }),
		),
	};
}

import type { YandexDiskClient } from "../api/yandex-client";
import type { VaultAdapter } from "../api/vault-adapter";
import { computeSha256, computeSha256FromString } from "../utils/hash-utils";
import {
	isForcePluginPath,
	isLegacyPluginDataPath,
	toLocalPath,
} from "../utils/path-utils";

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
	fullForce = false,
): Promise<BackupSnapshot> {
	return await captureLogicalVault(vaultAdapter, [], fullForce);
}

/** Hash the logical backup scope without retaining file contents. */
export async function captureLogicalVaultDigest(
	vaultAdapter: VaultAdapter,
	fullForce = false,
): Promise<string> {
	return (await captureLogicalVault(vaultAdapter, undefined, fullForce))
		.digest;
}

async function captureLogicalVault(
	vaultAdapter: VaultAdapter,
	files?: BackupSnapshotFile[],
	fullForce = false,
): Promise<BackupSnapshot> {
	const paths = fullForce
		? (await vaultAdapter.getForceTree(true)).files
		: [...vaultAdapter.getAllSyncableFiles()]
				.sort((left, right) => left.path.localeCompare(right.path))
				.map((file) => file.path);
	return await captureSnapshot(
		"logical-vault",
		paths,
		(path) =>
			fullForce
				? vaultAdapter.readForceFile(path)
				: vaultAdapter.readFile(path),
		files,
	);
}

/** Capture raw remote bytes while excluding the protected backup namespace. */
export async function captureRemoteRawSnapshot(
	yandexClient: YandexDiskClient,
	remotePath: string,
	forceConfigDir?: string,
): Promise<BackupSnapshot> {
	return await captureRemoteRaw(yandexClient, remotePath, [], forceConfigDir);
}

/** Hash raw remote backup bytes without retaining file contents. */
export async function captureRemoteRawDigest(
	yandexClient: YandexDiskClient,
	remotePath: string,
	forceConfigDir?: string,
): Promise<string> {
	return (
		await captureRemoteRaw(
			yandexClient,
			remotePath,
			undefined,
			forceConfigDir,
		)
	).digest;
}

/** Reject exposed plugin storage before reading either remote snapshot form. */
async function captureRemoteRaw(
	yandexClient: YandexDiskClient,
	remotePath: string,
	files?: BackupSnapshotFile[],
	forceConfigDir?: string,
): Promise<BackupSnapshot> {
	const resources = await yandexClient.getResourcesRecursive(
		remotePath,
		true,
		4,
		false,
		forceConfigDir
			? (path) => {
					const relative = toLocalPath(path, remotePath);
					return (
						relative !== ".backup" &&
						!relative.startsWith(".backup/") &&
						!isLegacyPluginDataPath(relative) &&
						!isForcePluginPath(relative, forceConfigDir)
					);
				}
			: undefined,
	);
	if (
		!forceConfigDir &&
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

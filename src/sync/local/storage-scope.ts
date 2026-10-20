import type { YandexDiskClient } from "../../api/yandex-client";
import type { RemoteStorageScope } from "../../types";
import { normalizePath } from "../../utils/path-utils";

/** A local history cannot authorize changes to an unidentified or different root. */
export class StorageScopeError extends Error {}

/** Read folder identity raw, independently of user-content encryption. */
export async function readRemoteStorageScope(
	client: YandexDiskClient,
	remotePath: string,
): Promise<RemoteStorageScope | null> {
	const path = normalizePath(remotePath.replace(/^disk:\//, ""));
	const resource = await client.getResource(path, 1, 0, true);
	if (!resource) {
		return null;
	}
	if (resource.type !== "dir" || !resource.resource_id) {
		throw new StorageScopeError(
			"Remote folder identity is unavailable; synchronization is stopped",
		);
	}
	return { remotePath: path, rootResourceId: resource.resource_id };
}

/** Compare physical identity as well as path; token rotation alone changes neither. */
export function sameRemoteStorageScope(
	a: RemoteStorageScope,
	b: RemoteStorageScope | null,
): boolean {
	return (
		b !== null &&
		a.remotePath === b.remotePath &&
		a.rootResourceId === b.rootResourceId
	);
}

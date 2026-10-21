import type { FileMetadata } from "../../src/types";

/** Supply ordinary file fields; scenarios declare causal and remote evidence. */
export function fileMetadata(
	path: string,
	overrides: Partial<FileMetadata> = {},
): FileMetadata {
	return {
		path,
		sha256: "hash",
		size: 1,
		mtime: 1,
		syncedAt: 1,
		...overrides,
	};
}

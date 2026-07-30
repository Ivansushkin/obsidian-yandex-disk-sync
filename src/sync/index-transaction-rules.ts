import type { SyncIndex } from "../types";

export interface Page<T> {
	items: T[];
	total: number;
}

/**
 * Serialize JSON-compatible state with stable object-key ordering.
 */
export function stableSerialize(value: unknown): string {
	const serialized = JSON.stringify(value, (_key, item: unknown) => {
		if (
			item !== null &&
			typeof item === "object" &&
			!Array.isArray(item)
		) {
			return Object.fromEntries(
				Object.entries(item as Record<string, unknown>).sort(
					([left], [right]) => left.localeCompare(right),
				),
			);
		}
		return item;
	});
	return serialized ?? "undefined";
}

/**
 * Read every page from a stable offset-based listing.
 */
export async function collectPaginatedItems<T>(
	loadPage: (limit: number, offset: number) => Promise<Page<T>>,
	limit = 1000,
): Promise<T[]> {
	const result: T[] = [];
	let offset = 0;
	while (true) {
		const page = await loadPage(limit, offset);
		result.push(...page.items);
		offset += page.items.length;
		if (offset >= page.total || page.items.length === 0) return result;
	}
}

/**
 * Require two consecutive identical root snapshots and deduplicate objects
 * that moved between offset pages while the listing was read.
 */
export async function collectStablePaginatedItems<T>(
	loadPage: (limit: number, offset: number) => Promise<Page<T>>,
	getPath: (item: T) => string,
	getVersion: (item: T) => string,
	maxSnapshots = 4,
): Promise<T[]> {
	let previousSignature: string | null = null;
	for (let attempt = 0; attempt < maxSnapshots; attempt++) {
		const pageItems = await collectPaginatedItems(loadPage);
		const unique = new Map<string, T>();
		for (const item of pageItems) {
			unique.set(getPath(item), item);
		}
		const items = [...unique.values()].sort((left, right) =>
			getPath(left).localeCompare(getPath(right)),
		);
		const signature = stableSerialize(
			items.map((item) => [getPath(item), getVersion(item)]),
		);
		if (signature === previousSignature) return items;
		previousSignature = signature;
	}
	throw new UnstablePaginationError(
		"Remote root changed while its pages were being read",
	);
}

/**
 * Check whether an orphan can be discarded without choosing between two
 * equally recent but different causal states.
 */
export function isOrphanIndexAmbiguous(
	canonical: SyncIndex,
	orphan: SyncIndex,
): boolean {
	return (
		orphan.revision > canonical.revision ||
		(orphan.revision === canonical.revision &&
			stableSerialize(orphan) !== stableSerialize(canonical))
	);
}

/**
 * Prevent an encryption transition from claiming maintenance against a
 * canonical revision newer than its completed source preflight.
 */
export function didCanonicalChangeBeforeMaintenanceClaim(
	observedRevision: number,
	currentRevision: number,
): boolean {
	return currentRevision !== observedRevision;
}

export class UnstablePaginationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnstablePaginationError";
	}
}

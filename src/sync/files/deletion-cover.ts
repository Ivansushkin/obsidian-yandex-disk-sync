import type { RecursiveDeleteAction } from "../../types";
import { getAncestorDirectories, normalizePath } from "../../utils/path-utils";

/** Choose maximal removable subtrees without covering a preserved descendant. */
export function planRecursiveDeletes(
	resources: readonly RecursiveDeleteAction[],
	removable: ReadonlySet<string>,
	preserved: ReadonlySet<string>,
	canCollapse: (path: string) => boolean = () => true,
): RecursiveDeleteAction[] {
	const entries = new Map(resources.map((entry) => [entry.path, entry]));
	for (const path of getAncestorDirectories(entries.keys())) {
		if (!entries.has(path)) {
			entries.set(path, { path, kind: "dir" });
		}
	}
	const inside = (path: string, root: string) =>
		path === root || path.startsWith(`${root}/`);
	const result: RecursiveDeleteAction[] = [];
	for (const entry of [...entries.values()].sort(
		(a, b) =>
			a.path.split("/").length - b.path.split("/").length ||
			a.path.localeCompare(b.path),
	)) {
		const { path, kind } = entry;
		if (
			!path ||
			normalizePath(path) !== path ||
			result.some((root) => inside(path, root.path))
		) {
			continue;
		}
		if (
			[...preserved].some(
				(keep) => inside(keep, path) || inside(path, keep),
			)
		) {
			continue;
		}
		const leaves = [...entries.values()].filter(
			(child) => child.kind === "file" && inside(child.path, path),
		);
		if (
			kind === "file"
				? removable.has(path)
				: canCollapse(path) &&
					(removable.has(path) || leaves.length > 0) &&
					leaves.every((child) => removable.has(child.path))
		) {
			result.push(entry);
		}
	}
	return result;
}

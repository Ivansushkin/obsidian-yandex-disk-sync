/**
 * Find the first error in a causal chain that satisfies a predicate.
 */
export function findErrorCause<T extends Error>(
	error: unknown,
	predicate: (candidate: Error) => candidate is T,
): T | null;
export function findErrorCause(
	error: unknown,
	predicate: (candidate: Error) => boolean,
): Error | null;
export function findErrorCause(
	error: unknown,
	predicate: (candidate: Error) => boolean,
): Error | null {
	const visited = new Set<unknown>();
	let current = error;
	while (current instanceof Error && !visited.has(current)) {
		if (predicate(current)) return current;
		visited.add(current);
		current = "cause" in current ? current.cause : undefined;
	}
	return null;
}

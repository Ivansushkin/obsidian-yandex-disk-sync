/** Filesystem timestamps may contain fractional milliseconds; causal counters may not. */
export function isFileModificationTime(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
	);
}

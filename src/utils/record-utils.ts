/** Recognize JSON object records while excluding null and arrays. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Define an own enumerable data property without invoking Object.prototype's
 * legacy `__proto__` setter. Persisted path maps must use this helper whenever
 * the key can originate from a vault, remote object, or imported snapshot.
 */
export function setRecordValue<T>(
	record: Record<string, T>,
	key: string,
	value: T,
): void {
	Object.defineProperty(record, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

/**
 * Neutralize the inherited `__proto__` accessor while retaining a normal
 * JSON-compatible object prototype. The placeholder is non-enumerable and is
 * replaced by {@link setRecordValue} when `__proto__` is a real persisted key.
 */
export function protectRecord<T>(record: Record<string, T>): Record<string, T> {
	if (!Object.prototype.hasOwnProperty.call(record, "__proto__")) {
		Object.defineProperty(record, "__proto__", {
			value: undefined,
			writable: true,
			enumerable: false,
			configurable: true,
		});
	}
	return record;
}

/** Create an empty JSON record safe for untrusted path keys and reads. */
export function createSafeRecord<T>(): Record<string, T> {
	return protectRecord({});
}

/** Read only own persisted entries; inherited object properties are absent. */
export function getRecordValue<T>(
	record: Record<string, T>,
	key: string,
): T | undefined {
	const value = record[key];
	return Object.prototype.hasOwnProperty.call(record, key)
		? value
		: undefined;
}

/** Create a regular JSON-compatible record from untrusted string keys. */
export function recordFromEntries<T>(
	entries: Iterable<readonly [string, T]>,
): Record<string, T> {
	const record = createSafeRecord<T>();
	for (const [key, value] of entries) {
		setRecordValue(record, key, value);
	}
	return record;
}

/** Control an asynchronous boundary without timing-dependent sleeps. */
export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((fulfill) => {
		resolve = fulfill;
	});
	return { promise, resolve };
}

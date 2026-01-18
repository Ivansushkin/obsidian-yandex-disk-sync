/**
 * Semaphore for controlling concurrency
 */

/**
 * Semaphore implementation for limiting concurrent operations
 */
export class Semaphore {
	private permits: number;
	private waiting: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	/**
	 * Acquire a permit (waits if none available)
	 */
	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			this.waiting.push(resolve);
		});
	}

	/**
	 * Release a permit
	 */
	release(): void {
		this.permits++;
		if (this.waiting.length > 0) {
			this.permits--;
			const resolve = this.waiting.shift();
			if (resolve) {
				resolve();
			}
		}
	}

	/**
	 * Get current available permits
	 */
	availablePermits(): number {
		return this.permits;
	}
}

/**
 * Execute tasks with limited concurrency
 */
export async function runWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
	onProgress?: (completed: number, total: number) => void
): Promise<T[]> {
	if (tasks.length === 0) {
		return [];
	}

	if (concurrency <= 0) {
		throw new Error("Concurrency must be greater than 0");
	}

	const results: (T | undefined)[] = [];
	for (let i = 0; i < tasks.length; i++) {
		results.push(undefined);
	}
	const semaphore = new Semaphore(concurrency);
	let completed = 0;

	const wrappedTasks = tasks.map((task, index) => async () => {
		await semaphore.acquire();
		try {
			const result = await task();
			results[index] = result;
			completed++;
			if (onProgress) {
				onProgress(completed, tasks.length);
			}
			return result;
		} finally {
			semaphore.release();
		}
	});

	await Promise.all(wrappedTasks.map((task) => task()));
	return results as T[];
}

/**
 * Execute tasks with limited concurrency and collect results with errors
 */
export async function runWithConcurrencySettled<T>(
	tasks: Array<() => Promise<T>>,
	concurrency: number,
	onProgress?: (completed: number, total: number) => void
): Promise<Array<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }>> {
	if (tasks.length === 0) {
		return [];
	}

	if (concurrency <= 0) {
		throw new Error("Concurrency must be greater than 0");
	}

	type Result =
		| { status: "fulfilled"; value: T }
		| { status: "rejected"; reason: unknown };
	const results: (Result | undefined)[] = [];
	for (let i = 0; i < tasks.length; i++) {
		results.push(undefined);
	}
	const semaphore = new Semaphore(concurrency);
	let completed = 0;

	const wrappedTasks = tasks.map((task, index) => async () => {
		await semaphore.acquire();
		try {
			const value = await task();
			results[index] = { status: "fulfilled", value };
		} catch (reason) {
			results[index] = { status: "rejected", reason };
		} finally {
			completed++;
			if (onProgress) {
				onProgress(completed, tasks.length);
			}
			semaphore.release();
		}
	});

	await Promise.all(wrappedTasks.map((task) => task()));
	return results as Result[];
}

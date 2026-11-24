const windowBytes = 8 * 1024 * 1024;

interface SizedTransfer {
	size?: number;
}

function knownSize(item: SizedTransfer): number {
	const { size } = item;
	return typeof size === "number" && Number.isFinite(size) && size >= 0
		? size
		: Infinity;
}

/** Small transfers can share a rolling pool without exceeding the estimated budget. */
export function isSmallTransfer(
	item: SizedTransfer,
	concurrency: number,
): boolean {
	return knownSize(item) <= windowBytes / concurrency;
}

/** Pack independent reads by size while keeping equal-sized inputs in order. */
export function* planTransferWindows<T extends SizedTransfer>(
	items: readonly T[],
	concurrency: number,
): Generator<T[]> {
	const small: T[] = [];
	const single: T[] = [];
	const bySize = new Map<number, { items: T[]; next: number }>();
	for (const item of items) {
		const size = knownSize(item);
		if (isSmallTransfer(item, concurrency)) {
			small.push(item);
		} else if (size > windowBytes) {
			single.push(item);
		} else {
			const group = bySize.get(size) ?? { items: [], next: 0 };
			group.items.push(item);
			bySize.set(size, group);
		}
	}
	for (let i = 0; i < small.length; i += concurrency) {
		yield small.slice(i, i + concurrency);
	}

	const sizes = [...bySize.keys()].sort((a, b) => a - b);
	const mixedLimit = Math.min(concurrency, 4);
	let low = 0;
	let high = sizes.length - 1;
	const take = (size: number): T => {
		const group = bySize.get(size)!;
		const item = group.items[group.next++]!;
		if (group.next === group.items.length) {
			if (sizes[low] === size) {
				low++;
			}
			if (sizes[high] === size) {
				high--;
			}
		}
		return item;
	};
	while (low <= high) {
		const largest = sizes[high]!;
		const window = [take(largest)];
		let remaining = windowBytes - largest;
		while (
			low <= high &&
			window.length < mixedLimit &&
			sizes[low]! <= remaining
		) {
			const smallest = sizes[low]!;
			window.push(take(smallest));
			remaining -= smallest;
		}
		yield window;
	}
	for (const item of single) {
		yield [item];
	}
}

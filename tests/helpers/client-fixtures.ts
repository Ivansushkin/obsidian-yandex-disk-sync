import test from "node:test";
import type { YandexResource } from "../../src/types";
import type { RequestUrlParam } from "obsidian";
import { YandexDiskClient } from "../../src/api/yandex-client";

export function response(status: number, json: unknown = {}) {
	return { status, json, arrayBuffer: new ArrayBuffer(0), text: "" };
}
export const requestGlobal = globalThis as typeof globalThis & {
	__obsidianRequestUrl?: (
		params: RequestUrlParam,
	) => Promise<ReturnType<typeof response>>;
};
export function createClient(
	options: Partial<ConstructorParameters<typeof YandexDiskClient>[0]> = {},
) {
	return new YandexDiskClient({
		token: "synthetic",
		maxRetries: 0,
		retryDelay: 0,
		...options,
	});
}

/** Scope synthetic HTTP interception to a single test, including failed assertions. */
export function httpTest(name: string, run: () => Promise<void>) {
	return test(name, async () => {
		const previous = requestGlobal.__obsidianRequestUrl;
		try {
			await run();
		} finally {
			requestGlobal.__obsidianRequestUrl = previous;
		}
	});
}

export function fileResource(
	path: string,
	identity: Partial<YandexResource> = {},
): YandexResource {
	return {
		name: path.split("/").pop() ?? path,
		path,
		type: "file",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		size: 4,
		...identity,
	};
}

import {
	OperationFailure,
	NetworkRequestError,
	YandexApiError,
} from "../src/errors";
import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { DEFAULT_LOG_RELATIVE_PATH, Logger } from "../src/utils/logger";
import { deferred } from "./helpers/deferred";

function createLogger(maxFileSize?: number) {
	const files = new Map<string, string>();
	const adapter = {
		async exists(path: string): Promise<boolean> {
			return files.has(path);
		},
		async stat(path: string): Promise<{ size: number } | null> {
			const content = files.get(path);
			return content === undefined
				? null
				: { size: new TextEncoder().encode(content).byteLength };
		},
		async read(path: string): Promise<string> {
			return files.get(path) ?? "";
		},
		async write(path: string, content: string): Promise<void> {
			files.set(path, content);
		},
		async append(path: string, content: string): Promise<void> {
			files.set(path, (files.get(path) ?? "") + content);
		},
	};
	const app = {
		vault: {
			configDir: ".custom-config",
			adapter,
			async createFolder(path: string): Promise<void> {
				files.set(path, "");
			},
		},
	} as unknown as App;
	const instance = new Logger();
	instance.configure({
		app,
		minLevel: "debug",
		consoleEnabled: false,
		fileEnabled: true,
		maxFileSize,
		baseContext: { deviceId: "device-test" },
		contextProvider: () => ({ sessionId: "full-test-1" }),
	});
	return {
		instance,
		adapter,
		contents: () =>
			files.get(`.custom-config/${DEFAULT_LOG_RELATIVE_PATH}`) ?? "",
	};
}

test("logger writes correlated sanitized diagnostics to plugin data", async () => {
	const { instance, contents } = createLogger();

	instance.info("Diagnostic entry", {
		token: "abcdefghijklmnopqrstuvwxyz0123456789",
		password: "do-not-log-this-password",
		key: "do-not-log-this-encryption-key",
		indexTransactionId: "transaction-test-1",
		code: "DiskPathPointsToExistentDirectoryError",
		error: new Error(
			"request failed: Authorization: Bearer embedded-secret-token-123456",
		),
	});
	const provider = new YandexApiError(
		"private-response-body",
		503,
		"ServiceUnavailable",
	);
	instance.error("Operation failed", {
		error: new OperationFailure(provider, {
			stage: "download",
			action: "read",
			durationMs: 50,
		}),
	});
	instance.warn("Network failed", {
		error: new OperationFailure(
			new NetworkRequestError(
				new Error(
					"socket https://signed.example/object?key=private-link password=private-password",
				),
			),
			{ stage: "download", action: "read" },
		),
	});
	instance.error("Quoted credentials", {
		error: new Error(
			`password="first second third" token='quoted secret with spaces'`,
		),
	});
	await instance.flush();

	const output = contents();
	for (const expected of [
		"Diagnostic entry",
		"ServiceUnavailable",
		"download",
		"device-test",
		"full-test-1",
		"transaction-test-1",
		"DiskPathPointsToExistentDirectoryError",
	]) {
		assert.ok(output.includes(expected), expected);
	}
	for (const secret of [
		"private-response-body",
		"signed.example",
		"private-link",
		"private-password",
		"first second third",
		"second third",
		"quoted secret",
		"with spaces",
		"abcdefghijklmnopqrstuvwxyz0123456789",
		"do-not-log-this-password",
		"do-not-log-this-encryption-key",
		"embedded-secret-token-123456",
	]) {
		assert.equal(output.includes(secret), false);
	}
});

test("clearing during an admitted flush discards old entries and preserves later entries", async () => {
	const { instance, adapter, contents } = createLogger();
	const entered = deferred();
	const release = deferred();
	const write = adapter.write.bind(adapter);
	adapter.write = async (path, content) => {
		if (content.includes("before-clear")) {
			entered.resolve();
			await release.promise;
		}
		await write(path, content);
	};
	instance.info("before-clear");
	const flushing = instance.flush();
	await entered.promise;
	const clearing = instance.clearLogs();
	instance.info("after-clear");
	release.resolve();
	await Promise.all([flushing, clearing]);
	await instance.flush();
	assert.doesNotMatch(contents(), /before-clear/);
	assert.match(contents(), /after-clear/);
});

test("clear failure is reported and does not prevent later log writes", async () => {
	const { instance, adapter, contents } = createLogger();
	instance.info("retained");
	await instance.flush();
	const write = adapter.write.bind(adapter);
	adapter.write = async () => {
		throw new Error("synthetic clear failure");
	};
	await assert.rejects(instance.clearLogs(), /synthetic clear failure/);
	adapter.write = write;
	instance.info("later-entry");
	await instance.flush();
	assert.match(contents(), /retained/);
	assert.match(contents(), /later-entry/);
});

test("logger serializes concurrent flushes without losing entries", async () => {
	const { instance, contents } = createLogger();

	for (let index = 0; index < 20; index++) {
		instance.debug(`entry-${index}`);
	}
	await Promise.all([instance.flush(), instance.flush(), instance.flush()]);

	const output = contents();
	for (let index = 0; index < 20; index++) {
		assert.equal(
			output.match(new RegExp(`entry-${index}(?!\\d)`, "g"))?.length,
			1,
		);
	}
});

test("failed log batches retain FIFO before queued writes and rotation", async () => {
	const { instance, adapter, contents } = createLogger(100);
	instance.configure({ baseContext: {}, contextProvider: () => undefined });
	const entered = deferred();
	const release = deferred();
	const write = adapter.write.bind(adapter);
	let first = true;
	adapter.write = async (path, content) => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
			throw new Error("synthetic write failure");
		}
		await write(path, content);
	};
	instance.info("old-entry");
	const older = instance.flush();
	await entered.promise;
	instance.info("new-entry");
	const newer = instance.flush();
	release.resolve();
	await Promise.all([older, newer]);
	await instance.flush();
	assert.match(contents(), /new-entry/);
	assert.doesNotMatch(contents(), /old-entry/);
});

test("logger rotates by UTF-8 byte size and keeps newest entries", async () => {
	const { instance, contents } = createLogger(700);

	for (let index = 0; index < 30; index++) {
		instance.debug(`rotating-entry-${index} ${"данные".repeat(8)}`);
	}
	await instance.flush();

	const output = contents();
	assert.ok(new TextEncoder().encode(output).byteLength <= 700);
	assert.match(output, /rotating-entry-29/);
	assert.doesNotMatch(output, /rotating-entry-0(?!\d)/);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import {
	DEFAULT_LOG_RELATIVE_PATH,
	Logger,
} from "../src/utils/logger";

interface MemoryLogAdapter {
	files: Map<string, string>;
	app: App;
}

function createMemoryLogAdapter(): MemoryLogAdapter {
	const files = new Map<string, string>();
	const directories = new Set<string>();
	const adapter = {
		async exists(path: string): Promise<boolean> {
			return files.has(path) || directories.has(path);
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
				directories.add(path);
			},
		},
	} as unknown as App;
	return { files, app };
}

test("logger writes correlated sanitized diagnostics to plugin data", async () => {
	const memory = createMemoryLogAdapter();
	const instance = new Logger();
	instance.configure({
		app: memory.app,
		minLevel: "debug",
		consoleEnabled: false,
		fileEnabled: true,
		baseContext: { deviceId: "device-test" },
		contextProvider: () => ({ sessionId: "full-test-1" }),
	});

	instance.info("Diagnostic entry", {
		token: "abcdefghijklmnopqrstuvwxyz0123456789",
		password: "do-not-log-this-password",
		key: "do-not-log-this-encryption-key",
		indexTransactionId: "transaction-test-1",
		error: new Error(
			"request failed: Authorization: Bearer embedded-secret-token-123456",
		),
	});
	await instance.flush();

	const path = `.custom-config/${DEFAULT_LOG_RELATIVE_PATH}`;
	const contents = memory.files.get(path) ?? "";
	assert.match(contents, /Diagnostic entry/);
	assert.match(contents, /device-test/);
	assert.match(contents, /full-test-1/);
	assert.match(contents, /transaction-test-1/);
	assert.doesNotMatch(contents, /abcdefghijklmnopqrstuvwxyz0123456789/);
	assert.doesNotMatch(contents, /do-not-log-this-password/);
	assert.doesNotMatch(contents, /do-not-log-this-encryption-key/);
	assert.doesNotMatch(contents, /embedded-secret-token-123456/);
});

test("logger serializes concurrent flushes without losing entries", async () => {
	const memory = createMemoryLogAdapter();
	const instance = new Logger();
	instance.configure({
		app: memory.app,
		minLevel: "debug",
		consoleEnabled: false,
		fileEnabled: true,
	});

	for (let index = 0; index < 20; index++) {
		instance.debug(`entry-${index}`);
	}
	await Promise.all([instance.flush(), instance.flush(), instance.flush()]);

	const path = `.custom-config/${DEFAULT_LOG_RELATIVE_PATH}`;
	const contents = memory.files.get(path) ?? "";
	for (let index = 0; index < 20; index++) {
		assert.equal(contents.match(new RegExp(`entry-${index}(?!\\d)`, "g"))?.length, 1);
	}
});

test("logger rotates by UTF-8 byte size and keeps newest entries", async () => {
	const memory = createMemoryLogAdapter();
	const instance = new Logger();
	instance.configure({
		app: memory.app,
		minLevel: "debug",
		consoleEnabled: false,
		fileEnabled: true,
		maxFileSize: 700,
	});

	for (let index = 0; index < 30; index++) {
		instance.debug(`rotating-entry-${index} ${"данные".repeat(8)}`);
	}
	await instance.flush();

	const path = `.custom-config/${DEFAULT_LOG_RELATIVE_PATH}`;
	const contents = memory.files.get(path) ?? "";
	assert.ok(new TextEncoder().encode(contents).byteLength <= 700);
	assert.match(contents, /rotating-entry-29/);
	assert.doesNotMatch(contents, /rotating-entry-0(?!\d)/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
	path.resolve("scripts/local-build-env.mjs"),
).href;

function readLocalPluginPath(root: string): string | null {
	const source = `
		import { readLocalPluginPath } from ${JSON.stringify(moduleUrl)};
		try {
			console.log(JSON.stringify(readLocalPluginPath(${JSON.stringify(root)})));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	`;
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", source],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim());
	}
	return JSON.parse(result.stdout.trim()) as string | null;
}

function withTemporaryRoot(run: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "yandex-sync-env-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("local build path is read only from the repository .env", () => {
	withTemporaryRoot((root) => {
		const destination = path.join(root, "test-vault", "plugin");
		writeFileSync(
			path.join(root, ".env"),
			`YANDEX_PLUGIN_PATH=${destination}\n`,
		);
		const previous = process.env.YANDEX_PLUGIN_PATH;
		process.env.YANDEX_PLUGIN_PATH = path.join(root, "shell-value");
		try {
			assert.equal(readLocalPluginPath(root), destination);
		} finally {
			if (previous === undefined) delete process.env.YANDEX_PLUGIN_PATH;
			else process.env.YANDEX_PLUGIN_PATH = previous;
		}
	});
});

test("missing or empty local .env disables test-vault deployment", () => {
	withTemporaryRoot((root) => {
		assert.equal(readLocalPluginPath(root), null);
		writeFileSync(path.join(root, ".env"), "YANDEX_PLUGIN_PATH=\n");
		assert.equal(readLocalPluginPath(root), null);
	});
});

test("local build path rejects relative paths and regular files", () => {
	withTemporaryRoot((root) => {
		writeFileSync(path.join(root, ".env"), "YANDEX_PLUGIN_PATH=relative\n");
		assert.throws(
			() => readLocalPluginPath(root),
			/YANDEX_PLUGIN_PATH in \.env must be an absolute path/,
		);

		const filePath = path.join(root, "not-a-directory");
		writeFileSync(filePath, "file");
		writeFileSync(
			path.join(root, ".env"),
			`YANDEX_PLUGIN_PATH=${filePath}\n`,
		);
		assert.throws(
			() => readLocalPluginPath(root),
			/YANDEX_PLUGIN_PATH in \.env must point to a directory/,
		);
	});
});

test("malformed local .env fails with a configuration error", () => {
	withTemporaryRoot((root) => {
		writeFileSync(path.join(root, ".env"), "not an assignment\n");
		assert.throws(
			() => readLocalPluginPath(root),
			/Cannot parse .*\.env/,
		);
		writeFileSync(
			path.join(root, ".env"),
			"YANDEX_PLUGIN_PATH=/one\nYANDEX_PLUGIN_PATH=/two\n",
		);
		assert.throws(
			() => readLocalPluginPath(root),
			/Cannot parse .*\.env/,
		);
	});
});

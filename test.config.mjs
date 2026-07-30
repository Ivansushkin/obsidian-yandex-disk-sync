import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outputDir = await mkdtemp(join(tmpdir(), "yandex-sync-tests-"));
const outputFiles = [
	join(outputDir, "index-rules.test.mjs"),
	join(outputDir, "conflict-resolver.test.mjs"),
	join(outputDir, "sync-coordinator.test.mjs"),
	join(outputDir, "local-operation-store.test.mjs"),
	join(outputDir, "index-transaction-rules.test.mjs"),
	join(outputDir, "index-transaction.test.mjs"),
	join(outputDir, "index-manager-transaction.test.mjs"),
	join(outputDir, "encryption-transition.test.mjs"),
	join(outputDir, "baseline-rules.test.mjs"),
	join(outputDir, "path-utils.test.mjs"),
	join(outputDir, "physical-action-rules.test.mjs"),
	join(outputDir, "logger.test.mjs"),
	join(outputDir, "vault-adapter.test.mjs"),
	join(outputDir, "folder-delete.test.mjs"),
	join(outputDir, "realtime-rules.test.mjs"),
	join(outputDir, "file-watcher.test.mjs"),
	join(outputDir, "file-rename.test.mjs"),
	join(outputDir, "full-sync-barrier.test.mjs"),
];
const obsidianStubPlugin = {
	name: "obsidian-test-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: "obsidian-test-stub",
			namespace: "test",
		}));
		build.onLoad(
			{ filter: /.*/, namespace: "test" },
			() => ({
				contents: `
					export async function requestUrl() {
						throw new Error("Unexpected Obsidian requestUrl call in unit test");
					}
					export function normalizePath(path) {
						return path
							.split("\\\\")
							.join("/")
							.split("/")
							.filter(Boolean)
							.join("/");
					}
					export class TFile {}
					export class TFolder {}
				`,
				loader: "js",
			}),
		);
	},
};

try {
	await build({
		entryPoints: [
			"tests/index-rules.test.ts",
			"tests/conflict-resolver.test.ts",
			"tests/sync-coordinator.test.ts",
			"tests/local-operation-store.test.ts",
			"tests/index-transaction-rules.test.ts",
			"tests/index-transaction.test.ts",
			"tests/index-manager-transaction.test.ts",
			"tests/encryption-transition.test.ts",
			"tests/baseline-rules.test.ts",
			"tests/path-utils.test.ts",
			"tests/physical-action-rules.test.ts",
			"tests/logger.test.ts",
			"tests/vault-adapter.test.ts",
			"tests/folder-delete.test.ts",
			"tests/realtime-rules.test.ts",
			"tests/file-watcher.test.ts",
			"tests/file-rename.test.ts",
			"tests/full-sync-barrier.test.ts",
		],
		bundle: true,
		platform: "node",
		format: "esm",
		outdir: outputDir,
		outExtension: { ".js": ".mjs" },
		logLevel: "silent",
		plugins: [obsidianStubPlugin],
	});

	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--test", ...outputFiles], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});
	if (exitCode !== 0) process.exitCode = exitCode;
} finally {
	await rm(outputDir, { recursive: true, force: true });
}

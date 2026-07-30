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
	join(outputDir, "encryption-transition.test.mjs"),
	join(outputDir, "baseline-rules.test.mjs"),
	join(outputDir, "path-utils.test.mjs"),
	join(outputDir, "physical-action-rules.test.mjs"),
	join(outputDir, "logger.test.mjs"),
];

try {
	await build({
		entryPoints: [
			"tests/index-rules.test.ts",
			"tests/conflict-resolver.test.ts",
			"tests/sync-coordinator.test.ts",
			"tests/local-operation-store.test.ts",
			"tests/index-transaction-rules.test.ts",
			"tests/encryption-transition.test.ts",
			"tests/baseline-rules.test.ts",
			"tests/path-utils.test.ts",
			"tests/physical-action-rules.test.ts",
			"tests/logger.test.ts",
		],
		bundle: true,
		platform: "node",
		format: "esm",
		outdir: outputDir,
		outExtension: { ".js": ".mjs" },
		logLevel: "silent",
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

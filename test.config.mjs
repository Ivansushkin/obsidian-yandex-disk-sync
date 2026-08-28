import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outputDir = await mkdtemp(join(tmpdir(), "yandex-sync-tests-"));
const testFiles = readdirSync("tests")
	.filter((name) => name.endsWith(".test.ts"))
	.sort();
const outputFiles = testFiles.map((name) =>
	join(outputDir, name.replace(/\.ts$/, ".mjs")),
);
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
					export async function requestUrl(params) {
						if (globalThis.__obsidianRequestUrl) {
							return await globalThis.__obsidianRequestUrl(params);
						}
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
					export function setIcon() {}
				`,
				loader: "js",
			}),
		);
	},
};

try {
	await build({
		entryPoints: testFiles.map((name) => `tests/${name}`),
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

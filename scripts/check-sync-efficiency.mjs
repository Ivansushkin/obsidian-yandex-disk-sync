import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { obsidianStubPlugin } from "../tests/helpers/obsidian-stub.mjs";

const outputDir = await mkdtemp(join(tmpdir(), "sync-efficiency-run-"));
try {
	const outfile = join(outputDir, "probe.mjs");
	await build({
		entryPoints: ["tests/helpers/sync-efficiency.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile,
		logLevel: "silent",
		plugins: [obsidianStubPlugin],
	});
	const probe = await import(pathToFileURL(outfile).href);
	try {
		await probe.run();
	} catch (error) {
		// Assertion objects can contain payloads; print only safe diagnostic coordinates.
		console.error(
			JSON.stringify({
				success: false,
				scenario: probe.currentScenario(),
				failure: error instanceof Error ? error.name : "unknown",
			}),
		);
		process.exitCode = 1;
	}
} finally {
	await rm(outputDir, { recursive: true, force: true });
}

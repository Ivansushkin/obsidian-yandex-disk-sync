import { obsidianStubPlugin } from "./tests/helpers/obsidian-stub.mjs";
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const outputDir = await mkdtemp(join(tmpdir(), "yandex-sync-tests-"));
const testRoot = process.argv.includes("--force-fencing")
	? "tests/release-gates"
	: "tests";
const testFiles = readdirSync(testRoot)
	.filter((name) => name.endsWith(".test.ts"))
	.sort();
const outputFiles = testFiles.map((name) =>
	join(outputDir, name.replace(/\.ts$/, ".mjs")),
);
let cleanupSafe = true;

try {
	await build({
		entryPoints: testFiles.map((name) => `${testRoot}/${name}`),
		bundle: true,
		platform: "node",
		format: "esm",
		outdir: outputDir,
		outExtension: { ".js": ".mjs" },
		logLevel: "silent",
		define: {
			YANDEX_OAUTH_CLIENT_SECRET: JSON.stringify("synthetic-test-secret"),
		},
		plugins: [obsidianStubPlugin],
	});

	const exitCode = await new Promise((resolve, reject) => {
		const grouped = process.platform !== "win32";
		const child = spawn(
			process.execPath,
			["--test", "--test-timeout=60000", ...outputFiles],
			{ stdio: "inherit", detached: grouped },
		);
		let stopping = false;
		let forced = false;
		let closed = false;
		let code = 1;
		let forceDeadline;
		let pendingStops = 0;
		let treeStopped = false;
		/** Signal only the owned runner tree, including its test-file workers. */
		const terminate = async (signal) => {
			if (!grouped) {
				const killer = spawn(
					"taskkill",
					[
						"/PID",
						String(child.pid),
						"/T",
						...(signal === "SIGKILL" ? ["/F"] : []),
					],
					{ stdio: "ignore", windowsHide: true, timeout: 5_000 },
				);
				await new Promise((resolve, reject) => {
					killer.on("error", reject);
					killer.on("close", (code) => {
						if (code === 0) {
							resolve();
						} else {
							reject(
								new Error(
									"Could not stop the test process tree",
								),
							);
						}
					});
				});
				return;
			}
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if (error.code !== "ESRCH") {
					throw error;
				}
			}
		};
		const settle = () => {
			if (!closed || pendingStops > 0) {
				return;
			}
			if (stopping && !grouped && !treeStopped) {
				return;
			}
			if (stopping && !forced && grouped) {
				try {
					process.kill(-child.pid, 0);
					return;
				} catch (error) {
					if (error.code !== "ESRCH") {
						throw error;
					}
				}
			}
			clearTimeout(deadline);
			clearTimeout(forceDeadline);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", cancel);
			resolve(stopping ? 1 : code);
		};
		const send = (signal) => {
			pendingStops++;
			void terminate(signal)
				.then(
					() => {
						treeStopped = true;
					},
					() => {
						if (signal === "SIGKILL") {
							cleanupSafe = false;
							clearTimeout(deadline);
							clearTimeout(forceDeadline);
							process.off("SIGINT", interrupt);
							process.off("SIGTERM", cancel);
							reject(
								new Error(
									"Test tree shutdown failed; temporary files retained",
								),
							);
						}
					},
				)
				.finally(() => {
					pendingStops--;
					settle();
				});
		};
		const stop = (signal) => {
			if (stopping) {
				return;
			}
			stopping = true;
			send(signal);
			forceDeadline = setTimeout(() => {
				forced = true;
				send("SIGKILL");
				settle();
			}, 5_000);
		};
		const interrupt = () => stop("SIGINT");
		const cancel = () => stop("SIGTERM");
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", cancel);
		const deadline = setTimeout(() => {
			console.error(
				"Test process exceeded 180000 ms; stopping its process tree",
			);
			stop("SIGTERM");
		}, 180_000);
		child.on("error", (error) => {
			clearTimeout(deadline);
			clearTimeout(forceDeadline);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", cancel);
			reject(error);
		});
		child.on("close", (exitCode) => {
			closed = true;
			code = exitCode ?? 1;
			settle();
		});
	});
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
} finally {
	if (cleanupSafe) {
		await rm(outputDir, { recursive: true, force: true });
	}
}

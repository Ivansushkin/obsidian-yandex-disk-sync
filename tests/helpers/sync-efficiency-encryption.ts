import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { encryptionFlow } from "./encryption-flow";
import {
	assertTransitionIdentity,
	transition,
	observeDerivations,
	transitionSource,
} from "./encryption-scenarios";
import { MemoryDisk, bytes, device } from "./sync-flow";

type Phase =
	"preparation" | "rewrite" | "publication" | "cleanup" | "finalization";

/** Measure real transitions independently of synthetic transport latency. */
export async function runEncryptionTransitions(): Promise<void> {
	const flag = process.argv.indexOf("--out");
	const output = flag < 0 ? undefined : process.argv[flag + 1];
	assert.ok(
		output && !output.startsWith("--"),
		"--out needs a fresh JSON path",
	);
	const rows = [];
	for (const kind of ["enable", "disable", "rotate"] as const) {
		const disk = new MemoryDisk();
		const a = device(disk, "transition-probe", null);
		const flow = encryptionFlow(a);
		const expected = Object.fromEntries(
			Array.from({ length: 50 }, (_, index) => [
				`Folder${index % 5}/Note${index}.md`,
				`synthetic preserved bytes ${index}`,
			]),
		);
		const phases: Partial<Record<Phase, Record<string, number>>> = {};
		const derivations = observeDerivations();
		let phase: Phase | undefined;
		let before: Record<string, number> | undefined;
		let started = 0;
		let canonicalDownloads = 0;
		let userDeletes = 0;
		let inFlight = 0;
		let peakRequests = 0;
		let verifyingTargets = false;
		let targetMetadataGets = 0;
		let targetParentListings = 0;
		let activeTargetMetadata = 0;
		let peakTargetMetadata = 0;
		const advancePhase = (next?: Phase) => {
			const after = a.client.getTransportMetrics();
			if (phase && before) {
				phases[phase] = {
					...Object.fromEntries(
						Object.entries(after).map(([key, value]) => [
							key,
							value - before![key]!,
						]),
					),
					canonicalDownloads,
					userDeletes,
					peakRequests,
					targetMetadataGets,
					targetParentListings,
					peakTargetMetadata,
					durationMs: Math.round(performance.now() - started),
				};
			}
			phase = next;
			before = after;
			started = performance.now();
			canonicalDownloads = 0;
			userDeletes = 0;
			peakRequests = 0;
			targetMetadataGets = 0;
			targetParentListings = 0;
			peakTargetMetadata = 0;
		};
		try {
			const source = await transitionSource(a, flow, kind, expected);
			derivations.count = 0;
			a.settings.maxConcurrency = 20;
			const collect = a.client.collectLogicalMetadata.bind(a.client);
			a.client.collectLogicalMetadata = async (...args) => {
				verifyingTargets = phase === "cleanup";
				try {
					await collect(...args);
				} finally {
					verifyingTargets = false;
				}
			};
			disk.beforeRequest = async (method, endpoint, path) => {
				if (
					verifyingTargets &&
					method === "GET" &&
					endpoint.endsWith("/resources")
				) {
					targetMetadataGets += Number(disk.files.has(path));
					targetParentListings += Number(disk.folders.has(path));
					activeTargetMetadata++;
					peakTargetMetadata = Math.max(
						peakTargetMetadata,
						activeTargetMetadata,
					);
				}
				if (method === "DELETE" && !path.includes(".obsidian-")) {
					userDeletes++;
				}
				inFlight++;
				peakRequests = Math.max(peakRequests, inFlight);
				if (
					method === "GET" &&
					endpoint === "/download" &&
					path === "vault/.obsidian-sync-index.json"
				) {
					canonicalDownloads++;
				}
			};
			disk.afterRequest = async (method, endpoint) => {
				if (
					verifyingTargets &&
					method === "GET" &&
					endpoint.endsWith("/resources")
				) {
					activeTargetMetadata--;
				}
				inFlight--;
			};

			const rewrite = a.engine.reencodeRemoteFiles.bind(a.engine);
			a.engine.reencodeRemoteFiles = async (options) => {
				advancePhase("rewrite");
				const result = await rewrite(options);
				advancePhase("publication");
				return result;
			};
			const cleanup = flow.workflow.maintenance.deleteRemoteRawPaths.bind(
				flow.workflow.maintenance,
			);
			flow.workflow.maintenance.deleteRemoteRawPaths = async (
				paths,
				fingerprints,
			) => {
				advancePhase("cleanup");
				await cleanup(paths, fingerprints);
				advancePhase("finalization");
			};
			advancePhase("preparation");
			const result = await transition(a, flow, kind);
			if (kind === "disable") {
				assert.deepEqual(result, { hadErrors: false });
			}
			advancePhase();
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			for (const [metric, limit] of Object.entries({
				requests: 120,
				canonicalDownloads: 4,
				peakRequests: 4,
			})) {
				assert.ok(
					phases.cleanup![metric]! <= limit,
					`cleanup ${metric} budget`,
				);
			}
			assert.equal(
				phases.cleanup!.targetMetadataGets,
				0,
				"healthy targets share fresh parent listings",
			);
			assert.equal(
				phases.cleanup!.targetParentListings,
				10,
				"five fresh parents on each verification pass",
			);
			assert.equal(
				phases.cleanup!.peakTargetMetadata,
				4,
				"metadata requests overlap independently of DELETE workers",
			);
			assert.equal(
				phases.cleanup!.userDeletes,
				5,
				"one recursive DELETE per old root",
			);
			assert.equal(
				derivations.count,
				kind === "disable" ? 0 : 1,
				"one target key derivation",
			);
			assert.equal(flow.context.getTransition(), null);
			await a.assertSettled(expected);
			assertTransitionIdentity(await a.canonical(), source);
			const oraclePath = "Folder0/Note0.md";
			a.vault.put(oraclePath, bytes("synthetic oracle corruption"));
			await assert.rejects(() => a.assertSettled(expected));
			a.vault.put(oraclePath, bytes(expected[oraclePath]!));
			await a.assertSettled(expected);
			const row = {
				kind,
				files: 50,
				maxConcurrency: 20,
				derivations: derivations.count,
				phases,
				outcomes: {
					bytesCanonicalBaselineQueues: true,
					causalIdentity: true,
					oracleRejectsCorruption: true,
				},
			};
			rows.push(row);
			process.stdout.write(JSON.stringify(row) + "\n");
		} finally {
			derivations.restore();
			disk.beforeRequest = undefined;
			disk.afterRequest = undefined;
			await a.stop();
		}
	}
	const report = {
		schema: "sync-encryption-transition-efficiency-v1",
		success: true,
		rows,
	};
	const content = JSON.stringify(report, null, 2) + "\n";
	await writeFile(output, content, { flag: "wx" });
}

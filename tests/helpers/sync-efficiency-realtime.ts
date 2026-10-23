import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
	FileRenameOutcome,
	UploadCausalReceipt,
} from "../../src/sync/realtime/rules";
import { bytes } from "./sync-flow";
import { setup, measure, counters, awaitRealtime } from "./sync-efficiency";

type Context = Awaited<ReturnType<typeof setup>>;

/** Observe public batch settlement and actual codec work without replacing algorithms. */
function observe(ctx: Context) {
	const engine = ctx.current.engine;
	const batch = engine.syncFileBatch.bind(engine);
	const receipts: UploadCausalReceipt[] = [];
	const windows: number[] = [];
	let afterAck: (() => void) | undefined;
	engine.syncFileBatch = (events, settle) =>
		batch(events, async (result, context) => {
			windows.push(result.completed.length + result.superseded.length);
			for (const receipt of result.uploadReceipts) {
				const event = events.find(({ id }) => id === receipt.eventId);
				assert.ok(event);
				assert.equal(receipt.mutationId, event.mutationId);
				assert.equal(receipt.mutationSeq, event.mutationSeq);
				assert.equal(receipt.sha256, event.snapshotSha256);
				if (receipt.status === "accepted-put") {
					assert.ok(receipt.canonicalRevision !== null);
					assert.ok(
						(ctx.current.index.getRemoteIndex().appliedMutationSeq
							.phone ?? 0) >= (receipt.mutationSeq ?? Infinity),
					);
				}
				receipts.push(structuredClone(receipt));
			}
			await settle?.(result, context);
			afterAck?.();
		});
	const codec = ctx.codec;
	const decrypt = codec?.decrypt.bind(codec);
	let decrypts = 0;
	if (codec && decrypt) {
		codec.decrypt = (content) => {
			decrypts++;
			return decrypt(content);
		};
	}
	return {
		receipts,
		windows,
		set afterAck(value: (() => void) | undefined) {
			afterAck = value;
		},
		get decrypts() {
			return decrypts;
		},
		restore() {
			engine.syncFileBatch = batch;
			if (codec && decrypt) {
				codec.decrypt = decrypt;
			}
		},
	};
}

/** Bound waits to real watcher/coordinator completion, including an intentionally failed drain. */
async function waitUntil(predicate: () => boolean) {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "Watcher boundary deadline");
		await delay(10);
	}
}

/** Keep supplemental histories separate from the immutable 38-row comparison. */
export async function runRealtimeBoundaries() {
	const rows: unknown[] = [];
	let unresolved = 0;
	for (const encrypted of [false, true]) {
		const ctx = await setup(encrypted);
		try {
			await ctx.host.tokenSetup();
			ctx.current.start();
			const edit = (path: string, text: string) => {
				ctx.expected[path] = text;
				ctx.vault.put(path, bytes(text));
			};
			const rename = (from: string, to: string) => {
				ctx.expected[to] = ctx.expected[from]!;
				delete ctx.expected[from];
				ctx.vault.rename(from, to);
			};
			const sample = async (
				name: string,
				action: (ports: ReturnType<typeof observe>) => Promise<void>,
			) => {
				const ports = observe(ctx);
				let cpu = { user: 0, system: 0 };
				let decrypts = 0;
				try {
					const row = await measure(
						ctx,
						`realtime-edit-${name}`,
						async () => {
							const start = process.cpuUsage();
							const decryptStart = ports.decrypts;
							await action(ports);
							cpu = process.cpuUsage(start);
							decrypts = ports.decrypts - decryptStart;
						},
					);
					rows.push({
						...row,
						cpuMicroseconds: cpu,
						decrypts,
						windows: ports.windows,
						receipts: ports.receipts.map(
							({ status, reason, mutationSeq }) => ({
								status,
								reason,
								mutationSeq,
							}),
						),
					});
					return row;
				} finally {
					ports.restore();
				}
			};
			const repeated = await sample("same-path-debounce", async () => {
				for (let i = 0; i < 8; i++) {
					edit("note-0.md", `repeated ${i}`);
				}
				await awaitRealtime(ctx, ["note-0.md"]);
			});
			assert.equal(repeated.localReads, 1);
			assert.equal(repeated.bodies["PUT.user"], 1);
			const late = await sample("late-successor", async (ports) => {
				const physical =
					await ctx.current.client.getPhysicalPath("vault/note-0.md");
				ctx.disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === physical
					) {
						ctx.disk.beforeRequest = undefined;
						edit("note-0.md", "late successor");
					}
				};
				edit("note-0.md", "first snapshot");
				await awaitRealtime(ctx, ["note-0.md"]);
				assert.equal(ports.receipts.length, 2);
				assert.ok(
					ports.receipts.every(
						({ reason }) => reason === "accepted-put",
					),
				);
				assert.ok(
					ports.receipts[0]!.mutationSeq! <
						ports.receipts[1]!.mutationSeq!,
				);
			});
			assert.equal(late.localReads, 2);
			assert.equal(late.bodies["PUT.user"], 2);
			await sample("rename-handoff", async (ports) => {
				const physical =
					await ctx.current.client.getPhysicalPath("vault/Flight.md");
				ctx.disk.beforeRequest = async (method, endpoint, path) => {
					if (
						method === "PUT" &&
						endpoint === "/upload" &&
						path === physical
					) {
						ctx.disk.beforeRequest = undefined;
						rename("Flight.md", "Deep/Handoff.md");
					}
				};
				edit("Flight.md", "handoff snapshot");
				await awaitRealtime(ctx, ["Deep/Handoff.md"]);
				assert.equal(ports.receipts[0]?.status, "pending-put");
				assert.equal(ports.receipts[0]?.reason, "coalesced");
			});
			await sample("rename-after-ack", async (ports) => {
				ports.afterAck = () => {
					ports.afterAck = undefined;
					rename("note-2.md", "Deep/AfterAck.md");
					const successor = ctx.current.watcher
						.getDeferredEvents()
						.find(
							(event) =>
								event.action === "rename" &&
								event.targetPath === "Deep/AfterAck.md",
						);
					assert.ok(successor?.action === "rename");
					assert.equal(successor.predecessorUploadId, undefined);
				};
				edit("note-2.md", "acknowledged snapshot");
				await awaitRealtime(ctx, ["Deep/AfterAck.md"]);
				assert.equal(ports.receipts[0]?.reason, "accepted-put");
			});
			// Failure is measured separately: a pending remainder is never a successful outcome.
			const metrics = counters();
			const before = await ctx.canonical();
			const apiBefore = ctx.current.client.getApiReadMetrics();
			ctx.disk.metrics = metrics;
			ctx.vault.metrics = metrics;
			let failed = false;
			ctx.disk.beforeRequest = async (method, endpoint, path) => {
				if (
					method === "PUT" &&
					endpoint === "/upload" &&
					!path.includes(".lock.")
				) {
					failed = true;
					ctx.current.engine.pause();
					throw new Error("Synthetic offline before user PUT");
				}
			};
			edit("note-3.md", "offline first");
			edit("note-4.md", "offline suffix");
			await waitUntil(
				() => failed && !ctx.current.engine.hasPendingWork(),
			);
			await ctx.current.watcher.waitForPendingPersistence();
			ctx.disk.metrics = null;
			ctx.vault.metrics = null;
			const apiAfter = ctx.current.client.getApiReadMetrics();
			ctx.disk.beforeRequest = undefined;
			const saved = ctx.current.lastSaved();
			assert.equal(saved.pendingWatcherEvents.length, 2);
			assert.equal(saved.pendingMutations.length, 2);
			assert.deepEqual(await ctx.canonical(), before);
			assert.equal(metrics.bodies["PUT.user"] ?? 0, 0);
			assert.equal(
				metrics.requests["GET.uploadLink"],
				1,
				"No suffix write after failure",
			);
			rows.push({
				scenario: "offline-stopped",
				encrypted,
				...metrics,
				apiTotal: Object.entries(apiAfter).reduce(
					(sum, [key, count]) =>
						sum + count - apiBefore[key as keyof typeof apiBefore],
					0,
				),
				outcomes: {
					canonicalUnchanged: true,
					durableEvents: 2,
					durableMutations: 2,
					noSuffixWrite: true,
				},
			});
			await ctx.restart(saved);
			rows.push(
				await measure(ctx, "restart-offline-full", () =>
					ctx.host.full(),
				),
			);
			rows.push(
				await measure(
					ctx,
					"boundary-followup-full-noop",
					() => ctx.host.full(),
					true,
				),
			);
			await ctx.desktop.full();
			await ctx.desktop.assertSettled(ctx.expected);
		} finally {
			ctx.disk.beforeRequest = undefined;
			await ctx.stop();
		}
	}
	for (const encrypted of [false, true]) {
		const ctx = await setup(encrypted);
		try {
			await ctx.host.tokenSetup();
			ctx.current.start();
			const metrics = counters();
			const source = "note-1.md";
			const target = "Deep/Tracked.md";
			const physical = await ctx.current.client.getPhysicalPath(
				`vault/${source}`,
			);
			const before = await ctx.canonical();
			const apiBefore = ctx.current.client.getApiReadMetrics();
			const ports = observe(ctx);
			ctx.disk.metrics = metrics;
			ctx.vault.metrics = metrics;
			const renameFile = ctx.current.engine.renameFile.bind(
				ctx.current.engine,
			);
			let outcome: FileRenameOutcome | undefined;
			ctx.current.engine.renameFile = async (...args) => {
				outcome = await renameFile(...args);
				return outcome;
			};
			let renamed = false;
			ctx.disk.beforeRequest = async (method, endpoint, path) => {
				if (
					!renamed &&
					method === "PUT" &&
					endpoint === "/upload" &&
					path === physical
				) {
					renamed = true;
					ctx.disk.beforeRequest = undefined;
					ctx.vault.rename(source, target);
				}
			};
			ctx.vault.put(source, bytes("tracked modified handoff"));
			const upload = ctx.current.watcher
				.getDeferredEvents()
				.find(
					(event) =>
						event.action === "upload" && event.path === source,
				);
			assert.ok(upload);
			await waitUntil(
				() =>
					outcome !== undefined &&
					!ctx.current.engine.hasPendingWork(),
			);
			await ctx.current.watcher.waitForPendingPersistence();
			ctx.current.watcher.stop();
			ctx.disk.metrics = null;
			ctx.vault.metrics = null;
			const apiAfter = ctx.current.client.getApiReadMetrics();
			const after = await ctx.canonical();
			const saved = ctx.current.lastSaved();
			assert.deepEqual(
				ctx.vault.files.get(target),
				bytes("tracked modified handoff"),
			);
			assert.equal(ctx.vault.files.has(source), false);
			const converged = outcome?.status === "completed";
			if (converged) {
				assert.equal(ports.receipts[0]?.eventId, upload.id);
				assert.equal(ports.receipts[0]?.mutationId, "phone:1");
				assert.equal(ports.receipts[0]?.reason, "accepted-put");
				assert.equal(after.appliedMutationSeq.phone, 2);
				delete ctx.expected[source];
				ctx.expected[target] = "tracked modified handoff";
				await ctx.current.assertSettled(ctx.expected);
			} else {
				unresolved++;
				assert.equal(outcome?.reason, "index-commit-not-confirmed");
				assert.deepEqual(
					after,
					before,
					"FIFO failure must not publish the move",
				);
				assert.deepEqual(
					saved.pendingMutations.map(({ type, seq }) => ({
						type,
						seq,
					})),
					[
						{ type: "put", seq: 1 },
						{ type: "move", seq: 2 },
					],
				);
				assert.equal(saved.pendingWatcherEvents.length, 1);
				assert.equal(saved.pendingWatcherEvents[0]?.action, "rename");
			}
			ports.restore();
			await ctx.restart(saved);
			if (converged) {
				const stable = structuredClone([...ctx.disk.files]);
				const noop = await ctx.host.full();
				assert.deepEqual(
					[noop.uploaded, noop.downloaded, noop.deleted],
					[0, 0, 0],
				);
				assert.deepEqual([...ctx.disk.files], stable);
				await ctx.current.assertSettled(ctx.expected);
				await ctx.desktop.full();
				await ctx.desktop.assertSettled(ctx.expected);
			}
			rows.push({
				scenario: "tracked-modified-handoff",
				encrypted,
				...metrics,
				receipts: ports.receipts.map(
					({ status, reason, mutationSeq }) => ({
						status,
						reason,
						mutationSeq,
					}),
				),
				apiTotal: Object.entries(apiAfter).reduce(
					(sum, [key, count]) =>
						sum + count - apiBefore[key as keyof typeof apiBefore],
					0,
				),
				outcomes: {
					converged,
					canonicalUnchanged: !converged,
					localBytesPreserved: true,
					durableRename: !converged,
					exactQueuesSurviveJsonRestart: true,
				},
				blocker: converged
					? null
					: "fifo-gap: unstaged source put precedes staged move",
			});
		} finally {
			ctx.disk.beforeRequest = undefined;
			await ctx.stop();
		}
	}
	const flag = process.argv.indexOf("--out");
	assert.ok(
		flag >= 0 &&
			process.argv[flag + 1] &&
			!process.argv[flag + 1]!.startsWith("--"),
		"Supplemental run needs a fresh --out path",
	);
	await writeFile(
		process.argv[flag + 1]!,
		JSON.stringify(
			{
				schema: "sync-realtime-boundaries-v1",
				success: unresolved === 0,
				rows,
			},
			null,
			"\t",
		) + "\n",
		{ flag: "wx" },
	);
	assert.equal(
		unresolved,
		0,
		"Tracked modified upload/rename must converge without a FIFO gap",
	);
}

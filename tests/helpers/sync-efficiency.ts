import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { RequestUrlParam, TFile } from "obsidian";
import { EncryptionManager } from "../../src/crypto/encryption-manager";
import {
	EncryptionService,
	type EncryptionCodec,
} from "../../src/crypto/encryption";
import { EncryptionWorkflow } from "../../src/crypto/workflow";
import {
	PluginStartup,
	type StartupBlocks,
	type StartupInvocation,
} from "../../src/plugin-startup";
import { applyUserSettingsPatch } from "../../src/settings-workflow";
import type { SyncIndex, SyncResult } from "../../src/types";
import {
	MemoryDisk,
	MemoryVault,
	bytes,
	codecFor,
	device,
	type SavedDevice,
} from "./sync-flow";

type Device = ReturnType<typeof device>;
type Kind = "canonical" | "manifest" | "lock" | "user";
type Totals = Record<string, number>;
const increment = (totals: Totals, key: string, n = 1) => {
	totals[key] = (totals[key] ?? 0) + n;
};
const sha = (data: string | Buffer) =>
	createHash("sha256").update(data).digest("hex");
const salt = EncryptionService.bytesToBase64(new Uint8Array(16).fill(12));
const unexpected = () => {
	throw new Error("Unexpected diagnostic workflow branch");
};

function kindOf(path: string): Kind {
	if (path.endsWith("/.obsidian-sync-index.json")) {
		return "canonical";
	}
	if (path.endsWith("/.obsidian-encrypt.json")) {
		return "manifest";
	}
	if (path.includes(".obsidian-sync-index.lock.")) {
		return "lock";
	}
	return "user";
}

function counters() {
	return {
		requests: {} as Totals,
		bodies: {} as Totals,
		transferBytes: {} as Totals,
		localReads: 0,
		localBytes: 0,
		persistenceRequests: 0,
		peakReads: 0,
		peakUserMetadata: 0,
		peakDirectories: 0,
		localReadsByPhase: {} as Totals,
	};
}
type Metrics = ReturnType<typeof counters>;

/** Observe public synthetic transport ports; production readers and guards stay intact. */
class MeasuredDisk extends MemoryDisk {
	metrics: Metrics | null = null;
	private active = { reads: 0, user: 0, directories: 0 };
	override async request(params: RequestUrlParam, accepted = false) {
		const m = this.metrics;
		if (!m) {
			return await super.request(params, accepted);
		}
		const url = new URL(params.url);
		const method = params.method ?? "GET";
		const path = (url.searchParams.get("path") ?? "").replace(
			/^disk:\//,
			"",
		);
		const endpoint = url.pathname;
		const kind = kindOf(path);
		const api = endpoint.startsWith("/v1/disk/");
		const route = endpoint.endsWith("/resources/download")
			? "downloadLink"
			: endpoint.endsWith("/resources/upload")
				? "uploadLink"
				: endpoint.endsWith("/resources/move")
					? "move"
					: "metadata";
		increment(m.requests, api ? `${method}.${route}` : `${method}.body`);
		const read = method === "GET";
		const resource = read && endpoint.endsWith("/resources");
		const directory = resource && this.folders.has(path);
		const user = resource && this.files.has(path) && kind === "user";
		if (read) {
			m.peakReads = Math.max(m.peakReads, ++this.active.reads);
		}
		if (directory) {
			m.peakDirectories = Math.max(
				m.peakDirectories,
				++this.active.directories,
			);
		}
		if (user) {
			m.peakUserMetadata = Math.max(
				m.peakUserMetadata,
				++this.active.user,
			);
		}
		try {
			if (resource && (directory || user)) {
				await delay(2);
			}
			const response = await super.request(params, accepted);
			if (
				response.status < 300 &&
				(endpoint === "/download" || endpoint === "/upload")
			) {
				const size =
					endpoint === "/download"
						? response.arrayBuffer.byteLength
						: (params.body as ArrayBuffer).byteLength;
				increment(m.bodies, `${method}.${kind}`);
				increment(m.transferBytes, `${method}.${kind}`, size);
			}
			return response;
		} finally {
			if (read) {
				this.active.reads--;
			}
			if (directory) {
				this.active.directories--;
			}
			if (user) {
				this.active.user--;
			}
		}
	}
}

/** Count successful native reads, including DataAdapter paths used by protected copies. */
class MeasuredVault extends MemoryVault {
	metrics: Metrics | null = null;
	phase = () => "idle";
	constructor() {
		super();
		const read = this.adapter.readBinary;
		this.adapter.readBinary = async (path) => this.record(await read(path));
	}
	private record(content: ArrayBuffer) {
		if (this.metrics) {
			this.metrics.localReads++;
			this.metrics.localBytes += content.byteLength;
			increment(this.metrics.localReadsByPhase, this.phase());
		}
		return content;
	}
	override async readBinary(file: TFile) {
		return this.record(await super.readBinary(file));
	}
}

/** Use actual admission/settings algorithms through their host ports, without UI mocks. */
function admission(current: Device, codec: EncryptionCodec | null) {
	let service = codec;
	const blocks: StartupBlocks = {
		migration: null,
		encryption: null,
		historical: null,
		authentication: null,
	};
	current.settings.yandexTokenSecret = "synthetic";
	if (codec) {
		Object.assign(current.settings, {
			enableEncryption: true,
			encryptionSalt: salt,
			encryptionPassword: "synthetic-flow-password",
			encryptionProfileId: "hardened",
			encryptionRevision: 1,
		});
	}
	const workflow = new EncryptionWorkflow({
		client: current.client,
		index: current.index,
		engine: current.engine,
		manager: new EncryptionManager(),
		backup: { createTransitionBackup: unexpected },
		getSettings: () => current.settings,
		getService: () => service,
		setService: (value) => {
			service = value;
		},
		getTransition: () => null,
		setTransition: unexpected,
		isCancelled: () => false,
		assertConnectionAllowed: () => {},
		getLocalSnapshotDigest: unexpected,
		persist: async () => {
			await current.saved();
		},
		ui: {
			setBlock: (reason) => {
				blocks.encryption = reason;
				current.engine.setExternalBlock("encryption", reason);
			},
			setHistoricalBlock: unexpected,
			requestPassword: unexpected,
			connected: () => {},
			disabledRemotely: () => {},
			stateChanged: () => {},
		},
	});
	const startup = new PluginStartup({
		index: current.index,
		engine: current.engine,
		getSettings: () => current.settings,
		getBlocks: () => blocks,
		hasTransition: () => false,
		isStopped: () => false,
		setBlock: (kind, reason) => {
			blocks[kind] = reason;
			current.engine.setExternalBlock(kind, reason);
		},
		ensureStorageBinding: async () => {
			await current.index.assertRemoteScope();
			return true;
		},
		recoverEncryptionTransition: unexpected,
		tryRecoverRemoteTargetTransition: (reads) =>
			workflow.recovery.tryRecoverRemoteTargetTransition(reads),
		ensureEncryptionReady: (options, read) =>
			workflow.admission.ensureEncryptionReady(options, read),
	});
	current.engine.setSyncGuardCallback(
		async (token, observation, knownManifest) => {
			await current.index.assertRemoteScope(observation);
			if (token !== undefined) {
				return {
					blockReason:
						(await current.index.isEncryptionManifestTokenCurrent(
							token,
							observation,
						))
							? null
							: "manifest changed",
					validationToken: token,
				};
			}
			const read =
				knownManifest ??
				(await current.index.downloadEncryptionManifestForGuard());
			const ready = await workflow.admission.ensureEncryptionReady(
				{ prompt: false },
				read,
			);
			return {
				blockReason: ready ? null : "encryption blocked",
				validationToken: read.validationToken,
			};
		},
	);
	const full = async (
		cold = false,
		invocation?: StartupInvocation,
	): Promise<Awaited<ReturnType<typeof current.engine.fullSync>>> => {
		if (!invocation) {
			return await startup.runInvocation((owned) => full(cold, owned));
		}
		assert.equal(await startup.refresh(false, true, invocation), "ready");
		const result = await current.engine.fullSync(
			cold ? { startup: true } : undefined,
			invocation.reads,
		);
		assert.equal(
			result.success,
			true,
			`Full reconciliation failed: ${result.errors.map((error) => error.message).join("; ")}`,
		);
		return result;
	};
	return {
		startup,
		workflow,
		full,
		async tokenSetup() {
			current.settings.yandexTokenSecret = "";
			assert.equal(await startup.refresh(false), "blocked");
			await applyUserSettingsPatch(
				{
					getSettings: () => current.settings,
					persistenceFailed: () => false,
					isConfigurationBusy: () => false,
					hasTransition: () => false,
					hasDurableConfigurationWork: () => false,
					isUnloaded: () => false,
					isLayoutReady: () => true,
					setUpdating: () => {},
					stopRegularSync: () => current.watcher.stop(),
					startAutomation: () => {},
					invalidateRemoteStateClassification: () => {
						startup.validated = false;
					},
					settingsSaveRejected: unexpected,
					persistPluginData: async (patch) => {
						// Fixture has coherent JSON persistence; the actual PluginPersistence queue is covered by the suite.
						await current.saved();
						Object.assign(current.settings, patch);
						current.client.setToken("synthetic");
					},
					runStartupInvocation: (action) =>
						startup.runInvocation(action),
					refreshRemoteStartupState: (prompt, recovery, invocation) =>
						startup.refresh(prompt, recovery, invocation),
					reconcile: (invocation) => full(true, invocation),
					watcher: current.watcher,
					engine: current.engine,
				},
				{ yandexTokenSecret: "synthetic" },
			);
			assert.equal(startup.validated, true);
		},
	};
}

/** Every context has independent device baselines/queues and two initialized codec instances. */
async function setup(
	encrypted: boolean,
	empty = false,
	deep = false,
	limit = 20,
) {
	const disk = new MeasuredDisk();
	const desktopCodec = await codecFor(encrypted);
	const desktop = device(disk, "desktop", desktopCodec);
	const expected: Record<string, string> = {};
	const expectedDeleted = new Set<string>();
	for (let n = 0; n < 42; n++) {
		const path = deep
			? `branch-${n % 6}/${"nested/".repeat(n % 4)}note-${n}.md`
			: `note-${n}.md`;
		expected[path] = `content-${n}`;
		desktop.vault.put(path, bytes(expected[path]));
	}
	await desktop.full();
	if (desktopCodec) {
		const manifest = await new EncryptionManager().createManifest({
			service: desktopCodec,
			salt,
			state: "enabled",
			revision: 1,
			deviceId: "desktop",
		});
		disk.files.set(
			"vault/.obsidian-encrypt.json",
			bytes(JSON.stringify(manifest)),
		);
	}
	admission(desktop, desktopCodec);
	const codec = await codecFor(encrypted);
	const vault = new MeasuredVault();
	if (!empty) {
		for (const [path, text] of Object.entries(expected)) {
			vault.put(path, bytes(text));
		}
	}
	const seenMutations = new Map<string, number>();
	const persistedEventIds = new Set<string>();
	const observe = (snapshot: SavedDevice) => {
		if (!disk.metrics) {
			return;
		}
		disk.metrics.persistenceRequests++;
		for (const mutation of snapshot.pendingMutations) {
			const prior = seenMutations.get(mutation.id);
			assert.ok(
				prior === undefined || prior === mutation.seq,
				"A durable mutation ID cannot change sequence",
			);
			seenMutations.set(mutation.id, mutation.seq);
		}
		for (const event of snapshot.pendingWatcherEvents) {
			assert.ok(event.id);
			persistedEventIds.add(event.id);
		}
	};
	const connect = (saved?: SavedDevice) => {
		const current = device(disk, "phone", codec, vault, saved, {}, observe);
		current.settings.maxConcurrency = limit;
		current.index.getLocalIndex().remoteScope = {
			remotePath: "vault",
			rootResourceId: `${disk.identity}:vault`,
		};
		vault.phase = () => current.engine.getState().phase ?? "idle";
		return { current, host: admission(current, codec) };
	};
	let { current, host } = connect();
	const canonical = async (): Promise<SyncIndex> => {
		const body = disk.files.get("vault/.obsidian-sync-index.json")!;
		return JSON.parse(
			new TextDecoder().decode(codec ? await codec.decrypt(body) : body),
		) as SyncIndex;
	};
	return {
		expectedDeleted,
		disk,
		vault,
		desktop,
		codec,
		expected,
		canonical,
		seenMutations,
		persistedEventIds,
		get current() {
			return current;
		},
		get host() {
			return host;
		},
		async restart(saved: SavedDevice) {
			await current.stop();
			({ current, host } = connect(
				JSON.parse(JSON.stringify(saved)) as SavedDevice,
			));
			assert.deepEqual(
				current.index.getPendingMutations(),
				saved.pendingMutations,
			);
			assert.deepEqual(
				current.index.getPendingPhysicalActions(),
				saved.pendingPhysicalActions,
			);
			assert.deepEqual(
				JSON.parse(JSON.stringify(current.watcher.getDeferredEvents())),
				saved.pendingWatcherEvents,
				"Restart preserves exact durable watcher identity/context",
			);
		},
		async stop() {
			disk.metrics = null;
			vault.metrics = null;
			await current.stop();
			await desktop.stop();
		},
	};
}
type Context = Awaited<ReturnType<typeof setup>>;
const rows: unknown[] = [];
let activeScenario = "setup";
export const currentScenario = () => activeScenario;

/** Check bytes, canonical/baseline, durable ACK and FIFO separately from measured traffic. */
async function outcomes(ctx: Context) {
	await ctx.current.assertSettled(ctx.expected);
	const canonical = await ctx.canonical();
	const saved = ctx.current.lastSaved();
	assert.equal(saved.localState.observedEpoch, canonical.epoch);
	assert.equal(
		saved.localState.observedRevision,
		ctx.current.index.getLocalIndex().observedRevision,
		"Durable observed revision must equal the live causal baseline",
	);
	assert.ok(
		saved.localState.observedRevision <= canonical.revision,
		"Realtime must not falsely observe a future revision",
	);
	assert.deepEqual(saved.pendingMutations, []);
	assert.deepEqual(saved.pendingPhysicalActions, []);
	assert.deepEqual(saved.pendingWatcherEvents, []);
	assert.deepEqual(
		saved.localState,
		JSON.parse(JSON.stringify(ctx.current.index.getLocalIndexData())),
		"Durable local state must match the complete live baseline",
	);
	for (const path of ctx.expectedDeleted) {
		assert.equal(
			canonical.files[path]?.deleted,
			true,
			"An ordinary deletion requires a canonical tombstone",
		);
		assert.equal(
			saved.localState.files[path]?.deleted,
			true,
			"Deletion must remain in the durable baseline",
		);
	}
	for (const seq of ctx.seenMutations.values()) {
		assert.ok(
			(canonical.appliedMutationSeq.phone ?? 0) >= seq,
			"FIFO receipt must cover every observed pending identity",
		);
	}
	assert.equal(canonical.format, "sync-index");
	assert.ok(!canonical.maintenance);
}

async function measure(
	ctx: Context,
	scenario: string,
	action: () => Promise<SyncResult | void>,
	noop = false,
) {
	activeScenario = scenario;
	const before = await ctx.canonical();
	const physicalBefore = structuredClone([...ctx.disk.files]);
	const metrics = counters();
	const apiBefore = ctx.current.client.getApiReadMetrics();
	ctx.disk.metrics = metrics;
	ctx.vault.metrics = metrics;
	const started = performance.now();
	let result: SyncResult | void;
	try {
		result = await action();
	} finally {
		ctx.disk.metrics = null;
		ctx.vault.metrics = null;
	}
	const elapsedMs = Math.round(performance.now() - started);
	const after = await ctx.canonical();
	const apiAfter = ctx.current.client.getApiReadMetrics();
	if (noop) {
		assert.deepEqual(
			after,
			before,
			"No-op must preserve canonical exactly",
		);
		assert.deepEqual(
			[...ctx.disk.files],
			physicalBefore,
			"No-op must preserve physical bytes exactly",
		);
		assert.deepEqual(
			[result?.uploaded, result?.downloaded, result?.deleted],
			[0, 0, 0],
		);
		assert.equal(metrics.requests["PUT.body"] ?? 0, 0);
		assert.equal(metrics.requests["POST.move"] ?? 0, 0);
		assert.equal(metrics.requests["DELETE.metadata"] ?? 0, 0);
	}
	await outcomes(ctx);
	if (!scenario.startsWith("realtime-edit")) {
		assert.equal(
			ctx.current.lastSaved().localState.observedRevision,
			after.revision,
			"A successful full must durably observe its final canonical revision",
		);
	}
	const api = Object.fromEntries(
		Object.entries(apiAfter).map(([key, count]) => [
			key,
			count - apiBefore[key as keyof typeof apiBefore],
		]),
	);
	const row = {
		scenario,
		encrypted: !!ctx.codec,
		maxConcurrency: ctx.current.settings.maxConcurrency,
		api,
		apiTotal: Object.values(api).reduce((a, b) => a + b, 0),
		...metrics,
		canonicalRevisionDelta: after.revision - before.revision,
		elapsedMs,
		result: result
			? {
					uploaded: result.uploaded,
					downloaded: result.downloaded,
					deleted: result.deleted,
				}
			: null,
		outcomes: {
			bytesCanonicalBaselineQueues: true,
			durableReceipts: true,
			observedMutationIds: ctx.seenMutations.size,
			observedEventIds: ctx.persistedEventIds.size,
		},
	};
	rows.push(row);
	process.stdout.write(JSON.stringify(row) + "\n");
	return row;
}

/** Wait through actual debounce/drain timers; no private watcher entry points are called. */
async function realtime(ctx: Context, paths: string[], label: string) {
	ctx.current.start();
	for (const path of paths) {
		ctx.expected[path] = `${label}:${path}`;
		ctx.vault.put(path, bytes(ctx.expected[path]));
	}
	await awaitRealtime(ctx, paths);
}

async function awaitRealtime(ctx: Context, paths: string[]) {
	const deadline = performance.now() + 30_000;
	do {
		await delay(10);
		await ctx.current.watcher.waitForPendingPersistence();
		if (
			!ctx.current.engine.hasPendingWork() &&
			ctx.current.watcher.getDeferredEvents().length === 0 &&
			paths.every(
				(path) =>
					ctx.current.index.getLocalIndex().files[path]?.sha256 !==
						undefined &&
					ctx.current.index.getLocalIndex().files[path]?.sha256 ===
						sha(Buffer.from(bytes(ctx.expected[path]!))),
			)
		) {
			return;
		}
	} while (performance.now() < deadline);
	process.stderr.write(
		JSON.stringify({
			failure: "realtime-timeout",
			pendingEvents: ctx.current.watcher.getDeferredEvents().length,
			pendingMutations: ctx.current.index.getPendingMutations().length,
			pendingPhysical:
				ctx.current.index.getPendingPhysicalActions().length,
			mismatchedBaselines: paths.filter(
				(path) =>
					ctx.current.index.getLocalIndex().files[path]?.sha256 !==
					sha(Buffer.from(bytes(ctx.expected[path]!))),
			).length,
		}) + "\n",
	);
	throw new Error(
		"Realtime did not durably settle before diagnostic deadline",
	);
}

async function standard(encrypted: boolean) {
	const ctx = await setup(encrypted);
	try {
		await measure(ctx, "token-initial-identical42", () =>
			ctx.host.tokenSetup(),
		);
		await measure(ctx, "full-noop42", () => ctx.host.full(), true);
		ctx.expected["note-0.md"] = "one phone edit";
		ctx.vault.put("note-0.md", bytes(ctx.expected["note-0.md"]));
		await measure(ctx, "full-upload1", () => ctx.host.full());
		for (const path of Object.keys(ctx.expected)) {
			ctx.expected[path] = `bulk:${path}`;
			ctx.vault.put(path, bytes(ctx.expected[path]));
		}
		await measure(ctx, "full-upload42", () => ctx.host.full());
		await ctx.desktop.full();
		await ctx.desktop.assertSettled(ctx.expected);
		ctx.expected["note-1.md"] = "offline desktop edit";
		ctx.desktop.vault.put("note-1.md", bytes(ctx.expected["note-1.md"]));
		await ctx.desktop.full();
		await measure(ctx, "full-download1", () => ctx.host.full());
		delete ctx.expected["note-2.md"];
		ctx.expectedDeleted.add("note-2.md");
		ctx.vault.remove("note-2.md");
		await measure(ctx, "full-local-delete1", () => ctx.host.full());
		await ctx.desktop.full();
		await ctx.desktop.assertSettled(ctx.expected);
		delete ctx.expected["note-3.md"];
		ctx.expectedDeleted.add("note-3.md");
		ctx.desktop.vault.remove("note-3.md");
		await ctx.desktop.full();
		await measure(ctx, "full-remote-delete1", () => ctx.host.full());
		await measure(ctx, "full-followup-noop", () => ctx.host.full(), true);
		await ctx.restart(ctx.current.lastSaved());
		await measure(
			ctx,
			"json-restart-full-noop",
			() => ctx.host.full(),
			true,
		);
	} finally {
		await ctx.stop();
	}
}

async function realtimeSeries(encrypted: boolean) {
	const ctx = await setup(encrypted);
	try {
		await ctx.host.tokenSetup();
		await measure(ctx, "realtime-edit1", () =>
			realtime(ctx, ["note-0.md"], "realtime-one"),
		);
		await measure(ctx, "realtime-edit42", () =>
			realtime(
				ctx,
				Array.from({ length: 42 }, (_, n) => `note-${n}.md`),
				"realtime-burst",
			),
		);
		await measure(
			ctx,
			"realtime-followup-full-noop",
			() => ctx.host.full(),
			true,
		);
		ctx.current.engine.pause();
		ctx.expected["note-4.md"] = "pending restart edit";
		ctx.vault.put("note-4.md", bytes(ctx.expected["note-4.md"]));
		await delay(20);
		await ctx.current.watcher.waitForPendingPersistence();
		const saved = ctx.current.lastSaved();
		assert.equal(
			saved.pendingWatcherEvents.length,
			1,
			"One durable event must survive restart",
		);
		await ctx.restart(saved);
		await measure(ctx, "json-restart-pending-full1", () => ctx.host.full());
		await measure(ctx, "json-restart-noop", () => ctx.host.full(), true);
		await ctx.desktop.full();
		await ctx.desktop.assertSettled(ctx.expected);
	} finally {
		await ctx.stop();
	}
}

export async function run() {
	if (process.argv.includes("--rename-latency")) {
		await renameLatency();
		return;
	}
	if (process.argv.includes("--realtime-boundaries")) {
		activeScenario = "realtime-boundaries";
		const { runRealtimeBoundaries } =
			await import("./sync-efficiency-realtime");
		await runRealtimeBoundaries();
		return;
	}
	if (process.argv.includes("--verify-oracle")) {
		const ctx = await setup(false);
		try {
			await ctx.host.tokenSetup();
			ctx.vault.put(
				"note-0.md",
				bytes("synthetic corrupted local byte oracle"),
			);
			await assert.rejects(() => outcomes(ctx));
			process.stdout.write(
				JSON.stringify({ byteOracleRejectsCorruption: true }) + "\n",
			);
		} finally {
			await ctx.stop();
		}
		return;
	}
	const outputFlag = process.argv.indexOf("--out");
	const outputPath =
		outputFlag < 0 ? undefined : process.argv[outputFlag + 1];
	assert.ok(
		outputFlag < 0 || (outputPath && !outputPath.startsWith("--")),
		"--out needs a scratch JSON path",
	);
	const onlyFlag = process.argv.indexOf("--only");
	const only = onlyFlag < 0 ? undefined : process.argv[onlyFlag + 1];
	assert.ok(
		!only || ["plain", "encrypted"].includes(only),
		"--only accepts plain or encrypted",
	);
	for (const encrypted of [false, true]) {
		if (only && (only === "encrypted") !== encrypted) {
			continue;
		}
		await standard(encrypted);
		await realtimeSeries(encrypted);
		const empty = await setup(encrypted, true);
		try {
			await measure(empty, "token-initial-empty42", () =>
				empty.host.tokenSetup(),
			);
			await measure(
				empty,
				"initial-empty-followup-noop",
				() => empty.host.full(),
				true,
			);
		} finally {
			await empty.stop();
		}
	}
	// Sparse limits rather than a Cartesian matrix: both codecs above; traversal/overlap below.
	if (!only) {
		for (const limit of [1, 20, 40]) {
			const ctx = await setup(false, false, false, limit);
			try {
				const row = await measure(
					ctx,
					"initial-identical42-limit",
					() => ctx.host.tokenSetup(),
				);
				assert.ok(row.peakUserMetadata <= limit);
			} finally {
				await ctx.stop();
			}
			const deep = await setup(false, false, true, limit);
			try {
				await deep.host.tokenSetup();
				const row = await measure(
					deep,
					"full-noop-uneven-deep",
					() => deep.host.full(),
					true,
				);
				assert.ok(row.peakDirectories <= limit);
				assert.ok(row.peakDirectories >= (limit === 1 ? 1 : 6));
			} finally {
				await deep.stop();
			}
		}
	}
	const sourcePaths = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "src"],
		{
			encoding: "utf8",
		},
	)
		.trim()
		.split("\n");
	const sourceHashes = await Promise.all(
		sourcePaths.map(async (path) => [path, sha(await readFile(path))]),
	);
	const runnerPaths = [
		"scripts/check-sync-efficiency.mjs",
		"tests/helpers/sync-efficiency.ts",
		"tests/helpers/sync-flow.ts",
		"tests/helpers/obsidian-stub.mjs",
	];
	const runnerHashes = await Promise.all(
		runnerPaths.map(async (path) => [path, sha(await readFile(path))]),
	);
	const summary = {
		schema: "sync-efficiency-v1",
		fixtureFiles: 42,
		syntheticReadDelayMs: 2,
		runtime: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		identity: {
			head: execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
			productionSha256: sha(JSON.stringify(sourceHashes)),
			runnerSha256: sha(JSON.stringify(runnerHashes)),
		},
		rows,
	};
	if (outputPath) {
		await writeFile(
			outputPath,
			JSON.stringify(summary, null, "\t") + "\n",
			{
				flag: "wx",
			},
		);
	}
	process.stdout.write(
		JSON.stringify({
			success: true,
			scenarios: rows.length,
			productionSha256: summary.identity.productionSha256,
		}) + "\n",
	);
}

export { setup, measure, counters, awaitRealtime };

/** Compare the approved rename histories with identical algorithm and byte oracles. */
async function renameLatency() {
	for (const encrypted of [false, true]) {
		for (const history of [
			"duplicate",
			"late",
			"inflight",
			"move-duplicate",
			"move-late",
		] as const) {
			const ctx = await setup(encrypted);
			try {
				await ctx.host.tokenSetup();
				ctx.current.start();
				const source = "note-1.md";
				const target = "Renamed.md";
				const moveOnly = history.startsWith("move-");
				const physical = await ctx.current.client.getPhysicalPath(
					`vault/${history === "inflight" ? source : target}`,
				);
				const rename = () => {
					ctx.expected[target] = ctx.expected[source]!;
					delete ctx.expected[source];
					ctx.expectedDeleted.add(source);
					ctx.vault.rename(source, target);
				};
				ctx.disk.beforeRequest = async (method, endpoint, path) => {
					if (
						((method === "PUT" && endpoint === "/upload") ||
							(moveOnly &&
								method === "POST" &&
								endpoint.endsWith("/resources/move"))) &&
						path === physical
					) {
						ctx.disk.beforeRequest = undefined;
						if (history === "inflight") {
							rename();
						} else if (
							history === "late" ||
							history === "move-late"
						) {
							ctx.expected[target] =
								"late edit after rename snapshot";
							ctx.vault.put(target, bytes(ctx.expected[target]));
						}
					}
				};
				await measure(
					ctx,
					`realtime-edit-rename-latency-${history}`,
					async () => {
						if (!moveOnly) {
							ctx.expected[source] = "modified before rename";
							ctx.vault.put(source, bytes(ctx.expected[source]));
						}
						if (history !== "inflight") {
							rename();
						}
						await awaitRealtime(ctx, [target]);
						if (
							history === "duplicate" ||
							history === "move-duplicate"
						) {
							ctx.vault.put(target, bytes(ctx.expected[target]!));
							await awaitRealtime(ctx, [target]);
						}
					},
				);
				await ctx.desktop.full();
				await ctx.desktop.assertSettled(ctx.expected);
			} finally {
				ctx.disk.beforeRequest = undefined;
				await ctx.stop();
			}
		}
		const ctx = await setup(encrypted);
		try {
			await ctx.host.tokenSetup();
			const saved = await ctx.current.saved();
			ctx.desktop.vault.rename("note-1.md", "Renamed.md");
			ctx.desktop.vault.put(
				"Renamed.md",
				bytes("published rename and edit"),
			);
			await ctx.desktop.engine.renameFile("note-1.md", "Renamed.md");
			delete ctx.expected["note-1.md"];
			ctx.expectedDeleted.add("note-1.md");
			ctx.expected["Renamed.md"] = "published rename and edit";
			await ctx.restart(saved);
			await measure(ctx, "restart-receive-rename-edit", () =>
				ctx.host.full(),
			);
			await measure(
				ctx,
				"rename-followup-noop",
				() => ctx.host.full(),
				true,
			);
		} finally {
			await ctx.stop();
		}
	}
	const flag = process.argv.indexOf("--out");
	assert.ok(
		flag >= 0 && process.argv[flag + 1],
		"Rename latency run needs a fresh --out path",
	);
	await writeFile(
		process.argv[flag + 1]!,
		JSON.stringify(
			{ schema: "sync-rename-latency-v1", success: true, rows },
			null,
			"\t",
		) + "\n",
		{ flag: "wx" },
	);
}

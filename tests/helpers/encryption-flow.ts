import { PluginStartup, type StartupBlocks } from "../../src/plugin-startup";
import { BackupManager } from "../../src/backup/backup-manager";
import { captureLogicalVaultDigest } from "../../src/backup/backup-snapshot";
import type { EncryptionContext } from "../../src/crypto/context";
import type { EncryptionCodec } from "../../src/crypto/encryption";
import { EncryptionManager } from "../../src/crypto/encryption-manager";
import type { LocalEncryptionTransition } from "../../src/crypto/encryption-transition";
import { EncryptionWorkflow } from "../../src/crypto/workflow";
import type { device } from "./sync-flow";

/** Use production orchestration with synthetic host persistence and no presentation objects. */
export function encryptionFlow(
	a: ReturnType<typeof device>,
	overrides: Partial<EncryptionContext> = {},
) {
	let service: EncryptionCodec | null = null;
	let transition: LocalEncryptionTransition | null = null;
	let cancelled = false;
	let block: string | null = null;
	const context: EncryptionContext = {
		client: a.client,
		index: a.index,
		engine: a.engine,
		backup: new BackupManager(a.client, a.adapter, a.settings, "2.0.0"),
		manager: new EncryptionManager(),
		getLocalSnapshotDigest: async () =>
			await captureLogicalVaultDigest(a.adapter),
		getSettings: () => a.settings,
		getService: () => service,
		setService: (value) => {
			service = value;
		},
		getTransition: () => transition,
		setTransition: (value) => {
			transition = value;
		},
		isCancelled: () => cancelled,
		assertConnectionAllowed: () => {
			if (cancelled) {
				throw new Error("Plugin was unloaded");
			}
		},
		persist: async () => {
			await a.saved();
		},
		ui: {
			setBlock: (reason) => {
				block = reason;
				a.engine.setExternalBlock("encryption", reason);
			},
			setHistoricalBlock: (reason) => {
				a.engine.setExternalBlock("historical", reason);
			},
			requestPassword: async () => null,
			connected: () => {},
			disabledRemotely: () => {},
			stateChanged: () => {},
		},
		...overrides,
	};
	const workflow = new EncryptionWorkflow(context);
	return {
		context,
		workflow,
		cancel: () => {
			cancelled = true;
		},
		block: () => block,
		async saved() {
			return JSON.parse(
				JSON.stringify({
					settings: context.getSettings(),
					transition: context.getTransition(),
					device: await a.saved(),
				}),
			) as {
				settings: typeof a.settings;
				transition: LocalEncryptionTransition | null;
				device: Awaited<ReturnType<typeof a.saved>>;
			};
		},
	};
}

/** Bind actual startup/recovery/admission to the same algorithms used by lifecycle full. */
export function startupFlow(
	a: ReturnType<typeof device>,
	flow: ReturnType<typeof encryptionFlow>,
) {
	const blocks: StartupBlocks = {
		migration: null,
		historical: null,
		authentication: null,
		encryption: null,
	};
	a.settings.yandexTokenSecret = "synthetic";
	const startup = new PluginStartup({
		index: a.index,
		engine: a.engine,
		getSettings: () => a.settings,
		getBlocks: () => ({ ...blocks, encryption: flow.block() }),
		hasTransition: () => flow.context.getTransition() !== null,
		isStopped: () => flow.context.isCancelled(),
		setBlock: (kind, reason) => {
			blocks[kind] = reason;
			a.engine.setExternalBlock(kind, reason);
		},
		ensureStorageBinding: async () => {
			await a.index.assertRemoteScope();
			return true;
		},
		recoverEncryptionTransition: () =>
			flow.workflow.recovery.recoverEncryptionTransition(),
		tryRecoverRemoteTargetTransition: (reads) =>
			flow.workflow.recovery.tryRecoverRemoteTargetTransition(reads),
		ensureEncryptionReady: (options, read) =>
			flow.workflow.admission.ensureEncryptionReady(options, read),
	});
	a.engine.setSyncGuardCallback(async (token, observation, known) => {
		await a.index.assertRemoteScope(observation);
		if (token !== undefined) {
			return {
				blockReason: (await a.index.isEncryptionManifestTokenCurrent(
					token,
					observation,
				))
					? null
					: "manifest changed",
				validationToken: token,
			};
		}
		const read =
			known ?? (await a.index.downloadEncryptionManifestForGuard());
		const ready = await flow.workflow.admission.ensureEncryptionReady(
			{ prompt: false },
			read,
		);
		return {
			blockReason: ready ? null : "encryption blocked",
			validationToken: read.validationToken,
		};
	});
	return startup;
}

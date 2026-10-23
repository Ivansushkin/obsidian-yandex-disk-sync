import type { YandexDiskClient } from "../../api/yandex-client";
import type {
	IndexManager,
	RemoteAuthorityObservation,
} from "../canonical/manager";
import type { YandexDiskSyncSettings } from "../../types";
import {
	readRemoteStorageScope,
	sameRemoteStorageScope,
	StorageScopeError,
} from "./storage-scope";

export type StorageBindingChoice = "same" | "new" | "replacement" | "cancel";

interface Dependencies {
	client: YandexDiskClient;
	index: IndexManager;
	getSettings: () => YandexDiskSyncSettings;
	hasPendingWork: () => boolean;
	hasTransition: () => boolean;
	isUnloaded: () => boolean;
	persist: () => Promise<void>;
	verifyReplacement?: () => Promise<{
		epoch: string;
		apply(): Promise<void>;
		rollback(): Promise<void>;
	}>;
	confirm: (
		path: string,
		canKeepHistory: boolean,
		canAdoptReplacement?: boolean,
	) => Promise<StorageBindingChoice>;
}

/** Admit one remote root before recovery or synchronization can use local history. */
export class StorageBindingController {
	private pending: Promise<boolean> | null = null;

	constructor(private readonly deps: Dependencies) {}

	ensure(
		prompt: boolean,
		observation?: RemoteAuthorityObservation,
	): Promise<boolean> {
		if (
			!prompt &&
			observation &&
			this.deps.index.getLocalIndex().remoteScope
		) {
			return this.deps.index
				.assertRemoteScope(observation)
				.then(() => true);
		}
		if (!this.pending) {
			this.pending = this.ensureNow(prompt).finally(() => {
				this.pending = null;
			});
		}
		return this.pending;
	}

	private async ensureNow(prompt: boolean): Promise<boolean> {
		const { deps } = this;
		const settings = deps.getSettings();
		const path = settings.remotePath;
		const token = settings.yandexTokenSecret;
		let observed = await readRemoteStorageScope(deps.client, path);
		const state = deps.index.getLocalIndex();
		if (
			state.remoteScope &&
			sameRemoteStorageScope(state.remoteScope, observed)
		) {
			return true;
		}
		const hasHistory =
			state.remoteScope !== null ||
			state.observedEpoch !== null ||
			Object.keys(state.files).length > 0 ||
			deps.hasPendingWork() ||
			deps.hasTransition();
		const canAdoptReplacement =
			!!state.remoteScope &&
			!!observed &&
			state.remoteScope.remotePath === path &&
			state.observedEpoch !== null &&
			!deps.hasTransition();
		let choice: StorageBindingChoice = "new";
		if (hasHistory) {
			if (!prompt) {
				return false;
			}
			choice = await deps.confirm(
				path,
				state.remoteScope === null && observed !== null,
				canAdoptReplacement,
			);
		}
		if (choice === "cancel") {
			return false;
		}
		if (
			deps.isUnloaded() ||
			deps.getSettings().remotePath !== path ||
			deps.getSettings().yandexTokenSecret !== token
		) {
			throw new StorageScopeError(
				"Connection changed while storage confirmation was open",
			);
		}
		const replacement =
			choice === "replacement" && canAdoptReplacement
				? await deps.verifyReplacement?.()
				: undefined;
		if (
			choice === "replacement" &&
			(!replacement || replacement.epoch === state.observedEpoch)
		) {
			throw new StorageScopeError(
				"A completed replacement generation must be verified before keeping offline history",
			);
		}
		if (
			deps.isUnloaded() ||
			deps.getSettings().remotePath !== path ||
			deps.getSettings().yandexTokenSecret !== token
		) {
			throw new StorageScopeError(
				"Connection changed during replacement verification",
			);
		}
		const fresh = await readRemoteStorageScope(deps.client, path);
		if (
			(observed && !sameRemoteStorageScope(observed, fresh)) ||
			(!observed && fresh)
		) {
			throw new StorageScopeError(
				"Remote folder changed while confirmation was open",
			);
		}
		if (choice === "same" && (state.remoteScope !== null || !fresh)) {
			throw new StorageScopeError(
				"Existing history cannot be reassigned to another root",
			);
		}
		if (
			choice === "new" &&
			(deps.hasPendingWork() || deps.hasTransition())
		) {
			throw new StorageScopeError(
				"Resolve pending work in the original storage before reconnecting",
			);
		}
		const previous = deps.index.captureLocalCausalState();
		try {
			await replacement?.apply();
			if (choice === "new") {
				deps.index.resetLocalStorageHistory();
			}
			if (!observed) {
				await deps.client.createFolderRecursive(path);
				observed = await readRemoteStorageScope(deps.client, path);
			}
			if (!observed) {
				throw new StorageScopeError(
					"Remote folder identity is unavailable",
				);
			}
			deps.index.getLocalIndex().remoteScope = observed;
			try {
				await deps.persist();
			} catch {
				throw new StorageScopeError(
					"Storage binding persistence failure",
				);
			}
		} catch (error) {
			deps.index.restoreLocalCausalState(previous);
			await replacement?.rollback();
			throw error;
		}
		return true;
	}
}

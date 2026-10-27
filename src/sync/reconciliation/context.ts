import { VaultAdapter } from "../../api/vault-adapter";
import { YandexDiskClient } from "../../api/yandex-client";
import type { YandexDiskSyncSettings } from "../../types";
import { IndexManager } from "../canonical/manager";
import type { IndexSaveCallback, SyncGuardResult } from "../contracts";
import * as fileOperations from "../files/operations";
import * as remoteMoves from "../files/remote-moves";
import { ConflictResolver } from "./conflicts";
export interface Dependencies {
	createReadLifetimeGuard: () => () => void;
	indexManager: IndexManager;
	indexSaveCallback: IndexSaveCallback | null;
	realtimeGuardValidationToken: string | undefined;
	getSyncGuardResult: (
		skipGuard?: boolean,
		validationToken?: string,
		validateThroughExternalBlock?: boolean,
	) => Promise<SyncGuardResult>;
	setBlockedState: (
		reason: string,
		status?: "error" | "migration-required" | "encryption-required",
	) => void;
	epochReplacementPending: boolean;
	vaultAdapter: VaultAdapter;
	settings: YandexDiskSyncSettings;
	yandexClient: YandexDiskClient;
	conflictResolver: ConflictResolver;
	expectWatcherEvent: (
		path: string,
		action: "upload" | "delete" | "rename",
	) => void;
	fileOperations: fileOperations.Dependencies;
	remoteMoves: remoteMoves.Dependencies;
}

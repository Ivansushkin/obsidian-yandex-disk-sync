import { logger } from "../utils/logger";

export type SyncSessionKind =
	| "full"
	| "force"
	| "realtime"
	| "maintenance";

export interface ActiveSyncSession {
	id: string;
	kind: SyncSessionKind;
	enqueuedAt: number;
	startedAt: number;
}

export interface SyncSessionHooks {
	onEnter?: (kind: SyncSessionKind) => void | Promise<void>;
	onExit?: (kind: SyncSessionKind) => void | Promise<void>;
}

/**
 * Serializes every synchronization entry point before any asynchronous guard
 * or remote operation can run.
 */
export class SyncCoordinator {
	private tail: Promise<void> = Promise.resolve();
	private activeKind: SyncSessionKind | null = null;
	private activeSession: ActiveSyncSession | null = null;
	private pendingFull: Promise<unknown> | null = null;
	private sequence = 0;

	constructor(private readonly hooks: SyncSessionHooks = {}) {}

	/**
	 * Run one exclusive session. Concurrent full-sync requests share one result.
	 */
	run<T>(kind: SyncSessionKind, task: () => Promise<T>): Promise<T> {
		if (kind === "full" && this.pendingFull) {
			logger.debug("Coalesced full sync request into pending session", {
				activeSessionId: this.activeSession?.id ?? null,
			});
			return this.pendingFull as Promise<T>;
		}

		const enqueuedAt = Date.now();
		const sessionId = this.createSessionId(kind);
		logger.debug("Sync session queued", {
			sessionId,
			sessionKind: kind,
		});
		const run = this.tail.then(async () => {
			const startedAt = Date.now();
			this.activeKind = kind;
			this.activeSession = {
				id: sessionId,
				kind,
				enqueuedAt,
				startedAt,
			};
			logger.info("Sync session started", {
				sessionId,
				sessionKind: kind,
				queueWaitMs: startedAt - enqueuedAt,
			});
			let entered = false;
			try {
				await this.hooks.onEnter?.(kind);
				entered = true;
				const result = await task();
				logger.info("Sync session task returned", {
					sessionId,
					sessionKind: kind,
					durationMs: Date.now() - startedAt,
				});
				return result;
			} catch (error) {
				logger.error("Sync session failed", {
					sessionId,
					sessionKind: kind,
					durationMs: Date.now() - startedAt,
					error,
				});
				throw error;
			} finally {
				try {
					if (entered) {
						await this.hooks.onExit?.(kind);
					}
				} finally {
					this.activeKind = null;
					this.activeSession = null;
				}
			}
		});
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		if (kind === "full") {
			const shared = run.finally(() => {
				if (this.pendingFull === shared) {
					this.pendingFull = null;
				}
			});
			this.pendingFull = shared;
			return shared;
		}
		return run;
	}

	/**
	 * Return the currently executing session kind.
	 */
	getActiveKind(): SyncSessionKind | null {
		return this.activeKind;
	}

	/**
	 * Return immutable diagnostic metadata for the active session.
	 */
	getActiveSession(): ActiveSyncSession | null {
		return this.activeSession ? { ...this.activeSession } : null;
	}

	private createSessionId(kind: SyncSessionKind): string {
		this.sequence++;
		return `${kind}-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
	}
}

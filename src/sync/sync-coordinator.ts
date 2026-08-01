import { logger } from "../utils/logger";
import type { SyncSessionKind } from "../types";

export type { SyncSessionKind } from "../types";

export interface ActiveSyncSession {
	id: string;
	kind: SyncSessionKind;
	enqueuedAt: number;
	startedAt: number;
}

export interface SyncSessionHooks {
	onQueued?: (session: QueuedSyncSession) => void | Promise<void>;
	onEnter?: (session: ActiveSyncSession) => void | Promise<void>;
	onExit?: (
		session: ActiveSyncSession,
		success: boolean,
		error?: unknown,
	) => void | Promise<void>;
}

export interface QueuedSyncSession {
	id: string;
	kind: SyncSessionKind;
	enqueuedAt?: number;
}

export type SyncSessionSettlement<T> =
	| { status: "fulfilled"; value: T }
	| { status: "rejected"; reason: unknown };

export interface SyncRunHooks<T> {
	/** Run local preparation before the session enters the shared queue. */
	prepare?: (session: QueuedSyncSession) => void | Promise<void>;
	/** Persist acknowledgement while the session still owns the coordinator. */
	settle?: (
		settlement: SyncSessionSettlement<T>,
		session: ActiveSyncSession,
	) => void | Promise<void>;
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
	run<T>(
		kind: SyncSessionKind,
		task: () => Promise<T>,
		runHooks: SyncRunHooks<T> = {},
	): Promise<T> {
		if (kind === "full" && this.pendingFull) {
			logger.debug("Coalesced full sync request into pending session", {
				activeSessionId: this.activeSession?.id ?? null,
			});
			return this.pendingFull as Promise<T>;
		}

		const sessionId = this.createSessionId(kind);
		const execute = async (): Promise<T> => {
			await runHooks.prepare?.({ id: sessionId, kind });
			return await this.enqueueSession(kind, sessionId, task, runHooks);
		};
		const run = execute();
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

	private enqueueSession<T>(
		kind: SyncSessionKind,
		sessionId: string,
		task: () => Promise<T>,
		runHooks: SyncRunHooks<T>,
	): Promise<T> {
		const enqueuedAt = Date.now();
		const queuedSession: QueuedSyncSession = {
			id: sessionId,
			kind,
			enqueuedAt,
		};
		logger.debug("Sync session queued", {
			sessionId,
			sessionKind: kind,
		});
		const queued = Promise.resolve(this.hooks.onQueued?.(queuedSession));
		const run = Promise.all([this.tail, queued]).then(async () => {
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
			let fulfilledSettlementAttempted = false;
			try {
				await this.hooks.onEnter?.(this.activeSession);
				entered = true;
				const result = await task();
				fulfilledSettlementAttempted = true;
				await runHooks.settle?.(
					{ status: "fulfilled", value: result },
					this.activeSession,
				);
				logger.info("Sync session task returned", {
					sessionId,
					sessionKind: kind,
					durationMs: Date.now() - startedAt,
				});
				return result;
			} catch (error) {
				try {
					if (!fulfilledSettlementAttempted && this.activeSession) {
						await runHooks.settle?.(
							{ status: "rejected", reason: error },
							this.activeSession,
						);
					}
				} catch (settlementError) {
					logger.error("Sync session settlement failed", {
						sessionId,
						sessionKind: kind,
						error: settlementError,
					});
				}
				logger.error("Sync session failed", {
					sessionId,
					sessionKind: kind,
					durationMs: Date.now() - startedAt,
					error,
				});
				if (entered && this.activeSession) {
					await this.hooks.onExit?.(
						this.activeSession,
						false,
						error,
					);
					entered = false;
				}
				throw error;
			} finally {
				try {
					if (entered && this.activeSession) {
						await this.hooks.onExit?.(
							this.activeSession,
							true,
						);
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

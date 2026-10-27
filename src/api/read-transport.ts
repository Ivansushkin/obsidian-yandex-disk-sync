import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { RemoteReadTimeoutError, RemoteReadInterruptedError } from "../errors";
import { logger } from "../utils/logger";

export interface RemoteReadBudget {
	deadline: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface ReadDiagnostic {
	operation: string;
	endpoint: string;
	category: string;
	attempt: number;
}

interface ReadWaiter {
	reserve: boolean;
	grant(release: () => void): void;
}

/** Bound native occupancy independently of the lifetime of a caller's wait. */
export class RemoteReadTransport {
	private active = 0;
	private activeReserve = 0;
	private sequence = 0;
	private waiters = new Set<ReadWaiter>();

	constructor(
		private readonly execute: (
			params: RequestUrlParam,
		) => Promise<RequestUrlResponse>,
		private concurrency: number,
	) {}

	/** Resizing never releases permits held by unresolved native reads. */
	setConcurrency(concurrency: number): void {
		this.concurrency = Math.max(1, Math.min(concurrency, 40));
		this.dispatch();
	}

	/** A replacement has its own reserved pool; native completion alone returns its permit. */
	async request(
		params: RequestUrlParam,
		diagnostic: ReadDiagnostic,
		budget: RemoteReadBudget,
		attemptTimeoutMs: number,
		reserve = false,
	): Promise<RequestUrlResponse> {
		const requestId = `read-${++this.sequence}`;
		const context = { requestId, ...diagnostic };
		const queuedAt = Date.now();
		let release: (() => void) | undefined;
		const waiter: ReadWaiter = {
			reserve,
			grant: (permit) => {
				release = permit;
			},
		};
		const permit = new Promise<void>((resolve) => {
			waiter.grant = (granted) => {
				release = granted;
				resolve();
			};
		});
		this.waiters.add(waiter);
		this.dispatch();
		try {
			await this.wait(
				permit,
				budget,
				budget.deadline - Date.now(),
				diagnostic.operation,
				"not-started",
			);
		} catch (error) {
			this.waiters.delete(waiter);
			release?.();
			logger.warn("Remote read admission stopped", {
				...context,
				queueMs: Date.now() - queuedAt,
				outcome: budget.signal?.aborted
					? "revoked"
					: "capacity-timeout",
			});
			throw error;
		}
		if (budget.signal?.aborted || Date.now() >= budget.deadline) {
			release?.();
			this.assertBudget(budget, diagnostic.operation);
		}
		const startedAt = Date.now();
		let abandoned = false;
		logger.info("Remote read dispatched", {
			...context,
			queueMs: startedAt - queuedAt,
			remainingMs: budget.deadline - startedAt,
		});
		const native = this.execute(params)
			.then(
				(response) => {
					logger.info("Remote read returned", {
						...context,
						durationMs: Date.now() - startedAt,
						status: response.status,
						outcome: abandoned ? "late-ignored" : "completed",
					});
					return response;
				},
				(error: unknown) => {
					logger.warn("Remote read native rejection", {
						...context,
						durationMs: Date.now() - startedAt,
						outcome: abandoned ? "late-ignored" : "network",
					});
					throw error;
				},
			)
			.finally(() => release?.());
		try {
			const response = await this.wait(
				native,
				budget,
				attemptTimeoutMs,
				diagnostic.operation,
				"unresolved",
			);
			this.assertBudget(budget, diagnostic.operation);
			return response;
		} catch (error) {
			abandoned = true;
			logger.warn("Remote read wait stopped", {
				...context,
				durationMs: Date.now() - startedAt,
				remainingMs: Math.max(0, budget.deadline - Date.now()),
				outcome: budget.signal?.aborted
					? "revoked"
					: error instanceof RemoteReadTimeoutError
						? "native-timeout"
						: "failed",
			});
			throw error;
		}
	}

	private dispatch(): void {
		for (const waiter of this.waiters) {
			if (
				waiter.reserve
					? this.activeReserve >= 2
					: this.active >= this.concurrency
			) {
				continue;
			}
			this.waiters.delete(waiter);
			if (waiter.reserve) {
				this.activeReserve++;
			} else {
				this.active++;
			}
			let released = false;
			waiter.grant(() => {
				if (released) {
					return;
				}
				released = true;
				if (waiter.reserve) {
					this.activeReserve--;
				} else {
					this.active--;
				}
				this.dispatch();
			});
		}
	}

	private assertBudget(budget: RemoteReadBudget, operation: string): void {
		if (budget.signal?.aborted) {
			throw new RemoteReadInterruptedError();
		}
		if (Date.now() >= budget.deadline) {
			throw new RemoteReadTimeoutError(
				budget.timeoutMs,
				operation,
				"not-started",
			);
		}
	}

	/** Always observe native rejection, even when the signal was already revoked. */
	private wait<T>(
		promise: Promise<T>,
		budget: RemoteReadBudget,
		timeoutMs: number,
		operation: string,
		requestState: "not-started" | "unresolved",
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		return new Promise<T>((resolve, reject) => {
			const timeout = Math.max(
				0,
				Math.min(timeoutMs, budget.deadline - Date.now()),
			);
			timer = setTimeout(() => {
				reject(
					new RemoteReadTimeoutError(
						timeout,
						operation,
						requestState,
					),
				);
			}, timeout);
			abort = () => {
				reject(new RemoteReadInterruptedError());
			};
			budget.signal?.addEventListener("abort", abort, { once: true });
			void promise.then(resolve, reject);
			if (budget.signal?.aborted) {
				abort();
			}
		}).finally(() => {
			clearTimeout(timer);
			if (abort) {
				budget.signal?.removeEventListener("abort", abort);
			}
		});
	}
}

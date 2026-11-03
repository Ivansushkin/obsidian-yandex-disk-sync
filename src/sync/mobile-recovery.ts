import type { NativeRequestActivity } from "../api/read-transport";
import type { FailureSummary } from "../errors";
import type { SyncResult } from "../types";

export interface MobileRecoveryContext {
	generation: number;
	enabled: boolean;
	manualAllowed: boolean;
	mobile: boolean;
	cooldownUntil: number;
	visible: boolean;
	busy: boolean;
	blocked: boolean;
	native: NativeRequestActivity;
}

export type MobileRecoveryOutcome =
	"success" | "deferred" | "retryable" | "blocked";
export type MobileRecoveryReason =
	| "visible"
	| "online"
	| "pageshow"
	| "resume"
	| "freeze"
	| "focus"
	| "failure"
	| "gap"
	| "schedule";
export interface MobileRecoveryPresentation {
	phase: "waiting-native" | "backoff";
}
interface FullTicket {
	epoch: number;
	revision: number;
}
interface RecoveryClock {
	now(): number;
	setTimeout(run: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}
interface RecoveryPorts {
	read(): MobileRecoveryContext;
	run(): Promise<MobileRecoveryOutcome>;
	probe(): Promise<MobileRecoveryOutcome>;
	runManual(): Promise<SyncResult | null>;
	changed(): void;
	clock?: RecoveryClock;
}
const RETRY_DELAYS = [5000, 15000, 60000];
const PROBE_DELAY = 300_000;

/** Classify a whole reconciliation without retrying nested safety or persistence failures. */
export function mobileRecoveryOutcome(
	result: SyncResult | null,
	failure?: FailureSummary,
): MobileRecoveryOutcome {
	if (result?.success) {
		return "success";
	}
	if (result?.deferred) {
		return "retryable";
	}
	const failures = result?.errors.length
		? result.errors.map((error) => error.failure)
		: [failure];
	return failures.length > 0 && failures.every(isMobileRetryableFailure)
		? "retryable"
		: "blocked";
}

/** An outer retry starts a fresh invocation only after native settlement. */
export function isMobileRetryableFailure(failure?: FailureSummary): boolean {
	return Boolean(
		failure &&
		failure.category === "unavailable" &&
		(failure.code === "remote-read-timeout" ||
			(failure.code === "network" && failure.httpStatus === undefined) ||
			(failure.code === "http-error" &&
				[423, 429, 500, 502, 503, 504].includes(
					failure.httpStatus ?? 0,
				))),
	);
}

/** Coalesce mobile lifecycle hints without owning sync sessions, native requests or durable state. */
export class MobileSyncRecovery {
	private readonly clock: RecoveryClock;
	private generation: number;
	private enabled: boolean;
	private visible: boolean;
	private epoch = 0;
	private revision = 0;
	private pending = false;
	private running = false;
	private waitingSignal = false;
	private slowProbe = false;
	private wakeDuringAttempt = false;
	private retries = 0;
	private dueAt = 0;
	private attemptTimer: unknown;
	private heartbeat: unknown;
	private lastTick: number;
	private disposed = false;
	private presentation = "";
	private manualPromise: Promise<SyncResult | null> | null = null;
	private resolveManual: ((result: SyncResult | null) => void) | null = null;

	constructor(private readonly ports: RecoveryPorts) {
		this.clock = ports.clock ?? {
			now: () => Date.now(),
			setTimeout: (run, delay) => setTimeout(run, delay),
			clearTimeout: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
		};
		const state = ports.read();
		this.generation = state.generation;
		this.enabled = state.enabled;
		this.visible = state.visible;
		this.lastTick = this.clock.now();
		this.notifyActivityChanged();
	}

	/** Regular automation waits behind recovery; explicit full preparation remains independent. */
	canStartAutomatic(): boolean {
		const state = this.ports.read();
		return (
			!this.disposed &&
			state.enabled &&
			state.visible &&
			!this.pending &&
			!this.manualPromise
		);
	}

	/** Keep one explicit manual request while an earlier native write settles. */
	requestManual(): Promise<SyncResult | null> {
		this.refresh();
		if (this.disposed || !this.ports.read().manualAllowed) {
			return Promise.resolve(null);
		}
		if (this.manualPromise) {
			return this.manualPromise;
		}
		this.manualPromise = new Promise((resolve) => {
			this.resolveManual = resolve;
		});
		this.clearAttempt();
		this.schedule();
		this.publish();
		return this.manualPromise;
	}

	/** A full already starting after this request may satisfy it after coherent persistence. */
	beginFull(): FullTicket {
		return { epoch: this.epoch, revision: this.revision };
	}

	completeFull(ticket: FullTicket, success: boolean): void {
		this.refresh();
		if (success && this.current(ticket)) {
			this.pending = false;
			this.waitingSignal = false;
			this.clearAttempt();
			this.publish();
		}
	}

	/** Repeated hints within one episode preserve its original deadline and retry budget. */
	request(reason: MobileRecoveryReason): void {
		this.refresh();
		if (this.disposed || !this.enabled) {
			return;
		}
		if (
			reason === "focus" &&
			!this.pending &&
			this.clock.now() - this.lastTick < 30000
		) {
			return;
		}
		if (!this.pending || this.waitingSignal) {
			this.revision++;
			this.pending = true;
			this.waitingSignal = false;
			this.retries = 0;
			this.slowProbe = false;
			this.dueAt = this.clock.now() + 500;
		} else if (
			this.slowProbe &&
			(reason === "visible" ||
				reason === "online" ||
				reason === "focus" ||
				reason === "gap" ||
				reason === "resume")
		) {
			this.wakeDuringAttempt ||= this.running;
			this.clearAttempt();
			this.dueAt = Math.min(this.dueAt, this.clock.now() + 500);
		}
		this.schedule();
		this.publish();
	}

	notifyActivityChanged(): void {
		if (this.disposed) {
			return;
		}
		const wasVisible = this.visible;
		this.refresh();
		if (
			!wasVisible &&
			this.visible &&
			(this.ports.read().mobile ||
				this.clock.now() - this.lastTick >= 30000)
		) {
			this.request("visible");
		}
		this.schedule();
		if (this.enabled && this.visible && this.heartbeat === undefined) {
			this.lastTick = this.clock.now();
			this.heartbeat = this.clock.setTimeout(() => this.tick(), 5000);
		}
		this.publish();
	}

	getPresentation(): MobileRecoveryPresentation | undefined {
		if (!this.pending && !this.manualPromise) {
			return undefined;
		}
		const state = this.ports.read();
		if (this.manualPromise && state.native.writes > 0) {
			return { phase: "waiting-native" };
		}
		if (this.manualPromise && state.cooldownUntil > this.clock.now()) {
			return { phase: "backoff" };
		}
		if (
			state.native.oldestStartedAt !== null &&
			this.clock.now() - state.native.oldestStartedAt >= 60000
		) {
			return { phase: "waiting-native" };
		}
		if (this.retries > 0 && this.dueAt > this.clock.now()) {
			return { phase: "backoff" };
		}
		return undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
		this.stopHeartbeat();
	}

	private refresh(): void {
		const state = this.ports.read();
		if (state.generation !== this.generation || !state.manualAllowed) {
			this.cancel();
		} else if (!state.enabled && this.enabled) {
			this.cancelAutomatic();
		}
		if (!state.visible && this.visible) {
			this.revision++;
			this.clearAttempt();
		}
		this.generation = state.generation;
		this.enabled = state.enabled;
		this.visible = state.visible;
		if (!this.enabled || !this.visible) {
			this.stopHeartbeat();
		}
	}

	private cancel(): void {
		this.cancelAutomatic();
		this.resolveManual?.(null);
		this.resolveManual = null;
		this.manualPromise = null;
	}

	private cancelAutomatic(): void {
		this.epoch++;
		this.pending = false;
		this.waitingSignal = false;
		this.slowProbe = false;
		this.wakeDuringAttempt = false;
		this.retries = 0;
		this.clearAttempt();
	}

	private current(ticket: FullTicket): boolean {
		const state = this.ports.read();
		return (
			!this.disposed &&
			state.enabled &&
			state.generation === this.generation &&
			ticket.epoch === this.epoch &&
			ticket.revision === this.revision
		);
	}

	private tick(): void {
		this.heartbeat = undefined;
		const elapsed = this.clock.now() - this.lastTick;
		if (elapsed >= 30000 || elapsed < 0) {
			this.request("gap");
		}
		this.notifyActivityChanged();
	}

	private schedule(): void {
		if (this.running || this.attemptTimer !== undefined) {
			return;
		}
		const state = this.ports.read();
		if (this.manualPromise) {
			if (!state.busy && state.native.writes === 0) {
				this.attemptTimer = this.clock.setTimeout(
					() => {
						this.attemptTimer = undefined;
						void this.attemptManual();
					},
					Math.max(0, state.cooldownUntil - this.clock.now()),
				);
			}
			return;
		}
		if (
			!this.pending ||
			this.waitingSignal ||
			!this.enabled ||
			!this.visible
		) {
			return;
		}
		if (
			state.busy ||
			state.blocked ||
			state.native.reads + state.native.writes > 0
		) {
			return;
		}
		this.attemptTimer = this.clock.setTimeout(
			() => {
				this.attemptTimer = undefined;
				void this.attempt();
			},
			Math.max(
				0,
				Math.max(this.dueAt, state.cooldownUntil) - this.clock.now(),
			),
		);
	}

	private async attemptManual(): Promise<void> {
		this.refresh();
		const state = this.ports.read();
		const resolve = this.resolveManual;
		if (
			!resolve ||
			!state.manualAllowed ||
			state.busy ||
			state.native.writes > 0 ||
			state.cooldownUntil > this.clock.now()
		) {
			this.schedule();
			return;
		}
		this.running = true;
		let result: SyncResult | null = null;
		try {
			result = await this.ports.runManual();
		} catch {
			result = null;
		} finally {
			if (this.resolveManual === resolve) {
				this.resolveManual = null;
				this.manualPromise = null;
				resolve(result);
			}
			this.running = false;
			this.refresh();
			this.schedule();
			this.publish();
		}
	}

	private async attempt(): Promise<void> {
		this.refresh();
		const state = this.ports.read();
		if (
			this.disposed ||
			!this.enabled ||
			!this.visible ||
			!this.pending ||
			state.blocked ||
			state.busy ||
			state.native.reads + state.native.writes > 0
		) {
			return;
		}
		if (state.cooldownUntil > this.clock.now()) {
			this.schedule();
			return;
		}
		const ticket = this.beginFull();
		this.running = true;
		let outcome: MobileRecoveryOutcome = "blocked";
		try {
			if (this.slowProbe) {
				outcome = await this.ports.probe();
			}
			if (!this.slowProbe || outcome === "success") {
				const admitted = this.ports.read();
				if (
					this.current(ticket) &&
					!this.manualPromise &&
					admitted.manualAllowed &&
					admitted.visible &&
					!admitted.busy &&
					!admitted.blocked &&
					admitted.native.reads + admitted.native.writes === 0 &&
					admitted.cooldownUntil <= this.clock.now()
				) {
					outcome = await this.ports.run();
				} else {
					outcome = "deferred";
				}
			}
		} catch {
			outcome = "blocked";
		} finally {
			this.running = false;
			this.refresh();
			if (this.current(ticket) && this.pending) {
				if (outcome === "success") {
					this.pending = false;
					this.slowProbe = false;
				} else if (
					outcome === "retryable" &&
					this.retries < RETRY_DELAYS.length
				) {
					this.dueAt =
						this.clock.now() + RETRY_DELAYS[this.retries++]!;
				} else if (outcome === "deferred") {
					this.dueAt = this.clock.now() + 500;
				} else if (outcome === "retryable") {
					this.slowProbe = true;
					this.dueAt =
						this.clock.now() +
						(this.wakeDuringAttempt ? 500 : PROBE_DELAY);
				} else {
					this.waitingSignal = true;
				}
			}
			this.wakeDuringAttempt = false;
			this.schedule();
			this.publish();
		}
	}

	private clearAttempt(): void {
		if (this.attemptTimer !== undefined) {
			this.clock.clearTimeout(this.attemptTimer);
			this.attemptTimer = undefined;
		}
	}
	private stopHeartbeat(): void {
		if (this.heartbeat !== undefined) {
			this.clock.clearTimeout(this.heartbeat);
			this.heartbeat = undefined;
		}
	}
	private publish(): void {
		const next = `${this.enabled}:${this.visible}:${this.pending}:${Boolean(this.manualPromise)}:${this.getPresentation()?.phase ?? ""}`;
		if (next !== this.presentation) {
			this.presentation = next;
			this.ports.changed();
		}
	}
}

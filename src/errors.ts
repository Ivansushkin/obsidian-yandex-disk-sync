import { findErrorCause } from "./utils/error-utils";

export type FailureCategory =
	"unavailable" | "access" | "safety" | "local" | "unknown";
export type OperationKind =
	"read" | "write" | "put" | "poll" | "local" | "unknown";
export type RequestState =
	"not-started" | "completed" | "unresolved" | "unknown";
export type FailureOutcome =
	"stopped-before-write" | "partial" | "write-unconfirmed" | "unknown";

export interface RetryProgress {
	stage: string;
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

export interface FailureContext {
	stage: string;
	path?: string;
	action: OperationKind;
	requestState?: RequestState;
	outcome?: FailureOutcome;
	durationMs?: number;
}

const failureContexts = new WeakMap<Error, FailureContext>();

/** Attach known request facts without replacing legacy exception identity. */
export function withFailureContext(
	error: unknown,
	context: FailureContext,
): unknown {
	if (error instanceof Error) {
		failureContexts.set(error, {
			...context,
			...failureContexts.get(error),
		});
	}
	return error;
}

/** Safe, ephemeral projection shared by every status surface. Never persist it. */
export interface FailureSummary extends FailureContext {
	category: FailureCategory;
	code: string;
	message: string;
	httpStatus?: number;
	providerCode?: string;
	causes: string[];
}

/** HTTP identity without implying API resource absence (signed links are separate). */
export class RemoteHttpError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
	) {
		super(message);
		this.name = "RemoteHttpError";
	}
}

export class YandexApiError extends RemoteHttpError {
	constructor(message: string, status: number, code?: string) {
		super(message, status, code);
		this.name = "YandexApiError";
	}
}

/** A native timeout retains its occupancy; only the API transport may replace it. */
export class RemoteReadTimeoutError extends Error {
	constructor(
		timeoutMs: number,
		operation: string,
		readonly requestState: "unresolved" | "not-started" = "unresolved",
	) {
		super(
			timeoutMs > 0
				? `Remote read timed out after ${timeoutMs / 1000}s (${operation})`
				: `Remote read timed out: deadline exhausted (${operation})`,
		);
		this.name = "RemoteReadTimeoutError";
	}
}

/** Revocation is an admission failure, never a retryable native rejection. */
export class RemoteReadInterruptedError extends Error {
	constructor() {
		super(
			"Read invocation interrupted: configuration changed or lifetime ended",
		);
		this.name = "RemoteReadInterruptedError";
	}
}

/** Tag only a rejection from the native transport, never decoding or guards. */
export class NetworkRequestError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super(
			cause instanceof Error ? cause.message : "Network request failed",
		);
		this.name = "NetworkRequestError";
		this.cause = cause;
		Object.defineProperty(this, "cause", { enumerable: false });
	}
}

export function isRemoteReadTimeout(error: unknown): boolean {
	return (
		findErrorCause(
			error,
			(candidate) => candidate instanceof RemoteReadTimeoutError,
		) !== null
	);
}

/** Remove transport URLs and inline secrets before messages reach UI or logs. */
export function sanitizeFailureMessage(value: string): string {
	return value
		.replace(/https?:\/\/[^\s<>"']+/gi, "[remote URL]")
		.replace(
			/(["']?(?:token|authorization|password|secret|access[_-]?token|refresh[_-]?token|encryption[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
			"$1***",
		)
		.replace(
			/(["']?(?:token|authorization|password|secret|access[_-]?token|refresh[_-]?token|encryption[_-]?key)["']?\s*[:=]\s*["']?)(?:Bearer\s+|OAuth\s+)?([^"'\s,;&}]+)/gi,
			"$1***",
		)
		.replace(/\b(Bearer|OAuth)\s+[^\s,;"'}]+/gi, "$1 ***");
}

/** Provider response descriptions are untrusted bodies, not diagnostics. */
export function describeFailureCause(error: Error): string {
	if (error instanceof RemoteHttpError) {
		const code =
			error.code && /^[a-z0-9_-]{1,100}$/i.test(error.code)
				? ` (${error.code})`
				: "";
		return `HTTP ${error.status}${code}`;
	}
	let message = error.message;
	findErrorCause(error, (candidate) => {
		if (
			candidate !== error &&
			candidate instanceof RemoteHttpError &&
			candidate.message
		) {
			message = message
				.split(candidate.message)
				.join(describeFailureCause(candidate));
		}
		return false;
	});
	return sanitizeFailureMessage(message);
}

function transportCategory(
	api: RemoteHttpError | null,
	timeout: boolean,
	network: boolean,
	action: OperationKind,
): FailureCategory {
	if (api?.status === 401 || api?.status === 403) {
		return "access";
	}
	if (
		timeout ||
		network ||
		(api && [423, 429, 500, 502, 503, 504].includes(api.status))
	) {
		return "unavailable";
	}
	return action === "local" ? "local" : "unknown";
}

function transportCode(
	api: RemoteHttpError | null,
	timeout: boolean,
	network: boolean,
): string {
	if (timeout) {
		return "remote-read-timeout";
	}
	if (api) {
		return api.status === 401 || api.status === 403
			? "authentication"
			: "http-error";
	}
	return network ? "network" : "unknown";
}

/** Retain the original exception in memory while exporting only sanitized facts. */
export class OperationFailure extends Error {
	readonly cause: unknown;
	readonly summary: FailureSummary;
	constructor(
		cause: unknown,
		context: FailureContext,
		domain?: { category: FailureCategory; code: string },
	) {
		const contextualCause = findErrorCause(cause, (candidate) =>
			failureContexts.has(candidate),
		);
		const requestContext = contextualCause
			? failureContexts.get(contextualCause)
			: undefined;
		const inherited =
			cause instanceof OperationFailure ? cause.summary : undefined;
		const api = findErrorCause(
			cause,
			(candidate): candidate is RemoteHttpError =>
				candidate instanceof RemoteHttpError,
		);
		const timeout = isRemoteReadTimeout(cause);
		const network = findErrorCause(
			cause,
			(candidate) => candidate instanceof NetworkRequestError,
		);
		const category =
			domain?.category ??
			inherited?.category ??
			transportCategory(api, timeout, Boolean(network), context.action);
		const message =
			inherited?.message ??
			(cause instanceof Error
				? describeFailureCause(cause)
				: "Unknown operation failure");
		super(message);
		this.name = "OperationFailure";
		this.cause = cause;
		Object.defineProperty(this, "cause", { enumerable: false });
		const causes: string[] = [];
		findErrorCause(cause, (candidate) => {
			causes.push(
				sanitizeFailureMessage(
					`${candidate.name}: ${describeFailureCause(candidate)}`,
				),
			);
			return false;
		});
		this.summary = {
			...inherited,
			...context,
			...requestContext,
			outcome:
				context.outcome && context.outcome !== "unknown"
					? context.outcome
					: (inherited?.outcome ??
						requestContext?.outcome ??
						context.outcome),
			stage: sanitizeFailureMessage(
				inherited?.stage ?? requestContext?.stage ?? context.stage,
			),
			action:
				inherited?.action ?? requestContext?.action ?? context.action,
			path: context.path
				? sanitizeFailureMessage(context.path)
				: inherited?.path,
			requestState: timeout
				? (findErrorCause(
						cause,
						(candidate): candidate is RemoteReadTimeoutError =>
							candidate instanceof RemoteReadTimeoutError,
					)?.requestState ?? "unresolved")
				: (inherited?.requestState ??
					requestContext?.requestState ??
					(api || network
						? "completed"
						: (context.requestState ?? "unknown"))),
			category,
			code:
				domain?.code ??
				inherited?.code ??
				transportCode(api, timeout, Boolean(network)),
			message,
			httpStatus: api?.status ?? inherited?.httpStatus,
			providerCode:
				api?.code && /^[a-z0-9_-]{1,100}$/i.test(api.code)
					? api.code
					: inherited?.providerCode,
			causes: inherited?.causes ?? causes,
		};
	}
}

/** Decide admissibility only; the owning workflow keeps attempts, deadlines and recovery. */
export function decideRecovery(
	failure: OperationFailure,
	budget: { attemptsRemaining: number; remainingMs: number },
): { retry: boolean; confirm: boolean } {
	const { category, action, requestState, httpStatus } = failure.summary;
	if (
		category === "safety" ||
		category === "access" ||
		requestState === "unresolved" ||
		requestState === "not-started"
	) {
		return { retry: false, confirm: false };
	}
	const network =
		findErrorCause(
			failure,
			(candidate) => candidate instanceof NetworkRequestError,
		) !== null;
	const statuses =
		action === "read"
			? [423, 429, 500, 502, 503, 504]
			: action === "poll"
				? [409, 423, 429, 503]
				: [423, 429, 503];
	const transient =
		httpStatus !== undefined
			? statuses.includes(httpStatus)
			: network && action !== "poll";
	return {
		retry:
			transient && budget.attemptsRemaining > 0 && budget.remainingMs > 0,
		confirm: transient && action === "put",
	};
}

import { EncryptionService } from "../crypto/encryption";
import type {
	AuthenticationUpdate,
	OAuthAuthorization,
} from "./authentication-state";
import { logger } from "../utils/logger";

export type AuthorizationFailure =
	| "unavailable"
	| "revoked"
	| "expired"
	| "denied"
	| "invalid-code"
	| "permissions"
	| "network"
	| "timeout"
	| "invalid-response"
	| "storage"
	| "sync"
	| "root-mismatch"
	| "root-unavailable";

/** Carry only a fixed public failure category, never provider bodies or native error details. */
export class AuthorizationError extends Error {
	constructor(readonly code: AuthorizationFailure) {
		super(`Authorization ${code}`);
		this.name = "AuthorizationError";
	}
}

export type AuthorizationPhase =
	| "idle"
	| "preparing"
	| "waiting-browser"
	| "exchanging"
	| "waiting-idle"
	| "checking-root"
	| "committing"
	| "connected"
	| "error";
export interface AuthorizationState {
	phase: AuthorizationPhase;
	failure?: AuthorizationFailure;
}
export interface OAuthResponse {
	status: number;
	json: unknown;
}
export type RefreshDecision =
	| "fresh"
	| "refreshed"
	| "temporary"
	| "cooldown"
	| "reauthorize"
	| "revoked"
	| { kind: "failed"; reason: AuthorizationFailure };
export interface AuthorizationAttempt {
	assertCurrent(): void;
	accept(): void;
	phase(phase: "waiting-idle" | "checking-root"): void;
}
interface Options {
	clientId: string;
	clientSecret: string;
	vaultName(): string;
	deviceId(): string;
	request(body: URLSearchParams): Promise<OAuthResponse>;
	captureContext(): {
		assertCurrent: () => void;
	};
	adopt(
		update: AuthenticationUpdate,
		attempt: AuthorizationAttempt,
	): Promise<void>;
	now?: () => number;
	requestTimeoutMs?: number;
}
interface PendingAttempt {
	state: string;
	verifier: string;
	deviceId: string;
	deadline: number;
	assertContext(): void;
	accepted: boolean;
	waiters: Set<(error: AuthorizationError) => void>;
	timer?: ReturnType<typeof setTimeout>;
}

/** Own one memory-only PKCE attempt while the host retains storage and synchronization ownership. */
export class YandexAuthorization {
	private pending: PendingAttempt | null = null;
	private native: Promise<void> | null = null;
	private nativeStartedAt: number | null = null;
	private readonly nativeListeners = new Set<() => void>();
	private refreshing: Promise<void> | null = null;
	private refreshDeniedGrant: string | null = null;
	private refreshRetryAt = 0;
	private disposed = false;
	private state: AuthorizationState = { phase: "idle" };
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	constructor(private readonly options: Options) {
		this.now = options.now ?? Date.now;
	}

	getState(): AuthorizationState {
		return { ...this.state };
	}
	getRefreshRetryAt(): number {
		return this.refreshRetryAt;
	}
	getNativeStartedAt(): number | null {
		return this.nativeStartedAt;
	}
	onNativeActivityChange(listener: () => void): () => void {
		this.nativeListeners.add(listener);
		return () => this.nativeListeners.delete(listener);
	}
	get available(): boolean {
		return this.options.clientId.trim().length > 0;
	}

	needsRefresh(authorization: OAuthAuthorization, force: boolean): boolean {
		return (
			force ||
			this.refreshDeniedGrant === authorization.grantId ||
			(authorization.expiresAt !== null &&
				authorization.expiresAt <= this.now() + 300_000)
		);
	}

	/** Decide whether one grant needs renewal without looping on provider failures. */
	async ensureFresh(
		current: { token: string; authorization: OAuthAuthorization },
		force: boolean,
		assertCurrent: () => void,
		adopt: (
			update: AuthenticationUpdate,
			assertCurrent: () => void,
		) => Promise<void>,
	): Promise<RefreshDecision> {
		if (this.refreshDeniedGrant === current.authorization.grantId) {
			return "reauthorize";
		}
		if (!this.needsRefresh(current.authorization, force)) {
			return "fresh";
		}
		if (this.now() < this.refreshRetryAt) {
			return "cooldown";
		}
		try {
			await this.refresh(current, assertCurrent, adopt);
			this.refreshRetryAt = 0;
			this.refreshDeniedGrant = null;
			return "refreshed";
		} catch (error) {
			if (
				error instanceof AuthorizationError &&
				(error.code === "expired" || error.code === "permissions")
			) {
				this.refreshDeniedGrant = current.authorization.grantId;
				return "reauthorize";
			}
			if (
				error instanceof AuthorizationError &&
				error.code === "revoked"
			) {
				return "revoked";
			}
			if (
				!(error instanceof AuthorizationError) ||
				(error.code !== "network" && error.code !== "timeout")
			) {
				return {
					kind: "failed",
					reason:
						error instanceof AuthorizationError
							? error.code
							: "storage",
				};
			}
			this.refreshRetryAt = this.now() + 30_000;
			return "temporary";
		}
	}

	resetRefreshState(): void {
		this.refreshDeniedGrant = null;
		this.refreshRetryAt = 0;
	}

	/** Coalesce refresh requests and publish only a still-current grant. */
	refresh(
		current: { token: string; authorization: OAuthAuthorization },
		assertCurrent: () => void,
		adopt: (
			update: AuthenticationUpdate,
			assertCurrent: () => void,
		) => Promise<void>,
	): Promise<void> {
		if (this.refreshing) {
			return this.refreshing;
		}
		const work = this.refreshOnce(current, assertCurrent, adopt);
		this.refreshing = work;
		void work.then(
			() => {
				if (this.refreshing === work) {
					this.refreshing = null;
				}
			},
			() => {
				if (this.refreshing === work) {
					this.refreshing = null;
				}
			},
		);
		return work;
	}

	private async refreshOnce(
		current: { token: string; authorization: OAuthAuthorization },
		assertCurrent: () => void,
		adopt: (
			update: AuthenticationUpdate,
			assertCurrent: () => void,
		) => Promise<void>,
	): Promise<void> {
		if (
			this.disposed ||
			this.pending ||
			!this.options.clientSecret ||
			!current.authorization.refreshToken
		) {
			throw new AuthorizationError("unavailable");
		}
		if (current.authorization.clientId !== this.options.clientId) {
			throw new AuthorizationError("expired");
		}
		assertCurrent();
		if (this.native) {
			let waitTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.native,
					new Promise<never>((_, reject) => {
						waitTimer = setTimeout(
							() => reject(new AuthorizationError("timeout")),
							this.options.requestTimeoutMs ?? 30_000,
						);
					}),
				]);
			} finally {
				clearTimeout(waitTimer);
			}
		}
		assertCurrent();
		if (this.disposed || this.pending) {
			throw new AuthorizationError("revoked");
		}
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: current.authorization.refreshToken,
			client_id: this.options.clientId,
			client_secret: this.options.clientSecret,
		});
		const request = Promise.resolve().then(() => {
			assertCurrent();
			if (this.disposed || this.pending) {
				throw new AuthorizationError("revoked");
			}
			return this.options.request(body);
		});
		this.trackNative(request);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let response: OAuthResponse;
		try {
			response = await Promise.race([
				request,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new AuthorizationError("timeout")),
						this.options.requestTimeoutMs ?? 30_000,
					);
				}),
			]);
		} catch (error) {
			if (error instanceof AuthorizationError) {
				throw error;
			}
			throw new AuthorizationError("network");
		} finally {
			clearTimeout(timer);
		}
		assertCurrent();
		const update = this.parseResponse(response, current.authorization);
		await adopt(update, assertCurrent);
	}
	get blocksOperations(): boolean {
		return this.pending !== null;
	}
	get canCancel(): boolean {
		return this.pending !== null && !this.pending.accepted;
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Create fresh proof material before opening the external consent page. */
	async begin(): Promise<string> {
		if (!this.available) {
			throw new AuthorizationError("unavailable");
		}
		if (this.disposed || this.pending?.accepted) {
			throw new AuthorizationError("revoked");
		}
		this.cancel();
		const context = this.options.captureContext();
		const attempt: PendingAttempt = {
			state: randomString(),
			verifier: randomString(),
			deviceId: "",
			deadline: this.now() + 600_000,
			assertContext: context.assertCurrent,
			accepted: false,
			waiters: new Set(),
		};
		this.pending = attempt;
		this.update({ phase: "preparing" });
		attempt.timer = setTimeout(
			() => this.retire(attempt, "expired"),
			600_000,
		);
		try {
			const challenge = await digest(attempt.verifier);
			attempt.deviceId = `oyds-${await digest(this.options.deviceId())}`;
			this.assertAttempt(attempt);
			const redirect = `obsidian://yandex-disk-sync-auth?vault=${encodeURIComponent(this.options.vaultName())}`;
			const query = new URLSearchParams({
				response_type: "code",
				client_id: this.options.clientId,
				redirect_uri: redirect,
				state: attempt.state,
				code_challenge: challenge,
				code_challenge_method: "S256",
				force_confirm: "yes",
				scope: "cloud_api:disk.read cloud_api:disk.write",
				device_id: attempt.deviceId,
				device_name: "Obsidian Yandex Disk Sync",
			});
			this.update({ phase: "waiting-browser" });
			return `https://oauth.yandex.ru/authorize?${query}`;
		} catch (error) {
			throw this.fail(attempt, error);
		}
	}

	/** Foreign and replayed links cannot retire the currently valid attempt. */
	async acceptCallback(params: Record<string, string>): Promise<boolean> {
		const attempt = this.pending;
		if (
			!attempt ||
			this.state.phase !== "waiting-browser" ||
			params.state !== attempt.state
		) {
			return false;
		}
		if (params.error) {
			this.retire(attempt, "denied");
			throw new AuthorizationError("denied");
		}
		await this.exchange(attempt, params.code ?? "");
		return true;
	}

	cancel(): void {
		if (this.pending?.accepted) {
			return;
		}
		if (this.pending) {
			this.retire(this.pending, "revoked");
		}
		this.update({ phase: "idle" });
	}

	dispose(): void {
		this.disposed = true;
		if (this.pending) {
			this.retire(this.pending, "revoked");
		}
		this.listeners.clear();
	}

	private async exchange(
		attempt: PendingAttempt,
		code: string,
	): Promise<void> {
		if (typeof code !== "string" || !code.trim() || code.length > 4096) {
			throw new AuthorizationError("invalid-code");
		}
		this.assertAttempt(attempt);
		this.update({ phase: "exchanging" });
		try {
			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code: code.trim(),
				client_id: this.options.clientId,
				code_verifier: attempt.verifier,
				device_id: attempt.deviceId,
				device_name: "Obsidian Yandex Disk Sync",
			});
			const response = await this.post(body, attempt);
			const candidate = this.parseResponse(response);
			this.assertAttempt(attempt);
			await this.options.adopt(candidate, {
				assertCurrent: () => this.assertAttempt(attempt),
				accept: () => {
					this.assertAttempt(attempt);
					attempt.accepted = true;
					clearTimeout(attempt.timer);
					attempt.verifier = "";
					this.update({ phase: "committing" });
				},
				phase: (phase) => {
					this.assertAttempt(attempt);
					this.update({ ...this.state, phase });
				},
			});
			this.assertAttempt(attempt);
			this.finish(attempt);
			this.update({ phase: "connected" });
		} catch (error) {
			throw this.fail(attempt, error);
		}
	}

	/** Keep native token requests serialized even after a logical timeout. */
	private async post(
		body: URLSearchParams,
		attempt: PendingAttempt,
	): Promise<OAuthResponse> {
		if (this.native) {
			await this.wait(this.native, attempt);
		}
		this.assertAttempt(attempt);
		const request = Promise.resolve().then(() => {
			this.assertAttempt(attempt);
			return this.options.request(body);
		});
		this.trackNative(request);
		return this.wait(request, attempt);
	}

	/** Observe native POST until actual settlement, including after caller timeout. */
	private trackNative(request: Promise<OAuthResponse>): void {
		const native = request.then(
			() => undefined,
			() => undefined,
		);
		this.native = native;
		this.nativeStartedAt = this.now();
		this.notifyNativeActivity();
		void native.then(() => {
			if (this.native === native) {
				this.native = null;
				this.nativeStartedAt = null;
				this.notifyNativeActivity();
			}
		});
	}

	private notifyNativeActivity(): void {
		for (const listener of this.nativeListeners) {
			try {
				listener();
			} catch {
				logger.warn("Authorization native activity observer failed");
			}
		}
	}

	private parseResponse(
		response: OAuthResponse,
		prior?: OAuthAuthorization,
	): AuthenticationUpdate {
		const data =
			response.json &&
			typeof response.json === "object" &&
			!Array.isArray(response.json)
				? (response.json as Record<string, unknown>)
				: {};
		if (response.status !== 200) {
			if (prior) {
				throw new AuthorizationError(
					response.status >= 400 &&
						response.status < 500 &&
						response.status !== 429
						? "expired"
						: "network",
				);
			}
			throw new AuthorizationError(
				data.error === "invalid_grant" ||
					data.error === "bad_verification_code"
					? "invalid-code"
					: data.error === "access_denied"
						? "denied"
						: "network",
			);
		}
		if (
			typeof data.access_token !== "string" ||
			!data.access_token.trim() ||
			data.token_type !== "bearer"
		) {
			throw new AuthorizationError("invalid-response");
		}
		if (
			data.scope !== undefined &&
			(typeof data.scope !== "string" ||
				!["cloud_api:disk.read", "cloud_api:disk.write"].every(
					(scope) =>
						(data.scope as string).split(/\s+/).includes(scope),
				))
		) {
			throw new AuthorizationError("permissions");
		}
		if (
			prior &&
			(typeof data.refresh_token !== "string" ||
				!data.refresh_token.trim() ||
				data.expires_in === undefined)
		) {
			throw new AuthorizationError("invalid-response");
		}
		let expiresAt: number | null = null;
		if (data.expires_in !== undefined) {
			if (
				typeof data.expires_in !== "number" ||
				!Number.isSafeInteger(data.expires_in) ||
				data.expires_in <= 0 ||
				!Number.isSafeInteger(this.now() + data.expires_in * 1000)
			) {
				throw new AuthorizationError("invalid-response");
			}
			expiresAt = this.now() + data.expires_in * 1000;
		}
		return {
			kind: prior ? "refresh" : "interactive",
			token: data.access_token,
			authorization: {
				clientId: this.options.clientId,
				grantId: prior?.grantId ?? randomString(),
				refreshToken:
					typeof data.refresh_token === "string" &&
					data.refresh_token.trim()
						? data.refresh_token
						: null,
				expiresAt,
			},
		};
	}

	/** Logical timeouts retain native ownership until the actual request settles. */
	private wait<T>(promise: Promise<T>, attempt: PendingAttempt): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const done = (error?: AuthorizationError, value?: T) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				attempt.waiters.delete(cancel);
				if (error) {
					reject(error);
				} else {
					resolve(value as T);
				}
			};
			const cancel = (error: AuthorizationError) => done(error);
			const timer = setTimeout(
				() => done(new AuthorizationError("timeout")),
				this.options.requestTimeoutMs ?? 30_000,
			);
			attempt.waiters.add(cancel);
			void promise.then(
				(value) => {
					try {
						this.assertAttempt(attempt);
						done(undefined, value);
					} catch {
						done(new AuthorizationError("revoked"));
					}
				},
				() => done(new AuthorizationError("network")),
			);
		});
	}

	private assertAttempt(attempt: PendingAttempt): void {
		if (this.disposed || this.pending !== attempt) {
			throw new AuthorizationError("revoked");
		}
		if (!attempt.accepted) {
			if (this.now() >= attempt.deadline) {
				throw new AuthorizationError("expired");
			}
			try {
				attempt.assertContext();
			} catch {
				throw new AuthorizationError("revoked");
			}
		}
	}

	private finish(attempt: PendingAttempt): void {
		clearTimeout(attempt.timer);
		attempt.verifier = "";
		if (this.pending === attempt) {
			this.pending = null;
		}
	}

	private retire(attempt: PendingAttempt, code: AuthorizationFailure): void {
		if (attempt.accepted && code === "expired") {
			return;
		}
		for (const reject of attempt.waiters) {
			reject(new AuthorizationError(code));
		}
		this.finish(attempt);
		this.update({ phase: "error", failure: code });
	}

	private fail(attempt: PendingAttempt, error: unknown): AuthorizationError {
		const failure =
			error instanceof AuthorizationError
				? error
				: new AuthorizationError("storage");
		if (this.pending === attempt) {
			this.retire(attempt, failure.code);
		}
		return failure;
	}

	private update(state: AuthorizationState): void {
		this.state = state;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				/* Presentation cannot revoke an accepted credential operation. */
			}
		}
	}
}

function randomString(): string {
	return EncryptionService.base64UrlEncode(
		crypto.getRandomValues(new Uint8Array(32)),
	);
}

async function digest(value: string): Promise<string> {
	return EncryptionService.base64UrlEncode(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(value),
			),
		),
	);
}

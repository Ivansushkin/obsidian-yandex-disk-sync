/**
 * Logger for Yandex Disk Sync plugin.
 *
 * Supports console and file output, configurable log levels, log rotation,
 * and automatic sanitization of sensitive values (tokens, passwords).
 */

import type { App } from "obsidian";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PREFIX = "[YandexSync]";
export const DEFAULT_LOG_RELATIVE_PATH =
	"plugins/yandex-disk-sync/debug.log";
export const DEFAULT_MAX_LOG_SIZE = 5 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const SENSITIVE_KEYS = [
	"token",
	"authorization",
	"password",
	"yandextokensecret",
	"encryptionpassword",
	"encryptionkey",
	"keymaterial",
	"key",
	"secret",
	"accesstoken",
	"refreshtoken",
];
const SAFE_DIAGNOSTIC_KEYS = new Set([
	"code",
	"name",
	"deviceid",
	"epoch",
	"expectedepoch",
	"actualepoch",
	"sessionid",
	"sessionkind",
	"indextransactionid",
	"lockname",
	"transitionid",
	"kind",
	"phase",
	"outcome",
	"failedstage",
	"remotefingerprint",
	"canonicalfingerprint",
	"lockfingerprint",
	"expectedfingerprint",
	"actualfingerprint",
	"restoredfingerprint",
]);

export interface LoggerConfig {
	app?: App;
	minLevel?: LogLevel;
	consoleEnabled?: boolean;
	fileEnabled?: boolean;
	logFilePath?: string;
	maxFileSize?: number;
	baseContext?: Record<string, unknown>;
	contextProvider?: () => Record<string, unknown> | undefined;
}

/**
 * Format a timestamp for log entries.
 */
function formatTimestamp(date: Date): string {
	return date.toISOString();
}

/**
 * Mask a string value, keeping a short prefix and suffix.
 */
function maskString(value: string): string {
	if (value.length <= 8) {
		return "***";
	}
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Shorten a non-secret diagnostic identifier while keeping it recognizable
 * across related log entries.
 */
export function shortenDiagnosticValue(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	if (value.length <= 16) return value;
	return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

/**
 * Heuristic check for values that look like secret tokens.
 */
function looksLikeToken(value: string): boolean {
	// Long base64-ish or random token strings
	return value.length > 30 && /^[A-Za-z0-9_.\-/+=]+$/.test(value);
}

/**
 * Redact common inline credential forms that may appear inside error messages
 * or stack traces where there is no enclosing object key to inspect.
 */
function sanitizeString(value: string): string {
	const assignment =
		/(["']?(?:token|authorization|password|secret|access[_-]?token|refresh[_-]?token|encryption[_-]?key)["']?\s*[:=]\s*["']?)(?:Bearer\s+|OAuth\s+)?([^"'\s,;&}]+)/gi;
	return value
		.replace(assignment, "$1***")
		.replace(
			/\b(Bearer|OAuth)\s+[A-Za-z0-9_.\-/+=]{12,}/gi,
			"$1 ***",
		);
}

/**
 * Recursively sanitize context data to avoid leaking secrets.
 */
function sanitizeContext(
	context: unknown,
	parentKey?: string,
): unknown {
	if (context === null || context === undefined) {
		return context;
	}

	if (typeof context === "string") {
		if (
			!SAFE_DIAGNOSTIC_KEYS.has(parentKey ?? "") &&
			looksLikeToken(context)
		) {
			return maskString(context);
		}
		return sanitizeString(context);
	}

	if (typeof context === "number" || typeof context === "boolean") {
		return context;
	}

	if (Array.isArray(context)) {
		return context.map((item) => sanitizeContext(item));
	}

	if (typeof context === "object") {
		// Error and DOMException have non-enumerable properties that
		// Object.entries() misses, producing "{}" in logs. Extract the
		// useful fields explicitly so diagnostics show the actual error.
		if (context instanceof Error) {
			const result: Record<string, unknown> = {
				name: context.name,
				message: sanitizeString(context.message),
			};
			if (context.stack) {
				result.stack = sanitizeString(context.stack);
			}
			const code = (context as { code?: unknown }).code;
			if (code !== undefined) {
				result.code = code;
			}
			return result;
		}
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			context as Record<string, unknown>,
		)) {
			const lowerKey = key.toLowerCase();
			if (
				SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive))
			) {
				result[key] =
					typeof value === "string" ? maskString(value) : "***";
			} else {
				result[key] = sanitizeContext(value, lowerKey);
			}
		}
		return result;
	}

	try {
		return JSON.stringify(context);
	} catch {
		return "[unserializable value]";
	}
}

/**
 * Plugin logger with console and optional file output.
 */
export class Logger {
	private app: App | null = null;
	private minLevel: LogLevel = "info";
	private consoleEnabled = true;
	private fileEnabled = false;
	private logFilePath = DEFAULT_LOG_RELATIVE_PATH;
	private maxFileSize = DEFAULT_MAX_LOG_SIZE;
	private baseContext: Record<string, unknown> = {};
	private contextProvider:
		| (() => Record<string, unknown> | undefined)
		| null = null;

	private buffer: string[] = [];
	private flushTimeout: ReturnType<typeof setTimeout> | null = null;
	private flushChain: Promise<void> = Promise.resolve();

	/**
	 * Resolve the final log file path inside the vault's config directory.
	 */
	private getResolvedLogPath(): string {
		if (!this.app) {
			return this.logFilePath;
		}
		const configDir = this.app.vault.configDir;
		return `${configDir}/${this.logFilePath}`;
	}

	/**
	 * Configure the logger. Can be called multiple times to update settings.
	 */
	configure(config: LoggerConfig): void {
		if (config.app !== undefined) {
			this.app = config.app;
		}
		if (config.minLevel !== undefined) {
			this.minLevel = config.minLevel;
		}
		if (config.consoleEnabled !== undefined) {
			this.consoleEnabled = config.consoleEnabled;
		}
		if (config.fileEnabled !== undefined) {
			this.fileEnabled = config.fileEnabled;
		}
		if (config.logFilePath !== undefined) {
			this.logFilePath = config.logFilePath;
		}
		if (config.maxFileSize !== undefined) {
			this.maxFileSize = config.maxFileSize;
		}
		if (config.baseContext !== undefined) {
			this.baseContext = { ...config.baseContext };
		}
		if (config.contextProvider !== undefined) {
			this.contextProvider = config.contextProvider;
		}
	}

	setMinLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	setFileEnabled(enabled: boolean): void {
		this.fileEnabled = enabled;
	}

	/**
	 * Check whether a message at the given level should be emitted.
	 */
	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
	}

	/**
	 * Format a single log entry as a string.
	 */
	private formatEntry(
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
	): string {
		const timestamp = formatTimestamp(new Date());
		let entry = `${timestamp} [${level.toUpperCase()}] ${LOG_PREFIX} ${message}`;
		let dynamicContext: Record<string, unknown> = {};
		try {
			dynamicContext = this.contextProvider?.() ?? {};
		} catch (error) {
			dynamicContext = {
				contextProviderError:
					error instanceof Error ? error.message : String(error),
			};
		}
		const mergedContext = {
			...this.baseContext,
			...dynamicContext,
			...context,
		};
		if (Object.keys(mergedContext).length > 0) {
			const sanitized = sanitizeContext(mergedContext);
			const json = JSON.stringify(sanitized, null, 2);
			entry += "\n  " + json.replace(/\n/g, "\n  ");
		}
		return entry;
	}

	/**
	 * Core logging method.
	 */
	private log(
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
	): void {
		if (!this.shouldLog(level)) {
			return;
		}

		const entry = this.formatEntry(level, message, context);

		if (this.consoleEnabled) {
			switch (level) {
				case "debug":
				case "info":
					console.debug(entry);
					break;
				case "warn":
					console.warn(entry);
					break;
				case "error":
					console.error(entry);
					break;
			}
		}

		if (this.fileEnabled && this.app) {
			this.buffer.push(entry);
			this.scheduleFlush();
		}
	}

	/**
	 * Schedule an asynchronous flush of buffered entries.
	 */
	private scheduleFlush(): void {
		if (this.flushTimeout !== null) {
			return;
		}
		this.flushTimeout = globalThis.setTimeout(() => {
			void this.flush();
		}, FLUSH_DELAY_MS);
	}

	/**
	 * Flush buffered entries to the log file.
	 */
	async flush(): Promise<void> {
		if (this.flushTimeout !== null) {
			globalThis.clearTimeout(this.flushTimeout);
			this.flushTimeout = null;
		}
		this.flushChain = this.flushChain.then(
			async () => await this.flushBufferedEntries(),
			async () => await this.flushBufferedEntries(),
		);
		await this.flushChain;
	}

	/**
	 * Serialize file writes so overlapping timers cannot overwrite newer
	 * diagnostic entries with an older read-modify-write snapshot.
	 */
	private async flushBufferedEntries(): Promise<void> {
		if (!this.app) return;
		const adapter = this.app.vault.adapter;
		const logPath = this.getResolvedLogPath();

		while (this.buffer.length > 0) {
			const entries = this.buffer.splice(0, this.buffer.length);
			const content = entries.join("\n") + "\n";
			try {
				const exists = await adapter.exists(logPath);
				if (!exists) {
					await this.ensureDirectory(logPath);
					await adapter.write(logPath, this.trimLog(content));
					continue;
				}
				const stat = await adapter.stat(logPath);
				const contentSize = new TextEncoder().encode(content).byteLength;
				if (
					stat &&
					stat.size + contentSize <= this.maxFileSize
				) {
					await adapter.append(logPath, content);
					continue;
				}
				const existing = await adapter.read(logPath);
				await adapter.write(
					logPath,
					this.trimLog(existing + content),
				);
			} catch (e) {
				this.buffer.unshift(...entries);
				console.error(`${LOG_PREFIX} Failed to write log file:`, e);
				return;
			}
		}
	}

	/**
	 * Ensure the parent directory for the log file exists.
	 */
	private async ensureDirectory(filePath: string): Promise<void> {
		if (!this.app) {
			return;
		}
		const parts = filePath.split("/");
		parts.pop();
		const dir = parts.join("/");
		if (!dir) {
			return;
		}
		const exists = await this.app.vault.adapter.exists(dir);
		if (!exists) {
			await this.app.vault.createFolder(dir);
		}
	}

	/**
	 * Trim the log file to the configured maximum size, keeping the most recent entries.
	 */
	private trimLog(content: string): string {
		const encoded = new TextEncoder().encode(content);
		if (encoded.byteLength <= this.maxFileSize) {
			return content;
		}
		const slice = new TextDecoder().decode(
			encoded.slice(encoded.byteLength - this.maxFileSize),
		);
		const lineBreak = slice.indexOf("\n");
		if (lineBreak === -1) {
			return slice;
		}
		return slice.slice(lineBreak + 1);
	}

	/**
	 * Read the current log file contents.
	 */
	async getLogContents(): Promise<string> {
		await this.flush();
		if (!this.app) {
			return "";
		}
		const adapter = this.app.vault.adapter;
		const logPath = this.getResolvedLogPath();
		try {
			const exists = await adapter.exists(logPath);
			if (exists) {
				return await adapter.read(logPath);
			}
		} catch (e) {
			console.error(`${LOG_PREFIX} Failed to read log file:`, e);
		}
		return "";
	}

	/**
	 * Clear the log file and buffer.
	 */
	async clearLogs(): Promise<void> {
		this.buffer = [];
		if (this.flushTimeout !== null) {
			globalThis.clearTimeout(this.flushTimeout);
			this.flushTimeout = null;
		}
		if (!this.app) {
			return;
		}
		this.flushChain = this.flushChain.then(async () => {
			if (!this.app) return;
			const adapter = this.app.vault.adapter;
			const logPath = this.getResolvedLogPath();
			try {
				const exists = await adapter.exists(logPath);
				if (exists) {
					await adapter.write(logPath, "");
				}
			} catch (e) {
				console.error(`${LOG_PREFIX} Failed to clear log file:`, e);
			}
		});
		await this.flushChain;
	}

	debug(message: string, context?: Record<string, unknown>): void {
		this.log("debug", message, context);
	}

	info(message: string, context?: Record<string, unknown>): void {
		this.log("info", message, context);
	}

	warn(message: string, context?: Record<string, unknown>): void {
		this.log("warn", message, context);
	}

	error(message: string, context?: Record<string, unknown>): void {
		this.log("error", message, context);
	}
}

export const logger = new Logger();

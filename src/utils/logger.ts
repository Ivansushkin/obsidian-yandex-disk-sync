/**
 * Logger for Yandex Disk Sync plugin.
 *
 * Supports console and file output, configurable log levels, log rotation,
 * and automatic sanitization of sensitive values (tokens, passwords).
 */

import type { App } from "obsidian";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PREFIX = "[YandexSync]";
const DEFAULT_LOG_RELATIVE_PATH = "yandex-disk-sync/debug.log";
const DEFAULT_MAX_LOG_SIZE = 1024 * 1024; // 1 MB
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
	"accesstoken",
	"refreshtoken",
];

export interface LoggerConfig {
	app?: App;
	minLevel?: LogLevel;
	consoleEnabled?: boolean;
	fileEnabled?: boolean;
	logFilePath?: string;
	maxFileSize?: number;
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
 * Heuristic check for values that look like secret tokens.
 */
function looksLikeToken(value: string): boolean {
	// Long base64-ish or random token strings
	return value.length > 30 && /^[A-Za-z0-9_.\-/+=]+$/.test(value);
}

/**
 * Recursively sanitize context data to avoid leaking secrets.
 */
function sanitizeContext(context: unknown): unknown {
	if (context === null || context === undefined) {
		return context;
	}

	if (typeof context === "string") {
		if (looksLikeToken(context)) {
			return maskString(context);
		}
		return context;
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
				message: context.message,
			};
			if (context.stack) {
				result.stack = context.stack;
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
				result[key] = sanitizeContext(value);
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
class Logger {
	private app: App | null = null;
	private minLevel: LogLevel = "info";
	private consoleEnabled = true;
	private fileEnabled = false;
	private logFilePath = DEFAULT_LOG_RELATIVE_PATH;
	private maxFileSize = DEFAULT_MAX_LOG_SIZE;

	private buffer: string[] = [];
	private flushTimeout: number | null = null;

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
		if (context && Object.keys(context).length > 0) {
			const sanitized = sanitizeContext(context);
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
		this.flushTimeout = window.setTimeout(() => {
			void this.flush();
		}, FLUSH_DELAY_MS);
	}

	/**
	 * Flush buffered entries to the log file.
	 */
	private async flush(): Promise<void> {
		this.flushTimeout = null;
		if (this.buffer.length === 0 || !this.app) {
			return;
		}

		const entries = this.buffer.splice(0, this.buffer.length);
		const content = entries.join("\n") + "\n";
		const adapter = this.app.vault.adapter;
		const logPath = this.getResolvedLogPath();

		try {
			const exists = await adapter.exists(logPath);
			if (exists) {
				const existing = await adapter.read(logPath);
				const trimmed = this.trimLog(existing);
				await adapter.write(logPath, trimmed + content);
			} else {
				await this.ensureDirectory(logPath);
				await adapter.write(logPath, content);
			}
		} catch (e) {
			console.error(`${LOG_PREFIX} Failed to write log file:`, e);
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
		if (content.length <= this.maxFileSize) {
			return content;
		}
		// Try to trim at a line boundary.
		const slice = content.slice(-this.maxFileSize);
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
			window.clearTimeout(this.flushTimeout);
			this.flushTimeout = null;
		}
		if (!this.app) {
			return;
		}
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

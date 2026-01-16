/**
 * Logger for synchronization plugin
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PREFIX = "[YandexSync]";

class Logger {
	private enabled = true;
	private minLevel: LogLevel = "info";

	private readonly levelPriority: Record<LogLevel, number> = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
	};

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setMinLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	private shouldLog(level: LogLevel): boolean {
		return (
			this.enabled &&
			this.levelPriority[level] >= this.levelPriority[this.minLevel]
		);
	}

	debug(message: string, ...args: unknown[]): void {
		if (this.shouldLog("debug")) {
			console.debug(`${LOG_PREFIX} [DEBUG]`, message, ...args);
		}
	}

	info(message: string, ...args: unknown[]): void {
		if (this.shouldLog("info")) {
			console.debug(`${LOG_PREFIX} [INFO]`, message, ...args);
		}
	}

	warn(message: string, ...args: unknown[]): void {
		if (this.shouldLog("warn")) {
			console.warn(`${LOG_PREFIX} [WARN]`, message, ...args);
		}
	}

	error(message: string, ...args: unknown[]): void {
		if (this.shouldLog("error")) {
			console.error(`${LOG_PREFIX} [ERROR]`, message, ...args);
		}
	}
}

export const logger = new Logger();

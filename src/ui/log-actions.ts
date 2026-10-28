import { type App, Notice } from "obsidian";
import { logger } from "../utils/logger";
import { t } from "../i18n";
import { createSyncFailure, formatOperationFailure } from "../sync/errors";
import { DecisionModal } from "./decision-modal";

export const LOG_COPY_LIMIT = 4000;

/** Request native opening of the existing log without claiming OS-level success. */
export async function openLogFile(
	app: App,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	if (!isCurrent()) {
		return;
	}
	try {
		await logger.flush();
		if (!isCurrent()) {
			return;
		}
		const path = logger.getLogFilePath();
		const exists = await app.vault.adapter.exists(path);
		if (!isCurrent()) {
			return;
		}
		if (!exists) {
			new Notice(t("settings.log_file_missing"));
			return;
		}
		const opener = (
			app as App & {
				openWithDefaultApp?: (path: string) => Promise<void> | void;
			}
		).openWithDefaultApp;
		if (typeof opener !== "function") {
			new Notice(t("settings.open_logs_failed"));
			return;
		}
		await opener.call(app, path);
	} catch {
		if (isCurrent()) {
			new Notice(t("settings.open_logs_failed"));
		}
	}
}

/** Copy a diagnostic tail without replacing the clipboard after its UI closes. */
export async function copyLogTail(
	win: Window,
	readLogs: () => Promise<string>,
	isCurrent: () => boolean = () => true,
): Promise<number | null> {
	if (!isCurrent()) {
		return null;
	}
	const skipped = new Error("Log copy skipped");
	let count: number | null = null;
	const content = Promise.resolve()
		.then(readLogs)
		.then((logs) => {
			if (!isCurrent()) {
				throw skipped;
			}
			if (!logs.trim()) {
				count = 0;
				throw skipped;
			}
			const tail = logs.slice(-LOG_COPY_LIMIT);
			count = tail.length;
			return tail;
		});
	// Native clipboard implementations may reject before consuming deferred data.
	void content.catch(() => undefined);
	try {
		const clipboard = win.navigator.clipboard;
		const ClipboardItemConstructor = (win as Window & typeof globalThis)
			.ClipboardItem;
		if (ClipboardItemConstructor && clipboard?.write) {
			const data = content.then(
				(text) => new Blob([text], { type: "text/plain" }),
			);
			void data.catch(() => undefined);
			try {
				await clipboard.write([
					new ClipboardItemConstructor({ "text/plain": data }),
				]);
			} catch {
				const text = await content;
				if (!isCurrent()) {
					return null;
				}
				await clipboard.writeText(text);
			}
		} else {
			const text = await content;
			if (!isCurrent()) {
				return null;
			}
			await clipboard.writeText(text);
		}
		await content;
		return isCurrent() ? count : null;
	} catch (error) {
		try {
			await content;
		} catch (readError) {
			if (readError === skipped) {
				return count;
			}
			if (!isCurrent()) {
				return null;
			}
			throw readError;
		}
		if (!isCurrent()) {
			return null;
		}
		throw error;
	}
}

let clearingLogs = false;

/** Confirm log clearing and reject stale or duplicate decisions. */
export async function clearLogsWithConfirmation(
	app: App,
	isCurrent: () => boolean,
): Promise<boolean> {
	if (clearingLogs || !isCurrent()) {
		return false;
	}
	clearingLogs = true;
	try {
		const confirmed = await new Promise<boolean>((resolve) => {
			new DecisionModal(
				app,
				t("modal.clear_logs_title"),
				t("modal.clear_logs_description"),
				[
					{ label: t("modal.cancel_button"), value: "cancel" },
					{
						label: t("settings.clear_logs_button"),
						value: "clear",
						warning: true,
					},
				],
				"cancel",
				(choice) => resolve(choice === "clear"),
			).open();
		});
		if (!confirmed || !isCurrent()) {
			return false;
		}
		await logger.clearLogs();
		if (isCurrent()) {
			new Notice(t("notice.logs_cleared"));
		}
		return true;
	} catch (error) {
		if (isCurrent()) {
			new Notice(
				formatOperationFailure(
					createSyncFailure(error, {
						stage: "persisting",
						action: "local",
					}).summary,
				),
			);
		}
		return false;
	} finally {
		clearingLogs = false;
	}
}

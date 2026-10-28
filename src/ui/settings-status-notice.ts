import { Notice } from "obsidian";
import type { SyncPresentation } from "./sync-status-presentation";

/** Mirror non-idle indicator states for the lifetime of the open settings tab. */
export class SettingsStatusNotice {
	private notice: Notice | null = null;
	private message = "";

	update(presentation: SyncPresentation): void {
		if (presentation.state.status === "idle") {
			this.hide();
			return;
		}
		const message = [
			[presentation.text, presentation.progress]
				.filter(Boolean)
				.join(" "),
			presentation.detail,
		]
			.filter(Boolean)
			.join("\n");
		if (message === this.message) {
			return;
		}
		this.message = message;
		if (this.notice) {
			this.notice.setMessage(message);
		} else {
			this.notice = new Notice(message, 0);
		}
	}

	hide(): void {
		this.notice?.hide();
		this.notice = null;
		this.message = "";
	}
}

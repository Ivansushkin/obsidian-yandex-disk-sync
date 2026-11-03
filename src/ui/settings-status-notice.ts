import type { SyncPresentation } from "./sync-status-presentation";

/** Own notices inside the settings tab instead of Obsidian's global notice area. */
export class SettingsStatusNotice {
	readonly element: HTMLElement;
	private status: HTMLElement;
	private messages: HTMLElement;
	private timers = new Set<number>();

	constructor(doc: Document) {
		this.element = doc.createElement("div");
		this.element.className = "yd-settings-notices";
		this.status = doc.createElement("div");
		this.status.className = "yd-settings-notice";
		this.status.setAttribute("role", "status");
		this.status.setAttribute("aria-live", "polite");
		this.status.hidden = true;
		this.messages = doc.createElement("div");
		this.element.append(this.status, this.messages);
	}

	update(presentation: SyncPresentation): void {
		const idle =
			presentation.state.status === "idle" &&
			presentation.state.lastOutcome !== "deferred";
		this.status.hidden = idle;
		this.status.textContent = idle
			? ""
			: [
					[presentation.text, presentation.progress]
						.filter(Boolean)
						.join(" "),
					presentation.detail,
				]
					.filter(Boolean)
					.join("\n");
	}

	show(message: string): void {
		const notice = this.element.ownerDocument.createElement("div");
		notice.className = "yd-settings-notice";
		notice.setAttribute("role", "status");
		notice.textContent = message;
		this.messages.appendChild(notice);
		const win = this.element.ownerDocument.defaultView;
		if (win) {
			const timer = win.setTimeout(() => {
				notice.remove();
				this.timers.delete(timer);
			}, 5000);
			this.timers.add(timer);
		}
	}

	hide(): void {
		const win = this.element.ownerDocument.defaultView;
		for (const timer of this.timers) {
			win?.clearTimeout(timer);
		}
		this.timers.clear();
		this.element.remove();
		this.messages.replaceChildren();
		this.status.textContent = "";
		this.status.hidden = true;
	}
}

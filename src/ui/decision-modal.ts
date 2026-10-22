import { App, Modal, Setting } from "obsidian";

/** Resolve one explicit decision, treating dismissal as its safe fallback. */
export class DecisionModal<T extends string | null> extends Modal {
	private settled = false;
	constructor(
		app: App,
		private readonly title: string,
		private readonly description: string,
		private readonly choices: { label: string; value: T }[],
		private readonly fallback: T,
		private readonly resolve: (value: T) => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.contentEl.createEl("h2", { text: this.title });
		this.contentEl.createEl("p", { text: this.description });
		const row = new Setting(this.contentEl);
		for (const choice of this.choices) {
			row.addButton((button) =>
				button.setButtonText(choice.label).onClick(() => {
					this.finish(choice.value);
					this.close();
				}),
			);
		}
	}
	onClose(): void {
		this.finish(this.fallback);
		this.contentEl.empty();
	}
	private finish(value: T): void {
		if (!this.settled) {
			this.settled = true;
			this.resolve(value);
		}
	}
}

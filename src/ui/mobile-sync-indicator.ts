import { formatSyncRetry } from "./sync-status-presentation";
import { App, Component, ItemView, setIcon } from "obsidian";
import { t } from "../i18n";
import type { SyncState } from "../types";
import type { ForceFlowState } from "../sync/workflows/force-controller";
import {
	getSyncStatusIcon,
	getSyncStatusText,
} from "./sync-status-presentation";

interface MobileSyncContext {
	sync: SyncState;
	force: ForceFlowState | null;
	foreground: "encryption" | "backup" | null;
}

/** Passive mobile counterpart of the desktop status bar, owned by the plugin lifecycle. */
export class MobileSyncIndicator extends Component {
	private element: HTMLElement | null = null;
	private iconEl!: HTMLElement;
	private textEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private insetProbe!: HTMLElement;
	private frame: number | null = null;
	private disposed = false;
	private observer: ResizeObserver | null = null;
	private observed = new Set<Element>();
	private readonly win: Window;

	constructor(
		private readonly app: App,
		private readonly readContext: () => MobileSyncContext,
	) {
		super();
		this.win =
			app.workspace.containerEl.ownerDocument.defaultView ?? window;
	}

	onload(): void {
		this.element = this.app.workspace.containerEl.createDiv({
			cls: "yandex-sync-mobile",
			attr: {
				role: "status",
				"aria-live": "polite",
				"aria-atomic": "true",
			},
		});
		this.iconEl = this.element.createSpan({
			cls: "yandex-sync-status-icon",
			attr: { "aria-hidden": "true" },
		});
		const content = this.element.createDiv({
			cls: "yandex-sync-mobile-content",
		});
		const heading = content.createDiv({
			cls: "yandex-sync-mobile-heading",
		});
		this.textEl = heading.createDiv({ cls: "yandex-sync-mobile-text" });
		this.progressEl = heading.createSpan({
			cls: "yandex-sync-mobile-progress",
		});
		this.detailEl = content.createDiv({ cls: "yandex-sync-mobile-detail" });
		this.insetProbe = this.element.createDiv({
			cls: "yandex-sync-mobile-inset",
			attr: { "aria-hidden": "true" },
		});
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.update()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.schedulePosition(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("resize", () => this.schedulePosition()),
		);
		this.registerDomEvent(this.win, "resize", () =>
			this.schedulePosition(),
		);
		this.registerDomEvent(this.win.document, "visibilitychange", () => {
			this.update();
		});
		const viewport = this.win.visualViewport;
		if (viewport) {
			const reposition = () => this.schedulePosition();
			viewport.addEventListener("resize", reposition);
			viewport.addEventListener("scroll", reposition);
			this.register(() => {
				viewport.removeEventListener("resize", reposition);
				viewport.removeEventListener("scroll", reposition);
			});
		}
		this.observer = new ResizeObserver(() => this.schedulePosition());
		this.registerDomEvent(
			this.app.workspace.containerEl,
			"scroll",
			() => this.schedulePosition(),
			true,
		);
		this.registerDomEvent(
			this.app.workspace.containerEl,
			"transitionend",
			() => this.schedulePosition(),
		);
		const appearanceObserver = new MutationObserver(() =>
			this.schedulePosition(),
		);
		const appearanceOptions = {
			attributes: true,
			attributeFilter: ["class", "style"],
		};
		appearanceObserver.observe(this.win.document.body, appearanceOptions);
		appearanceObserver.observe(
			this.win.document.documentElement,
			appearanceOptions,
		);
		this.register(() => appearanceObserver.disconnect());
		this.app.workspace.onLayoutReady(() => this.update());
		this.update();
	}

	/** Read fresh sources on every event, so completed flows cannot retain UI ownership. */
	update(): void {
		if (this.disposed || !this.element) {
			return;
		}
		this.ensureMounted();
		const { sync, force, foreground } = this.readContext();
		let state = sync;
		let text: string;
		let detail = "";
		let progress = "";
		let idleLabel = "";
		if (force?.active) {
			state = { ...sync, status: "syncing" };
			text = t(`notice.force_phase_${force.phase}`);
			if (force.activity?.status === "syncing") {
				text += `: ${force.activity.currentOperation ?? t("status.syncing")}`;
				progress =
					this.progressText(force.activity) +
					formatSyncRetry(force.activity);
				detail = force.activity.errorMessage ?? "";
			}
		} else if (sync.status === "syncing") {
			text = sync.currentOperation ?? t("status.syncing");
			progress = this.progressText(sync) + formatSyncRetry(sync);
			detail = sync.errorMessage ?? "";
		} else if (foreground) {
			state = { ...sync, status: "syncing" };
			text = t(`status.mobile.${foreground}`);
		} else if (sync.status === "idle") {
			text = "YD";
			idleLabel = t("status.mobile.ready");
			if (sync.lastSyncTime) {
				const time = new Date(sync.lastSyncTime).toLocaleTimeString(
					[],
					{
						hour: "2-digit",
						minute: "2-digit",
						hour12: false,
					},
				);
				text += ` · ${time}`;
				idleLabel = `${t("status.mobile.last_sync")} ${time}`;
			}
		} else {
			text =
				sync.status === "paused" || sync.status === "error"
					? t(`status.mobile.${sync.status}`)
					: getSyncStatusText(sync);
			detail = sync.errorMessage ?? "";
		}
		this.element.className = `yandex-sync-mobile sync-${state.status}${idleLabel ? " is-compact" : ""}${detail && state.status === "syncing" ? " has-error" : ""}`;
		const icon = getSyncStatusIcon(state.status);
		if (this.iconEl.dataset.icon !== icon) {
			setIcon(this.iconEl, icon);
			this.iconEl.dataset.icon = icon;
		}
		if (this.textEl.textContent !== text) {
			this.textEl.setText(text);
		}
		if (this.detailEl.textContent !== detail) {
			this.detailEl.setText(detail);
		}
		this.detailEl.hidden = !detail;
		this.progressEl.setText(progress);
		this.progressEl.hidden = !progress;
		this.element.setAttribute(
			"aria-label",
			`Yandex Disk Sync: ${idleLabel || text}${progress ? ` ${progress}` : ""}${detail ? ` ${detail}` : ""}`,
		);
		this.schedulePosition();
	}

	/** Workspace restoration can remove plugin-owned nodes during a cold launch. */
	private ensureMounted(): void {
		const host = this.app.workspace.containerEl;
		if (this.element && this.element.parentElement !== host) {
			host.appendChild(this.element);
		}
	}

	private progressText(state: SyncState): string {
		return state.progress && state.progress.total > 0
			? `${state.progress.completed}/${state.progress.total}`
			: "";
	}

	private schedulePosition(): void {
		if (this.disposed || this.frame !== null) {
			return;
		}
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = null;
			this.position();
		});
	}

	/** Keep all dependence on Obsidian header DOM in this geometry adapter. */
	private position(): void {
		if (this.disposed || !this.element) {
			return;
		}
		this.ensureMounted();
		const workspace = this.app.workspace;
		const viewport = this.win.visualViewport;
		const viewportTop = viewport?.offsetTop ?? 0;
		const viewportLeft = viewport?.offsetLeft ?? 0;
		const width = viewport?.width ?? this.win.innerWidth;
		const viewportBottom =
			viewportTop + (viewport?.height ?? this.win.innerHeight);
		const insetStyle = this.win.getComputedStyle(this.insetProbe);
		const safeInset = Number.parseFloat(insetStyle.paddingTop) || 0;
		const headerOffset = Number.parseFloat(insetStyle.marginTop) || 0;
		const headerHeight = Number.parseFloat(insetStyle.height) || 48;
		const leftGap = Math.max(
			12,
			Number.parseFloat(insetStyle.paddingLeft) || 0,
		);
		const rightGap = Math.max(
			12,
			Number.parseFloat(insetStyle.paddingRight) || 0,
		);
		// Full-screen content may start under system chrome and floating controls.
		const reservedTop =
			viewportTop + Math.max(safeInset, headerOffset) + headerHeight;
		const view = workspace.getActiveViewOfType(ItemView);
		const content = view?.contentEl;
		const targets = new Set<Element>([
			workspace.containerEl,
			this.insetProbe,
		]);
		const contentRect = content?.getBoundingClientRect();
		let top = reservedTop;
		if (
			content &&
			contentRect &&
			contentRect.width > 0 &&
			contentRect.height > 0 &&
			contentRect.top < viewportBottom
		) {
			top = Math.max(top, contentRect.top);
			targets.add(content);
		}
		const viewContainer =
			view?.containerEl ??
			content?.closest(".workspace-leaf") ??
			workspace.containerEl;
		const headers = [
			...Array.from(
				workspace.containerEl.querySelectorAll<HTMLElement>(
					".workspace-tab-header-container",
				),
			),
			...Array.from(
				viewContainer.querySelectorAll<HTMLElement>(
					".view-header, .view-header .mod-raised, .view-header-left, .view-actions",
				),
			),
		];
		for (const header of headers) {
			targets.add(header);
			const rect = header.getBoundingClientRect();
			const style = this.win.getComputedStyle(header);
			if (
				rect.width > 0 &&
				rect.height > 0 &&
				rect.bottom > viewportTop &&
				rect.bottom < viewportBottom &&
				rect.top < reservedTop + headerHeight &&
				style.visibility !== "hidden" &&
				style.opacity !== "0"
			) {
				top = Math.max(top, rect.bottom);
			}
		}
		this.element.style.setProperty(
			"--yandex-sync-mobile-top",
			`${top + 8}px`,
		);
		this.element.style.setProperty(
			"--yandex-sync-mobile-right",
			`${this.win.innerWidth - viewportLeft - width + rightGap}px`,
		);
		this.element.style.setProperty(
			"--yandex-sync-mobile-width",
			`${Math.max(0, Math.min(360, width - leftGap - rightGap))}px`,
		);
		for (const old of this.observed) {
			if (!targets.has(old)) {
				this.observer?.unobserve(old);
			}
		}
		for (const target of targets) {
			if (!this.observed.has(target)) {
				this.observer?.observe(target);
			}
		}
		this.observed = targets;
	}

	onunload(): void {
		this.disposed = true;
		if (this.frame !== null) {
			this.win.cancelAnimationFrame(this.frame);
			this.frame = null;
		}
		this.observer?.disconnect();
		this.observed.clear();
		this.element?.remove();
		this.element = null;
	}
}

/**
 * Periodic synchronization scheduler
 */

import type { SyncEngine } from "./engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";

export class SyncScheduler {
	private syncEngine: SyncEngine;
	private settings: YandexDiskSyncSettings;

	private intervalId: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;
	private generation = 0;
	private canStartAutomatic: () => boolean = () => true;
	private deferred: () => void = () => {};

	constructor(syncEngine: SyncEngine, settings: YandexDiskSyncSettings) {
		this.syncEngine = syncEngine;
		this.settings = settings;
	}

	/** Gate scheduled entry without changing the user's interval or an admitted session. */
	setAutomaticAdmission(
		canStart: () => boolean,
		deferred: () => void = () => {},
	): void {
		this.canStartAutomatic = canStart;
		this.deferred = deferred;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		const restart =
			this.isRunning &&
			this.settings.syncInterval !== settings.syncInterval;
		this.settings = settings;
		if (restart) {
			this.stop();
			this.start();
		}
	}

	/**
	 * Start scheduler
	 */
	start(): void {
		if (this.isRunning || this.settings.manualSyncRequired) {
			return;
		}

		const intervalMinutes = this.settings.syncInterval;

		if (intervalMinutes <= 0) {
			logger.debug("Periodic synchronization disabled (interval = 0)");
			return;
		}

		const intervalMs = intervalMinutes * 60 * 1000;

		const generation = ++this.generation;
		this.intervalId = setInterval(() => {
			if (this.isRunning && generation === this.generation) {
				void this.runScheduledSync();
			}
		}, intervalMs);

		this.isRunning = true;
		logger.info(
			`SyncScheduler started with ${intervalMinutes} minute interval`,
		);
	}

	/**
	 * Stop scheduler
	 */
	stop(): void {
		this.generation++;
		if (!this.isRunning) {
			return;
		}

		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}

		this.isRunning = false;
		logger.info("SyncScheduler stopped");
	}

	/**
	 * Run scheduled synchronization
	 */
	private async runScheduledSync(): Promise<void> {
		if (!this.canStartAutomatic()) {
			this.deferred();
			return;
		}
		if (this.settings.manualSyncRequired) {
			return;
		}
		if (this.syncEngine.isSyncInProgress()) {
			logger.debug(
				"Skipping scheduled synchronization: already in progress",
			);
			return;
		}

		if (this.syncEngine.isSyncPaused()) {
			logger.debug("Skipping scheduled synchronization: paused");
			return;
		}

		logger.info("Starting scheduled synchronization...");

		try {
			const result = await this.syncEngine.fullSync({
				trigger: "automatic",
			});

			if (result.success) {
				logger.info("Scheduled synchronization completed successfully");
			} else {
				logger.warn(
					`Scheduled synchronization completed with errors: ${result.errors.length}`,
				);
			}
		} catch (e) {
			logger.error("Scheduled synchronization error:", { error: e });
		}
	}
}

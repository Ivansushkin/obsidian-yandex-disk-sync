/**
 * Periodic synchronization scheduler
 */

import { SyncEngine } from "./sync-engine";
import type { YandexDiskSyncSettings } from "../types";
import { logger } from "../utils/logger";

export class SyncScheduler {
	private syncEngine: SyncEngine;
	private settings: YandexDiskSyncSettings;

	private intervalId: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;

	constructor(syncEngine: SyncEngine, settings: YandexDiskSyncSettings) {
		this.syncEngine = syncEngine;
		this.settings = settings;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: YandexDiskSyncSettings): void {
		const oldInterval = this.settings.syncInterval;
		this.settings = settings;

		// Restart if interval changed
		if (this.isRunning && oldInterval !== settings.syncInterval) {
			this.stop();
			this.start();
		}
	}

	/**
	 * Start scheduler
	 */
	start(): void {
		if (this.isRunning) {
			return;
		}

		const intervalMinutes = this.settings.syncInterval;

		if (intervalMinutes <= 0) {
			logger.debug(
				"Periodic synchronization disabled (interval = 0)"
			);
			return;
		}

		const intervalMs = intervalMinutes * 60 * 1000;

		this.intervalId = setInterval(() => {
			void this.runScheduledSync();
		}, intervalMs);

		this.isRunning = true;
		logger.info(
			`SyncScheduler started with ${intervalMinutes} minute interval`
		);
	}

	/**
	 * Stop scheduler
	 */
	stop(): void {
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
		if (this.syncEngine.isSyncInProgress()) {
			logger.debug(
				"Skipping scheduled synchronization: already in progress"
			);
			return;
		}

		if (this.syncEngine.isSyncPaused()) {
			logger.debug(
				"Skipping scheduled synchronization: paused"
			);
			return;
		}

		logger.info("Starting scheduled synchronization...");

		try {
			const result = await this.syncEngine.fullSync();

			if (result.success) {
				logger.info("Scheduled synchronization completed successfully");
			} else {
				logger.warn(
					`Scheduled synchronization completed with errors: ${result.errors.length}`
				);
			}
		} catch (e) {
			logger.error("Scheduled synchronization error:", e);
		}
	}

	/**
	 * Check if scheduler is running
	 */
	isActive(): boolean {
		return this.isRunning;
	}

	/**
	 * Get synchronization interval in minutes
	 */
	getIntervalMinutes(): number {
		return this.settings.syncInterval;
	}

	/**
	 * Trigger synchronization immediately (outside schedule)
	 */
	async triggerSync(): Promise<void> {
		await this.runScheduledSync();
	}
}

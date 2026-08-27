/** Blocks automatic recovery of unsupported historical data. */
export class UnsupportedHistoricalDataError extends Error {
	constructor(detail: string) {
		super(
			`${detail}. Use a clean remote path or reset the old data manually after creating an independent backup.`,
		);
		this.name = "UnsupportedHistoricalDataError";
	}
}

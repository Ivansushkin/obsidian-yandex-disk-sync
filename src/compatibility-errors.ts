/** Blocks automatic recovery of unsupported historical or prerelease data. */
export class UnsupportedPrereleaseDataError extends Error {
	constructor(detail: string) {
		super(
			`${detail}. Use a clean remote path or reset the old data manually after creating an independent backup.`,
		);
		this.name = "UnsupportedPrereleaseDataError";
	}
}

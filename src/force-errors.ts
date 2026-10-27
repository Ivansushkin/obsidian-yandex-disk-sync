/** A verified encrypted source still contains an undecodable resource; never guess its format. */
export class ForceSourceFormatError extends Error {
	constructor() {
		super("Force source contains mixed or unreadable encrypted resources");
		this.name = "ForceSourceFormatError";
	}
}

/** A replacement cannot use a selected path to erase excluded data or its codec. */
export class ForceScopeConflictError extends Error {
	constructor() {
		super(
			"Force replacement conflicts with excluded or protected destination data",
		);
		this.name = "ForceScopeConflictError";
	}
}

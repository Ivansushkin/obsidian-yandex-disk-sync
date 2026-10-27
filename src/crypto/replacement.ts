import type {
	EncryptionEpochAdoption,
	EncryptionReplacement,
	EncryptionReplacementScope,
} from "../types";
import { InvalidCurrentIndexError } from "../sync/canonical/errors";
import {
	isProtectedPath,
	normalizePath,
	shouldSyncFile,
} from "../utils/path-utils";
import { isJsonRecord } from "../utils/record-utils";

/** Apply the same frozen selection on the owner and returning devices. */
export function isReplacementPath(
	path: string,
	scope: EncryptionReplacementScope,
): boolean {
	return shouldSyncFile(
		path,
		scope.syncPatterns,
		scope.excludePatterns,
		scope.syncDotObsidian,
		scope.configDir,
	);
}

/** Skip old-codec exclusions before attempting to decode raw names. */
export function isPreservedRawPath(
	path: string,
	paths: readonly string[],
): boolean {
	return paths.some((root) => path === root || path.startsWith(`${root}/`));
}

function validPaths(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		new Set(value).size === value.length &&
		value.every(
			(path) =>
				typeof path === "string" &&
				path.length > 0 &&
				normalizePath(path) === path &&
				!path.includes("\\") &&
				!path.includes("\0") &&
				!path.split("/").some((part) => part === "." || part === ".."),
		)
	);
}

function validScope(value: unknown): value is EncryptionReplacementScope {
	return (
		isJsonRecord(value) &&
		Object.keys(value).sort().join() ===
			"configDir,excludePatterns,syncDotObsidian,syncPatterns" &&
		Array.isArray(value.syncPatterns) &&
		value.syncPatterns.every((p) => typeof p === "string") &&
		Array.isArray(value.excludePatterns) &&
		value.excludePatterns.every((p) => typeof p === "string") &&
		typeof value.syncDotObsidian === "boolean" &&
		typeof value.configDir === "string" &&
		value.configDir.length > 0
	);
}

/** Reject malformed replacement authority before it can authorize a delete. */
export function validateEncryptionReplacement(
	value: unknown,
): asserts value is EncryptionReplacement {
	if (
		!isJsonRecord(value) ||
		Object.keys(value).sort().join() !==
			"deletions,preservedRawPaths,scope,sourceEpoch,targetEpoch" ||
		typeof value.sourceEpoch !== "string" ||
		!value.sourceEpoch ||
		typeof value.targetEpoch !== "string" ||
		!value.targetEpoch ||
		value.sourceEpoch === value.targetEpoch ||
		!validScope(value.scope) ||
		!validPaths(value.preservedRawPaths) ||
		!Array.isArray(value.deletions) ||
		!value.deletions.every(
			(entry) =>
				isJsonRecord(entry) &&
				Object.keys(entry).sort().join() === "kind,path" &&
				validPaths([entry.path]) &&
				!isProtectedPath(entry.path as string) &&
				(entry.kind === "file" || entry.kind === "dir") &&
				!isPreservedRawPath(
					entry.path as string,
					value.preservedRawPaths as string[],
				) &&
				!(value.preservedRawPaths as string[]).some((path) =>
					path.startsWith(`${entry.path as string}/`),
				),
		)
	) {
		throw new InvalidCurrentIndexError(
			"maintenance.replacement",
			"invalid replacement authority",
		);
	}
	const actions = value.deletions as { path: string }[];
	if (
		actions.some((entry, index) =>
			actions.some(
				(other, position) =>
					position !== index &&
					(entry.path === other.path ||
						entry.path.startsWith(`${other.path}/`)),
			),
		)
	) {
		throw new InvalidCurrentIndexError(
			"maintenance.replacement",
			"overlapping deletion authority",
		);
	}
}

/** Validate the stable receipt independently of an active maintenance record. */
export function validateEncryptionEpochAdoption(
	value: unknown,
): asserts value is EncryptionEpochAdoption {
	if (
		!isJsonRecord(value) ||
		Object.keys(value).sort().join() !==
			"initiatedBy,kind,operationId,preservedRawPaths,scope" ||
		value.kind !== "encryption-replacement" ||
		typeof value.operationId !== "string" ||
		!value.operationId ||
		typeof value.initiatedBy !== "string" ||
		!value.initiatedBy ||
		!validScope(value.scope) ||
		!validPaths(value.preservedRawPaths)
	) {
		throw new InvalidCurrentIndexError(
			"epochAdoption",
			"invalid encryption replacement receipt",
		);
	}
}

/** Prove complete filter coverage conservatively before deleting a whole directory. */
export function isReplacementSubtree(
	path: string,
	scope: EncryptionReplacementScope,
): boolean {
	const inside = (child: string, parent: string) =>
		child === parent || child.startsWith(`${parent}/`);
	const included =
		scope.syncPatterns.length === 0 ||
		scope.syncPatterns.some((pattern) => {
			if (pattern === "**") {
				return true;
			}
			if (!pattern.endsWith("/**")) {
				return false;
			}
			const prefix = pattern.slice(0, -3);
			return !prefix.includes("*") && inside(path, prefix);
		});
	if (
		!included ||
		(!scope.syncDotObsidian &&
			(inside(path, scope.configDir) || inside(scope.configDir, path)))
	) {
		return false;
	}
	return !scope.excludePatterns.some((pattern) => {
		const wildcard = pattern.indexOf("*");
		if (wildcard < 0) {
			return inside(pattern, path) || inside(path, pattern);
		}
		const prefix = pattern.slice(0, wildcard);
		return (
			!prefix ||
			`${path}/`.startsWith(prefix) ||
			prefix.startsWith(`${path}/`)
		);
	});
}

/** Revocation is terminal for this invocation; only a later session may resume it. */
export class EncryptionReplacementRevokedError extends Error {}

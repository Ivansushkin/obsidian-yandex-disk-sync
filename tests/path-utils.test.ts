import assert from "node:assert/strict";
import test from "node:test";
import {
	getAncestorDirectoriesDeepestFirst,
	shouldSyncFile,
	toLocalPath,
} from "../src/utils/path-utils";

test("plugin installation data is never synchronized", () => {
	const configDir = ".custom-config";
	assert.equal(
		shouldSyncFile(
			`${configDir}/plugins/yandex-disk-sync/data.json`,
			["**"],
			[],
			true,
			configDir,
		),
		false,
	);
	assert.equal(
		shouldSyncFile(
			`${configDir}/plugins/yandex-disk-sync/debug.log`,
			["**"],
			[],
			true,
			configDir,
		),
		false,
	);
});

test("legacy debug log directory is never synchronized", () => {
	const configDir = ".custom-config";
	assert.equal(
		shouldSyncFile(
			`${configDir}/yandex-disk-sync/debug.log`,
			["**"],
			[],
			true,
			configDir,
		),
		false,
	);
});

test("other Obsidian plugin data remains eligible when enabled", () => {
	const configDir = ".custom-config";
	assert.equal(
		shouldSyncFile(
			`${configDir}/plugins/another-plugin/data.json`,
			["**"],
			[],
			true,
			configDir,
		),
		true,
	);
});

test("transition physical paths use one root-relative representation", () => {
	assert.equal(
		toLocalPath(
			"disk:/obsidian-sync/encrypted-segment/file",
			"obsidian-sync",
		),
		"encrypted-segment/file",
	);
	assert.equal(
		toLocalPath(
			"obsidian-sync/plain/folder/file.md",
			"obsidian-sync",
		),
		"plain/folder/file.md",
	);
});

test("ancestor directories are unique and deepest first", () => {
	assert.deepEqual(
		getAncestorDirectoriesDeepestFirst([
			"a/b/c/one.md",
			"a/b/two.md",
			"a/d/three.md",
		]),
		["a/b/c", "a/b", "a/d", "a"],
	);
});

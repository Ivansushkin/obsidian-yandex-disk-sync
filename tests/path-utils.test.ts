import assert from "node:assert/strict";
import test from "node:test";
import {
	getAncestorDirectoriesDeepestFirst,
	hasPortablePathCollision,
	isLegacyPluginDataPath,
	isLegacyServicePathCollision,
	shouldSyncFile,
	toLocalPath,
} from "../src/utils/path-utils";

test("portable path collisions block Force remote before local writes", () => {
	assert.equal(hasPortablePathCollision(["Notes/A.md", "notes/a.md"]), true);
	assert.equal(hasPortablePathCollision(["Cafe\u0301.md", "Caf\u00e9.md"]), true);
	assert.equal(hasPortablePathCollision(["Remote.md", "remote.md"]), true);
	assert.equal(hasPortablePathCollision(["one.md", "two.md"]), false);
});

test("stable migration recognizes protected plugin and service paths", () => {
	assert.equal(
		isLegacyPluginDataPath(
			"vault-config/plugins/yandex-disk-sync/data.json",
		),
		true,
	);
	assert.equal(
		isLegacyPluginDataPath(
			"vault-config/plugins/obsidian-yandex-disk-sync/data.json",
		),
		true,
	);
	assert.equal(
		isLegacyPluginDataPath("vault-config/plugins/another/data.json"),
		false,
	);
	assert.equal(
		isLegacyServicePathCollision("notes/.obsidian-sync-index.json"),
		true,
	);
});

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

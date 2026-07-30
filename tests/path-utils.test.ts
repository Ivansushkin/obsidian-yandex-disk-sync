import assert from "node:assert/strict";
import test from "node:test";
import {
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

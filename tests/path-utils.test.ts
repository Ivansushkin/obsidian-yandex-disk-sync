import assert from "node:assert/strict";
import test from "node:test";
import {
	hasPortablePathCollision,
	isLegacyPluginDataPath,
	isLegacyServicePathCollision,
	shouldSyncFile,
} from "../src/utils/path-utils";

test("portable path collisions block Force remote before local writes", () => {
	assert.equal(hasPortablePathCollision(["Notes/A.md", "notes/a.md"]), true);
	assert.equal(
		hasPortablePathCollision(["Cafe\u0301.md", "Caf\u00e9.md"]),
		true,
	);
	assert.equal(hasPortablePathCollision(["Remote.md", "remote.md"]), true);
	for (const paths of [
		["Foo/a.md", "foo/b.md"],
		["folder", "folder/note.md"],
		["Cafe\u0301/a", "Caf\u00e9/b"],
	]) {
		assert.equal(hasPortablePathCollision(paths), true, paths.join(", "));
	}
	assert.equal(
		hasPortablePathCollision(["one.md", "two.md", "one.md"]),
		false,
	);
	assert.equal(hasPortablePathCollision(["folder"], ["folder"]), true);
	assert.equal(
		hasPortablePathCollision(["folder/note.md"], ["folder"]),
		false,
	);
	assert.equal(
		hasPortablePathCollision(["__proto__", "日本語/Заметка.md"]),
		false,
	);
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

test("path filtering protects plugin storage while allowing other configured plugins", () => {
	const configDir = ".custom-config";
	for (const [relativePath, expected] of [
		["plugins/yandex-disk-sync/data.json", false],
		["plugins/yandex-disk-sync/debug.log", false],
		["yandex-disk-sync/debug.log", false],
		["plugins/another-plugin/data.json", true],
	] as const) {
		assert.equal(
			shouldSyncFile(
				`${configDir}/${relativePath}`,
				["**"],
				[],
				true,
				configDir,
			),
			expected,
			relativePath,
		);
	}
});

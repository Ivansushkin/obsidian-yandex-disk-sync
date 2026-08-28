import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { validateScenarioCatalog } from "../scripts/scenario-catalog.mjs";

const catalog = readFileSync("docs/SYNC_USER_SCENARIOS.md", "utf8");
const smokeTests = readFileSync("docs/SMOKE_TESTS.md", "utf8");
const scenarioTestSources = readdirSync("tests")
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => readFileSync(`tests/${name}`, "utf8"));

function collectTextFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return collectTextFiles(path);
		return /\.(?:ts|md|json)$/.test(entry.name) ? [path] : [];
	});
}

test("changelog exposes stable 2.0.0 and historical 1.1.0", () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		version: string;
	};
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
		version: string;
		minAppVersion: string;
	};
	const versions = JSON.parse(readFileSync("versions.json", "utf8")) as Record<
		string,
		string
	>;
	const changelog = readFileSync("CHANGELOG.md", "utf8");

	assert.equal(packageJson.version, "2.0.0");
	assert.equal(manifest.version, "2.0.0");
	assert.equal(manifest.minAppVersion, "1.0.0");
	assert.deepEqual(versions, {
		"1.1.0": "0.15.0",
		"2.0.0": "1.0.0",
	});
	assert.deepEqual(
		[...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
		["2.0.0", "1.1.0"],
	);
	assert.match(changelog, /Changes since stable `1\.1\.0`\./);
	assert.match(changelog, /## 1\.1\.0[\s\S]+#### Force Sync/);
	assert.doesNotMatch(changelog, /\b(?:beta|prerelease)\b/i);
});

test("first-party source and docs contain no numbered current format markers", () => {
	const files = [
		...collectTextFiles("src"),
		...collectTextFiles("docs"),
		"AGENTS.md",
		"README.md",
		"README_RU.md",
		"CHANGELOG.md",
	];
	const forbidden = [
		/\b(?:beta|prerelease)\b/i,
		/\b(?:index|canonical|manifest|schema)\s+v\d+\b/i,
		/\bCURRENT_INDEX_VERSION\b/,
		/\bhardened-v\d+\b/,
		/OYDSBKP\d/,
		/:device-id:v\d+\b/,
		/obsidian-yandex-disk-sync:[^"'`\s]+:v\d+\b/,
		/\bversion\s*:\s*[34]\b/,
	];
	const violations = files.flatMap((path) => {
		const content = readFileSync(path, "utf8");
		return forbidden.flatMap((pattern) =>
			pattern.test(content) ? [`${path}: ${pattern.source}`] : [],
		);
	});
	assert.deepEqual(violations, []);
});

test("scenario evidence uses strict syntax and exact executable test names", () => {
	assert.deepEqual(
		validateScenarioCatalog(catalog, scenarioTestSources, smokeTests),
		[],
	);
});

test("causal blockers have exact automated evidence", () => {
	for (const id of [
		"MOVE-029",
		"MOVE-030",
		"FDEL-017",
		"SYNC-030",
		"INDEX-001",
		"SYNC-031",
		"MULTI-017",
	]) {
		const line = catalog
			.split("\n")
			.find((candidate) => candidate.startsWith(`| ${id}`));
		assert.ok(line, `${id} must exist in the scenario catalogue`);
		assert.match(line, /auto: `[^`]+`/);
	}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = readFileSync("docs/SYNC_USER_SCENARIOS.md", "utf8");

test("release metadata exposes one 2.0.0 line after stable 1.1.0", () => {
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
		["2.0.0"],
	);
	assert.match(changelog, /Changes since stable `1\.1\.0`\./);
	assert.doesNotMatch(changelog, /\b(?:beta|prerelease)\b/i);
});

test("P0 and P1 scenario evidence does not use generic test labels", () => {
	const invalid = catalog.split("\n").flatMap((line) => {
		if (!/^\|\s*[^|]+\s*\|\s*P[01]\s*\|/.test(line)) return [];
		const cells = line.split("|").map((cell) => cell.trim());
		const id = cells[1] ?? "unknown";
		const evidence = cells.at(-2) ?? "";
		const hasGenericLabel =
			/\b(?:integration|two-device|fault matrix)\b/i.test(evidence);
		return hasGenericLabel && !evidence.includes("`") ? [id] : [];
	});
	assert.deepEqual(
		invalid,
		[],
		`Replace generic scenario evidence with an exact test name or manual-required: ${invalid.join(", ")}`,
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
		"DIAG-017",
	]) {
		const line = catalog
			.split("\n")
			.find((candidate) => candidate.startsWith(`| ${id}`));
		assert.ok(line, `${id} must exist in the scenario catalogue`);
		assert.match(line, /auto: `[^`]+`/);
	}
});

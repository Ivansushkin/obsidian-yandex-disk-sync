import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = readFileSync("docs/SYNC_USER_SCENARIOS.md", "utf8");

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

test("beta.3 causal blockers have exact automated evidence", () => {
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

import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const catalogModule = pathToFileURL(
	resolve(process.cwd(), "scripts/scenario-catalog.mjs"),
).href;
type ScenarioCatalogModule = {
	collectNodeTestNames: (sources: string[]) => Set<string>;
	parseScenarioRows: (markdown: string) => { id: string }[];
	validateScenarioCatalog: (
		markdown: string,
		sources: string[],
		smoke: string,
		scripts: Record<string, string>,
	) => string[];
};
const catalogPromise = import(catalogModule) as Promise<ScenarioCatalogModule>;
const scripts = {
	"test:force-fencing": "node test.config.mjs --force-fencing",
};

const catalog = [
	"| AUTH-001 | P0 | Sign in | Connected | auto: `OAuth plaintext full`, `OAuth encrypted full`; manual: `TC-AUTH-01` |",
	"| AUTH-002 | P1 | Callback | No stale grant | manual-required: real Obsidian; manual: `TC-AUTH-01` (timeout) |",
	"| FORCE-DIRECT-001 | P0 | Foreign write | Server fencing is not guaranteed | known-limitation; diagnostic: `npm run test:force-fencing` |",
].join("\n");
const smoke = [
	"## TC-AUTH-01. Authorization",
	"Покрывает `AUTH-001`–`AUTH-002`.",
].join("\n");
const source = [
	"for (const encrypted of [false, true]) {",
	'  test(`OAuth ${encrypted ? "encrypted" : "plaintext"} full`, async () => {});',
	"}",
].join("\n");

test("scenario catalogue recognizes compound IDs, named manual ranges, and two-mode test titles", async () => {
	const { collectNodeTestNames, parseScenarioRows, validateScenarioCatalog } =
		await catalogPromise;
	assert.equal(parseScenarioRows(catalog).length, 3);
	assert.deepEqual([...collectNodeTestNames([source])].sort(), [
		"OAuth encrypted full",
		"OAuth plaintext full",
	]);
	assert.deepEqual(
		validateScenarioCatalog(catalog, [source], smoke, scripts),
		[],
	);
});

test("scenario catalogue rejects unknown evidence and diagnostic-only positive claims", async () => {
	const { validateScenarioCatalog } = await catalogPromise;
	assert.match(
		validateScenarioCatalog(
			catalog.replace("OAuth plaintext full", "missing executable title"),
			[source],
			smoke,
			scripts,
		).join("; "),
		/missing executable test missing executable title/,
	);
	assert.match(
		validateScenarioCatalog(
			catalog.replace("known-limitation; ", ""),
			[source],
			smoke,
			scripts,
		).join("; "),
		/FORCE-DIRECT-001: P0\/P1 scenario has no executable or manual evidence/,
	);
	assert.match(
		validateScenarioCatalog(
			catalog.replace("test:force-fencing", "missing-script"),
			[source],
			smoke,
			scripts,
		).join("; "),
		/unknown diagnostic script missing-script/,
	);
});

test("scenario catalogue reports malformed scenario IDs instead of skipping their rows", async () => {
	const { validateScenarioCatalog } = await catalogPromise;
	assert.match(
		validateScenarioCatalog(
			catalog.replace("| AUTH-001 |", "| auth-001 |"),
			[source],
			smoke,
			scripts,
		).join("; "),
		/invalid scenario ID auth-001/,
	);
});

test("test-title collection does not invent an unreachable conditional mode", async () => {
	const { collectNodeTestNames } = await catalogPromise;
	const fixedMode =
		'test(`OAuth ${true ? "encrypted" : "plaintext"} full`, async () => {});';
	assert.equal(
		collectNodeTestNames([fixedMode]).has("OAuth plaintext full"),
		false,
	);
	const dependentModes = [
		"for (const encrypted of [false, true]) {",
		'  test(`${encrypted ? "encrypted" : "plaintext"} ${encrypted ? "yes" : "no"}`, async () => {});',
		"}",
	].join("\n");
	assert.equal(
		collectNodeTestNames([dependentModes]).has("encrypted no"),
		false,
	);
});

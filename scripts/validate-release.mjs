import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
	throw new Error(`Release validation failed: ${message}`);
}

const packageJson = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const evidence = readJson("docs/release-evidence/2.0.0.json");
const version = packageJson.version;
const stable = !version.includes("-");

if (manifest.version !== version) fail("package and manifest versions differ");
if (manifest.minAppVersion !== "1.0.0") fail("minAppVersion must be 1.0.0");
if (versions[version] !== manifest.minAppVersion) {
	fail(`versions.json does not map ${version} to ${manifest.minAppVersion}`);
}
if (versions["1.1.0"] !== "0.15.0") fail("1.1.0 fallback is missing");
if (
	JSON.stringify(Object.keys(versions).sort()) !==
	JSON.stringify(["1.1.0", "2.0.0"])
) {
	fail("versions.json must expose only stable 1.1.0 and 2.0.0");
}
const changelog = readFileSync("CHANGELOG.md", "utf8");
const changelogVersions = [...changelog.matchAll(/^## (.+)$/gm)].map(
	(match) => match[1],
);
if (JSON.stringify(changelogVersions) !== JSON.stringify(["2.0.0"])) {
	fail("changelog must contain one unified 2.0.0 section");
}
if (/\b(?:beta|prerelease)\b/i.test(changelog)) {
	fail("changelog must describe only changes from stable 1.1.0");
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== version) {
	fail(`tag ${process.env.RELEASE_TAG} does not equal ${version}`);
}

const runtime = packageJson.dependencies ?? {};
const development = packageJson.devDependencies ?? {};
if (runtime["@noble/ciphers"] !== "2.2.0" || runtime.jszip !== "3.10.1") {
	fail("runtime dependency pins changed");
}
if (runtime.obsidian || development.obsidian !== "1.13.1") {
	fail("obsidian must be a pinned devDependency");
}
const lock = readFileSync("package-lock.json", "utf8");
if (/registry\.npmmirror\.com|npm\.yandex-team\.ru/.test(lock)) {
	fail("lockfile contains a non-public registry");
}

const assets = readdirSync("build").sort();
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
if (JSON.stringify(assets) !== JSON.stringify(expectedAssets)) {
	fail(`unexpected build assets: ${assets.join(", ")}`);
}
const bundle = readFileSync("build/main.js", "utf8");
const forbiddenImports = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
for (const name of forbiddenImports) {
	if (bundle.includes(`require("${name}")`) || bundle.includes(`require('${name}')`)) {
		fail(`browser bundle imports ${name}`);
	}
}

const catalog = readFileSync("docs/SYNC_USER_SCENARIOS.md", "utf8");
const testSources = readdirSync("tests")
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => readFileSync(`tests/${name}`, "utf8"))
	.join("\n");
for (const id of [
	"ENC-011",
	"ENC-012",
	"ENC-013",
	"TRANS-023",
	"TRANS-024",
	"TRANS-025",
	"TRANS-026",
	"TRANS-027",
	"SAFE-010",
	"SAFE-011",
	"SAFE-012",
]) {
	const line = catalog.split("\n").find((candidate) => candidate.startsWith(`| ${id}`));
	if (!line || !/auto: `[^`]+`/.test(line)) fail(`${id} lacks exact automated evidence`);
	for (const name of [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])) {
		if (!testSources.includes(`test("${name}"`)) {
			fail(`${id} references a missing test: ${name}`);
		}
	}
}

if (stable) {
	if (version !== "2.0.0") fail("only 2.0.0 is approved as the next stable");
	if (evidence.status !== "PASS" || evidence.releaseVersion !== version) {
		fail("manual P0/P1 evidence is not complete");
	}
	if (!/^[0-9a-f]{40}$/.test(evidence.testedCommit ?? "")) {
		fail("verified 2.0.0 test commit SHA is missing");
	}
	const priorityLines = catalog
		.split("\n")
		.filter((line) => /^\|\s*[^|]+\s*\|\s*P[01]\s*\|/.test(line));
	const entries = new Map(
		(evidence.scenarios ?? []).map((entry) => [entry.scenarioId, entry]),
	);
	for (const line of priorityLines) {
		const cells = line.split("|").map((cell) => cell.trim());
		const id = cells[1];
		const check = cells.at(-2) ?? "";
		if (check.includes("auto:")) {
			const names = [...check.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
			if (names.length === 0) fail(`${id} uses generic automated evidence`);
			for (const name of names) {
				if (!testSources.includes(`test("${name}"`)) {
					fail(`${id} references a missing test: ${name}`);
				}
			}
		}
		const entry = entries.get(id);
		if (
			!entry ||
			entry.status !== "PASS" ||
			!entry.evidenceName ||
			entry.testedCommit !== evidence.testedCommit ||
			!entry.date ||
			!entry.os ||
			!entry.obsidianVersion ||
			!Array.isArray(entry.deviceIds) ||
			entry.deviceIds.length !== 2 ||
			entry.deviceIds[0] === entry.deviceIds[1]
		) {
			fail(`${id} lacks complete machine-readable evidence`);
		}
	}
	const allowedReleaseDiff = new Set(["docs/release-evidence/2.0.0.json"]);
	const changed = execFileSync(
		"git",
		["diff", "--name-only", evidence.testedCommit, "HEAD"],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean);
	const forbidden = changed.filter((path) => !allowedReleaseDiff.has(path));
	if (forbidden.length > 0) {
		fail(`release differs from the tested 2.0.0 code: ${forbidden.join(", ")}`);
	}
}

console.log(`Release metadata validated for ${version}`);

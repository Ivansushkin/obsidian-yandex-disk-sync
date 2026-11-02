import { builtinModules } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { validateScenarioCatalog } from "./scenario-catalog.mjs";
import { readLocalPluginPath } from "./local-build-env.mjs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
	throw new Error(`Release validation failed: ${message}`);
}

const packageJson = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const version = packageJson.version;
const stable = !version.includes("-");

if (manifest.version !== version) {
	fail("package and manifest versions differ");
}
if (manifest.minAppVersion !== "1.0.0") {
	fail("minAppVersion must be 1.0.0");
}
if (versions[version] !== manifest.minAppVersion) {
	fail(`versions.json does not map ${version} to ${manifest.minAppVersion}`);
}
if (versions["1.1.0"] !== "0.15.0") {
	fail("1.1.0 fallback is missing");
}
if (
	JSON.stringify(Object.keys(versions).sort()) !==
	JSON.stringify(["1.1.0", "2.0.0", "2.1.0", "2.2.0"])
) {
	fail(
		"versions.json must retain stable 1.1.0, 2.0.0, 2.1.0 and current 2.2.0",
	);
}
const changelog = readFileSync("CHANGELOG.md", "utf8");
const changelogVersions = [...changelog.matchAll(/^## (.+)$/gm)].map(
	(match) => match[1],
);
if (
	JSON.stringify(changelogVersions) !==
	JSON.stringify(["2.2.0", "2.1.0", "2.0.0", "1.1.0"])
) {
	fail(
		"changelog must contain current 2.2.0 and historical 2.1.0/2.0.0/1.1.0 sections",
	);
}
if (/\b(?:beta|prerelease)\b/i.test(changelog)) {
	fail("changelog must describe stable release changes");
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
if (runtime.dotenv || development.dotenv !== "17.4.2") {
	fail("dotenv must be a pinned devDependency");
}
const lock = readFileSync("package-lock.json", "utf8");
if (/registry\.npmmirror\.com|npm\.yandex-team\.ru/.test(lock)) {
	fail("lockfile contains a non-public registry");
}
if (
	execFileSync("git", ["ls-files", "--", ".env"], { encoding: "utf8" }).trim()
) {
	fail("local .env must not be tracked");
}
readLocalPluginPath();

const assets = readdirSync("build").sort();
const expectedAssets = ["main.js", "manifest.json", "styles.css"];
if (JSON.stringify(assets) !== JSON.stringify(expectedAssets)) {
	fail(`unexpected build assets: ${assets.join(", ")}`);
}
const bundle = readFileSync("build/main.js", "utf8");
if (bundle.includes("dotenv")) {
	fail("browser bundle contains dotenv");
}
const forbiddenImports = [
	"electron",
	...builtinModules,
	...builtinModules.map((name) => `node:${name}`),
];
for (const name of forbiddenImports) {
	if (
		bundle.includes(`require("${name}")`) ||
		bundle.includes(`require('${name}')`)
	) {
		fail(`browser bundle imports ${name}`);
	}
}

const catalog = readFileSync("docs/SYNC_USER_SCENARIOS.md", "utf8");
const smokeTests = readFileSync("docs/SMOKE_TESTS.md", "utf8");
const testSources = readdirSync("tests")
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => readFileSync(`tests/${name}`, "utf8"));
const scenarioErrors = validateScenarioCatalog(
	catalog,
	testSources,
	smokeTests,
	packageJson.scripts ?? {},
);
if (scenarioErrors.length > 0) {
	fail(`scenario catalogue is invalid: ${scenarioErrors.join("; ")}`);
}

if (stable) {
	if (version !== "2.2.0") {
		fail("only 2.2.0 is approved as the next stable");
	}
}

console.log(`Release metadata validated for ${version}`);

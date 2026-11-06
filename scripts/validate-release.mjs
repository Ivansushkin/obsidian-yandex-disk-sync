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
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

if (typeof version !== "string" || !stableVersion.test(version)) {
	fail("package version must have the stable x.y.z format");
}
if (manifest.version !== version) {
	fail("package and manifest versions differ");
}
if (versions[version] !== manifest.minAppVersion) {
	fail(`versions.json does not map ${version} to ${manifest.minAppVersion}`);
}

const historicalFallbacks = {
	"1.1.0": "1.0.0",
	"2.0.0": "1.0.0",
	"2.1.0": "1.0.0",
	"2.2.0": "1.0.0",
	"2.3.0": "1.0.0",
};
for (const [release, minimum] of Object.entries(historicalFallbacks)) {
	if (versions[release] !== minimum) {
		fail(
			`versions.json must retain the fallback mapping ${release} to ${minimum}`,
		);
	}
}
for (const [release, minimum] of Object.entries(versions)) {
	if (
		!stableVersion.test(release) ||
		typeof minimum !== "string" ||
		!stableVersion.test(minimum)
	) {
		fail(`versions.json contains an invalid stable mapping for ${release}`);
	}
}
const changelog = readFileSync("CHANGELOG.md", "utf8");
const changelogVersions = [...changelog.matchAll(/^## (.+)$/gm)].map(
	(match) => match[1],
);
const releasesNewestFirst = Object.keys(versions).sort((left, right) =>
	right.localeCompare(left, "en", { numeric: true }),
);
if (
	changelogVersions[0] !== version ||
	JSON.stringify(changelogVersions) !== JSON.stringify(releasesNewestFirst)
) {
	fail(
		"changelog must start with the current release and list all releases newest first",
	);
}
if (/\b(?:beta|prerelease)\b/i.test(changelog)) {
	fail("changelog must describe stable release changes");
}
const releaseTag = process.env.RELEASE_TAG;
const sourceManifest = readFileSync("manifest.json");
if (releaseTag !== undefined) {
	if (releaseTag !== version) {
		fail(`tag ${releaseTag} does not equal ${version}`);
	}
	const tagRef = `refs/tags/${releaseTag}`;
	const tagCommit = execFileSync("git", [
		"rev-parse",
		"--verify",
		`${tagRef}^{commit}`,
	]);
	const headCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"]);
	if (!tagCommit.equals(headCommit)) {
		fail(`tag ${releaseTag} does not point to HEAD`);
	}
	const taggedManifest = execFileSync("git", [
		"show",
		`${tagRef}:manifest.json`,
	]);
	if (!sourceManifest.equals(taggedManifest)) {
		fail(`manifest.json differs from the manifest at tag ${releaseTag}`);
	}
}

const runtime = packageJson.dependencies ?? {};
const development = packageJson.devDependencies ?? {};
if (runtime["@noble/ciphers"] !== "2.2.0" || runtime.fflate !== "0.8.3") {
	fail("runtime dependency pins changed");
}
if (runtime.obsidian || development.obsidian !== "1.13.1") {
	fail("obsidian must be a pinned devDependency");
}
const lock = readFileSync("package-lock.json", "utf8");
const lockfile = JSON.parse(lock);
if (
	lockfile.version !== version ||
	lockfile.packages?.[""]?.version !== version
) {
	fail("lockfile version differs from package version");
}
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
if (!sourceManifest.equals(readFileSync("build/manifest.json"))) {
	fail("build/manifest.json differs from the source manifest");
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

console.log(`Release metadata validated for ${version}`);

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import process from "node:process";

const [publishedDir, buildDir] = process.argv.slice(2);
if (!publishedDir || !buildDir) throw new Error("Two asset directories are required");
const expected = ["main.js", "manifest.json", "styles.css"];
const actual = readdirSync(publishedDir).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
	throw new Error(`Published release has unexpected assets: ${actual.join(", ")}`);
}
for (const name of expected) {
	const published = readFileSync(join(publishedDir, name));
	const built = readFileSync(join(buildDir, name));
	const digest = (value) => createHash("sha256").update(value).digest("hex");
	if (digest(published) !== digest(built)) {
		throw new Error(`Published ${name} does not match the verified build`);
	}
}
console.log("Published release assets match the verified build byte-for-byte");

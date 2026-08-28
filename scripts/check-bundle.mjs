import { build } from "esbuild";
import { readFileSync } from "node:fs";
import process from "node:process";

async function bundledSize(contents) {
	const result = await build({
		stdin: { contents, resolveDir: process.cwd(), loader: "js" },
		bundle: true,
		format: "cjs",
		minify: true,
		platform: "browser",
		target: "es2018",
		treeShaking: true,
		write: false,
		logLevel: "silent",
	});
	return result.outputFiles[0].contents.byteLength;
}

const baseline = await bundledSize("export const marker = 1;");
const withNoble = await bundledSize(`
	import { aessiv } from "@noble/ciphers/aes.js";
	export function encrypt(key, aad, data) {
		return aessiv(key, aad).encrypt(data);
	}
`);
const increase = withNoble - baseline;
if (increase > 12 * 1024) {
	throw new Error(`@noble/ciphers adds ${increase} bytes; limit is 12288`);
}
if (readFileSync("build/main.js", "utf8").includes("dotenv")) {
	throw new Error("Runtime bundle must not contain the dev-only dotenv package");
}
console.log(`@noble/ciphers minified contribution: ${increase} bytes`);

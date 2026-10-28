import { build } from "esbuild";
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const bundle = await build({
	entryPoints: ["src/i18n/translations.ts"],
	bundle: true,
	write: false,
	platform: "node",
	format: "esm",
	logLevel: "silent",
});
const { translations } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const failures = [];
const base = translations.en;
const placeholders = (text) =>
	[...text.matchAll(/\{([^{}]+)\}/g)]
		.map((match) => match[1])
		.sort()
		.join(",");
for (const [language, dictionary] of Object.entries(translations)) {
	for (const key of new Set([
		...Object.keys(base),
		...Object.keys(dictionary),
	])) {
		if (!base[key] || !dictionary[key]) {
			failures.push(`${language}: missing or empty key ${key}`);
		} else if (placeholders(dictionary[key]) !== placeholders(base[key])) {
			failures.push(`${language}: inconsistent placeholders for ${key}`);
		}
	}
}

/** Inspect literal references, including keys held in maps and conditional branches. */
function scan(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			scan(file);
			continue;
		}
		if (
			!file.endsWith(".ts") ||
			file.startsWith(path.join("src", "i18n"))
		) {
			continue;
		}
		const source = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		function visit(node) {
			if (
				(ts.isStringLiteral(node) ||
					ts.isNoSubstitutionTemplateLiteral(node)) &&
				/^(settings|modal|force|storage|notice|status|failure|generic|units|command|backup_list)\.[a-z0-9_.-]+$/.test(
					node.text,
				) &&
				!base[node.text]
			) {
				failures.push(
					`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: missing ${node.text}`,
				);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
}
scan("src");
for (const [prefix, variants] of [
	[
		"failure.category.",
		["unavailable", "access", "safety", "local", "unknown"],
	],
	[
		"failure.outcome.",
		["stopped-before-write", "partial", "write-unconfirmed", "unknown"],
	],
	[
		"failure.next.",
		[
			"unavailable",
			"access",
			"safety",
			"local",
			"unknown",
			"local-persistence",
			"force-source-format",
			"force-scope-conflict",
		],
	],
	[
		"notice.force_phase_",
		[
			"preflight",
			"confirming",
			"protected-snapshot",
			"creating-backup",
			"uploading-backup",
			"verifying-backup",
			"syncing",
			"persisting",
			"reconciling",
		],
	],
	[
		"status.mobile.",
		["paused", "error", "encryption", "backup", "expand", "collapse"],
	],
	["units.", ["byte", "kilobyte", "megabyte", "gigabyte"]],
]) {
	for (const variant of variants) {
		if (!base[prefix + variant]) {
			failures.push(`Missing dynamic key ${prefix + variant}`);
		}
	}
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(
		`i18n: ${Object.keys(translations).length} languages, ${Object.keys(base).length} keys each; references and placeholders checked.`,
	);
}

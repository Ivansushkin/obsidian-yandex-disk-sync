import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const LOCAL_ENV_FILE = ".env";

/** Parse only the local build configuration, without exposing its contents. */
function readLocalEnvironment(rootDir) {
	const envPath = path.join(rootDir, LOCAL_ENV_FILE);
	if (!existsSync(envPath)) {
		return {};
	}

	let localEnvironment;
	try {
		const source = readFileSync(envPath, "utf8");
		const assignmentLines = source
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
		if (
			assignmentLines.some(
				(line) =>
					!/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(line),
			) ||
			assignmentLines.filter((line) =>
				/^(?:export\s+)?YANDEX_PLUGIN_PATH\s*=/u.test(line),
			).length > 1
		) {
			throw new Error(
				"unsupported syntax or duplicate YANDEX_PLUGIN_PATH",
			);
		}
		localEnvironment = {};
		for (const line of assignmentLines) {
			const assignment = line.replace(/^export\s+/u, "");
			// Preserve existing quoted values, including escapes the Node parser treats differently.
			const quoted =
				/^(\w+)\s*=\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`)\s*(?:#.*)?$/u.exec(
					assignment,
				);
			if (!quoted) {
				const separator = assignment.indexOf("=");
				const key = assignment.slice(0, separator).trimEnd();
				const value = assignment.slice(separator + 1);
				localEnvironment[key] = value.split("#", 1)[0].trim();
				continue;
			}
			const [, key, value] = quoted;
			const inner = value.slice(1, -1);
			localEnvironment[key] = value.startsWith('"')
				? inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r")
				: inner;
		}
	} catch (error) {
		throw new Error(`Cannot parse ${envPath}`, { cause: error });
	}

	return localEnvironment;
}

/** Read the build-time OAuth credential without logging its value. */
export function readLocalOAuthSecret(rootDir = process.cwd()) {
	return (
		process.env.YANDEX_OAUTH_CLIENT_SECRET?.trim() ||
		readLocalEnvironment(rootDir).YANDEX_OAUTH_CLIENT_SECRET?.trim() ||
		""
	);
}

/** Read the local test-vault destination without inheriting shell variables. */
export function readLocalPluginPath(rootDir = process.cwd()) {
	const configuredPath =
		readLocalEnvironment(rootDir).YANDEX_PLUGIN_PATH?.trim();
	if (!configuredPath) {
		return null;
	}
	if (!path.isAbsolute(configuredPath)) {
		throw new Error("YANDEX_PLUGIN_PATH in .env must be an absolute path");
	}
	if (existsSync(configuredPath) && !statSync(configuredPath).isDirectory()) {
		throw new Error("YANDEX_PLUGIN_PATH in .env must point to a directory");
	}
	return configuredPath;
}

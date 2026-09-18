import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "dotenv";

export const LOCAL_ENV_FILE = ".env";

/**
 * Read the local test-vault destination without inheriting shell variables.
 */
export function readLocalPluginPath(rootDir = process.cwd()) {
	const envPath = path.join(rootDir, LOCAL_ENV_FILE);
	if (!existsSync(envPath)) {
		return null;
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
		localEnvironment = parse(source);
	} catch (error) {
		throw new Error(`Cannot parse ${envPath}`, { cause: error });
	}

	const configuredPath = localEnvironment.YANDEX_PLUGIN_PATH?.trim();
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

// The user's configuration, read from one file. Nothing here reads environment variables: a project
// can set those for the processes it starts, and the guard must not take its trust from them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SandboxMode = "landlock" | "off";
export type UnavailablePolicy = "warn" | "block";

export interface HomeGuardConfig {
	/** More writable places: absolute, or starting with `~/`. */
	allowWrite?: string[];
	/** More protected places outside the home directory: absolute, or starting with `~/`. */
	protect?: string[];
	/** `landlock` (default) runs every bash call in the sandbox on Linux; `off` keeps only the static check. */
	sandbox?: SandboxMode;
	/** What happens when the sandbox cannot run: `warn` (default) or `block` every bash call. */
	onUnavailable?: UnavailablePolicy;
	/** The Bun executable that runs the sandbox helper; found on PATH when unset. */
	bunPath?: string;
}

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".config", "omp-home-guard", "config.json");
}

function stringList(value: unknown, key: string, file: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${file}: "${key}" must be a list of paths`);
	}
	return value as string[];
}

function oneOf<T extends string>(value: unknown, key: string, choices: readonly T[], file: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${file}: "${key}" must be one of ${choices.map(choice => `"${choice}"`).join(", ")}`);
	}
	return value as T;
}

/** Reads the config file; a missing file is an empty config, anything malformed throws. */
export function loadConfig(file: string): HomeGuardConfig {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object`);
	const data = raw as Record<string, unknown>;
	const known = new Set(["allowWrite", "protect", "sandbox", "onUnavailable", "bunPath"]);
	const unknown = Object.keys(data).filter(key => !known.has(key));
	if (unknown.length > 0) throw new Error(`${file}: unknown setting ${unknown.map(key => `"${key}"`).join(", ")}`);
	if (data.bunPath !== undefined && (typeof data.bunPath !== "string" || !path.isAbsolute(data.bunPath))) {
		throw new Error(`${file}: "bunPath" must be an absolute path`);
	}
	return {
		allowWrite: stringList(data.allowWrite, "allowWrite", file),
		protect: stringList(data.protect, "protect", file),
		sandbox: oneOf(data.sandbox, "sandbox", ["landlock", "off"] as const, file),
		onUnavailable: oneOf(data.onUnavailable, "onUnavailable", ["warn", "block"] as const, file),
		bunPath: data.bunPath as string | undefined,
	};
}

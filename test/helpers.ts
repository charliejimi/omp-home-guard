import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { HomeGuardOptions } from "../src/index";
import { safeRemove } from "./fixtures";

export const PACKAGE = path.resolve(import.meta.dir, "..");
export const HELPER = path.join(PACKAGE, "src", "sandbox-exec.ts");
export const BUN = process.execPath;

let entries = 0;

/** An extension entry that loads the guard with explicit options and no config file. */
export function writeGuardEntry(dir: string, options: HomeGuardOptions = {}): string {
	fs.mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, `home-guard-${++entries}.ts`);
	const source = [
		`import { createHomeGuard } from ${JSON.stringify(path.join(PACKAGE, "src", "index.ts"))};`,
		`export default createHomeGuard(${JSON.stringify({ configPath: null, ...options }, null, "\t")});`,
		"",
	].join("\n");
	fs.writeFileSync(entry, source);
	return entry;
}

let registry: { auth: AuthStorage; models: ModelRegistry; dir: string } | undefined;

async function models(): Promise<ModelRegistry> {
	if (!registry) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hg-auth-"));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		registry = { auth, models: new ModelRegistry(auth), dir };
	}
	return registry.models;
}

export function closeRegistry(): void {
	if (!registry) return;
	registry.auth.close();
	safeRemove(registry.dir);
	registry = undefined;
}

export interface Notice {
	message: string;
	type: string | undefined;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
	input?: Record<string, unknown>;
}

export interface Guard {
	runner: ExtensionRunner;
	notices: Notice[];
	toolCall(toolName: string, input: Record<string, unknown>): Promise<ToolCallResult | undefined>;
}

/** Loads extension entries through omp's own loader and runner and starts the session in `cwd`. */
export async function loadGuard(paths: string[], cwd: string): Promise<Guard> {
	const result = await discoverAndLoadExtensions(paths, cwd, undefined, undefined, { ambient: false });
	const extensions = result.extensions.filter(ext => paths.includes(ext.path));
	const loadErrors = result.errors.filter(err => paths.includes(err.path));
	if (loadErrors.length > 0 || extensions.length !== paths.length) {
		throw new Error(`extensions did not load: ${JSON.stringify(loadErrors)} (${extensions.length} loaded)`);
	}
	const runner = new ExtensionRunner(extensions, result.runtime, cwd, SessionManager.inMemory(cwd), await models());
	const notices: Notice[] = [];
	const ui = { notify: (message: string, type?: string) => notices.push({ message, type }) };
	const tools = ["read", "write", "edit", "ast_edit", "bash", "eval", "grep", "find"];
	runner.initialize({ getActiveTools: () => tools, getAllTools: () => [] } as never, {} as never, undefined, ui as never, "rpc");
	await runner.emit({ type: "session_start" } as never);
	return {
		runner,
		notices,
		toolCall: (toolName, input) =>
			runner.emitToolCall({ type: "tool_call", toolCallId: "call-1", toolName, input } as never) as Promise<ToolCallResult | undefined>,
	};
}

export interface Ran {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the sandbox helper the way the guard's rewritten command does: from an empty directory. */
export function runHelper(args: string[], options: { cwd: string; env?: Record<string, string | undefined> }): Ran {
	const env = { ...process.env, ...options.env, BUN_OPTIONS: "" };
	const ran = Bun.spawnSync([BUN, "--no-env-file", HELPER, ...args], { cwd: options.cwd, env, stdout: "pipe", stderr: "pipe" });
	return { code: ran.exitCode ?? -1, stdout: ran.stdout?.toString() ?? "", stderr: ran.stderr?.toString() ?? "" };
}

/** Runs a shell command line the way omp's bash tool would, from `cwd`. */
export function runShell(command: string, cwd: string, env?: Record<string, string | undefined>): Ran {
	const ran = Bun.spawnSync(["bash", "-c", command], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	return { code: ran.exitCode ?? -1, stdout: ran.stdout?.toString() ?? "", stderr: ran.stderr?.toString() ?? "" };
}

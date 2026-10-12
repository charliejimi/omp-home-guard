// omp-home-guard: keeps an omp agent from deleting, overwriting, or creating files in the home
// directory outside the project, the temp directories, and the user's allowWrite list.
//   1. A static check of write, edit, ast_edit, bash, and eval calls (every platform).
//   2. On Linux, every bash call runs under a helper that restricts its write rights with Landlock;
//      everything the command starts inherits the restriction.
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { defaultConfigPath, type HomeGuardConfig, loadConfig } from "./config";
import { type Places, places, referencesHome, toolVerdict, type Verdict } from "./policy";
import { launchDirEmpty, prepareSandbox, type ReadySandbox, type Sandbox, wrapCommand } from "./sandbox";

export type { HomeGuardConfig } from "./config";

export interface HomeGuardOptions extends HomeGuardConfig {
	/** The config file to read; `null` reads none. Defaults to `~/.config/omp-home-guard/config.json`. */
	configPath?: string | null;
}

/** Linux limits one argument to 128 KiB; the helper receives the command as one argument. */
const MAX_COMMAND_BYTES = 120_000;

interface Session {
	cwd: string;
	places: Places;
	/** Undefined when the sandbox is off. */
	sandbox?: Sandbox;
}

type Notice = { message: string; type: "info" | "warning" | "error" };

function shown(target: string, home: string): string {
	if (!path.isAbsolute(target)) return target;
	const rel = path.relative(home, target);
	if (rel === "") return "~";
	return rel.startsWith("..") || path.isAbsolute(rel) ? target : `~/${rel}`;
}

function writableList(p: Places): string {
	return p.writable.map(place => shown(place, p.home)).join(", ");
}

function notices(s: Session, config: HomeGuardConfig, configError: string | undefined): Notice[] {
	const out: Notice[] = [];
	const p = s.places;
	if (configError) out.push({ type: "error", message: `omp-home-guard: could not read the config (${configError}); using the defaults.` });
	if (!p.project) {
		out.push({
			type: "warning",
			message: "omp-home-guard: omp is running in your home directory or above it, so nothing in your home directory is writable, not even the current directory. Start omp in a project directory.",
		});
	}
	if (p.ignored.length > 0) {
		out.push({ type: "warning", message: `omp-home-guard: ignored writable places that contain a protected place: ${p.ignored.map(item => shown(item, p.home)).join(", ")}.` });
	}
	const sandbox = s.sandbox;
	if (!sandbox) out.push({ type: "info", message: `omp-home-guard: the sandbox is off; bash runs with static checks only. Writable: ${writableList(p)}.` });
	else if (sandbox.available) {
		out.push({ type: "info", message: `omp-home-guard: bash runs in a Landlock sandbox (ABI ${sandbox.abi}). Writable: ${writableList(p)}; the rest of your home directory is protected.` });
	} else if (sandbox.launchDirty) {
		out.push({ type: "error", message: `omp-home-guard: ${sandbox.reason}; every bash call is blocked until it is empty.` });
	} else if (config.onUnavailable === "block") {
		out.push({ type: "warning", message: `omp-home-guard: the Landlock sandbox is not available (${sandbox.reason}); every bash call is blocked (onUnavailable: "block").` });
	} else {
		out.push({ type: "warning", message: `omp-home-guard: the Landlock sandbox is not available (${sandbox.reason}); bash runs with static checks only.` });
	}
	return out;
}

function blockReason(tool: string, verdict: Exclude<Verdict, { ok: true }>, p: Places): string {
	switch (verdict.rule) {
		case "protected-write":
			return `omp-home-guard blocked ${tool}: it would change ${verdict.target ? shown(verdict.target, p.home) : "a protected place"}, which is in your home directory outside the places this session may change (${writableList(p)}).`;
		case "protected-eval":
			return `omp-home-guard blocked ${tool}: the code refers to your home directory and writes, deletes, or starts processes. ${tool === "eval" ? "eval runs inside omp, outside the sandbox." : ""}`.trim();
		case "unverifiable":
			return `omp-home-guard blocked ${tool}: the sandbox is not running, and the command names a protected place${verdict.target ? ` (${shown(verdict.target, p.home)})` : ""} in a way the static check cannot follow. Change only the project, or turn the sandbox on.`;
	}
}

function stripUndefined<T extends object>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function createHomeGuard(options: HomeGuardOptions = {}) {
	return function homeGuard(pi: ExtensionAPI): void {
		const { configPath = defaultConfigPath(), ...overrides } = options;
		let fileConfig: HomeGuardConfig = {};
		let configError: string | undefined;
		if (configPath !== null) {
			try {
				fileConfig = loadConfig(configPath);
			} catch (err) {
				configError = (err as Error).message;
			}
		}
		const config: HomeGuardConfig = { ...stripUndefined(fileConfig), ...stripUndefined(overrides) };
		let session: Session | undefined;
		const evalHome = new Set<string>();

		const start = (cwd: string): Session => {
			const p = places({ home: os.homedir(), cwd, tmpdir: os.tmpdir(), allowWrite: config.allowWrite, protect: config.protect });
			const sandbox = config.sandbox === "off" ? undefined : prepareSandbox({ bunPath: config.bunPath, writable: p.allowed });
			session = { cwd, places: p, sandbox };
			return session;
		};

		pi.on("session_start", (_event, ctx) => {
			evalHome.clear();
			for (const notice of notices(start(ctx.cwd), config, configError)) ctx.ui.notify(notice.message, notice.type);
		});

		pi.on("tool_call", (event, ctx) => {
			const s = session?.cwd === ctx.cwd ? session : start(ctx.cwd);
			const tool = event.toolName;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const language = typeof input.language === "string" ? input.language : "js";
			if (tool === "eval" && input.reset === true) evalHome.delete(language);
			const verdict = toolVerdict(tool, input, ctx.cwd, s.places, !s.sandbox?.available, tool === "eval" && evalHome.has(language));
			if (!verdict.ok) return { block: true, reason: blockReason(tool, verdict, s.places) };
			if (tool === "eval" && typeof input.code === "string" && referencesHome(input.code, s.places)) evalHome.add(language);
			if (tool !== "bash" || !s.sandbox) return undefined;

			const sandbox = s.sandbox;
			if (!sandbox.available) {
				if (sandbox.launchDirty) return { block: true, reason: `omp-home-guard blocked bash: ${sandbox.reason}, so the sandbox helper could run code from it. Empty it and start a new session.` };
				if (config.onUnavailable === "block") {
					return { block: true, reason: `omp-home-guard blocked bash: the Landlock sandbox is not available (${sandbox.reason}) and onUnavailable is "block".` };
				}
				return undefined;
			}
			const command = typeof input.command === "string" ? input.command : "";
			const bytes = Buffer.byteLength(command);
			if (bytes > MAX_COMMAND_BYTES) {
				return {
					block: true,
					reason: `omp-home-guard blocked bash: the command is too long to run in the sandbox (${bytes} bytes; Linux allows 128 KiB for one argument). Write it to a script file in the project and run that.`,
				};
			}
			if (!launchDirEmpty(sandbox.launchDir)) {
				return {
					block: true,
					reason: `omp-home-guard blocked bash: the launch directory ${sandbox.launchDir} is not empty, so the sandbox helper could run code from it. Empty it and start a new session.`,
				};
			}
			return { input: { ...input, command: wrapCommand(command, sandbox as ReadySandbox, s.places.allowed) } };
		});
	};
}

export default createHomeGuard();

// The guard's side of the sandbox: at session start, a private copy of the helper, an empty launch
// directory, and a probe run; for every bash call, the rewritten command that runs under the helper.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Sandbox {
	available: boolean;
	/** Why the sandbox is not available. */
	reason?: string;
	/** The launch directory is not empty, so bash calls are blocked whatever `onUnavailable` says. */
	launchDirty?: boolean;
	abi?: number;
	bun?: string;
	helper?: string;
	launchDir: string;
}

export type ReadySandbox = Sandbox & { available: true; bun: string; helper: string };

const HELPER_FILES = ["landlock.ts", "sandbox-exec.ts"];

/** The guard's state directory. Fixed under the home directory, so a project's environment cannot move it. */
export function stateDir(home = os.homedir()): string {
	return path.join(home, ".local", "state", "omp-home-guard");
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The Bun that runs the helper: `bunPath`, else the Bun running omp, else Bun on PATH; never one in a writable place. */
function findBun(configured: string | undefined, writable: readonly string[]): { bun?: string; reason?: string } {
	const candidates = configured
		? [configured]
		: [/^bun(\.exe)?$/.test(path.basename(process.execPath)) ? process.execPath : undefined, Bun.which("bun") ?? undefined];
	for (const candidate of candidates) {
		if (!candidate) continue;
		let real: string;
		try {
			real = fs.realpathSync(candidate);
			fs.accessSync(real, fs.constants.X_OK);
		} catch {
			if (configured) return { reason: `bunPath ${configured} is not an executable file` };
			continue;
		}
		if (writable.some(place => isInside(real, place))) return { reason: `the Bun executable ${real} is in a place this session may change` };
		return { bun: real };
	}
	return { reason: "no Bun executable was found (set bunPath in the config)" };
}

/** Copies the helper into `<state>/helper/<content hash>/` unless an identical copy is there; returns the copy's entry. */
function installHelper(state: string): string {
	const sources = HELPER_FILES.map(name => ({ name, text: fs.readFileSync(path.join(import.meta.dir, name)) }));
	const hash = createHash("sha256");
	for (const source of sources) hash.update(`${source.name}\0`).update(source.text);
	const digest = hash.digest("hex").slice(0, 16);
	const root = path.join(state, "helper");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const holdsCopy = (dir: string) =>
		sources.every(source => {
			try {
				return fs.readFileSync(path.join(dir, source.name)).equals(source.text);
			} catch {
				return false;
			}
		});
	const dir = path.join(root, digest);
	if (holdsCopy(dir)) return path.join(dir, "sandbox-exec.ts");
	const fresh = fs.mkdtempSync(path.join(root, `${digest}-`));
	for (const source of sources) fs.writeFileSync(path.join(fresh, source.name), source.text, { mode: 0o444 });
	try {
		fs.renameSync(fresh, dir);
		return path.join(dir, "sandbox-exec.ts");
	} catch {
		if (!holdsCopy(dir)) return path.join(fresh, "sandbox-exec.ts");
		for (const source of sources) fs.unlinkSync(path.join(fresh, source.name));
		fs.rmdirSync(fresh);
		return path.join(dir, "sandbox-exec.ts");
	}
}

export function launchDirEmpty(dir: string): boolean {
	try {
		return fs.readdirSync(dir).length === 0;
	} catch {
		return false;
	}
}

function firstLine(output: Buffer | undefined): string {
	return (output?.toString() ?? "").trim().split("\n")[0]?.replace(/^omp-home-guard: /, "") ?? "";
}

/** Prepares the sandbox and runs the helper's probe; the sandbox is available only when the probe succeeds. */
export function prepareSandbox(options: { bunPath?: string; writable: readonly string[]; home?: string }): Sandbox {
	const state = stateDir(options.home);
	const launchDir = path.join(state, "launch");
	if (process.platform !== "linux") return { available: false, reason: "Landlock is only available on Linux", launchDir };
	try {
		fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 });
	} catch (err) {
		return { available: false, reason: `could not create ${launchDir} (${(err as NodeJS.ErrnoException).code})`, launchDir };
	}
	if (!launchDirEmpty(launchDir)) return { available: false, launchDirty: true, reason: `the launch directory ${launchDir} is not empty`, launchDir };
	const { bun, reason } = findBun(options.bunPath, options.writable);
	if (!bun) return { available: false, reason, launchDir };
	let helper: string;
	try {
		helper = installHelper(state);
	} catch (err) {
		return { available: false, reason: `could not install the helper (${(err as Error).message})`, launchDir, bun };
	}
	const probe = Bun.spawnSync([bun, "--cwd", launchDir, "--no-env-file", helper, "--probe"], {
		cwd: launchDir,
		env: { ...process.env, BUN_OPTIONS: "" },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	});
	const abi = /^landlock (\d+)\n$/.exec(probe.stdout?.toString() ?? "")?.[1];
	if (probe.exitCode !== 0 || !abi) {
		return { available: false, reason: firstLine(probe.stderr) || `the helper's probe failed (exit ${probe.exitCode})`, launchDir, bun, helper };
	}
	return { available: true, abi: Number(abi), bun, helper, launchDir };
}

/** POSIX single quotes: one shell word with no expansion. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// Must match omp 18.2.8's pattern and quote rule (tools/bash-skill-urls.ts), so the rewritten
// command leaves expandable exactly the internal URLs omp would have expanded in the original.
const INTERNAL_URL =
	/'(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local|attachment):\/\/[^\s'")`\\;&|<>($]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\;&|<>($]+/g;

function insideShellQuote(command: string, index: number): boolean {
	type Quote = "'" | '"' | undefined;
	let quote: Quote;
	const substitutions: Array<{ kind: "dollar" | "backtick"; outerQuote: Quote; depth: number }> = [];
	for (let i = 0; i < index; i++) {
		const char = command[i];
		const top = substitutions.at(-1);
		if (char === "\\" && command[i + 1] === '"' && quote !== "'" && top?.kind === "backtick" && top.outerQuote === '"') {
			quote = quote === '"' ? undefined : '"';
			i++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (char === "'" && quote !== '"') {
			quote = quote === "'" ? undefined : "'";
			continue;
		}
		if (char === '"' && quote !== "'") {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (char === "$" && command[i + 1] === "(" && quote !== "'") {
			substitutions.push({ kind: "dollar", outerQuote: quote, depth: 1 });
			quote = undefined;
			i++;
			continue;
		}
		if (char === "`" && quote !== "'") {
			if (top?.kind === "backtick") {
				substitutions.pop();
				quote = top.outerQuote;
			} else {
				substitutions.push({ kind: "backtick", outerQuote: quote, depth: 0 });
				quote = undefined;
			}
			continue;
		}
		if (quote !== undefined || top?.kind !== "dollar") continue;
		if (char === "(") top.depth++;
		else if (char === ")") {
			top.depth--;
			if (top.depth === 0) quote = substitutions.pop()?.outerQuote;
		}
	}
	return quote !== undefined;
}

/**
 * Quotes `command` as one shell word. Internal URLs omp would expand in the original become quoted
 * pieces of their own, which omp still expands; the shell joins the pieces back into one word.
 */
export function quoteCommand(command: string): string {
	let quoted = "";
	let last = 0;
	for (const match of command.matchAll(INTERNAL_URL)) {
		const token = match[0];
		const index = match.index!;
		const wrapped = token.startsWith("'") || token.startsWith('"');
		if (!wrapped && insideShellQuote(command, index)) continue;
		if (index > last) quoted += shellQuote(command.slice(last, index));
		quoted += `'${wrapped ? token.slice(1, -1) : token}'`;
		last = index + token.length;
	}
	if (last < command.length || quoted === "") quoted += shellQuote(command.slice(last));
	return quoted;
}

/**
 * The command omp runs instead of `command`: Bun starts the helper copy from the empty launch
 * directory with `BUN_OPTIONS` cleared (the helper restores it), and the helper runs `command` in
 * the call's own directory (`$PWD`, which omp sets for every call) under the restriction.
 */
export function wrapCommand(command: string, sandbox: ReadySandbox, allowed: readonly string[]): string {
	return [
		'OMP_HOME_GUARD_BUN_OPTIONS="${BUN_OPTIONS-}"',
		"BUN_OPTIONS=",
		shellQuote(sandbox.bun),
		"--cwd",
		shellQuote(sandbox.launchDir),
		"--no-env-file",
		shellQuote(sandbox.helper),
		"--cwd",
		'"$PWD"',
		...allowed.flatMap(dir => ["--allow", shellQuote(dir)]),
		"--dev",
		"--",
		quoteCommand(command),
	].join(" ");
}

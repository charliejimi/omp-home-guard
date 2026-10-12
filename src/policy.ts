// Pure decisions for the guard: which places are writable, where a tool call would write, and a
// static reading of bash commands and eval code. Nothing here imports omp.
import * as fs from "node:fs";
import * as path from "node:path";

export interface Places {
	home: string;
	/** The session's project when it is writable: not the home directory or a directory above it. */
	project?: string;
	/** Writable places, as given and as real paths. None of them contains a protected place. */
	allowed: string[];
	/** The writable places as given, for messages. */
	writable: string[];
	/** The home directory and `protect`, as given and as real paths. */
	protected: string[];
	/** Places that would have been writable but contain a protected place, so they are ignored. */
	ignored: string[];
}

export interface PlaceInputs {
	home: string;
	cwd: string;
	tmpdir: string;
	allowWrite?: readonly string[];
	protect?: readonly string[];
}

const SYSTEM_TEMP = ["/tmp", "/dev/shm"];

/** Replaces a leading `~`, `$HOME`, or `${HOME}` with the home directory. */
export function expandHome(word: string, home: string): string {
	const prefix = /^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/.exec(word);
	return prefix ? home + word.slice(prefix[0].length) : word;
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The real path of `abs`, following symlinks on the part of it that exists. */
export function realPathOf(abs: string): string {
	const tail: string[] = [];
	let current = abs;
	for (let depth = 0; depth < 64; depth++) {
		try {
			const real = fs.realpathSync(current);
			return tail.length > 0 ? path.join(real, ...tail) : real;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return abs;
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
	return abs;
}

function forms(abs: string): string[] {
	const real = realPathOf(abs);
	return real === abs ? [abs] : [abs, real];
}

const unique = (list: string[]) => [...new Set(list)];

export function places(input: PlaceInputs): Places {
	const home = path.resolve(input.home);
	const cwd = path.resolve(input.cwd);
	const resolve = (value: string) => path.resolve(cwd, expandHome(value, home));
	const protectedRoots = unique([home, ...(input.protect ?? []).map(resolve)].flatMap(forms));
	const homeForms = forms(home);
	const project = forms(cwd).some(form => homeForms.some(h => isInside(h, form))) ? undefined : cwd;
	const candidates = unique([...(project ? [project] : []), path.resolve(input.tmpdir), ...SYSTEM_TEMP, ...(input.allowWrite ?? []).map(resolve)]);
	const allowed: string[] = [];
	const writable: string[] = [];
	const ignored: string[] = [];
	for (const candidate of candidates) {
		const variants = forms(candidate);
		if (variants.some(form => protectedRoots.some(root => isInside(root, form)))) ignored.push(candidate);
		else {
			writable.push(candidate);
			allowed.push(...variants);
		}
	}
	return { home, project, allowed: unique(allowed), writable, protected: protectedRoots, ignored };
}

function resolveTarget(target: string, base: string, p: Places): string {
	return path.resolve(base, expandHome(target, p.home));
}

/** Whether writing `target` (resolved against `base`) would change a protected place, through symlinks too. */
export function isProtected(target: string, base: string, p: Places): boolean {
	return forms(resolveTarget(target, base, p)).some(
		form => p.protected.some(root => isInside(form, root)) && !p.allowed.some(place => isInside(form, place)),
	);
}

/** Whether `target` is a protected place or a directory above one, so removing or moving it removes one. */
function containsProtected(target: string, base: string, p: Places): boolean {
	return forms(resolveTarget(target, base, p)).some(form => p.protected.some(root => isInside(root, form)));
}

function asStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

/** The paths a write, edit, or ast_edit call would write; `undefined` for other tools. */
export function writeTargets(toolName: string, input: Record<string, unknown>): string[] | undefined {
	switch (toolName) {
		case "write":
			return asStrings(input.path);
		case "edit": {
			const targets = asStrings(input.path);
			if (Array.isArray(input.edits)) {
				for (const edit of input.edits) {
					if (edit && typeof edit === "object") {
						for (const field of ["rename", "move", "moveTo", "to"]) targets.push(...asStrings((edit as Record<string, unknown>)[field]));
					}
				}
			}
			for (const text of [...asStrings(input.input), ...asStrings(input.patch)]) {
				for (const match of text.matchAll(PATCH_FILE_LINE)) targets.push(match[1]!);
			}
			return targets;
		}
		case "ast_edit":
			return asStrings(input.paths).flatMap(entry => entry.split(";").map(item => item.trim()).filter(Boolean));
		default:
			return undefined;
	}
}

const GLOB_CHARS = /[*?[{]/;

function isDirectory(abs: string): boolean {
	try {
		return fs.statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

/** For ast_edit: whether the file, directory, or glob could reach into a protected place. */
function astEditTouches(target: string, base: string, p: Places): boolean {
	const globAt = target.search(GLOB_CHARS);
	const staticPart = globAt < 0 ? target : target.slice(0, globAt);
	const dir = globAt < 0 ? target : staticPart.endsWith("/") || staticPart === "" ? staticPart || "." : path.dirname(staticPart);
	if (isProtected(dir, base, p)) return true;
	const recursive = globAt < 0 ? isDirectory(resolveTarget(target, base, p)) : target.includes("**");
	return recursive && containsProtected(dir, base, p);
}

// ---- bash ---------------------------------------------------------------------------------------

interface Segment {
	words: string[];
	/** Targets of output redirects (`>`, `>>`, `&>`, `>|`, `<>`). */
	writes: string[];
	/** Contains command or process substitution, so its effect cannot be read statically. */
	opaque: boolean;
}

/** Splits a command into simple commands, honoring quotes and skipping here-document bodies. */
export function parseCommand(command: string): Segment[] {
	const segments: Segment[] = [];
	let current: Segment = { words: [], writes: [], opaque: false };
	let word = "";
	let hasWord = false;
	let next: "word" | "write" | "data" = "word";
	let heredocStart: { strip: boolean } | undefined;
	const heredocs: Array<{ delimiter: string; strip: boolean }> = [];
	const pushWord = () => {
		if (hasWord) {
			if (heredocStart) {
				heredocs.push({ delimiter: word, strip: heredocStart.strip });
				heredocStart = undefined;
			} else if (next === "write") current.writes.push(word);
			else if (next === "word") current.words.push(word);
			next = "word";
		}
		word = "";
		hasWord = false;
	};
	const endSegment = () => {
		pushWord();
		next = "word";
		if (current.words.length > 0 || current.writes.length > 0 || current.opaque) segments.push(current);
		current = { words: [], writes: [], opaque: false };
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		const after = command[i + 1];
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			word += command.slice(i + 1, end < 0 ? command.length : end);
			hasWord = true;
			i = end < 0 ? command.length : end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\" && j + 1 < command.length) j++;
				else if (command[j] === "$" && command[j + 1] === "(") current.opaque = true;
				else if (command[j] === "`") current.opaque = true;
				word += command[j];
				j++;
			}
			hasWord = true;
			i = j;
			continue;
		}
		if (c === "\\" && after !== undefined) {
			if (after !== "\n") {
				word += after;
				hasWord = true;
			}
			i++;
			continue;
		}
		if (c === "`" || (c === "$" && after === "(") || ((c === "<" || c === ">") && after === "(")) {
			current.opaque = true;
			word += c;
			hasWord = true;
			continue;
		}
		if (c === "\n") {
			endSegment();
			for (const { delimiter, strip } of heredocs.splice(0)) {
				while (i < command.length) {
					const start = i + 1;
					const end = command.indexOf("\n", start) < 0 ? command.length : command.indexOf("\n", start);
					const line = command.slice(start, end);
					i = end;
					if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
				}
			}
			continue;
		}
		if (c === ";" || c === "|" || (c === "&" && after !== ">")) {
			endSegment();
			if ((c === "|" || c === "&") && (after === c || after === "&")) i++;
			continue;
		}
		if (c === " " || c === "\t") {
			pushWord();
			continue;
		}
		if (c === ">" || (c === "&" && after === ">")) {
			if (/^\d+$/.test(word)) {
				word = "";
				hasWord = false;
			} else pushWord();
			let j = c === "&" ? i + 2 : i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&") {
				i = j;
				while (i + 1 < command.length && /[0-9-]/.test(command[i + 1]!)) i++;
				continue;
			}
			next = "write";
			i = j - 1;
			continue;
		}
		if (c === "<") {
			if (/^\d+$/.test(word)) {
				word = "";
				hasWord = false;
			} else pushWord();
			if (after === "<" && command[i + 2] === "<") {
				i += 2;
				next = "data";
			} else if (after === "<") {
				i++;
				const strip = command[i + 1] === "-";
				if (strip) i++;
				heredocStart = { strip };
			} else if (after === "&") {
				i++;
				while (i + 1 < command.length && /[0-9-]/.test(command[i + 1]!)) i++;
			} else if (after === ">") {
				i++;
				next = "write";
			} else next = "data";
			continue;
		}
		word += c;
		hasWord = true;
	}
	endSegment();
	return segments;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const KEYWORDS = new Set(["!", "{", "(", "if", "then", "else", "elif", "while", "until", "do"]);
const WRAPPERS = new Set(["env", "command", "builtin", "nohup", "time", "exec", "sudo", "doas", "nice", "ionice", "timeout", "stdbuf", "chronic", "unbuffer"]);

interface Command {
	name: string;
	args: string[];
	assignments: string[];
}

function commandOf(words: readonly string[]): Command {
	const assignments: string[] = [];
	let at = 0;
	for (;;) {
		while (at < words.length && KEYWORDS.has(words[at]!)) at++;
		while (at < words.length && ASSIGNMENT.test(words[at]!)) assignments.push(words[at++]!);
		const wrapper = words[at] !== undefined && WRAPPERS.has(path.basename(words[at]!));
		if (!wrapper) break;
		at++;
		while (at < words.length && (words[at]!.startsWith("-") || /^\d/.test(words[at]!))) at++;
	}
	return { name: words[at] ?? "", args: words.slice(at + 1), assignments };
}

const READ_ONLY = new Set([
	"cat", "less", "more", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "ls", "tree", "file", "stat", "du", "df",
	"sha256sum", "sha1sum", "sha512sum", "md5sum", "shasum", "b2sum", "cksum", "diff", "cmp", "readlink", "realpath", "basename",
	"dirname", "pwd", "echo", "printf", "true", "false", "test", "[", "[[", "jq", "sort", "uniq", "cut", "tr", "nl", "od", "xxd",
	"hexdump", "strings", "column", "type", "which", "printenv", "id", "whoami", "uname", "date", "sleep", "hostname", "popd",
	"done", "fi", "}", ")", "esac", "wait", "exit", "return", "set", "shopt", "unset", "shift",
]);
const XARGS_VALUE_OPTIONS = new Set(["-I", "-i", "-d", "-E", "-e", "-L", "-l", "-n", "-P", "-s", "-a", "--replace", "--delimiter", "--max-args", "--max-procs", "--arg-file"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "ls-files", "grep", "blame", "rev-parse", "cat-file", "branch", "describe", "remote", "config"]);
const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const ALL_OPERANDS = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "touch", "mkdir", "chmod", "chown", "chgrp", "chattr", "setfacl", "tee", "mkfifo", "mknod", "mv", "sponge"]);
const DESTINATION = new Set(["cp", "install", "ln", "rsync", "scp"]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "shred", "mv", "chmod", "chown", "chgrp", "chattr", "setfacl", "find", "rsync", "git"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const CODE_RUNNERS = new Set(["python", "python3", "node", "bun", "deno", "perl", "ruby", "php"]);
const CODE_FLAGS = new Set(["-c", "-e", "-E", "-p", "--eval", "--print", "-r"]);
const DECLARERS = new Set(["export", "declare", "local", "readonly", "typeset"]);

function operands(args: readonly string[]): string[] {
	const out: string[] = [];
	let ended = false;
	for (const arg of args) {
		if (!ended && arg === "--") ended = true;
		else if (ended || !arg.startsWith("-") || arg === "-") out.push(arg);
	}
	return out;
}

/** The value of an option given as `-o value`, `--long value`, or `--long=value`. */
function optionValues(args: readonly string[], short: readonly string[], long: readonly string[]): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const eq = long.find(name => arg.startsWith(`${name}=`));
		if (eq) values.push(arg.slice(eq.length + 1));
		else if ((short.includes(arg) || long.includes(arg)) && args[i + 1] !== undefined) values.push(args[++i]!);
	}
	return values;
}

const isRemote = (value: string) => /^[^/]*:/.test(value) && !value.startsWith("./");

/** Where a known writer would write; `undefined` when the command is not a known writer. */
function writerTargets(name: string, args: readonly string[]): string[] | undefined {
	const exe = path.basename(name);
	if (ALL_OPERANDS.has(exe)) return operands(args);
	if (DESTINATION.has(exe)) {
		const into = optionValues(args, ["-t"], ["--target-directory"]);
		if (into.length > 0) return into;
		const all = operands(args);
		if (all.length === 0) return [];
		if (all.length === 1) return ["."];
		const destination = all.at(-1)!;
		return isRemote(destination) ? [] : [destination];
	}
	switch (exe) {
		case "dd":
			return args.filter(arg => arg.startsWith("of=")).map(arg => arg.slice(3));
		case "sed":
		case "perl":
			return args.some(arg => arg.startsWith("--in-place") || /^-[A-Za-z]*i/.test(arg)) ? operands(args) : undefined;
		case "find": {
			if (!args.some(arg => FIND_ACTIONS.test(arg))) return undefined;
			const starts: string[] = [];
			for (const arg of args) {
				if (arg.startsWith("-") || arg === "(" || arg === "!" || arg === ")") break;
				starts.push(arg);
			}
			return starts.length > 0 ? starts : ["."];
		}
		case "git": {
			let at = 0;
			let dir = ".";
			while (at < args.length && args[at]!.startsWith("-")) {
				const arg = args[at]!;
				if ((arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") && args[at + 1] !== undefined) {
					const value = args[at + 1]!;
					if (arg === "-C") dir = path.isAbsolute(value) || value.startsWith("~") || value.startsWith("$") ? value : path.join(dir, value);
					if (arg === "--work-tree") dir = value;
					at += 2;
				} else {
					if (arg.startsWith("--work-tree=")) dir = arg.slice("--work-tree=".length);
					at++;
				}
			}
			const sub = args[at];
			if (sub === undefined || READ_ONLY_GIT.has(sub)) return undefined;
			if (sub === "clone") {
				const rest = operands(args.slice(at + 1));
				return [rest.length > 1 ? path.join(dir, rest[1]!) : dir];
			}
			return [dir];
		}
		case "tar": {
			const bundle = args[0] ?? "";
			const extract = args.some(arg => arg === "--extract" || arg === "--get") || /^-?[A-Za-z]*x/.test(bundle);
			const create = args.some(arg => arg === "--create") || /^-?[A-Za-z]*[cru]/.test(bundle);
			const dir = optionValues(args, ["-C"], ["--directory"]);
			return [...(extract ? (dir.length > 0 ? dir : ["."]) : []), ...(create ? optionValues(args, ["-f"], ["--file"]) : [])];
		}
		case "unzip": {
			const dir = optionValues(args, ["-d"], []);
			return dir.length > 0 ? dir : ["."];
		}
		case "curl": {
			const out = [...optionValues(args, ["-o"], ["--output"]), ...optionValues(args, [], ["--output-dir"])];
			return args.some(arg => arg === "-O" || arg === "--remote-name") ? [...out, "."] : out;
		}
		case "wget": {
			const out = [...optionValues(args, ["-O"], ["--output-document"]), ...optionValues(args, ["-P"], ["--directory-prefix"])];
			return out.length > 0 ? out : ["."];
		}
		default:
			return undefined;
	}
}

function isReadOnly(name: string, args: readonly string[]): boolean {
	const exe = path.basename(name);
	if (exe === "git") return writerTargets(exe, args) === undefined;
	if (exe === "find") return !args.some(arg => FIND_ACTIONS.test(arg));
	return READ_ONLY.has(exe);
}

export type Verdict = { ok: true } | { ok: false; rule: "protected-write" | "protected-eval" | "unverifiable"; target?: string };

const OK: Verdict = { ok: true };

interface BashState {
	p: Places;
	strict: boolean;
	base: string;
	tainted: Set<string>;
	/** Some word in the whole command names a protected place. */
	mentions: boolean;
}

function referencesTainted(word: string, tainted: ReadonlySet<string>): boolean {
	for (const name of tainted) if (new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(word)) return true;
	return false;
}

type Judgement = "protected" | "unknown" | "safe";

/** Whether a word used as a write target names a protected place. */
function judge(raw: string, state: BashState, destructive: boolean): Judgement {
	const { p, base } = state;
	const word = expandHome(raw, p.home).replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, p.home);
	if (referencesTainted(word, state.tainted)) return "protected";
	if (word.includes("$") || word.includes("`")) return "unknown";
	const globAt = word.search(/[*?[]/);
	if (globAt >= 0) {
		const prefix = word.slice(0, globAt);
		const dir = prefix === "" ? "." : prefix.endsWith("/") ? prefix : path.dirname(prefix);
		return isProtected(dir, base, p) || containsProtected(dir, base, p) ? "protected" : "safe";
	}
	if (isProtected(word, base, p)) return "protected";
	return destructive && containsProtected(word, base, p) ? "protected" : "safe";
}

function namesProtected(word: string, state: BashState): boolean {
	const value = /^--?[A-Za-z0-9-]+=(.*)$/s.exec(word)?.[1] ?? ASSIGNMENT.exec(word)?.[2] ?? word;
	return judge(value, state, false) === "protected";
}

/** The command xargs or parallel runs: the first word after their own options. */
function xargsCommand(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (XARGS_VALUE_OPTIONS.has(arg)) i++;
		else if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}

function taint(assignment: string, state: BashState): void {
	const match = ASSIGNMENT.exec(assignment);
	if (match && namesProtected(match[2]!, state)) state.tainted.add(match[1]!);
}

/** A static reading of a bash command: allowed unless it would write into a protected place. */
export function bashVerdict(command: string, cwd: string, p: Places, strict: boolean, depth = 0): Verdict {
	const segments = parseCommand(command);
	const state: BashState = { p, strict, base: cwd, tainted: new Set(), mentions: false };
	state.mentions = segments.some(segment => [...segment.words, ...segment.writes].some(word => namesProtected(word, state)));
	for (const segment of segments) {
		const { name, args, assignments } = commandOf(segment.words);
		const exe = path.basename(name);
		for (const assignment of assignments) taint(assignment, state);
		if (DECLARERS.has(exe)) for (const arg of args) taint(arg, state);
		if (exe === "for" && args[1] === "in" && args.slice(2).some(word => namesProtected(word, state))) state.tainted.add(args[0]!);

		for (const target of segment.writes) {
			const verdict = judge(target, state, false);
			if (verdict === "protected") return { ok: false, rule: "protected-write", target };
			if (verdict === "unknown" && strict && state.mentions) return { ok: false, rule: "unverifiable", target };
		}
		const baseProtected = isProtected(".", state.base, p);

		if (exe === "cd" || exe === "pushd") {
			const target = operands(args)[0];
			if (target === undefined || target === "-" || target.includes("$") || target.includes("`")) {
				state.base = target === undefined || target === "-" || /\$\{?HOME\b/.test(target) || referencesTainted(target, state.tainted) ? p.home : state.base;
			} else state.base = resolveTarget(target, state.base, p);
			continue;
		}
		if (name === "" || isReadOnly(name, args)) continue;

		const targets = writerTargets(name, args);
		if (targets) {
			const destructive = DESTRUCTIVE.has(exe);
			for (const target of targets) {
				const verdict = judge(target, state, destructive);
				if (verdict === "protected") return { ok: false, rule: "protected-write", target };
				if (verdict === "unknown" && strict && (state.mentions || baseProtected)) return { ok: false, rule: "unverifiable", target };
			}
			continue;
		}

		if (SHELLS.has(exe) || exe === "eval" || exe === "trap") {
			const code = exe === "eval" ? args.join(" ") : exe === "trap" ? args[0] : optionValues(args, ["-c"], [])[0];
			if (code !== undefined && depth < 3) {
				const inner = bashVerdict(code, state.base, p, strict, depth + 1);
				if (!inner.ok) return inner;
				continue;
			}
		}
		if (CODE_RUNNERS.has(exe)) {
			for (let i = 0; i < args.length; i++) {
				if (CODE_FLAGS.has(args[i]!) && args[i + 1] !== undefined && !evalVerdict(args[i + 1]!, p).ok) return { ok: false, rule: "protected-eval" };
			}
		}
		if (exe === "xargs" || exe === "parallel") {
			const inner = xargsCommand(args);
			const writer = inner !== undefined && (ALL_OPERANDS.has(path.basename(inner)) || DESTINATION.has(path.basename(inner)));
			if (state.mentions && (writer || strict)) return { ok: false, rule: writer ? "protected-write" : "unverifiable" };
			continue;
		}
		if (strict && (baseProtected || args.some(arg => namesProtected(arg, state)) || namesProtected(name, state) || (segment.opaque && state.mentions))) {
			return { ok: false, rule: "unverifiable", target: args.find(arg => namesProtected(arg, state)) };
		}
	}
	return OK;
}

// ---- eval ---------------------------------------------------------------------------------------

const HOME_API =
	/\bhomedir\s*\(|expanduser|Path\.home\s*\(|\$HOME\b|\$\{HOME\}|process\.env\.HOME\b|process\.env\[\s*["']HOME["']\s*\]|Bun\.env\.HOME\b|os\.environ(?:\.get)?\s*[[(]\s*["']HOME["']|getenv\s*\(\s*["']HOME["']|["'`]~(?:\/|["'`])/;
const FILE_WRITES =
	/\b(?:rmSync|rm|rmdir|rmdirSync|unlink|unlinkSync|rmtree|remove|removedirs|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|cpSync|cp|rename|renameSync|truncate|truncateSync|mkdir|mkdirSync|makedirs|symlink|symlinkSync|chmod|chmodSync|chown|chownSync|createWriteStream|write_text|write_bytes|touch|move|copy|copyfile|copy2|copytree)\s*\(|Bun\.write\s*\(|\bopen(?:Sync)?\s*\([^)]*,\s*["'][^"']*[wax+]/;
const PROCESSES =
	/\b(?:execSync|execFileSync|spawnSync|spawn|execFile|popen)\s*\(|\b(?:child_process|subprocess|os|cp)\.(?:exec|system|run|call|check_call|check_output|Popen)\s*\(|Bun\.(?:\$|spawn|spawnSync)\b|\$`/;
const PATH_LITERAL = /["'`]((?:\/|~\/)[^"'`\n]*)["'`]/g;

/** Whether eval code refers to the home directory: through an API, or a literal path in a protected place. */
export function referencesHome(code: string, p: Places): boolean {
	if (HOME_API.test(code)) return true;
	for (const match of code.matchAll(PATH_LITERAL)) if (isProtected(match[1]!, p.home, p)) return true;
	return false;
}

/**
 * Eval code runs inside omp, outside any sandbox, so code that refers to the home directory and
 * writes or deletes files is blocked. `carried`: an earlier call in the same kernel referred to it.
 */
export function evalVerdict(code: string, p: Places, carried = false): Verdict {
	return (carried || referencesHome(code, p)) && (FILE_WRITES.test(code) || PROCESSES.test(code)) ? { ok: false, rule: "protected-eval" } : OK;
}

// ---- every tool ---------------------------------------------------------------------------------

/** The static verdict for one tool call. `strict`: no sandbox stands behind this check. */
export function toolVerdict(toolName: string, input: Record<string, unknown>, cwd: string, p: Places, strict: boolean, evalCarried = false): Verdict {
	const targets = writeTargets(toolName, input);
	if (targets) {
		for (const target of targets) {
			if (toolName === "ast_edit" ? astEditTouches(target, cwd, p) : isProtected(target, cwd, p)) return { ok: false, rule: "protected-write", target };
		}
		return OK;
	}
	if (toolName === "bash") {
		const given = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
		// omp resolves internal URLs (skill://…) in cwd itself; the directory is unknown here, so assume the home directory.
		const base = given === undefined ? cwd : /^[a-z]+:\/\//.test(given) || given.startsWith("local:") ? p.home : resolveTarget(given, cwd, p);
		return bashVerdict(typeof input.command === "string" ? input.command : "", base, p, strict);
	}
	if (toolName === "eval") return evalVerdict(typeof input.code === "string" ? input.code : "", p, evalCarried);
	return OK;
}

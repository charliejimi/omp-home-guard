// The sandbox helper. The guard's rewritten bash command starts it with Bun from an empty directory:
//   sandbox-exec --cwd <dir> --allow <dir>... [--dev] -- <command>
// It restricts its own write rights with Landlock to the --allow places (and device files under
// /dev with --dev), changes to <dir>, and replaces itself with `bash -c <command>`, so the command
// and everything it starts can write only there. When it cannot do all of that it exits 126 and
// runs nothing.
//   sandbox-exec --probe    restricts itself, prints "landlock <abi>", and exits 0.
import { execve, type Rule, restrictWrites } from "./landlock";

const NOT_RUN = 126;
const SAVED_BUN_OPTIONS = "OMP_HOME_GUARD_BUN_OPTIONS";

function fail(message: string, code = NOT_RUN): never {
	process.stderr.write(`omp-home-guard: ${message}; the command was not run.\n`);
	process.exit(code);
}

const argv = process.argv.slice(2);

if (argv[0] === "--probe" && argv.length === 1) {
	try {
		const { abi } = restrictWrites([]);
		process.stdout.write(`landlock ${abi}\n`);
		process.exit(0);
	} catch (err) {
		process.stderr.write(`omp-home-guard: ${(err as Error).message}\n`);
		process.exit(1);
	}
}

let cwd: string | undefined;
let command: string | undefined;
let dev = false;
const allow: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]!;
	if (arg === "--") {
		if (argv.length !== i + 2) fail("expected exactly one command after --");
		command = argv[i + 1];
		break;
	}
	if (arg === "--dev") dev = true;
	else if ((arg === "--cwd" || arg === "--allow") && argv[i + 1]?.startsWith("/")) {
		if (arg === "--cwd") cwd = argv[++i];
		else allow.push(argv[++i]!);
	} else fail(`unexpected argument ${JSON.stringify(arg)} (paths must be absolute)`);
}
if (cwd === undefined || command === undefined) fail("usage: sandbox-exec --cwd <dir> --allow <dir>... [--dev] -- <command>");

const rules: Rule[] = allow.map(path => ({ path, access: "write" }));
if (dev) rules.push({ path: "/dev", access: "device" });
try {
	restrictWrites(rules);
} catch (err) {
	fail(`could not restrict writes with Landlock (${(err as Error).message})`);
}
try {
	process.chdir(cwd);
} catch (err) {
	fail(`could not change to ${cwd} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
}

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (value !== undefined && key !== SAVED_BUN_OPTIONS && key !== "BUN_OPTIONS") env[key] = value;
}
const saved = process.env[SAVED_BUN_OPTIONS];
if (saved) env.BUN_OPTIONS = saved;
env.PWD = cwd;

const bash = Bun.which("bash", { PATH: env.PATH ?? "/usr/bin:/bin" });
const shell = bash ?? "/bin/sh";
const error = execve(shell, [bash ? "bash" : "sh", "-c", command], env);
fail(`could not start ${shell} (${error.message})`, 127);

// Runs `bun test` with HOME, TMPDIR, and omp's agent directory inside one temporary root created
// here. Bun fixes os.homedir() and os.tmpdir() when a process starts, so a preload that changes
// HOME is too late; this runner sets them before Bun starts, and test/setup.ts refuses to run
// otherwise. Arguments are passed to `bun test`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hg-suite-")));
const home = path.join(root, "home");
const tmp = path.join(root, "tmp");
fs.mkdirSync(home);
fs.mkdirSync(tmp);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (value === undefined || key.startsWith("XDG_") || key === "CLAUDE_CONFIG_DIR" || key === "USERPROFILE") continue;
	env[key] = value;
}
Object.assign(env, { HOME: home, TMPDIR: tmp, PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"), HG_TEST_ROOT: root });

const child = Bun.spawn(["bun", "test", ...process.argv.slice(2)], { cwd: path.resolve(import.meta.dir, ".."), env, stdio: ["inherit", "inherit", "inherit"] });
const code = await child.exited;
fs.rmSync(root, { recursive: true, force: true });
process.exit(code);

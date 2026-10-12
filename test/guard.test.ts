import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandInternalUrls } from "@oh-my-pi/pi-coding-agent/tools/bash-skill-urls";
import { loadConfig } from "../src/config";
import { homeCanary, makeProject, type Project, removeCreated, safeRemove, tempDir, writeFile } from "./fixtures";
import { closeRegistry, type Guard, loadGuard, PACKAGE, runHelper, runShell, writeGuardEntry } from "./helpers";

const landlock = runHelper(["--probe"], { cwd: process.cwd() }).code === 0;
const STATE = path.join(os.homedir(), ".local", "state", "omp-home-guard");

let entries: string;
let project: Project;
let canary: string;

beforeAll(() => {
	entries = tempDir("hg-entries-");
	project = makeProject();
	canary = homeCanary("precious/keep.txt");
});

afterAll(() => {
	closeRegistry();
	safeRemove(path.dirname(canary));
	removeCreated();
});

async function guard(options: Parameters<typeof writeGuardEntry>[1] = {}, cwd = project.cwd): Promise<Guard> {
	return loadGuard([writeGuardEntry(entries, options)], cwd);
}

describe("static blocks through omp's runner", () => {
	test("write to ~/.bashrc is blocked with a reason; a project write passes untouched", async () => {
		const g = await guard();
		const blocked = await g.toolCall("write", { path: "~/.bashrc", content: "x" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("omp-home-guard blocked write");
		expect(blocked?.reason).toContain("~/.bashrc");
		expect(await g.toolCall("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
	});

	test("bash rm -rf ~/.config and eval deleting under the home directory are blocked", async () => {
		const g = await guard();
		expect((await g.toolCall("bash", { command: "rm -rf ~/.config" }))?.block).toBe(true);
		const evalBlocked = await g.toolCall("eval", { language: "js", code: 'require("fs").rmSync(require("os").homedir() + "/.cache", { recursive: true })' });
		expect(evalBlocked?.block).toBe(true);
	});

	test("eval: a home reference kept in the kernel blocks a later write until reset", async () => {
		const g = await guard();
		expect(await g.toolCall("eval", { language: "js", code: 'const h = require("os").homedir();' })).toBeUndefined();
		expect((await g.toolCall("eval", { language: "js", code: 'require("fs").rmSync(h + "/.cache", { recursive: true })' }))?.block).toBe(true);
		expect(await g.toolCall("eval", { language: "py", code: 'open("out.txt", "w").write("x")' })).toBeUndefined();
		expect(await g.toolCall("eval", { language: "js", reset: true, code: 'require("fs").writeFileSync("out.txt", "x")' })).toBeUndefined();
	});
});

describe.if(landlock)("the bash rewrite with the sandbox on (AC-4)", () => {
	test("the session-start notice names the sandbox and the writable places", async () => {
		const g = await guard();
		const notice = g.notices.find(item => item.message.includes("Landlock sandbox"));
		expect(notice?.type).toBe("info");
		expect(notice?.message).toContain("~/work/");
	});

	test("the rewritten input keeps cwd and the other fields and runs a copy of the helper", async () => {
		const g = await guard();
		const result = await g.toolCall("bash", { command: "ls -a", timeout: 7, cwd: "sub" });
		const input = result?.input as { command: string; cwd: string; timeout: number };
		expect(result?.block).toBeUndefined();
		expect(input.cwd).toBe("sub");
		expect(input.timeout).toBe(7);
		expect(input.command.startsWith(`OMP_HOME_GUARD_BUN_OPTIONS="\${BUN_OPTIONS-}" BUN_OPTIONS= '`)).toBe(true);
		expect(input.command).toContain(` --cwd '${path.join(STATE, "launch")}' --no-env-file '${path.join(STATE, "helper")}/`);
		expect(input.command).toContain(` --cwd "$PWD" --allow '${project.cwd}'`);
		expect(input.command).not.toContain(PACKAGE);
		expect(input.command.endsWith("-- 'ls -a'")).toBe(true);
		const copy = /'([^']*\/sandbox-exec\.ts)'/.exec(input.command)?.[1];
		expect(copy && fs.readFileSync(copy, "utf8")).toBe(fs.readFileSync(path.join(PACKAGE, "src", "sandbox-exec.ts"), "utf8"));
	});

	test("the rewritten command runs: project writes work, a script deleting a home folder is stopped", async () => {
		const g = await guard();
		project.write(
			"cleanup.js",
			'const fs = require("fs"), os = require("os"), path = require("path");\nfs.rmSync(path.join(os.homedir(), "precious"), { recursive: true, force: true });\nconsole.log("cleaned");\n',
		);
		const write = (await g.toolCall("bash", { command: "echo built > out.txt && cat out.txt" }))?.input as { command: string };
		const ran = runShell(write.command, project.cwd);
		expect(ran.code).toBe(0);
		expect(ran.stdout).toBe("built\n");
		const script = (await g.toolCall("bash", { command: "bun cleanup.js" }))?.input as { command: string };
		const stopped = runShell(script.command, project.cwd);
		expect(stopped.code).not.toBe(0);
		expect(stopped.stderr).toMatch(/EACCES|permission denied/i);
		expect(fs.readFileSync(canary, "utf8")).toBe("precious\n");
	});

	test("a BUN_OPTIONS preload does not run in the helper", async () => {
		const g = await guard();
		const marker = path.join(os.homedir(), "preload-marker");
		const preload = project.write("evil.ts", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
		const input = (await g.toolCall("bash", { command: "true" }))?.input as { command: string };
		const ran = runShell(input.command, project.cwd, { BUN_OPTIONS: `--preload ${preload}` });
		expect(ran.code).toBe(0);
		expect(fs.existsSync(marker)).toBe(false);
	});

	test("internal URLs stay where omp expands them; quoted mentions stay literal", async () => {
		const g = await guard();
		const skillDir = path.join(tempDir("hg-skill-"), "demo");
		writeFile(path.join(skillDir, "SKILL.md"), "demo skill\n");
		const skills = [{ name: "demo", baseDir: skillDir, filePath: path.join(skillDir, "SKILL.md") }] as never;
		const input = (await g.toolCall("bash", { command: 'cat skill://demo/SKILL.md && echo "see skill://demo/SKILL.md"' }))?.input as { command: string };
		const expanded = await expandInternalUrls(input.command, { skills });
		expect(expanded).not.toBe(input.command);
		const ran = runShell(expanded, project.cwd);
		expect(ran.stdout).toBe("demo skill\nsee skill://demo/SKILL.md\n");
	});

	test("a non-empty launch directory or an oversized command blocks the call", async () => {
		const g = await guard();
		const long = await g.toolCall("bash", { command: `echo ${"x".repeat(120_001)}` });
		expect(long?.block).toBe(true);
		expect(long?.reason).toContain("too long");
		const planted = writeFile(path.join(STATE, "launch", "bunfig.toml"), 'preload = ["./x.ts"]\n');
		try {
			const result = await g.toolCall("bash", { command: "ls" });
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("launch directory");
		} finally {
			safeRemove(planted);
		}
	});
});

describe("without the sandbox (AC-5)", () => {
	test("sandbox off: bash is not rewritten and the static check is strict", async () => {
		const g = await guard({ sandbox: "off" });
		expect(g.notices.some(item => item.message.includes("static checks only"))).toBe(true);
		expect(await g.toolCall("bash", { command: "ls" })).toBeUndefined();
		expect((await g.toolCall("bash", { command: "python3 tool.py ~/notes" }))?.block).toBe(true);
	});

	test("Landlock unavailable, warn (default): a warning, no rewrite, strict static check", async () => {
		const g = await guard({ bunPath: "/nonexistent/bun" });
		const notice = g.notices.find(item => item.message.includes("not available"));
		expect(notice?.type).toBe("warning");
		expect(notice?.message).toContain("static checks only");
		expect(await g.toolCall("bash", { command: "ls" })).toBeUndefined();
		expect((await g.toolCall("bash", { command: "python3 tool.py ~/notes" }))?.block).toBe(true);
	});

	test("Landlock unavailable, block: every bash call is blocked", async () => {
		const g = await guard({ bunPath: "/nonexistent/bun", onUnavailable: "block" });
		expect(g.notices.some(item => item.message.includes("every bash call is blocked"))).toBe(true);
		const result = await g.toolCall("bash", { command: "ls" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("not available");
	});
});

describe("configuration and the project-is-home case", () => {
	test("omp started in the home directory: a warning, and nothing in it is writable (AC-6)", async () => {
		const g = await guard({ sandbox: "off" }, os.homedir());
		expect(g.notices.some(item => item.type === "warning" && item.message.includes("home directory"))).toBe(true);
		expect((await g.toolCall("write", { path: "notes.txt", content: "x" }))?.block).toBe(true);
	});

	test("the config file's allowWrite opens a place; a broken config keeps the defaults and says so", async () => {
		const dir = tempDir("hg-config-");
		const good = writeFile(path.join(dir, "good.json"), `${JSON.stringify({ allowWrite: ["~/notes"], sandbox: "off" })}\n`);
		const g = await guard({ configPath: good });
		expect(await g.toolCall("write", { path: "~/notes/a.md", content: "x" })).toBeUndefined();
		const bad = writeFile(path.join(dir, "bad.json"), "{ not json");
		const h = await guard({ configPath: bad, sandbox: "off" });
		expect(h.notices.some(item => item.type === "error" && item.message.includes("bad.json"))).toBe(true);
		expect((await h.toolCall("write", { path: "~/.bashrc", content: "x" }))?.block).toBe(true);
	});

	test("the example config parses; unknown settings and bad values are refused", () => {
		expect(loadConfig(path.join(PACKAGE, "examples", "config.example.json"))).toEqual({
			allowWrite: ["~/.npm", "~/.bun/install/cache", "~/.cache"],
			protect: [],
			sandbox: "landlock",
			onUnavailable: "warn",
			bunPath: undefined,
		});
		const dir = tempDir("hg-config-");
		const cases: Array<[unknown, RegExp]> = [
			[{ allowWrites: [] }, /unknown setting "allowWrites"/],
			[{ sandbox: "docker" }, /"sandbox" must be one of/],
			[{ allowWrite: "~/notes" }, /"allowWrite" must be a list of paths/],
			[{ bunPath: "bun" }, /"bunPath" must be an absolute path/],
		];
		for (const [value, message] of cases) {
			const file = writeFile(path.join(dir, "config.json"), JSON.stringify(value));
			expect(() => loadConfig(file)).toThrow(message);
		}
		expect(loadConfig(path.join(dir, "missing.json"))).toEqual({});
	});
});

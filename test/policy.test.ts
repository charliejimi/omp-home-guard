import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProtected, type Places, places, toolVerdict } from "../src/policy";
import { removeCreated, tempDir, writeFile } from "./fixtures";

// Built when the file loads, because test.each lists below are evaluated then.
const world = tempDir("hg-world-");
const home = path.join(world, "home");
const project = path.join(home, "work", "repo");
const tmp = path.join(world, "tmp");
let p: Places;

beforeAll(() => {
	for (const dir of [project, tmp, path.join(home, ".config"), path.join(home, "notes"), path.join(world, "srv", "data")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	writeFile(path.join(home, ".bashrc"), "# rc\n");
	fs.symlinkSync(path.join(home, ".config"), path.join(project, "config-link"));
	p = places({ home, cwd: project, tmpdir: tmp });
});

afterAll(removeCreated);

const blocked = (tool: string, input: Record<string, unknown>, strict = false, at = p) => {
	const verdict = toolVerdict(tool, input, project, at, strict);
	return verdict.ok ? undefined : verdict.rule;
};
const bash = (command: string, strict = false, at = p) => blocked("bash", { command }, strict, at);

describe("places", () => {
	test("the project and the temp directory are allowed; the home directory is protected", () => {
		expect(p.project).toBe(project);
		expect(p.allowed).toContain(project);
		expect(p.allowed).toContain(tmp);
		expect(p.protected).toContain(home);
	});

	test("an allowed place that contains a protected place is ignored", () => {
		const q = places({ home, cwd: project, tmpdir: tmp, allowWrite: [world, "~/notes"] });
		expect(q.allowed).not.toContain(world);
		expect(q.ignored).toContain(world);
		expect(q.allowed).toContain(path.join(home, "notes"));
		if (home.startsWith("/tmp/")) {
			expect(q.allowed).not.toContain("/tmp");
			expect(q.ignored).toContain("/tmp");
		}
	});

	test("omp started in the home directory or above it: the project is not allowed (AC-6)", () => {
		for (const cwd of [home, path.dirname(home), "/"]) {
			const q = places({ home, cwd, tmpdir: tmp });
			expect(q.project).toBeUndefined();
			expect(q.allowed).not.toContain(cwd);
			expect(isProtected(path.join(home, "notes.txt"), cwd, q)).toBe(true);
		}
	});
});

describe("isProtected", () => {
	test("home paths, through ~, .., and symlinks", () => {
		expect(isProtected("~/.bashrc", project, p)).toBe(true);
		expect(isProtected(path.join(home, ".ssh", "authorized_keys"), project, p)).toBe(true);
		expect(isProtected("../other/file", project, p)).toBe(true);
		expect(isProtected("config-link/omp.yml", project, p)).toBe(true);
		expect(isProtected(home, project, p)).toBe(true);
	});

	test("the project, temp directories, and places outside the home directory are not", () => {
		expect(isProtected("src/index.ts", project, p)).toBe(false);
		expect(isProtected(path.join(tmp, "x"), project, p)).toBe(false);
		expect(isProtected(path.join(world, "outside", "x"), project, p)).toBe(false);
	});

	test("allowWrite opens a place in the home directory; protect adds one outside it", () => {
		const q = places({ home, cwd: project, tmpdir: tmp, allowWrite: ["~/notes"], protect: [path.join(world, "srv")] });
		expect(isProtected("~/notes/today.md", project, q)).toBe(false);
		expect(isProtected("~/notes-old/today.md", project, q)).toBe(true);
		expect(isProtected(path.join(world, "srv", "data", "db"), project, q)).toBe(true);
	});
});

describe("write, edit, ast_edit (AC-1)", () => {
	test("protected targets are blocked", () => {
		expect(blocked("write", { path: "~/.bashrc", content: "x" })).toBe("protected-write");
		expect(blocked("write", { path: "config-link/new.yml", content: "x" })).toBe("protected-write");
		expect(blocked("write", { path: "../../.profile", content: "x" })).toBe("protected-write");
		expect(blocked("edit", { path: path.join(home, ".bashrc"), edits: [] })).toBe("protected-write");
		expect(blocked("edit", { path: "src/a.ts", edits: [{ rename: "~/.local/bin/a" }] })).toBe("protected-write");
		expect(blocked("edit", { input: "*** Begin Patch\n*** Add File: ~/.ssh/authorized_keys\n+key\n*** End Patch\n" })).toBe("protected-write");
		expect(blocked("ast_edit", { paths: "~/**/*.ts", ops: [] })).toBe("protected-write");
		expect(blocked("ast_edit", { paths: home, ops: [] })).toBe("protected-write");
		expect(blocked("ast_edit", { paths: path.dirname(home), ops: [] })).toBe("protected-write");
	});

	test("project, temp, and allowWrite targets pass", () => {
		const q = places({ home, cwd: project, tmpdir: tmp, allowWrite: ["~/notes"] });
		expect(blocked("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(blocked("write", { path: path.join(tmp, "scratch.txt"), content: "x" })).toBeUndefined();
		expect(blocked("write", { path: "~/notes/a.md", content: "x" }, false, q)).toBeUndefined();
		expect(blocked("edit", { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n" })).toBeUndefined();
		expect(blocked("ast_edit", { paths: "src/**/*.ts", ops: [] })).toBeUndefined();
		expect(blocked("ast_edit", { paths: ".", ops: [] })).toBeUndefined();
	});
});

describe("bash with the sandbox on (AC-2)", () => {
	test.each([
		"rm -rf ~/.config",
		"echo x > ~/.bashrc",
		"find ~ -delete",
		"cd ~ && rm -rf .cache",
		"mv ~/.ssh /tmp/x",
		"X=$HOME/.ssh; rm -rf $X",
		'rm -rf "${HOME}/.cache"',
		"rm -rf ~/*",
		"rm -rf ../..",
		"cp build/app ~/.local/bin/app",
		"echo 'export X=1' | tee -a ~/.zshrc",
		"sed -i 's/a/b/' ~/.gitconfig",
		"dd if=/dev/zero of=$HOME/.bash_history bs=1 count=1",
		"git -C ~ clean -fdx",
		"bash -c 'rm -rf ~/.cache'",
		"find ~ -name '*.log' | xargs rm -f",
		"curl -o ~/.local/bin/tool https://example.test/tool",
		"touch ~/.hushlogin",
		"mkdir -p ~/.config/autostart",
		`rm -rf ${path.dirname(path.dirname(project))}`,
	])("blocks %s", command => {
		expect(bash(command)).toMatch(/^protected-/);
	});

	test.each([
		"rm -rf ./build",
		"ls ~",
		"cat ~/.gitconfig",
		"cp ~/.gitconfig ./backup",
		"echo hi > /dev/null",
		"npm test",
		"git status",
		"mkdir -p out && echo ok > out/a.txt",
		"python3 tool.py ~/notes",
		"grep -r TODO ~ | head",
		"cd sub && rm -rf dist",
		"bun run build",
	])("passes %s", command => {
		expect(bash(command)).toBeUndefined();
	});

	test("cwd passed to the tool is where relative targets resolve", () => {
		expect(blocked("bash", { command: "rm -rf .cache", cwd: home })).toBe("protected-write");
		expect(blocked("bash", { command: "rm -rf dist", cwd: "packages/a" })).toBeUndefined();
	});

	test("an internal URL as cwd counts as the home directory: reads pass, relative writes do not", () => {
		expect(blocked("bash", { command: "cat SKILL.md", cwd: "skill://demo" })).toBeUndefined();
		expect(blocked("bash", { command: "rm -rf build", cwd: "skill://demo" })).toBe("protected-write");
	});
});

describe("bash without the sandbox (strict)", () => {
	test("a command it cannot read that names a protected place is blocked", () => {
		expect(bash("python3 tool.py ~/notes", true)).toBe("unverifiable");
		expect(bash("cd ~ && make", true)).toBe("unverifiable");
		expect(bash("node $(echo script.js) ~", true)).toBe("unverifiable");
	});

	test("commands that name no protected place still pass", () => {
		expect(bash("npm test", true)).toBeUndefined();
		expect(bash("ls ~", true)).toBeUndefined();
		expect(bash("cp ~/.gitconfig ./backup", true)).toBeUndefined();
	});
});

describe("eval (AC-3)", () => {
	test.each([
		'require("fs").rmSync(require("os").homedir() + "/.cache", { recursive: true })',
		'import shutil, os\nshutil.rmtree(os.path.expanduser("~/.cache"))',
		'from pathlib import Path\n(Path.home() / ".bashrc").write_text("")',
		'await Bun.write(`${process.env.HOME}/.profile`, "")',
		`require("fs").writeFileSync(${JSON.stringify(path.join(home, ".bashrc"))}, "")`,
	])("blocks %s", code => {
		expect(blocked("eval", { code })).toBe("protected-eval");
	});

	test.each([
		'console.log(require("os").homedir())',
		'require("fs").writeFileSync("out.txt", "x")',
		"print(sum(range(10)))",
	])("passes %s", code => {
		expect(blocked("eval", { code })).toBeUndefined();
	});
});

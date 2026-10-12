import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { homeCanary, homeDir, removeCreated, safeRemove, tempDir, writeFile } from "./fixtures";
import { BUN, HELPER, runHelper } from "./helpers";

let launch: string;
let project: string;
let scratch: string;
let canary: string;

const landlock = runHelper(["--probe"], { cwd: process.cwd() });
const available = landlock.code === 0;
if (!available) console.warn(`sandbox tests skipped: the helper's probe failed (${landlock.stderr.trim()})`);

beforeAll(() => {
	launch = tempDir("hg-launch-");
	project = homeDir("hg-sbx-");
	scratch = tempDir("hg-scratch-");
	canary = homeCanary("precious/keep.txt");
});

afterAll(() => {
	safeRemove(path.dirname(canary));
	removeCreated();
});

/** Runs `command` under the helper with the project and the scratch directory writable. */
const sandboxed = (command: string, env?: Record<string, string | undefined>) =>
	runHelper(["--cwd", project, "--allow", project, "--allow", scratch, "--dev", "--", command], { cwd: launch, env });

describe.if(available)("the helper on real Landlock (AC-4, AC-5)", () => {
	test("--probe restricts itself and reports the ABI", () => {
		expect(landlock.stdout).toMatch(/^landlock \d+\n$/);
	});

	test("writes in the allowed places work", () => {
		const ran = sandboxed(`echo built > out.txt && echo tmp > ${JSON.stringify(path.join(scratch, "t.txt"))} && echo x > /dev/null`);
		expect(ran.code).toBe(0);
		expect(fs.readFileSync(path.join(project, "out.txt"), "utf8")).toBe("built\n");
		expect(fs.readFileSync(path.join(scratch, "t.txt"), "utf8")).toBe("tmp\n");
	});

	test("deleting, overwriting, and creating outside them fail with EACCES", () => {
		const home = path.dirname(path.dirname(canary));
		const rm = sandboxed(`rm -rf ${JSON.stringify(path.dirname(canary))}`);
		expect(rm.code).not.toBe(0);
		expect(rm.stderr).toMatch(/Permission denied/);
		const overwrite = sandboxed(`echo gone > ${JSON.stringify(canary)}`);
		expect(overwrite.code).not.toBe(0);
		const create = sandboxed(`touch ${JSON.stringify(path.join(home, ".new-dotfile"))}`);
		expect(create.code).not.toBe(0);
		expect(fs.readFileSync(canary, "utf8")).toBe("precious\n");
		expect(fs.existsSync(path.join(home, ".new-dotfile"))).toBe(false);
	});

	test("child processes inherit the restriction: bun -e rmSync and a script that builds the path", () => {
		const inline = sandboxed(`${JSON.stringify(BUN)} -e 'require("fs").rmSync(require("os").homedir() + "/precious", { recursive: true, force: true })'`);
		expect(inline.code).not.toBe(0);
		expect(inline.stderr).toMatch(/EACCES|permission denied/i);
		writeFile(
			path.join(project, "cleanup.js"),
			'const fs = require("fs"), os = require("os"), path = require("path");\nfs.rmSync(path.join(os.homedir(), "precious"), { recursive: true, force: true });\nconsole.log("cleaned");\n',
		);
		const script = sandboxed(`${JSON.stringify(BUN)} cleanup.js`);
		expect(script.code).not.toBe(0);
		expect(script.stdout).not.toContain("cleaned");
		expect(fs.readFileSync(canary, "utf8")).toBe("precious\n");
	});

	test("output, exit code, and the original working directory pass through", () => {
		const ran = sandboxed("pwd; echo err >&2; exit 5");
		expect(ran.code).toBe(5);
		expect(ran.stdout).toBe(`${project}\n`);
		expect(ran.stderr).toBe("err\n");
	});

	test("BUN_OPTIONS is restored for the command, and the helper's own variable is not passed on", () => {
		const restored = sandboxed('printf "%s|%s" "$BUN_OPTIONS" "${OMP_HOME_GUARD_BUN_OPTIONS-unset}"', { OMP_HOME_GUARD_BUN_OPTIONS: "--smol" });
		expect(restored.stdout).toBe("--smol|unset");
		const none = sandboxed('printf "%s" "${BUN_OPTIONS-unset}"');
		expect(none.stdout).toBe("unset");
	});

	test("a project's bunfig.toml preload runs only when Bun starts in the project, so the helper starts elsewhere", () => {
		writeFile(path.join(project, "bunfig.toml"), 'preload = ["./mark.ts"]\n');
		writeFile(path.join(project, "mark.ts"), `require("fs").writeFileSync(${JSON.stringify(path.join(project, "preload-ran"))}, "ran");\n`);
		try {
			expect(sandboxed("true").code).toBe(0);
			expect(fs.existsSync(path.join(project, "preload-ran"))).toBe(false);
			runHelper(["--cwd", project, "--allow", project, "--", "true"], { cwd: project });
			expect(fs.existsSync(path.join(project, "preload-ran"))).toBe(true);
		} finally {
			for (const name of ["bunfig.toml", "mark.ts", "preload-ran"]) safeRemove(path.join(project, name));
		}
	});

	test("when the restriction fails the helper exits 126 without running the command", () => {
		// Landlock allows 16 stacked restrictions; the 17th nested helper cannot restrict itself.
		writeFile(
			path.join(project, "nest.sh"),
			[
				'n=$1',
				'if [ "$n" -le 0 ]; then echo reached; exit 0; fi',
				'cd "$HG_LAUNCH" && exec "$HG_BUN" --no-env-file "$HG_HELPER" --cwd "$HG_PROJECT" --allow "$HG_PROJECT" --dev -- "sh nest.sh $((n - 1))"',
				"",
			].join("\n"),
		);
		const env = { HG_LAUNCH: launch, HG_BUN: BUN, HG_HELPER: HELPER, HG_PROJECT: project };
		const shallow = sandboxed("sh nest.sh 2", env);
		expect(shallow.stdout).toBe("reached\n");
		const deep = sandboxed("sh nest.sh 16", env);
		expect(deep.code).toBe(126);
		expect(deep.stdout).not.toContain("reached");
		expect(deep.stderr).toMatch(/omp-home-guard: .*not run/);
	}, 60_000);

	test("a missing working directory also exits 126 without running the command", () => {
		const ran = runHelper(["--cwd", path.join(project, "missing"), "--allow", project, "--", "echo ran"], { cwd: launch });
		expect(ran.code).toBe(126);
		expect(ran.stdout).toBe("");
	});
});

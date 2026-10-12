import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The temporary root test/run.ts created; test/setup.ts already checked HOME and TMPDIR are inside it. */
export const TEST_ROOT = fs.realpathSync(process.env.HG_TEST_ROOT ?? "/nonexistent-test-root");

/** Deletes `target` only when its real path is strictly inside the suite's temporary root. */
export function safeRemove(target: string): void {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	const rel = path.relative(TEST_ROOT, real);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${target}: outside the test root`);
	fs.rmSync(real, { recursive: true, force: true });
}

const created: string[] = [];

/** A new directory under the suite's TMPDIR. */
export function tempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

/** A new directory under the suite's HOME, the way most projects live under a home directory. */
export function homeDir(prefix: string): string {
	const parent = path.join(os.homedir(), "work");
	fs.mkdirSync(parent, { recursive: true });
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix)));
	created.push(dir);
	return dir;
}

export function removeCreated(): void {
	for (const dir of created.splice(0)) safeRemove(dir);
}

export function writeFile(file: string, text: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

/** A canary under the suite's HOME (outside every project); returns its path. */
export function homeCanary(rel: string, text = "precious\n"): string {
	return writeFile(path.join(os.homedir(), rel), text);
}

export interface Project {
	/** The directory omp runs in, under the suite's HOME. */
	cwd: string;
	write(rel: string, text: string): string;
}

export function makeProject(): Project {
	const cwd = path.join(homeDir("hg-proj-"), "repo");
	writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
	return { cwd, write: (rel, text) => writeFile(path.join(cwd, rel), text) };
}

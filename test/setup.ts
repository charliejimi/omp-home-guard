// Preloaded before every test file (bunfig.toml). The suite creates and deletes fixtures under the
// home directory, so it runs only when test/run.ts started it with HOME and TMPDIR inside a
// temporary root. Bun fixes os.homedir() when the process starts, so this checks the value Bun
// actually uses instead of trusting the HOME variable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function inside(child: string, root: string): boolean {
	const rel = path.relative(root, fs.realpathSync(child));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const root = process.env.HG_TEST_ROOT;
if (!root || !fs.existsSync(root) || !inside(os.homedir(), root) || !inside(os.tmpdir(), root)) {
	throw new Error(
		`Refusing to run: the home directory (${os.homedir()}) is not inside a temporary test root. ` +
			"Run the tests with `bun run test`, which starts Bun with a temporary HOME.",
	);
}

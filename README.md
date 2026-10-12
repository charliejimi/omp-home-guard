# omp-home-guard

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension that keeps the agent from deleting, overwriting, or creating files in your home directory outside the project it works on. It checks every tool call statically, and on Linux it runs every bash call in a Landlock sandbox: the kernel refuses writes outside the project and the temp directories, also in every process the command starts.

[中文說明](README.zh-TW.md)

> **Not tested with a real model.** The live tests run real omp 18.2.8 end to end with a scripted test model. They show what is blocked and what still works; they do not show how a real model reacts to a block.

## Why

On 2026-10-12, a test cleanup run by a coding agent deleted the real `~/.config`, `~/.local`, `~/.cache`, and `~/.omp` of the machine this package was built on. The test set `HOME` to a temporary directory after Bun had started, but Bun fixes `os.homedir()` when the process starts, so the cleanup computed its paths in the real home directory. No tool call named those paths; the command was `bun test`.

That is the gap this package closes. A check of tool calls can block `rm -rf ~/.config`; it cannot see a deletion made inside a process the command starts. omp's own documentation says bash approval "is not containment". Landlock is: a Linux process can give up its write rights everywhere but in a few directories, and every process it starts inherits that, for good.

## What it does

| Layer | Where | What it does | If it cannot |
|---|---|---|---|
| Static check | every platform, `tool_call` | Works out where `write`, `edit` (also renames and the files named in a combined patch), and `ast_edit` would write, through `~`, `..`, and symlinks, and blocks writes into protected places. Reads `bash` commands: redirects; the targets of `rm`, `mv`, `cp`, `tee`, `dd`, `sed -i`, `find -delete`, `git -C`, `tar`, `curl -o`, and similar; `cd` into protected places; variables assigned from them; `xargs` fed from them; `bash -c` and inline `python -c` or `node -e` code. Blocks `eval` code that refers to the home directory and writes, deletes, or starts processes, also when the reference came in an earlier call to the same kernel. | omp blocks the call and tells the model why. |
| Sandbox | Linux, `tool_call` on `bash` | Rewrites every bash call to run under a small helper that restricts its write rights with Landlock to the writable places, then replaces itself with `bash -c '<your command>'` in the call's directory. Output, exit code, and directory stay the same; a write anywhere else fails with `EACCES`. | `onUnavailable: "warn"` (default): bash runs with the static check only, which is then strict. `"block"`: every bash call is blocked. The helper itself exits 126 without running anything when it cannot restrict itself. |
| Notice | `session_start` | Tells you whether the sandbox runs and what is writable. | — |

The static check is strict only when it is the only layer. With the sandbox on, a command it cannot read (`python tool.py ~/data.csv`) is left to the sandbox; without the sandbox, such a command is blocked when it names a protected place.

## What is writable

- The project omp runs in, unless omp runs in your home directory or above it; then nothing in the home directory is writable, and the notice says so.
- The temp directory (`os.tmpdir()`), `/tmp`, and `/dev/shm`.
- Your `allowWrite` entries.
- Existing device files under `/dev`, such as `/dev/null` and terminals, for writing only.

Protected: your home directory and your `protect` entries, minus the writable places. A writable place that contains a protected place (for example `allowWrite: ["~"]`, or `/tmp` when your home directory is under `/tmp`) is ignored and named in the notice, because Landlock can only allow directories; it cannot cut a protected hole into an allowed one.

Reads and network access are not restricted.

## Requirements

- omp 18.2.8.
- [Bun](https://bun.sh) 1.3.14 or newer (tested with 1.4.2); it runs the helper.
- For the sandbox: Linux with Landlock enabled (kernel 5.13 or newer; 5.19 for moving files between directories, 6.2 for truncation). Tested on kernel 7.0 (Landlock ABI 8), x86_64. On macOS and Windows only the static check runs.

## Install

Clone it **outside** every project the agent works on, so the agent cannot change the guard itself. The extension needs no dependencies at run time; `bun install` is for the tests:

```bash
git clone <this repository> ~/omp-home-guard
cd ~/omp-home-guard && bun install
```

Load it for every session in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/omp-home-guard
```

or for one run with `omp -e ~/omp-home-guard`. If another extension also rewrites bash input, load this one last: omp runs the last rewrite.

## Configuration

Optional, in `~/.config/omp-home-guard/config.json`. Nothing is read from environment variables or from the project.

```json
{
  "allowWrite": ["~/.npm", "~/.bun/install/cache", "~/.cache"],
  "protect": ["/srv/data"],
  "sandbox": "landlock",
  "onUnavailable": "warn"
}
```

| Setting | Default | Meaning |
|---|---|---|
| `allowWrite` | `[]` | More writable places, absolute or starting with `~/`. Tools that keep caches in your home directory (npm, Bun, pip, cargo) fail with `EACCES` until their cache is listed here. |
| `protect` | `[]` | More protected places outside the home directory. |
| `sandbox` | `"landlock"` | `"off"` keeps only the static check. |
| `onUnavailable` | `"warn"` | `"block"` blocks every bash call when the sandbox cannot run. |
| `bunPath` | the Bun running omp, else `bun` on `PATH` | The Bun that runs the helper, as an absolute path. A Bun inside a writable place is refused. |

A config file that cannot be read is reported at session start, and the defaults apply.

## How the sandbox works

For every bash call the guard returns a new `command` and leaves the other fields, such as `cwd` and `timeout`, as they were:

```sh
OMP_HOME_GUARD_BUN_OPTIONS="${BUN_OPTIONS-}" BUN_OPTIONS= '<bun>' --cwd '<state>/launch' --no-env-file \
  '<state>/helper/<hash>/sandbox-exec.ts' --cwd "$PWD" --allow '<project>' --allow '<tmp>' … --dev -- '<your command>'
```

`<state>` is `~/.local/state/omp-home-guard`; the real command uses absolute paths.

- **The helper is a copy.** At session start the guard copies `landlock.ts` and `sandbox-exec.ts` into `<state>/helper/<content hash>/`, inside the protected home directory, and runs the copy once with `--probe`. The sandbox counts as available only when that probe could restrict itself. A change to the package during the session does not change what runs.
- **Bun starts in an empty directory.** Bun runs the `bunfig.toml` preload and loads the `.env` of the directory it starts in; `--cwd` into the empty launch directory and `--no-env-file` keep the project's out of the helper. A bash call is blocked when the launch directory is not empty.
- **`BUN_OPTIONS` is cleared for the helper**, because a `--preload` in it would run before the restriction, and restored for your command.
- **Your command runs where omp put it.** omp sets `$PWD` to the call's directory and applies direnv for it, as without the guard; the helper restricts itself, changes to that directory, and replaces itself with `bash -c`. Internal URLs such as `skill://…` are kept outside the quotes, where omp still expands them.
- **One argument is limited to 128 KiB on Linux**, so a command over 120,000 bytes is blocked with a hint to write a script file instead.
- **Cost:** about 0.23 s per bash call on the 4-core machine it was built on (median of 20 runs), mostly Bun starting.

## Tests

```bash
bun run test
```

`bun run test` starts Bun with a temporary `HOME` and `TMPDIR`; plain `bun test` refuses to run, because the suite creates and deletes files in the home directory and Bun fixes the home directory when it starts. The suite runs through omp's own extension loader and runner, uses real Landlock where the kernel has it, and needs no network.

The live tests run real omp with a scripted test-only model provider (`test/scripted-provider.ts`):

```bash
HOME_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
HOME_GUARD_LIVE_OUT=/tmp/home-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` runs an installed omp instead. Without the guard, a project script that builds a home path at run time deletes a canary folder. With the guard, `rm -rf` of that folder is blocked statically, the same script is stopped by the sandbox with `EACCES`, a project write works, and `write` to `~/.bashrc` is blocked; `skill://` URLs in a command and as `cwd` still work under the sandbox.

## To do before a public release

- **Threat model.** Not run (STRIDE, OWASP LLM Top 10, OWASP Agentic).
- **Security audit.** Not run; the helper and the static check have had no independent adversarial review.
- **Real-model runs.** Not run.
- **Runs with approvals on.** The live tests use `--approval-mode yolo`; how omp's approval prompts show the rewritten command was not checked.
- **First CI run.** The GitHub Actions workflow has not run yet; `bun.lock` was produced offline.
- **Newer omp versions.** Only 18.2.8 was tested, and the URL handling mirrors omp 18.2.8's rules.

## Limits

- **Reads and network are not restricted.** Secrets in your home directory can be read and sent out.
- **Landlock restricts writing, creating, removing, renaming, and truncating, not metadata.** Permissions, ownership, timestamps, and extended attributes are not covered by the sandbox; the static check blocks `chmod`, `chown`, and `touch` on protected paths it can read.
- **Only bash is sandboxed.** `eval` runs inside omp (JavaScript) or in a Python kernel omp starts, and is checked statically only. omp's own writes, its `memory_edit`, `learn`, `manage_skill`, and `lsp` tools, MCP tools, other extensions, and your own `!` commands are not checked.
- **The static check reads; it does not run anything.** A command that builds a path at run time is not seen statically; the sandbox stops it, and without the sandbox nothing does.
- **Shell state does not carry over** between sandboxed bash calls: variables you export and functions you define are gone in the next call. omp's bash interceptor and approval rules see the wrapped command.
- **A guard the agent can write to can be changed** for the next session. Install it outside your projects.
- **Older kernels.** With Landlock ABI 1 (kernel 5.13 to 5.18), moving a file between directories is always refused.

## Background

This package turns the lesson of that incident into a guard for omp agents. The same lesson became a rule for the Cursor agent and a test runner in the sibling packages omp-extension-guard and omp-skill-guard: tests start Bun with a temporary home directory and refuse to run otherwise, and every recursive delete first checks that its target is inside a directory the same code created.

## License

[MIT](LICENSE)

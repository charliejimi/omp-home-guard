# Changelog

## [0.1.0] - 2026-10-12

### Added

- Static check of `write`, `edit` (renames and the files named in a combined patch), `ast_edit`, `bash`, and `eval` tool calls: protected places are the home directory and `protect`, minus the project, the temp directories, and `allowWrite`; paths are followed through `~`, `$HOME`, `..`, and symlinks; a writable place that contains a protected place is ignored.
- A static reading of `bash` commands: redirects, the targets of common writers (`rm`, `mv`, `cp`, `tee`, `dd`, `sed -i`, `find -delete`, `git -C`, `tar`, `curl -o`, and others), `cd`, variables and `for` loops assigned from protected places, `xargs`, `bash -c`, `eval`, `trap`, and inline `-c`/`-e` code; here-document bodies are skipped. Strict only when there is no sandbox.
- `eval` check that remembers, per language, a home-directory reference from an earlier call until the kernel is reset.
- Landlock sandbox for every `bash` call on Linux: a helper restricts its write, create, remove, rename, and truncate rights to the writable places and replaces itself with `bash -c` in the call's directory; children inherit the restriction; the helper exits 126 without running anything when it cannot restrict itself.
- The helper runs from a copy in `~/.local/state/omp-home-guard/helper/<content hash>/`, started by Bun from an empty launch directory with `--no-env-file` and `BUN_OPTIONS` cleared (restored for the command), after a start-up probe; internal URLs such as `skill://` stay where omp expands them; omp's `cwd` handling and direnv are unchanged.
- Session-start notice; `~/.config/omp-home-guard/config.json` with `allowWrite`, `protect`, `sandbox`, `onUnavailable`, and `bunPath`.
- Tests through omp's own extension loader and runner, with real Landlock, run with a temporary HOME by `bun run test`; opt-in live tests on real omp 18.2.8 with a scripted test model.

### Not yet done

- Threat model (STRIDE, OWASP LLM Top 10, OWASP Agentic): not run.
- Independent security audit: not run.
- Live runs with a real model, and with omp's approvals on: not run.
- First run of the GitHub Actions workflow; `bun.lock` was produced offline.
- A sandbox on macOS and Windows.
- Tests against omp versions newer than 18.2.8.

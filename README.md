# Quirky

Quirky is a memory-efficient rewrite of [Orca](https://github.com/zpyoung/orca) for running coding
agents in git worktrees. v1 runs on macOS: you add repos, create worktrees, run shells and agents
in terminals that survive closing the app, see which agents are working, waiting or done, review
and commit diffs, answer `quirky ask` questions, and run background Claude sessions with no
terminal. Its daemon and PTY host together use about 43 MB with eight busy terminals
(`research/memory-probe/quirky-v1-daemon.md`).

## Try it

```sh
bun install
bun run build
open apps/desktop/build/Quirky.app
```

The app starts the daemon, which keeps running after you close the window. To try it without
touching your real state, run `open -n --env QUIRKY_HOME=/tmp/qtest apps/desktop/build/Quirky.app`.
[apps/desktop/README.md](apps/desktop/README.md) covers installing to `~/Applications`, dev mode,
logs and cleanup.

Inside any Quirky terminal, the `quirky` command is on PATH: try `quirky status` or `quirky help`.

## How it's built

- **`packages/pty-host`:** `quirky-pty` owns every terminal and its history.
- **`packages/daemon`:** `quirkyd` serves the one API that the UI, the CLI and the desktop shell
  all use.
- **`packages/ui`:** the React UI, served by the daemon.
- **`packages/cli`:** the `quirky` command.
- **`apps/desktop`:** the Electrobun window.
- **`prototypes/`:** stack experiments, such as the native Swift shell.

`bun test` runs every package's tests.

## Docs

- [docs/v1.md](docs/v1.md): what v1 does and leaves out, and how the parts fit together.
- [docs/architecture.md](docs/architecture.md): the full design, its memory budget, and the
  decisions made so far.
- [docs/roadmap.md](docs/roadmap.md): the build order for every kept Orca feature and the plugin
  kernel, with each milestone's exit test.
- [docs/stack-proposal.md](docs/stack-proposal.md): how the stack choice was settled, including the
  native Swift option, with the measurements.
- [research/orca-features/](research/orca-features/README.md): how each Orca feature Quirky keeps
  works, verified in the running app, with screenshots.
- `research/` is its own local git repo with no remote, ignored here, so the research and the
  screenshots never reach this repo's remote. Paths into it from these docs resolve only on the
  machine that has it.
- [BRIEF.md](BRIEF.md): the project's starting brief.

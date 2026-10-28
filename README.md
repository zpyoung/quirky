# Quirky

Quirky is a memory-efficient rewrite of [Orca](https://github.com/zpyoung/orca) for running coding
agents in git worktrees. Quirky runs on macOS: you add repos, create worktrees, run shells and agents
in terminals that survive closing the app, see which agents are working, waiting or done, review
and commit diffs, answer `quirky ask` questions, and run background Claude sessions with no
terminal. The measured v1 daemon and PTY host together used about 43 MB with eight busy terminals
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

## Agent Session History

Open **Agent Session History** to browse agent-owned transcripts and resume a session in a
terminal. Workspace/Project filters follow the current context; select **All** to browse other
directories. Resume uses the agent's configured command and the transcript's original directory.
When the Accounts plugin is active, required account preparation must succeed before resume.
Explicit launch-home overrides keep their precedence; preparation failure does not start a process.

Transcript search is **off until explicitly enabled**. Before consent, the search box filters
titles only. Enabling stores a local searchable copy of unredacted conversations and up to 3,072
characters per tool result; authenticated clients can search that copy. Disable retains it.
**Clear search data** disables search and removes only the derived index, not original transcripts.

The same core flows are scriptable:

```sh
quirky vault list --unlimited --json
quirky vault search --index-status --json
quirky vault enable
quirky vault search 'remembered words' --fresh --json
quirky vault resume '<id from list>'
quirky vault clear --yes
```

Advanced parity and verification obligations are tracked in
[the vault's open findings](docs/loop/BLOCKERS.md#m3-vault-open-review-findings) and the dependent
`m3-vault-parity-completion` queue item.
## How it's built

- **`packages/pty-host`:** `quirky-pty` owns every terminal and its history.
- **`packages/daemon`:** `quirkyd` serves the one API that the UI, the CLI and the desktop shell
  all use.
- **`packages/ui`:** the React UI, served by the daemon.
- **`packages/cli`:** the `quirky` command.
- **`apps/desktop`:** the Electrobun window.
- **`prototypes/`:** stack experiments, such as the native Swift shell.

`bun run test` runs the whole suite through the configured test host. Use
`bun scripts/suite.ts <dirs>` for affected packages and `bun test <file>` for a single file.

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

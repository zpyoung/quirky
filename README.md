# Quirky

Quirky is a memory-efficient rewrite of [Orca](https://github.com/zpyoung/orca) for running coding
agents in git worktrees. Quirky runs on macOS: you add repos, create worktrees, run shells and agents
in terminals that survive closing the app, see which agents are working, waiting or done, review
and commit diffs, answer `quirky ask` questions, and run background Claude and Codex sessions
without a terminal, with shared local checks. The measured v1 daemon and PTY host together used about 43 MB with eight busy terminals
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

`bun run test` runs the package, app and plugin suite on the configured remote test host, plus
macOS-only checks locally. Use `bun test <file>` for a targeted file, `bun test scripts` for the
runner tests, and `bun run typecheck` for TypeScript.

### Public plugin UI and grouping APIs

UI plugins can declare an `activity-item` contribution beside the right sidebar. It mounts even
when no panel is open and uses the ordinary module, override, report and cleanup lifecycle.
`quirky ui contributions --json` exposes `activityItems`; `quirky ui state --json` exposes each
mounted item's report. Existing main-header panel toggles and right-column panel placement remain.

Setting declarations can provide optional `category` and `section` strings. The generic Settings
dialog groups these declarations by category and section; uncategorized settings retain their
plugin grouping.

Git worktrees expose separate display membership (`projectGroupId`), monotonic activity
(`lastActivityAt`) and filesystem-instance identity (`instanceId`). `quirky wt create-group
<worktree> <name>` creates a group and assigns only that worktree with stale-assignment protection.
`quirky wt set <worktree> --project-group <group-id>` moves it; `--no-project-group` clears it.
These operations do not change its repository, path or lineage.

Project groups expose `parentId`. `quirky repo group create <name> --parent <group>` and
`quirky repo group set-parent <group> --parent <parent>` manage hierarchy; `--no-parent` clears it.
Deleting a group deletes its group subtree and releases loose worktree memberships without
deleting their Git worktrees or metadata.

The built-in `quirky.sidebar-extras` plugin adds cross-repository worktree placement, client-local
activity windows, a live Source Control dirty indicator, and configurable sidebar separators.
`quirky sidebar-extras set --workspace-activity-window week` changes the activity window;
`state`, `projection`, and `dirty` provide JSON readback with `--json`.
`activate --worktree <id>` records a visit; `activate --clear` clears it.
Preferences persist per client. Visit and departure stamps are keyed to filesystem-instance
identity, so replacing a worktree does not inherit its predecessor's recency.
The separator switch is under Appearance > Window & Sidebar. The original header panel toggles
remain available alongside the Source Control activity item.

The operator-directed core landing leaves exhaustive parity and browser verification to
`m2-sidebar-extras-followup`; see [the sidebar specification](docs/quirk/specs/2026-10-27-m2-sidebar-extras/logic.md)
for that remaining acceptance target.
The root TypeScript configuration resolves both public `@quirky/protocol` entries directly to
workspace source, so newly added plugins do not need generated per-plugin links for typechecking.
Keep those mappings aligned with `packages/protocol/package.json` exports.

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

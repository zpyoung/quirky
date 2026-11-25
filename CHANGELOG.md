---
last_released_commit: 98b5867f0bd06ac1ea7b9cd22c43fc8ef15dda73
---

# Changelog

Changes to Quirky, an independent app. The entries below predate Quirky's own versioning: they
come from [`zpyoung/orca`](https://github.com/zpyoung/orca), the personal build Quirky's code grew
out of, and their sync lines refer to the [`stablyai/orca`](https://github.com/stablyai/orca)
releases that build followed.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). It is maintained by the
`release` skill — see `.claude/skills/release/SKILL.md`.

## [1.4.238-rc.0.zy02] - 2026-10-22

Synced to upstream [v1.4.237](https://github.com/stablyai/orca/releases/tag/v1.4.237).

### Fixed

- The upstream sync automation now fetches upstream's trunk by an explicit refspec, so its
  fork-commit counts and the fork's `upstream` mirror branch no longer read a stale copy of
  upstream's `main`.

## [1.4.238-rc.0.zy01] - 2026-10-22

Synced to upstream [v1.4.237](https://github.com/stablyai/orca/releases/tag/v1.4.237).

### Changed

- The upstream sync automation adds the daemon protocol-bump label when it opens a sync PR that
  moves the protocol version, and retargets an open sync PR in place when a newer stable tag fixes
  what blocked it.

### Fixed

- Fork features that hang off code upstream reworked in this release keep working: the fork's chat
  composer disables attachments while a remote chat session is still starting, native paste keeps
  the fork's focus routing and image-only fallback, the session handoff settings sit inside
  upstream's new scrolling settings page, and fork loops and the project ledger resolve a repo's
  host the way upstream's new checks expect.
- Claude Code keeps loading the fork's agent rules. Upstream removed `CLAUDE.md`; the fork keeps it.

## [1.4.234-rc.0.zy01] - 2026-10-20

Synced to upstream [v1.4.233](https://github.com/stablyai/orca/releases/tag/v1.4.233), by way of
[v1.4.232](https://github.com/stablyai/orca/releases/tag/v1.4.232).

### Added

- Typing `/resume` in a structured chat, optionally followed by a search, opens Agent Session
  History for that chat's workspace instead of sending the text to the agent. Terminal-backed
  chats and the terminal dock still pass `/resume` to the agent.

### Fixed

- Signing in from a protected artifact's share panel shows the same sign-in progress as upstream,
  with a link to copy and a way to cancel while the browser sign-in is pending.
- Fork features that hang off code upstream reworked in these releases keep working: removing a
  project still checks its ledgers, ask cards still reach the dashboard popout, and the workspace
  activity window, worktree groups, session handoff and plugin skill names follow upstream's new
  modules.
- The remote test sandbox builds again. Its image now ships upstream's new pnpm config file and
  keeps a project-local `node_modules`.

## [1.4.231-rc.0.zy03] - 2026-10-19

Synced to upstream [v1.4.230](https://github.com/stablyai/orca/releases/tag/v1.4.230), by way of
[v1.4.227](https://github.com/stablyai/orca/releases/tag/v1.4.227).

### Added

- Loops run an agent in a worktree's terminal over and over until a check command or an evaluator
  says the work is done. Pick until-done, a fixed interval, or a queue of prompts, from the + menu
  or with `orca loop`. A loop rail shows each iteration and lets you pause, steer, edit, or stop
  it, with optional caps on iterations, minutes, and cost. A loop keeps running after its tab
  closes, works over SSH, and shows its status in `worktree ps` and on mobile worktree rows.

### Changed

- Native chat code blocks now use upstream's syntax highlighter. The fork's own code-block
  coloring is gone, so inline code in chat prose no longer gets the fork's accent chip. Tool
  icons in chat keep their fork coloring.
- Pull request CI now runs only the essential gates: the fork ownership guard, lint and
  typecheck, unit tests, and cross-version wire checks. The standalone test workflows are off.
- The daily upstream sync builds on an open sync PR for an older release instead of stalling
  behind it, asks the owner when it needs a decision and waits for the answer, and checks locally
  what PR CI would reject before it pushes.

### Removed

- The fork's additions to the SSH relay are retired, because upstream replaced the relay with its
  managed remote host. Native chat transcript paging and live tail keep working for local chats.

### Fixed

- Pasting into the terminal dock's chat composer with Cmd+V, a paste event, or the app menu goes
  to the composer again, instead of to the terminal beside it.
- The hosted-review sitter now checks a pull request's conflicts against the base branch's current
  tip. It used to keep retrying a no-op merge against an old base commit after the base moved.
- The hosted-review sitter now waits for a GitHub workflow run to finish before rerunning its
  failed jobs, instead of failing on GitHub's "already running" refusal on every tick.
- Fork macOS release builds sign again. The packaged terminal host is now checked against the
  fork's own Apple signing team, not upstream's.

## [1.4.231-rc.0.zy02] - 2026-10-19

Not published: the build failed. Superseded by 1.4.231-rc.0.zy03.

Synced to upstream [v1.4.230](https://github.com/stablyai/orca/releases/tag/v1.4.230), by way of
[v1.4.227](https://github.com/stablyai/orca/releases/tag/v1.4.227).

### Changed

- Native chat code blocks now use upstream's syntax highlighter. The fork's own code-block
  coloring is gone, so inline code in chat prose no longer gets the fork's accent chip. Tool
  icons in chat keep their fork coloring.

### Removed

- The fork's additions to the SSH relay are retired, because upstream replaced the relay with its
  managed remote host. Native chat transcript paging and live tail keep working for local chats.

### Fixed

- Pasting into the terminal dock's chat composer with Cmd+V, a paste event, or the app menu goes
  to the composer again, instead of to the terminal beside it.
- The hosted-review sitter now checks a pull request's conflicts against the base branch's current
  tip. It used to keep retrying a no-op merge against an old base commit after the base moved.
- The hosted-review sitter now waits for a GitHub workflow run to finish before rerunning its
  failed jobs, instead of failing on GitHub's "already running" refusal on every tick.
- Fork macOS release builds sign again. The packaged terminal host is now checked against the
  fork's own Apple signing team, not upstream's.

## [1.4.231-rc.0.zy01] - 2026-10-19

Not published: the build failed. Superseded by 1.4.231-rc.0.zy02.

Synced to upstream [v1.4.230](https://github.com/stablyai/orca/releases/tag/v1.4.230), by way of
[v1.4.227](https://github.com/stablyai/orca/releases/tag/v1.4.227).

### Changed

- Native chat code blocks now use upstream's syntax highlighter. The fork's own code-block
  coloring is gone, so inline code in chat prose no longer gets the fork's accent chip. Tool
  icons in chat keep their fork coloring.

### Removed

- The fork's additions to the SSH relay are retired, because upstream replaced the relay with its
  managed remote host. Native chat transcript paging and live tail keep working for local chats.

### Fixed

- Pasting into the terminal dock's chat composer with Cmd+V, a paste event, or the app menu goes
  to the composer again, instead of to the terminal beside it.
- The hosted-review sitter now checks a pull request's conflicts against the base branch's current
  tip. It used to keep retrying a no-op merge against an old base commit after the base moved.
- The hosted-review sitter now waits for a GitHub workflow run to finish before rerunning its
  failed jobs, instead of failing on GitHub's "already running" refusal on every tick.

## [1.4.225-rc.0.zy03] - 2026-10-14

Synced to upstream [v1.4.224](https://github.com/stablyai/orca/releases/tag/v1.4.224).

### Changed

- The daily upstream sync now runs a cheap precheck first and skips the full run when upstream
  has shipped no new stable release, the newest fork release is published, and there are no
  unreleased fork commits. If the check can't decide, the sync runs as before.
- Fork releases are now watched until they're published, not just dispatched. A release whose
  build failed is noticed on the next run and re-run or recut instead of sitting as an empty
  draft, and problems that need the account owner, such as an expired Apple agreement, are
  reported for attention.

## [1.4.225-rc.0.zy02] - 2026-10-14

Synced to upstream [v1.4.224](https://github.com/stablyai/orca/releases/tag/v1.4.224).

### Changed

- Claude chat sends from the composer now report delivery the way upstream does. A message the
  terminal refused shows "Message not sent", and one whose delivery couldn't be confirmed is held
  as unconfirmed instead of being sent twice. Sends are still dropped safely when a terminal
  reattaches.
- Answers to an agent's multi-part question are typed group by group, each waiting for the
  previous one to be acknowledged, so a slow answer is no longer overtaken by the final Enter.
  Over SSH this uses the paired host's own acknowledgement.
- Chat width now follows upstream's chat width setting on every surface, including the terminal
  dock. The fork's separate width tiers are gone.
- The tool line in chat tints upstream's icon and verb by tool category, replacing the fork's
  glyph and monospace tool name.
- Automation raw arguments now use upstream's extra agent arguments field. The fork's
  `--agent-args` flag and editor field are removed. Saved arguments move over verbatim, and an
  argument outside upstream's allowed list makes that automation's runs fail with an error until
  it's fixed.

### Fixed

- Fork releases build and publish again. Since the v1.4.222 sync, every release stopped before
  the macOS build because the release pipeline expected an analytics key this fork doesn't have.
  Telemetry stays off.
- An image pasted into a question card's answer box attaches to the composer again instead of
  being dropped.
- Pasting into the fork composer works with upstream's paste handling again.
- A chat attachment whose preview can't be read shows the chip without a thumbnail instead of
  raising an error.
- Agent state rules update from upstream's releases again. They had been looking for updates in
  this fork, which publishes none.
- Fork launches, handoffs and Heimdall worker reports work with upstream's new launch API and its
  removal of the orchestration capability token.
- Stopping a structured agent session before it picks up a message puts that message back in the
  composer again, including while an IME composition is in progress. Text put back while the
  composer was closed appears when it reopens.

## [1.4.225-rc.0.zy01] - 2026-10-12

Not published: the build failed. Superseded by 1.4.225-rc.0.zy02.

Synced to upstream [v1.4.224](https://github.com/stablyai/orca/releases/tag/v1.4.224).

### Changed

- Claude chat sends from the composer now report delivery the way upstream does. A message the
  terminal refused shows "Message not sent", and one whose delivery couldn't be confirmed is held
  as unconfirmed instead of being sent twice. Sends are still dropped safely when a terminal
  reattaches.
- Answers to an agent's multi-part question are typed group by group, each waiting for the
  previous one to be acknowledged, so a slow answer is no longer overtaken by the final Enter.
  Over SSH this uses the paired host's own acknowledgement.
- Chat width now follows upstream's chat width setting on every surface, including the terminal
  dock. The fork's separate width tiers are gone.
- The tool line in chat tints upstream's icon and verb by tool category, replacing the fork's
  glyph and monospace tool name.
- Automation raw arguments now use upstream's extra agent arguments field. The fork's
  `--agent-args` flag and editor field are removed. Saved arguments move over verbatim, and an
  argument outside upstream's allowed list makes that automation's runs fail with an error until
  it's fixed.

### Fixed

- An image pasted into a question card's answer box attaches to the composer again instead of
  being dropped.
- Pasting into the fork composer works with upstream's paste handling again.
- A chat attachment whose preview can't be read shows the chip without a thumbnail instead of
  raising an error.
- Agent state rules update from upstream's releases again. They had been looking for updates in
  this fork, which publishes none.
- Fork launches, handoffs and Heimdall worker reports work with upstream's new launch API and its
  removal of the orchestration capability token.

## [1.4.219-rc.0.zy01] - 2026-10-01

Synced to upstream [v1.4.218](https://github.com/stablyai/orca/releases/tag/v1.4.218).

### Fixed

- Stopping a structured agent session before it picks up a message puts that message back in the
  composer again, including while an IME composition is in progress. Text put back while the
  composer was closed appears when it reopens.

## [1.4.216-rc.0.zy03] - 2026-09-29

Synced to upstream [v1.4.215](https://github.com/stablyai/orca/releases/tag/v1.4.215).

### Added

- The `orca` CLI can now manage Heimdall watchers end to end: create, budget (decimal `--hours`
  are rounded), approve, and answer escalations, with workspace selection and enrollment refusals
  reported consistently.

### Fixed

- A pull-request sitter no longer merges until every check on the current head commit has passed;
  failures the sitter can fix itself are recovered first, and GitLab hosts without status checks
  are tolerated.
- Heimdall stops watchers whose registered workspace has been removed, after confirming the
  workspace is really gone rather than just unreachable.
- Objective watchers clean up applied dispatch worktrees on every tick. Worktrees that vanished or
  hold uncommitted changes are kept and noted instead of force-removed.
- A malformed batch of Jev judgments no longer discards the valid answers in it, and the failure is
  diagnosed without state notices leaking into recorded reasons.

## [1.4.216-rc.0.zy02] - 2026-09-29

Synced to upstream [v1.4.215](https://github.com/stablyai/orca/releases/tag/v1.4.215).

### Added

- Automations and source-control agent recipes can set the model, reasoning effort, and extra
  agent arguments for the agents they launch, and each automation run records the launch settings
  it used.
- Heimdall notices a supervised worker that has sat idle at its prompt for two minutes without
  reporting, and shows the watcher's owner the worker's last message. The owner can reply straight
  into the worker's prompt; a watcher with no owner hands a question asked in plain prose to you.
- When a watcher has an owner, its workers' questions now go to that owner instead of appearing as
  cards in the app, including questions from structured Claude and Codex workers. The owner's reply
  is returned to the worker. A paused watcher's workers still ask you directly.
- An objective watcher can be enrolled into a new worktree created for it, picked as "New worktree
  in <repo>" with a name and base branch. The worktree is removed again if enrollment fails.
- The Heimdall sidebar entry shows how many watchers need attention, have lost contact, are
  active, or are inactive.

### Fixed

- An owner's answer aimed at a question it could not reach no longer stalls the watcher on every
  tick and starves later questions. The owner is told why the answer was refused, and an answer
  that stays undeliverable is handed to you after the stall window.
- A local, repeatable watcher failure is now shown as "Error · retrying" instead of being reported
  as lost contact with the host.
- The objective planner no longer tells workers to rely on machine-local files, such as
  `.claude/settings.local.json`, that a fresh worktree may not have.

## [1.4.216-rc.0.zy01] - 2026-09-28

Synced to upstream [v1.4.215](https://github.com/stablyai/orca/releases/tag/v1.4.215).

### Added

- Heimdall watchers. A hosted-review sitter watches a pull request, runs gated fixes, keeps the
  branch up to date, and merges it once it is green. An objective runner takes a structured plan
  through to a landed change, tracking each step from files on disk to committed, pushed, reviewed,
  and merged. Both are durable across restarts, have per-watcher budgets and emergency stop
  controls in the Heimdall UI, and can be driven over remote connections. `orca heimdall debug`
  reports a watcher's state from the CLI.

### Fixed

- Sending a message from the terminal dock into a fresh Claude Code session no longer lands below
  a wall of blank lines without submitting. Claude Code read the dock's input-clearing keystrokes
  as a paste; they now go out in small, paced writes, and a cancelled send finishes its cleanup
  before the next one starts.
- The terminal dock no longer throws on a pane that has no stable id; it treats that pane as
  undocked.
- Heimdall watchers keep working against v1.4.215's stricter orchestration caller checks.

### Changed

- Adapted the fork's features and tests to upstream v1.4.215's changed signatures, removed helpers,
  and new test harnesses, with no change in fork behaviour.
- CI's real-IME end-to-end step runs only its own spec again instead of the full e2e suite, which
  had made it time out after the Playwright upgrade. This is an upstream fix taken ahead of the
  stable tag that carries it.
- The remote test sandbox image builds again after upstream's Electron install step began importing
  shared code.
- The upstream sync process now stops when an older tag's sync PR is still open or an upstream tag
  was retracted, adopts new lint rules automatically, and catches more classes of module split.

## [1.4.208-rc.0.zy01] - 2026-09-22

Synced to upstream [v1.4.207](https://github.com/stablyai/orca/releases/tag/v1.4.207).

### Fixed

- Typing in the quick-open file search or the right sidebar's file-explorer filter no longer leaves
  the previous query's results on screen for a moment; both lists now clear and re-filter as the
  query changes. This comes from upstream.

### Changed

- The fork's own record of which upstream files it copies wholesale was advanced to this release.
  Nothing upstream changed in any copied file, so no fork behaviour moved with it.

## [1.4.207-rc.0.zy02] - 2026-09-21

Re-synced to upstream [v1.4.206](https://github.com/stablyai/orca/releases/tag/v1.4.206). Upstream
retracted the v1.4.206 tag that 1.4.207-rc.0.zy01 was built on and re-cut it from trunk at a
different commit, adding 325 commits the retracted tag never carried.

### Added

- Upstream's mobile web app bundle, terminal performance work, editor diff improvements and
  OpenCode 2 beta support arrive with the re-cut release.

### Fixed

- The docked terminal composer no longer crashes pane close in setups that report no settings
  snapshot, which previously surfaced as a failure when closing a split or a pending pane.
- Mobile browser frames decode image data again in the browser-served mobile app; the frame reader
  had been importing Node's Buffer in a form the web bundle cannot resolve.

### Changed

- The fork's packaging and sandbox test inventories now describe this repository's own job set
  rather than upstream's, so they stop reporting a Windows packaging job the fork does not run and
  they skip the same relay region suites CI does.
- Native chat keeps reading the agent's own session log for its model and effort while also using
  upstream's new live agent-status model discovery, rather than one replacing the other.

## [1.4.207-rc.0.zy01] - 2026-09-18

Synced to upstream [v1.4.206](https://github.com/stablyai/orca/releases/tag/v1.4.206), absorbing
v1.4.204, v1.4.205 and v1.4.206 in one step.

### Fixed

- A parked `orca ask` no longer starves worker-to-coordinator messaging. Waiting on a human used to
  hold one of eight shared long-poll slots for the full chunk, so eight agents waiting at once shed
  every later `orchestration.ask` — which has no shed tolerance — and browser attach with it. Waits
  are now metered on their own per-runtime gate of four, and overflow is reported as a resumable
  pending ask rather than a failure.
- Stale terminal input can no longer reach a replacement PTY after a reattach, and the same
  quarantine now covers native-chat sends.
- Cancelling a session handoff cancels its repository diff probes all the way through, instead of
  leaving them running against a worktree nobody is waiting on.
- Git errors that span several lines keep their full diagnostic text instead of being truncated to
  the first line.
- Interrupted release cuts can be recovered: a draft RC whose tag already exists is completed rather
  than abandoned.
- The packaged fork's macOS computer-use helper authorizes its own peers, so computer use works in a
  packaged build without widening bundle-prefix trust.
- The POSIX garbage-collection listing test no longer creates and removes 15,197 directories on the
  test host; it feeds the real shell filter a synthetic listing instead.

### Changed

- Fork code adopts the eight `anti-slop` lint rules upstream enabled in v1.4.206, following
  upstream's own renames for each rule. Symbol names and parameter types only — no behaviour
  changed.
- The sandboxed test runner tracks CI's shell-contract lane again after upstream moved the OMP
  alias-safety suite out of the unit lane.

## [1.4.204-rc.0.zy01] - 2026-09-15

Synced to upstream [v1.4.203](https://github.com/stablyai/orca/releases/tag/v1.4.203).

### Fixed

- Release-notes links opened a 404 for everyone on a fork build, and the dev build picker listed
  upstream's releases instead of this fork's. Stable and RC lookups now both resolve against the
  fork's own repository.
- The macOS press-and-hold default — the one that turns accented-character popups back into key
  repeat — was gated on upstream's bundle identifier, so it silently never applied to a fork build.
- macOS permission prompts were counted against upstream's dev bundle identifier while the
  TCC watch had already moved to the fork's, so prompts from a stable dev build went unrecorded.
- A long `orca ask` wait dropped its runtime connection after roughly twenty seconds and reported
  "Orca is not running", abandoning a question that was still live and durable. Long waits now stay
  alive and resume after a drop.
- The pending-ask count never appeared in the titlebar — the badge was written but never mounted,
  so there was no way to see that a question was waiting.
- Ledger import misread `**Key**:` labels, the common bold form, and a storage failure partway
  through aborted the run without resuming, leaving entries half-imported.
- In a split tab, the lineage badge could resolve an ambiguous legacy pane key to the wrong pane and
  jump to a sibling.
- Starting a session handoff against a target that could not be resolved did nothing at all, with no
  error. It now reports what is missing.
- A template save the server rejected failed silently in the handoff settings editor, leaving the
  editor looking as though the change had been kept.

### Changed

- Orca ask worktrees now carry their own sidebar icon.
- Two suites that read the POSIX shell lookup are isolated from the developer's zsh startup files,
  and the sandbox shard runner's exclude list matches CI's shell contracts again, so live-shell
  suites no longer run inside parallel shards locally.
- Internal documentation: the Orca ledger workflow for bugs and deferred work is written up, and the
  sync skill records how to size a module split by line count and diagnose a type-only gate.

## [1.4.203-rc.0.zy01] - 2026-09-14

Synced to upstream [v1.4.202](https://github.com/stablyai/orca/releases/tag/v1.4.202), absorbing
v1.4.201 in the same step.

### Fixed

- `npx skills add` cloned upstream, so every skill this fork ships that upstream does not have was
  missing from the tree the installer read. It now installs from this fork's own repository.
- The docked agent composer kept focus when a pane had one, but upstream's new chat-cover rule
  could focus the terminal underneath it instead. A pane with a dock composer now hands focus
  straight to it, and every other pane follows upstream's rule.

### Changed

- The mid-prompt `/` picker is now upstream's: it offers commands as well as skills mid-draft, and
  opens for any agent with a known grammar. A pick made mid-sentence still completes the token
  rather than sending it.
- `$`-prefixed skill triggering is gone — upstream routes every agent's skills through `/`.

## [1.4.201-rc.0.zy03] - 2026-09-13

Synced to upstream [v1.4.200](https://github.com/stablyai/orca/releases/tag/v1.4.200) — no new
upstream stable release since the previous fork build.

### Added

- `orca ask` lets an agent working in an Orca terminal put a real question to you and block until
  you answer it — select, multi-select, text, number, date, or confirm — with the answer coming back
  as a structured JSON envelope. A question that outlives a single invocation is resumed with
  `orca ask wait` instead of holding a shell open, and `orca ask cancel` withdraws one the agent no
  longer needs. The pane, terminal, and worktree an ask came from are recorded automatically, so it
  reaches the right place with no flags to set.
- Questions arrive as cards in a new Questions panel in the right sidebar, keeping your draft while
  you think about it. One left unanswered escalates to a notification, and one raised while no UI is
  attached is handed to the coordinator rather than stranding the agent. Registered questions are
  stored durably rather than held in memory.
- Claude sessions launched by Orca now suppress Claude's own `AskUserQuestion` prompt when the
  installed `claude` binary is new enough to honour it, leaving one question surface rather than
  two. The check fails open: a version that can't be read, or one below the floor, just leaves
  Claude's prompt in place. The `orca-ask` skill guide ships with the bundled skill set.

## [1.4.201-rc.0.zy02] - 2026-09-12

Synced to upstream [v1.4.200](https://github.com/stablyai/orca/releases/tag/v1.4.200) — no new
upstream stable release since the previous fork build.

### Added

- Project and group ledgers: a durable, validated record of decisions and findings that lives with a
  project rather than in a scratch file. Entries carry provenance, revision history, and a triage
  state, can be imported in bulk, and are browsable from a new sidebar view that filters by scope —
  workspace, project, or group — and names the owner each entry resolves to. The `orca ledger`
  command reaches the same data from the CLI, including on remote hosts, with list and review
  filters and positional entry IDs.
- Ledger staleness thresholds now live in repository settings and are reachable by deep link, so a
  project can say for itself when an entry counts as going stale.

### Changed

- Removing a project or group checks its ledger first and refuses on a revision conflict rather than
  silently discarding entries, and a rejected save keeps its error visible while leaving the form
  usable instead of clearing what you typed.
- The upstream-sync runbook now withdraws a fork file deletion when a new upstream release starts
  importing the module the fork deleted. That case reached the previous sync as a type error against
  upstream's own new files, with every ownership check still passing.

## [1.4.201-rc.0.zy01] - 2026-09-11

Synced to upstream [v1.4.200](https://github.com/stablyai/orca/releases/tag/v1.4.200), absorbing
v1.4.199 and v1.4.200 in one span.

### Added

- The sidebar can now hide workspaces you are not working on: filter by how recently a workspace was
  active — including a custom date range — and by whether its review is finished and its checks are
  passing. The choices persist per pairing, and the header says how many workspaces are hidden so a
  filtered list never looks like a missing one.

### Changed

- A file dropped on a chat composer now attaches only to the composer it landed on. Upstream shipped
  its own version of the fix this fork had been carrying, so the fork's copy is retired in favour of
  it; the behaviour is the same and it now covers every composer, not just this fork's.
- Skill and slash-command suggestions come from what the running session reports it actually loaded,
  and still name the plugin each skill belongs to. The two used to be alternatives; they now compose,
  so a skill offered by more than one plugin stays disambiguated.
- PR CI no longer scans a sync-sized diff line by line, and the Windows lanes this macOS-only fork
  cannot use are gone. Sync pull requests stop burning their budget on checks that could not finish.

### Fixed

- The terminal no longer loses its composer draft or its focus after a window wake while a chat view
  covers the pane — an effect had stopped re-running when the chat view was toggled.

## [1.4.199-rc.0.zy01] - 2026-09-10

Synced to upstream [v1.4.198](https://github.com/stablyai/orca/releases/tag/v1.4.198), absorbing
v1.4.196, v1.4.197 and v1.4.198 in one span.

### Added

- Optional divider lines between the sidebar's top-level projects and groups, switchable from
  Appearance and findable through settings search. They do not affect layout, and default to on, so
  an existing sidebar looks the same until the setting is turned off.

### Changed

- The fork's seams survived upstream's largest module split yet. v1.4.198 broke `main/index.ts`, the
  chat composer and the terminal pane into separate modules; nine seam barrels were re-homed onto the
  new files, and the terminal dock now reaches the pane through a controller bridge inside
  `TerminalPaneSurface` rather than riding its lifecycle hook. That also keeps the dock clear of
  upstream's per-pane listener budget and leaves a dock-less tab on upstream's own single-argument
  focus call. No behavior change.
- The fork's preload API types are covered by the renderer typecheck projects, which had not been
  seeing them.

### Fixed

- The sidebar-separator setting has the French catalog it was missing. v1.4.198 adds French to the
  locale set and the setting was written before it, so its keys had no French bundle to resolve from
  and the catalog gate rejected the merged tree.

## [1.4.196-rc.0.zy02] - 2026-09-03

Synced to upstream [v1.4.195](https://github.com/stablyai/orca/releases/tag/v1.4.195).

Re-cut of `1.4.196-rc.0.zy01`, which created a tag and a draft but never produced a build. That
draft and `1.4.195-rc.0.zy01`'s are left in place; neither was ever published, and neither carries
artifacts.

### Fixed

- Releases build again. Both release workflows pinned pnpm 10.24.0 while `packageManager` — which
  the fork takes from upstream — had moved to pnpm 12, and the setup action refuses that
  combination outright rather than picking one. Every cut since 2026-09-01 therefore tagged a
  version and then died before building anything, leaving a draft release with no installers in
  it. The workflows now use the same action upstream and the fork's own PR CI already use, which
  reads the version from `packageManager` instead of pinning its own. The macOS build had not
  failed yet only because it runs behind the jobs that did.

### Changed

- The sync procedure gained what the last two syncs cost. The merge and ownership commits now
  bypass the pre-commit hook, which otherwise lints a deliberately half-resolved tree and reverts
  the resolution it was about to repair. Reset upstream tests are swept for pinned upstream
  release tags absent from this fork's remote — the third such constant aborted an entire PR CI
  suite. Static-analysis findings on upstream code a release introduces are now in scope for the
  sync's fix policy, since every upstream line reads as a changed line on a sync PR. And release
  workflows get a toolchain pass of their own: nothing in PR CI runs them, so a fork exception
  that discards an upstream toolchain bump stays green until someone cuts a release, which is
  exactly how the pnpm pin above survived.
- `BUGS.md` records that the pipeline's stuck-draft recovery matches bare `-rc.N` tags only, so
  this fork's `.zyNN` releases are never candidates for it. No behavior change.

## [1.4.196-rc.0.zy01] - 2026-09-02

Synced to upstream [v1.4.195](https://github.com/stablyai/orca/releases/tag/v1.4.195).

### Fixed

- The Session Info sidebar still reports Claude's hook status. Upstream removed the `agentHooks`
  IPC surface as dead code — it had no callers left there, but the fork's panel read
  `claudeStatus()` from it. The row now goes over the fork's own Session Info bridge, which reaches
  the same unchanged main-process service.
- The browser annotation tray no longer paints a frame still in edit mode for an annotation that
  has just been deleted or cleared. The edit state is reset while rendering instead of afterwards
  in an effect. Filed for upstream.

### Changed

- The fork's composer picks up upstream's app-menu Select All fix. Upstream landed it in the chat
  composer it replaced, so it is replayed into the shared composer core, where it reaches the
  docked terminal composer as well.
- Upstream's new attachment preview is deliberately not adopted: the fork already renders image
  thumbnails in its own composer chips, and swapping in upstream's component would reconcile that
  away. Only the per-attachment connection id it introduced was taken.
- The release pipeline gains upstream's `release-preflight` gate ahead of macOS signing, minus the
  two skill-sharing gates this fork's macOS-only pipeline does not define.
- Two cross-version and updater tests now exercise the fork's own release feed and tags instead of
  upstream's, which do not exist on this remote.

## [1.4.195-rc.0.zy01] - 2026-09-01

Synced to upstream [v1.4.194](https://github.com/stablyai/orca/releases/tag/v1.4.194).

### Added

- A Session Info sidebar for the focused agent terminal, showing live context, usage, identity,
  activity, files, hooks, and MCP servers for that exact session and pane. A custom Claude
  statusline survives, because the fork chains its own telemetry rather than replacing it, and MCP
  servers are deduplicated by name across config scopes.
- Shared artifacts can be passphrase-protected. Content is encrypted in the browser before upload,
  the passphrase is stored locally, and protecting, rotating, removing, and recovering protection
  all work from the CLI, the RPC layer, and the desktop UI.

### Fixed

- Passphrase protection is now reachable from the desktop app at all. Every protect, rotate,
  make-public and reveal action threw for the renderer, whose IPC bridge dispatches as a runtime
  client, so only the CLI could use the feature. The same pass fixed a replacement passphrase being
  minted under a key that was never persisted, a removal that could brick a source key for later
  shares, a stale removal intent that could republish a deleted artifact's plaintext, protection
  state leaking into results that paired clients are meant not to see, an unregistered locale
  bundle that left every non-English catalog empty, an "unknown on this version" message shown
  while the status lookup was still in flight, and a re-validation of the whole store once per
  record on every list refresh.
- The changed-lines type-aware code-quality scan no longer reaches into `mobile/`. It pinned the
  root oxlint config over a workspace that has its own config, lockfile, and uninstalled
  dependencies, so every React Native type resolved as an error type and the rule fired on the
  resolution failure rather than on the code. Filed for upstream.

### Changed

- The remote test sandbox follows upstream onto pnpm 12 and off the deleted `.npmrc`.
- Contributor docs now describe the forked Native Chat architecture and its runtime changes, and
  point local typechecking at the per-project commands so a full sweep cannot saturate the machine.

## [1.4.194-rc.0.zy01] - 2026-08-31

Synced to upstream [v1.4.193](https://github.com/stablyai/orca/releases/tag/v1.4.193).

### Added

- The docked terminal composer now renders Markdown as you type, over a draft that stays raw
  underneath, so styling never rewrites what will actually be sent.

### Changed

- Focus goes to an enabled dock composer before falling back to the terminal beneath it, so typing
  after a reveal or reattach lands where the composer is showing.
- Upstream's updated structured native-chat session (Codex, off by default behind
  **Use updated structured native chat**) now runs through this fork's shared agent composer rather
  than a second chat-only one, so the chat pane and the terminal dock keep one draft, history, and
  attachment path.

### Fixed

- Continue-in-new-session no longer hands over a stale transcript. A fork-owned probe authorizes
  against the Vault's agent-source roots and walks an ordered candidate chain — reported path,
  session id, pane history, then project scan — recording where each answer came from. Ambiguous
  project scans are refused rather than guessed, an unreachable host now reports `unverifiable`
  instead of `missing`, and the same chain runs against SSH targets.
- Claude's startup options repaint as PTY output settles, so the model and effort pills stop showing
  a stale selection from the previous session.
- Switching a pane's PTY resets the reported screen state, and composer scroll sync now initializes
  once the textarea ref attaches — fixing a desynced overlay on the first paint after a switch.
- Inline Markdown scanning is bounded per line, so a long draft no longer degrades typing latency.
- The packaged CLI can resolve `claude-accounts/keychain` again; it was missing from the fork's
  `asarUnpack` list, which a restored packaging check caught.
- `use-checks-list-state` no longer writes a ref inside a state updater. React may run an updater
  more than once, so the write moved into the effect that queues it.

## [1.4.191-rc.0.zy01] - 2026-08-26

Synced to upstream [v1.4.190](https://github.com/stablyai/orca/releases/tag/v1.4.190).

### Added

- Continue a coding-agent session in a new one. A continuation dialog composes a handoff brief from
  the source pane or an AI Vault session, previews and edits it, scans it for secrets, resolves the
  target environment, and launches the receiving agent. Parent and child sessions are linked, and
  the relationship shows as a badge on agent rows and in the vault. Briefs can be built from a
  user-editable template catalog, with its own Settings pane and per-template steering notes.
- The right sidebar's Source Control glyph now carries a dot whenever the active worktree has
  uncommitted changes, and the count rides in the button title so the tooltip and the accessible
  name both carry it — color is never the only signal. Rows inside an expanded submodule are left
  out of the count so expanding one cannot make the number jump, and a truncated `git status`
  reports "N+" rather than a total it cannot know.
- Composer attachment chips show the image itself instead of a generic icon, so a composer holding
  several images is readable at a glance. On an SSH worktree the chip reads the client-local file
  the upload came from, since the remote path it attaches is not readable on the client.
- A setting controls whether the terminal composer docks itself automatically. It defaults to on,
  and turning it off suppresses automatic docking without closing composers that are already
  mounted. An explicit decision to undock now persists across clients, while an agent exiting can
  still bring the composer back.

### Fixed

- The skill picker scanned the frozen cache copy of a `directory`-sourced Claude Code marketplace
  rather than the live directory the harness actually loads plugins from, so it offered whatever
  skill set existed at the last `claude plugin update`. Directory marketplaces now resolve to their
  live `skills` directory; `github` and `git` marketplaces are untouched, because their cache copy
  is what the harness loads. A malformed registry degrades to the cached roots rather than dropping
  a plugin.
- A native file drop was broadcast to every mounted composer, so one drop attached to all of them.
  A drop now carries the tab and pane it landed on, and a composer ignores one addressed elsewhere.
- Live plugin-marketplace discovery inside WSL kept working across upstream's move to a single
  `wsl.exe` runner. The read now goes through that runner instead of spawning `wsl.exe` itself.

### Changed

- The upstream sync no longer runs the test suite locally before opening its pull request. That run
  went to a single shared Docker host, where sharding it produced timeout, perf-budget, and
  temp-file failures on a different random subset each time — none of them caused by the code. The
  pull request's own CI, which runs the same suite on clean hosted runners, is now the only test
  gate.

## [1.4.189-rc.0.zy02] - 2026-08-26

Synced to upstream [v1.4.188](https://github.com/stablyai/orca/releases/tag/v1.4.188).

### Changed

- Upstream syncs now land through a pull request rather than pushing `main` directly, so the fork
  ownership guard and the rest of PR CI run on every resolution before `main` moves. The sync
  procedure also gained a fix policy that separates failures a run may resolve on its own from ones
  that have to stop and ask a person.
- `pnpm test` no longer starts Vitest on a developer machine. It refuses unless it is running in CI,
  in a container, or under an explicit opt-out, and points at the sandboxed shard runner instead;
  where it does run, the worker pool is capped at half the host's cores.

## [1.4.189-rc.0.zy01] - 2026-08-24

Synced to upstream [v1.4.188](https://github.com/stablyai/orca/releases/tag/v1.4.188).

### Fixed

- Closing the docked composer no longer leaves a dead strip below the terminal. The pane's geometry
  effect used to re-run after the composer's own cleanup had zeroed the slot and write the gutter
  height straight back, so the terminal never grew into the space it had just been given.
- The docked composer no longer shows "No terminal session" over a live pane. It reads the pane's
  PTY id during render, and a reattach that lands on the id the layout already holds — recovery
  remount, tab move, web-mirror remount — used to produce no re-render at all, stranding the
  composer on the value it read while the attach was still pending.
- The fork's skill release ledger is now declared fork-owned, so a sync can no longer replace it
  with upstream's rows. Those rows name tags that exist only on `stablyai/orca`, which killed the
  skill-update roundtrip check across every matrix job the last time a sync took them.

### Changed

- The agent composer's draft, history, and attachment caches are built from one shared scope cache
  instead of three copies, the terminal-dock gutter clamp lives in one module rather than six call
  sites, and the dock-state merge paths are collapsed onto a single routine. Net 195 lines removed,
  with no behaviour change.

## [1.4.188-rc.0.zy01] - 2026-08-22

Synced to upstream [v1.4.187](https://github.com/stablyai/orca/releases/tag/v1.4.187).

### Added

- A rich-input composer can now be docked beneath a terminal pane running a supported coding-agent
  CLI, so a prompt can be drafted, edited, and sent without typing into the TUI, with the terminal
  still visible underneath as a fallback. Send and Stop are separate controls rather than one button
  that flips, and the pane quarantines input after its PTY endpoint is replaced so a send cannot land
  in the wrong session. Behind an experimental flag.
- `pnpm test:sandbox` runs the test suite in throwaway Docker containers, sharded, either locally or
  on a remote host. Shards no longer see each other's temp files, git config, or build output.

### Changed

- File ownership across the fork is now declared in `config/fork-ownership.json` and enforced in CI,
  instead of being inferred from commit authorship. Each fork change belongs to one of four tiers,
  and a PR that adds a fork file matching no manifest entry fails the ownership guard. This is what
  keeps a fork change from being silently reset the next time upstream is merged.
- The upstream-sync procedure now lives in a git-tracked skill rather than an automation prompt, so
  there is a single copy under test.
- Release builds register the `orca://` URL scheme, matching upstream.
- The release pipeline now runs least-privileged: the workflow's default token grants read-only
  access to repository contents, with write scoped to the single job that needs it.

### Fixed

- The workspace sidebar's tighter row spacing is applied again. Upstream moved the module holding it
  during a refactor, and because the fork still claimed the old path, the build had been shipping
  upstream's roomier spacing while the fork's copy sat unused. Drop targets line up with the rows as
  drawn once more.
- Reconnecting an SSH terminal surfaces the underlying error again, and native-chat panes hosted on
  a remote machine keep reading transcripts over this fork's relay through upstream's module split.
- Cross-repo worktree groups, the docked composer, and per-pane chat width all survive upstream's
  restructuring of the sidebar into ~105 modules; their behavior is unchanged.

## [1.4.185-rc.0.zy01] - 2026-08-17

Synced to upstream [v1.4.184](https://github.com/stablyai/orca/releases/tag/v1.4.184).

### Changed

- Native Chat continues to read transcripts over this fork's SSH relay. Upstream replaced that path
  with a WSL filesystem admission gate, which this build does not adopt, so reading transcripts from
  a remote host behaves exactly as it did before the sync.
- The workspace sidebar keeps this fork's tighter row spacing rather than upstream's roomier
  virtual-row gap, so drag-and-drop drop targets stay aligned with the rows as drawn.
- Index checks in two fork-owned files were rewritten to satisfy lint rules upstream newly enabled.
  No behavior changes; it keeps future upstream syncs from stalling on a toolchain change alone.

## [1.4.183-rc.0.zy01] - 2026-08-14

Synced to upstream [v1.4.182](https://github.com/stablyai/orca/releases/tag/v1.4.182).

### Added

- The native chat transcript is colored. Each recognized agent tool takes its own glyph and hue on
  its line, and a collapsed run of tool calls shows one dot per distinct kind of work in the order
  it first appeared — so a folded run says what happened without being expanded. Code blocks and
  inline code in chat are syntax-highlighted, the user bubble and reasoning rule are tinted, and
  every new color is held to a contrast floor in both themes. Tool names are matched exactly, so an
  agent whose vocabulary Orca does not know renders exactly as before rather than being assigned a
  color that claims something untrue about the call. Glyphs carry the same distinction as the hues,
  so color is never the only signal.

### Fixed

- Electron downloads that fail with an HTTP status response are retried instead of failing the run.
  The transient-error check read only `statusCode`, but the error raised for a rejected fetch
  carries `status`, so release-CDN 503s aborted on the first attempt and took several test lanes
  down at once.

### Changed

- Upstream code the fork does not own now tracks v1.4.182 directly. Where this release extended the
  same code the fork's SSH-relay chat feature touches, both sides are kept: upstream's transcript
  read cancellation, subscription teardown, quick-command matching, and cross-device workspace
  filtering are back alongside the fork's relay work. Files the fork does own — the workspace card,
  the live chat session hook, and the macOS-only signed build configuration — stay on the fork's
  versions, and three upstream tests that assert behavior this fork deliberately does not carry
  were dropped.

## [1.4.181-rc.0.zy03] - 2026-08-13

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Fixed

- Chat view now reads transcripts over the SSH relay when a pane is hosted on a remote machine.
  Previously it always read from local disk, so an SSH-hosted conversation showed a read error and
  the first message only appeared after toggling to the terminal and back. A transcript that does
  not exist yet is treated as an empty conversation rather than a failure, oversized snapshots are
  clipped to a wire byte budget instead of being lost, byte-bounded pagination can reach older
  history, subscriptions re-arm when the relay reconnects so an idle pane recovers on its own,
  retained sessions are keyed by SSH connection so rebinding a pane between hosts cannot show the
  previous host's messages, and read failures surface inline with a retry option.
- CI retries the Electron download failures it actually hits — refused HTTP/2 streams and 5xx
  responses are now classified as transient, with a retry budget long enough to outlast observed
  CDN degradations.

## [1.4.181-rc.0.zy02] - 2026-08-12

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Added

- An architecture reference for the plugin subsystem, covering the trust tiers, the contribution
  types a manifest can declare, the host API available to each runtime, and the limits that apply
  to plugin workers and panels.

### Fixed

- Skill updates verify again. The v1.4.180 sync adopted upstream's skill ledger, whose release rows
  name upstream tags that do not exist on this fork, so the roundtrip check failed outright. The
  ledger is now rebuilt from the fork's own release tags, and the check stands down for a skill that
  has only one recorded revision to move between — it reactivates on its own as fork releases
  accumulate.
- The upstream-sync skill is tracked in git again. It lived under a gitignored path, so the sync
  automation would have called a skill its checkout could not see.

### Changed

- Local memsearch index data is ignored instead of surfacing as untracked files.

## [1.4.181-rc.0.zy01] - 2026-08-11

Synced to upstream [v1.4.180](https://github.com/stablyai/orca/releases/tag/v1.4.180).

### Added

- Worktrees can be placed in a project group independently of the group their repo belongs to, so
  the sidebar can group related work across repositories. Grouping is presentational — running
  commands stays scoped to each worktree's own repo.

### Fixed

- The native chat view no longer blanks to a loading pane when an agent finishes its turn. Session
  retention could discard messages the live view had already committed to showing; it now only ever
  adds to that list.
- Deleting a provider session from the AI Vault is available again, together with upstream's fixes
  that block deletion of a live session and contain deletion on WSL. The fork had been carrying an
  upstream revert of this feature that upstream itself had already superseded.
- The Cmd+J palette picks up upstream's current open-tab search, recent chats and terminals, and
  digit shortcuts. The fork had been holding an earlier draft of the same work.

### Changed

- Upstream code the fork does not modify now tracks each upstream stable release directly, instead
  of preserving whatever variant an earlier sync happened to inherit. Several subsystems had drifted
  onto stale copies that upstream had since reworked.

## [1.4.178-rc.0.zy01] - 2026-08-09

Synced to upstream [v1.4.177](https://github.com/stablyai/orca/releases/tag/v1.4.177).

## [1.4.177-rc.0.zy01] - 2026-08-07

Synced to upstream [v1.4.176](https://github.com/stablyai/orca/releases/tag/v1.4.176).

### Added

- Native chat panes have a configurable reading column. Pick a width from the new menu in the pane
  header, or set the default for every pane from the experimental chat settings. The tier names and
  descriptions are translated into Spanish, Japanese, Korean, and Chinese.
- A checked-in `.nvmrc` pinning Node 24, so `nvm use` matches the version the project already
  requires. Upstream removed the file; the fork keeps it.

### Fixed

- The chat width menu no longer appears in the pane header when the experimental native chat
  surface is switched off. It read the tab's raw view mode rather than the mode actually in effect,
  so a chat-only control could surface on a plain terminal pane.

### Changed

- The fork no longer carries its own copy of the orchestration subsystem. It was restored here
  after upstream pulled it from the v1.4.161 release branch, but upstream has since shipped a newer
  version of the same code, so the fork now tracks upstream's directly. This brings creator-dispatch
  task attribution and the newer worker-release handling that the fork's copy never had.
- Two upstream fixes the fork had picked up early — the relay's refusal to fall back silently when
  a pairing invite fails, and the new-workspace flicker when typing ahead of search — are dropped in
  favour of upstream v1.4.176's versions of those files. They return when upstream ships them.

## [1.4.163-rc.0.zy01] - 2026-07-30

Synced to upstream [v1.4.162](https://github.com/stablyai/orca/releases/tag/v1.4.162).

### Added

- Orchestration is back. Upstream pulled its orchestration primitives and connected-server workers
  out of the v1.4.161 release branch, and the fork inherited that removal when it synced. Upstream
  shipped the subsystem again in v1.4.162, so the orchestration CLI, runtime, and federation
  workers return with it.

### Fixed

- The macOS permission-prompt watcher new in v1.4.162 now recognises this fork. It counts the
  consent dialogs macOS raises in Orca's name, but matched only upstream's bundle identifiers, so on
  a fork build it silently counted nothing.
- Mobile pairing screens no longer break the Spanish, Japanese, Korean, and Chinese catalogs.
  Upstream shipped these strings in English only; the fork carries English placeholders for them,
  matching the fallback already shown at runtime, until upstream ships translations.

## [1.4.162-rc.0.zy01] - 2026-07-29

Synced to upstream [v1.4.161](https://github.com/stablyai/orca/releases/tag/v1.4.161).

### Fixed

- The `orca` command-line tool works again on this fork. Its launcher looked for a binary named
  `Orca` inside the app bundle, but fork builds ship it as `Orca Dev` so the app can install beside
  official Orca — so every invocation failed with "No such file or directory". The launcher now
  reads the bundle's own executable name instead of assuming upstream's.

### Changed

- Upstream's new local-build compatibility contract is pinned to this fork's application identity
  (`com.zpyoung.orca`). Locally-built artifacts are validated against the fork rather than upstream,
  so a local build installs over a fork build instead of being rejected as foreign.

## [1.4.160-rc.0.zy06] - 2026-07-28

Synced to upstream [v1.4.159](https://github.com/stablyai/orca/releases/tag/v1.4.159).

This build re-bases the fork on upstream's stable v1.4.159. Earlier `zy` builds were cut from
upstream trunk, which had already moved past 1.4.159 and carried an unreleased regression that left
a stale terminal pane painted over file tabs. The fork now follows upstream stable tags only, so
this release intentionally carries _older_ upstream code than 1.4.160-rc.0.zy05 despite the higher
version number.

### Added

- A `release` skill that records fork-owned changes in this changelog and dispatches the release
  pipeline, so fork cuts no longer collide with upstream's inherited rc numbering.

### Changed

- Releases are signed, notarized, macOS-only, and published to this fork, so a second Mac
  auto-updates from `zpyoung/orca` instead of upstream. The build installs under its own identity
  ("Orca Dev", `com.zpyoung.orca`) and runs alongside official Orca.
- Mac artifacts are arm64-only. Each architecture is a separate ~40-minute notarization submission
  under this fork's new Developer ID team, and no fork machine runs Intel.
- The left-sidebar workspace list is denser — tighter row gaps, shorter card padding, and a shorter
  section header — without changing worktree-to-worktree spacing.
- Telemetry transport is compiled out. The fork ships no PostHog project, and leaving it enabled
  failed the mac release build only after signing and notarization had already run.
- Release versions anchor on the newest upstream stable tag reachable from `main` rather than the
  trunk merge base, which would otherwise freeze once the sync tracks stable releases.

### Fixed

- Release builds no longer die mid-notarization. Apple takes ~43 minutes for this fork where
  upstream clears in ~9, so job and attempt timeouts are sized for the slower queue.
- The homebrew tap bump no longer runs on the fork, which has neither the upstream tap nor the app
  credentials it authenticates with.
- Settings-search keywords carrying the Ghostty brand name are allowlisted, so the localization
  coverage check passes.
- Sidebar host headers no longer overlap the row beneath them at the tighter row gap, and the focus
  ring on repo-header action buttons is no longer clipped.

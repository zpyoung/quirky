# Quirky roadmap

Quirky gets every feature in [research/orca-features/](../research/orca-features/README.md) in
eight milestones and two side tracks. M0 builds a plugin kernel and moves v1 onto it. After that,
features land in the order that lets Quirky replace Orca for daily work soonest: terminals and
agents, then review, agent extras and hosting. Background agents and supervision come after that.
You can stop opening Orca at the end of M4.

Each milestone gets its own spec before work starts. This file fixes the order, what goes in each
milestone and how each is judged done. [architecture.md](architecture.md) owns the design, and the
feature docs own how each feature behaves.

## What the order rests on

Decided with the user on 2026-10-26:

- **Shell:** Electrobun and the React webview, on the Bun daemon v1 already uses. The native Swift
  option is not pursued.
- **Features are plugins:** the core is a kernel (PTY host, daemon, API, UI shell, plugin host). All
  28 features ship as built-in plugins on the same API third parties get.
- **Distros:** an opinionated Quirky is a plugin pack installed into stock Quirky. It is a manifest
  naming plugins, settings, keybindings, theme, and which built-ins are off.
- **Trust:** plugins run in process, in `quirkyd` and the webview, with the user's privileges. There
  is no sandbox and no plugin helper process.
- **Overrides:** a plugin can replace or disable any built-in contribution.
- **Order:** replace Orca for daily work as early as possible.
- **Parity:** every user flow in the feature docs is in scope, and none of the Orca defects they
  list.
- **Plugin API growth:** M0 builds only the API v1's features need. Each later milestone adds what
  its features need, and the API stays marked unstable until M7 freezes it.
- **Everything is scriptable:**
  - An agent can drive anything a person can, through the local API or the `quirky` CLI.
  - Every built-in plugin exposes its own namespaced API methods and CLI command group, in addition
    to what it adds to the UI.
  - Every UI command, including ones that only change the view, is an API command routed to the open
    window.
  - Layout and focus live in the daemon, and agents read what the window shows as JSON. There are no
    screenshots of Quirky itself.
- **Agent access:** an agent in a Quirky session can do everything the user can, with the same
  token. Actions that can't be undone, such as deleting a worktree, merging a PR or installing a
  plugin, ask through `quirky ask` unless the call passes `--yes`.

## When a milestone is done

All of these apply to every milestone:

- Each flow in a shipped feature's doc passes. The flows are its acceptance criteria, and each flow's
  test is a script against the CLI and API. Passing it is what shows the flow can be scripted.
- Each Orca defect the doc lists has a test showing Quirky doesn't have it.
- Each feature ships as a built-in plugin, using only the public plugin API. If it needs something
  the API lacks, the API grows in the same milestone.
- Each feature's plugin ships its own API methods and CLI command group, declared with schemas. A
  view command with no API equivalent doesn't pass.
- The memory probe runs at the typical-day workload and stays within
  [the budget](architecture.md#memory-budget).
- The milestone's exit test passes on real work, not a demo repo.

## Milestones

### M0: plugin kernel, with v1 moved onto it

- **Registry:** every contribution has a stable ID. A plugin overrides one by registering the same
  ID, and a distro disables one by ID. The pattern follows Backstage's extension overrides and
  LazyVim's `enabled = false`.
- **Daemon API:** RPC methods, events, per-plugin store namespaces with migrations, a scheduler, and
  hooks into agent launch. v1 has no scheduler; M1's agent status and M3's accounts need one.
- **UI API:** views, panels, sidebar sections, commands, keybindings, settings and themes, all
  through declared slots. Plugins get no access to the DOM structure, which Atom learned is not a
  stable contract.
- **Scripting surface:**
  - Every RPC method, command and event a plugin contributes declares a schema.
  - The `quirky` CLI is generated from those schemas, so each plugin's methods get a namespaced
    command group without extra code.
  - `quirky api --json` lists every method and command with its arguments.
  - Quirky ships an agent skill generated from the same list.
- **UI bridge:** UI commands are API commands routed to the open window. Layout, focus, open tabs
  and the visible view live in the daemon and can be read back with `quirky ui state`.
- **CLI core:** the unix socket, selectors, `--version` and idempotent request ids. This moved up
  from M1, because M0's exit test drives everything through the CLI.
- **Confirmations:** irreversible actions ask through `quirky ask` unless the call passes `--yes`.
- **Distros and safety:**
  - Distro manifest.
  - An install screen listing what a plugin contributes.
  - No silent auto-update.
  - Safe mode, `--disable-plugins`.
  - Lazy activation, so an unused plugin costs no memory.
- **v1 as built-ins:** repos, worktrees, terminals, sessions, agent status, source control, asks and
  structured sessions move into built-in plugins. Each one takes its existing API methods and CLI
  commands with it.

**Exit test:**
- v1 behaves as it does today.
- A sample distro turns source control off and replaces the sidebar.
- An agent installs that distro, checks the result with `quirky ui state`, and reverts it, using
  only the CLI.

### M1: terminals and agents

- [Terminal host daemon](../research/orca-features/term-daemon.md):
  - Screen snapshot on attach, checkpoints and cold restore.
  - Paged history.
  - Bell and OSC 133.
  - A shell-ready barrier.
  - Exit codes recorded correctly on macOS.
- [Terminal panes](../research/orca-features/term-ui.md): splits, tab groups, search, floating
  terminal, quick commands, layout persistence.
- [Agent launch](../research/orca-features/providers.md): all 45 CLIs as data, plus detection,
  resume, permission modes, and paste-after-ready.
- [Launch settings](../research/orca-features/launch-settings.md):
  - The per-agent model and effort catalog.
  - It lands here because it is the provider option catalog, and M2's AI commit messages need it.
  - One catalog yields both argv and structured-session options.
- [Agent status](../research/orca-features/agent-status.md):
  - The full state machine.
  - Hook installers beyond Claude and Codex. Each agent gets one CLI command that is safe to rerun
    and prints every file it changed, the way `cmux hooks setup` works.
  - Capture of each session's provider id and transcript path.
  - Title and OSC fallback.
  - Status that programs report with cmux's OSC 7501 sequence, so tools that already report to
    cmux show their status in Quirky.
- [Agent status for scripts](../research/orca-features/agent-status.md), after agent status lands.
  These follow herdr, a terminal workspace for agents:
  - An explain command that names the source and rule behind a session's current state, so
    "why does this say idle?" has an answer.
  - Screen detection rules stored as data, one file per agent. A plugin can ship rules and a user
    can override them locally without a new release. Quirky never downloads rules from a server.
  - Sending a prompt to an agent never types into one waiting for approval, because idle isn't
    permission to type. The send fails with a distinct error when the agent is waiting for
    approval, and with another when it hasn't started working within a few seconds, instead of
    hanging.
  - Waits for scripts: until a session reaches a given state, and until its output matches a
    pattern. Sessions can be given unique names to address them by.
  - Loops, automations and orchestration send prompts through this path, so it lands before M5.
- [Notifications](../research/orca-features/notifications.md):
  - Unread markers, cooldown, banner text, sounds, tray dot.
  - Notifications from the OSC 9, OSC 99 and OSC 777 sequences that terminal programs already
    emit, which cmux also reads. They follow the same cooldown and unread rules as hook
    notifications.
- [Worktrees](../research/orca-features/worktrees.md):
  - The metadata model.
  - Create and delete flows.
  - Setup scripts.
  - Folder workspaces and project groups.
  - "Create from PR" waits for M4.
- [CLI](../research/orca-features/cli.md): the command groups for this milestone's features. The CLI
  core landed in M0.

**Exit test:** a full day of agent work runs in Quirky, apart from review and PRs.

### M2: review loop

- [Source control](../research/orca-features/source-control.md):
  - Remote operations, discard, branch compare and history.
  - Conflicts.
  - Diff notes sent to an agent.
  - AI commit messages.
- [Editor](../research/orca-features/editor.md), in three slices:
  1. Explorer, tabs, CodeMirror editing with the disk precondition, file watching, quick open and
     search.
  2. Rich Markdown.
  3. Notebooks and the CSV, image, PDF and media viewers.
- [Sidebar extras](../research/orca-features/sidebar-extras.md): dirty marker, separators, activity
  window, cross-repo groups. The review filters wait for M4.
- [orca ask](../research/orca-features/ask.md) parity:
  - Number and date questions.
  - Defaults, timeouts, credential refusal and draft persistence.
  - A fresh sequence number for a queued second ask.

**Exit test:** you review and commit agent work without leaving Quirky.

### M3: agent extras

- [Session info](../research/orca-features/session-info.md): Claude's statusline is set per launch
  through `--settings`, so the user's `~/.claude` is never edited.
- [Terminal dock](../research/orca-features/terminal-dock.md):
  - It needs a composer of its own, because Orca's comes from native chat, which Quirky dropped.
  - Effort changes must not write to the user's global Claude settings.
  - Its slash-command and skill picker is in scope, though the standalone skills catalog stays
    dropped.
  - Dictation and the refusal to send during input quarantine are out of scope, because Quirky
    dropped both.
- [Session handoff](../research/orca-features/handoff.md).
- [Accounts](../research/orca-features/accounts.md): read-only usage meters first, then Claude and
  Codex account switching.
- [AI vault](../research/orca-features/ai-vault.md): browse and resume first, then full-text search,
  which stays opt-in.

**Exit test:** you don't reach for any of Orca's agent extras.

### M4: hosting

- [Git hosting API](../research/orca-features/hosting-api.md): GitHub, then GitLab, then Bitbucket,
  Gitea and Azure DevOps. Human merges and the sitter share one merge path.
- [PR, issue and checks pages](../research/orca-features/hosting-ui.md): checks panel, PR page,
  Create PR, Tasks, issue page, Projects.
- [Worktrees](../research/orca-features/worktrees.md): "Create from" a PR, MR or issue.
- [Sidebar extras](../research/orca-features/sidebar-extras.md): the review filters.

**Exit test:** an issue goes to a merged PR inside Quirky. From here Orca is no longer needed day to
day.

### M5: background agents

- **Shared seams first:**
  - A Codex structured runner over `app-server`.
  - Structured-session resume.
  - Model and effort options on structured launches.
  - A checks runner shared by automations, loops and objectives.
- [Automations](../research/orca-features/automations.md).
- [Loops](../research/orca-features/fork-loops.md).
- [Project ledger](../research/orca-features/ledger.md). It depends on nothing else here and can move
  earlier if wanted.

**Exit test:** a scheduled automation and a loop run unattended overnight.

### M6: supervision

These go in order, because each is built on the one before:

1. [Orchestration](../research/orca-features/orchestration.md): tasks, dispatch, mailbox, worker
   start and done, gates.
2. [Heimdall supervisor kernel](../research/orca-features/heimdall.md): without leases, remote
   fleets or the judgment layer. Its journal is named the journal, so it isn't confused with the
   project ledger.
3. [Objective runner](../research/orca-features/heimdall-objective.md) and
   [PR sitter](../research/orca-features/hosted-review-sitter.md), both as Heimdall kinds.

**Exit test:** an objective goes from a stated goal to an opened PR, and the sitter merges it.

### Side track A: embedded browser

[Embedded browser and design mode](../research/orca-features/browser.md) can start after M1, because
it needs worktrees and the CLI. It runs in four slices:

1. Agent automation over an on-demand Chrome and CDP.
2. The visible pane and screencast.
3. Design mode.
4. Cookie import.

cmux puts agent-browser's command set on its WKWebView pane, so its browser API is a reference for
the pane's accessibility snapshot, script injection and design mode. Agents still drive Chrome, as
the [Browser](architecture.md#browser) decision says.

**Exit test:** an agent drives a page while you watch it in the pane.

### Side track B: mobile

[Mobile companion](../research/orca-features/mobile.md) comes last, because it is a client of nearly
the whole API. It covers:

- A non-loopback listener.
- Pairing.
- End-to-end encryption.
- A method allowlist.
- The fork of Orca's Expo app.

**Exit test:** you answer an agent's question from your phone.

### M7: parity sweep and plugin API 1.0

- Every remaining flow in the 28 docs passes.
- The plugin API is frozen and versioned. Plugin manifests declare the API version they target.
- An example distro is published.

**Exit test:** every flow in the feature docs passes, and the example distro installs into stock
Quirky.

## Dependencies that fix the order

- **Worktree metadata and agent status come first.** Nearly every later feature reads them.
  Resume, handoff, session info, account switching and the dock all need the provider session id
  and transcript path that agent status captures. v1's `worktrees` table holds only an id and a repo
  id.
- **Supervision goes in sequence.** Heimdall is built on orchestration, and the objective runner and
  the sitter are Heimdall kinds. Loops and automations use neither, so they come earlier.
- **Every background agent needs M5's runner.** Background agents run structured
  ([architecture.md](architecture.md#structured-agent-sessions)), and v1's structured path is
  Claude-only, with no resume and no model choice.
- **Review filters and "Create from PR" read hosting caches,** so they ship with hosting in M4, not
  with the rest of their features.

## Platforms

Every milestone is built and tested on macOS only, decided with the user on 2026-10-26. Code
prefers a portable API where that costs little. Each place that will need Linux or Windows work is
logged as it comes up, so the cross-platform checks in [stack-proposal.md](stack-proposal.md) can
be planned from that list later.

## How it gets built

Three unattended Orca loops work through these milestones in parallel, one item each at a time
([docs/loop/](loop/README.md)). The order of work items is in `docs/loop/queue.json`, and each
decision the loop makes is logged for review.

- **Browser placement:** the browser side track is queued after M4, so lanes take it once the
  ready items ahead of it are claimed.
- **Ideas from cmux:** a few items follow conventions from cmux, a GPL-3.0 macOS terminal for
  agents. Those items match cmux's documented behavior and never copy its code, which would bring
  the GPL with it.
- **Ideas from herdr:** agent status for scripts follows herdr's documented behavior. herdr is
  Apache-2.0 but written in Rust, so nothing is ported from it.
- **Review stop:** the loop stops for review after M0.

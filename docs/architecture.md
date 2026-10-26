# Quirky architecture

Quirky runs as three small long-lived processes plus a webview, and starts heavy things only on
demand. A PTY host owns every terminal and the only full copy of its history. A daemon owns
everything else and serves one API that the desktop UI, the `quirky` CLI and mobile all use. A thin
shell draws one system-webview window. The target is about 300 MB for a typical day (eight agent
sessions, two terminals on screen, the editor open), against Orca's 2,461 MB.

This document is for whoever builds Quirky next. It fixes the process boundaries, the API shape,
where terminal history lives, how structured agent sessions run, the browser approach and a memory
budget. The stack is Bun and Electrobun, settled on 2026-10-26; [stack-proposal.md](stack-proposal.md)
records how the options were measured. Scope decisions made so far are in [Decisions](#decisions),
and the build order is in [roadmap.md](roadmap.md).

Orca file references are relative to the Orca repo (`~/PycharmProjects/orca`).

## Processes

Each process has one job, so a crash or an upgrade in one doesn't take the others down.

```
            ┌─────────────┐  ┌─────────┐  ┌──────────────┐
            │ shell + UI  │  │ quirky  │  │ mobile app   │
            │ (webview)   │  │ CLI     │  │ (LAN/relay)  │
            └──────┬──────┘  └────┬────┘  └──────┬───────┘
     loopback WS + token   unix socket   paired WS, E2EE
                   └──────────────┼──────────────┘
                          ┌───────┴────────┐        on demand
                          │    quirkyd     │──────► Chrome (agent browser, CDP)
                          │ runtime + API  │──────► agent CLIs: structured (stdio JSON)
                          └───────┬────────┘
                         unix socket / named pipe
                          ┌───────┴────────┐
                          │   quirky-pty   │──────► shells and TUI agents (PTYs)
                          │ PTYs + history │
                          └────────────────┘
```

| Process | Owns | Lifetime |
| --- | --- | --- |
| `quirky-pty` | PTYs, the per-session screen state, the on-disk history log | Detached; outlives the app and `quirkyd` upgrades |
| `quirkyd` | Every feature except drawing: worktrees, git, hosting, agent launch and status, structured sessions, kernels (Heimdall, sitter, objectives, loops, orchestration, automations), ask, ledger, vault, accounts, all stores, the API | Detached; outlives the window |
| Shell | One window, one webview, tray, dock badge, notifications, menus, updates, deep links | While the app is open |
| Webview | The whole UI as one single-page app | With the window |
| Chrome | Pages that agents automate | Started on first browser command, stopped after 10 idle minutes |

The PTY host is separate from `quirkyd` for the same reason Orca's terminal daemon is separate from
Electron main: shells must survive an upgrade or crash of the much larger runtime. Orca already
pays for that split and has learned its protocol (`src/main/daemon/`, protocol v50). Quirky keeps
the split and drops Orca's other copies of terminal state (see [Terminal history](#terminal-history)).
The PTY host's protocol is small and versioned so a new `quirkyd` can adopt an old PTY host.

Orca by comparison runs Electron main (runtime, RPC, a second headless emulator per PTY), the
terminal daemon, several renderers, one Chromium process per browser tab, and forked helpers for
plugins, vault scanning, file watching and computer use
(`src/main/daemon/daemon-launched-child-spawn.ts`, `src/main/plugins/plugin-host-process.ts`,
`src/main/ai-vault/session-scanner-service-spawn.ts`). Quirky runs vault scanning and file watching
inside `quirkyd` on a worker, and drops computer use. Plugins run in process, inside `quirkyd` and
the webview, so they need no helper process ([Decisions](#decisions)).

## One API for every client

`quirkyd` serves one protocol, and the desktop UI is just another client of it. Orca's renderer
talks to Electron main over about 870 IPC channels while the CLI and mobile use a separate RPC
(`src/preload/api/`, `src/main/runtime/rpc/`). Quirky has no IPC layer: the UI calls the same
methods the CLI and phone call, so a feature added for one surface reaches the others without extra
wiring.

### Transport and auth

| Client | Transport | Auth |
| --- | --- | --- |
| Desktop UI | WebSocket on `127.0.0.1`, random port | Per-start token from a 0600 runtime file, which the shell passes to the webview |
| `quirky` CLI | Unix socket (named pipe on Windows) | The same token file, as Orca does with `orca-runtime.json` |
| Mobile | WebSocket over LAN or tailnet | Paired device key and an E2EE channel; the phone app is a fork of Orca's, moved onto this API ([Decisions](#decisions)) |
| Agent hooks | HTTP `POST /hook/<agent>` on `127.0.0.1` | Per-session hook token in the agent's env |

Calls are JSON-RPC 2.0. Subscriptions are calls that return a stream id, and events for it arrive
as notifications. Terminal output travels in binary frames (`[kind u8][stream u32][len u32][bytes]`,
the same shape as Orca's `binary-v1` in `src/main/daemon/daemon-stream-binary-framing.ts`), so bytes
are never JSON-encoded. `quirkyd` relays PTY frames without parsing them.

### Method groups

The API mirrors the kept features. Names are indicative; the prototype fixes them.

- **Sessions:** `session.*` covers terminal and structured sessions under one id space: list,
  create, attach, send, interrupt, close, resume.
- **Terminals:** `terminal.*` covers write, resize, snapshot and `readHistory` (paged, from the log).
- **Agents:** `agent.*` covers launch specs for the 25+ CLIs, status, hook installation and session
  info.
- **Workspaces:** `worktree.*`, `repo.*`, `files.*` (with a disk precondition on write, as Orca has)
  and `git.*`.
- **Hosting:** `hosting.*` covers PRs, issues, checks, reviews and merges across GitHub, GitLab,
  Bitbucket, Gitea and Azure DevOps.
- **Browser:** `browser.*` keeps the command set agents already use (snapshot, click, fill,
  screenshot, tabs and the rest; `src/cli/browser-handler-groups.ts`).
- **Background work:** `automation.*`, `orchestration.*`, `heimdall.*`, `sitter.*`, `objective.*`,
  `loop.*` and `handoff.*`.
- **People and records:** `ask.*`, `ledger.*`, `vault.*`, `accounts.*` and `settings.*`.
- **Events:** `events.subscribe` covers status changes, asks, notifications and store changes.
  Every UI view is a projection of these events.

Desktop surfaces stay out of the daemon. The shell subscribes to `events.subscribe` and turns
"agent finished" or "agent needs input" into a native notification and a badge. When no shell is
connected, `quirkyd` sends the notification itself through the OS's command-line notifier and to
mobile push, so a closed window doesn't silence a finished agent.

## Terminal history

The PTY host holds the only full copy of terminal history, on disk. Memory holds only what a
reattach needs. Orca holds the same terminal up to three times in memory: the daemon's
`@xterm/headless` (1,000 rows, `src/main/daemon/daemon-session-scrollback-window.ts`), a second
headless emulator in Electron main (5,000 rows,
`src/main/runtime/terminal/output/headless-terminal-state.ts`), and the renderer's xterm.js (up to
50,000 rows, `src/shared/terminal-scrollback-policy.ts`). Its own comment records a host with 100+
terminals retaining about 1 GB of grid and being OOM-killed.

Per session, `quirky-pty` keeps three things:

1. **Raw output log on disk.** It is append-only and framed, with torn-tail detection like Orca's
   `output.log` (`src/main/daemon/terminal-history-log.ts`). It rotates at 16 MB per session and
   keeps two segments, so history survives restarts and crashes.
2. **Screen state in memory.** An emulator holds the visible screen and modes (alternate screen,
   cursor, bracketed paste, mouse) with no scrollback. That costs well under 1 MB per session, and
   it lets any client get an exact repaint without replaying bytes. A checkpoint (the serialized
   screen plus its log offset) goes to disk every few seconds while the session is dirty.
3. **Hot tail.** The last 256 KB of output stays in memory, for fast reattach and for
   `terminal.read`.

When a pane attaches, it gets the screen snapshot, then the last N lines of history from the log
(2,000 by default), then live frames from the snapshot's offset onward. Scrolling past N pages in
more from the log on request. The renderer never holds more than its window, and a pane that isn't
visible is unmounted: its xterm.js instance is disposed and reattaches from the PTY host when shown.
The mobile app and the CLI use the same snapshot and history calls.

The screen emulator is where the stacks differ. On Bun it is `@xterm/headless` with `scrollback: 0`.
In Go, terminal emulation libraries are young (tuios.dev/vt, vt-go), so the fallback is to record
redraw points instead of emulating: offsets where the screen was fully redrawn (clear screen,
alternate-screen switch, a full-screen repaint). On attach, it replays the log from the last redraw
point into the renderer's xterm.js. That is exact for TUIs that redraw, which covers most agents,
and approximate for plain shells. The stack prototypes test both against real agents
([stack-proposal.md](stack-proposal.md)).

## Structured agent sessions

Agents with a structured mode run as a subprocess that speaks JSON over stdio, with no PTY and no
terminal buffer. A session is the subprocess plus an append-only message journal in `quirkyd`'s
SQLite store. Clients render the journal and subscribe to new messages.

Orca already has this path for more agents than the brief assumed:

| Agent | Structured mode | Orca reference |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` driving the user's `claude` binary (stream-json in and out, permission prompts over stdio) | `src/main/claude/claude-stream-json-connection.ts` |
| Codex | `codex app-server` JSON-RPC over stdio | `src/main/codex/codex-structured-launch-resolution.ts` |
| Pi | `--mode rpc` | `src/main/pi/rpc-launch.ts` |
| Grok, OpenCode, oh-my-pi, Antigravity | ACP over stdio | `src/main/acp/acp-launch-specs.ts` |

For Codex, use `app-server` rather than the brief's `codex exec --json`. `exec` is one-shot per turn
and can't answer approvals; `app-server` is a long-lived session with approvals, and it is what Orca
uses.

Permission requests (Claude's `canUseTool`, Codex approvals, ACP permission calls) become `ask`
events, the same type `orca ask` cards use. So a tool approval can be answered from the desktop, the
CLI or the phone. Resume uses each agent's own session id (`--resume=<id>` for Claude). Agent status
comes straight from the event stream, so structured sessions don't need hooks.

Terminal agents keep Orca's mechanism. Managed hooks `POST` to `quirkyd`'s loopback hook server, and
OSC 7501 and title parsing fill in where hooks are missing (`src/main/agent-hooks/README.md`).
Prompts reach a running TUI as a bracketed paste followed by a separate Enter, with the per-agent
quirks Orca records in `TuiAgentConfig` (`src/shared/agent-prompt-injection.ts`,
`src/shared/tui-agent-config.ts`). The terminal dock uses this path.

Background agents run structured: orchestration workers, loops, sitter fix agents, objectives and
automations. Interactive Claude and Codex sessions stay in terminal panes with the dock, because a
structured interactive session needs a chat view, and native chat is on the dropped list. Once
hidden panes are unmounted, an interactive terminal costs memory only while it's on screen.

## Browser

The embedded browser splits by audience: the human sees a system webview, and agents drive a Chrome
that Quirky starts on demand.

- **Visible pane:** a second system webview in the window (WKWebView, WebView2 or WebKitGTK). At
  most one is resident. Hiding the pane destroys it and keeps the URL, so a hidden browser costs
  nothing.
- **Agent automation:** `browser.*` commands go to a Chrome or Chromium that Quirky finds on the
  machine (or downloads once). Quirky launches it with its own profile directory and drives it over
  CDP. Orca already has this backend for headless hosts (`src/main/orcad/external-chromium-browser-process.ts`),
  and the `agent-browser` binary it uses speaks CDP directly
  (`src/main/browser/agent-browser-bridge-execution.ts`). Everything Orca's agents rely on needs
  CDP: accessibility snapshots, input synthesis, screencast, PDF, network interception, cookies.
  A system webview can't supply it on any platform.
- **Watching an agent:** the visible pane can show a CDP screencast (`Page.startScreencast`) of the
  agent's Chrome tab, as Orca's web client does, so the human sees the page the agent drives
  without a second engine rendering it.
- **Design mode:** works in the system webview. An injected script picks the element and collects
  HTML and computed styles (Orca's `grab-guest-element-context-script.ts` ports as is), and the
  shell's native snapshot call crops the screenshot. On a screencast tab it uses CDP instead.

Profiles become Chrome profile directories rather than Electron partitions. Cookie import from
other browsers (`browser-cookie-*`) is kept as a `quirkyd` job.

## UI

The UI is one React single-page app in one webview, written against the `quirkyd` API. Most of what
the renderer costs comes from how much it keeps mounted, not from the framework.

- **Only visible views are mounted.** That covers terminal panes, the editor, PR pages and the
  browser pane. State lives in `quirkyd` and is re-fetched on mount, so unmounting loses nothing.
- **Terminals:** xterm.js with WebGL, scrollback capped at 2,000 lines (setting range 500 to
  10,000).
- **Editor:** CodeMirror 6 with `@codemirror/merge` for diffs, instead of Monaco. Orca uses Monaco as a viewer and diff surface with TS diagnostics off and no LSP
  (`src/renderer/src/lib/monaco-setup.ts`), which is what CodeMirror does well at a fraction of the
  memory. Rich markdown stays on TipTap and loads only when a markdown file is open.
- **Reuse:** Orca's renderer is React 19 and Zustand, and its web build already runs against a
  remote runtime over WebSocket (`src/renderer/src/web/main.tsx`). Components port where they're
  self-contained, such as PR pages, diff comments, the composer and the ask card. The 208-slice
  store and the IPC bridge don't port, because Quirky's state is server-owned.

That describes a webview shell. Under the native Swift option, the window, sidebar, tabs and
terminals are AppKit with libghostty, and this single-page app shrinks to the views that are HTML
by nature, each loaded in a WKWebView panel. Both kinds of UI are clients of the same daemon API.
[stack-proposal.md](stack-proposal.md#the-native-option) covers what that changes.

## Where the code comes from

Orca's runtime is already free of Electron, which makes the TypeScript daemon's reuse case much
larger than the brief's 100k lines. A build ratchet fails if the runtime, RPC, `orcad` or CLI graphs
import Electron (`config/scripts/check-runtime-electron-ratchet.mjs`). `orcad` runs the same runtime
headless in plain Node (`src/main/orcad/main.ts`).

| Kept area | What exists in Orca | On Bun | In Go |
| --- | --- | --- | --- |
| Agent launch specs, prompt injection, startup plans | Pure TS in `src/shared/tui-agent-*` | Port as is | Rewrite (mostly data, so it can be generated from the TS tables) |
| Hook server and installers | Plain `node:http`, no Electron | Port as is | Rewrite |
| Structured sessions | Claude SDK, Codex app-server, Pi RPC, ACP (24k lines) | Port, using the official Claude SDK | Rewrite the Claude control protocol without an SDK, and track its changes by hand |
| Git, hosting | `git`, `gh`, `glab` CLIs plus `fetch` | Port as is | Rewrite (small, since it shells out to the same CLIs) |
| Heimdall, sitter, objective, loops, ask, ledger, handoff, session info | Pure TS; needs a runtime port, a store port and a notify port | Port behind those three ports | Rewrite about 100k lines |
| Orchestration, automations | Inside `OrcaRuntimeService`, Electron-free | Extract and port | Rewrite |
| Accounts, usage, vault | Local CLI files, the `security` CLI, SQLite FTS5 | Port; needs `bun:sqlite` in place of `node:sqlite`, with FTS5 checked | Rewrite |
| Browser automation | `agent-browser` over CDP | Reuse the binary | Reuse the binary |
| UI | React renderer, web build | Same in both stacks | Same in both stacks |

Two things follow for the stack decision. The UI is TypeScript in a webview under either shell, so
UI reuse doesn't favour either stack; only the daemon's language changes how much ports. And the
shell and daemon choices are independent: Tauri can host a Bun daemon and Electrobun can host a Go
one.

What doesn't port in either stack is `OrcaRuntimeService` itself. It is a monolith that the fork
features reach into about 21 ways, mostly through `getOrchestrationDb`, terminal launch and send,
and worktree show and remove. Quirky replaces it with the ports above rather than carrying it over.

## Memory budget

The budget covers Quirky's own processes on macOS arm64, measured as `footprint` phys_footprint
like the probe. It excludes the agent CLIs and the shells they run, which cost the same under any
host. "Measured" means a number from `research/memory-probe/`; "target" is a budget the prototypes
must confirm.

| Component | Budget | Basis |
| --- | --- | --- |
| `quirky-pty` | 10–20 MB + under 1 MB per session | Measured: the probe's PTY server as plain `bun` used about 7 MB with four shells |
| `quirkyd` | Bun: 60–100 MB. Go: 25–50 MB | Target; the stack prototype measures it |
| Shell | Electrobun: 38 MB. Tauri: 15–30 MB | Electrobun measured; Tauri is a target |
| WebKit GPU + networking | 30 MB | Measured: 21 MB + 6–7 MB |
| Webview, base with app shell | 130–180 MB | Measured 103–122 MB with only xterm.js loaded; the app's UI adds the rest |
| Each visible terminal pane at 2,000 lines | 6–8 MB | Scaled from the measured 25–28 MB per pane at 10,000 lines |
| Editor (CodeMirror 6, one file and a diff) | 10–20 MB | Target |
| **Typical day: 8 sessions, 2 panes on screen, editor open** | **about 280–350 MB** | Sum of the rows above |
| Visible browser pane (adds) | 80–150 MB | Target; a second WebContent process, only while shown |
| Agent Chrome (adds) | 200–400 MB | Target; only while an agent drives the browser, stopped after 10 idle minutes |

Orca's 2,461 MB breaks down as follows (`research/orca-feature-inventory.json`): the main renderer
499 MB, Electron main 384 MB, other renderers and browser tabs 600 MB, the terminal daemon 150 MB,
and helpers 400 MB. Quirky avoids each of those through a rule:

- **One copy of terminal history, on disk,** removes the main-process emulators and most of the
  daemon's grid.
- **Only visible views are mounted,** which bounds the renderer by what is on screen rather than by
  how many sessions exist.
- **At most one browser webview is resident,** and Chrome runs only while an agent uses it.
- **No helper processes** for plugins, vault scanning or file watching.
- **Structured sessions** cost a journal row, not a terminal buffer.

The memory probe becomes the regression check. Each prototype, and later each release, runs it at
the probe's four workloads plus the typical-day workload above.

## Decisions

Decided with the user on 2026-10-23:

- **Stack:** settled by separate daemon and shell prototypes, measured on macOS only
  ([stack-proposal.md](stack-proposal.md)). Linux and Windows checks come after the choice. A
  third option, a native Swift app, was added the same day, and whether to pursue it is with the
  user.
- **Mobile:** fork Orca's phone app onto Quirky's API rather than reimplementing Orca's mobile
  contract (about 193 RPC methods, `src/main/runtime/rpc/e2ee-channel.ts`). Quirky doesn't use
  upstream's hosted relay (`relay.onorca.dev`). Phones connect directly over LAN or a tailnet, and a
  self-hosted relay built from Orca's `cloud/apps/relay` can be added later if needed.
- **Structured sessions:** background agents only, as in
  [Structured agent sessions](#structured-agent-sessions).
- **Browser:** the system webview for people and an on-demand Chrome for agents, as in
  [Browser](#browser).
- **Editor:** CodeMirror 6 instead of Monaco.

Decided with the user on 2026-10-26:

- **Stack:** a Bun daemon and the Electrobun shell with the React webview. The native Swift option
  is not pursued, although its prototype met the memory rule.
- **Plugins:** Quirky has a plugin system, reversing the brief's drop of Orca's plugins. The 28
  kept features ship as built-in plugins on the same API third parties use. Plugins run in process
  with full trust and can replace or disable any built-in by its stable ID. A distro is a plugin
  pack installed into stock Quirky. [roadmap.md](roadmap.md) builds this kernel first, as M0.
- **Scriptable by agents:**
  - Everything a person can do in Quirky, an agent can do through the local API or the `quirky`
    CLI.
  - Each plugin, built-in or not, exposes its own namespaced methods and CLI commands, declared with
    schemas that the CLI is generated from.
  - UI commands are API commands routed to the window. Layout and focus live in the daemon and are
    readable as JSON.
  - Agents in sessions have the user's full access. Irreversible actions confirm through
    `quirky ask` unless the call passes `--yes`.

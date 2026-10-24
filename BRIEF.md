# Quirky: a lighter Orca

Quirky is a rewrite of Orca (`~/PycharmProjects/orca`, the zpyoung/orca fork of stablyai/orca)
that keeps most of its features and uses a fraction of the memory. Orca is an Electron app for
running coding agents in git worktrees. The running app measured 2,461 MB of physical footprint
across 21 processes on 2026-10-23.

This brief records what was decided and measured before the project started. Your first job is a
design, not code: see [First deliverable](#first-deliverable).

## Memory comes from architecture, not the shell

A same-workload test (Bun-owned PTYs over a localhost WebSocket, xterm.js with WebGL, macOS arm64,
`footprint` phys_footprint) showed the shell framework barely matters:

| Workload | Electrobun 2.0.4 (WebKit) | Electron 38 (Chromium) |
| --- | --- | --- |
| 1 terminal, empty | 158 MB | 184 MB |
| 4 terminals, empty | 188 MB | 225 MB |
| 4 terminals, 10k scrollback | 301 MB | 334 MB |
| 8 terminals, 10k scrollback | 402 MB | 475 MB |

- Each terminal pane with 10k-line scrollback costs about 25 MB on WebKit and 35 MB on Chromium, in
  the renderer. That cost moves with the panes, whichever shell hosts them.
- Electrobun's Bun main process sat at about 38 MB; the same PTY server as a plain `bun` process
  used about 7 MB.
- Plain Electron with 8 full terminals is 475 MB, so roughly 2 GB of Orca's footprint comes from
  how Orca is built: extra renderers, resident browser tabs, a 384 MB main process, and terminal
  state held twice (xterm.js in the renderer and `@xterm/headless` in the terminal-host daemon).

Single runs with short settle times. The probe, script and raw results are in
`research/memory-probe/`.

So the design levers are:
- One daemon owns every PTY and holds the only full copy of terminal history.
- Renderers keep a small scrollback (around 1–2k lines) and unmount panes that aren't visible.
- No browser tab stays resident; no bundled Chromium.
- Agents with a structured mode run headless instead of in a terminal pane (next section).

## Structured agent sessions skip the terminal entirely

Claude desktop's Code tab does not run Claude Code in a PTY. It bundles
`@anthropic-ai/claude-agent-sdk`, which spawns the `claude` binary with
`--input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`,
renders the JSON events as its own chat UI, answers permission checks through the SDK's
`canUseTool` callback, and resumes with `--resume=<cliSessionId>`. A session is then a subprocess
plus a message list, with no terminal buffer.

Use that for Claude Code, and `codex exec --json` for Codex. Agents without a structured mode still
need a terminal pane.

## Features to keep

The full inventory, with lines of code, GUI and PTY flags, and dependencies per feature, is
`research/orca-feature-inventory.json`. It covers 41 features, 26 from upstream and 15 the fork
adds.

Kept (28 features, about 1.2M lines of Orca's feature code):
- Terminal host daemon, terminal panes, notifications, worktrees
- Agent launch for 25+ CLIs, agent status and hooks
- Editor, source control, git hosting API, the PR, issue and checks pages
- Embedded browser, AI vault, accounts and usage
- Automations, orchestration, the Orca CLI, mobile
- Fork features: Heimdall, the PR sitter, the objective runner, loops, `orca ask`, the ledger,
  session handoff, the terminal dock, session info, launch settings, the sidebar extras

Dropped: quick open, Jira and Linear, native chat, artifacts, computer use, dictation, the skills
catalog, SSH and WSL remote, onboarding and telemetry, input quarantine, artifact passwords, the
native-chat extras and the skill-picker extras.

What the selection implies:
- It needs a GUI. The editor, source control, PR pages, browser and terminal dock rule out a
  terminal-only UI.
- Dropping SSH and WSL removes about 71k lines and the mixed-version client/server compatibility
  work. Mobile still needs the daemon to serve an API.
- The embedded browser is the riskiest pick. The system webview has no CDP on macOS, so agent
  browser automation needs a separate Chrome launched on demand and driven over CDP, while the
  visible pane uses the system webview.
- Monaco is one of the heaviest renderer loads; CodeMirror 6 is worth considering, since the
  editor mostly serves review.

## Open decision: which stack

Two builds are on the table. Both shells are thin; the shell opens a window and a webview, shows
tray icons and notifications, handles updates and connects to the daemon.

| | Lowest memory | Least rewriting |
| --- | --- | --- |
| Daemon | Go (chromedp, go-github) | TypeScript on Bun |
| Shell | Tauri (system webview) | Electrobun (system webview) |
| Reuse | Little; everything is rewritten | Heimdall, sitter, objective runner, loops and ledger (about 100k lines) port with little change |
| Risk | Go terminal emulation is weak (tuios.dev/vt, vt-go are young); mitigate by replaying a raw-byte ring buffer with screen checkpoints | Bun daemon is heavier; Windows ConPTY under Bun is unproven. Bun 1.4's native `Bun.spawn({terminal})` worked on macOS without node-pty |

Ruled out: Electron and NW.js (bundled Chromium), and the herdr and cmux multiplexers as the base
(herdr's license is disputed; cmux is macOS-only). Servo is embeddable from crates.io but its
WebDriver story and Chrome rendering parity are unconfirmed.

Orca's cross-platform rule still applies: macOS, Linux and Windows.

## First deliverable

1. Read Orca enough to understand the kept features' boundaries. Start from
   `config/fork-ownership.json` and `README.md` in the Orca repo. Don't modify the Orca repo.
2. Write `docs/architecture.md`: daemon boundaries and its API (desktop UI, CLI and mobile are all
   clients), where terminal history lives, the structured-session path, the browser approach, and
   a memory budget per component.
3. Propose how to settle the stack decision, most likely a one-window prototype of each that
   reruns the memory probe. Ask the user with `orca ask` before building either.

Ask the user with `orca ask` whenever a decision changes scope or architecture.

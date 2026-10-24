# Settling the stack

Settle the daemon and the shell as two separate decisions, each with a small prototype measured by
the memory probe. The brief pairs Go with Tauri and Bun with Electrobun, but they are independent:
the UI is the same TypeScript webview app under either shell, and either shell can host either
daemon ([architecture.md](architecture.md#where-the-code-comes-from)). Testing them as fixed pairs
would mix two effects into one number.

The questions the prototypes answer:

- **Daemon:** does a Bun daemon cost enough more memory than a Go one to give up porting most of
  Orca's runtime? And can Go's young terminal emulators produce correct screen snapshots?
- **Shell:** which one runs Quirky's window, an xterm.js WebGL pane, a second webview for the
  browser pane, tray and notifications?

Prototypes run on macOS only. Orca's cross-platform rule still applies to Quirky, so the macOS
result is provisional until the [Linux and Windows checks](#after-the-choice-linux-and-windows)
pass.

## Step 0: measure Orca's own headless runtime

Before writing anything, measure `orcad`, Orca's existing Electron-free runtime, in plain Node with
eight sessions. It is an upper bound for a TypeScript daemon, because it carries all 765 methods,
including dropped features. If it lands near the Go budget (25–50 MB), the daemon question is
already answered.

It has to run with its own data directory and ports so it can't adopt the PTY daemon of the Orca
you're using. It runs Orca's code but doesn't modify the repo.

## Step 1: two daemon prototypes

Each prototype implements the same thin slice of the API in [architecture.md](architecture.md) on
macOS:

- **PTY host:** sessions with create, attach, write, resize, snapshot and paged history from the
  on-disk log.
- **Structured session:** one Claude Code session, with a permission prompt answered over the API.
- **Hooks:** the loopback hook server receiving a Claude hook.
- **Storage:** a SQLite message journal, with FTS5 on Bun.
- **Git:** status for one worktree through the `git` binary.

A test client drives both through the same workloads: the probe's four, plus the typical day from
the [memory budget](architecture.md#memory-budget).

**Correctness:** snapshot a session mid-run and compare it with a reference xterm.js that saw every
byte. Run this against `claude`, `codex`, `vim`, `htop`, `less`, and a plain shell after 10,000
lines. Go runs this with both screen-state approaches (a VT library, and redraw-point replay).

**Decision rule:** choose Bun unless one of these holds:

- Bun's two processes exceed Go's by more than 50 MB at the typical-day workload.
- Bun's `@xterm/headless` snapshots fail the correctness check while Go's pass.

The 50 MB threshold is a proposal. It weighs roughly a sixth of the target footprint against
porting rather than rewriting the runtime, agent launch, hooks, structured sessions and about 100k
lines of fork kernels.

## Step 2: two shell prototypes

Build one window that loads the same small web UI in Tauri and in Electrobun, connected to the
daemon from step 1. The UI holds two xterm.js WebGL panes, a CodeMirror 6 diff and a second webview
for the browser pane. Run each on macOS and check:

- **Memory:** the probe's workloads, with and without the browser pane.
- **Second webview:** it can sit inside the window, navigate, take a native snapshot and accept an
  injected script, for design mode.
- **Desktop features:** tray, dock badge, notifications, a menu, deep links and an update path.
- **Reading the auth token:** the shell can read the 0600 runtime file and pass the token to the
  webview.

**Decision rule:** pick the shell that passes every check. If both pass, pick the lower footprint.
If they're within 15 MB, pick Tauri, which is the more widely used.

## After the choice: Linux and Windows

These risks can't be tested on macOS. They stay open until a Linux and a Windows machine are
available, and a failure in one of them reopens the choice:

- **Windows ConPTY under Bun:** `Bun.spawn({terminal})` worked on macOS, but it hasn't been tried
  on Windows. Only relevant if Bun wins.
- **WebGL in other webviews:** xterm.js with WebGL has to work on WebKitGTK (Linux) and WebView2
  (Windows).
- **Desktop features on each platform:** tray, notifications and the second webview on Linux and
  Windows, which matters most for Electrobun.

## Measurement

The probe (`research/memory-probe/measure.py`) has its app paths hard-coded to `~/scratch/eb/`.
That needs fixing first. Each workload runs three times with a longer settle time than the
original single runs, and the result reports the median.

## What it needs

- **Go:** not installed on this machine. Bun 1.4.0 and Rust 1.93 are installed.
- **Prototype code** goes in `prototypes/` in this repo, and the measured results go in
  `research/memory-probe/`.

# Settling the stack

Settle the daemon and the shell as two separate decisions, each with a small prototype measured by
the memory probe. The brief now lists three builds:

- **Go+Tauri:** lowest memory, cross-platform.
- **Bun+Electrobun:** least rewriting.
- **Native Swift:** a native macOS app.

The daemon and the shell are still independent: every shell is a client of the same daemon API
([architecture.md](architecture.md#one-api-for-every-client)), and any of the three daemon languages
fits under any shell. Testing them as fixed pairs would mix two effects into one number.

The questions the prototypes answer:

- **Daemon:** does a Bun daemon cost enough more memory than a Go one to give up porting most of
  Orca's runtime? And can Go's young terminal emulators produce correct screen snapshots?
- **Shell:** which one runs Quirky's window, its terminals, a second webview for the browser pane,
  tray and notifications? The [native option](#the-native-option) also replaces most of the UI, and
  it only makes sense if Quirky gives up Linux and Windows. That part is the user's call, made
  before its prototype.

Prototypes run on macOS only. Under a webview shell, Orca's cross-platform rule still applies, so
the macOS result is provisional until the
[Linux and Windows checks](#after-the-choice-linux-and-windows) pass.

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

## The native option

The third build is a Swift and AppKit app. It uses libghostty terminals (Metal rendering, capped
native scrollback), with SwiftTerm as the fallback, and WKWebView only for the views that are HTML
by nature: diffs, the structured-session transcript, and later the PR, issue and checks pages and
markdown with comments. cmux (Swift, AppKit, libghostty, with a browser pane) is the closest
existing app of this shape.

It goes after the largest measured cost. At 10,000 lines of scrollback, each pane cost 25–35 MB,
and that was xterm.js and its WebGL state inside the webview. A native terminal takes that out of
the webview entirely. The webview's base process, 103–122 MB measured, can stay closed until an
HTML view is opened. How much memory a libghostty surface costs per pane is not measured yet.

**What it costs:**

- **Platforms:** it drops Linux and Windows.
- **UI rewrite:** the sidebar, tabs, terminals, dialogs, ask cards and notifications are rewritten
  in Swift. SwiftUI struggles with long lists and complex layouts, so the heavy screens need AppKit.
- **Editor:** there is no native Monaco. The choice becomes CodeEditSourceEditor, STTextView, or
  CodeMirror in a WKWebView. The last keeps Quirky's CodeMirror decision.

**What doesn't change:**

- **The daemon,** in any language, along with the PTY host, the CLI, terminal history and the
  browser approach. The visible pane is the system webview, and agents drive an on-demand Chrome.

**The main unknown is whether libghostty can render a stream it doesn't own.** Quirky's PTY host
owns every terminal, so the app has to feed libghostty bytes from the daemon's stream, replay
included, and send keystrokes and resizes back. Ghostty's embedding API normally runs its own PTY.
If libghostty can't take an external stream, SwiftTerm (which has a byte-feed API) is the fallback.
Building libghostty also needs Zig, which isn't installed on this machine. Xcode 26.2 and Swift
6.2.3 are installed.

**Prototype:** one AppKit window, built against the same daemon as the other shells.

- **Sidebar:** worktrees from `worktree.list`.
- **Terminals:** two terminal panes fed through `terminal.attach`. Run libghostty first, and
  SwiftTerm if libghostty can't take the stream.
- **Diff view:** one WKWebView panel showing the CodeMirror diff.

It runs the same memory workloads as the webview shells, checks that replay and resize repaint
correctly in `claude`, `codex` and `vim`, and measures idle memory with no WKWebView open.

**Decision rule:** pick the native shell only if all three hold:

- The user accepts macOS only.
- A native terminal renders the daemon's stream correctly.
- It saves at least 100 MB over the better webview shell at the typical-day workload.

The 100 MB threshold is a proposal. It weighs the memory saved against rewriting the UI in Swift
and giving up two platforms.

### What it changes in the v1 plan

v1 is already macOS only and is being built as a React UI in Electrobun ([v1.md](v1.md)). Choosing
the native shell would change it like this:

| Part | Under the native shell |
| --- | --- |
| `packages/protocol`, `pty-host`, `daemon`, `cli` | Unchanged. The Swift app speaks the same JSON-RPC and binary frames over `URLSessionWebSocketTask`. |
| `packages/ui` | Shrinks from the whole app to the HTML-shaped views, each its own small page loaded in a WKWebView panel: the diff view and the structured-session transcript now, and PR pages later. The connection, store, ask-answer logic, diff and transcript carry over. The sidebar, tabs, xterm.js terminal pane, dialogs, ask cards and toasts are rewritten in AppKit. |
| `apps/desktop` | Replaced by a Swift app (`apps/macos`). It covers the window and split view, sidebar, tab bar, libghostty surfaces, `NSStatusItem` tray, `UNUserNotificationCenter` notifications and the dock badge. It also launches the daemon, as a `bun build --compile` executable bundled in the app, so it needs no Bun runtime. The Electrobun shell is thrown away; it is small. |
| Memory budget | The webview's base process, 103–122 MB measured, goes when no HTML view is open, and xterm.js's per-pane cost goes too. libghostty's per-surface cost replaces it; the prototype measures that. |
| Mobile | The plan to fork Orca's React Native app is unchanged. SwiftUI code shared with an iOS client becomes a later option. |

## After the choice: Linux and Windows

These risks apply only if a webview shell wins. They can't be tested on macOS, so they stay open
until a Linux and a Windows machine are available, and a failure in one of them reopens the choice:

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

- **Toolchains:**
  - Installed: Bun 1.4.0, Rust 1.93, Xcode 26.2 and Swift 6.2.3.
  - Missing: Go, and Zig, which libghostty needs.
- **Prototype code** goes in `prototypes/` in this repo, and the measured results go in
  `research/memory-probe/`.

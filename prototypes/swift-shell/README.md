# Swift shell prototype

A one-window native macOS client for the Quirky daemon, built to answer the "native option" questions in
`docs/stack-proposal.md`: can a native terminal render the daemon's stream, and what does the shell cost in memory?
Numbers are in [results/results.md](results/results.md), raw data in `results/results.json`.

## What it is

- **Daemon client** (`DaemonClient.swift`, `Protocol.swift`): reads `$QUIRKY_HOME/runtime.json`, connects
  `ws://127.0.0.1:<port>/rpc?token=...` with `URLSessionWebSocketTask`, sends `client.hello` (role `desktop`,
  protocol 1) and `events.subscribe`, makes JSON-RPC calls, and decodes binary frames
  `[kind u8 = 1][streamId u32 BE][bytes]`.
- **Window** (`ShellController.swift`): `NSSplitView` with an `NSOutlineView` sidebar (`repo.list` + `worktree.list`),
  the selected worktree's terminal panes side by side, and a toggleable WKWebView panel that loads
  `http://127.0.0.1:<port>/#token=<token>`. The WKWebView is created the first time the panel is shown (View >
  Toggle Web Panel, cmd-B, or `SIGUSR1`), not before. Missing shell sessions are created with `session.create`.
- **Terminals** (`TerminalPane.swift`, `TerminalEngine.swift`, `GhosttyEngine.swift`): each pane calls
  `terminal.attach` with its grid size, writes the base64 `replay`, then live frames; keystrokes go to
  `terminal.write`, grid changes to `terminal.resize`, and closing sends `terminal.detach`.

## Build and run

```sh
cd prototypes/swift-shell
swift build -c release            # SwiftTerm only, fetched by SwiftPM
```

To include libghostty, put `GhosttyKit.xcframework` in `Vendor/` before building (it is git-ignored, 126 MB; build
steps below). `Package.swift` then adds the `GHOSTTY` define and links it, and the engine defaults to libghostty;
`QSWIFT_ENGINE=swiftterm` forces SwiftTerm. SwiftPM caches the evaluated manifest by its text, so after adding or
removing `Vendor/GhosttyKit.xcframework` run `rm -rf ~/Library/Caches/org.swift.swiftpm/manifests` once, or the build
keeps the old choice and fails with "does not contain a binary artifact".

Run against a daemon (start one first, from the integration tree or your own checkout):

```sh
export QUIRKY_HOME=/tmp/qswift-demo       # short path: the unix socket must stay under 104 bytes
bun /path/to/quirky/packages/daemon/src/main.ts &
QSWIFT_ADD_REPO=/path/to/some/git/repo .build/release/QuirkyShell
```

| Variable | Meaning |
| --- | --- |
| `QUIRKY_HOME` | state directory holding `runtime.json` (default `~/.quirky`) |
| `QSWIFT_PANES` | number of terminal panes (default 2; 0 shows the sidebar only) |
| `QSWIFT_ENGINE` | `ghostty` or `swiftterm` (default: ghostty when linked) |
| `QSWIFT_ADD_REPO` | `repo.add` this path when the daemon has no repos |
| `QSWIFT_FILL` | type `seq 1 N` into each freshly created session |
| `QSWIFT_SCROLLBACK` | SwiftTerm scrollback lines (default 10000) |
| `QSWIFT_GHOSTTY_SCROLLBACK_BYTES` | libghostty scrollback limit in bytes (default 16,000,000) |
| `QSWIFT_WEB_URL` | page for the web panel instead of the daemon UI |
| `QSWIFT_TRACE` | log attach and resize calls to stderr |

Signals for scripted runs: `SIGUSR1` toggles the web panel, `SIGUSR2` toggles the window between 1400 and 900
points wide, `SIGINFO` prints the window number (for `screencapture -l`).

`tools/measure.py <ghostty|swiftterm|all> [runs] [settle] [workloads]` runs workloads (a) to (e) against the real
daemon and PTY host from `$QUIRKY_TREE` (default `/Users/zpyoung/orca/workspaces/quirky/architecture`), each on a
fresh `QUIRKY_HOME`, and writes `results/results.json`; `tools/summarize.py` prints the tables.
`tools/correctness.sh <engine>` drives vim and takes the screenshots in `results/`. It types with `osascript`, so
the terminal running it needs Accessibility permission. `tools/corr-start.sh` is its launcher.

## Terminal engine

**libghostty works, but only through cmux's fork.** The measured and screenshot runs use libghostty (cmux fork,
manual IO) as the default engine; SwiftTerm is built in as the comparison and fallback. Upstream Ghostty cannot take
an external stream. Evidence:

- **Upstream** `ghostty-org/ghostty` @ `8ef0ec1` (needs Zig 0.17.0): `src/termio/backend.zig` defines
  `pub const Kind = enum { exec }`, so a surface can only run its own PTY. `include/ghostty.h` has no IO-mode field
  in `ghostty_surface_config_s`, no write callback and no output call; its header comment says it is the macOS
  app's internal API. `Termio.processOutput` exists in Zig ("the manual API that users can call with pty data") but
  is not exported to C. libghostty-vt (`include/ghostty/vt.h`) is a parser and screen model with no renderer.
- **cmux's fork** `manaflow-ai/ghostty` @ `ef4f157` (the commit cmux `f165d16` pins; Zig 0.16.0) adds
  `src/termio/Manual.zig` and, in `include/ghostty.h`, `GHOSTTY_SURFACE_IO_MANUAL`, `io_write_cb` (called with the
  bytes the surface encodes for keystrokes and parser replies), `ghostty_surface_process_output` (bytes in) and
  `ghostty_surface_size` (grid after a resize). The fork's own notes (`docs/ghostty-fork.md` in cmux, section 10)
  say upstream has no equivalent and that the patches should be dropped if one lands.
- **Result:** the fork's xcframework built in 2 minutes on the first try once the Metal toolchain was present, and a
  libghostty surface renders the daemon's PTY output, sends keystrokes back (verified by typing in vim), and
  reports its grid for `terminal.resize`. Nothing in the app owns a PTY on the Swift side.

Findings that matter for the decision:

- **Fork dependency.** Using libghostty means carrying a Ghostty fork (or an upstream C bridge for
  `processOutput`). The fork pins Zig 0.16 while upstream main is already on 0.17, so the two diverge.
- **Replay hazard, both engines.** The replay holds old terminal queries (device attributes, kitty keyboard
  query). Replayed into a fresh terminal, the terminal answers them and the answers reach the shell or vim as
  typed input. With SwiftTerm and no guard the reopened vim ended up with stray input (cursor on the wrong
  line, a stray `y` on the last row). Both engines now drop replies for 0.4-0.6 s after a replay. libghostty also
  has `GHOSTTY_SURFACE_IO_MANUAL_MIRROR`, which suppresses parser replies altogether and leaves them to the
  daemon's emulator. A real client needs one of these. The webview client has the same issue.
- **Input.** The prototype maps `NSEvent` to `ghostty_surface_key` with text, modifiers and the macOS keycode, as
  Ghostty's own `SurfaceView` does, but has no IME, mouse reporting beyond scrolling, selection or clipboard.
- **Scrollback** is capped in bytes in libghostty (50 MB default in the fork), not in lines.

## Correctness check

Procedure (`tools/correctness.sh <engine>`, a fresh daemon each time): launch the app with two panes, run
`vim /tmp/qswift-long.txt` in pane 1 and move down five lines; quit the app (`SIGTERM`) and relaunch it so the panes
re-attach; toggle the window to 900 points wide and back; quit vim. Screenshots are in `results/`:
`<engine>-vim-live.png`, `-vim-reopen.png`, `-vim-resized-narrow.png`, `-vim-resized-wide.png`, `-vim-quit.png`.

- **libghostty:** the reopened window repaints vim exactly as it was, with the file text, the status line text and
  the cursor on line 6; the other pane shows its shell prompt. Narrowing the window makes the app send
  `terminal.resize`; vim receives the new size, redraws with wrapped lines in the new grid and widening restores the
  original layout. `:q` returns to the shell with the earlier prompt line intact.
- **SwiftTerm:** the reopened vim is correct once the replay guard was added (file text, status line, cursor on
  line 6). Without it, the reopened vim was wrong as described above. After narrowing and widening, the text redraws
  correctly at each width, but in those two screenshots the vim cursor is not drawn where libghostty draws it (the
  window had lost key status after the earlier steps; not investigated further).
- Both engines show a stray `%` and a prompt redraw on the shell pane after a window resize or reattach: zsh's own
  redraw sequence replayed into the fresh terminal. It is zsh reflow behaviour, not a rendering fault.
- Not covered: `claude` and `codex` TUIs (not run), a replay larger than 1 MiB that is cut mid-sequence, and two
  clients attached to one session at different sizes.

## What was installed

- Homebrew (Apple silicon, `/opt/homebrew`): `zig@0.16` 0.16.0 (keg-only, bottle), with its dependencies
  `llvm@21` 21.1.8_1 and `lld@21` 21.1.8_1. Zig 0.16.0 is the minimum version of the cmux ghostty fork; upstream
  Ghostty main needs 0.17.0, which was not installed because upstream has no external-stream API to build for.
  (An attempt through the Intel Homebrew in `/usr/local` started compiling LLVM from source and was killed before
  installing anything.)
- Apple Metal Toolchain 17C7003j via `xcodebuild -downloadComponent MetalToolchain` (705 MB). Ghostty's build runs
  `xcrun metal`, which Xcode 26 does not ship by default.
- SwiftPM, per build: SwiftTerm 1.99.1 and its dependencies (swift-png 4.5.2, swift-argument-parser 1.8.2).
- Sources cloned to the session scratchpad: `ghostty-org/ghostty` @ `8ef0ec1` (read only), `manaflow-ai/ghostty`
  @ `ef4f157`, `manaflow-ai/cmux` @ `f165d16`.

Building the xcframework:

```sh
git init ghostty-cmux && cd ghostty-cmux
git remote add origin https://github.com/manaflow-ai/ghostty.git
git fetch --depth 1 origin ef4f1570d62117ebc51e3b0f07ad4f34032267b6 && git checkout FETCH_HEAD
PATH=/opt/homebrew/opt/zig@0.16/bin:$PATH zig build -Dsentry=false -Di18n=false -Demit-macos-app=false \
  -Demit-xcframework=true -Dxcframework-target=native -Doptimize=ReleaseFast
cp -R macos/GhosttyKit.xcframework <repo>/prototypes/swift-shell/Vendor/
```

(the flags are cmux's `scripts/ensure-ghosttykit.sh` with `-Dxcframework-target=native` for arm64 only).

## Limits of this prototype

- The web panel loads the whole daemon UI, not a purpose-built diff page, and it was checked only for process
  creation and memory, not for what it renders.
- No tray, notifications, dock badge, tabs or dialogs; the stack proposal's "Desktop features" are out of scope here.
- The app is a bare executable, not a signed `.app` bundle. WebKit's responsible process is therefore the
  launching shell, which `tools/measure.py` accounts for.
- Measured on a machine running other apps; each cell is a median of three runs and runs agreed within 4 MB.

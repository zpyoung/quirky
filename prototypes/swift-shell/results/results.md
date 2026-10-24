# Swift shell memory results

Measured on macOS 26.6 arm64 (Xcode 26.2, Swift 6.2.3), against the real `quirkyd` and PTY host from the
integration tree (commit 6686afb), each started on a fresh `QUIRKY_HOME` under `/tmp`. All numbers are
`footprint -p <pid>` phys_footprint in MB, the same tool as `research/memory-probe/measure.py`.
Each cell is the median of 3 runs after a 25 s settle (runs differ by at most 4 MB; raw runs, per-process
rows and pids are in `results.json`, the run log in `measure.log`). The app window is 1400x800 points.

How the columns are built:

- **app** is the `QuirkyShell` process. **WebKit procs** are the `com.apple.WebKit.{GPU,Networking,WebContent}`
  services the app spawned (attributed by responsible pid, not by parent, because they are not children).
- **shell (app+WebKit)** is the part the shell choice controls. **Quirky total** adds the daemon (`bun`) and the
  PTY host (`bun`). The login `zsh` processes (2 per 2 panes) are listed apart and left out of totals, as in the probe.
- (e) and (e-blank) are measured in the same run as (c), 25 s after toggling the web panel, so the app cell
  there is the post-toggle value. Before the toggle no WebKit process existed in any run.
- Workload (e) loads the daemon-served React UI (`http://127.0.0.1:<port>/#token=...`), the whole app, not a
  lone diff view. (e-blank) loads `about:blank` to show WebKit's floor.

## Tables (MB)

### ghostty

| workload | app | WebKit procs | daemon | PTY host | shell (app+WebKit) | Quirky total | shells (not in totals) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| (a) idle, sidebar only | 17.0 | 0 | 14.0 | 12.0 | 17.0 | 43.0 | 0 |
| (b) 2 panes, empty shells | 53.0 | 0 | 14.0 | 14.0 | 53.0 | 81.0 | 10.0 |
| (c) 2 panes after seq 1 10000 | 58.0 | 0 | 15.0 | 24.0 | 58.0 | 95.0 | 10.1 |
| (d) 4 panes after seq 1 10000 | 74.0 | 0 | 15.0 | 26.0 | 74.0 | 115.0 | 20.5 |
| (e) = (c) + full daemon UI in WKWebView | 62.0 | 50.9 | 15.0 | 23.0 | 112.8 | 150.8 | 10.1 |
| (e-blank) = (c) + WKWebView on about:blank | 65.0 | 18.3 | 14.0 | 22.0 | 83.3 | 120.2 | 10.2 |

### swiftterm

| workload | app | WebKit procs | daemon | PTY host | shell (app+WebKit) | Quirky total | shells (not in totals) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| (a) idle, sidebar only | 16.0 | 0 | 13.0 | 12.0 | 16.0 | 41.0 | 0 |
| (b) 2 panes, empty shells | 20.0 | 0 | 14.0 | 15.0 | 20.0 | 48.0 | 9.9 |
| (c) 2 panes after seq 1 10000 | 38.0 | 0 | 15.0 | 23.0 | 38.0 | 77.0 | 9.4 |
| (d) 4 panes after seq 1 10000 | 58.0 | 0 | 15.0 | 25.0 | 58.0 | 98.0 | 20.4 |
| (e) = (c) + full daemon UI in WKWebView | 46.0 | 50.8 | 15.0 | 23.0 | 96.8 | 134.9 | 9.9 |
| (e-blank) = (c) + WKWebView on about:blank | 46.0 | 18.3 | 14.0 | 21.0 | 64.3 | 99.2 | 10.0 |

Engines: `ghostty` is libghostty from the cmux fork with manual IO (terminal fed by `ghostty_surface_process_output`);
`swiftterm` is SwiftTerm 1.99.1. Both ran the identical app, daemon client and workloads. libghostty's scrollback is
capped in bytes, not lines, so it was set to 16 MB (about 10,000 lines of 200 columns); SwiftTerm's is 10,000 lines.

## What the numbers say

- The webview base process disappears. With no WKWebView, workload (a) is 17 MB for the whole shell and no WebKit
  process exists. Opening the panel costs +18 MB on a blank page and +51 MB with the full React UI loaded
  (GPU, Networking and WebContent together), against 103-122 MB for the Electrobun WebContent process alone.
- Terminal cost per pane. SwiftTerm adds about 2 MB per empty pane and about 10 MB per pane with 10k lines of
  scrollback ((b) to (d) per pane, 20 to 58 MB over four panes). libghostty has a one-time cost of about 18 MB per
  surface for the first two (53 MB at (b)), then about 8 MB per further pane with 10k lines ((c) to (d)).
  At two or four panes SwiftTerm is the smaller of the two; libghostty's cost is Metal and font state.
  Both are well under xterm.js's 25 MB per pane (in the webview renderer).
- The daemon (13-15 MB) and the PTY host (12-26 MB; it holds the 1 MiB tails and the headless emulators)
  are the same under both engines and are about 40% of the total at (d).

## Comparison with the Electrobun probe

`research/memory-probe/electrobun-results.json`, app processes only (launcher, bun, WebKit), zsh excluded:

| Electrobun workload (probe) | footprint | nearest Swift workload | shell only (ghostty / SwiftTerm) | + daemon + PTY host (ghostty / SwiftTerm) |
| --- | ---: | --- | ---: | ---: |
| 1 terminal, empty | 158 | (b) 2 panes, empty | 53 / 20 | 81 / 48 |
| 4 terminals, empty | 188 | (b) 2 panes, empty (no 4-empty run) | 53 / 20 | 81 / 48 |
| 4 terminals, 10k scrollback | 301 | (d) 4 panes, 10k | 74 / 58 | 115 / 98 |
| 8 terminals, 10k scrollback | 402 | none | | |

The workloads differ, so read this as an order of magnitude, not a ranking:

- The probe's Electrobun number contains its Bun PTY server (38-40 MB, in the `bun` process) and has no separate
  daemon. The Swift "+ daemon + PTY host" column is the like-for-like total: the Swift app has no PTY code, and
  `quirkyd` plus `quirky-pty` do that work in two processes.
- Probe terminals were xterm.js with WebGL in one WebContent process. Here the terminals are
  native and the daemon is the real one with its own per-session state.
- The probe filled its terminals with 10k lines of scrollback by its own harness; here each shell runs `seq 1 10000` and
  each pane in the 2-pane runs is about 86x53 cells.
- No pane-count-4 empty run and no 2-pane Electrobun run exist, so (b) and (c) have no direct counterpart.

At the 4-pane 10k workload the native shell plus the real daemon and PTY host uses 98-115 MB against the
probe's 301 MB for the whole Electrobun app, a gap of about 185-200 MB, before the Electrobun build would add a
standalone daemon. That clears the 100 MB bar in the decision rule at this workload; "typical day" is not defined
in the probe, so I did not pick one, and the other webview shell (Tauri) was not measured here.

# Platform Support

The Quirky desktop app runs on macOS only. Don't add Windows or Linux code paths (see `AGENTS.md`). Two things still reach other systems: the web client, which can open in any browser, and SSH hosts, which are usually Linux.

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. The web client can run in a non-Mac browser, so pick `metaKey` or `ctrlKey` with `navigator.userAgent.includes('Mac')`. Electron menu accelerators use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` in other browsers.
- **File paths**: Use `path.join` or Electron/Node path utilities for local paths. Paths on an SSH host follow that host's rules, not the Mac's.
- **Child processes**: Start them through `runProcess`/`spawnProcess` from `@quirky/process-host`, never `child_process` directly. `check:process-host-imports` enforces this in CI.
- **Ripgrep**: Spawn the bundled `rg` through `spawnBundledRipgrep`, never a bare `'rg'`.
- **macOS daemon launch**: packaged macOS runs the terminal daemon from a copy of the signed terminal host helper through launchd, so an update cannot sever its privacy grants. Before touching that copy, its cleanup, or the fork fallback, read [`macos-daemon-tcc-attribution.md`](./macos-daemon-tcc-attribution.md).
- **Leftover Windows, WSL and Linux code**: some is still in the tree. Don't extend it or add callers to it.

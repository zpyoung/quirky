# Quirky desktop shell

An Electrobun 2.0.4 app (built through `hutch`) that starts or reuses the Quirky daemon, shows
its UI in one window, and posts native notifications and the dock badge. Closing the window or
choosing Quit Quirky in the tray menu quits only the shell; the daemon and PTY host keep running.

## Build, install, run

From the repo root, after `bun install`:

```sh
bun run build
mkdir -p ~/Applications
cp -R apps/desktop/build/Quirky.app ~/Applications/
open ~/Applications/Quirky.app
```

`bun run build` builds the UI, bundles the daemon, PTY host, CLI and UI into the app, and fails
if any of them is missing. The result is `apps/desktop/build/Quirky.app`.

Reinstalling over a running copy: quit Quirky first (window close or tray Quit), then repeat the
`cp -R`. Use `rm -rf ~/Applications/Quirky.app` before copying if you want a clean replace.

The app is unsigned. If macOS refuses to open the copy, run
`xattr -dr com.apple.quarantine ~/Applications/Quirky.app` once.

## Development mode

```sh
bun run dev
```

Builds the UI, then runs the shell from the repo sources (`packages/*/src`), so the daemon is the
checked-out code. The dev app is `apps/desktop/build/dev-macos-arm64/Quirky-dev.app`; console
output of the shell appears in the terminal.

## Logs

- Daemon: `$QUIRKY_HOME/logs/daemon.log` (default `~/.quirky/logs/daemon.log`).
- PTY host: `$QUIRKY_HOME/logs/pty-host.log`.
- Shell console output (window, tray and connection errors): not saved when launched from Finder
  or `open`. Run `~/Applications/Quirky.app/Contents/MacOS/launcher` from a terminal to see it.
- If the daemon cannot start, the window shows the error and the daemon log path.

## Testing against a separate QUIRKY_HOME

The shell and everything it starts read `QUIRKY_HOME`. Use a short path (the PTY host socket
lives under it and macOS limits socket paths to about 100 characters):

```sh
mkdir -p /tmp/qtest
open -n --env QUIRKY_HOME=/tmp/qtest ~/Applications/Quirky.app
# or: QUIRKY_HOME=/tmp/qtest bun run dev
```

When finished, quit the app, stop the daemon it left behind and delete the directory:

```sh
kill "$(python3 -c 'import json;print(json.load(open("/tmp/qtest/runtime.json"))["pid"])')"
kill "$(cat /tmp/qtest/pty.pid)"
rm -rf /tmp/qtest
```

## Why the build unpacks the installer

`hutch electrobun build --env=stable` produces a self-extracting installer. In Electrobun 2.0.4 it
stays open on an "Installation complete" panel until someone clicks Close, so a quit app leaves a
`launcher` process running with ppid 1. `scripts/unpack.ts` replaces the installer with the real
app taken from `artifacts/`, which starts directly and exits with its window.

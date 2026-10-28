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

`bun run build` builds the UI, bundles the daemon, PTY host, CLI, UI and built-in plugins into the app, and fails
if any of them is missing. The result is `apps/desktop/build/Quirky.app`.

Reinstalling over a running copy: quit Quirky first (window close or tray Quit), then repeat the
`cp -R`. Use `rm -rf ~/Applications/Quirky.app` before copying if you want a clean replace.

The app is unsigned. If macOS refuses to open the copy, run
`xattr -dr com.apple.quarantine ~/Applications/Quirky.app` once.

## External command and profile launchers

The built-in CLI Settings owner exposes installation status, install, reveal and removal through `quirky.cli/*` methods and matching commands. From a source checkout, bootstrap an external command with the current CLI entrypoint:

```sh
bun packages/cli/src/main.ts cli status --json
bun packages/cli/src/main.ts cli install --path "$HOME/.local/bin/quirky" --yes
quirky cli profile install --name work --home "$HOME/.quirky-work" --path "$HOME/.local/bin/quirky-work" --yes
quirky cli profile list --json
```

Put the chosen command directory on `PATH`. Launchers pin both the executable/entrypoint and `QUIRKY_HOME`, including paths containing spaces or apostrophes. Keep the pinned entrypoint available. Installation and removal use kernel confirmation; `--yes` explicitly bypasses it. A foreign command requires `--replace-foreign`, and uninstall never deletes a managed command that another program has replaced. Filesystem permission errors remain errors; this does not obtain privileged installation authorization.

## Paired runtime CLI selection

Save an existing mobile-v2 pairing offer, or select one for a single invocation:

```sh
quirky runtime add --name remote --code "$PAIRING_OFFER"
quirky runtime list --json
quirky --runtime remote api call quirky.worktree/list --json
quirky --pairing-code "$PAIRING_OFFER" api call quirky.worktree/list --json
```

Saved credential metadata is private to the profile; list/status output omits offers and tokens. `--runtime` and `--pairing-code` are mutually exclusive. Explicit selection overrides `QUIRKY_RUNTIME` or `QUIRKY_PAIRING_CODE`; `--runtime local` explicitly opts out. An unavailable remote target never falls back to the local daemon. Current-cwd/active local shortcuts and local administration commands refuse remote selection.

Paired calls reuse the mobile-v2 encrypted connection and its existing device grant, not local owner privileges. Methods outside that grant refuse; full-owner remote CLI administration is not implemented.

## Per-window UI routing

Use a live kernel UI connection ID to read or change one renderer without changing another
window's navigation. `ui.window.self {}` returns `{ connId }` only to its own role-`ui` caller.
For a CLI or other non-UI caller, `ui.state {}` lists the live UI connections and their `connId`
values. This ID is not a native auxiliary-window `windowId`.

- `ui.window.state { connId }` returns that window's effective layout, slot reports and toasts.
- `ui.window.view.open { connId, id, input? }`, `ui.window.view.close { connId, expectedView? }`
  and `ui.window.command.run { connId, id, args? }` target that exact connection. Command results
  are completed by the same window that received the request.
- `expectedView` is a compare-and-close guard over the complete view, including whether `input` is
  absent or its current value. If the view changed, close refuses without mutation. Missing,
  stale and non-UI connection IDs also refuse.
- Unscoped `ui.view.open` and `ui.view.close` retain their no-window/default and singleton behavior;
  with multiple live UI windows they refuse rather than choosing the focused or most recent window.
  `ui.command.run` likewise refuses an ambiguous multiwindow target.

Panels, sidebar settings and other shared layout changes remain global. Their renderer updates use
each window's effective layout, so a shared change does not replace another window's selected view.

## Native folder and auxiliary-window bridges

Supported shells expose public `desktop.folder.pick` and `desktop.window.open/list/close` routes. Folder cancellation returns no paths and does not overwrite the UI's typed draft; a missing native shell refuses rather than showing a browser prompt. Dashboard's open-as setting selects an in-window view or an owner-bound pop-out. Auxiliary route/filter updates retain that window identity, while workspace-card commands route to its owning main window.

These bridges do not provide generic per-window workspace sleep/close routing. Notification permission, click and dismissal callbacks also remain unavailable in the pinned SDK; a void notification call is not delivery proof. Production signed helper/TCC/launchd/admission/upgrade integration still requires an authorized signing identity.

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

For disposable **web UI passes**, launch the daemon through the owned-command wrapper:

```sh
bun scripts/owned-run.ts -- bun packages/daemon/src/main.ts
```

It prints a fresh `QUIRKY_HOME` on stderr. Keep the wrapper running during the pass and use that
home for CLI commands. Stop the wrapper when finished: its guardian stops the daemon, detached
PTY host and session process trees, then removes the temporary home. The guardian also runs if
the wrapper is killed with SIGKILL. Never point a disposable pass at your normal profile.

For a native app run that should keep its sessions after the shell quits, use a separate home
and stop the persistent services explicitly:

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

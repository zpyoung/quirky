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

`bun run build` builds the UI, bundles the daemon, PTY host, CLI, UI and built-in plugins into the app, prepares the pinned Electrobun SDK, and fails if any required input is missing. The result is `apps/desktop/build/Quirky.app`.

`bun run typecheck` checks the root, mobile and desktop TypeScript projects. The desktop script runs `hutch electrobun prepare` before `tsc`, so the configured Electrobun 2.0.4 SDK is available without manual preparation. Both commands require the `hutch` CLI on `PATH`.

Reinstalling over a running copy: quit Quirky first (window close or tray Quit), then repeat the
`cp -R`. Use `rm -rf ~/Applications/Quirky.app` before copying if you want a clean replace.

The app is unsigned. If macOS refuses to open the copy, run
`xattr -dr com.apple.quarantine ~/Applications/Quirky.app` once.

## Releases

Installed apps update themselves from the latest GitHub release. About 30 seconds after launch and
every 4 hours after that, the app reads `stable-macos-arm64-update.json` from
`https://github.com/zpyoung/quirky/releases/latest/download`. When that build differs from the
running one, it downloads it in the background, posts a notification, and adds **Restart to Update**
to the Quirky menu and the tray menu. **Check for Updates…** in both menus checks on demand and
reports "You're up to date" or the failure. `bun run dev` builds never check.

To cut a release, tag the commit you want to ship and push the tag:

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
```

The `Build and release` GitHub Actions workflow builds the app on every push to `main` and every
pull request; the run's `quirky-macos-arm64` artifact holds the zipped app. A `v*` tag also sets the
app version from the tag and publishes a GitHub release with `Quirky-macos-arm64.zip` and the update
files the apps fetch (`stable-macos-arm64-update.json` and the app tarball). Mark a release as a
pre-release or draft to keep installed apps from picking it up, because `latest` skips both.

To install a release on another Apple Silicon Mac for the first time, download
`Quirky-macos-arm64.zip`, unzip it into `~/Applications`, and clear the quarantine flag as above.
Later updates need no manual steps. When the updated app starts, it replaces a daemon left running
from the previous build. Terminals keep running unless the update changes the PTY protocol.

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

## Terminal clipboard reads

Terminal Paste, ⌘V and right-click paste read text through the trusted desktop window's native
pasteboard bridge, not WKWebView's permission-gated Web Clipboard API. Plugins use the public
`UiPluginContext.readClipboardText()` method; clipboard contents do not go through the daemon
or guest browser webviews. A native read failure stays an error rather than opening a WebKit
Paste permission callout. Browser shells continue to use the Web Clipboard API.

Acquired text uses the existing terminal paste pipeline: brackets only when the terminal program
enabled bracketed paste, with the same newline conversion, chunking, size limit and timeout.


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

## Desktop screenshot review

`bun run ui:review` starts the real daemon and desktop renderer against a fresh isolated
home, registers a disposable local repository and two Git worktrees, and captures the live
UI contribution inventory in dark and light. It does not open the foreground native window,
load your profile, install hooks, or use provider accounts. Chromium and all app processes are
owned by the run and stopped before it returns.

Install the development dependencies, then either install a Playwright browser with
`bunx playwright install chromium` or pass `--browser /absolute/path/to/chromium`.
For model review, install `pi-watch`, authenticate its model provider with `pi /login`, and
check availability with `pi-watch --check gemini`.

```sh
# Full inventory; output must be an absolute path that does not already exist.
bun run ui:review -- --author-family openai --output /tmp/quirky-visual-review

# An area's exact plugin or contribution IDs; --only is repeatable.
bun run ui:review -- --author-family openai --only quirky.editor \
  --output /tmp/quirky-editor-review

# Capture without model cost. This reports not-reviewed, never a visual pass.
bun run ui:review -- --author-family openai --only host:shell --capture-only \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --output /tmp/quirky-shell-captures

# Review existing immutable capture evidence without restarting the app.
bun run ui:review -- --author-family openai \
  --manifest /tmp/quirky-shell-captures/capture-manifest.json \
  --output /tmp/quirky-shell-review
```

The default separate reviewer is `gemini`; `--reviewer` selects another available pi-watch
alias. Its resolved model family must differ from `--author-family`. Each image is compared to
the approved same-theme PNG in `docs/quirk/specs/2026-10-28-ui-redesign/img/`, with scores for
palette, typography, spacing, component consistency and hierarchy. **Every image** must meet
`--threshold` (default 85/100); a high average cannot hide a bad view.

Evidence includes `capture-manifest.json`, incremental `capture-progress.json`, selected
theme metadata, PNGs, per-image reviewer responses/logs, `review-report.json` and the final
`ui-review-result.json`. Images and references are SHA-256 checked before and after review.
Filtered runs identify their exact scope and do not certify the whole application. The command
builds UI assets unless `--skip-build` is supplied; missing assets still fail.

Exit 0 means a complete requested capture-only inventory (**not reviewed**) or all requested
reviews passed; exit 1 means capture/coverage/mount or score failure; exit 2 means invalid
arguments, missing prerequisites, invalid evidence or reviewer/runtime failure. Signals await
cleanup before returning 130/143. Unmounted, hidden, persistently loading, missing-required-input
and native-only surfaces fail explicitly rather than disappearing from coverage; legitimate empty
states remain reviewable. Renderer screenshots do not certify OS chrome, native browser embedding,
focus or notifications; those belong to native QA. The existing, not-yet-restyled UI is expected
to fail against the new goldens.

## Why the build unpacks the installer

`hutch electrobun build --env=stable` produces a self-extracting installer. In Electrobun 2.0.4 it
stays open on an "Installation complete" panel until someone clicks Close, so a quit app leaves a
`launcher` process running with ppid 1. `scripts/unpack.ts` replaces the installer with the real
app taken from `artifacts/`, which starts directly and exits with its window.

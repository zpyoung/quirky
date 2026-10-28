# Browser

`quirky.browser` exposes managed headless Chromium pages through the daemon API and the `quirky browser` CLI. The plugin is lazy: profile metadata and page listings do not start Chrome. First page use starts one Quirky-owned Chrome process and one foreground `agent-browser` helper for that profile; pages in a profile share the pair, and each profile has a separate managed data directory.

## Requirements

- Install Google Chrome or Chromium on macOS; the plugin does not bundle a browser.
- The desktop bundle includes the pinned `agent-browser` helper (0.27.0).
- Set `QUIRKY_BROWSER_CHROME` to an absolute executable path if the standard Chrome/Chromium locations are unsuitable.

The plugin never attaches to an installed browser's user profile or opens a visible window. Disabling it closes only the helper and Chrome processes it owns. macOS is the exercised platform; other platforms are not claimed as supported.

## CLI

```sh
quirky browser tab profile list --json
quirky browser tab profile create --label Review --json
quirky browser tab create --url http://127.0.0.1:8080 --profile <profile-id> --worktree current --json
quirky browser tab list --worktree current --json
quirky browser tab show --page <page-id> --json
quirky browser tab switch --page <page-id> --json
quirky browser goto --page <page-id> --url http://127.0.0.1:8080
quirky browser snapshot --page <page-id>
quirky browser fill --page <page-id> --element '#email' --value 'agent@example.test'
quirky browser click --page <page-id> --element '<snapshot-ref>'
quirky browser screenshot --page <page-id> --format png --json
quirky browser exec --page <page-id> --command 'fill "#email" "agent@example.test"'
quirky browser tab close --page <page-id> --yes --json
```

Page operations accept an explicit `--page` or use the existing worktree/current-directory scope rules. `--worktree all` is for read-only page listings. `tab switch --focus` fails explicitly because native window focus is unsupported in this headless feature.

CLI values are literal data. In particular, a string beginning with `@file:` is passed unchanged; the CLI does not read files or stdin implicitly.

## API and command surface

The public methods are `profileList`, `profileCreate`, `tabList`, `tabShow`, `tabCurrent`, `tabCreate`, `tabSwitch`, `tabClose`, `goto`, `eval`, `snapshot`, `fill`, `click`, `screenshot`, and `exec`. Profiles created by this release are isolated profiles; there are no profile import, switch, clone, or delete operations.

Page commands support navigation, serializable JavaScript evaluation, accessibility snapshots, input fill, selector or current snapshot-reference click, and viewport PNG/JPEG screenshots. Snapshot references are page- and generation-bound; navigation, actual helper-tab switches, closure, and browser epoch loss invalidate them. `exec` is shell-free and accepts only `goto`, `eval`, `snapshot`, `fill`, `click`, and viewport `screenshot`; the documented `open` and `navigate` aliases normalize to `goto`. It cannot access arbitrary helper commands.

Cookie import and other deferred browser capabilities belong to the dependent `sa-browser-agent-extras` follow-up. The full pre-cutover implementation is retained on `build/sa-browser-agent-full-snapshot`.

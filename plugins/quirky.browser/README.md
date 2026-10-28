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

The automation methods are `profileList`, `profileCreate`, `tabList`, `tabShow`, `tabCurrent`, `tabCreate`, `tabSwitch`, `tabClose`, `goto`, `eval`, `snapshot`, `fill`, `click`, `screenshot`, and `exec`. Browser preferences add `preferencesState`, `profileSet` and `openLink`; profile selection targets a hosted Browser **pane**, not an unscoped automation page.

Page commands support navigation, serializable JavaScript evaluation, accessibility snapshots, input fill, selector or current snapshot-reference click, and viewport PNG/JPEG screenshots. Snapshot references are page- and generation-bound; navigation, actual helper-tab switches, closure, and browser epoch loss invalidate them. `exec` is shell-free and accepts only `goto`, `eval`, `snapshot`, `fill`, `click`, and viewport `screenshot`; the documented `open` and `navigate` aliases normalize to `goto`. It cannot access arbitrary helper commands.

## Profiles and Browser settings

The Browser menu lists persistent profiles, marks the pane's selection, and creates isolated profiles. Switching preserves the pane/hosted-tab identity and URL while retiring the old native guest or Watch lease. Native partitions are `persist:quirky-browser-<profile-id>`; Chrome uses a separate owned directory for each profile.

```sh
quirky browser preferences --json
quirky browser tab profile set --pane <pane-id> --profile <profile-id> --json
quirky browser open-link --worktree <worktree-selector> --url https://example.com --json
```

Browser Settings expose the pane defaults, Chrome identity, link routing, terminal plain/middle URL-click behavior, import hint visibility, and a Session & Cookies profile list. Terminal click settings retain their canonical terminal namespace. Agent Browser Use shows guidance only: it neither installs skills nor gates automation.

Link Routing defaults to the system browser. Cmd-click opens directly; Shift+Cmd-click forces the system browser unless Shift inversion is enabled, when it reverses the configured route for that click. HTTP(S) navigation from terminal and Markdown/editor surfaces retains its originating worktree. Ordinary rich-editor link clicks remain editing; modified navigation uses routing. File links keep their editor/reveal behavior. A failed explicit in-app route is an error, not a silent external fallback.

Chrome identity is `clean` by default; it removes embedding/headless user-agent tokens. `native` preserves Chrome's actual user agent. Changes require a daemon or Browser-plugin restart; an existing runtime keeps its activation-time mode. This is not a credential/fingerprint guarantee.

### Explicit capability limits

- **Cookie imports:** current core has no import engine. Menus disclose this and the Google-login exclusion, never fabricated installed-browser rows or import success. Source detection/import/file summaries are queued in `sa-browser-profile-import-ui` after `sa-browser-agent-extras`. Hide Hint persists and can be reversed in Settings.
- **Native clear/removal:** `profileClear`/`profileDelete` and their `tab profile clear|delete` CLI commands require confirmation and refuse active profiles. Current SDK has no deletion completion acknowledgement; native capability rejects before invocation, preserving Chrome data/profile metadata. Successful native clear/removal is **not shipped**. `sa-browser-native-profile-clear-completion` owns the missing barrier; the one-use desktop claim command cannot bypass ordinary destructive confirmation.
- **Native identity and localhost labels:** no supported native UA override or faithful worktree-host routing capability is available. Settings state the limits rather than store working-looking no-ops. Exact follow-ups: `sa-browser-native-identity`, `sa-browser-localhost-label-routing`.
- **Native test state:** `QUIRKY_HOME` alone does not prove WKWebView storage-root isolation. Native nightly scenarios must use newly created UUID profiles only; never clear/use shared Default without independent native-root proof. Web checks cannot prove native storage isolation or deletion.


Cookie import and other deferred browser capabilities belong to the dependent `sa-browser-agent-extras` follow-up. The full pre-cutover implementation is retained on `build/sa-browser-agent-full-snapshot`.

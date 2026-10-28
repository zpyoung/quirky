# Browser

`quirky.browser` exposes managed headless Chromium pages through the daemon API and `quirky browser` CLI, plus a Browser view for human browsing. The plugin is lazy: profile metadata and page listings do not start Chrome. First agent-page use starts one Quirky-owned Chrome process and one foreground `agent-browser` helper for that profile; pages in a profile share the pair, and each profile has a separate managed data directory.

## Requirements

- Install Google Chrome or Chromium on macOS; the plugin does not bundle a browser.
- The desktop bundle includes the pinned `agent-browser` helper (0.27.0).
- Set `QUIRKY_BROWSER_CHROME` to an absolute executable path if the standard Chrome/Chromium locations are unsuitable.

The Native Browser view embeds a sandboxed system webview without starting automation Chrome. Watch explicitly shows an existing managed agent page through its CDP screencast. Disabling the plugin closes only helper and Chrome processes it owns. macOS is the exercised platform; other platforms are not claimed as supported.

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

## Browser panes
The operator-authorized delivery for sa-browser-pane is pane lifecycle and navigation through the daemon API and CLI. Retained Watch, advanced controls and page-event source is not a claim that its remaining UI scenarios passed. Existing sa-browser-pane-native-host-controls owns screencast, base-pane UI and cross-lane pane/profile integration acceptance; native-events owns page events; workspace-preview owns grant preview. Lane8 retains its own profiles/settings feature and focused follow-ups. Exact handoffs are in docs/loop/decisions/sa-browser-pane.md and docs/loop/BLOCKERS.md.


Browser panes are real hosted tabs in the worktree's terminal workspace. `pane open` creates a Native pane by default; `--mode watch --page` explicitly binds an existing managed agent page. `pane watch --pane` explicitly switches that pane to Watch and starts/resumes its owned page at the pane's current address. Closing a Watch pane stops its screencast but leaves the agent page open.

```sh
quirky browser pane open --worktree current --mode native --url https://example.com --json
quirky browser pane state --worktree current --json
quirky browser pane navigate --pane <pane-id> --input localhost:3000
quirky browser pane control --pane <pane-id> --action zoom --level 1
quirky browser pane control --pane <pane-id> --action viewport --preset mobile-m
quirky browser pane open --worktree current --mode watch --page <page-id> --json
quirky browser pane control --pane <watch-pane-id> --action hardReload
quirky browser pane watch --pane <pane-id> --json
quirky browser pane watch-stop --pane <pane-id> --watch-id <watch-id>
quirky browser pane close --pane <pane-id> --json
```

Every pane API method has a `quirky browser pane ...` CLI command, including suggestions, state reports, frame acknowledgements, typed Watch input, prompt responses and download actions. `pane control` accepts `back`, `forward`, `reload`, `hardReload`, `stop`, `find`, `zoom`, and `viewport`. Address navigation uses the same normalization, safe history and search-engine settings as the UI. The Browser menu contains History, zoom, viewport presets, and Watch choices; the address bar and Find controls are visible in the toolbar. Mod+Shift+B opens a browser tab. While a browser pane is focused, Mod+L focuses the address bar, Mod+F opens Find, Alt+Left/Right navigate history, Mod+R reloads, Mod+Shift+R hard reloads in Watch and reports the Native SDK limitation otherwise, and Mod+=/Mod+-/Mod+0 adjust or reset zoom.

`pane close` returns `true` after the hosted tab and pane resources are removed. Its `fromTab` and `tabId` parameters are reserved for the terminal's authenticated close hook.

Native is available only in the desktop shell. A plain web client explains that the system webview cannot be embedded and offers an explicit Watch action; it never silently substitutes Chrome. Native browsing uses the selected visible viewport size. Mobile device emulation is available only in Watch.

`Open source file` uses public `quirky.editor/open` only with the backend's canonical in-worktree `sourcePath`; outside file URLs have no source action. `Open in Editor Preview` opens a separate editor preview tab and is not a Browser preview conversion. Selecting a supported non-HTML document suggestion navigates its backend-provided resource URL, and Browser Back returns to the prior location. Resource-backed previews do not serve `text/html`; unsupported editor previews show an error. Native `file:` navigation uses runtime authorization, and the UI does not resolve typed paths itself.

The pinned Electrobun SDK has no public JavaScript-dialog, basic-auth, or certificate-response interception, no download cancellation or destination control for Native views, and no Native hard reload. Native popup events are informational; Quirky does not turn a popup URL into a replacement tab or claim to preserve named/opener-dependent OAuth windows. Those Native operations are not presented as working controls. Watch uses the managed page's CDP events for its supported prompts, downloads and typed input.

The `defaultHomePage`, `defaultSearchEngine`, and `defaultZoom` settings apply to new panes only. Default home page is blank; the search engine defaults to Google and the zoom level to 0.

## Design mode

Grab and Annotate run on the exact ready, nonblank Native or Watch pane. Mod+C starts Grab only when the browser page has no editable focus or selected text; Mod+Shift+C starts Annotate. While Grab is armed, plain C copies the hovered element in either mode; S requests a crop on Watch, while Native reports cropped screenshots unavailable. Esc cancels. Clicking an element in Grab copies bounded text; right-click opens Copy and Copy Screenshot actions without copying automatically. Clipboard errors remain visible and keep the selected data available. Copy success toasts appear only after the text or PNG is actually written to the clipboard.

Watch Grab selections include a cropped PNG in their payload when capture fits the 2 MiB budget; unavailable or oversized crops leave `screenshot: null`. The crop uses captured pixels without resizing the live Watch viewport. After text copy, press S without another hover to copy that selection. Annotation payloads never retain screenshots.

Ordinary selected text is not treated as a Grab shortcut. macOS Watch editing supports select-all/copy/paste inside the managed page. Watch-to-host clipboard transfer remains unaccepted: the recorded web smoke selected the text but pasted an empty value into the host address field. That residual base-pane input acceptance belongs to the existing `sa-browser-pane-native-host-controls` handoff; Native ordinary-copy behavior remains pending the real-window run.

Annotate opens a Change/Question editor (up to 2,000 characters). Notes stay in this window's memory, retain the URL and element context captured when selected, and are not reassigned when the page navigates. They survive hosted-view unmounts while the browser page remains open. Each page keeps at most 20 notes; the oldest is dropped. Closing a page removes its notes, and restarting the application loses all notes. Copy uses the browser's Markdown formatter. Send lists same-worktree agent sessions and available new agents; it removes only notes confirmed delivered and unchanged since the send snapshot.

Draw freezes a real Watch screenshot and opens the markup editor. Copy Markup reports success only after the composed PNG is actually written to the clipboard. Native cropped screenshots and Draw are disabled: the pinned public SDK exposes no page snapshot capability. Native never falls back to Watch or an approximate image.

```sh
quirky browser design arm --pane <pane-id> --mode grab
quirky browser design read --pane <pane-id> --op-id <operation-id>
quirky browser design targets --pane <pane-id>
quirky browser design format --payload '<payload-json>'
quirky browser design send --pane <pane-id> --annotations '<annotations-json>' --session <session-id>
```

The public UI command `quirky.browser/design` accepts `grab`, `annotate`, `draw`, or `cancel` for the focused Native pane. Native Draw returns the documented SDK capability limit.

## API and command surface

The automation methods are `profileList`, `profileCreate`, `tabList`, `tabShow`, `tabCurrent`, `tabCreate`, `tabSwitch`, `tabClose`, `goto`, `eval`, `snapshot`, `fill`, `click`, `screenshot`, and `exec`. Browser preferences add `preferencesState`, `profileSet` and `openLink`; profile selection targets a hosted Browser **pane**, not an unscoped automation page.

Pane methods are `paneOpen`, `paneState`, `paneNavigate`, `paneControl`, `paneReport`, `paneClose`, `paneSuggestions`, `paneWatch`, `paneWatchStop`, `paneFrameAck`, `paneInput`, `paneRespond`, and `paneDownload`; they use the same Browser CLI group.

Design methods are `designArm`, `designRead`, `designHover`, `designCancel`, `designCapture`, `designFormat`, `designTargets`, and `designSend`.

Page commands support navigation, serializable JavaScript evaluation, accessibility snapshots, input fill, selector or current snapshot-reference click, and viewport PNG/JPEG screenshots. Snapshot references are page- and generation-bound; navigation, actual helper-tab switches, closure, and browser epoch loss invalidate them. `exec` is shell-free and accepts only `goto`, `eval`, `snapshot`, `fill`, `click`, and viewport `screenshot`; the documented `open` and `navigate` aliases normalize to `goto`. It cannot access arbitrary helper commands.

## Profiles and Browser settings

The Browser menu lists persistent profiles, marks the pane's selection, and creates isolated profiles. Both modes preserve the pane/hosted-tab identity and address. A Watch switch prepares a real page in the selected profile before committing the change and retiring the old lease; creation failure leaves the old selection intact, and original agent pages stay open. Native profile changes do not launch Chrome. Native partitions are `persist:quirky-browser-<profile-id>`; Chrome uses a separate owned directory for each profile.

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

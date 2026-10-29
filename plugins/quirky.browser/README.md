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

Bulk input is explicit: `fill --value-file <path>`, `eval --expression-file <path>`, or an operation's `--text-file <path>` reads only that named field. Corresponding `--value-stdin`, `--expression-stdin` and `--text-stdin` read stdin only when requested. Inline/file/stdin choices are mutually exclusive; a literal `@file:` value never opts into reading.

Advanced automation adds history, semantic locators, keyboard/mouse and form operations, uploads/downloads, full-page screenshots/PDF, console/network/HAR, interception and page emulation. `exec` remains a closed typed command parser: it cannot launch or retarget the helper, close its session, change transport, or bypass ordinary page scoping.

```sh
quirky browser full-screenshot --page <page-id> --format png --json
quirky browser pdf --page <page-id> --json
quirky browser find --page <page-id> --locator nth --value 'input' --index -1 --action fill --text 'last input'
quirky browser tab profile show --page <page-id> --json
quirky browser tab profile set-page --page <page-id> --profile <profile-id> --json
```

`tab profile set-page` changes a managed agent page; existing `tab profile set --pane` changes a hosted Browser pane. Clone requires an empty isolated destination and copies actual cookies, not native-webview storage. Chrome identity uses the existing next-runtime-start setting; it does not change an already running profile's identity.

## Browser panes

Browser stays a center view (including hosted worktree tabs); Browser Settings remains a settings section and command-opened center view, not a new tool stripe. Pane controls, profiles, import forms, annotations and markup use the shared graphite controls and semantic tokens in dark and light. `quirky.browser` is enrolled in the canonical UI lint gate.

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

Find protects the focused typed query from delayed canonical replies. Next, Previous and Enter use that current query; canonical updates after editing and switching to a different pane still hydrate the field.

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

Draw freezes a real Watch screenshot and opens the markup editor above the whole window, outside pane clipping and tool-slot stacking contexts. Its controls follow the app theme; screenshot pixels and chosen drawing ink do not change with the theme. Copy Markup reports success only after the composed PNG is actually written to the clipboard. Native cropped screenshots and Draw are disabled: the pinned public SDK exposes no page snapshot capability. Native never falls back to Watch or an approximate image.

```sh
quirky browser design arm --pane <pane-id> --mode grab
quirky browser design read --pane <pane-id> --op-id <operation-id>
quirky browser design targets --pane <pane-id>
quirky browser design format --payload '<payload-json>'
quirky browser design send --pane <pane-id> --annotations '<annotations-json>' --session <session-id>
```

The public UI command `quirky.browser/design` accepts `grab`, `annotate`, `draw`, or `cancel` for the focused Native pane. Native Draw returns the documented SDK capability limit.

## API and command surface

The schema-declared automation catalog includes managed profiles/pages, advanced page interactions, captures, observability, cookies/storage, import jobs and page controls. `quirky api --json` is the authoritative method/argument listing. Browser preferences retain `preferencesState`, `profileSet` and `openLink`; `profileSet` targets a hosted Browser **pane**, while `tabProfileSet` targets a managed agent page.

Managed-page `selectAll` focuses the selected element and uses macOS editing commands for the owned Chrome target. Network observations include CORS preflight requests as well as application requests; distinguish them by HTTP method rather than assuming the latest row is a GET response.

Pane methods are `paneOpen`, `paneState`, `paneNavigate`, `paneControl`, `paneReport`, `paneClose`, `paneSuggestions`, `paneWatch`, `paneWatchStop`, `paneFrameAck`, `paneInput`, `paneRespond`, and `paneDownload`; they use the same Browser CLI group.

Design methods are `designArm`, `designRead`, `designHover`, `designCancel`, `designCapture`, `designFormat`, `designTargets`, and `designSend`.

Snapshot references are page- and generation-bound; navigation, actual helper-tab switches, closure, and browser epoch loss invalidate them. Redundant same-tab selection preserves fresh references. Every page mutation remains scoped, and a profile-wide FIFO covers helper selection plus the complete action. `exec` accepts only implemented typed page commands; documented `open` and `navigate` aliases normalize to scoped `goto`, never helper launch.

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

- **Cookie import destination:** menu, toolbar hint and per-profile Settings import controls update the selected managed Chrome/Watch profile, not the separate Native WKWebView engine. Hide Hint persists and can be reversed in Settings.
- **Native clear/removal:** `profileClear`/`profileDelete` and their `tab profile clear|delete` CLI commands require confirmation and refuse active profiles. Current SDK has no deletion completion acknowledgement; native capability rejects before invocation, preserving Chrome data/profile metadata. Successful native clear/removal is **not shipped**. `sa-browser-native-profile-clear-completion` owns the missing barrier; the one-use desktop claim command cannot bypass ordinary destructive confirmation.
- **Native identity and localhost labels:** no supported native UA override or faithful worktree-host routing capability is available. Settings state the limits rather than store working-looking no-ops. Exact follow-ups: `sa-browser-native-identity`, `sa-browser-localhost-label-routing`.
- **Native test state:** `QUIRKY_HOME` alone does not prove WKWebView storage-root isolation. Native nightly scenarios must use newly created UUID profiles only; never clear/use shared Default without independent native-root proof. Web checks cannot prove native storage isolation or deletion.


## Cookie import and credential safety

`detectBrowsers` inspects installed source cookie files only when explicitly requested. Import supports detected macOS Chromium-family profiles, Firefox SQLite, Safari binarycookies, explicit daemon-local JSON files, and explicit API JSON cookie arrays. Sources are read-only; destination data stays inside the selected managed profile. Chromium source decryption uses the selected browser's Safe Storage key only on explicit import. Tests inject synthetic roots/keys and never read the user's browser or Keychain.

Open **Import Cookies** in the Browser menu or beside a Settings profile to detect source browsers. Expanding the toolbar **Import browser data** hint offers the same controls for that pane's profile. Detection does not run on startup or ordinary profile listing. Multiple source profiles appear as named choices; empty or denied discovery still leaves **From File** available.

**From File** opens an Import Cookies dialog and a JSON file chooser. The selected file's bytes are sent as the existing JSON API source, not as a guessed daemon-side path. Invalid JSON, a non-array or an empty array reports an error without starting an import. A replacement confirmation names the captured destination; changing a pane's selected profile does not retarget an accepted job.

The controls show queued/running progress, then the actual imported/skipped/Google/partition counts and engine warnings. Success and failure produce toasts; successful imports refresh source badges in Settings and the Browser menu. Closing the control stops UI polling without cancelling the daemon-owned job; its state remains available through `importGet`/`importList` until daemon shutdown.

`importCookies` performs a confirmed one-shot import. `importStart` returns a tracked job ID; `importGet` and `importList` expose its state and actual summary. Import methods require ordinary destructive confirmation or `--yes`. Summaries include imported/skipped counts and domain/decryption/partition warnings, never credential values.

Replacement is restricted to safely imported registrable domain families, including private public-suffix rules. Unrelated cookies remain untouched. Google logins are excluded; sign in to Google directly in Quirky. Unreadable partition/decryption families are preserved instead of being wiped by partial imports. Failed writes restore the previous exact cookie identities; an unprovable rollback fails explicitly as `browser_unsafe_replace`. There is no plaintext restart-staging fallback or success claim for rejected live writes.

Cookie and storage CRUD share the same scoped API/CLI. Dialog accept/dismiss uses the current exact page session outside the ordinary command FIFO, allowing a pending prompt-producing evaluation to complete without answering another page. Clipboard operations use Chrome's private modern-headless clipboard, not the desktop clipboard.

## Floating workspace destinations

`paneOpen` and `pane open` accept explicit `worktree:"floating"` and an optional exact terminal `group`. The public editor owner supplies only its profile-owned floating document root; HOME and other worktrees are not inferred. Native and Watch retain their existing separate owners, profile rules and resource lifetimes. Opening a floating Browser tab does not navigate the main worktree view. Real native focus and system-webview visibility remain in the native handoff.


## Running browser tests

Run `bun scripts/suite.ts plugins/quirky.browser` for the canonical package checks. Real browser automation, extras API/CLI, cookie import, Watch and design-runtime files run on macOS with installed Chrome, as listed in `scripts/test-on-macos.txt`; the remote Linux host does not provide Chrome. These checks retain real owned browser processes rather than skipping browser scenarios or substituting mocks.

The browser harness installs the public dependencies of its real plugins, including the Worktrees dependency on `quirky.cli`. It uses temporary process homes and synthetic cookie source files and cleans up the owned browser and daemon. UI import tests verify explicit discovery, file recovery, captured destination confirmation and command execution without pinning explanatory copy or button punctuation.

The end-phase browser gate still has one open managed-page drag failure in SC5 (`browser_error: native browser action drag failed`). `fix-browser-remaining-flows-1028` tracks that flow after the existing `m7-sweep-browser-mobile` helper repair; the affected package is not fully green until it passes. The import, UI, select-all and CORS fixes do not waive that scenario.

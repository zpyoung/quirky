# Browser pane and page events

## Status & amendments
Approved autonomously under docs/loop/LOOP.md night mode. One logic spec includes technical contracts; no separate tech spec or spec review. 2026-10-28: initial self-reviewed design.

**Amendments:** 2026-10-28: bounded frame transport adds `paneFrameAck({pane,watchId,sequence}) -> {acknowledged:true}`. At most one delivered frame and one latest replacement may await a renderer. The renderer ACKs only after loading/drawing; a finite stalled lease expires. CDP screencast ACK is independent and always drains. This amendment supersedes the implicit event-only backpressure in SC7 and the method table below.

**Amendments:** 2026-10-28: `paneOpen` owns `quirky.terminal/openViewTab` and records its real tab ID for API and UI callers alike; the UI does not duplicate the tab. `paneClose({pane,fromTab?:boolean})` uses `fromTab:true` only in the hosted-tab preclose callback and removes resources directly, avoiding terminal queue reentrancy. Ordinary `paneClose` closes the actual hosted tab and cleans state idempotently.

**Amendments:** 2026-10-28 lane8/user coordination: PaneTab carries profileId (default `default`) and partition; paneOpen accepts profile. Exact Native partition is `persist:quirky-browser-${profileId}`, IDs only `default` or `profile_[0-9a-f]{32}`, assigned before creation. BrowserService.listPanes() returns copied PaneTab[]; setPaneProfile validates BrowserStore existence, preserves pane/tab/URL and retires old Watch generation. Lane8 owns profileSet, maintenance/clear confirmation guards and schema-declared profileClearNative window command with a one-use claim. Latest user ruling: public nativeBrowser.clearPartition rejects completion-unavailable BEFORE any real Session invocation because the pinned SDK exposes only void clearStorageData, not a proven completion contract; plain-web also rejects unavailable. No native data/Chrome/metadata deletion follows a mere invocation. Lane8 queues native-profile-clear-completion; do not duplicate it. Native tests/nightly use NEW run-owned UUID partitions only; HOME/QUIRKY_HOME is not proven to relocate WKWebView storage, and shared Default must never be cleared without a proven isolated native-root override. Lane8 owns src/preferences/** and src/preferences-window/**; menu insertion props {context,pane,onError} after Browser menu, before History.

**Amendments:** 2026-10-28: NativeBrowserCapability also exposes clearPartitionAvailable:boolean, false in both current production native and plain-web adapters. Lane8 checks it before consuming a confirmed opaque clear claim; a known pre-invocation rejection must not strand the profile in an uncertain state. The unsupported native clear host transport/Session call is absent, not a hidden alternative success path.

## Purpose and conceptual model
People browse in one sandboxed system-webview embedded in the active worktree tab. Agents continue to drive the existing profile-owned headless Chrome; Watch displays that exact managed page through CDP screencast, without a second page rendering it. A pane tab is either Native (human browsing, no Chrome startup) or Watch (an existing or explicitly created agent page). Switching away destroys the native view or ends the screencast subscription. Closing a Watch pane does not close its agent page. Closing an agent page ends its watch with a visible error, not a recycled target.

## Scope and non-goals
This queue item covers browser.md section 1 items 1–10 together: opening/closing browser tabs and panes, normalization/suggestions/history, find, zoom, viewport presets, local HTML and workspace document previews, three default settings; download shelf, script dialogs/basic-auth/certificate prompts, page-created tabs/popups/OAuth and external-app launch policy. Browser profiles/cookie import and design tools belong to other items. SSH/client-hosted routing, native chat, artifact publishing/account services are not added. Share-as-artifact depends on a dropped account integration and is not advertised as a working action.

**Native SDK feasibility boundary:** pinned Electrobun exposes sandboxed native views, navigation/find/zoom and observational popup/download events, but no public JS-dialog/basic-auth/certificate interception or download cancellation/destination control. Do not fake synchronous confirm/prompt with an asynchronous JavaScript override, turn off TLS validation, route all human pages through Chrome, or access private native pointers. Native-only unsupported page-event flows require an explicitly queued dependent follow-up describing the missing SDK prerequisite. Implement the reachable Chrome Watch page-event flows through CDP. Native popup/OAuth interception and native download control must likewise be honestly deferred if the public SDK cannot establish safe ownership. The rest ships without them under LOOP.md's flow-deferral rule. Deferred/native support is never reported passing.

## Decisions locked
- Layout/interaction: compact toolbar above the page with Back, Forward, Reload/Stop, address bar, Find, Watch/Native mode indication and Browser menu; real accessible buttons and labels, no hidden command-only flows.
- Empty/loading/error: blank Native pane says New Tab / Type a URL above to start browsing; loading never erases the URL; navigation error retains requested URL and retry controls. Plain web clients explain native unavailability and offer an explicit Watch mode, never a silent engine substitution.
- API/CLI: every action is a schema-declared quirky.browser method generated in the browser CLI. The public plugin API grows with a generic native-browser capability; browser-specific policy stays in the plugin. Window commands run through the existing command API. Daemon pane state includes actual hosted terminal tab ID and active pane identity.
- Data: history is per plugin store, capped at200 recency-deduplicated safe URLs; suggestions at most8, queries over2048 UTF-8 bytes return none. Strip credentials and Kagi session token from persisted/history addresses. Native URL reports are untrusted and cannot authorize OS launch/file read.
- Targeting: pane IDs map to a worktree. Watch requires the same worktree as its managed page, and retains page generation/session identity. No Chrome URL/title/order target matching. No renderer-controlled CDP passthrough.
- Lifetime: at most one native browser resident per window; hidden native view removed, URL retained. One active Watch lease per pane; stop/close/unmount cancels subscriptions and timers and acknowledges/drains frames. No implicit mutating-command retries.
- Settings: Default Home Page blank by default; Default Search Engine google/duckduckgo/bing/kagi (Google default); Default Zoom0, clamped -3..5 in half steps. New tabs use current defaults; changing defaults does not mutate existing tabs.
- Platform: macOS only; other-platform native host/OS launch/download behavior recorded deferred: platform.

## Behavior and acceptance scenarios
Each scenario is driven by the CLI/daemon API and, where web-renderable, by the real browser UI. Native-system-view facts are additionally handed off to docs/loop/native/sa-browser-pane.json, not inferred from a web-only test.

### SC1 — Native lifecycle and discoverability
Before: worktree W has no browser. Use New Browser Tab (tab create menu or command palette, Mod+Shift+B). After: a real hosted browser tab in W with a unique pane ID, default URL or New Tab blank overlay; no automation Chrome process was started. Switch to another tab/worktree: native browser is destroyed. Return: recreate only one native view with retained URL. Close: pane metadata and native resources disappear. A normal web client shows native-unavailable with explicit Watch entry rather than an empty fake webview.

### SC2 — URL input and suggestions
Before: default search Google and history [https://example.com/]. Enter localhost:3000 -> http://localhost:3000; 127.0.0.1:3000 -> http; IPv6 loopback -> http; example.com -> https; foo.localhost:8080 -> http; absolute POSIX/Windows/UNC paths -> file URL; existing http/https/file retained; empty/about:blank -> about:blank; hello world -> selected search engine query. Reject javascript:, data:, and other explicit schemes as navigation. Suggestions offer safe matching history/workspace documents and a search row, maximum8; empty query shows recents. An oversized query yields none. Selecting a row navigates; Enter works without selecting a row. Credential/session-token URLs never leak into persisted history.

### SC3 — History and navigation state
Visit local fixtures A then B and navigate back, forward, reload, hard reload, stop while loading. Address/title/button availability reflect actual resulting page, including same-document navigation; history caps200 and survives plugin restart. Invalid schemes fail before navigation or history mutation. Failed loads retain validated URL, show error, and can recover to A.

### SC4 — Find
Find in Browser (Mod+F) shows text input, previous/next/close and N of M / No matches. On fixture with three occurrences, searching selects/highlights real text, advances and reverses, close clears highlights; zero hits shows No matches. Watch uses the exact bound Chrome page; Native uses supported native/injected view operations without exposing guest access to daemon RPC.

### SC5 — Zoom and viewport
Zoom In/Out/Reset through toolbar/menu and API follows half-step -3..5, displayed percent round(100*1.2^level). New tabs start at configured default, old tabs unchanged. Viewport menu lists Default, Mobile S320x568, M375x667, L425x812, Tablet768x1024, Laptop1024x768, Laptop L1440x900, Desktop1920x1080. First4 CDP presets use mobile=true and scale2; others scale1. Watch page emulation persists through reload. Native uses the selected visible size and documents that mobile CDP emulation applies only to Watch.

### SC6 — Local HTML and workspace documents
Open file:// HTML or absolute path, retain native browser navigation; Open source file uses the public editor API only for an in-worktree canonical file. Workspace documents can open an explicit supported preview, with Back returning to the prior web location. Reuse public worktree/files/editor/resource capabilities; never serve unrestricted filesystem paths or inject unescaped source into HTML. If editor preview does not support a document, give an explicit error, not a successful fake preview. Artifact publication is excluded above.

### SC7 — Watch an agent page
Before: API creates agent page P in W. Open Watch P in W. After: pane displays P's real screencast; API fill/click/eval visibly change the same page. Viewport/input coordinate conversion accounts for letterboxing and real frame dimensions. Pointer, wheel, text and key events operate only on P; no OS focus steal. Switch away: Page.stopScreencast, no further frame delivery. Resume produces a fresh watchId; late old events ignored. Close P or kill owned helper: visible error/end, no retarget to another page. Frame delivery bounded (one latest frame, no unbounded event history/base64 persistence). Input through typed API, not arbitrary CDP method names.

### SC8 — Downloads
Watch fixture attachment starts a shelf with safe collision-resistant destination under OS Downloads (test home Downloads), name and byte progress. Cancel affects that download only; completed file can Open/Show in folder; dismiss removes shelf entry only. State distinguishes downloading/paused/completed/canceled/error. Never overwrite an existing file or execute a page-provided path. Any unsupported Native controls are queued under the SDK boundary, not rendered as working buttons.

### SC9 — Prompts and auth
Watch alert/confirm/prompt/beforeunload appear as Quirky overlays naming the origin; accept/dismiss returns real result to the initiating page, including Unicode input. Basic auth provides username/password without persisting/logging credentials. At most one prompt per page; flood refused, timeout120s fails closed. Respond outside the helper's held profile lock so eval awaiting prompt cannot deadlock. Pending generation/IDs prevent stale responses to a new page. Native interception limitations are queued explicitly.

### SC10 — Certificate policy
Watch TLS failure displays certificate prompt; Proceed available only for loopback IPs/localhost/.localhost. Remote host certificate failures cannot proceed, even through direct API. No global ignoreCertificateErrors. Timeouts/stale responses fail closed. Native unavailable hook is queued, never silently bypassed.

### SC11 — Popups, OAuth and external apps
HTTP(s) target=_blank/window.open from an input opens same-profile managed browser tab; page-initiated creation limited4 per2seconds with owned cleanup for excess targets. Named/opener-dependent OAuth requires a small native window and origin bar, preserving opener/post body; if no supported native mechanism, queue this exact flow, do not approximate by URL-only tab. Non-http(s) app launches require explicit origin-naming UI prompt and allow-listed safe OS launch; javascript/data/file masquerades cannot launch an OS command. Native SDK interception limitations recorded separately.

### SC12 — Default settings and commands
Settings contribution exposes Default Home Page, Default Search Engine, Default Zoom; changes persist using public settings. All SC1–SC11 actions that ship appear in quirky api and browser CLI. Standard browser focus/address/find/back/forward/reload/hardReload/zoom commands bind only in browser context; normal copy/editor shortcuts remain unaffected. Replaced/disabled plugin contributions unmount all resources.

## Defect and safety regressions
DF1: same-page watch input never reaches another identical-URL page/worktree (existing agent mapping retained).
DF2: pending prompt response works while eval awaits it; close cancels, stale prompt cannot resolve a different page.
DF3: hidden/closed view releases resources; late frame/command reports do not resurrect it.
DF4: helper/process swap or closed page produces explicit stale/error, no guessed retarget or implicit mutation replay.
DF5: unsupported schemes and credential-bearing URLs do not enter history; local file escapes denied for preview/source opening.
DF6: page-prompt flood and popup budget remain bounded; timeout fails closed.
DF7: real UI typing focus in another terminal remains there during agent input (native nightly handoff). Existing source design-mode annotation defects belong to design-mode item, not this item.

## Industry insights
No external research swarm under night-mode instruction. Grounding: read-only external browser.md, docs/architecture.md Browser, shipped sa-browser-agent D19/D21/D23/D26/D37–D43; installed SDK API files. Native and CDP are separate engines; a screencast is not another rendering of the page.

## Deferred ideas
No unrelated features. Native page events/OAuth/artifact integration limitations above must have a durable decision and follow-up before land; no placeholder API implementations may ship.

## Glossary
Pane: plugin-owned browser presentation, in one hosted terminal tab. Native: sandboxed system-webview for a human. Watch: bounded CDP frame lease of an existing managed agent page. Page: existing browser-agent identity. Lease/watchId: prevents stale frame delivery across remount. Half-step level: zoom exponent, not percent.

## Technical contracts and implementation partition
Shared type files committed before implementers: packages/protocol/src/native-browser.ts and plugins/quirky.browser/src/pane-contract.ts. These are normative shapes, not implementation stubs. Browser pane RPCs all under quirky.browser; manifest contributes exact schemas/CLI flags. Every provided API is implemented or removed from the contract/manifest with a decision if blocked by the named SDK boundary. No advertised no-ops.

### Public native capability (component Native)
UiPluginContext.nativeBrowser: NativeBrowserCapability. mount(element, options) returns NativeBrowserHandle; available=false in plain browser, mount throws explicit unavailable. A trusted shell bridge supplies the supported SDK custom element for geometry/navigation and accesses only tag-owned BrowserView IDs for real WebKit zoom. Native child sandbox=true; SDK default appData=false; synchronous navigation rules allow HTTP/HTTPS/file/about:blank only and deny views/appdata schemes. The tag cannot disable the packaged public-asset loader flag; that defense-in-depth flag is not guest authority. Never pass daemon token/URL or privileged host RPC to guest. State/find reports from a guest are display-only untrusted data. At most one resident view per window, destroyed on hide/unmount/window close. No private FFI/pointers. Native owns protocol exports/context addition, packages/ui host integration, desktop bridge/preload/types and scoped tests; no plugin files.

### Plugin runtime (component Runtime)
Browser pane methods and requests are normative in src/pane-contract.ts, including paneFrameAck and paneClose.fromTab amendments above. Existing agent-core catalog remains unchanged except explicit focus reveal may be implemented; otherwise keep its honest rejection. Native pages never enter Chrome restoration list; Watch page must match pane worktree. Bindings/generation/locks use current driver, never URL/order guesses. Runtime owns plugins/quirky.browser/src/** EXCEPT pane-contract.ts, ui.tsx and window/**, plus main.ts, test/pane*.ts, test/harness.ts and (only if core acceptance changes) test/automation.test.ts. Runtime emits paneChanged(PaneState) and bounded paneFrame(PaneFrame), never persists frames. paneWatch returns {watchId}; state-changing methods return PaneTab, paneState returns PaneState, suggestions returns {suggestions:[{url,title,kind:'history'|'search'|'document'}]}; stop/close return {closed:true}; input/respond/download return actual structured results. paneReport validates pending command identity and current tab, never resurrects an unknown pane. Dialog/download controls use exact-session CDP outside held helper locks where necessary. Native paneOpen creates real hosted tabs, and fromTab preclose cleanup never reenters the terminal queue.

### UI contributions (component UI)
UI owns plugin quirky-plugin.json, cli.ts, conventional src/ui.tsx bundle entry, src/window/**, README.md and test/window*.test.ts. Provide Browser view and New Browser Tab/palette/keybinding/menu actions through paneOpen; the daemon opens the public terminal hosted tab. Render PaneTab/PaneState; use nativeBrowser only in Native, latest-frame image/canvas in Watch with correct typed input coordinates. Subscribe to paneChanged/paneFrame; stop lease on unmount, ignore stale watchId/sequence, ACK only loaded/drawn frame. Execute pending Native commands and report actual command result/ID. No kernel DOM querying or private services. Manifest uses existing limited Schema subset; settings defaultHomePage/defaultSearchEngine/defaultZoom match runtime. Declare all implemented methods, events and CLI contributions without advertised stubs.

### Verification
Implementers skip all build/lint/tests/formatters while peers run; parent runs each owned test after barrier, affected suite once: bun scripts/suite.ts plugins/quirky.browser packages/ui packages/protocol apps/desktop; bun test scripts; bun run typecheck. Since protocol is widely imported land runs complete integration suite. Every process fixture uses createProcessScope/temp HOME+QUIRKY_HOME, hooks disabled, mock-keychain Chrome, and awaited owned cleanup. No real browser/profile/Keychain/source import. Actual smoke: real owned daemon+Chrome/local fixture and isolated web surface; agent eval visibly changes Watch pane. Native scenarios are pending nightly; web cannot establish native embedding, OS focus or origin-bar windows. One final review/fix batch. Merge build/roadmap once just before land and read incoming decisions. Remove exact owned scratch/worktrees after land.

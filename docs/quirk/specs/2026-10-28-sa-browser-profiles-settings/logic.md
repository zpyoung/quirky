# Browser profiles and settings

## Status & amendments
Approved autonomously under the current build/roadmap LOOP.md night-mode rules, 2026-10-28. One self-reviewed logic spec with technical decisions; no separate tech spec or spec review.
**Amendments:** 2026-10-28 — confirmed the native Session API proves invocation only, not deletion completion. Native profile clear/removal cannot ship as working until a supported acknowledgement/barrier exists; current attempts reject before native invocation and preserve Chrome data/metadata. Exact dependent flow: sa-browser-native-profile-clear-completion. Native nightly uses only fresh UUID partitions; never shared Default without proven native storage-root isolation.

## Purpose and conceptual model
A Browser pane belongs to one persistent profile. Default always exists. Settings and toolbar actions use the same authenticated plugin API as the CLI. Human Native browsing and agent Watch remain separate engines; selecting a profile rebuilds the native guest or retires/rebinds the Watch lease without changing the hosted tab identity or its URL.

## Scope and non-goals
This item owns browser.md section2 profile/cookie menus and the Settings table. It does not implement the cookie import engine, advanced automation, design mode, paired servers/SSH routing, OAuth, or artifact publishing. Existing sa-browser-agent D37/D38 deferred the actual import engine, imported-source metadata and identity backend. Menu availability is based on real methods: no fabricated sources, import success or OS file picker. Where a prerequisite is unavailable, disclose it and queue that exact flow before landing. Remote settings remain absent because the prior Browser scope is local-only.

## Decisions locked and key rationale
- Reuse public Browser profileList/profileCreate; add profile selection and safe inactive-profile clear/removal rather than copy profile state into UI storage.
- Compact accessible Browser menu and Settings > Browser, with loading, actionable inline errors, explicit destructive confirmation, and no optimistic success before API completion.
- Default settings remain owned by sa-browser-pane. Browser settings also expose Link Routing (off), Shift inversion (off), terminal plain click Actions and middle click Open URL, and the import hint hidden flag (false). Terminal settings are edited in their existing namespace, not duplicated.
- Cmd/Ctrl-click always opens a URL; Shift+modifier forces system browser unless inversion is enabled, then flips configured routing once. File-path copy/reveal behavior remains unchanged. Link routing applies to terminal, editor and Markdown HTTP(S) links only; unsupported protocols are rejected by the existing external-open policy.
- Profile deletion/clear are irreversible API methods using ordinary confirmation or --yes and refuse active panes/pages. The current native SDK lacks deletion completion acknowledgement, so clear/remove report actionable unavailable before any native invocation or Chrome/metadata mutation; no deletion parity is claimed. Default cannot be deleted. The dependent native-profile-clear-completion item must establish supported completion before enabling real clear/remove.
- Identity: Cleaned versus Native is a next-runtime-start Chrome setting with restart notice. Native system-webview UA override has no inspected public SDK method, so its missing flow must be explicitly queued and not represented as working. Agent Browser Use is a persisted explanatory setup checklist only, never an automation authorization gate or automatic real-home skill install.
- Import detection runs only on explicit opening, never mount/startup. Until extras supplies import methods, render an explicit unavailable explanation and Google-login exclusion, not fake installed-browser rows. Hint can be hidden and restored through settings.
- Localhost Worktree Labels requires a faithful reachable host mapping, not changing hostname text alone. If no public routing prerequisite exists, expose the exact limitation and queue it, never persist an effective-looking no-op.

## Behavior and acceptance
Each scenario has CLI/daemon API coverage; visible controls are additionally exercised in an isolated web dogfood. Native-only proof is handed off to nightly scenarios.

### SC1: Profile discovery and creation
Before: Default only, pane P uses Default. Open Browser menu: Default is checked. New Profile opens a labelled Profile name dialog. Submit Review: API creates an isolated persistent profile, success is shown, list refreshes; duplicate/blank name leaves dialog and error. After restart Review remains; opening Settings does not start Chrome.

### SC2: Profile switching
Before: P uses Default at URL U and Q remains Default. Choose Review in P: P keeps its pane/hosted-tab identity and U, profileId changes to Review, old native guest/watch lease is retired and rebuilt. Q is unchanged. Invalid/deleted profile fails before mutation. A Watch page cannot be claimed under a mismatched profile or worktree.

### SC3: Session & Cookies management
Before: Default and unused Review exist. Settings shows each profile and Active when used by a pane/page; Add Profile reuses SC1. Remove/Clear disclose their native-completion prerequisite. An attempted confirmed inactive clear/remove returns unavailable before native invocation, retains the profile and Chrome data, and never shows success; cancel and active-profile refusal preserve data. The real native clear/removal flow is queued as sa-browser-native-profile-clear-completion. Default cannot be removed; no paired-host picker is fabricated for a local-only runtime. Injected native-ack test boundaries prove only daemon guard sequencing, not current native deletion.

### SC4: Import affordances and hint
Before: hint visible. Toolbar Import browser data and menu Import Cookies show the same real capability state. With import engine unavailable, explain the missing engine, include Google logins aren't imported / Sign in to Google directly in Quirky, and offer Browser Settings and Hide Hint. Hide persists and can be undone in settings. Once real engine is present, detection may run only after explicit import-menu opening; no protected browser data read at startup. Successful engine execution/file import is an explicitly dependent flow, not claimed by this UI-only item.

### SC5: Browser defaults and setup
Before: default URL unset, Google, zoom100%. Browser settings edits the dependency's home/search/zoom settings and saves through settings API; new panes use defaults, existing panes do not change. Agent Browser Use toggle reveals checklist/examples without installing skills or gating browser API. Error saves do not show success.

### SC6: Routing and terminal click behavior
Before: Link Routing off, inversion off, plain Actions/middle Open. A terminal plain URL click shows actions; Open uses system browser. Turn routing on: Open from terminal/Markdown/editor calls paneOpen in the originating worktree. Cmd-click opens directly. Shift+Cmd-click forces system browser; enable inversion to flip either configured route for one click. Plain/middle options Actions/Open URL/Leave to terminal take effect immediately from canonical terminal settings. No auto fallback to system browser when an explicitly requested in-app open fails. File links retain editor/open/reveal behavior.

### SC7: Identity and localhost capability limits
Before: mode Cleaned. Select Native for Chrome: persisted mode changes with restart-required text, existing runtime unchanged. After a daemon or Browser-plugin restart, a new runtime applies the selected mode; a Chrome/helper epoch restart within the old runtime does not adopt a changed setting. Native preserves the actual UA; Cleaned removes embedding/headless tokens. Native system-webview identity mode explicitly reports unavailable hook. Localhost labels are not advertised effective without a real mapping. Missing native UA and label routing receive exact dependent queue flows and blockers. Linux/Windows verification is deferred: platform.

## Defect and safety regressions
DF1 profile switch never aliases a page in a different worktree/profile; late old lease/state cannot resurrect it. DF2 no protected-source discovery on mount. DF3 failed native clear cannot remove profile metadata or Chrome data; active profiles cannot be removed. DF4 route modifiers cannot turn unsupported schemes into external execution; normal terminal file copy/reveal is retained. DF5 no global agent/browser config writes, no real Keychain/browser state in tests. browser.md's annotation-selection defects are owned by the separate design-mode item, not these menus.

## Industry insights
No external research swarm per LOOP.md night mode. Evidence is browser.md section2/Settings, docs/architecture.md Browser, sa-browser-agent D19/D21/D23/D37/D38, sa-browser-pane spec and inspected public Electrobun BrowserView.partition and Session.fromPartition.clearStorageData. No private native pointers or iframe substitution.

## Deferred ideas
Only named unavailable prerequisites above; each requires an exact queue follow-up and decision before land. No unrelated features.

## Glossary
Profile: persistent browser identity, with separate Chrome directory and native partition. Pane: hosted Browser tab. Watch: exact managed Chrome page screencast lease. Cleaned: user-agent token normalization, not a credential or fingerprint guarantee.

## Technical decisions and shared contracts
- Three disjoint components maximum: backend preferences/profile lifecycle and Chrome identity; React profile/import/settings components; terminal/editor/Markdown link consumers. Parent owns manifest/CLI/service/UI insertion and native/dependency integration. Contracts committed before implementers. OpenAI omp task implementers; pi-watch Opus unavailable by actual probe, Gemini reachable and selected for cross-family final review.
- Backend files src/preferences/** plus profiles/store.ts and runtime/driver.ts as needed; do not alter pane service contracts owned by lane4. Expose a registerPreferences(context, adapters) composition seam with explicit profile lifecycle, pane state/profile selection and native clear adapters. Never register duplicate existing methods.
- Renderer files src/preferences-window/** export BrowserProfileMenu and BrowserSettings with {context,pane,onError}; Settings pane argument is optional. No kernel DOM reach-through. Parent inserts into src/window/BrowserPaneWindow.tsx and settings-section contribution after merging dependency.
- Routing consumers use quirky.browser/openLink({url,worktree,shift?,modifier?}) returning actual route/pane. Browser service owns decision and external/pane invocation; consumers do not import Browser internals. Canonical settings IDs: quirky.browser/openLinksInApp, openLinksInAppModifierInverts, browserImportHintHidden, agentBrowserUseEnabled; terminal link-click/link-middle-click unchanged.
- Preserve limited public Schema subset, stable browser errors, generated CLI and public settings methods. All processes use fresh HOME/QUIRKY_HOME and createProcessScope cleanup. Parent runs affected remote suite, scripts and typecheck once before land; one web dogfood; one final review/fix batch; native handoff pending. Catch up pending dependency before tests, wait deps ready then one roadmap catchup and land.

### Verified cutover contracts
2026-10-28 amendment: openLink resolves pane identity first, then opens the public worktree view using the returned worktreeId before reporting route=app. A valid caller selector is not itself the window input identity. paneClose has one canonical boolean-true result for direct API/CLI calls and the terminal pre-close callback; fromTab/tabId remain terminal-plugin-only and must match the actual hosted tab. No compatibility union or hidden success wrapper. Pending profile admissions cover the complete asynchronous pane/page/profile-switch operation, not only a pre-await availability check.

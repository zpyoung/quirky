# Native browser host controls and retained pane completion

## Status & amendments
Blocked at brainstorming/technical feasibility on 2026-10-28. The following is the complete retained behavior contract, not a shipped implementation or an acceptance receipt. No product source, public schema, dependency pin, tests, or native scenario statuses changed.

**Amendments:** None. This item preserves sa-browser-pane D17/D23 and sa-browser-design-mode D33; it does not supersede them.

- 2026-10-29: the core is unblocked by the approved Electrobun fork patch `patch/hard-reload-load-failed` (decision D9). HC1–HC3 are implemented through it; "Technical feasibility" below describes the stock SDK, which still lacks both operations and keeps the unavailable path.

## Purpose and conceptual model
A human browses in the owned sandboxed system webview. A Native hard reload must bypass the native engine's cache for the unchanged requested URL. Network/TLS failures must originate in the native engine's navigation-failure callbacks and produce explicit error state, retained requested URL, and retry controls. Watch remains a screencast of the exact existing managed Chrome page, not a substitute Native engine.

## Scope and non-goals
The queue title's Native reload/error flows are the core of this item. Its binding inherited scope also includes sa-browser-pane's SC1–SC5, SC7 and SC12 base-pane/Watch UI acceptance, resource lifetime, cross-lane pane/profile composition, and sa-browser-design-mode D33's ordinary Watch-to-host clipboard transfer. Their implementation and existing tests remain preserved; blocking Native does not clear or transfer these obligations. Current LOOP moves acceptance execution to the end phase, so this iteration does not restart their dogfood/review/debugging campaign.

Existing native-events owns prompt/auth/certificate decisions, downloads, popup/OAuth and external launch interception. Workspace-preview owns isolated grant preview and Back. Profiles/settings owns its feature implementation and already named native clearing, identity and import handoffs. This item must not add another record duplicating those owners.

Non-goals: changing engines, Electron/CEF substitution, a Swift desktop shell, broad TLS overrides, private pointer/Objective-C delegate replacement, an unapproved SDK fork, cache clearing with unproven completion, URL cache-buster mutation, and inferring failures from timeout or absence of a success event. Ordinary reload is not hard reload; command rejection is not a native network error.

## Data flow and decisions locked
- Interaction: retain ordinary Reload/Stop and native-unavailable reporting. Enable Hard Reload only when a real supported cache-bypassing operation exists; command/API/CLI must invoke that same operation.
- Loading: retain requested URL while a navigation is pending. Never turn a finite command wait into a fabricated DNS/TLS failure.
- Error: accept only actual owned-native navigation failure details; preserve the requested address rather than a browser-internal error URL. Retry explicitly navigates that address once.
- Recovery: a superseded/cancelled navigation cannot overwrite the newer request's state; disposal rejects late reports. Retrying does not disable certificate validation.
- Integration: extend the existing public generic NativeBrowserCapability through the trusted tag-owned bridge if a supported native primitive becomes available. Plugins do not import host pointers or SDK internals.
- Targeting/lifetime: preserve one resident Native view, owned pane/profile identity, exact Watch generation and bounded frame ACKs. No URL/title/order matching, mutation replay, or new clipboard permissions.
- Data/security: native failure details are display data, not authorization; no daemon credentials go into the guest, error messages, or persisted history.
- Platform: macOS is the implementation target. Linux/Windows host validation remains deferred, not inferred from this source audit.

## Behavior and acceptance scenarios
### HC1 — Genuine Native hard reload
Before: an isolated native profile displays fixture A at URL U, with its response cached; the server now serves B at the same U. Action: Hard Reload from the toolbar, bound command, and public command/API path. After: the engine requests fresh content and displays B at unchanged U, with the same owned profile and pane. Ordinary Reload remains separately available. No storage deletion or query mutation substitutes for cache bypass.

### HC2 — Network and TLS failure with recovery
Before: the pane displays A. Action: navigate to a controlled closed loopback endpoint, then to a controlled invalid-certificate HTTPS endpoint. After each: an actual native failure callback supplies error state, loading ends, the requested URL remains in the address bar/state, and retry is available. Once the fixture becomes valid, explicit retry loads it and clears the error. Certificate validation is never globally disabled. HTTP error responses alone are not transport failures.

### HC3 — Supersession and disposal
Before: request U1 is pending. Action: navigate to valid U2 or close/hide the owned pane; deliver late U1 failure. After: U2 is not replaced with U1 error, and closed/disposed views are not resurrected. Native resources are released and only the current owned view can report.

### HC4 — Retained base-pane and Watch scenarios
Before: a real worktree has Native and exact-page Watch panes plus two managed pages with the same URL. Actions: new-tab discovery, URL/suggestions/history navigation, focus/address commands, real find occurrences, zoom/viewport, Watch screenshot/input, switch/hide/resume/close and profile changes. After: preserve the behavior and examples of sa-browser-pane SC1–SC5/SC7/SC12, bounded ACK transport, exact page/worktree identity, fresh leases, retained URL and owned cleanup. Profiles/settings implementation remains the producer; compose its current public contract rather than replacing it.

### HC5 — Ordinary Watch clipboard transfer
Before: the exact bound guest contains selectable text and a nonempty host clipboard sentinel. Action: select/copy guest text normally, focus a host input, paste. After: the selected text reaches the host input, Grab is not armed, site copy semantics and permissions remain intact, and neither an unrelated page nor stale lease can supply clipboard data. This is the retained unresolved observation from run 20261028T094623-7210, not a proven Native failure or a tool-only failure.

## Defect and safety coverage
Preserve sa-browser-pane DF1/DF3/DF4/DF5/DF7 and all existing tests: exact-page input, hidden resource release, late-event rejection, no guessed retarget/replay, safe URLs/history, and no user-focus theft. Add consumer-visible regression coverage when supported Native primitives exist for HC1–HC3. Do not add a mocked-success cache test or a synthetic load-failure test that purports to prove the native engine. No tests were added/run here because implementation is blocked at the required native boundary.

## Industry insights
No research swarm or reviewer was run. Grounding is the read-only browser feature doc, locked architecture, prior decision logs, one targeted repository scout, and an executable isolated source/public-event audit. Registry latest is Electrobun 2.0.5. The complete v2.0.4-to-v2.0.5 comparison contains 136 files across 52 commits and no non-test changes under public main SDK/browser/preload. Latest macOS native source still calls ordinary reload and contains neither provisional nor committed navigation-failure delegate methods.

## Deferred ideas
No new feature or follow-up item. All named acceptance obligations stay attached to this blocked item. Native event interception, preview, profile clearing and identity retain their existing owners.

## Glossary
Native: the desktop system-webview, not Chrome. Watch: a frame lease of the existing managed Chrome page. Hard reload: real engine cache bypass, not normal reload or URL mutation. Native load failure: a failure reported by the engine, not an application timeout. Requested URL: the user's current navigation target retained through failure.

## Technical feasibility and implementation prerequisite
`apps/desktop/hutch.config.ts:6-8` pins Electrobun 2.0.4. The installed public tag has `reload()` only (`api/preload/webviewTag.ts:276-279`) and load-started/committed/finished only (`:12-26`). Existing Quirky protocol already distinguishes hardReload and carries error state (`packages/protocol/src/native-browser.ts:9-16`). The adapter correctly rejects hard reload (`packages/ui/src/native-browser.ts:842-843`); adding another schema cannot supply the missing native behavior.

Published 2.0.5 has the same supported boundary:
- [Public tag](https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/browser/webviewtag.ts): `reload(): void`, no load-failed event.
- [Public event factories](https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/sdks/main/events/webviewEvents.ts): runtime import emits eleven event names, none for navigation failure; download-failed is not page failure.
- [macOS native source](https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/native/macos/nativeWrapper.mm#L3346-L3348): WKWebView reload calls `[self.webView reload]`; native wrapper dispatches that ordinary operation. No `reloadFromOrigin`, `ReloadIgnoreCache`, `didFailProvisionalNavigation`, or `didFailNavigation` hook exists in the inspected file.
- [Complete supported release comparison](https://github.com/blackboardsh/electrobun/compare/v2.0.4...v2.0.5) supplies no replacement public API. Editing generated `.hutch/devkit` files would neither produce the absent native binary implementation nor be a durable supported extension.

Unblock with a documented supported SDK operation backed by true WKWebView cache bypass and real native provisional/committed failure events carrying owned view/navigation identity, failing URL and error details; or an explicit authorized native-fork/patch contract that supersedes the prior no-private-pointer decision. The existing independent iOS WKWebView module is not an extension of the desktop view.

After that prerequisite, reuse existing request/state/command seams, commit necessary shared contract changes before implementers, update every consumer, and exercise HC1–HC5 plus preserved base scenarios under the phase then active. Native engine observations require disposable UUID profiles and a proven isolated native storage root; do not touch real Default or infer QUIRKY_HOME redirects WebKit storage. No implementation signatures or placeholders are introduced while those prerequisites are absent.

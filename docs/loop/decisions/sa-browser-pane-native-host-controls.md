# sa-browser-pane-native-host-controls decisions

## D1: Retain the queue core and all binding inherited acceptance
- **Question:** Does the title alone define scope, or do prior owner assignments also bind this item?
- **Options:** title only; inherited completion without Native core; title plus all prior assignments.
- **Chose:** true Native cache bypass and native load-error state remain core; retain base-pane UI/Watch screencast/input/find/zoom/viewport, cross-lane pane/profile composition, and residual Watch-to-host clipboard acceptance.
- **Why:** sa-browser-pane D23 and sa-browser-design-mode D33 assign these to this exact existing item. No title edit, duplicate follow-up or implicit scope reduction is authorized.
- **Evidence:** docs/loop/decisions/sa-browser-pane.md:245-254; docs/loop/decisions/sa-browser-design-mode.md:363-372; docs/loop/BLOCKERS.md:371-404.
- **Reversibility:** medium (acceptance ownership).
- **Confidence:** high.
- **Revisit if:** an explicit later operator ruling changes ownership.
- **Source:** locked by sa-browser-pane D23 and sa-browser-design-mode D33

## D2: Answer design questions autonomously and stop at the unsupported core boundary
- **Question:** How should brainstorming/spec/execution run unattended under the current build-first policy?
- **Options:** human questions and research/review swarm; autonomous defaults and targeted capability investigation; manufacture implementation despite missing native API.
- **Chose:** no asks, companion, adhd, external swarm, review round, dogfood or suite; one logic spec with final technical section; one read-only scout plus executable source/public-event audit. No implementer or backend-review preflight because supported core feasibility fails before implementation.
- **Why:** latest canonical LOOP says no person is watching, build first/typecheck-only until end phase, and block an item whose core cannot ship. A capability audit is not a product test pass.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md read this iteration; MapNativeControls completed; isolated capability-audit.ts exit0 in1.66seconds.
- **Reversibility:** easy (process).
- **Confidence:** high.
- **Revisit if:** supported host API becomes available or end phase changes execution policy.
- **Source:** locked by docs/loop/LOOP.md

## D3: Preserve Native/Watch separation and supported host ownership
- **Question:** Which integration approach can faithfully meet the required controls?
- **Options:** normal reload plus inferred failure; Chrome/CEF engine substitution; private pointer/delegate surgery; supported Electrobun native primitive and real event.
- **Chose:** supported native primitive/event only; block while absent rather than substitute or alter generated SDK files. Do not launch a Swift desktop shell or replace the engine.
- **Why:** architecture locks the system-webview for people, managed Chrome for agents and at most one resident Native view. Prior decisions reject private FFI and false hard reload. No configured durable dependency-patch path was found, and changing TypeScript cannot add native binary callbacks.
- **Evidence:** docs/architecture.md:180-203,290-324; sa-browser-pane D5/D9/D13/D17; MapNativeControls inspected public entries, FFI and projection.
- **Reversibility:** hard (engine/host boundary).
- **Confidence:** high for supported API absence; not a claim that WebKit itself lacks the capability.
- **Revisit if:** an upstream supported SDK or explicit authorized native patch exposes both real primitives.
- **Source:** locked by docs/architecture.md and sa-browser-pane D17

## D4: Require real cache bypass without changing page identity or data
- **Question:** Interaction/cache gray areas: ordinary versus hard reload, URL identity, persistent session and fallback?
- **Options:** invoke reload; cache-bust URL; clear profile data and reload; real per-view engine cache bypass.
- **Chose:** true engine cache bypass at unchanged requested URL and same owned profile; ordinary Reload remains separate; unavailable remains honest. No destructive cache/storage workaround or completion inference.
- **Why:** source browser.md distinguishes Reload/Hard Reload; title explicitly forbids substitutes; native storage clear completion is independently unavailable.
- **Evidence:** read-only external browser.md:22,29-30,218; packages/ui/src/native-browser.ts:836-843; sa-browser-pane D15-D17.
- **Reversibility:** medium.
- **Confidence:** high.
- **Revisit if:** a documented supported SDK supplies a faithful cache-bypassing operation.
- **Source:** locked by browser.md and sa-browser-pane D15-D17

## D5: Native failure state must come from actual navigation failure
- **Question:** Loading/error/recovery gray areas: source of failure, address retention, retry, TLS, cancellation and stale events?
- **Options:** loading timeout or missing success heuristic; command exception as network failure; actual native failure event bound to current request.
- **Chose:** actual native failure only; retain requested URL; stop loading on that event; explicit single retry; do not misclassify HTTP error responses, user cancellation, supersession or late disposed events. Keep TLS validation and existing ownership guards.
- **Why:** a guest or timeout cannot authoritatively diagnose native DNS/TLS failure, and an error document must not replace the retry target. No global certificate override or automatic mutation replay.
- **Evidence:** browser.md:431; packages/protocol/src/native-browser.ts:9-16; packages/ui/src/native-browser.ts:567-584; logic HC2/HC3.
- **Reversibility:** medium.
- **Confidence:** high.
- **Revisit if:** the supported failure contract cannot identify current navigation; then fail closed, not guess.
- **Source:** locked by browser.md and sa-browser-pane D4/D17

## D6: Latest published SDK does not unblock either native core flow
- **Question:** Does an available supported release or extension path resolve the known pinned limitation?
- **Options:** keep an unverified historical blocker; inspect only TS declarations; execute public factory audit and inspect latest public/native source plus complete release delta.
- **Chose:** re-evaluate 2.0.4 pin against registry latest2.0.5 and its real macOS implementation. Block both Native flows: public tag has reload() only; runtime public factory names contain no navigation failure; macOS still invokes ordinary reload and lacks provisional/committed failure delegates.
- **Why:** all six audited sources contain no reloadFromOrigin/ReloadIgnoreCache/ignoreCache/reloadIgnoring hook. Full136-file/52-commit comparison has no non-test public main-SDK/browser/preload changes. Upgrading the pin alone does not supply missing primitives.
- **Evidence:** https://registry.npmjs.org/electrobun/latest ; https://github.com/blackboardsh/electrobun/compare/v2.0.4...v2.0.5 ; https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/browser/webviewtag.ts ; https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/sdks/main/events/webviewEvents.ts ; https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/native/macos/nativeWrapper.mm#L3346-L3348 ; capability audit receipt retained beside iteration notes.
- **Reversibility:** easy when upstream adds APIs; medium for an explicitly approved native fork.
- **Confidence:** high for inspected supported release surfaces; no assertion about unreleased/private SDK code.
- **Revisit if:** supported native cache-bypass operation and actual navigation failure callback with identity/error detail become available.
- **Source:** assumed — autonomous

## D7: Block the whole item without clearing retained acceptance or fabricating a landing
- **Question:** Can an unrelated reachable acceptance campaign stand in for the missing Native core?
- **Options:** partial landing labelled complete; split another follow-up; preserve all work and block at core feasibility.
- **Chose:** block this item, preserving existing code/tests and all D1 ownership. Record exact prerequisite and unexecuted acceptance; add no queue item. No suite, UI campaign, typecheck or product behavior verification is claimed; no source/schema/pin changes require a compiler gate.
- **Why:** required Native cache bypass/error reporting is the core of this follow-up, not an optional flow. Build-first moves unfinished acceptance/debugging to end phase; it does not authorize fake success. A supported upstream API or explicitly authorized durable native patch is the missing prerequisite, not a user prompt in this unattended turn.
- **Evidence:** logic HC1-HC5 and Technical feasibility; current canonical LOOP Blocking an item; sa-browser-pane D23; design-mode D33.
- **Reversibility:** easy (queue item can be re-enabled when prerequisite exists).
- **Confidence:** high.
- **Revisit if:** both required native primitives are supported or operator explicitly changes the item's core.
- **Source:** assumed — autonomous

## D8: Audit isolated sources only and preserve unrelated metadata
- **Question:** Platform/state gray areas: can native probes touch Default profiles or inherited tooling files?
- **Options:** run the real app/profile; treat QUIRKY_HOME as WebKit isolation; disposable source audit and no native window.
- **Chose:** fresh /tmp scratch HOME/QUIRKY_HOME for source/event audit only; no daemon, Chrome, native view, website-data clear or real settings modification. Preserve inherited .serena in stash lane6-inherited-serena-iteration7. Linux/Windows and real native engine evidence remain unclaimed.
- **Why:** native website storage root isolation is not proven; source audit requires none. Inherited files are not this item's changes.
- **Evidence:** capability audit nativeWindowStarted=false; source hashes in receipt; stash command returned saved; sa-browser-pane D7/D15.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** supported storage-root isolation and an authorized native verification phase permit genuine window probes.
- **Source:** deferred: platform

## D9: Unblock the core through the approved Electrobun fork patch
- **Question:** D6/D7 blocked the item until a supported SDK or an approved native patch supplied real cache bypass and native load failures. Does the fork satisfy that condition?
- **Options:** stay blocked; patch generated `.hutch/devkit` files; use the approved fork patch `patch/hard-reload-load-failed` on v2.0.5.
- **Chose:** the fork patch. It adds `reloadIgnoringCache()`, `supportsReloadIgnoringCache()`, `supportsLoadFailed()` and a `load-failed` event to BrowserView and `<electrobun-webview>`. macOS WKWebView calls public `reloadFromOrigin` and forwards `didFailProvisionalNavigation`/`didFailNavigation`. Linux, Windows and CEF report unsupported and never fall back to an ordinary reload.
- **Why:** the electrobun-fork spec is the "explicit authorized native-fork/patch contract" D6 named. It uses only public WebKit API, so D3's private-pointer boundary still holds.
- **Evidence:** electrobun `patch/hard-reload-load-failed` commits 6cce30c8 and 31811831; `docs/quirk/specs/2026-10-29-electrobun-fork/logic.md`.
- **Reversibility:** medium (the code keeps the unavailable path; it moves to upstream's API if upstream merges a different shape).
- **Confidence:** high.
- **Revisit if:** upstream ships a differently named API, or the fork release containing the patch isn't cut.
- **Source:** supersedes sa-browser-pane-native-host-controls D6, D7

## D10: Report Hard Reload support per view, in Native state
- **Question:** How does the UI know whether Native Hard Reload is real before offering it?
- **Options:** a capability-wide flag from the platform; always offer it and fail on click; a per-view `hardReloadAvailable` in NativeBrowserState from the tag's support check.
- **Chose:** per view. The adapter asks `supportsReloadIgnoringCache()` after claiming the view; a missing method (stock SDK) or `false` (Linux, Windows) keeps it unavailable. The Browser menu shows Hard Reload only when it's true, and a queued `hardReload` command on an unsupporting view reports the unavailable reason instead of running anything.
- **Why:** support depends on renderer and platform and is only known once a view exists; D4 forbids substituting an ordinary reload.
- **Evidence:** packages/protocol/src/native-browser.ts; packages/ui/src/native-browser.ts `start()` and `hardReload`; plugins/quirky.browser/src/window/BrowserPaneWindow.tsx `nativeRequest`.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a second renderer needs Hard Reload on some views only and the per-view flag proves too late for the keybinding.
- **Source:** locked by sa-browser-pane-native-host-controls D4

## D11: Accept a load failure only for the navigation in flight
- **Question:** HC3: which `load-failed` events may set error state?
- **Options:** any event; events whose URL equals the requested URL only; the requested URL, the latest allowed `will-navigate` target (redirects) or the current URL (reload), reset at each new request.
- **Chose:** the last. Native `will-navigate` details are JSON strings that `eventUrl()` doesn't parse, so the adapter tracks the target separately. `NSURLErrorDomain -999` and `WebKitErrorDomain 102/204` (stop, supersession, download or policy hand-off) aren't errors. An accepted failure keeps the failing URL, ends loading, settles any pending navigation/reload waiter, and ignores the old document's guest state until the next navigation.
- **Why:** HC2 needs redirect failures; HC3 forbids an older request's failure replacing a newer one. Disposal already removes listeners.
- **Evidence:** packages/ui/test/native-browser-dom.test.ts (redirect, late failure, cancellation, disposal); real WKWebView on macOS 26 reported no failure for a replaced or stopped provisional navigation (electrobun `webview_navigation.test.mm`).
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a real failure is ever reported for a URL the adapter didn't see in `will-navigate`.
- **Source:** locked by sa-browser-pane-native-host-controls D5

## D12: Retry navigates to the retained address
- **Question:** The existing error overlay's Retry ran an ordinary reload. Is that the HC2 retry?
- **Options:** keep reload; navigate to the retained requested URL.
- **Chose:** navigate. After a provisional failure WKWebView still holds the previous committed page, so reload would reload the wrong page.
- **Why:** D5 says retry explicitly navigates the requested address once.
- **Evidence:** plugins/quirky.browser/test/pane-window-native-controls.test.tsx.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** never.
- **Source:** locked by sa-browser-pane-native-host-controls D5

## D13: Hold unacknowledged Native state reports while a command is pending
- **Question:** The real-app run showed `browser_tab_changed: pane report must acknowledge the pending command identity` on the first command-driven Native navigation. Fix it here?
- **Options:** leave it to another item; suppress only the about:blank case (existing); skip every unacknowledged report while the pane has a pending command.
- **Chose:** skip them. The command's own report carries the same state moments later.
- **Why:** this item owns base-pane UI acceptance (sa-browser-pane D23), and the race made every queued Native navigation show an error banner. It came from `onNavigation`'s report, not from the load-failed change.
- **Evidence:** in the D14 app run, the banner appeared on the first queued navigation and was gone after the fix (session screenshots, not kept in the repo); test "a Native state change during a pending command waits for that command to report it".
- **Reversibility:** easy.
- **Confidence:** medium (a command the window never runs keeps suppressing intermediate reports, which were rejected before anyway).
- **Revisit if:** a pane shows stale state while a command hangs.
- **Source:** assumed — autonomous

## D14: What was verified, and how
- **Question:** Which acceptance ran, and against what?
- **Options:** n/a (record).
- **Chose:** record below.
- **Why:** the item must not claim more than it showed.
- **Evidence:**
  - Fork: `bash package/scripts/test-macos-webview-navigation.sh` passed against a real WKWebView: `reloadFromOrigin` sent `Cache-Control: no-cache`/`Pragma: no-cache` without validators and showed a fresh response at the same URL, while ordinary reload sent neither; a closed loopback port reported `NSURLErrorDomain -1004` with the requested URL. The contract, symbol, event-bridge and core Zig tests pass, and the new tests fail on stock v2.0.5.
  - Quirky: `bun run typecheck` passed. `bun scripts/suite.ts packages/ui packages/protocol plugins/quirky.browser` ran locally: 64 of 65 files passed. The one failure, `packages/ui/test/exit.e2e.test.ts` SC-59 (quirky.ask waits), also fails on this branch's base commit with no changes, so it isn't from this item.
  - Real app (2026-10-29): `Quirky-dev` built against devkit `2.0.5-quirky.0-hard-reload-load-failed`, fresh QUIRKY_HOME, a new `profile_<32hex>` partition, driven by `quirky browser pane open|navigate|control` and `quirky ui open-view`, with read-only window screenshots. A closed port showed "Page could not load" with `Could not connect to the server. (NSURLErrorDomain -1004)` and kept the address; after the port served, navigating that address again (what Retry sends) loaded it and cleared the error; self-signed HTTPS reported `NSURLErrorDomain -1202` with no override; `pane control --action hardReload` reloaded the same URL and the fixture server logged `cache-control=no-cache pragma=no-cache` while the ordinary reload before it logged neither. The profile's WebKit store, the temp home and every process were removed afterwards.
- **Reversibility:** easy.
- **Confidence:** high for what's listed.
- **Revisit if:** the nightly native run disagrees.
- **Source:** assumed — autonomous

## D15: Not verified, and why
- **Question:** What remains unshown?
- **Options:** n/a (record).
- **Chose:** record below; native click scenarios go to `docs/loop/native/sa-browser-pane-native-host-controls.json` as pending.
- **Why and evidence:**
  - Clicking Hard Reload, Retry and Mod+Shift+R in the real window wasn't done. The `using-apps-like-a-user` native surface binds by bundle id, and three running apps shared `dev.quirky.app` (the user's installed Quirky, another session's dev build and this one), so clicks could have landed in someone else's window. The pane-window tests cover the same buttons in DOM.
  - HC1 with a warm WebKit cache: in both the native test and the app, the ordinary reload refetched without validators, so "ordinary reload shows the cached copy" wasn't observable; the evidence is the request headers and fresh content.
  - Linux and Windows: not built or run. They report unsupported by construction (contract test), which keeps the unavailable UI.
  - HC4 (Watch screencast/input/find/zoom/viewport, base-pane UI scenarios, pane/profile composition) and HC5 (Watch-to-host clipboard) weren't run; their implementation is unchanged and the BLOCKERS entries stay open. The address field kept stale typed text while focused during CLI-driven navigation; that's existing focus behavior, noted for the base-pane UI pass.
  - The Quirky pin stays on 2.0.4 in git; it moves to the fork release holding this patch when the coordinator merges.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a single-instance target for the native driver exists, then run the native scenarios.
- **Source:** deferred: platform

## Progress
Core HC1–HC3 implemented against the fork patch and verified as D14 lists, on branch `zpyoung/eb-sa-browser-pane-native-host-controls`. Waiting on: the fork release that holds `patch/hard-reload-load-failed`, then moving the pin in `apps/desktop/hutch.config.ts` to it and merging. Still open and owned here: the native click scenarios in `docs/loop/native/sa-browser-pane-native-host-controls.json`, HC4 Watch/base-pane/profile acceptance, and the HC5 clipboard entry in BLOCKERS.md.

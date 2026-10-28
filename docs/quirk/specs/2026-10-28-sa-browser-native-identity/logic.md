# Native browser identity

## Status & amendments
Blocked at SDK feasibility on 2026-10-28. Design selected autonomously under docs/loop/LOOP.md; no implementation or effective native identity is claimed.

**Amendments:** None.

## Purpose and conceptual model
Apply the saved Cleaned/Native Browser identity preference to the human Native system-webview through a supported SDK API. Native browsing remains the system webview; owned Chrome/Watch remains a separate engine. The identity value `native` means preserve an engine's actual user agent, not switch engines. Cleaned removes embedding tokens without claiming Chrome compatibility, imported-login success or a fingerprint guarantee.

## Scope and non-goals
Only the native identity flow deferred by sa-browser-profiles-settings D4 and SC7 belongs here. Existing preference persistence, Chrome identity and restart reporting remain unchanged. Cookie import, native profile clearing, localhost routing, remote browsing, native event interception, Chrome identity repairs, CEF substitution and SDK upgrades are excluded. No private FFI, SDK patch or navigator-only JavaScript spoof satisfies this item.

## Decisions locked
- Integration / data mapping: consume the existing clean/native preference; do not introduce a second native identity setting.
- Lifecycle: preserve restart-required behavior; saving a new preference does not mutate a live guest or activate it merely by remounting a pane.
- Engine boundary: Native mode keeps the system webview's actual UA, not Chrome's UA. Cleaned must use a supported native override affecting the actual request UA, not only page JavaScript.
- Error state: keep existing explicit native-unavailable disclosure until a real capability exists. Do not report the setting effective for Native.
- Exception handling: block the whole item because the native UA hook is its sole flow; do not land scaffolding or add a duplicate follow-up.

## Behavior and acceptance
These are completion criteria, not implemented or passing scenarios.

### SC1: Cleaned mode after restart
Before: the saved preference is clean and the supported native identity hook exists. Restart the runtime and open an owned Native pane. After: request headers and page-visible UA agree on the SDK-supported cleaned value, the pane remains a native system webview, and no Chrome process is started for it. Existing sandbox, navigation policy and partition identity remain intact.

### SC2: Native mode and restart boundary
Before: a native runtime started in clean mode. Save native through the existing Browser preference API/CLI and inspect preferences. After: restartRequired remains true and the live guest retains its active mode. After runtime restart, a new Native pane uses the native engine's unmodified UA. Pane hide/show or an owned Chrome helper restart must not activate the pending native preference early.

### SC3: Missing SDK hook
Before: the pinned public native SDK has no UA override. Inspect Browser preferences and Settings. After: nativeSupported remains false with an explicit capability explanation. Saving Chrome identity still has its existing restart semantics; no native success, engine switch or JS-only UA spoof is claimed. The current source already implements this disclosure; it does not complete SC1/SC2.

## Defect and safety coverage
A native implementation must regress request/page-UA disagreement, unintended Chrome/CEF substitution, premature activation on pane remount, and changed partition/sandbox ownership. Browser.md's import and annotation defects remain with their existing owners. Native execution must use only run-owned isolated partitions; HOME/QUIRKY_HOME alone is not proof of OS webview storage isolation.

## Industry insights
No external research swarm under LOOP.md. Source evidence: external browser.md Settings row122; docs/architecture.md:180-203,304-305; sa-browser-profiles-settings D4 and SC7; installed public SDK and Quirky adapter described below. The absence finding is scoped to the current installed/pinned SDK, not every SDK release.

## Deferred ideas
None beyond the blocked core prerequisite. Reopen this same item when a supported native UA API is available; do not manufacture another queue item.

## Glossary
Native pane: the human system-webview renderer. Native identity: preserve the active engine's UA. Cleaned identity: remove embedding tokens from that engine's UA. Watch: the separately owned Chrome page screencast.

## Technical decisions and feasibility
- apps/desktop/hutch.config.ts:6-8 pins Electrobun2.0.4. Installed BrowserViewOptions at apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:44-78 includes renderer and partition but no UA option. init():191-219 forwards no UA to createWebview.
- The installed public BrowserView surface has navigation, script, devtools and zoom operations, not a supported UA setter. A case-insensitive UA-hook search across api/sdks/main and api/preload found only unrelated preload platform-marker/spoofing comments/tests, no native UA control.
- apps/desktop/src/bun/native-browser.ts:3-49 exposes claim, zoom and release; its NativeBrowserViewPort has no UA operation. plugins/quirky.browser/src/preferences/controller.ts:43-57 captures the active preference at registration and explicitly reports nativeSupported:false.
- Supported-hook approach is the only acceptable implementation. Extending Quirky's public adapter alone cannot create the missing native primitive. Private FFI, JavaScript spoofing and Chrome/CEF replacement are rejected.
- Unblock with a supported native UA creation option or setter, documented timing/reset semantics, and a public way to obtain the engine UA if required for cleaning. Re-evaluate the exact released SDK contract before implementation; preserve blank-first ownership/policy admission and the existing restart boundary.
- No new shared contracts, tests, native handoff scenarios or source edits were created because feasibility stopped before implementation. No suite, dogfood or native session was run. Source inspection is not runtime proof of UA behavior.

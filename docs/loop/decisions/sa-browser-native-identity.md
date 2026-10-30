# sa-browser-native-identity decisions

## D1: Apply unattended build-first feasibility rules
- **Question:** How are brainstorming approvals, research and execution handled without a person?
- **Options:** ask a person; skip design; resolve defaults and record the feasibility decision
- **Chose:** autonomous standard-gray-area design, one combined logic/technical spec, one read-only source-capability scout; no research swarm, visual offer, user ask, separate tech spec or review.
- **Why:** current authoritative LOOP.md requires unattended decisions, build-first scope and blocking when an outside capability prevents the core.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; canonical queue wait --lane1 returned this item.
- **Reversibility:** easy (workflow)
- **Confidence:** high
- **Revisit if:** authoritative loop instructions change
- **Source:** locked by docs/loop/LOOP.md

## D2: Own only the deferred human Native identity flow
- **Question:** Who consumes this change, what defines success, and which related flows are excluded?
- **Options:** rebuild all Browser settings; repair Chrome identity; implement the one deferred native identity flow
- **Chose:** human system-webview UA application with existing public preference/API/CLI, verified by real request and page UA after restart; all other Browser flows remain with their current owners.
- **Why:** this queue item is the exact follow-up to dependency D4/SC7; existing Chrome identity is not a substitute.
- **Evidence:** external browser.md:122,248; docs/quirk/specs/2026-10-28-sa-browser-profiles-settings/logic.md:19,44-45; docs/loop/BLOCKERS.md:277.
- **Reversibility:** medium (acceptance scope)
- **Confidence:** high
- **Revisit if:** a binding requirement changes this item's flow
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D3: Reuse the setting and preserve its restart boundary
- **Question:** Integration/data gray areas: separate native preference or shared value; immediate apply or restart; does pane remount count as restart?
- **Options:** introduce a second setting; mutate live guests; consume the existing value only at runtime restart
- **Chose:** shared clean/native preference and existing selected/active/restartRequired distinction; no live-guest mutation or early activation through pane remount/Chrome helper restart.
- **Why:** the title requires preserving restart semantics and dependency SC7 already fixes the construction-time active mode.
- **Evidence:** plugins/quirky.browser/src/preferences/controller.ts:43-57; dependency logic SC7; external browser.md:122.
- **Reversibility:** medium (observable lifecycle)
- **Confidence:** high
- **Revisit if:** a later explicit requirement changes restart scope
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D4: Preserve the native engine and truthful capability state
- **Question:** Engine/error gray areas: what does Native mean; can Chrome/CEF or navigator spoofing satisfy Cleaned; what should unsupported UI claim?
- **Options:** replace the engine; spoof only navigator.userAgent; use a supported actual native UA override or retain unavailable
- **Chose:** Native identity preserves the system-webview engine's actual UA; Cleaned requires a real supported native override; keep nativeSupported:false and explicit disclosure while absent.
- **Why:** locked architecture separates human system webview from agent Chrome. JS-only spoofing cannot establish request-header identity, and capability state is not proof of application.
- **Evidence:** docs/architecture.md:180-203,304-305; native-browser.ts:24-38; preferences/controller.ts:52-56; BrowserSettings.tsx disclosure inspected by capability scout.
- **Reversibility:** hard (architecture)
- **Confidence:** high
- **Revisit if:** the locked architecture is explicitly superseded
- **Source:** locked by docs/architecture.md

## D5: The installed public SDK still lacks the prerequisite
- **Question:** Has a supported native UA creation option or setter become available since the original deferral?
- **Options:** assume the follow-up implies availability; widen Quirky's types without implementation; inspect the actual pinned and installed SDK
- **Chose:** inspect the installed public contract; prerequisite remains absent in Electrobun2.0.4. No new adapter method, patched SDK, private FFI or behavior is added.
- **Why:** BrowserViewOptions includes renderer/partition but no UA field; init forwards no UA. Public view methods expose no UA setter. Searching main/preload SDK sources for user-agent spellings finds only unrelated preload platform/spoofing mentions. Quirky's adapter exposes only claim/zoom/release.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:44-78,150-219,330-365; apps/desktop/src/bun/native-browser.ts:3-49; parent SDK-wide case-insensitive hook search and read-only NativeIdentityFeasibility scout.
- **Reversibility:** easy when supported API exists
- **Confidence:** high for this installed/pinned public SDK; no claim about all versions or private native capabilities
- **Revisit if:** a released supported Native BrowserView UA option/setter is projected and pinned
- **Source:** assumed — autonomous

## D6: Block the sole flow instead of landing a scaffold or duplicate follow-up
- **Question:** Can a reachable independent flow ship while the native hook is missing?
- **Options:** land documentation as completed feature; add a duplicate follow-up; block this item's sole unimplemented flow
- **Chose:** block at technical feasibility; retain reviewable spec/decision branch and queue blocker evidence. No source change, fake fallback, duplicate item, test run or native launch.
- **Why:** Chrome preference and truthful unavailable UI already shipped in the dependency; they are not new work for this item. The only requested end-to-end behavior requires the missing native primitive.
- **Evidence:** item title; dependency logic SC7; D5; docs/loop/LOOP.md Blocking an item.
- **Reversibility:** easy (reopen this item when supported API lands)
- **Confidence:** high
- **Revisit if:** supported UA API provides actual request/page-UA behavior, reset/timing semantics and necessary engine-UA read
- **Source:** assumed — autonomous

## D7: Defer non-macOS native work without inferring parity
- **Question:** Does this capability check establish Linux/Windows support or safe native storage isolation?
- **Options:** infer parity from types; launch native real profiles; record platform limits and retain isolated-state constraints
- **Chose:** macOS-only inspection; Linux/WebKitGTK and Windows/WebView2 UA application, reset and lifecycle verification require later platform work. Any eventual native scenario uses owned partitions, never assumes HOME/QUIRKY_HOME relocates OS native storage.
- **Why:** LOOP.md locks macOS build/test scope; the dependency records native-root isolation as unproved.
- **Evidence:** docs/loop/LOOP.md Platforms/Tests; sa-browser-profiles-settings D21; apps/desktop/.hutch/devkit/.complete macos-arm64 metadata reported by scout.
- **Reversibility:** easy (platform evidence can be added)
- **Confidence:** high for limits, no cross-platform behavior claim
- **Revisit if:** supported native API and isolated platform runners are available
- **Source:** deferred: platform

## D8: Reopen on the fork's supported user-agent API
- **Question:** Does Quirky's Electrobun fork now supply the prerequisite D5 and D6 blocked on?
- **Options:** keep blocking; reopen against the fork's `patch/webview-user-agent` API
- **Chose:** reopen. The fork adds a `userAgent` creation option, `BrowserView.setUserAgent(ua | null): boolean` and `BrowserView.getDefaultUserAgent(): string | null`, implemented with public WebKit API (`WKWebView.customUserAgent`, and `navigator.userAgent` read in `WKContentWorld.defaultClientWorld` from a throwaway non-persistent view).
- **Why:** this is the supported native override, timing/reset semantics and engine-UA read D6's "Revisit if" names. It is public API, not private pointers, a JS-only spoof or an engine swap.
- **Evidence:** fork commit on `patch/webview-user-agent`; `package/src/native/macos/user_agent.h`; its native test checks the actual request header against a local HTTP server.
- **Reversibility:** easy (the pin moves to the fork release that carries the patch)
- **Confidence:** high
- **Revisit if:** upstream merges a different shape of the API and the fork drops the patch
- **Source:** supersedes sa-browser-native-identity D5

## D9: The pane mounts with the daemon's active identity, resolved through the plugin
- **Question:** Where is the Native pane's user agent decided, and how is the restart boundary kept?
- **Options:** have the desktop shell read the setting; add a pane field from the daemon; have the Browser plugin's pane window derive it from `identityGet.active` and pass it to the native capability
- **Chose:** the pane window calls `quirky.browser/identityGet`, and for active `clean` reads `nativeBrowser.defaultUserAgent()` and applies the existing `userAgentForIdentity('clean', …)`. Native passes no user agent, so the system webview keeps its own. The value goes in `NativeBrowserOptions.userAgent`; the trusted shell applies it in `claimNativeBrowserView`, after the navigation policy and while the guest is still on `about:blank`, so the first target request carries it.
- **Why:** `active` is captured when the daemon registers the plugin, so pane hide/show or a Chrome helper restart re-reads the same value and can't apply a pending selection early (spec SC2). Reusing `userAgentForIdentity` keeps one home for what Cleaned means and leaves the Chrome path untouched.
- **Evidence:** `plugins/quirky.browser/src/preferences/native-identity.ts`; `apps/desktop/src/bun/native-browser.ts` claim; `packages/ui/src/native-browser.ts` start().
- **Reversibility:** medium (protocol option and bridge request)
- **Confidence:** high
- **Revisit if:** identity ever needs to change on a live guest, which the spec rules out
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md (D4, SC7)

## D10: A host that can't apply the user agent fails loudly
- **Question:** What happens when a Cleaned user agent is requested but the host can't set it?
- **Options:** ignore it and mount anyway; fail the claim; skip the request when the host has no default user agent
- **Chose:** `defaultUserAgent()` returns null where the host can't read or override (plain web, Linux, Windows, CEF), and the plugin then mounts with no override, which is the engine's own identity. If an override is requested and `setUserAgent` returns false, the claim throws `native browser user agent override is unavailable on this platform` and the pane shows its existing native error with Retry. User agents with control characters, empty or over 1024 characters are rejected in both the renderer capability and the shell.
- **Why:** the spec forbids claiming a native success that didn't happen; a header value with CR/LF must never reach the engine.
- **Evidence:** `packages/protocol/src/native-browser.ts` `isNativeBrowserUserAgent`; desktop and UI tests.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux or Windows get an implementation in the fork
- **Source:** assumed — autonomous

## D11: Native identity support is reported per platform
- **Question:** What does `preferencesState.identity.nativeSupported` report now?
- **Options:** keep false; compute it in the UI; compute it in the daemon from the platform the pinned fork supports
- **Chose:** the daemon reports `process.platform === 'darwin'` through a new `nativeIdentitySupported` preferences adapter. Settings show that the Native pane follows the active identity when supported, and keep the explicit "cannot be changed on this platform" copy otherwise.
- **Why:** the desktop app is the only Native pane host and it pins the fork, whose macOS renderer supports the override and whose other platforms report unsupported. The daemon is on the same machine as that desktop app.
- **Evidence:** `plugins/quirky.browser/src/service.ts`; `BrowserSettings.tsx` NativeIdentityNote; `preferences-api.test.ts`.
- **Reversibility:** easy
- **Confidence:** medium. A web-only client on macOS sees `true` though it has no Native pane; the pane itself still asks its host and falls back to the engine identity.
- **Revisit if:** the daemon gains a way to ask the attached desktop host directly
- **Source:** deferred: platform

## D12: On current macOS WebKit, Cleaned and Native send the same string
- **Question:** What does Cleaned change for WKWebView today?
- **Options:** append Safari tokens; leave it; apply the same token removal as Chrome
- **Chose:** apply the same token removal. WKWebView's default user agent carries no Quirky, Electrobun or Electron token, so the cleaned value equals the default today, but it's still applied through `setUserAgent`, so any token the engine or app adds later is removed.
- **Why:** the spec defines Cleaned as removing embedding tokens "without claiming Chrome compatibility"; adding Safari tokens would claim Safari.
- **Evidence:** `getDefaultUserAgent()` on this Mac (see Verification).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the user wants Cleaned to match Safari's user agent instead
- **Source:** locked by docs/quirk/specs/2026-10-28-sa-browser-native-identity/logic.md

## Progress
2026-10-28 lane1: claimed sa-browser-native-identity, created build/sa-browser-native-identity from build/roadmap, read the feature/locked architecture/dependency decisions, and self-reviewed the combined logic/technical spec against this single flow. Read-only scout plus parent installed-SDK inspection confirm no supported native UA override in pinned Electrobun2.0.4. No product behavior changed, no native webview/profile constructed, no tests/build/dogfood/review run and no runtime UA success claimed. Block at feasibility: commit these records, preserve as blocked/sa-browser-native-identity, detach, and use canonical queue.ts block with the external blocker file. Reopen this same item only once the supported SDK prerequisite is established; then implement SC1/SC2 and verify actual request/page identity with the restart boundary.

2026-10-29 fork session: reopened against the fork's `patch/webview-user-agent` (fork commits 286729d2, 53b61a0e and 564e327f on v2.0.5, landed in unified build 2.0.5-quirky.1) and implemented SC1 and SC2 (D8–D12). Quirky is pinned locally to the private test devkit `2.0.5-quirky.0-webview-user-agent`. That pin change is not committed: the pin moves to the fork release that carries the patch, after review.

## Verification

What was verified, and how:
- **Fork, real WebKit:** `package/scripts/test-macos-user-agent.sh` compiles the shipped `user_agent.h` and drives a real WKWebView against a local HTTP server. The first request carries a user agent set before loading. A change after a load reaches the next request. Clearing it sends exactly the default the probe read. A page that redefines `navigator.userAgent` doesn't change the client-world read. Passed on this Mac.
- **Fork, full SDK path in a real Electrobun app:** a scratch app built on the private devkit, with a hidden, non-activating window, created BrowserViews against a local Bun server.
  - `userAgent` option: the first request carried `Mozilla/5.0 (Macintosh) UAProbe/1`.
  - `setUserAgent(...)` returned true, and the next request carried `UAProbe/2`.
  - `setUserAgent(null)` returned true, `view.userAgent` became null, and the next request carried the engine default.
  - `BrowserView.getDefaultUserAgent()` returned `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)`, identical to the header an unmodified view sent. That string has no app tokens, which is the basis for D12.
- **Fork contract:** `node --test src/shared/user-agent.test.js` fails 4/4 on v2.0.5 and passes 4/4 with the patch. The symbol contract test (16) passes, and `hutch typecheck` is clean.
- **Quirky:** `bun run typecheck` passes, including `apps/desktop` against the fork devkit. All 81 tests pass across the affected files (`bun test`, run locally per file):
  - packages/ui native-browser and native-browser-dom
  - apps/desktop native-browser
  - quirky.browser native-identity, preferences-api, preferences-integration, extras-api, pane-window-find, preferences-window and cookie-import-window

The new tests cover:
- the claim applying the user agent after policy and before any target navigation
- null keeping the engine default
- a host that can't override failing the claim
- CR/LF and length rejection in both the renderer and the shell
- Cleaned and Native derivation
- `active`, not `selected`, deciding the value (the restart boundary)
- a host without an override keeping the engine default
- nativeSupported reported from the adapter

What wasn't verified, and why:
- **The Quirky desktop window itself:** the Native pane only renders in the real Quirky window, and driving it needs a foreground window on a Mac shared with other sessions, which the brief rules out. SC1-native and SC2-native are handed to the nightly run in `docs/loop/native/sa-browser-native-identity.json`. The same SDK calls were exercised end to end in the hidden-window app above.
- **Linux and Windows:** not run. The fork returns unsupported there (D10, D11).
- **The full Quirky suite:** not run. An accidental full local `bun run test` reported 833 of 882 files passing, but its failure list wasn't captured. The visible failures were timeouts in `plugins/quirky.worktree/test/window-navigation.test.ts`, which this item doesn't touch, and they happened while other sessions loaded the Mac.

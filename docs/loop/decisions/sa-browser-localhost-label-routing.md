# sa-browser-localhost-label-routing decisions

Reader: build-loop maintainer — Decision: supply a supported isolated native routing capability before requeuing this item.

## D1: Require real worktree routing in both browser engines
- **Question:** Brainstorming purpose, consumers, primary behavior and success criteria: what does Localhost Worktree Labels mean?
- **Options:** replace address-bar text; implement Chrome only; route labelled local HTTP(S) destinations to the intended worktree server in both engines
- **Chose:** the third option. A human Native pane and an agent Chrome page must reach the intended worktree host/port; a display label alone is not success. The feature-doc setting defaults off.
- **Why:** this item's title explicitly requires native and agent routing, while the parent deliberately declined effective-looking no-op labels.
- **Evidence:** external browser.md Settings row127; docs/roadmap.md:230–244; sa-browser-profiles-settings D4 and logic SC7; authoritative queue item title.
- **Reversibility:** medium (observable address/origin and connection behavior)
- **Confidence:** high
- **Revisit if:** an explicit scope ruling changes the two-engine requirement
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D2: The inspected native public SDK still lacks the prerequisite
- **Question:** Integration gray area, data-mapping: can the supported native interface configure actual host/port routing?
- **Options:** navigation allow/block rules; supported per-view/session proxy or resolver; private native-pointer extension
- **Chose:** require the supported proxy/resolver seam. It is absent from the inspected installed Electrobun2.0.4 and published2.0.5 BrowserView/Session interfaces, so stop before implementation.
- **Why:** BrowserViewOptions has no network-routing option; loadURL forwards the unchanged URL; setNavigationRules only installs allow/block rules. SessionInstance exposes partition, cookies and clearStorageData, not network configuration. The executable AST audit found no proxy/DNS/resolver/interception members in these declarations, and the installed/latest source hashes match for both SDK files. This is a public-interface finding, not proof native routing is globally impossible.
- **Evidence:** apps/desktop/hutch.config.ts:6–8; installed api/sdks/main/core/BrowserView.ts:44–78,276–298 and proc/native.ts:3347–3394; packages/protocol/src/native-browser.ts:13–40; apps/desktop/src/bun/native-browser.ts:3–49; [published release](https://registry.npmjs.org/electrobun/latest); [exact upstream BrowserView](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/sdks/main/core/BrowserView.ts); [exact upstream native SDK](https://github.com/blackboardsh/electrobun/blob/d06abc9edf0b4e55116129cabbfe17bf89e11791/package/src/sdks/main/proc/native.ts).
- **Reversibility:** easy (recheck a supported SDK capability when supplied)
- **Confidence:** high for inspected declarations; no native connection experiment claimed
- **Revisit if:** a supported native hook or approved native-extension prerequisite becomes available
- **Source:** assumed — autonomous

## D3: Do not substitute machine-wide or external routing infrastructure
- **Question:** Integration gray areas, sync-direction, conflict-resolution and auth-method: could a local reverse proxy avoid the native prerequisite?
- **Options:** isolated native proxy plus owned local reverse proxy; machine-wide hosts/resolver/proxy changes; externally resolved wildcard domain; URL/path rewriting to literal loopback
- **Chose:** the isolated native-proxy model is the recommended candidate once supported. Do not change OS DNS/proxy settings, depend on public wildcard DNS, or replace the worktree hostname with a loopback path under this item.
- **Why:** a reverse proxy can select a server after receipt, but does not itself make the labelled hostname resolve or make WKWebView use the proxy. Machine-wide configuration affects unrelated applications and needs a separate lifecycle/permission decision; public DNS adds an external dependency to this local-only feature. A loopback URL/path substitute changes the requested hostname/origin semantics rather than establishing them. None is an existing supported mapping in the current Browser API.
- **Evidence:** sa-browser-profiles-settings logic scope and SC7; apps/desktop/src/bun/native-browser.ts:24–38; packages/protocol/src/native-browser.ts:18–40; RoutingCapabilityScout current-code and supplemental alternative assessment; D2 SDK source audit.
- **Reversibility:** medium (routing scope, origin and ownership contracts)
- **Confidence:** high for current-code absence; alternatives remain architecture choices, not impossibility claims
- **Revisit if:** an explicit ruling authorizes machine-wide/external infrastructure or supplies an isolated resolver
- **Source:** assumed — autonomous

## D4: Block the whole item rather than ship a Chrome-only fragment
- **Question:** Brainstorming scope and approach selection: does agent routing independently satisfy the core item?
- **Options:** ship only Chrome routing and defer Native again; force Chrome into the human pane; formally block this existing two-engine prerequisite item
- **Chose:** block the whole item before specs/contracts. Do not add another follow-up for the same native prerequisite.
- **Why:** this is already the parent's exact deferred flow. Its core is both engines' reachable routing. Chrome launch arguments/CDP are plausible agent extension points, but cannot supply WKWebView networking. Chrome substitution conflicts with the locked system-webview-for-people architecture. Private pointer/FFI patches conflict with the pane's recorded supported-interface boundary.
- **Evidence:** docs/architecture.md:180–203,304–305; sa-browser-pane D5,D9,D13; sa-browser-profiles-settings D4; plugins/quirky.browser/src/runtime/chrome.ts:86–121; D1–D3.
- **Reversibility:** easy (preserved blocked branch can resume after prerequisite)
- **Confidence:** high
- **Revisit if:** real native mapping is supported, or an explicit ruling changes the locked native-extension boundary
- **Source:** locked by docs/loop/decisions/sa-browser-pane.md

## D5: Preserve current unavailable UX and browser isolation
- **Question:** API/Visual gray areas, error-response and error-state: what should callers observe while routing is missing?
- **Options:** save an apparently effective labels setting; add an unavailable placeholder API; preserve the parent's truthful capability state without production changes
- **Chose:** preserve localhostLabels.available=false and its existing reason. No new setting, method, CLI verb, mock route, optimistic label, native guest or profile mutation.
- **Why:** the current API/UI already explains the precise missing mapping; another scaffold would add no reachable behavior. Native storage isolation and engine ownership remain unchanged.
- **Evidence:** plugins/quirky.browser/src/preferences/controller.ts:7–8,47–60; src/preferences-window/BrowserSettings.tsx:198; sa-browser-profiles-settings logic SC7; sa-browser-pane D15–D16.
- **Reversibility:** easy
- **Confidence:** high for unchanged current behavior; not a new UI acceptance claim
- **Revisit if:** the complete mapping implementation is ready
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D6: Record a source-capability investigation, not feature acceptance
- **Question:** Which verification and execution steps are meaningful before the external prerequisite exists?
- **Options:** launch Native against shared storage; run suites/dogfood despite build-first policy; execute a source-only capability audit and stop at the feasibility gate
- **Chose:** executed the throwaway Bun/TypeScript-AST capability audit successfully, fetching exact published SDK sources and enumerating current native/protocol declarations. One read-only scout checked current code and prior decisions. No suite, UI/native dogfood, review round, build, native SDK import, daemon, browser process, system configuration or real profile was exercised. No production code changed. Typecheck/land gates are not claimed; this item is formally blocked instead.
- **Why:** source evidence settles the missing public interface without touching unisolated native state. Current LOOP.md postpones testing/review to the end phase; the audit is feasibility evidence, not an acceptance test or a claim that DNS/native navigation was exercised.
- **Evidence:** lane9 ignored loop folder routing-capability-audit.ts and routing-capability-evidence/audit.json, command exit0; same folder preserves six exact source snapshots and their SHA256 values; RoutingCapabilityScout completed read-only.
- **Reversibility:** easy
- **Confidence:** high for audit outcome; actual routed connectivity remains unimplemented and unverified
- **Revisit if:** native routing prerequisite becomes reachable
- **Source:** locked by docs/loop/LOOP.md

## D7: Retain the macOS-only platform boundary
- **Question:** Should this feasibility investigation promise Linux or Windows routing support?
- **Options:** infer portability from Chrome; inspect macOS and explicitly retain other-platform work
- **Chose:** macOS public native/Chrome interfaces only; Linux WebKitGTK and Windows WebView2 routing integration remain platform work.
- **Why:** the loop fixes macOS as the build/test platform, and native networking capabilities differ across engines.
- **Evidence:** authoritative LOOP.md platforms rule; docs/architecture.md:185–194; D2 audit scope.
- **Reversibility:** easy
- **Confidence:** high for scope; no cross-platform capability claim
- **Revisit if:** those platform lanes become authorized
- **Source:** deferred: platform

## Progress
Stopped at step3, technical-feasibility prerequisite, before logic spec, contracts or implementation. Formally block sa-browser-localhost-label-routing through queue.ts after committing this decision log and renaming the branch blocked/sa-browser-localhost-label-routing. No production changes, tests, UI/native acceptance, or feature completion claimed. Resume only when a supported isolated native hostname/proxy/resolver hook is available, or an explicit ruling authorizes a different native/networking model. Then specify real host/port mapping, ownership/lifetime, hostname collisions, redirects/subresources/WebSocket behavior and errors for both engines; commit contracts and implement under the then-current LOOP.md. Evidence is retained in lane9's ignored loop folder. Never reopen the parent or report display-only labels as working routing.

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

## Progress
2026-10-28 lane1: claimed sa-browser-native-identity, created build/sa-browser-native-identity from build/roadmap, read the feature/locked architecture/dependency decisions, and self-reviewed the combined logic/technical spec against this single flow. Read-only scout plus parent installed-SDK inspection confirm no supported native UA override in pinned Electrobun2.0.4. No product behavior changed, no native webview/profile constructed, no tests/build/dogfood/review run and no runtime UA success claimed. Block at feasibility: commit these records, preserve as blocked/sa-browser-native-identity, detach, and use canonical queue.ts block with the external blocker file. Reopen this same item only once the supported SDK prerequisite is established; then implement SC1/SC2 and verify actual request/page identity with the restart boundary.

# sa-browser-localhost-label-routing decisions

Reader: build-loop maintainer — Decision: review the label routing built on the fork's session proxy (D8–D14) before merging.

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

## D8: Unblock through the fork's per-partition session proxy
- **Question:** D2 and D4 blocked on a missing supported native proxy/resolver seam. Is there one now?
- **Options:** keep blocked; private WebKit/FFI hooks; the Electrobun fork patch `patch/per-view-proxy`
- **Chose:** the fork patch. It adds public `Session.fromPartition(p).setProxy({type, host, port, matchDomains, excludedDomains})` and `Session.supportsProxy`, built on WebKit's public `WKWebsiteDataStore.proxyConfigurations` (macOS 14+). It applies to the partition's live and future data stores and reports unsupported (throws) on Linux, Windows and older macOS.
- **Why:** it's the "isolated native proxy plus owned local reverse proxy" D3 recommended, through a supported public API rather than private pointers, so D4's boundary holds.
- **Evidence:** fork commit on `patch/per-view-proxy` (`package/src/native/macos/nativeWrapper.mm` createDataStoreForPartition/sessionSetProxy, `package/src/sdks/main/proc/sessionProxy.ts`); its test `package/src/sdks/main/__tests__/session-proxy.test.ts`; docs/quirk/specs/2026-10-29-electrobun-fork/logic.md.
- **Reversibility:** medium (the pin must move to the fork release that holds the patch)
- **Confidence:** high
- **Revisit if:** upstream merges a different proxy API, or WebKit drops `proxyConfigurations`
- **Source:** supersedes sa-browser-localhost-label-routing D2, D4, D5 (`localhostLabels.available` is now true, with a real setting)

## D9: Use Orca's label URL shape, served by one daemon-owned label proxy
- **Question:** What address does a label get, and what serves it?
- **Options:** port-less `http://<label>.quirky.localhost/` (needs a proxy in both engines, a Chrome PAC script, and breaks in outside browsers); Orca's `http://<label>.quirky.localhost:<proxyPort>/` behind a Host-routing reverse proxy
- **Chose:** Orca's shape. One `node:http` server on `127.0.0.1:<ephemeral>` in the Browser plugin routes `<label>.quirky.localhost` by Host to the registered loopback origin, rewrites Host to the dev server's, forwards WebSocket upgrades, and answers `CONNECT` only for registered labels by looping the tunnel back into itself.
- **Why:** the feature doc's behavior is Orca's (`src/main/localhost-worktree-label-proxy.ts`). The URL works in both engines and in outside Chromium browsers, and a CONNECT tunnel gets the same routing as a direct request.
- **Evidence:** plugins/quirky.browser/src/localhost-labels/proxy.ts; Orca src/main/localhost-worktree-label-proxy.ts, src/shared/localhost-worktree-labels.ts; browser.md:127
- **Reversibility:** medium (label URLs are user-visible)
- **Confidence:** high
- **Revisit if:** users want label URLs that survive a daemon restart (the proxy port is ephemeral, as in Orca)
- **Source:** locked by browser.md (Orca behavior)

## D10: The Native pane routes only the label domain through the session proxy
- **Question:** How does the Native pane reach the label proxy?
- **Options:** rely on the system resolver mapping `*.localhost` to loopback; set the session proxy for the whole profile; set it for `quirky.localhost` only
- **Chose:** before loading a label URL, the Native adapter calls the desktop RPC `routeNativeBrowserLabels {viewId, owner, port}` with the port from the URL. The main process checks the view's claim and sets `{type: 'http', host: '127.0.0.1', port, matchDomains: ['quirky.localhost']}` on the claimed partition. Every other request in the profile still connects directly.
- **Why:** on this Mac (macOS 26) the system resolver happens to map `*.localhost` to loopback, so the pane would reach the proxy without help, but RFC 6761 only says resolvers SHOULD do that, and older macOS releases may not. The session proxy makes routing independent of it. Scoping by match domain keeps every other request in the profile direct.
- **Evidence:** `dscacheutil -q host -a name feature-x.localhost` returned 127.0.0.1/::1 here; standalone WKWebView probe (D13); apps/desktop/src/bun/native-browser.ts routeLabels; packages/ui/src/native-browser.ts routeLabel
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the Native pane gains per-view rather than per-partition networking
- **Source:** assumed — autonomous

## D11: Agent Chrome reaches labels directly
- **Question:** Does agent Chrome need proxy flags?
- **Options:** `--proxy-server` plus `--proxy-bypass-list=<-loopback>` or a PAC script; `--host-resolver-rules`; nothing
- **Chose:** nothing. Chromium resolves every `*.localhost` name to loopback internally, so the label URL's port reaches the label proxy.
- **Why:** it keeps the agent's launch arguments unchanged, and a fixed proxy would also capture the agent's other traffic. `--host-resolver-rules` would collide with the test harness's own rule.
- **Evidence:** real headless Chrome check in D13; plugins/quirky.browser/src/runtime/chrome.ts:100-111
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Chromium stops treating `*.localhost` as loopback
- **Source:** assumed — autonomous

## D12: Labels come from links a worktree opens, not a port scan
- **Question:** Where do worktree-to-port mappings come from?
- **Options:** port Orca's port scanner; label the loopback links a worktree opens, plus an explicit register method
- **Chose:** `openLink` from a worktree, with Link Routing to Quirky and the setting on, labels an `http://<loopback>:<port>` link and opens the pane at the label. `localhostLabelRegister {url, worktree}` and `localhostLabelList` (CLI `browser localhost-label register|list`) expose the same thing. Only loopback http targets with a port qualify, and the setting `localhostWorktreeLabelsEnabled` is off by default. A label is the worktree folder's slug, `<project>-main` for a git primary checkout, with `-2`, `-3` on collision.
- **Why:** Quirky has no port registry. Orca attributes terminal links to worktrees through its scan, but in Quirky the link already names its worktree. Restricting targets to loopback keeps the proxy from being an open proxy, like Orca's SSRF guard.
- **Evidence:** plugins/quirky.browser/src/preferences/controller.ts; src/localhost-labels/labels.ts; Orca src/main/ipc/localhost-worktree-labels.ts
- **Reversibility:** easy
- **Confidence:** medium (a ports panel would need its own attribution)
- **Revisit if:** Quirky gains a workspace port scanner
- **Source:** deferred: port scanning

## D13: What was verified, and how
- **Question:** What evidence backs the two-engine routing claim?
- **Chose:** these checks, all run on this Mac (macOS 26, Darwin 25.6, arm64):
  - **Fork patch:** `cd package && node scripts/run-bun-test.js src/sdks/main/__tests__/session-proxy.test.ts src/shared/native-symbol-contract.test.ts` passes, and the session-proxy native tests fail against the unpatched wrapper. It compiles the real wrapper section against WebKit and checks real data stores.
  - **Standalone WebKit probe:** a WKWebView on a non-persistent store with `proxyConfigurations` pointed at a Bun proxy loaded a page, a script subresource and a WebSocket for `feature-x.localhost`, all as `CONNECT`. `matchDomains: ["localhost"]` left `example.com` direct, and setting the proxy after the view existed still applied.
  - **Agent Chrome, real engine:** headless Google Chrome, launched with the agent's own flags plus a remote-debugging port and driven over CDP, loaded the label URL from the plugin's `LocalhostLabelProxy`. Title `main-ok sub-ok ws-ok` (document, subresource, WebSocket), and the dev server saw `Host: localhost:<port>` on every request.
  - **Native engine through the patched Electrobun:** a minimal Electrobun app built with `hutch electrobun dev` against devkit `2.0.5-quirky.0-per-view-proxy` and this branch's `allow-label-hosts` postBuild hook ran the plugin's real `LocalhostLabelProxy` and opened native `BrowserView`s in an offscreen window, each in its own `persist:` partition. With `Session.setProxy({type: 'http', host: '127.0.0.1', port: <label proxy>, matchDomains: ['quirky.localhost']})`, `http://feature-a.quirky.localhost:4999/` loaded its page, script subresource and WebSocket. Nothing listens on 4999, so only the session proxy could deliver it, and the label proxy logged `CONNECT feature-a.quirky.localhost:4999`. Quirky's own URL shape (the proxy's port) also arrived as `CONNECT`, and so did a partition whose proxy was set after its view already existed. The same URL in a partition without the proxy never reached the dev server. Before the ATS hook, every label URL failed with WebKit's ATS error (D15).
  - **Quirky tests:** `bun run typecheck` passes against devkit `2.0.5-quirky.0-per-view-proxy`. `bun scripts/suite.ts` over the 11 affected files and packages/protocol passed on the remote test host. The one failure was a profile-menu test that timed out at 5 s under load and passed alone. New tests: test/localhost-labels.test.ts (direct, CONNECT and WebSocket routing; tunnel refusal), preferences-api.test.ts (openLink rewrite, off by default, loopback only), preferences-integration.test.ts (real daemon and CLI: open-link to a labelled pane, list, request through the proxy), apps/desktop/test/native-browser.test.ts (claim check, label-domain-only proxy, unsupported), packages/ui/test/native-browser-dom.test.ts (route before load, refusal with the macOS 14 message).
- **Not verified:** the full Quirky desktop app driven like a user (Settings toggle, then a terminal link click into the Native pane). It opens a visible app window on a shared Mac, so it is handed to the nightly native run in `docs/loop/native/sa-browser-localhost-label-routing.json`. The macOS-before-14 path ran only against fakes, because no older macOS is available.
- **Reversibility:** easy
- **Confidence:** high for the engine checks; the in-app flow is pending
- **Revisit if:** the nightly native scenario fails
- **Source:** assumed — autonomous

## D14: Platform limits
- **Question:** What happens off macOS 14+?
- **Chose:** `Session.supportsProxy` is false on Linux, Windows and older macOS, so `routeNativeBrowserLabels` returns `{routed: false}` and the Native pane refuses label URLs with an error naming the requirement. Agent Chrome routing works on any platform where Chromium runs. Labels are still offered there, and the Settings copy states the Native requirement.
- **Why:** SC-11 of the fork spec: report unsupported, never a no-op.
- **Evidence:** packages/ui/src/native-browser.ts routeLabel; fork wrappers for Linux and Windows
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** WebKitGTK or WebView2 support lands in the fork
- **Source:** deferred: platform

## D15: Add a scoped App Transport Security exception for label hosts
- **Question:** The real Native check showed WKWebView refusing every label URL with "The resource could not be loaded because the App Transport Security policy requires the use of a secure connection". What should change?
- **Options:** allow all plain-http loads (`NSAllowsArbitraryLoadsInWebContent`); switch labels to an ATS-exempt `.local` or single-label host, which loses the secure context `*.localhost` gets and needs Chrome resolver flags; a scoped exception for `quirky.localhost` and its subdomains
- **Chose:** the scoped exception. Electrobun's config has no Info.plist hook, so the desktop app's `postBuild` script `apps/desktop/scripts/allow-label-hosts.ts` merges `NSAppTransportSecurity.NSExceptionDomains["quirky.localhost"] = {NSIncludesSubdomains, NSExceptionAllowsInsecureHTTPLoads}` into each built bundle, keeping existing ATS keys.
- **Why:** ATS exempts `localhost` and IP literals but not `*.localhost`. A bundled standalone WKWebView probe proved it: blocked without the key, and with it a label loads through the proxy while `http://example.com` stays blocked. Labels keep the `*.localhost` secure context, and the exception covers only Quirky's own label domain.
- **Evidence:** bundled probe results (D13); apps/desktop/electrobun.config.ts scripts.postBuild; apps/desktop/test/allow-label-hosts.test.ts; Electrobun docs apis/cli/build-configuration.mdx (hook environment)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Electrobun gains an Info.plist option, which should replace the hook
- **Source:** assumed — autonomous

## D16: Plain-http sites in the Native pane are ATS-blocked (observation)
- **Question:** The D15 investigation found Quirky's bundle declares no ATS keys, so the Native pane can't load any plain-http host except `localhost` and IP literals (for example `http://example.com`). Should this item fix that?
- **Options:** allow all plain-http web content now; leave it and record it
- **Chose:** leave it and record it. It's a browser-wide policy choice outside label routing.
- **Why:** this item owns label hosts only. Opening all plain-http content changes the security posture of the human browser, which needs its own decision.
- **Evidence:** a bundled probe with no ATS keys failed `http://example.com`; built Quirky.app Info.plist files have no NSAppTransportSecurity
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a Browser item decides plain-http policy for the Native pane
- **Source:** deferred: native plain-http policy

## Progress
Implemented on zpyoung/eb-sa-browser-localhost-label-routing against the private fork build `2.0.5-quirky.0-per-view-proxy` (pin change not committed). The pin moves to the fork release that holds `patch/per-view-proxy` when this branch merges. The nightly native run should check the in-app scenarios in docs/loop/native/sa-browser-localhost-label-routing.json.

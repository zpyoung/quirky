# sa-browser-pane-native-events decisions

## D1: Keep this item scoped to the deferred Native page-event flows
- **Question:** Which consumers, purpose, main behavior and success criteria govern this follow-up?
- **Options:** complete the Native flows; duplicate the existing Watch implementation; narrow acceptance to popup notifications.
- **Chose:** Native system-webview dialogs, auth, certificates, controlled downloads, OAuth popups and external-app interception, as the claimed queue title specifies. Human Native browsing stays distinct from opt-in Chrome Watch. Other pane controls, profiles, grant preview and design mode remain with their existing owners.
- **Why:** The parent explicitly assigned these deferred flows to this item; existing Watch behavior cannot fulfill the Native requirement.
- **Evidence:** docs/architecture.md:180-203,304-305; docs/roadmap.md:230-244; docs/quirk/specs/2026-10-28-sa-browser-pane/logic.md:21-24,63-73; docs/loop/decisions/sa-browser-pane.md D5,D12,D23; browser.md:67-70 in the read-only research directory.
- **Reversibility:** hard (engine and acceptance boundary)
- **Confidence:** high
- **Revisit if:** the locked browser architecture is explicitly amended.
- **Source:** locked by docs/architecture.md and docs/loop/decisions/sa-browser-pane.md

## D2: Resolve interaction and error-state gray areas without weakening source semantics
- **Question:** What are the visible prompt interaction, timeout, origin, input and failure defaults?
- **Options:** source-equivalent real event responses; asynchronous replacements for synchronous page functions; native OS dialogs with no scriptable response.
- **Chose:** origin-naming Quirky overlays for real alert/confirm/prompt/beforeunload events; actual accepted/dismissed page results and prompt text; 120-second fail-closed timeout; basic-auth credentials neither persisted nor logged. Preserve stale-page/generation fencing and bounded pending prompts from the parent design.
- **Why:** These are source requirements and parent safety decisions, not discretionary UI defaults. JavaScript replacements cannot preserve the synchronous confirm/prompt contract or cover native auth challenges.
- **Evidence:** browser.md:68; parent logic SC9 and DF2/DF6; apps/desktop/.hutch/devkit/api/preload/webviewTag.ts:12-26,398-407; apps/desktop/.hutch/devkit/api/sdks/main/events/webviewEvents.ts:16-39.
- **Reversibility:** medium (visible interaction contract)
- **Confidence:** high
- **Revisit if:** source behavior or the binding parent decisions change.
- **Source:** locked by browser.md and docs/loop/decisions/sa-browser-pane.md D5

## D3: Keep certificate approval loopback-only and external launches explicitly approved
- **Question:** How should authentication/integration gray areas handle TLS failures and external applications?
- **Options:** global TLS bypass or immediate OS launch; source-equivalent approval with real native responders; display-only prompts with no native effect.
- **Chose:** only loopback/localhost/.localhost certificate exceptions may be approved for the affected page; remote certificate failures cannot proceed. External launches require an origin-naming approval and supported native interception before OS launch. No global TLS bypass or pretend successful response.
- **Why:** A prompt without an actual native challenge responder does not implement the flow; changing global policy would weaken unrelated pages.
- **Evidence:** browser.md:68-69; parent logic SC10-SC11; parent D5; inspected public webview event payloads in webviewEvents.ts:1-39.
- **Reversibility:** hard (security boundary)
- **Confidence:** high
- **Revisit if:** supported scoped native responders become available.
- **Source:** locked by browser.md and docs/loop/decisions/sa-browser-pane.md D5

## D4: Preserve download ownership and OAuth opener/body fidelity
- **Question:** Which data, progress and popup semantics may be approximated?
- **Options:** notifications plus URL-only recreations; a new HTTP fetch detached from the native session; supported native event ownership.
- **Chose:** require native destination reservation before writing, collision-safe Downloads names, real byte/state reporting, per-download cancellation, completed-file open/reveal and shelf dismissal. Require OAuth popup creation that preserves the original opener, named-window and POST-body semantics; ordinary popup budget remains four per two seconds. Neither notification-only shelves nor URL-only OAuth recreations fulfill acceptance.
- **Why:** Notification delivery does not establish control of destination/cancellation; replaying a URL loses native-session request and opener semantics.
- **Evidence:** browser.md:67,69; parent logic SC8/SC11; webviewEvents.ts:4-14,31-38; BrowserView.ts:309-374; parent D5,D12.
- **Reversibility:** medium (native ownership contracts)
- **Confidence:** high
- **Revisit if:** a supported SDK supplies destination/cancel and original popup ownership controls.
- **Source:** locked by browser.md and docs/loop/decisions/sa-browser-pane.md D5

## D5: The selected public SDK still lacks the required response contracts
- **Question:** Has the prerequisite named by the queued item become available?
- **Options:** trust the historical blocker; inspect the selected public SDK; assume private native implementation is callable.
- **Chose:** inspect the current local projection and independent scout evidence. The configured Electrobun version is 2.0.4. Public BrowserView options/methods and webview tag events expose navigation/find/zoom, popup metadata and download notifications, not dialog/auth/certificate responders, native download destination/cancel controls or opener/postbody-preserving popup creation.
- **Why:** This independently confirms the same public API boundary recorded when the parent deferred the item. Generic openFileDialog/showMessageBox utilities create host dialogs; they do not intercept or resolve a guest's pending native challenge. Updater download helpers are not native browser download ownership APIs.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:44-78,150-218,269-374; api/sdks/main/events/webviewEvents.ts:1-39; api/preload/webviewTag.ts:12-26,354-407; api/sdks/main/core/Utils.ts:212-269. Parent direct reads and NativeBrowserHooks read-only scout agree. No claim is made about absence of private native callbacks.
- **Reversibility:** easy (repeat capability assessment after a supported SDK update)
- **Confidence:** high for the inspected public surface
- **Revisit if:** public SDK APIs document and expose the required per-view responders and ownership controls.
- **Source:** assumed — autonomous

## D6: Block the core item rather than ship another deferral or forbidden replacement
- **Question:** Which approach can truthfully complete the item with the current SDK?
- **Options:** supported public native implementation (recommended when hooks exist); private pointer/FFI adapter or Chrome-only replacement; block until supported native hooks exist.
- **Chose:** block at feasibility/design before implementation. No supported implementation of the core event-response flows was established; no independent notification-only slice satisfies a complete named flow. Preserve the existing production behavior and parent tests unchanged. Do not create a duplicate follow-up.
- **Why:** The whole item is the previously deferred native capability gap. Deferring it again would not deliver it; fake JS dialogs, global TLS bypass, private FFI and replacing human Native browsing violate binding constraints. The unresolved prerequisite is outside the public plugin adapter, not missing schema wiring.
- **Evidence:** D1-D5; docs/loop/BLOCKERS.md:266-272; parent D5,D12,D18,D23; docs/loop/LOOP.md Blocking an item and headless feasibility rule.
- **Reversibility:** easy (resume preserved blocked branch after prerequisite changes)
- **Confidence:** high
- **Revisit if:** supported hooks permit faithful Native completion without changing locked decisions.
- **Source:** locked by docs/loop/LOOP.md and docs/loop/decisions/sa-browser-pane.md D5

## D7: Use the unattended build-first workflow, with no implementation or completion claims
- **Question:** How should the skills' user gates, research and verification steps run here?
- **Options:** ask a person; launch research/review/test swarms; follow current authoritative LOOP autonomous/build-first overrides.
- **Chose:** no human asks, visual companion, ADHD offer or external research swarms; standard Visual/API/Data/Integration gray areas resolved from source and locked decisions in D1-D4. Compare supported native implementation, forbidden substitutes and explicit blocking in D6. No logic/tech implementation spec or contracts are committed because feasibility stopped before implementation. No code, tests, native scenarios or runtime behavior changed. No suites, reviews, dogfood or typecheck ran for this documentation-only blocked item.
- **Why:** Current LOOP requires blocking a core flow when its native prerequisite is unavailable, and defers test/review execution until the end phase. Typecheck cannot supply missing native response contracts. Six essential design inputs are established by the queue title, source flows and locked architecture; none require a human answer.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Build first test at the end / Answering a skill's questions / Blocking an item; claimed item from exact-path queue wait --lane 10; D1-D6.
- **Reversibility:** easy (resume normal implementation after prerequisite is supported)
- **Confidence:** high
- **Revisit if:** the item is unblocked by a public SDK capability change.
- **Source:** locked by docs/loop/LOOP.md

## D8: Defer other-platform native capability validation
- **Question:** Are Linux/Windows native event adapters or validation part of this assessment?
- **Options:** imply portability from TypeScript; expand platform investigation; macOS-only evidence.
- **Chose:** macOS-only assessment. Linux/Windows dialog/auth/certificate/download/popup/OS-launch integration and verification remain unvalidated; no portability claim.
- **Why:** LOOP locks this build and test phase to macOS, and native engines have different challenge and ownership APIs.
- **Evidence:** docs/loop/LOOP.md What is already decided, Platforms; docs/architecture.md:185-194.
- **Reversibility:** medium (platform-specific host support)
- **Confidence:** high
- **Revisit if:** other-platform work is authorized and supported public SDK hooks exist.
- **Source:** deferred: platform

## D9: Unblock through the fork's public-WebKit native page requests
- **Question:** Does the prerequisite D5/D6 named now exist, and how does Quirky reach it?
- **Options:** keep blocking; patch Electrobun with private WebKit SPI; patch it with public WKUIDelegate/WKNavigationDelegate/WKDownloadDelegate API.
- **Chose:** the fork branch `patch/webview-native-events` adds `BrowserView.setNativeRequestHandling`, per-kind request events, `respondToNativeRequest`, `cancelDownload` and `popupRequestId` adoption. Every piece uses public API. Quirky pins the private test devkit `2.0.5-quirky.0-webview-native-events` while developing; the pin moves to the release that holds the patch at merge.
- **Why:** this is exactly the unblock D6 described. It needs no private pointers, no TLS bypass, no JS fakes and no Chrome substitution.
- **Evidence:** fork commit `ceba2f98`, `package/src/native/macos/native_requests.h`, `nativeWrapper.mm` `startNativeRequest`/`parkPopupWithConfiguration`/`adoptParkedPopup:`; `docs/quirk/specs/2026-10-29-electrobun-fork/logic.md`.
- **Reversibility:** medium (depends on the patch landing upstream or staying in the fork)
- **Confidence:** high
- **Revisit if:** upstream ships a different API for the same flows; then the host adapter switches to it.
- **Source:** supersedes sa-browser-pane-native-events D6

## D10: The daemon stays the policy owner; the window only relays
- **Question:** Where do Native prompt, download and popup decisions live?
- **Options:** the renderer decides alone; the desktop host decides; the browser plugin's pane service decides as it does for Watch.
- **Chose:** the pane window relays each request with `paneNativeRequest`, a UI-only method. The pane service applies the existing Watch rules: one prompt per page, a 120 s fail-closed deadline, loopback-only certificate proceed, UI-only external approval, collision-safe Downloads, and a popup budget of four per two seconds. It answers with a prompt ID or an immediate answer. Answers return as the `paneNative` event, and expiry and download progress return through `paneNativeUpdate`. The host and `packages/ui` only carry generic page requests.
- **Why:** the parent spec requires browser policy to stay in the plugin and every action to be a schema-declared method with a CLI. Reusing `paneRespond`/`paneDownload` keeps one prompt and shelf model for Watch and Native.
- **Evidence:** `plugins/quirky.browser/src/pane-service.ts` `paneNativeRequest`/`respondNative`/`receiveNativeDownload`; `quirky-plugin.json` `paneNativeRequest`, `paneNativeUpdate`, event `paneNative`; parent logic "browser-specific policy stays in the plugin".
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a non-window client needs to own a Native view.
- **Source:** locked by docs/quirk/specs/2026-10-28-sa-browser-pane/logic.md

## D11: Native sign-in credentials never leave the window
- **Question:** How can `paneRespond` complete a Native basic-auth challenge without the daemon handling the password?
- **Options:** send credentials through the daemon as Watch does; keep them in the window and send the daemon only the decision.
- **Chose:** the overlay keeps the typed credentials in a window-local map keyed by prompt ID and calls `paneRespond` with `accept` only. When the `paneNative` answer arrives, the window adds the credentials and answers the view. The daemon refuses credentials for Native prompts, and accepts a Native sign-in only from the UI role.
- **Why:** the Native answer reaches the window through a broadcast plugin event, and pane state is persisted. Neither may carry a password (D2: credentials neither persisted nor logged). The CLI can still decline.
- **Evidence:** `BrowserPaneWindow.tsx` `nativeCredentialsRef`; `pane-service.ts` `respondNative`; `test/pane-window-native-events.test.tsx`, `test/pane-native-events.test.ts`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a direct, non-broadcast daemon→window channel appears.
- **Source:** assumed — autonomous

## D12: Popups open in an origin-titled host window and keep WebKit defaults inside
- **Question:** What hosts an opener-preserving OAuth popup, and what handles page requests inside it?
- **Options:** a new Quirky pane tab; a small host BrowserWindow with an origin bar; reject named/opener popups.
- **Chose:** the desktop host adopts the parked WebKit page into a sandboxed native `BrowserView`, with the pane's navigation rules, in its own small `BrowserWindow`. The window's title is always the page origin, which serves as the origin bar. `window.close()` closes it, and closing the main window closes its popups. Native page requests inside the popup stay off, so it keeps WebKit's defaults: alert is dismissed, confirm is false, untrusted certificates fail, and downloads go to Downloads.
- **Why:** SC11 asks for "a small native window and origin bar, preserving opener/post body". A pane tab can't host the WebKit-created page, because tags create their own views. Popup-internal prompts have no overlay to show them in, and enabling them would only make the page wait out the timeout.
- **Evidence:** `apps/desktop/src/bun/index.ts` `openPopup`, `native-browser.ts` `popupWindowTitle`; fork test `native_requests.test.mm` (opener, name and POST body survive adoption).
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** OAuth providers need dialogs or downloads inside the popup.
- **Source:** assumed — autonomous

## D13: External-app allow-list for Native
- **Question:** Which schemes may a Native page ask to open?
- **Options:** Watch's `mailto` only; any non-web scheme; a short list of common communication apps.
- **Chose:** `mailto`, `tel`, `sms`, `facetime`, `facetime-audio`, `zoommtg`, `zoomus`, `msteams`, `slack`. Each needs a user gesture (link or form) and approval from the UI overlay. The fork only reports URLs WebKit itself can't load, so `javascript:`, `data:`, `file:` and `about:` can never reach this path.
- **Why:** browser.md flow 9 names meeting-app links. The allow-list keeps "allow-listed safe OS launch" without a general OS-launch path. Watch keeps its own list, which is out of scope here.
- **Evidence:** `pane-service.ts` `NATIVE_EXTERNAL_SCHEMES`; fork `electrobun::isExternalAppURL`.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** users need another scheme; add it to the list.
- **Source:** assumed — autonomous

## D14: Two deadlines, daemon first
- **Question:** Who enforces the 120 s fail-closed timeout across an async FFI boundary?
- **Options:** native only; daemon only; both.
- **Chose:** both. The daemon fails a prompt closed at 120 s and sends the decline. The host gives native requests 125 s, so the native deadline only matters if the renderer or daemon goes away. Removing the view also fails every pending request closed natively.
- **Why:** WebKit requires every completion handler to be called. A page must never stay paused because a renderer died.
- **Evidence:** `apps/desktop/src/bun/native-browser.ts` `NATIVE_REQUEST_TIMEOUT_MS`; fork `NativeRequestRegistry`; tests for both timeout paths.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** prompts need a user-configurable deadline.
- **Source:** locked by sa-browser-pane-native-events D2

## D15: Plugin API 1.1.0 for the optional native-browser members
- **Question:** Does adding Native page requests to `UiPluginContext.nativeBrowser` change the plugin API version?
- **Options:** keep 1.0.0; bump the minor.
- **Chose:** `PLUGIN_API_VERSION` 1.1.0. The members are optional: `pageRequestsAvailable`, `onPageRequest`, `onPageRequestExpired`, `onDownload`, `answer()` and `cancelDownload()`. `quirky.browser` declares `apiVersion` 1.1.0.
- **Why:** docs/plugin-api.md: a backward-compatible author-facing addition is a minor bump, and a plugin declares the earliest release that supplies what it uses.
- **Evidence:** `packages/protocol/src/plugin-api.ts`, `packages/protocol/src/native-browser.ts`, `docs/plugin-api.md`.
- **Reversibility:** easy
- **Confidence:** medium (other fork items may also bump to 1.1.0; merge them as one minor)
- **Revisit if:** another item lands a 1.1.0 with different members first.
- **Source:** locked by docs/plugin-api.md

## D16: beforeunload stays unsupported in Native
- **Question:** Can Native show `beforeunload` prompts?
- **Options:** WebKit SPI `runBeforeUnloadConfirmPanelWithMessage:`; leave it unsupported.
- **Chose:** unsupported. WKWebView's public delegate has no `beforeunload` callback, so Native pages leave without asking, as before.
- **Why:** the item forbids private API.
- **Evidence:** WKUIDelegate public header; fork PR text.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** WebKit makes the callback public.
- **Source:** deferred: beforeunload

## Verification (2026-10-29)

### What passed, and how
- **Fork native test.** `package/scripts/test-macos-native-requests.sh` passes. It compiles `native_requests.test.mm` against Cocoa and WebKit and drives a real WKWebView:
  - An unanswered `confirm()` returns `false` and an unanswered `prompt()` returns `null` at the deadline, and a late answer is rejected.
  - Answers return `true` and Unicode text to the page.
  - A form POST to a named target is parked with its navigation held. After release, the popup sees `window.opener`, `window.name === "oauth"` and the POST body `code=abc`.
  - A discarded popup never loads.
  - It also covers the registry (answer once, wrong view, expire-all on close), credential persistence `None`, numbered download destinations and external-URL detection.
- **Fork contract test.** `package/src/shared/native-requests.test.js` passes 4/4 and fails 4/4 on v2.0.5.
- **Fork builds.** `test-devkit` built `2.0.5-quirky.0-webview-native-events`. The fork package `tsc --noEmit` passes.
- **Unified build.** After resolving the conflicts with the three earlier patches, the merged `nativeWrapper.mm` compiles. Every listed patch's contract tests pass on the merged tree: native-symbol-contract, webview-navigation-contract, eventBridge, session-proxy, drop-source-paths and native-requests.
- **Quirky typecheck.** `bun run typecheck` passes against the private devkit, with the pin `2.0.5-quirky.0-webview-native-events` and `HUTCH_ELECTROBUN_DEVKIT_ROOT` set. The pin change is not committed.
- **Quirky affected tests.** 171 pass and 0 fail across 10 files, run locally with `QUIRKY_TEST_LOCAL=1 bun scripts/suite.ts <files>` because the remote host was unreachable:
  - `apps/desktop/test/native-browser.test.ts`: host relay, owner-only answers, credentials only for auth, absolute download paths, popup hosting and decline, expiry, unsupported SDK.
  - `packages/ui/test/native-browser{,-dom}.test.ts`: routing by view, answer and cancel through the claim, decline without a listener, nothing after dispose.
  - `plugins/quirky.browser/test/pane-native-events.test.ts`, through the real daemon: SC-1 to SC-6, the 120 s deadline (injected 150 ms), navigation declining a pending prompt, and expiry.
  - `plugins/quirky.browser/test/pane-window-native-events.test.tsx`: credentials go from the overlay to the handle and never into a daemon call, the popup refusal message, the Native shelf.
  - The existing `pane.test.ts` (Watch prompts and downloads, including the Chrome runs), `pane-lifecycle`, `pane-window-find`, `plugin-api` and `cli/generated`.

### What wasn't verified, and why
- **The live desktop app.** A user dialog, sign-in, download, popup and app link were not exercised in the running Quirky window. The machine-wide heavy slots stayed held by other sessions' full suites while this item ran. An isolated daemon, fixture pages and the CLI steps were prepared, but the app build never got a slot. The full chain was only proven in parts:
  - WKWebView behavior, by the native test.
  - The SDK FFI path, by the devkit build and typecheck.
  - The host, adapter and daemon, by the tests above.

  What is still unproven end to end in the app: the Zig core relaying the new events, `setNextWebviewPopupRequest` adoption through `BrowserView`, and the popup window's origin title. `docs/loop/native/sa-browser-pane-native-events.json` should list these for the nightly native run.
- **`run-patch-tests` in the unified worktree.** Skipped, because another session's land (`patch/storage-clear-completion`) started right after mine and resets that worktree. The release workflow runs every patch test.
- **Real OS launch for external apps.** Not accepted in any test, to avoid opening Mail or Zoom on a shared Mac. Only the decline and approval-routing paths are tested.
- **Linux and Windows.** Not validated (D8). The fork returns false there, and the Native browser is darwin-only.

## Progress
2026-10-29: implemented on `zpyoung/eb-sa-browser-pane-native-events` against fork patch `patch/webview-native-events`, which is landed in `unified/v2.0.5` as part of 2.0.5-quirky.1. Next steps:
1. Run the native scenarios in the desktop app.
2. When the fork release that holds the patch is tagged, move `apps/desktop/hutch.config.ts` to it.
3. Merge after review.

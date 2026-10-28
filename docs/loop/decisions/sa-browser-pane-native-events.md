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

## Progress
Stopped at feasibility/design on 2026-10-28, lane 10. The current public Electrobun 2.0.4 SDK still lacks the core native page-event response/ownership hooks. No implementation or behavior change, no checks run. Preserve this record on blocked/sa-browser-pane-native-events and register the blocker with the authoritative queue.ts block command. Resume only after supported per-view dialog/auth/certificate responders, native download destination/cancel controls and opener/postbody-preserving popup/external launch interception are available without the forbidden substitutes. Existing Native and Watch implementations/tests remain unchanged.

# sa-browser-native-profile-clear-completion decisions

## D1: Apply the unattended combined-spec workflow without native side effects
- **Question:** Which workflow, research, approval and verification steps apply to this follow-up?
- **Options:** ask a person; start a research swarm and native deletion probe; inspect current public prerequisites and record autonomous choices
- **Chose:** standard gray areas, autonomous recommended defaults, one combined logic/technical spec and one read-only scout; no human asks, visual companion, external research swarm, tests, dogfood or review. No implementation dispatch because the core prerequisite is absent.
- **Why:** authoritative LOOP.md's Build first, test at the end section overrides the normal multi-spec/review/test cadence; its blocking rule applies when the core cannot ship. A real Session deletion probe cannot be made safe by QUIRKY_HOME alone.
- **Evidence:** build/roadmap:docs/loop/LOOP.md, Build first, test at the end and Blocking an item; predecessor sa-browser-profiles-settings D9/D21.
- **Reversibility:** easy (workflow only)
- **Confidence:** high
- **Revisit if:** the item is resumed after a supported public SDK capability is provided
- **Source:** locked by docs/loop/LOOP.md

## D2: Retain the established profile API and destructive-operation semantics
- **Question:** Brainstorming API/Data/Integration gray areas: who consumes this, which flows change, what is success, and how do authentication, errors, cancellation, active use and partial failure behave?
- **Options:** Chrome-only clear reported as full success; new independent profile store/API; complete the existing confirmed clear/remove transaction only with native completion evidence
- **Chose:** Settings and generated CLI use the existing namespaced plugin methods and confirmation/--yes contract. Default clear preserves Default; isolated removal deletes its metadata only after native completion and Chrome maintenance. Active/pending use refuses before mutation; cancellation preserves data. Unavailable completion refuses before native invocation and request claim; uncertain already-claimed completion keeps admission closed. No optimistic toast or partial-success reinterpretation.
- **Why:** browser.md section2.5 requires actual cookies clear/profile removal, not a callback invocation. Existing one-use confirmation and admission guards protect unrelated profiles and late native deletion. Existing UI layout/loading/error style is unchanged.
- **Evidence:** browser.md:80-85; docs/roadmap.md:19-20,31-41; sa-browser-profiles-settings D8/D9/D11; plugins/quirky.browser/src/preferences-lifecycle.ts:21-31,52-87; src/preferences-ui.tsx:19-30.
- **Reversibility:** medium (consumer-visible storage semantics)
- **Confidence:** high
- **Revisit if:** the public native SDK exposes stronger completion/cancellation semantics
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D3: Block instead of equating native invocation with completion
- **Question:** Which implementation approach can satisfy acknowledged native cookies/site-data removal with the current SDK?
- **Options:** await the void method or add a timer; poll visible cookies/DOM storage; use a supported public native completion barrier and otherwise block
- **Chose:** block the whole item. Leave clearPartitionAvailable=false and reject-before-invocation unchanged. Neither timer/await-void nor cookie/DOM polling proves removal of all native website data; no private FFI/Swift bridge or browser-engine substitution.
- **Why:** configured and projected Electrobun 2.0.4 still exposes SessionInstance.clearStorageData(...):void. Its native ABI takes only partition/type cstrings and returns FFIType.void; the inspected public Session object has no acknowledgement, completion event or barrier. No native Session deletion was invoked. This is a public-contract limitation, not a claim about whether private native code internally waits.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/package.json:1; apps/desktop/.hutch/devkit/api/sdks/main/proc/native.ts:1102-1105,3346-3394; packages/ui/src/native-browser.ts:990-1008. Read-only scout NativeStoragePrereqs independently confirmed the public surface.
- **Reversibility:** easy (no product change)
- **Confidence:** high for the inspected public-contract limitation
- **Revisit if:** a supported public deletion completion/error acknowledgement or documented barrier exists in the configured SDK and can be demonstrated safely
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D4: Require separate native root-isolation proof before any Default scenario
- **Question:** Does a temporary QUIRKY_HOME, helper HOME or a Browser partition establish a run-owned native websiteDataStore root?
- **Options:** assume helper env relocates WKWebView storage; clear Default under temporary QUIRKY_HOME; require supported native storage-root configuration and independent proof
- **Chose:** do not open or clear shared Default. Require a supported root configuration before native view creation and proof that the actual native website data resides only in the owned root. Existing nightly scenarios remain unchanged and pending; fresh UUID profiles are the only permitted partition-isolation scenario until root isolation is proven.
- **Why:** public BrowserView options expose partition, not a native storage-root setting; helper-process env isolation is not a documented WKWebView storage contract. The inspected SDK API projection has no websiteDataStore/storageRoot/storagePath/userDataPath surface. Completing isolated-profile removal alone is also impossible without D3's completion prerequisite, so no independently shippable remainder exists.
- **Evidence:** SDK api/sdks/main/core/BrowserView.ts:44-78; plugins/quirky.browser/src/runtime/native.ts:185-246; sa-browser-profiles-settings D21; docs/loop/native/sa-browser-profiles-settings.json:5-7; public SDK API search for websiteDataStore/storageRoot/storagePath/userDataPath.
- **Reversibility:** medium (native runtime/test environment prerequisite)
- **Confidence:** high for absent inspected public configuration; no claim about unprojected private implementation
- **Revisit if:** SDK documents/provides isolated native storage configuration and an owned environment can demonstrate the actual root before touching Default
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D5: Keep this blocker narrow and do not enqueue duplicate work
- **Question:** Should the item land a refusal-only change or enqueue another follow-up for the same unsupported flow?
- **Options:** land unchanged guards as completion; create another completion item; queue-block this existing owner with exact unblock conditions
- **Chose:** preserve all product code/tests/native handoffs, commit this spec/decision record on blocked/sa-browser-native-profile-clear-completion, and let queue.ts block append the blocker/index. No duplicate queue item or invented passing test evidence.
- **Why:** the predecessor already ships the safe refusal; repeating it would not implement any requested flow. The loop requires whole-item blocking when the core cannot ship.
- **Evidence:** docs/loop/BLOCKERS.md:279; packages/ui/src/native-browser.ts:1001-1008; docs/loop/LOOP.md, Blocking an item.
- **Reversibility:** easy (resume this exact item when SDK prerequisites exist)
- **Confidence:** high
- **Revisit if:** both native completion and root-isolation prerequisites become available
- **Source:** assumed — autonomous

## Progress
Stopped at specification feasibility: both public native prerequisites are still missing in the configured/projected Electrobun 2.0.4 SDK. Combined spec is docs/quirk/specs/2026-10-28-sa-browser-native-profile-clear-completion/logic.md. No production/test/native scenario change, real native invocation, test suite, review or dogfood was performed. Next queue action: commit these records, rename branch blocked/sa-browser-native-profile-clear-completion, detach and invoke the authoritative absolute queue.ts block with the external blocker file. Resume implementation only after the SDK provides supported deletion completion and proven native storage-root isolation; preserve existing refusal and stored data meanwhile.

# sa-browser-pane decisions

## D1: Take both queue parts together and answer all design questions autonomously
- **Question:** What scope/approval governs this unattended item?
- **Options:** part1 alone; both queue parts; wait for user
- **Chose:** browser.md section1 items1–10, including page events; no asks, companion, adhd or external research swarms; self-reviewed single markdown logic spec with technical final section.
- **Why:** queue wait lane4 returned both parts; current LOOP.md night mode prescribes autonomous recommended defaults and one spec.
- **Evidence:** queue wait 2026-10-28T00:35Z; docs/roadmap.md:230-244; external read-only browser.md:47-70; git show build/roadmap:docs/loop/LOOP.md night mode.
- **Reversibility:** medium (scope and acceptance)
- **Confidence:** high
- **Revisit if:** locked source contradicts a selected behavior
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve native human browsing and Chrome Watch as separate modes
- **Question:** Which approach meets the locked browser architecture?
- **Options:** Chrome-only screencast for every browser; iframe pages in app; sandboxed native system-webview plus exact-page Chrome screencast
- **Chose:** native plus Watch; never substitute iframe/Chrome for native human browsing silently. Native unavailable in a plain web client is explicit; Watch is opt-in.
- **Why:** native saves unused browser memory, while agents need CDP; iframe cannot embed arbitrary sites. Destroy native view on hiding, keep at most one resident per window; stop Watch subscription on hiding without closing agent page.
- **Evidence:** docs/architecture.md:180-203,290-305; installed BrowserView.ts and preload/webviewTag.ts; BrowserPaneMap survey.
- **Reversibility:** hard (engine/lifetime model)
- **Confidence:** high
- **Revisit if:** public native SDK proves unable to host a secure view
- **Source:** locked by docs/architecture.md

## D3: Adopt source-visible interaction, loading, error and settings defaults
- **Question:** Visual gray areas — layout/information density, interactions, empty/loading/error, defaults?
- **Options:** compact source toolbar; a new dashboard; command-only view
- **Chose:** compact accessible toolbar, New Tab blank state, retained URL on error, source zoom and7 viewport presets, three defaults applied only to new tabs, contextual keybindings and ordinary public hosted tabs.
- **Why:** matches documented user flows without inventing another browser model.
- **Evidence:** external browser.md:9-39,55-70,116-121,156-168; logic SC1–SC6/SC12.
- **Reversibility:** easy (UI presentation)
- **Confidence:** high
- **Revisit if:** real dogfood finds an inaccessible/misleading control
- **Source:** locked by browser.md

## D4: Use schema-declared pane APIs, bounded history and exact target identity
- **Question:** API/CLI/Data/Integration gray areas — auth, error/format, state, persistence, concurrency and targeting?
- **Options:** new transport/private kernel integration; existing plugin methods/events with public native capability; unscoped CDP passthrough
- **Chose:** existing authenticated namespaced RPC and generated CLI; typed pane contract; bounded200 history/8 suggestions/2KiB query; credentials/session tokens stripped before persistence; native pane state distinct from agent restoration; Watch same-worktree exact binding and fresh lease, typed input, no guessed targets/replayed mutations.
- **Why:** every UI action must be scriptable and replaceable; existing agent D19/D21/D23/D26 are binding. Raw CDP and unscoped automation would break ownership.
- **Evidence:** docs/roadmap.md:19-53; sa-browser-agent D19,D21,D23,D26,D37–D43; packages/protocol/src/plugins.ts and ui.ts; shared pane-contract.ts.
- **Reversibility:** medium (public API while unstable)
- **Confidence:** high
- **Revisit if:** acceptance proves state or page identity races
- **Source:** locked by docs/roadmap.md

## D5: Preserve unsupported native page-event flows as explicit SDK follow-ups
- **Question:** How can native prompt/auth/certificate/download/OAuth parity be built on the pinned public SDK?
- **Options:** private pointer/FFI patch; Chrome-only replacement; async JS dialog fake; explicitly defer unsupported flows and ship independently reachable pane behavior
- **Chose:** no private FFI, global TLS bypass or fake dialogs; implement reachable CDP Watch events; queue exact native gaps with their SDK prerequisites before land when confirmed. Artifact publication remains dropped-integration non-goal. OAuth opener/postbody must not be approximated by URL-only creation.
- **Why:** installed SDK exposes native BrowserView navigation/find/zoom and download notifications, not JS dialog/auth/cert response or download-cancel/destination APIs. LOOP.md permits a flow deferral for outside limits when the core ships without it.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:44-218,309-374; preload/webviewTag.ts:12-26,361-402; BrowserPaneMap native survey; external browser.md:67-70.
- **Reversibility:** medium (requires SDK growth)
- **Confidence:** high for inspected public API, not proof of private native absence
- **Revisit if:** supported SDK hooks supply faithful synchronous response/popup/download ownership
- **Source:** deferred: native page-event interception

## D6: Use three disjoint implementation components and Gemini review
- **Question:** Execution preflight and decomposition — which backend pair/partition is reachable?
- **Options:** omp+Opus; omp+Gemini; same-family reviewer; one broad implementer
- **Chose:** omp OpenAI task implementers plus Google Gemini reviewer through pi-watch, with at most3 concurrent isolated components: Native public host capability, Runtime pane/CDP/API, UI contributions/CLI. Shared type files and spec committed first. Parent owns integration and scopes; no worker commits or checks while peers run.
- **Why:** actual pi-watch preflight reports Opus/Sonnet unavailable, Gemini reachable; disjoint component scopes buy real width without simultaneous edits. No successor wave planned, so no checkpoint review.
- **Evidence:** 2026-10-28 preflight pi-watch --check; logic Technical contracts and implementation partition; xd://lsp status: no language servers configured.
- **Reversibility:** easy (next run)
- **Confidence:** high
- **Revisit if:** worker exposes a real shared-file dependency; stop and replan scope rather than widen silently
- **Source:** assumed — autonomous

## D7: Verify macOS-native only by pending nightly scenarios and isolate all process tests
- **Question:** Platform/acceptance gray areas — how to verify native surfaces without foreground access or real home writes?
- **Options:** claim web proves native; foreground native dogfood; honest web Watch dogfood plus native nightly handoff
- **Chose:** web --owner yours --unattended only; pending native view/focus/OS scenarios; temp HOME/QUIRKY_HOME, disabled automatic hooks, mock-keychain owned Chrome and awaited cleanup. Linux/Windows host, downloads and external-launch verification remain deferred.
- **Why:** LOOP.md prohibits native foreground testing in this lane and requires native scenario handoff. Tests must never touch real agent/browser state.
- **Evidence:** docs/loop/LOOP.md Verify; docs/loop/NATIVE.md:60-80; sa-browser-agent D30,D32; m2-editor D22 incident.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native nightly identifies actual runtime failures
- **Source:** deferred: platform

## Progress
Claimed 2026-10-28T00:35Z. Design/self-review complete; source, roadmap/architecture locks and all sa-browser-agent decisions read. Shared native/browser-pane types and single combined spec ready for contract commit. Next:3 isolated implementers, barrier/scope acceptance, real Watch/web smoke, one review/fix batch, required affected/scripts/typecheck, one roadmap catchup/reconciliation and controller land. No implementation claimed verified yet.

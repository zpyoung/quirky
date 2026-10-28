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

## Progress
Blocked at step3, brainstorming/native technical feasibility. One logic spec records complete behavior and retained ownership. No product implementation, tests, compiler gate, review or native/window acceptance ran. Executable source/public-event audit exited0; all workers returned. Next action after supported SDK/native patch prerequisite is satisfied: re-enable this same queue item, inspect new API, implement real HC1-HC3 through existing public seams, retain HC4-HC5 and current native handoffs, and follow the phase then active. Do not treat blocked state as delivered browser parity.

# fix-test-apps-mobile-1028 decisions

## D1: Repair reported mobile failures against current authority contracts
- **Question:** Which behavior and evidence bound the repair?
- **Options:** repin incidental assertions; weaken admission; trace the recorded failures and repair their causes.
- **Chose:** repair exactly apps/mobile failures reported in docs/loop/reports/m7-test-triage.json against current source. Keep per-route grants, exact source/grant binding, verified atomic generation activation, independent content-pinned consents, durable automation provenance and real Browser Watch coordinates. Delete incidental wording/source/default/inventory assertions rather than repinning them.
- **Why:** the queue explicitly assigns these failing files and requires consumer-visible repairs without aliases or bypasses. Existing failures are ground-truth RED evidence; do not rerun merely to confirm them.
- **Evidence:** queue wait --lane 8; triage groups.apps/mobile; starting revision e212abde0d3bec208b52d1d642f4ccf4f1b02c83; sb-mobile-app D2/D6/D9/D10/D11; sb-mobile-app-panels-unbuilt-flows D2/D7/D11.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** current source or an owning repair changes a public contract.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous

## D2: Use disjoint mobile repair slices and preserve inherited metadata
- **Question:** How to execute safely without human decisions?
- **Options:** edit all shared source concurrently; isolate storage, bridge and UI ownership.
- **Chose:** initial read-only mapping, then at most three OpenAI omp task implementers on disjoint scopes. Parent owns integration, checks, decisions and landing. No worker commits or checks mid-flight. Existing untracked .quirk/ and .serena/ remain untouched. No language servers configured. No human asks. Fix items skip feature brainstorming/specs under LOOP.
- **Why:** storage, page admission and mounted UI failures have separate observable contracts; shared files require explicit owner before dispatch.
- **Evidence:** startup status; xd://lsp status; authoritative LOOP fix-items and end-phase sections.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** mapping shows a shared root cause or write scope.
- **Source:** assumed — autonomous

## D3: Repair fixtures without narrowing the production summary contract
- **Question:** Did the reported failures require a new workspace-only summaries restriction?
- **Options:** narrow all callers; supply the required route and authoritative origin projection in the fixture.
- **Chose:** keep production bridge-policy byte-for-byte unchanged. Parent removed an unsolicited worker workspace-only guard and consolidated its duplicate provenance scenario. The retained test supplies the required route, checks missing RPC authority and artifact-route exclusion, retains empty-param and loop-method denial coverage, and drives persisted origin filtering through the UI.
- **Why:** the observed failure came from an omitted route argument; durable origins are a separate producer projection. Neither failure establishes a production admission defect or authorizes changing other base routes.
- **Evidence:** MobileFailureMap source report; parent component diff; apps/mobile/src/shell/bridge-policy.ts; apps/mobile/test/pages.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** consumer evidence establishes a summary admission defect.
- **Source:** assumed — autonomous

## D4: Use actual Chrome placement and coordinate overlapping ownership
- **Question:** How to handle real Watch tests on the remote host and the simultaneous broader sweep?
- **Options:** skip/fake Watch; install a new runtime remotely; use the existing macOS runner placement.
- **Chose:** place the real Chrome-dependent session-tabs test file on the canonical macOS runner list without skipping any cases. Lane8 owns the six assigned app test files; lane7 m7-sweep-browser-mobile retains PhoneLinks production, mobile-plugin repairs and their markers. Published this ownership through the exact live terminal handle; receipt proves input acceptance only.
- **Why:** the triage error explicitly says no Chrome/Chromium on the remote host. Existing Browser tests use the same owned macOS harness. Lane7 D6 names the same failure set, so uncoordinated repairs would duplicate work.
- **Evidence:** scripts/test-on-macos.txt; triage mobile Watch error; build/m7-sweep-browser-mobile D6; Orca terminal send request b0c77919-eb49-4434-b98d-ce43c139fefa accepted true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical runner gains a supported isolated Chrome environment elsewhere.
- **Source:** assumed — autonomous; deferred: platform

## D5: Prefer a verified cross-family review fallback
- **Question:** Which reviewer is reachable on this omp lane?
- **Options:** preferred Opus; available Gemini; same-family fallback.
- **Chose:** OpenAI omp implementers and Gemini google/gemini-3.1-pro-preview:high reviewer. One final promote/refute review round through correctness, contract and security lenses, with a single accepted-finding repair batch as LOOP specifies.
- **Why:** actual Opus probe failed with no authenticated/shipping model; Gemini probe succeeded. No model availability inferred from the malformed multi-alias attempt or aborted Eval.
- **Evidence:** pi-watch --check opus exit5; pi-watch --check gemini exit0; authoritative LOOP end-phase review rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the real reviewer dispatch fails.
- **Source:** assumed — autonomous

## D6: Keep real daemon primitives when mounting its mobile UI in Happy DOM
- **Question:** Why did the Mac Watch scenario fail after runner placement was corrected?
- **Options:** weaken Browser authentication or mock scrolling; repair the mixed DOM/daemon test fixture.
- **Chose:** supply the actual CLI plugin dependency in the shared Browser harness; use the existing Browser test outer 90-second process lifecycle budget without changing the 15-second UI condition deadline; preserve native transport/HTTP/abort/timer globals around DOM registration; let Happy DOM decode/load the real JPEG once; populate its incomplete WheelEvent's standard client coordinates against an offset, half-size displayed image.
- **Why:** successive diagnostics established separate fixture defects. Missing quirky.cli rejected worktree activation. The default 5-second outer budget interrupted owned Chrome startup. The identical plain-Bun Watch operation passed in 4.15 seconds while Happy DOM failed CDP attachment. Restoring WebSocket advanced to Bun.serve rejecting Happy DOM's Response class; restoring native primitives advanced to real Tall page/2616px content. Instrumentation then showed x/y NaN because Happy DOM WheelEvent extends UIEvent and discards MouseEvent coordinates, plus a stale duplicate ACK caused by manually firing a load Happy DOM already fires for data URLs. No evidence called for a production change.
- **Evidence:** actual Watch failures captured at artifact38/54/60/62/64; plain runtime artifact56; plugins/quirky.browser/test/design-ui.test.tsx:9–15; node_modules Happy DOM WheelEvent.js:1–24 and HTMLImageElement.js:362–377; apps/mobile/test/session-tabs.test.tsx.
- **Reversibility:** easy
- **Confidence:** high for observed diagnostic boundaries; final acceptance receipt follows separately
- **Revisit if:** real browser or device events reproduce the failure outside the simulator.
- **Source:** assumed — autonomous

## D7: Preserve exact source ownership when prerequisite work races
- **Question:** Does the shared Browser fixture dependency correction duplicate the broader sweep?
- **Options:** merge unrelated sweep work; diverge on dependency policy; retain the identical one-line prerequisite and share receipts.
- **Chose:** lane7 published d34de2be immediately before receiving lane8's take-ownership message; lane8 e1a4f78b independently contains the same quirky.cli inclusion. Both lanes acknowledged the race and stopped competing harness edits. Publicized lane8 commits rather than copying foreign uncommitted source. Lane7 owns production PhoneLinks, Browser fixes and shell resource cleanup; lane8 owns these app fixtures and the existing Watch case.
- **Why:** adding the real declared dependency repairs admission without a fake API, dependency bypass or duplicate product implementation. Array discovery order does not alter the plugin set.
- **Evidence:** /tmp/quirky-lane7-mobile-repair-coordination.md; canonical m7-sweep-browser-mobile decisions; accepted terminal messages and both scoped commits.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** integration reports an actual differing fixture contract.
- **Source:** assumed — autonomous

## Progress
Claimed this iteration's sole item on build/fix-test-apps-mobile-1028. Read authoritative LOOP and recorded triage evidence; source mapping in progress. No source edits or checks run yet.

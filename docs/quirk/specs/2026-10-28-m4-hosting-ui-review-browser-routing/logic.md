# Review and stack browser routing

## Status & amendments
Approved autonomously, 2026-10-28. Current build/roadmap LOOP.md requires one self-reviewed logic spec with technical decisions, no separate tech spec/review, tests written but not run, and typecheck before landing.

## Purpose and conceptual model
A review header or stack member opens its actual HTTP(S) URL in the originating workspace. Browser owns the Link Routing setting and per-click alternate destination. Reviews adapts visible gestures into that existing public API, never invents a forge URL from a stack ID or substitutes the globally active workspace.

## Scope and non-goals
Own the Checks PR-number header, Checks stack-node buttons and detail-page Open on host header. The shared Browser route already landed in m7-sweep-hosting; retain it and close the visible-control and modifier gaps. Other provider implementations, task/issue/Project controls, unrelated check/comment actions, Browser engine/profile behavior and terminal/editor routing are unchanged. Native delivery is handed off, not inferred from daemon state.

## Decisions locked and key rationale
- Interaction: plain activation follows Link Routing. On macOS only Shift+Cmd is the alternate chord; Ctrl+Shift alone is not. Use the public application's CHORD_PLATFORM, not navigator.platform. Keyboard activation without the chord follows the normal route.
- Settings: Link Routing off means system, on means in-app. With inversion off the alternate chord always means system; with inversion on it flips either configured destination for that click. Never mutate settings for a gesture.
- Presentation: tooltip names normal and alternate destinations and correct platform chord. Reactively update after canonical Browser setting changes. If settings are unavailable, do not promise a destination; actual routing still belongs to Browser.
- Context/errors: preserve exact source worktree through Review API/window command/Browser API. Existing unsafe-URL, missing/ambiguous source and route-failure refusals remain; no silent external fallback for requested app delivery. Error stays visible in the owning panel or detail toast.
- Architecture: reuse existing Review openLink contract and Browser openLink; no new method, setting, kernel branch, private sibling import or local destination router.

## Behavior and acceptance
All URLs below are owned fixture data, not real forge effects. Tests drive the public daemon API and mounted controls; no suite is run before the end phase under current LOOP policy.

| Scenario | Before and action | Observable after |
|---|---|---|
| SC1 header normal routing | Review #12 belongs to W; Link Routing on; click Checks #12, then detail Open on host | Browser pane has exact #12 URL and W; public workspace view reveals W. No external launch. |
| SC2 stack identity | Stack resource #42 contains PR #7 and #12; click #7 | Exact member #7 URL opens in W, not PR #42 or the currently active unrelated workspace. |
| SC3 system default | Link Routing off; plain header/stack activation | Canonical external opener gets exact URL; no Browser pane is created. |
| SC4 alternate policy | Link Routing on/off; inversion off/on; Shift+Cmd activation on all three controls | Off inversion always system. On inversion flips system to app or app to system. Settings remain unchanged. |
| SC5 platform and keyboard | macOS CHORD_PLATFORM but conflicting navigator.platform; Shift+Ctrl alone, Shift alone, Cmd alone, keyboard Enter | Only Shift+Cmd invokes alternate policy. All others use normal destination. |
| SC6 live hints | Mounted headers/stack; change both canonical Browser settings | Tooltips name current normal/alternate destination and chord without remount. No setting writes or routing side effects from rendering. |
| SC7 route failure | Explicit app destination; pane/worktree unavailable, unsafe credentialed URL, or missing/ambiguous source | Visible error and rejection; no fallback OS launch or unrelated pane/view mutation. Existing API safety cases remain. |

## Defect and safety regressions
DF1: macOS Ctrl is not accidentally treated as Cmd by the detail header. DF2: misleading unconditional 'flips' hint is removed when inversion is disabled. DF3: stack summary resource number is never used as a PR URL. DF4: API acceptance records real pane/worktree identity rather than only echoed arguments. The feature doc's unrelated rerun, merge, Project, stale mutation and annotation defects remain with their existing owners.

## Industry insights
No research swarm under current LOOP. Primary evidence: hosting-ui.md section10 steps2–3; browser.md Settings Link Routing/Hold Shift; public Browser preferences/controller.ts; m4-hosting-ui-reviews D9/D13; m7-sweep-hosting D11; sa-browser-profiles-settings D3/D14/D21.

## Deferred ideas
No unbuilt in-scope flow planned. OS browser/window focus and real system-webview delivery have pending native scenarios with mandatory isolated-root/owned-browser preflight. Linux/Windows execution is deferred: platform; portable chord selection costs little and is retained.

## Glossary
Alternate chord: Shift plus platform Mod. Invert API flag: records that chord, not a forced destination; Browser interprets it under current settings. Stack number: stack resource identity, distinct from each member PR number.

## Technical decisions and shared contracts
- Existing committed API contracts remain unchanged: quirky.reviews/openLink({url:string,worktree?:string,invert?:boolean}) dispatches command:quirky.reviews/open-link; that command calls quirky.browser/openLink({url,worktree,modifier:invert,shift:invert}). No compatibility path or alias.
- Shared UI module within Reviews owns event classification and reactive destination hints only. It reads public getSetting with full setting:quirky.browser/openLinksInApp and setting:quirky.browser/openLinksInAppModifierInverts IDs; subscribes/unsubscribes through public context events. It does not choose or perform a destination.
- One strongly coupled implementation component: new routing presentation module, ChecksPanel.tsx, ReviewPage.tsx, new mounted-control regression file and existing link-routing.test.ts. Same owner for all tests. Parent owns specification/decision/native/usage docs.
- OpenAI task implementation. Reviewer selection/probes/final review skipped under build-first override; no independent-review assurance claimed. No baseline tests, suites, build or dogfood. Parent typecheck is the land gate.
- Acceptance commands retained for end phase: bun test plugins/quirky.reviews/test/review-link-ui.test.tsx; bun test plugins/quirky.reviews/test/link-routing.test.ts. Current gate: bun run typecheck. All daemon/process fixtures use fresh QUIRKY_HOME and owned cleanup; external delivery uses existing safe fixture opener.
- Self-review: all three requested visible controls and both setting dimensions covered; no new API/schema needed, all producer and consumer signatures remain consistent. Native limits are explicit, not fake success.

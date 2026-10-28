# m4-hosting-ui-review-browser-routing decisions

## D1: Reuse the implemented core and finish all three visible controls
- **Question:** What remains after dependencies and the hosting sweep landed?
- **Options:** duplicate routing in Reviews; declare the existing API sufficient; finish Checks header/stack and detail header gestures plus truthful hints.
- **Chose:** finish the three visible controls over unchanged public Review/Browser APIs.
- **Why:** the API already routes exact worktree URLs; visible gesture coverage is absent, detail accepts either Ctrl/Meta and Checks reads navigator.platform. The unconditional flips hint contradicts inversion-off behavior.
- **Evidence:** hosting-ui.md section10 steps2–3; plugins/quirky.reviews/src/checks/ChecksPanel.tsx:935–940,1149,1201; src/detail/ReviewPage.tsx:445; test/link-routing.test.ts; m7-sweep-hosting D11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a documented review control is omitted.
- **Source:** locked by hosting-ui.md and docs/loop/decisions/m7-sweep-hosting.md

## D2: Resolve standard gray areas without a person
- **Question:** Which interaction, error, setting and integration policies apply?
- **Options:** change defaults; add consumer-owned route policy; preserve Browser's canonical settings and fail-closed exact source routing.
- **Chose:** plain follows Link Routing; alternate is Shift+platform Mod; inversion-off forces system and inversion-on flips. Canonical setting changes update destination hints. Browser errors remain visible without fallback; preserve source URL/worktree and scheme/credential validation. Include both Checks and detail review headers. No new provider, permission, setting or destination API.
- **Why:** primary feature docs and binding Browser D3/D14 settle the observable behavior. Existing public getSetting/events support presentation without a second route owner.
- **Evidence:** browser.md Settings rows Link Routing/Hold Shift; sa-browser-profiles-settings D3/D14; reviews/env.ts and ui.tsx; public protocol CHORD_PLATFORM.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Browser changes its canonical gesture contract.
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D3: Follow build-first execution and keep inherited artifacts untouched
- **Question:** How should this unattended implementation run be executed and verified?
- **Options:** interactive skills/full review/test campaign; one combined spec and bounded implementation with typecheck gate.
- **Chose:** no asks, research swarm, separate tech/spec review, backend reviewer probes, suite, build or dogfood; write consumer-visible regression tests first but do not run them. Existing committed public schemas/types are the shared contract; commit this spec before one OpenAI task implementer in an external temporary component worktree. Preserve unrelated untracked .quirk/.serena. Catch up once before typecheck/land.
- **Why:** current authoritative LOOP Build first, test at the end explicitly overrides the normal skill stages. One coupled slice has no real parallel split. Reviewer is not dispatched, not called passing. LSP status returned no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; actual xd://lsp status; initial git status; combined logic specification.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the end-phase items are claimed or the operator changes LOOP policy.
- **Source:** locked by docs/loop/LOOP.md

## D4: Hand off native delivery only after isolation preflight
- **Question:** What can establish real native/system destination and focus safety?
- **Options:** treat API panes as OS proof; open the user's browser or Default native guest; require owned isolated roots/browser and pending native scenarios.
- **Chose:** record pending actual-window scenarios; block execution before any in-app click unless native Default root isolation is proven, and before system launch unless an owned isolated browser/session is configured. Never claim HOME/QUIRKY_HOME alone isolates WKWebView. macOS implementation only; Linux/Windows execution remains deferred.
- **Why:** public in-app routing uses Default, and existing Browser D21 forbids touching that native storage without root proof. Daemon state proves routing, not native rendering or OS launch.
- **Evidence:** sa-browser-profiles-settings D21; Browser preferences/controller.ts:117; docs/loop/NATIVE.md.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public native storage-root isolation is established.
- **Source:** deferred: platform

## Progress
Design and shared existing contracts specified; next commit the specification, dispatch one bounded implementer, then catch up once, typecheck and land. No tests/review/dogfood run under build-first policy.

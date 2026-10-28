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

## D5: Retain the existing route owner after all incoming decisions
- **Question:** Does the single final roadmap catch-up change this assignment?
- **Options:** absorb newly blocked Native flows; preserve the bounded Reviews consumer slice.
- **Chose:** preserve Reviews gesture/hint ownership and existing Browser openLink; no new native/protocol/localhost/profile implementation. Read all 15 incoming logs and retain their public event, exact source and isolated-native boundaries.
- **Why:** the Browser native identity/clear/events/controls/preview/localhost items explicitly lack supported public capabilities and must not be imitated here. No incoming decision conflicts with this consumer-only change.
- **Evidence:** final roadmap merge after a00dd5f0; IncomingReviewRoutingRules read fix-terminal-dock-unfinished-flows-20261027, m2-editor-complete-remaining-flows, m3-vault-parity-completion, m5-automations-dispatch-remote-and-args, m5-loops-ui-visible-stop-close-review, m6-heimdall-host-power, m7-sweep-orchestration, six sa-browser native/localhost logs and sb-mobile-app-panels/install-links.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public Browser contract changes during an actual landing-conflict recovery.
- **Source:** assumed — autonomous

## D6: Separate the typecheck gate and isolated module smoke from acceptance
- **Question:** What verification is actually current?
- **Options:** imply the written regressions passed; retain exact bounded evidence.
- **Chose:** permanent mounted-control/daemon acceptance tests are written but NOT RUN; no build, suite, dogfood or review. First typecheck found missing isRecord import in the new fixture; added the existing guard import, removed subscription-count wiring assertions, and required hints to change visibly after settings changes. Second bun run typecheck passed root and mobile. A disposable happy-dom presentation smoke mounted the actual shared routing hook, exercised live hint changes and five click classifications, then unmounted; no daemon, OS opener or native guest started.
- **Why:** typecheck is the current controller gate, not runtime/OS assurance. The isolated smoke is a bounded changed-module execution, not full control/daemon acceptance or visual proof. Its initial dependency-resolution failure used root package scope; the corrected Reviews package-scoped resolver completed successfully without product changes.
- **Evidence:** typecheck exit0/22.84s including mobile; /tmp/quirky-l8-review-routing-smoke.ts output: Shift+Cmd true; Shift+Ctrl, Shift-only, Cmd-only and keyboard false; hint changed from Quirky/system to system/Quirky. Component HEAD be31687e stayed unchanged, exactly four scoped source/test files integrated as a00dd5f0; component worktree removed.
- **Reversibility:** easy
- **Confidence:** high for the observed gate/module behavior; full acceptance and native effects unverified
- **Revisit if:** end-phase acceptance or native handoff finds a defect.
- **Source:** assumed — autonomous

## Progress
Implementation complete and bounded evidence recorded. One final roadmap catch-up done; all 15 incoming decision logs read without a consumer-routing conflict. Root/mobile typecheck passed; permanent acceptance unrun, native scenarios pending, no review/dogfood/build claim. No unbuilt in-scope flow or follow-up added. Commit, detach and run authoritative queue.ts land, then await its actual receipt in this turn.

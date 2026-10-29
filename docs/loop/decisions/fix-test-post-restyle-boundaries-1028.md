# fix-test-post-restyle-boundaries-1028 decisions

## D1: Consume current integration and preserve the exact uncovered boundary scope
- **Question:** How should the historical eight-file failure packet be repaired after intervening lands?
- **Options:** replay every historical fix; diagnose the current integration and reuse already-landed repairs.
- **Chose:** Create the item branch from current build/roadmap, run the exact eight files through the canonical remote suite, and split investigation into three exclusive daemon, shared-fields/Ask and Notifications scopes. Parent owns checks, shared contracts and landing. No worker checks or commits.
- **Why:** The broad snapshot predates later lands. The item explicitly prohibits duplicate repairs, timeout increases, aliases, suppressions and inference about lock load.
- **Evidence:** queue item title; fix-test-orchestration-1028 D17–D18; current queue wait lane10; initial eight-file canonical run.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current reproduction identifies a cross-slice production contract.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve public identities and consumer-visible assertions
- **Question:** What may change when restyled fields invalidate old selectors or expected copy?
- **Options:** repin markup, wording and defaults; retain public API/UI behavior with accessible controls and exact state transitions.
- **Chose:** Keep current shared components and public caller/connection identities. Remove incidental wording/source/default/inventory mirrors, not their consumer-visible invariants. No deadline changes. Every spawned runtime uses fresh private HOME and QUIRKY_HOME with owned cleanup.
- **Why:** These requirements are explicit in the claim and bind all slices. No human decision is needed.
- **Evidence:** queue title; end-phase Fix items instructions; named daemon lock, native field value, Ask and Notifications acceptance cases.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a current failing consumer case demonstrates a production defect rather than stale test assumptions.
- **Source:** assumed — autonomous

## D3: Diagnose the current failures rather than treating historical results as current defects
- **Question:** Which named historical failures remain after earlier lanes landed?
- **Options:** repair all eight files again; act on the exact current canonical result.
- **Chose:** Initial canonical eight-file run: three passed and five failed, exit1 in33.15s. Both Notifications files and daemon lock passed. Notifications stays unchanged: a0d3ac78 already migrated sound controls to associated labels and synchronized loop cancellation on the matching public pending Ask. No duplicate repair or new follow-up.
- **Why:** The remaining current reds are daemon supported-icon/unknown-field expectations, activity hidden-body setup, shared HappyDOM FormData, Ask presentation mirrors and a non-tool fake panel fixture.
- **Evidence:** canonical run1793238305690-70351; initial full output preserved with this item's private evidence; fix-test-notifications-1028; worker BoundaryNotifications source trace.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final caught-up owning suites reproduce one of the previously closed cases.
- **Source:** assumed — autonomous

## D4: Keep native form behavior and repair the DOM-emulator assertion
- **Question:** Does the disabled textarea's appearance in HappyDOM FormData prove a shared component defect?
- **Options:** alter production props or polyfill form collection; verify the actual browser then assert supported native-control state in the unit fixture.
- **Chose:** Compile the actual TextArea and SelectField into an owned Chromium1223 surface. Initial FormData contains only the exact multiline instructions and selected codex value; disabled is true and omitted. Actual typing and selection produce exact edited multiline instructions and claude. All three labels own their controls, inherited/help/error descriptions resolve and aria-invalid is true. Preserve production code; no manual successful-control shim.
- **Why:** Current production forwards native attributes. The real browser disproves a production disabled-submission bug; the failing unit observation is a DOM-emulator mismatch.
- **Evidence:** actual owned CDP browser observation, native form submit-button readout and screenshot; fields-browser.json beside loop notes; packages/ui/src/design-system/primitives.tsx53–89.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual browser form submits a disabled control or loses the accessible ownership.
- **Source:** assumed — autonomous

## D5: Keep lock behavior and record exact actual process outcomes
- **Question:** What does the historical daemon-lock failure justify changing?
- **Options:** infer load and expand deadlines; preserve the passing current case and observe real isolated processes.
- **Chose:** No lock algorithm/deadline change. Actual fresh private-HOME/QUIRKY_HOME smoke launched three daemon processes, observed exactly two losers exit0 with “a daemon already owns this home; exiting”, verified the sole survivor's exact runtime PID and healthy endpoint, then SIGTERMed it and observed lock removal. Final three exit codes are0. Scope cleanup removed the private home.
- **Why:** The current canonical lock file passed. No current product failure is proven. The first throwaway smoke waited on a different subdirectory than createProcessScope's enforced home and timed out; correcting only that fixture path produced exit0 in2.38s.
- **Evidence:** runtime-proof.json; actual POST_RESTYLE_BOUNDARY_RUNTIME_SMOKE_OK and CLEANED receipts; scripts/test-support/process-scope.ts493–505.
- **Reversibility:** easy
- **Confidence:** high for the exercised run, not a universal race-free claim
- **Revisit if:** exact captured future process outcomes violate the singleton/zero-exit invariant.
- **Source:** assumed — autonomous

## D6: Exercise activity body transitions through the existing public tool API
- **Question:** Is an installed activity contribution automatically a shown body?
- **Options:** restore the old assumption; open the registered tool before claiming its body is mounted.
- **Chose:** Preserve catalog ownership and initial hidden state, explicitly open the tool, publish the connected window's report, retain null legacy panel, then disable the override and assert restoration of the base owner while its body stays shown.
- **Why:** The current tool layout intentionally separates installed contributions from open bodies. Actual isolated daemon smoke exercised hidden→open/report→base-owner restoration without any production change.
- **Evidence:** packages/daemon/src/plugins/layout.ts273–301,466–483; packages/daemon/test/plugins/tool-slots.test.ts317–330; actual runtime-proof.json activity receipt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** tool body reports or override restoration fail after valid public opening.
- **Source:** assumed — autonomous

## D7: Retain Ask semantics without pinning restyled presentation copy
- **Question:** How should the Ask control/result/panel failures be corrected?
- **Options:** restore old child markup or add a title to match expected wording; verify accessible controls, answer summaries and valid panel registration.
- **Chose:** Resolve date and text prompts through associated native labels, keep the fieldset header and actual control behavior, remove optional/aria-label wording mirrors, and keep the terminal answer summary/status/live-region/badge assertions. Supply a real UI module in the other-panel fixture so it contributes an openable tool; preserve the exact other-panel identity assertion.
- **Why:** Restyling separated header and prompt placement; the result fixture overwrote its spec title. Adding a title just to satisfy the stale expected wording would repin incidental copy. A panel declaration without a UI module does not create the public tool that the preservation scenario requires.
- **Evidence:** current Ask UI and panel red cases; plugins/quirky.ask/test/ui.test.ts SC21/Q2 and panel.test.ts SC31; worker scoped handoff.
- **Reversibility:** easy
- **Confidence:** high for the source diagnosis; final canonical verification pending
- **Revisit if:** a valid registered panel is replaced by creating an Ask or a terminal summary omits the actual answer.
- **Source:** assumed — autonomous

## D8: Validate truly unknown metadata and delete the stale override-error wording mirror
- **Question:** Should optional tool icons be rejected to satisfy historical UI-kind tests?
- **Options:** forbid supported icons; repin the new icon error string; exercise an actually unknown field and remove incidental override-message copy.
- **Chose:** Test unknown-field refusal with `extra` while retaining non-string-description rejection. Delete the override test that mirrored the old exact error array for `icon`; keep valid override and title-boundary checks and the existing tool metadata validation regressions.
- **Why:** Tool icons are supported metadata. The first repaired eight-file run passed seven files but still failed this omitted stale override mirror; no production defect was exposed. The deletion follows the item's explicit instruction instead of repinning the replacement numeric-icon error wording.
- **Evidence:** packages/daemon/test/plugins/ui-kinds.test.ts; packages/daemon/test/plugins/tool-slots.test.ts185 onward; canonical run1793239538217-55826 exit1/21.95s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a supported icon is rejected or invalid tool metadata is accepted through the public plugin manifest.
- **Source:** assumed — autonomous

## Progress
Current integration consumed at branch creation. Initial canonical remote eight-file reproduction is running. Three exclusive workers investigate daemon, shared-fields/Ask and Notifications; no worker checks or commits permitted. Parent must receive output before approving behavioral changes, run actual executable/surface smoke and final remote checks/typecheck, catch up build/roadmap once and read incoming decisions, commit/detach/canonical land. Exactly one item this iteration; no global completion/stuck result observed.

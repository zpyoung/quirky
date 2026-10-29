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

## D9: Preserve the seven incoming decision logs and their existing owners
- **Question:** Does the single roadmap catch-up change this test-only repair's authority?
- **Options:** absorb incoming VM/native/provider fixes; preserve their contracts and keep the eight-file boundary.
- **Chose:** Consume all seven incoming logs through every D choice/source and Progress: Accounts, Agents, Ledger, packages-CLI, scripts-profile-timeout, native-notification/signed-host and VM/owner-bound-host-workspaces. Preserve activation-attempt-owned disposers, one ownedIds registration, exact caller/window/saved-runtime/host generation identities, real confirmation/retention, supported shared controls, private homes and all qualified review/native/hardware limits. No conflict with these five test-file changes was found.
- **Why:** Incoming source adds real activation cleanup and owner-bound workspace contracts, not permission to restore obsolete UI assumptions or infer OS notification authority. Current native successor is blocked on SDK callbacks/authorized signing; this item does not claim those flows.
- **Evidence:** sole clean roadmap merge after24996684,68files; complete IncomingBoundaryLogs extraction plus exact long CLI assurance/Progress and VM D13 raw reads; scripts/suite.ts96–121 private HOME/QUIRKY_HOME and cleanup.
- **Reversibility:** medium
- **Confidence:** high for the preserved boundary; broad verification remains pending
- **Revisit if:** the owning-suite or controller result identifies a concrete concurrent contract conflict.
- **Source:** locked by incoming decision logs

## D10: Retain current complete owning-suite proof and bounded actual-surface evidence
- **Question:** Which final checks are actually exercised, and what remains intentionally unchanged?
- **Options:** extrapolate to the whole repository/native UI; report this repair's exact owning boundary.
- **Chose:** Caught-up canonical packages/daemon, packages/ui, quirky.ask, quirky.notifications and scripts passed164/164 remote files, zero failed and flaky:[], exit0/185.05s. Real typecheck prepass passed UI lint/root/mobile/prepared desktop in30.718s. Actual native-field component browser proof and current daemon activity/three-process singleton smoke passed. Production code, public types, docs/changelog, feature specs and native handoffs remain intentionally unchanged: this repair changes fixtures/assertions only and no product flow or API.
- **Why:** The initial current red cases were faithful fixture/presentation/emulator corrections, not demonstrated production defects. Existing Notifications and lock repairs are reused. No full-repository, real provider, OS banner/signing, visual redesign score or all-platform clearance follows.
- **Evidence:** owning-suite.json and fields-browser.json beside notes; runtime-proof.json; review/prepass.json; final named8/8 canonical gate.
- **Reversibility:** easy
- **Confidence:** high for exercised scope
- **Revisit if:** controller landing or a concrete consumer regression contradicts one of these results.
- **Source:** assumed — autonomous

## D11: Reject reviewer context contamination and recover only the invalid review stage
- **Question:** Can the initial mechanical PASS be treated as independent review after the promoter reads author decisions?
- **Options:** accept its empty findings; silently repeat discovery; preserve the failed assurance and enforce a no-tools recovery over the fixed artifact.
- **Chose:** Preserve the initial raw promote/refute and gate/manifests but reject their independence claim. The promoter had only read/search tools yet read this author's decision log despite an explicit prohibition. Retry the failed review context with fresh no-tools promote and refute processes over the identical source-only patch plus staged source excerpts, reusing the successful typecheck prepass/model/resolve. No source change, new discovery scope or code fix batch is inferred.
- **Why:** Structural independence requires withholding author reasoning. A tool prompt alone did not enforce that boundary. The no-tools recovery cannot reach decision logs; any reduced context/reproduction limit must stay explicit. Actual original promote/refute returned[]; zero claims are not evidence that the protocol breach was harmless.
- **Evidence:** promote.0.stderr43 records the prohibited decision-log read; original artifact hash7b7dd8f72f452626872800eff43ecaaf669e0de9322df79d6a0f74f854b494fc and runf6affa5423531318; recover-review.py dispatches pi-watch --no-tools with fresh stage contexts.
- **Reversibility:** easy for unchanged source; original lost independence cannot be retroactively repaired
- **Confidence:** high for detected breach; recovery verdict pending
- **Revisit if:** recovered stages find a supported defect or cannot issue a valid bounded verdict.
- **Source:** assumed — autonomous

## D12: Retain the recovered LOW advisory without restoring incidental error-format coverage
- **Question:** Does recovered F1 require restoring the deleted override-error wording test?
- **Options:** restore a formatting mirror; add redundant base-validator coverage; retain the bounded advisory and explicit user-directed deletion.
- **Chose:** The recovered standard Gemini/google high promote/fresh-refute machine gate reports PASS with0blockers,1LOW advisory,0suppressed,0contested,0limitations,0questions and no excluded/unreviewed paths. Retain F1 in BLOCKERS rather than call it closed. No code fix batch: the claim concerns intentionally removed error-format coverage, not a demonstrated production validation defect; the task expressly requires deleting incidental wording mirrors. Existing shared unknown/type and tool metadata validation tests remain.
- **Why:** Fresh refutation kept the coverage observation but downgraded HIGH to LOW because the underlying validator remains covered. No-tools recovery prevents author-context access but limits review to the staged artifact/source context; it supplies no runtime reproduction. Original contaminated assurance remains rejected. The final canonical164/164 suite, real typecheck and actual component/API/process smokes establish the separate exercised boundary.
- **Evidence:** recovered-promote/refute raw responses, recovered-gate.json and recovered-manifest.json for artifact7b7dd8f72f452626872800eff43ecaaf669e0de9322df79d6a0f74f854b494fc, runf6affa5423531318; BLOCKERS open review findings; owning-suite.json.
- **Reversibility:** easy
- **Confidence:** high for bounded findings/dispositions, not comprehensive review coverage
- **Revisit if:** a concrete override admission bug bypasses the shared validator or another consumer requires a stable error-format contract.
- **Source:** locked by item title's delete-incidental-mirrors requirement

## Progress
Ready for canonical land of exactly this item. Source24996684 and the single roadmap merge retain only five test-file changes; no production behavior, authority, deadline or alias changed. Current owning canonical gate164/164/no flakes185.05s and actual typecheck30.718s pass. Native-field component browser and post-catch-up daemon activity/three-process singleton smokes passed with private-home cleanup. All seven incoming logs consumed. Bounded standard cross-family review recovery passes with one explicitly retained LOW advisory and the original contamination/no-tools limits recorded. All workers/review/check/runtime jobs returned; no owned browser/runtime remains. Commit this receipt and BLOCKERS, detach, run the absolute canonical queue land command and await its actual outcome. Remove only owned scratch after successful landing. No second item or global completion/stuck claim.

# fix-test-reviews-tool-1028 decisions

## D1: Trust the reported red and trace the current public slot contract
- **Question:** Which failure and scope govern this end-phase fix?
- **Options:** rerun the reported failure merely to confirm; extend polling deadlines; investigate the active Checks refresh and fixture boundary
- **Chose:** use the reported initial and isolated retry failures as red evidence and investigate the current public slot contract before changing anything
- **Why:** the queue identifies the exact mounted Checks test and wait at line417; the other five cases pass. Neither a longer deadline nor markup/copy pinning repairs the behavioral boundary.
- **Evidence:** queue item fix-test-reviews-tool-1028; plugins/quirky.reviews/test/review-link-ui.test.tsx:400–482; fix-test-mobile-1028 D12
- **Reversibility:** easy
- **Confidence:** high for reported failure; root cause not yet established
- **Revisit if:** traced runtime evidence identifies a different broken boundary
- **Source:** assumed — autonomous

## D2: Preserve canonical ownership and isolated verification
- **Question:** Should this repair change public tool authority or use real account state?
- **Options:** fake providers or loosen authority; preserve six-slot public semantics and fresh private test homes
- **Chose:** preserve existing plugin IDs, daemon layout authority and public plugin API; every runtime uses private HOME/QUIRKY_HOME and awaited cleanup. No human asks or protected-loop edits.
- **Why:** ui-shell-slots D2/D3/D11 bind tool identity, visibility and persistence. The end phase requires canonical affected suites, scripts and typecheck, plus actual changed-path smoke evidence.
- **Evidence:** docs/loop/decisions/ui-shell-slots.md D2/D3/D11; docs/roadmap.md:13–55; canonical docs/loop/LOOP.md end phase and step6; xd://lsp status returned no configured servers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual contract inconsistency requires a separately recorded decision
- **Source:** locked by docs/loop/LOOP.md and ui-shell-slots D2/D3/D11

## D3: Release the outer async act before observing the DOM
- **Question:** Is the fixture's timeout caused by hidden-document gating or renderer scheduling?
- **Options:** override document visibility; change production polling; release React's async act scope before waiting for its commit
- **Chose:** use the existing settleUi helper followed by waitUntil outside act. Remove two incidental loading/title wording assertions without repinning them.
- **Why:** an owned standalone React19 probe observed defaultVisibility visible, insideAsyncAct loading and afterAsyncAct ready. The harness's async refresh calls nested synchronous act(root.render); the outer scope defers that commit. This isolated mechanism is real but was not the complete production root cause: the first changed canonical run exposes the additional Hook-order failure recorded in D4.
- **Evidence:** actual act-probe.tsx exit0; review-link-ui.test.tsx:234–253,400–479; canonical exact-file run initial+retry5pass/1fail with explicit Hook-order diagnostic
- **Reversibility:** easy
- **Confidence:** high for isolated scheduling; insufficient alone to fix the reported failure
- **Revisit if:** future renderer fixture waits again enclose their required commit
- **Source:** assumed — autonomous

## D4: Keep the PR action-menu hook unconditional across loading transitions
- **Question:** Why does actual provider refresh still fail after the fixture releases React's commit?
- **Options:** suppress the renderer error; special-case initial state; move the existing menu useMemo before all conditional returns
- **Chose:** move the unchanged actionItems useMemo above the no-worktree/loading/no-review returns, preserving memoization and handlers.
- **Why:** actual canonical initial and isolated retry both report ChecksPanel hook37 changing from undefined to useMemo. The loaded-only hook at former1115 follows three early returns; transitioning from initial unbound/loading state to PR12 therefore violates React's hook invariant and blocks rendering. The existing mounted real-daemon regression now reaches and catches that consumer defect.
- **Evidence:** canonical bg1 exit1/44.84seconds; ChecksPanel.tsx former1022–1093,1115–1118; React previous36hooks→next37 diagnostic
- **Reversibility:** easy
- **Confidence:** high; changed-path green verification pending
- **Revisit if:** the current canonical run exposes another actual transition defect
- **Source:** assumed — autonomous

## D5: Reject a rationale-contaminated reviewer dispatch and isolate its replacement
- **Question:** Which cross-family review is actually independent of the author's reasoning?
- **Options:** accept the first empty reply despite its trace; hide the scope breach; discard it and stage source-only context without filesystem tools
- **Chose:** preferred Opus unavailable (exit5); verified Gemini fallback (exit0). Discard the first promote reply because its trace reads this decision log despite an explicit instruction not to. Preserve its raw trace, then restart the same fixed-bar review with the immutable two-file source patch, complete source context and no tools in a scratch cwd. Run a fresh-context refute and deterministic gate; do not claim the discarded empty reply as clearance.
- **Why:** cross-family alone is insufficient once a reviewer reads the author's rationale. No-tools dispatch enforces the intended boundary; bounded source context keeps the small lifecycle patch reviewable without repository exploration.
- **Evidence:** actual bg6 promote trace includes read docs/loop/decisions/fix-test-reviews-tool-1028.md; invalid-rationale-read evidence; resolve run86371b9819fa8d6b and source-only artifactc1c990cf3e028593489e21b06f2d6dfd76e82e82d5039bb225747bd18a294140
- **Reversibility:** easy
- **Confidence:** high for trace and enforced tool boundary; replacement review pending
- **Revisit if:** the replacement cannot adjudicate an actual claim from supplied source
- **Source:** assumed — autonomous

## D6: Report bounded review clearance with its noise, not exhaustive assurance
- **Question:** What did the valid source-only standard review actually establish?
- **Options:** call it a clean universal review; apply an invented active-slot field; retain the bounded verdict and suppression record
- **Chose:** Gemini promote156.53seconds returned one HIGH visibility-contract claim; fresh-context refute14.02seconds rejected it because the cited visibility lines are outside the patch. Deterministic claims/merge/gate/manifest all exit0: PASS, full cross-family independence,0blocking/0advisory/0contested,1suppressed,0limitations/0questions/0excluded/0unreviewed. No accepted findings or fix batch.
- **Why:** the only proposed defect was outside the two-file diff and its recommended tools.active field does not exist: the current public UiToolLayout explicitly defines open. This is a noisy1of1-suppressed review, not evidence of exhaustive correctness. Do not change the working visibility contract to satisfy it.
- **Evidence:** review run86371b9819fa8d6b; actual promote/refute JSON and manifest; packages/protocol/src/tool-slots.ts:19–25; current prepass18files pass/no flakes57.979seconds and full typecheck31.018seconds
- **Reversibility:** easy
- **Confidence:** high for bounded verdict and public schema; no whole-repository assurance
- **Revisit if:** an actual changed-seam regression is observed
- **Source:** assumed — autonomous

## D7: Prove the loaded transition through actual APIs and the built web surface
- **Question:** Which runtime evidence proves the repair without real account state or native claims?
- **Options:** tests alone; fake rendered data; actual private daemon/upstream fixture, public slot actions and built desktop page
- **Chose:** independent mounted production ChecksPanel smoke drives real ui.tool.open/move/replacement/reopen/close and Reviews/Hosting RPCs. Exit0/3.98seconds returns PR12, accepted candidate counts1,1,1,0,1,0 and exactly1checksRefresh. Actual built desktop web goals checks-load and checks-reopen both pass: three guarded visible-control clicks return OBSERVED, real PR12/failing-build row renders, minimize removes it and reopen restores it. Final direct browser inspection also shows PR12 with0pageerrors. All browser/daemon cleanup awaited.
- **Why:** the first scratch scripts incorrectly assumed fresh layout.panel was null; normalize default slots using public ui.tool.close, not a product change. First browser fixture also omitted actual Browser settings provider and rendered blank with getSetting error; record that run as blocked, close its retained owned browser and rerun with the same actual Browser/Editor providers used by bootUi. Corrected run has0findings/0consoleerrors/0networkfailures/0testoverrides and kept_open[]/cleanup_errors[]. The upstream gh fixture is stateful test data; no hosting write or real profile is touched.
- **Evidence:** runtime-smoke.tsx; corrected likeuser run20261029T020346-2bba report.json and obs2–5 PNGs; earlier incomplete fixture run20261029T020118-07a4 retained separately; actual build exit0/18.94seconds; final browser screenshot and error receipt; both successful daemon services exit0
- **Reversibility:** easy
- **Confidence:** high for exercised loading/loaded and slot lifecycle; no real-provider/network/native certification
- **Revisit if:** a real provider or nightly native check reports a failure in this lifecycle
- **Source:** assumed — autonomous; deferred: platform for native effects (unchanged by this patch)

## D8: Close the static plugin boundary and owned-resource inventory
- **Question:** Does moving the menu memo require packaging, API or native-handoff changes?
- **Options:** change unrelated contracts; validate the unchanged boundary and preserve existing handoffs
- **Chose:** static plugin validator returns PASS/0blocking at the changed lifecycle seam, without executing checks. No manifest, API, CLI, import, dependency or native-scenario edits are needed. Preserve built-in public API ownership; all5owned fixture roots and runtime URL/token files are confirmed absent, both successful services exit0, all browser sessions are closed.
- **Why:** the same declared Checks mount and checksUnlink method/CLI remain wired to unchanged handlers. Only hook order and fixture scheduling change. Real smoke and UI evidence already exercise their consumer-visible transition.
- **Evidence:** ValidateReviewsBoundary report; ChecksPanel.tsx:1022–1025,1131; actual cleanup assertion exit0; corrected UI end kept_open[]/cleanup_errors[]; runtime smoke and browser reports retained in lane notes evidence archive
- **Reversibility:** easy
- **Confidence:** high for changed seam and observed cleanup
- **Revisit if:** canonical land reports a concrete integration failure
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Source a1488767 unchanged since current18file Reviews+scripts/typecheck/build checks, actual API/React smoke and2passing actual web goals. Sole planned catch-up changed only queue state; no incoming decisions. Bounded standard review PASS with1suppressed noisy claim, static plugin validation PASS/0blocking; no accepted findings or fix batch. Every implementer/scout/validator/reviewer/check/runtime process returned; all5owned fixture roots and URL/token files confirmed removed, browsers closed. Nonsecret review/proof evidence archived beside lane notes. Next commit this evidence, detach, canonical queue land and await its authoritative result; remove only owned scratch after success and end exactly this item.

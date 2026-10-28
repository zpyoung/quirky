# m3-accounts-remaining-flows decisions

## D1: Complete existing public flows, not a parallel Accounts implementation
- **Question:** What design and boundary applies to the completion item?
- **Options:** rewrite account service; extend existing plugin and finish named acceptance; mounted-only verification
- **Chose:** existing public plugin/service/UI, real daemon/API and guarded built-web acceptance, fixes only for evidenced defects
- **Why:** queue title explicitly describes deferred user-surface acceptance; core services and native conversation ownership already exist. Original m3-accounts D1–35 and AC1–18 remain binding.
- **Evidence:** external accounts.md; docs/loop/BLOCKERS.md:123-145; AccountsFlowMap and AccountsUiMap source surveys
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual flow proves a required public seam absent
- **Source:** locked by docs/loop/LOOP.md and queue item

## D2: Resolve every unattended gray area with feature requirements and conservative defaults
- **Question:** How to resolve layout, information density, loading/error states, interactions, auth, idempotency and scope without a person?
- **Options:** wait for questions; documented behavior and recommended defaults
- **Chose:** existing status-bar/drill-in/settings; Compact/Used defaults, consumed urgency, durable preferences; truthful old-session identity; official CLI native login; captured scope and explicit destructive confirmation; generic secret-free errors; sequential/debounced inactive fetch
- **Why:** each maps to accounts.md and original logic AC2–AC18. No new visual language, OAuth implementation, retries or abstraction. Purpose/consumers/success/constraints/scope/main behavior are all established by the queue and feature doc. Markdown spec accepted autonomously; no research swarm/visual companion/ADHD under night rules.
- **Evidence:** docs/quirk/specs/2026-10-28-m3-accounts-remaining-flows/logic.md; accounts.md Read usage, Switching state machine, Edge cases
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** source and executed flow disagree
- **Source:** locked by accounts.md and docs/loop/LOOP.md

## D3: Preserve inherited metadata and use isolated component worktrees
- **Question:** Which preflight state and execution pairing is safe?
- **Options:** stash unrelated .serena; stage it; leave untouched and isolate all implementers
- **Chose:** preserve unrelated untracked .serena unchanged; external /tmp component worktrees, fixed committed contracts; omp task implementers (AUTHOR_FAMILY=openai), Gemini independent review fallback
- **Why:** pi-watch --check reports opus/sonnet unavailable, gemini google/gemini-3.1-pro-preview:high available; codex/terra/flash also resolve. Bun1.4.0 available; web doctor ready with playwright-cli0.1.22. xd://lsp status reports no configured servers. Serena initial manual read; no native auth/state access authorized.
- **Evidence:** observed alias preflight and doctor; /tmp/quirky-accounts-lane9.YKzHLj; clean tracked branch at claim
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer fails actual dispatch or tool runtime changes
- **Source:** assumed — autonomous

## D4: Native-only observations remain explicit pending handoffs
- **Question:** Can unattended web/API proof stand in for macOS browser/clipboard/Keychain/OS focus?
- **Options:** falsely infer native completion; perform real user auth; pending native scenario handoff
- **Chose:** pending native scenarios with synthetic-only fixtures; complete reachable web/API behavior without real provider state or foreground control
- **Why:** LOOP explicitly requires native-only handoff and prohibits native/foreground dogfood. Existing m3-accounts native scenarios remain pending; do not claim a run occurred.
- **Evidence:** docs/loop/native/m3-accounts.json; LOOP step6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authorized native runner reports results
- **Source:** locked by docs/loop/LOOP.md

## D5: Preferences do not change account-selection authority
- **Question:** Why did “Don't ask again” invalidate an otherwise current reset or restart choice?
- **Options:** loosen scope comparisons; rebind the captured offer in the renderer; stop advancing the selection revision for preference writes
- **Chose:** preference writes persist and publish without incrementing account-selection authority; real account mutations retain their existing fences
- **Why:** the actual private-daemon before probe captured revision0, saved the confirmation preference, then received revision1 and a reset conflict. The repaired probe retained0 and redeemed the synthetic offer. Rebinding would authorize a different offer without confirmation.
- **Evidence:** revision-smoke.ts before/after output; service.ts setPreferences; remaining-authority.test.ts; final prepass22 tests/112 assertions
- **Reversibility:** medium (authority semantics)
- **Confidence:** high
- **Revisit if:** a preference is added that changes provider/account identity
- **Source:** assumed — autonomous

## D6: Promote pending usage reloads when account state changes
- **Question:** Why did a genuine account-change event leave the old switch dialog and opt-out checked?
- **Options:** increase the test sleep; discard the regression; let a full reload supersede a pending usage-only timer
- **Chose:** one pending timer with an explicit full-reload request; account changes reload accounts and credentials as well as usage
- **Why:** a diagnostic showed only usage reads after the event, with the old B dialog still displayed. scheduleReload returned because scheduleUsageReload already owned the timer. This is a production race, not merely a slow React test.
- **Evidence:** preserved UI_EVENT_DIAGNOSTIC; model.ts reload scheduling; failing-before/passing-after checkbox transition in remaining-ui.test.tsx; both UI files14pass/51 assertions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reload work becomes independently scheduled
- **Source:** assumed — autonomous

## D7: Trusted hook home overrides are effective custom homes
- **Question:** Does prior unconfirmed m3-accounts S1 establish an account-routing defect?
- **Options:** label every hook home injected; infer intent from paths/bytes; preserve the trusted extension environment precedence and verify recorded identity
- **Chose:** preserve public hook semantics; no sessions.ts production change
- **Why:** the launch planner applies trusted hook environment after agent configuration. A daemon test proves configured home without the hook and the hook's effective custom home with it; sessionHome records the latter. Calling it managed would misrepresent the launched process.
- **Evidence:** plugins/quirky.session/test/launch.test.ts; sessions.ts homeOverrideOf; public launch-hook environment contract; targeted test passed
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public hook contract adds explicit provenance rather than generic environment additions
- **Source:** supersedes m3-accounts D31 (S1 remains unconfirmed there; this item supplies executable disposition)

## D8: Native continuation requires actual accumulated bytes
- **Question:** What establishes the missing Codex C leg without real credentials/model work?
- **Options:** ID/environment echoes; synthetic external CLI on real daemon/PTY reading native rollouts; real user account operations
- **Chose:** isolated real daemon/PTY and native-format synthetic CLI; public restart/removal/focus/layout APIs
- **Why:** C read A's prior content plus B's continuation after confirmed removal of A's owned home. Its current transcript locator is in C and public terminal output/layout/focus agree. No model request, user credential or default home was used.
- **Evidence:** accounts-remaining.ts c-leg final outputs, including ABytesInC/BContinuationInC/CContinuationInC=true, removedAHomeGone=true and current C focused session; guarded web pane Restart also displayed A's prior rollout and B response
- **Reversibility:** easy (fixture)
- **Confidence:** high for the named external-boundary/runtime proof; no real-provider or OS-focus pass claimed
- **Revisit if:** provider rollout format/resume contract changes
- **Source:** locked by original m3-accounts D24 and logic AC12

## D9: Respect the night cutoff and carry all unfinished user acceptance in one item
- **Question:** What should happen at01:24+90minutes when the full deferred UI matrix has not finished?
- **Options:** silently call every flow complete; start more campaigns; land verified repairs and register one complete follow-up before landing
- **Chose:** stop starting new flows at02:54CDT, finish the already-started Codex/reset checks and blocking repairs, then register m3-accounts-complete-user-acceptance-20261028 with every remaining flow
- **Why:** authoritative LOOP night rules explicitly prescribe this scope adjustment. This is acceptance deferral, not evidence that unexercised controls work. The core can ship without claiming the unfinished observations.
- **Evidence:** guarded runs20261028T073937-8f70 and20261028T074759-9b79 are partial overall, with no test overrides; BLOCKERS entry and dependent queue item retain the complete remaining list
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the follow-up supplies the missing built-UI/native observations
- **Source:** deferred: complete user-surface acceptance under docs/loop/LOOP.md night cutoff

## D10: Distinguish verified gates, UI proof and driver limits
- **Question:** Which verification results can be claimed?
- **Options:** extrapolate from mounted tests; count only exact exercised surfaces and command verdicts
- **Chose:** preserve the full result for each surface and command
- **Why:** affected suite passed297remote files and2Mac files with no retries; scripts passed68tests/568assertions after the first external180s command deadline expired without verdict; typecheck passed after three new-test typing errors were fixed; full build passed with missing-icon warnings. The final review prepass passed22tests/112assertions. Guarded web proved Detailed/Remaining changes, Claude/Codex drill-ins, ordinary Keep and opt-out Keep, reset opt-out/redemption/replay, and pane Restart with prior content. Targeted keyboard input was refused for xterm textarea opacity (F1), so typing/OS focus are not claimed.
- **Evidence:** suite-result ok=true/flaky=[]; scripts133.54s; typecheck42.27s; build63.46s; final-review/prepass.json; run2obs18 focused Codex2 and retained transcript; report.json state_left has no kept browser or cleanup errors
- **Reversibility:** easy
- **Confidence:** high for named observations only
- **Revisit if:** merged-source verification contradicts them
- **Source:** assumed — autonomous

## D11: Keep Accounts popovers below public modal overlays
- **Question:** Why did the Usage menu cover the right side of the Claude restart dialog?
- **Options:** raise every modal/kernel layer; close Usage after the fact; respect the existing public overlay layer's z-index40
- **Chose:** Accounts Usage/context menus use z-index30/35 instead of100/110
- **Why:** the dialog belongs to the public overlay layer; plugin-local popovers must remain below it. The rebuilt fresh page showed the whole dialog and successfully applied its footer Keep with opt-out.
- **Evidence:** packages/ui/src/styles.css overlay-layer40; first runobs7 occluded dialog; second runobs1–3 repaired modal and actual Keep action
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public overlay stacking contract changes
- **Source:** assumed — autonomous

## D12: Preserve scope attribution and unknown metadata
- **Question:** How should relative-path worker misrouting and component cleanup be handled?
- **Options:** absorb main dirt; force-remove unknown metadata; preserve evidence and restore only positively attributed owned changes
- **Chose:** stop the barrier, archive the exact residual patch/incident, restore only the worker-attributed missing warning declaration, then rerun scope/HEAD audits
- **Why:** one relative renderer edit/reverse left three deleted declaration lines in main; another worker's two newly created main test files were removed only after ownership confirmation and recreated by absolute paths. Final audits passed all component scopes and unchanged inherited metadata. Parent committed/merged components, moved their unknown .serena folders intact, and removed all three trees with normal git worktree remove.
- **Evidence:** wave-audit.json; main-contamination.patch/incident.json; runtime-smoke/worktree-path-incident.json; accounts-component-metadata.tar.gz SHA2565100031b1c4eeef974a8b51041c857ea31e3a7a25fb8822c1b84ca61e8d4ff73 in this lane's ignored loop folder
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** preserved metadata needs restoring
- **Source:** assumed — autonomous

## D13: Preserve formal review results, including reduced independence and isolation failure
- **Question:** What clearance did Final Round1 actually produce?
- **Options:** equate empty/timed-out output with approval; discard the read-only violation; complete bounded task backstops and preserve the machine verdicts
- **Chose:** S is a valid full-independence Gemini PASS; C/X used actual fresh OpenAI task promote/refute backstops after bounded Gemini/Flash failures, with script-selected reduced-independence records
- **Why:** C's machine PASS suppressed C1 for inaccurate evidence anchors, but both model stages supported the race; parent corrected the anchors, reproduced it and accepted the finding. X's machine NEEDS_FIXES contains X1, a cancellation-polling failure path present in the baseline; it is tracked below rather than misrepresented as a new regression. No three-lens clean approval is claimed.
- **Evidence:** final-review/{C,S,X}/{gate,manifest}.json; caller-adjudication.json; initial-pi-failures.json and actual backstop dispatch journal
- **Reversibility:** easy
- **Confidence:** high for the recorded execution; reduced review independence remains a limit
- **Revisit if:** an independent follow-up supplies new findings
- **Source:** assumed — autonomous

The initial unsandboxed X reviewer violated its read-only prompt: it created test_cancel_login.ts, patch_check.js and test_restart_race.ts and attempted Bun execution. Individual command results were not exposed in its captured progress stream, so none is claimed. Exact payloads/hashes were archived under X/incident before parent removed only those positively attributed files. Main tracked source was unchanged by that reviewer; only parent documentation edits were present. All review processes/tasks settled before the fix batch.

## D14: A successful action can have a superseded display snapshot
- **Question:** Does a newer account event mean an earlier successful restart RPC failed?
- **Options:** keep treating discarded snapshots as failed actions; overwrite newer display state; separate committed action success from projection freshness
- **Chose:** preserve the event/generation fence for state application and return applied after successful restart/keep RPC completion
- **Why:** the deterministic C1 regression reproduced the pinned retry dialog when the committed account event arrived before the response. The repaired test removes the dialog while preserving the newer state. An event cannot undo an already committed restart.
- **Evidence:** model.ts restart/keep; remaining-ui.test.ts “a committed restart…” failed before and passed after; final narrow gate23pass/114assertions across5files
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public action contract stops treating a fulfilled RPC as a committed action
- **Source:** assumed — autonomous

## D15: Confirmation text wraps independently of status-bar chip layout
- **Question:** Why was the full Codex account/offer warning clipped horizontally?
- **Options:** shorten the warning; widen the fixed popover; override inherited status-bar white-space in the popover
- **Chose:** white-space:normal for Usage popovers; status-bar chips retain their layout
- **Why:** the warning inherited nowrap from the status bar. The rebuilt guarded repair run shows every sentence within the panel, then Cancel removes the confirmation without another provider redemption.
- **Evidence:** before run20261028T074759-9b79 obs8/9; after run20261028T081956-5813 obs3/4, scoped goal PASS, no test overrides; external provider log retained exactly one consume POST across the earlier redemption/replay and this Cancel
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** constrained-width verification finds another layout defect
- **Source:** assumed — autonomous

## D16: Preserve incoming launch, service and browser boundaries
- **Question:** Do the three incoming decision logs conflict with Accounts?
- **Options:** assume compatibility; read their exact integration objects and preserve the later binding decisions
- **Chose:** read m5-automations-dispatch D1–34, m6-heimdall-core D1–37 and sa-browser-profiles-settings D1–25 in full, including trailing verification and Progress
- **Why:** no Accounts conflict. m5 D31 supersedes its D15: automatic adoption is terminal-only, while explicit background bindings remain intact. Native identity/history and accepted-work evidence remain genuine; no fabricated service authority, remote/raw-argument fallback or native browser-clear completion is introduced.
- **Evidence:** incoming-decisions.json, integration snapshot2d00b2931121b5f1bf309d7dd155ea33d94d6c9b; ReadAccountsIncomingDecisions complete audit
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the final integration catch-up contains an additional decision
- **Source:** locked by incoming decision logs

## D17: Land the verified merge, not an on-time or full-parity claim
- **Question:** What did the final catch-up and queue registration establish?
- **Options:** infer that earlier checks cover incoming source; skip the new decision logs; verify the actual merge and keep all timing/scope limits explicit
- **Chose:** sole catch-up d0f14be25bd87bb4da7a9ddba3a230f265483ecf, incoming parent eaf268560ddbf2288dd25262f10d44436cc3f71a; read all five incoming logs and verify that merge
- **Why:** the actual merge also brought m5-automations-ui D1–29 and m6-orchestration-ui D1–15. All140 numbered decisions and trailing Progress/verification text were read, with no Accounts conflict. Post-merge affected58remote files passed without retries, typecheck and build passed, scripts passed68tests/574assertions, and actual private authority/Codex C-leg probes passed with cleanup. The commit/catch-up command completed after3929.83seconds; its delay's cause was not established. The two-hour/4am target was missed; no on-time claim is made.
- **Evidence:** merged-incoming-decisions.json; post-merge-evidence.json; build9UIoutputs/22modules/29plugins with icon-source warnings; affected80.95s, typecheck49.48s, build40.39s, scripts137.51s, runtime7.33s
- **Reversibility:** easy
- **Confidence:** high for these observed results; the queue full-merge verifier remains authoritative for landing
- **Revisit if:** canonical queue land reports a failure
- **Source:** assumed — autonomous

The canonical queue add exited0 and the integration queue confirmed exactly one new todo item, m3-accounts-complete-user-acceptance-20261028, depending on this item. Canonical deps returned ready:true with no pending dependencies. No unfinished acceptance requirement was deleted; D9 and BLOCKERS remain the follow-up's contract.

## D18: Keep the full verifier after an intermittent script timeout
- **Question:** Does the first land's script timeout justify changing a deadline or claiming the product failed?
- **Options:** weaken assertions/deadlines; bypass the scripts gate; preserve the rejection and investigate the exact scenario before a normal full retry
- **Chose:** preserve all source, deadlines and verification policy; inspect the awaited setup/child/cleanup path and run the unchanged named case, then the complete scripts gate
- **Why:** the first land passed all683product files after the configured loops-store isolated retry and all5Mac files, then failed scripts67pass/1timeout in “runFiles emits no profile rows when profiling is disabled” at5003.68ms. Source inspection did not establish the cause. The unchanged isolated case passed in1121ms; the subsequent full scripts run passed68tests/576assertions in144.60s. Those executions establish an intermittent outcome, not a proven load-only root cause. A normal queue retry must still run every required gate.
- **Evidence:** first-land-result.json; full land836.15s; ScriptsProfilerFailure source audit; isolated1pass/2assertions; full scripts retry68pass/0fail/576assertions
- **Reversibility:** easy
- **Confidence:** high for observed results; root cause remains unknown
- **Revisit if:** the normal authoritative retry reproduces the timeout
- **Source:** assumed — autonomous; preserves m3-accounts D35's no-waiver precedent

## Progress
The first canonical land was rejected only by the script timeout in D18; no landed claim is made. The required failure-recovery merge brought queue.json only, with no new source or decision logs. Unchanged isolated and complete scripts checks now pass; product gates and prior source checks remain as recorded. Commit this evidence, detach and retry canonical queue land with the full verifier. The one registered complete-acceptance follow-up, native handoffs and explicit review limits remain unchanged.

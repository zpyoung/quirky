# fix-terminal-dock-unfinished-flows-20261027 decisions

## D1: Retain every named deferred flow as the repair acceptance contract
- **Question:** what remains to deliver after the operator-approved core landing?
- **Options:** narrow to the obvious card defect; complete every flow named by the queue item.
- **Chose:** complete SC14/15 visible session controls and safe refusal; SC16 card interaction/refresh; SC06/08 feature-toggle focus, disable and auto-open; SC04/05 measured rows/hysteresis; SC09/20/21 visible interruption and draft preservation; SC12 acquisition/paste/drop/removal and native handoff; SC02 shell pane menu negative; SC03 direct hook-ended and whole-PTY exit. Existing full dock specs remain normative. Fix-item workflow skips new brainstorming/specs.
- **Why:** the original D33/D40 deferred exactly these flows, not their requirements. User requires one queue item, unattended decisions and no asks.
- **Evidence:** docs/quirk/specs/2026-10-27-m3-terminal-dock/logic.md; docs/loop/decisions/m3-terminal-dock.md D33/D40; authoritative queue title.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public-flow evidence identifies a locked architecture conflict.
- **Source:** locked by docs/loop/LOOP.md fix-item workflow and m3-terminal-dock D33/D40

## D2: Use isolated runtime state and retain native tool limitations explicitly
- **Question:** how to reproduce browser and native acquisition failures without affecting real sessions?
- **Options:** normal user profile; private daemon/HOME with owned deterministic terminal processes.
- **Chose:** fresh temporary HOME and QUIRKY_HOME; no writes to real agent directories; owned processes cleaned after proof. Web-only unattended dogfood. Native OS-dialog scenario remains a native handoff, not a fabricated web pass; inspect the existing blocked native report and reset its status only when an actual fix justifies rerun.
- **Why:** locked loop safety/platform rules; prior native run opened the panel but its driver could not deliver keys.
- **Evidence:** docs/loop/native/m3-terminal-dock.json; terminal-dock feature document; LOOP.md verification rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current web/native capabilities supply new actual evidence.
- **Source:** locked by docs/loop/LOOP.md; deferred: platform (Linux/Windows remain untested)

## D3: Pair OpenAI implementation with reachable Gemini review
- **Question:** which cross-family reviewer is available on this omp lane?
- **Options:** Opus; next cross-family Gemini; same-family review.
- **Chose:** OpenAI task implementers and Gemini review via pi-watch. Preflight found Opus/Sonnet/Fable/Haiku unavailable and Gemini/Flash reachable. No review result claimed yet.
- **Why:** required pairing with actual availability evidence.
- **Evidence:** pi-watch --check output during this iteration: Gemini google/gemini-3.1-pro-preview:high, Flash google/gemini-flash-latest:medium; Anthropic aliases unavailable.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini dispatch fails.
- **Source:** assumed — autonomous, following LOOP.md model pairing

## D4: Separate regression authoring from implementation in three ownership domains
- **Question:** how to parallelize investigation without overlapping mutable state or testing moving source?
- **Options:** serial broad implementation; disjoint host/composer/backend owners with a test-only first wave.
- **Chose:** host owns pane focus/geometry/menu; composer owns UI event/recovery and styles; backend owns lifecycle/provider refresh/public daemon tests. Authors first return regressions and root causes without production edits or checks. Parent runs the red proof after the wave, then authorizes minimal fixes and verifies integrated behavior.
- **Why:** preserves research-before-editing and failing-before/passing-after evidence while sharing existing APIs, not introducing a second convention.
- **Evidence:** DockRepairMap, DockHostRepair, DockComposerRepair and DockBackendRepair handoffs; existing test/e2e harnesses use owned temporary process scopes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a fix needs a new shared protocol contract.
- **Source:** assumed — autonomous

## D5: Correct invalid test assumptions instead of changing safe production behavior
- **Question:** how to interpret the first five-file regression gate?
- **Options:** treat every failure as production red; distinguish actual regression failures from test defects.
- **Chose:** retain real red for queued Stop/Escape (`second` instead of `first\n\nsecond`) and SessionEnd leaving the dock open. Fix SC16's missing helper import before using it as evidence. Correct cancellation expectation to recover the queued `never-write` prompt too. Preserve caller-owned attachment paths on chip removal rather than delete them. Investigate the host test's disabled-state assertion before claiming it proved focus.
- **Why:** the specs require lossless queued recovery and forbid deletion of caller files; test mistakes are not grounds for altering those contracts.
- **Evidence:** first remote five-file gate exit1, 2026-10-28 iteration6; window tests two expected data-loss failures, SessionEnd timeout; service attachment/path contradiction, send snapshot omission, SC16 ReferenceError, host disabled-state timeout.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** corrected tests expose another consumer-visible defect.
- **Source:** locked by original dock specs; assumed — autonomous (test interpretation)

## D6: Confine terminal canvas stacking instead of escalating overlay z-indices
- **Question:** what actually covers the visible question-card controls?
- **Options:** arbitrary larger card z-index; isolate the terminal's internal canvas stack.
- **Chose:** confine the existing relative terminal subtree with z-index zero, keeping the gutter's existing z-index one. Actual baseline hit-testing found xterm's z-index-two link canvas at all five Collapse/Dismiss/choice/Submit centers, not the controls.
- **Why:** the overlay's z-index five is inside the gutter's z-index-one stacking context; the terminal had no stacking context. This fixes the escaping child stack at its owner.
- **Evidence:** private baseline-hit-test.json and baseline-card.png in .quirk/build-loop/fix-terminal-dock-unfinished-flows-20261027; measured host996x759, gutter180px, terminal zauto, gutter1, overlay5; all five targets unreachable.
- **Reversibility:** easy
- **Confidence:** high for observed root cause; repaired interaction pending.
- **Revisit if:** post-fix hit testing or real clicks still find an occluder.
- **Source:** assumed — autonomous, actual browser reproduction

## D7: Scope browser evidence to an explicit private terminal profile
- **Question:** how to inspect dock behavior when the default editor accessory masks terminals and this headless Chrome's GPU renderer paints blank?
- **Options:** claim a whole-default-profile pass; change unrelated feature/rendering defaults; isolate through existing public settings and retain limits.
- **Chose:** public plugin.disable({id:'quirky.editor'}) and terminal GPU acceleration off, only inside the run-created home. Baseline screenshot was blank with GPU auto while public terminal/read returned the actual question; switching GPU off visibly restored the terminal question. No production default or renderer code is changed.
- **Why:** dock flows must remain observable without fabricating native/default-profile evidence or expanding this item into unrelated plugin/driver repairs.
- **Evidence:** baseline Chrome screenshots; setting.set terminal/gpu-acceleration off; terminal/read returned AskUserQuestion/Choose a color/Red/Blue; retained prior-iteration notes documented the editor-disabled private-profile limitation.
- **Reversibility:** easy
- **Confidence:** high for private-profile observation; default-profile integration unverified.
- **Revisit if:** the default editor/GPU surface is independently repaired or verified.
- **Source:** assumed — autonomous (verification isolation); deferred: platform (headless GPU/native-default surface)

## D8: Keep existing event-driven focus behavior when the corrected regression passes
- **Question:** does feature re-enable still require a new focus-ownership mechanism?
- **Options:** add another controller/host focus retry; exercise the existing readiness path with the correct Settings control.
- **Chose:** no new focus implementation. Correct the test's checkbox selector and assert remount plus actual active editor after returning from Settings, without pinning the disabled record's internal representation. The focused real-daemon/headless-UI test passed with 31 assertions; the original dock landing's later D43 readiness repair remains in effect.
- **Why:** the first test timed out before focus because it did not exercise the intended control. Adding a second focus mechanism without a current failure risks background focus stealing. Actual web focus is still a required final scenario.
- **Evidence:** corrected dock.test.ts focused local run exit0, 1pass/0fail/31assertions; original D43/D44; no host focus production change.
- **Reversibility:** easy
- **Confidence:** high for the exercised headless path; actual web re-enable pending.
- **Revisit if:** final web use shows missing focus in the active pane.
- **Source:** assumed — autonomous, following observed regression evidence

## D9: Exercise actual public SessionEnd and expire provider reads on fresh status
- **Question:** how to fulfill the old lead.ended assertion and remove answered-card refresh lag?
- **Options:** invent a public lead.ended setter; consume actual authenticated hook lifecycle and current status events.
- **Chose:** correlate non-child Claude/OpenClaude SessionEnd with the live provider-session identity and status-row removal; retain child/foreign-session negatives and relaunch/whole-PTY assertions. The status plugin removes the row, so a synthetic lead.ended field is not an exercisable public flow. Separately, expire matching cached provider reads on fresh status by setting their read timestamp stale, preserving question overlay identity/collapse/dismiss state.
- **Why:** corrected SC16 actually failed with undefined instead of the next question after its public hook update. Expiring rather than deleting the entry avoids resetting the same question's overlay on every status tick.
- **Evidence:** defects.e2e.test.ts public SessionEnd regression failed before fix; corrected SC16 filter failed at next-question assertion before cache expiry fix; service.ts status hook and provider cache boundaries.
- **Reversibility:** medium
- **Confidence:** high for reproduced failures; final green proof pending.
- **Revisit if:** stale child/foreign exit can close a live lead, or fresh status still shows the old question.
- **Source:** supersedes m3-terminal-dock D40 lead.ended test wording with actual public contract; assumed — autonomous

## D10: Catch up once and preserve the landed generic loop-tab contracts
- **Question:** which concurrent decisions bind this repair before final review?
- **Options:** overwrite integration seams; merge the current roadmap and preserve both features.
- **Chose:** merged build/roadmap at 58ec89b1c5e0a3314e84904cc73e355f06e3191f into this item (4b482ed8f833c340d4f5ee270653ad11e8bf5830). Read the complete incoming m5-loops-ui decision log. Retain the canonical tab-menu target, hosted close-context ownership, no automatic background-session tab adoption and structured-session lifetime rules. Dock recognition remains terminal-only.
- **Why:** incoming terminal/controller changes are additive and auto-merged; no separate menu convention or private plugin import is needed.
- **Evidence:** merge output; m5-loops-ui D2/D3/D7/D12/D15/D24/D25; dock source and public UI regression.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative landing exposes another concrete shared-seam conflict.
- **Source:** locked by imported m5-loops-ui decisions

## D11: Compare hook status evidence to the exit fence, not another listener's clock
- **Question:** why did relaunch pass locally but fail twice on the remote affected gate?
- **Options:** retry or extend deadlines; compare independent listener timestamps; fence normalized evidence against the confirmed exit and exact provider identity.
- **Chose:** hook reopening requires the same exact provider-session identity, fresh hook observation after confirmed exit and normalized status evidence after that exit. It no longer requires status.evidenceAt to be greater than the dock listener's later Date.now. Program-app freshness checks remain unchanged.
- **Why:** hook.received has no public event timestamp; the status plugin and dock record separate observation clocks. A one-millisecond listener-order difference can make legitimate status permanently older than the dock observation.
- **Evidence:** affected suite 94/95 remote files passed plus both macOS files; sole SC03 relaunch failure repeated in isolation. DockRelaunchRace inspected the hook type/schema/producer and normalized status clock. After the narrow guard fix, the exact remote defects.e2e.test.ts passed with flaky:[].
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a stale pre-exit row or wrong provider identity reopens a closed dock.
- **Source:** assumed — autonomous, confirmed remote lifecycle repair

## D12: Use the public plugin-event envelope and realistic shell lifetime in regressions
- **Question:** what prevented the first lifecycle repair from exercising its intended boundary?
- **Options:** change correct process semantics; add test-only state; follow actual event and launch contracts.
- **Chose:** read quirky.agent-status/changed from event.data, as the public event actually carries it. Trace it with a real private daemon, then preserve the existing freshEvidence map. Launch the lifecycle agent inside a real shell so command exit and whole-PTY exit are distinct; keep canonical Session.agent equal to shell. Teach the private fake TUI to consume the real public terminal-send bracketed-paste framing.
- **Why:** the initial handler looked for sessionId at the wrong envelope level. Managed agent commandArgv intentionally execs the agent, so expecting a shell commandFinished/relaunch after its process exit was an invalid fixture assumption.
- **Evidence:** private exit-trace.json showed changed.data with working row then row:null; packages/daemon/src/launch.ts commandArgv exec; corrected local SC03 passed 1/0/9 assertions. Subsequent remote clock-skew failure is separately repaired in D11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public event or managed-launch contract changes.
- **Source:** locked by existing public event and launch semantics; assumed — autonomous

## D13: Retain exact guarded results alongside actual visible effects
- **Question:** how to report driver observations that differ from the visible outcome?
- **Options:** label the campaign universally passing; preserve each guard status and screenshot.
- **Chose:** run web/yours/unattended campaign 20261028T102010-951f on the isolated profile. Pane-menu, visible option safety and question-card goals passed. Generic Settings scrolling remained blocked; the normal command-palette route opened dedicated dock settings and enabled the feature. Low visibly applied session-only effort even though the screen hash returned NO_EFFECT; later visible Low safely refused the unsafe default picker with OBSERVED. Actual Stop and Escape both showed STOPPED and retained their distinct newer drafts; keep the Stop goal partial because Escape's act returned UNSETTLED before a stable observation, rather than manufacture a trailing action.
- **Why:** a formal status and the evidence of an actual effect are different facts. The repaired card controls were genuinely clicked, answered Blue retired immediately, and dismissal retained pending-request enforcement.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T102010-951f observations 18/20 (pane menus), 24/34 (options), 40–47 (cards), 56–64 (Stop/Escape). Final remaining goals and report are still in progress.
- **Reversibility:** easy
- **Confidence:** high for recorded screenshots/actions; no native/default-profile claim.
- **Revisit if:** final report or owned raw-browser measurement contradicts these visible outcomes.
- **Source:** assumed — autonomous, required tool-limit reporting

## Progress
Regression authoring and minimal source fixes are in place. Genuine red: Stop/Escape queued recovery, SessionEnd stale latch and corrected next-question cache refresh. Host re-enable test passes after its selector correction; no extra focus implementation. Baseline actual browser proved canvas occlusion; terminal stack is now isolated but post-fix browser verification remains. Corrected initial compiler mistakes (missing existing freshEvidence field, fixture closure paths, overbroad fixture report field); latest status-event envelope fix uses public plugin event data. Focused lifecycle/card verification is running. Next: finish green gates, integration catch-up, built private web campaign/exact measurements/acquisition, cross-family final review and canonical queue land. Native chooser handoff is pending in this item's native JSON; prior blocked attempt remains untouched.

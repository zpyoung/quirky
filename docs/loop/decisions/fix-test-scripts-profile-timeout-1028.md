# fix-test-scripts-profile-timeout-1028 decisions

## D1: Diagnose the recorded timeout without treating it as a profiling defect
- **Question:** What does the assigned failure establish?
- **Options:** Raise the test deadline; change runtime profiling; trace the real process lifecycle and retain only meaningful regression coverage.
- **Chose:** Trace lifecycle and gather focused runtime evidence before choosing a repair; preserve existing isolation, process cleanup and deadlines.
- **Why:** The historical case exceeded Bun's default 5000ms after 5053.94ms during an operator-reported load260 run. That establishes a timeout, not a causal profile defect. The original lane already recorded a successful remote scripts run; repeating the historical failure for confirmation would add no evidence.
- **Evidence:** docs/loop/decisions/fix-test-agent-status-1028.md D7-D8; scripts/suite.test.ts:196-201; scripts/suite.ts:51-121,177-200.
- **Reversibility:** easy
- **Confidence:** high for reported timeout; root cause attribution remains open
- **Revisit if:** Focused smoke identifies an actual process/profile behavior defect.
- **Source:** assumed — autonomous

## D2: Use reachable cross-family review without changing authentication
- **Question:** Which independent reviewer can execute on this omp lane?
- **Options:** opus; next reachable cross-family backend; same-family fallback.
- **Chose:** OpenAI task investigation/implementation and Gemini review through pi-watch.
- **Why:** `pi-watch --check opus` exited5 with no authed/shipping model among eight candidates; `pi-watch --check gemini` exited0 resolving google/gemini-3.1-pro-preview:high.
- **Evidence:** This iteration's actual alias preflight outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Dispatch fails or reviewer cannot inspect the changed surface.
- **Source:** assumed — autonomous

## D3: Reuse the existing real-process isolation test for disabled-profile coverage
- **Question:** How can the reported test-design defect be removed without changing runtime behavior or raising a deadline?
- **Options:** Increase the standalone test's timeout; delete the no-profile assertion; consolidate it into the existing isolated-home lifecycle integration.
- **Chose:** Capture the existing isolation test's real `runFiles` invocation, retain its success assertion and add the unchanged no-`suite-file ` assertion; remove the redundant standalone invocation.
- **Why:** The standalone test incorrectly required a full guarded subprocess lifecycle to finish inside Bun's default5000ms. Guardian readiness allows15000ms and cleanup waits5000ms plus a1000ms guardian wait; the meaningful home-cleanup integration already has an explicit30000ms deadline. Reusing that invocation tests the same opt-in profile behavior and every existing home-cleanup invariant without another lifecycle or any changed timeout. No production defect has been established; the exact historical phase that consumed5053.94ms remains unknown.
- **Evidence:** scripts/suite.test.ts isolated-home integration and removed standalone case; scripts/suite.ts:51-121; scripts/test-support/process-scope.ts:19-21,373-408,512-524; focused scout report.
- **Reversibility:** easy (test-only consolidation)
- **Confidence:** high for unsafe default-deadline mismatch and preserved coverage; no historical phase-causation claim
- **Revisit if:** The consolidated integration exposes a genuine lifecycle/profile error.
- **Source:** assumed — autonomous

## D4: Exercise both real profile modes and report bounded timing evidence
- **Question:** What evidence distinguishes profile behavior from an unproven historical timing cause?
- **Options:** Repeat the failed historical suite; mock process execution; run a standalone real-process diagnostic with fresh private homes in each mode.
- **Chose:** Standalone diagnostic calls actual `runFiles` once disabled and once enabled, reads child-written process/home reports, checks profile rows, process exit, separate homes and cleanup, and records broad timing boundaries and machine load.
- **Why:** Disabled mode returned success with no rows in888ms (startup-to-fixture255ms, fixture-to-return633ms); enabled mode returned success with one valid row in830ms (193ms/637ms). Load averages were about9.7/12.3/19.8, unlike the historical operator-reported260 load. These observations prove exercised mode behavior and cleanup, not the historical cause or worst-case latency. No tests or profiles touched real user state.
- **Evidence:** `bun /tmp/quirky-suite-l12-TmgMDd/smoke.ts` exit0/1.83s; `SUITE_PROFILE_LIFECYCLE_OK`; `SUITE_DIAGNOSTIC_HOME_REMOVED true`. Disabled/enabled child homes absent and child PIDs exited; parent environment restored. Canonical `bun scripts/suite.ts scripts` returned12/12files,0failed,`ok:true,flaky:[]` remotely in26.64s.
- **Reversibility:** easy
- **Confidence:** high for the named actual observations
- **Revisit if:** Caught-up gates disagree.
- **Source:** assumed — autonomous

## D5: Preserve the incoming script-review contract and verify the caught-up tree
- **Question:** Does the sole roadmap catch-up change this repair, and what checks actually ran?
- **Options:** Reopen adjacent script-review validation behavior; preserve its independent contract and gate this test-only change.
- **Chose:** Read the full incoming `fix-test-scripts-ui-review-1028` log, preserve its validation/error-artifact boundaries and receipt-only closure; run the canonical scripts suite and full typecheck on the merged tree.
- **Why:** The catch-up brought only that decision log plus controller-owned queue/index changes. Its real CLI validation smoke and original repair do not conflict with profile opt-in or test-home cleanup. Caught-up scripts returned12/12remote files,0failed,`ok:true,flaky:[]` in36.71s. Full typecheck exited0 in37.34s, including frozen install, UI lint, root/mobile/prepared-desktop TypeScript.
- **Evidence:** Sole `git merge build/roadmap` after b7c3d46a; docs/loop/decisions/fix-test-scripts-ui-review-1028.md D1-D4 and unabridged Progress; actual commands above. Ignored `.orca/loops/omp-until-done-0f117076/suite-evidence/proof.json` retains the observed receipt, and `smoke-source.tgz` retains diagnostic/review inputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Merge-result typecheck or independent review identifies a conflict.
- **Source:** locked by incoming decision log

## D6: Accept the bounded independent review without extending its claims
- **Question:** Did the final cross-family review identify a coverage, capture or lifecycle regression?
- **Options:** Fix concrete findings; accept no-findings result for this scoped test-only consolidation; treat review prose as proof of historical causation.
- **Chose:** Accept the no-actionable-findings result; no fix batch required. Do not adopt broader claims about historical causation or arbitrary-load reliability.
- **Why:** The actual Gemini dispatch returned exit0, `STATUS: PASS` after165.07s using only read/grep/find/ls. It inspected capture, coverage, isolation and lifecycle. The source ordering remains cleanup before stream EOF, as `exec` explicitly requires; review wording loosely describing stream closure/cleanup does not replace that source evidence. Existing integration deadlines remain unchanged, not a newly raised budget.
- **Evidence:** `pi-watch --alias gemini --tools read,grep,find,ls --require-trailer STATUS` with archived `review.md` input; actual output retained as a receipt under suite-evidence/review.txt. Reviewer did not receive author decision rationale and could not run shell or mutate files.
- **Reversibility:** easy
- **Confidence:** high for scoped no-findings result; not an exhaustive audit
- **Revisit if:** Merge gate or actual consumer behavior contradicts the exercised checks.
- **Source:** assumed — autonomous

## Progress
Ready to land. Source test-only consolidation b7c3d46a; sole roadmap catch-up completed and incoming log read fully. Actual smoke verified both profile modes, distinct private homes, exited children and cleanup. Remote scripts passed12/12files before/after catch-up without flakes; full typecheck passed. One independent Gemini review returned PASS/no actionable findings; no accepted findings or fix batch. All agents/jobs returned. No runtime/export/API/schema/plugin/UI/native change or flow deferral; feature docs/specs/native handoffs intentionally unchanged, this log documents the repair. Next: commit final receipt, detach, canonical queue land and await result, remove owned scratch after successful land, retain loop notes and end exactly this item.

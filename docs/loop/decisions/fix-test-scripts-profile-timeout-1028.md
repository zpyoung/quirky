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

## Progress
Implementation complete: only scripts/suite.test.ts and this log changed. Focused runtime diagnostic and canonical remote scripts passed; both task agents returned. Next: commit, merge roadmap once, read incoming decisions, run typecheck and caught-up scripts gate, perform one independent review/fix batch, then detach and land exactly this item. No public API, plugin, UI or native behavior changed; existing specs/native handoffs intentionally unchanged.

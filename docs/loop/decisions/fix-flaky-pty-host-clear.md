# fix-flaky-pty-host-clear decisions

## D1: Diagnose the reported flake before changing timeouts or clear ordering
- **Question:** Does the clear test exceed a deadline under load or race with live output?
- **Options:** lengthen waits immediately; change clear synchronization speculatively; capture a failure under controlled CPU contention first
- **Chose:** capture a failure, then change only its verified cause
- **Why:** the three historical flakes are ground truth, but the shared log records only file names and timestamps; it contains no failing assertion
- **Evidence:** common git dir `build-loop/flakes.log`, entries 2026-10-27T15:28:19.424Z, 22:47:40.082Z, 23:11:38.983Z; packages/pty-host/test/clear.test.ts; packages/pty-host/src/session.ts:788-809
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** captured evidence identifies a different failure
- **Source:** assumed — autonomous

## D2: Honor this fix item's explicit test-host load reproduction requirement
- **Question:** Does build-first mode suppress the test run explicitly required by this assignment?
- **Options:** typecheck only without diagnosis; run focused diagnostic and regression tests, but not unrelated suites or reviews
- **Chose:** focused diagnostic and regression tests
- **Why:** the claimed item explicitly requires reproduction under CPU load on the test host; suppressing it would leave the core task unfinished. No feature flows or review rounds are added.
- **Evidence:** queue item fix-flaky-pty-host-clear title; scripts/suite.ts:299-322; common git dir build-loop/remote-tests.json
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** assignment requirements change
- **Source:** assumed — autonomous

## D3: Use an isolated checkout and owned bounded load processes on the configured host
- **Question:** How should contention be applied without modifying real application state or other lanes' processes?
- **Options:** system-wide untracked stress processes; an isolated checkout with process-scope-owned lower-priority CPU burners and fresh per-test homes
- **Chose:** the isolated checkout and scoped CPU burners, always reaped in finally
- **Why:** the existing runner provides temporary HOME/QUIRKY_HOME and process guardians; the load harness reuses those contracts. The configured host identifies as Linux with 16 processors, despite the general macOS-only platform preference; this item explicitly requires that host. macOS validation will also cover the fix.
- **Evidence:** scripts/suite.ts:96-121; scripts/test-support/process-scope.ts; configured-host uname/getconf probes; /tmp/quirky-l11-clear-load.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** configured test host changes
- **Source:** assumed — autonomous

## D4: Give the real-PTY tests and cleanup the existing 60-second outer budget
- **Question:** What failed under load, and should the implementation or the test change?
- **Options:** change clear/output ordering; lengthen inner polling waits; match the existing host integration tests' outer test and cleanup deadlines
- **Chose:** import `setDefaultTimeout`, set the file default to 60,000 ms, and give `afterEach(runCleanups)` the same budget; leave all assertions, explicit 30-second test budgets, inner polling waits and production code unchanged
- **Why:** the unmodified file failed at its 5,000 ms Bun default while the 10,000 ms screen waiter and process lifecycle were still allowed to continue. Cleanup began before that test finished, and its continuation then rejected with `Terminal host is shutting down`. This is runner deadline cancellation, not evidence of incorrectly ordered clear/output bytes. `host.test.ts` already applies this exact 60-second convention for process-scope startup/cleanup under suite load.
- **Evidence:** test-host CPU0 affinity, 32 owned normal-priority busy workers, five complete-file repeats: 84 pass, 1 fail, 1 unhandled error, 377 assertions, 356.85 s. Failing test: `resetModes > an exited session can have its modes reset`, `this test timed out after 5000ms`, followed by `session.ts:478` through `clear.test.ts:351`. Earlier load experiments: 510/510, 340/340 and 300/300 passed without retries. `packages/pty-host/test/host.test.ts:10-12`; `packages/pty-host/test/clear.test.ts:54-62`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a future failure reports an assertion or inner polling deadline rather than the outer Bun timeout; archived output of the three original flakes is not available, so their exact assertion cannot be identified
- **Source:** assumed — autonomous

## D5: Use the existing end-to-end clear assertions as the regression, not a test of timeout configuration
- **Question:** Is another permanent test necessary for a runner-budget fix?
- **Options:** assert source text or mock timeout registration; preserve all existing real-PTY assertions and rerun them under the same failing CPU load
- **Chose:** preserve the existing tests and run the failing-before scenario again after the fix
- **Why:** the existing 17 tests exercise screen/history/offset/subscription/restore/mode behavior through actual PTYs. A test that only inspects the timeout wiring would not catch a consumer-visible bug.
- **Evidence:** packages/pty-host/test/clear.test.ts; captured pre-fix CPU-load run
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** production behavior needs to change
- **Source:** assumed — autonomous

## Verification

- **Failing before:** isolated configured-host checkout, Bun 1.4.0, test and 32 normal-priority owned CPU workers restricted to CPU0; `bun test packages/pty-host/test/clear.test.ts --rerun-each=5` inside the existing `runSuite` temporary-home/process-scope wrapper. **84 pass, 1 fail, 1 unhandled error**, 377 assertions, 356.85 s; the runner reported a 5,000 ms outer test timeout and a premature-cleanup continuation error, not an ordering assertion.
- **Passing after, identical contention:** only `clear.test.ts` replaced with the deadline fix; same host, affinity, worker count, Bun version and five repeats. **85 pass, 0 fail, 0 errors**, 380 assertions, 383.59 s; `clear-load-result {"ok":true,"flaky":[]}`. All clear/history/offset/restore/mode assertions retained. Several successful cases took more than 5 seconds, including the reset-stream case at 7.54 s. No retry rescued this run.
- **macOS actual-PTY smoke:** full changed test file through the same fresh-HOME/QUIRKY_HOME runner without CPU burners: **17 pass, 0 fail**, 76 assertions, 18.45 s, no flakes. This executes real shell/cat PTYs and screen/history/subscriber/restore paths, not mocked forwarding.
- All diagnostic CPU workers, test children, guardians and per-run homes are owned and cleaned by `ProcessScope`/`finally`. The isolated host checkout and local throwaway load harness will be deleted after landing.
- No plugin/runtime/API behavior changed, so no new feature spec, native scenario, or broader feature-suite/review run is necessary for this test-only fix. Typecheck remains the canonical land gate.

## Progress
Focused failing-before/passing-after verification and macOS real-PTY smoke complete. Next: commit the test-only fix and decisions; catch up once with build/roadmap, read incoming decisions, run root typecheck and canonical land. Cleanup owned scratch after successful land. No production changes, speculative race fix, weakened assertions, human input, feature spec, review round, or protected loop changes.

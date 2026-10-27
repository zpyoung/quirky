# fix-flaky-pty-host-host decisions

## D1: Repair the named timing failure without re-specifying terminal features
- **Question:** Which workflow and acceptance boundary apply?
- **Options:** Full terminal feature specs; systematic debugging and test-first fix.
- **Chose:** Fix-item workflow; reproduce host.test.ts under bounded CPU load, repair the verified cause, verify affected consumers and land one item.
- **Why:** The claimed id starts with fix-. Product terminal persistence and public APIs remain locked.
- **Evidence:** docs/loop/LOOP.md:159–171; docs/architecture.md:39–51; queue.ts wait --lane 11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Evidence requires changing product behavior.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve independent cleanup ownership and isolate experiments
- **Question:** Can load failures be fixed by removing process scopes?
- **Options:** Remove guardians; retain ownership and diagnose scheduling/deadline assumptions.
- **Chose:** Retain guardians. Use finite CPU workers, temporary HOME/QUIRKY_HOME and finally cleanup for experiments.
- **Why:** Earlier process-leak decisions require cleanup after worker SIGKILL; production PTYs must remain detached. Removing safety is not a timing fix.
- **Evidence:** docs/loop/decisions/fix-test-process-leaks.md D1/D4/D10; scripts/test-support/process-scope.ts:370–405; packages/pty-host/test/helpers.ts:32–42.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A different ownership mechanism proves equivalent hard-death safety.
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D3: Use OpenAI implementation and available Gemini review
- **Question:** Which cross-family reviewer can run unattended?
- **Options:** Opus; Sonnet; Gemini.
- **Chose:** OpenAI task implementer and pi-watch Gemini reviewer.
- **Why:** Opus and Sonnet availability checks each exited 5 (no authenticated/shipping model); Gemini resolves google/gemini-3.1-pro-preview:high.
- **Evidence:** Current iteration pi-watch --check opus/sonnet/gemini output. No auth state changed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch cannot complete.
- **Source:** assumed — autonomous

## D4: Give host tests and their cleanup independent load-tolerant outer budgets
- **Question:** Which five-second assumption actually fails under CPU contention?
- **Options:** Increase arbitrary sleeps; remove cleanup; allow bounded process startup and cleanup to finish before the runner advances.
- **Chose:** Keep condition-based waits and process ownership; increase the host file's test and afterEach budgets explicitly.
- **Why:** Twelve and 48 CPU workers passed all 32 tests in 28.83/75.80 seconds of driver wall time. With 96 workers, afterEach exceeded five seconds at authentication and session tests (6.72–7.69 seconds); subsequent tests saw ECONNRESET while cleanup from the preceding test still ran. The cleanup path itself allows five seconds plus a one-second guardian-exit wait, already longer than the runner's outer hook deadline.
- **Evidence:** /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/lane11-pty-load-nFaX9l/test.log:14–87; scripts/test-support/process-scope.ts:510–520; packages/pty-host/test/host.test.ts:9. The bounded experiment stopped at 170 seconds (exit 143), then killed and awaited all 96 workers; this was a reproduced failure, not a completed suite.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The explicit condition waits fail after correct cleanup isolation is restored.
- **Source:** assumed — autonomous

## D5: Stop local stress and verify contention-sensitive work remotely
- **Question:** Where should load-sensitive reproduction run without starving other lanes?
- **Options:** Local CPU burners; remote-aware suite on the shared test host; reason from captured failure timing.
- **Chose:** No more local CPU-load generation. Use `bun scripts/suite.ts packages/pty-host` and recorded evidence. Any future local synthetic load is limited to two processes for less than a minute.
- **Why:** The operator stopped the final 96-worker run after it drove host load to 346 and slowed all twelve lanes. That stopped run has no success result. The external load script was removed; a PID/environment-scoped cleanup found no surviving owned load workers.
- **Evidence:** Operator instruction in this iteration; stopped job bg_5 exit 143 at 30.76 seconds; cleanup checked only the exact load command plus this experiment's temporary HOME.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The operator explicitly authorizes a different isolated load host.
- **Source:** locked by operator instruction, 2026-10-27

## D6: Bound slow guardian readiness without weakening the handshake
- **Question:** How should slow-but-live cleanup ownership startup behave?
- **Options:** Remove readiness checks; keep four seconds; retain readiness and early-death detection with a fifteen-second bound.
- **Chose:** Fifteen seconds for guardian startup; sixty seconds for the host file's test and explicit afterEach budgets. Individual condition waits remain unchanged.
- **Why:** The deterministic regression delays only the guardian's first process-table lookup by 4.5 seconds. Before the change it failed with the exact reported “could not start process scope guardian” error (8.66 seconds driver wall time under contention). Afterward it passed (15.85 seconds), spawned a real owned process, and confirmed child and guardian termination. The first four authentication scenarios also passed under the previously reproduced 96-worker contention (39.76 seconds), without hook timeout or connection-reset cascade.
- **Evidence:** scripts/process-scope.test.ts “a slow live guardian does not prevent scope startup or owned-process cleanup”; red/green command output in this iteration; /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/lane11-pty-load-FgrmlW/test.log. The later whole-file local load run was stopped by the operator (D5), not passed.
- **Reversibility:** easy
- **Confidence:** high for observed readiness and hook failures
- **Revisit if:** Remote verification exposes another lifecycle or condition-wait failure.
- **Source:** assumed — autonomous

## D7: Keep product surfaces and platform support unchanged
- **Question:** Does a test-harness timing repair require new terminal UI/native flows?
- **Options:** Alter product protocols or UI; keep this repair at disposable process ownership and test budgets.
- **Chose:** No new API, plugin, UI or native scenario. Preserve all existing consumers. Document readiness and separate hook budgeting in docs/v1.md.
- **Why:** Runtime terminal behavior is unchanged. An actual `owned-run` invocation of `quirky --json status` started real quirkyd and quirky-pty in a fresh home and returned version, daemon PID and live PTY-host PID. After wrapper exit, both PIDs were absent and the temporary runtime record was removed. No real profile was used. Windows process ownership remains the earlier deferred platform decision; this fix adds no platform-specific production API.
- **Evidence:** `bun scripts/owned-run.ts -- bun packages/cli/src/main.ts --json status`, exit 0, 13.56 seconds; daemon PID 57404, PTY PID 57451; post-run process inspection empty; docs/loop/decisions/fix-test-process-leaks.md D7.
- **Reversibility:** easy
- **Confidence:** high for the exercised CLI lifecycle
- **Revisit if:** A product surface changes.
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D8: Accept Final Round 1 with no additional fix batch
- **Question:** Which final cross-family findings need correction?
- **Options:** Fix confirmed issues; invent additional changes despite no findings.
- **Chose:** No fix batch; retain the scoped timing repair.
- **Why:** Gemini independently read the changed source, regression and documentation and returned no actionable findings, STATUS: PASS. It checked readiness/early-death detection, outer hook budgeting, private PID ownership and PATH restoration. This is review evidence, not a guarantee against every scheduling failure.
- **Evidence:** pi-watch --check gemini and --alias gemini --tools read,grep,find,ls --require-trailer STATUS; exit 0, 28.84 seconds in this iteration.
- **Reversibility:** easy
- **Confidence:** high for the reviewed paths
- **Revisit if:** Verification or the merge-result gate finds another defect.
- **Source:** assumed — autonomous

## D9: Treat the remote synchronous-wait stall as unresolved, not a successful isolated rerun
- **Question:** Did the larger budgets eliminate the named flake?
- **Options:** Accept the runner's passing rerun as proof; inspect the remaining failure without more local load.
- **Chose:** Continue diagnosis. The scoped run exited 0 only because its isolated rerun passed.
- **Why:** The first remote host run passed fifteen tests, then stalled in cleanup; later tests timed out at sixty seconds. Temporary per-process phase traces and a read-only remote observer then reproduced the same pattern in clear.test.ts: the parent was running while its synchronous bootstrap child was already a zombie; a later synchronous ps child was also already a zombie. That disproves the hypothesis that a merely slow live ps alone explains the stall. No additional timeout increase was made.
- **Evidence:** scoped run bg_7: host.test.ts 15 pass/17 fail/4 errors in 1263 seconds, isolated rerun 32 pass in 10.96 seconds; diagnostic scoped run bg_11: clear.test.ts 13 pass/4 fail/1 error, isolated rerun 17 pass; artifact://27 captured parent 1899813 with zombie children 1902361 (bootstrap) and 1906408 (ps). An instrumented single-file remote host run passed; it did not explain the intermittent stall.
- **Reversibility:** easy
- **Confidence:** high for the observed process states; native Bun wait-loop mechanism is not yet established
- **Revisit if:** A controlled trace identifies a different blocked operation.
- **Source:** assumed — autonomous

## D10: Release each exited session's native terminal handle during finalization
- **Question:** What verified lifecycle defect does the remote trace expose beyond scheduling budgets?
- **Options:** Leave terminal handles to garbage collection; close them explicitly at the existing final-output boundary.
- **Chose:** Add a black-box resource-release regression, then close the native terminal during session finalization before resolving its finished promise.
- **Why:** The stalled parent retained more than twenty /dev/ptmx descriptors after thirteen tests. Before this repair, SessionManager.finalize and teardown never called terminal.close. A separate real Bun smoke showed terminal.closed=false after echo exited and output drained, then true after explicit close. This proves a retained native resource; its causal link to the Bun synchronous-wait spin remains an inference. Closing only finalized sessions preserves detached live terminals and existing history/exit ordering.
- **Evidence:** packages/pty-host/src/session.ts:796–843; artifact://27 process descriptor capture; actual two-process echo/terminal smoke in this iteration; https://bun.com/docs/runtime/child-process#terminal-pty-support.
- **Reversibility:** easy
- **Confidence:** high for the missing close; medium for its relationship to the observed spin
- **Revisit if:** Resource release loses final output or remote synchronous waits still stall.
- **Source:** supersedes fix-flaky-pty-host-host D7

## D11: Replace the subscriber-query sleep race with an input and parse barrier
- **Question:** Why did the remote subscriber test observe a legitimate emulator reply even though it expected none?
- **Options:** Increase the fixture's 300 ms delay; suppress the assertion; trigger the query only after subscription and verify the program's actual input.
- **Chose:** Have the shell wait for input before querying; subscribe, release that gate, observe the emitted query, await snapshot parsing, then send PING as the client reply. Verify the program consumed PING without a preceding emulator response.
- **Why:** The old fixture could ask before a delayed subscription completed, when the host is supposed to reply. A 700 ms sleep after subscribing did not establish ordering. The new test uses the actual socket subscription and screen-settled boundary and has no scheduling delay.
- **Evidence:** remote run bg_12 isolated output received ESC[5n plus “033 [ 0 n” in the old test; packages/pty-host/src/screen.ts:109–112 and session.ts snapshot/atRest; final local whole-file run: 33 pass, 0 fail, 73 assertions in 26.60 seconds.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A query can be emitted before the explicit input gate or snapshot no longer waits for queued parsing.
- **Source:** assumed — autonomous

## D12: Give bulk raw-replay fixtures one output writer
- **Question:** Why could raw replay wait forever for a second intact line token when every byte arrived?
- **Options:** Increase the timeout or require a different interleaving; synthesize/suppress production echo; make the fixture's output deterministic.
- **Chose:** In the two bulk raw-tail fixtures, disable echo, emit and wait for RAW_READY, then exec cat. Wait for the one program-produced output stream. Keep the exact replay boundary, byte offset, cap and replay-plus-live assertions.
- **Why:** Remote diagnostic capture held all 700 expected bytes from two 350-byte streams, but kernel echo and cat interleaved inside tokens, for example “line-line-2” followed later by “39”. Counting two intact line-39 strings assumed atomic writes from independent writers, which terminals do not guarantee. The single raw case passed in isolation but failed after the saturated case because writer scheduling changed, not because production lost bytes.
- **Evidence:** diagnostic remote bg_17 / artifact://45, live/all data and offset 700; RawSequenceScout's evidence assessment; targeted corrected host and manager cases both passed (2.73 seconds total). The socket fixture explicitly requests raw initial replay so serialized screen ANSI is not counted as original output.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The single-writer fixture's exact byte-join invariant fails.
- **Source:** assumed — autonomous

## D13: Wait for both expected copies before checking cold-restore input
- **Question:** When is it safe to assert that restored history injected no extra input?
- **Options:** Assert after the first “typed” token; wait for the complete echo-plus-cat result already required by the assertion.
- **Chose:** Wait for typed CRLF typed CRLF before checking that no other bytes arrived.
- **Why:** A remote failure captured only the first copy when the assertion expected both; the previous wait established a weaker condition than its assertion. The complete sequence is unchanged; only its readiness condition is corrected.
- **Evidence:** manager.test.ts SC-21 remote failure in bg_14; corrected scenario passed both diagnostic whole-file runs in bg_17.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The fixture changes its expected output contract.
- **Source:** assumed — autonomous

## Verification
- Regression red/green: delayed real guardian startup rejected at the old four-second bound and accepted at fifteen seconds, with actual owned child and guardian cleanup verified (D6).
- Actual CLI lifecycle: real daemon and PTY host started through `owned-run`, CLI JSON status succeeded, both service PIDs were gone afterward (D7).
- Initial budget-only gates passed: scripts 63 tests/462 assertions; typecheck and build exit 0; full suite 455 remote files plus two macOS files, no flaky reruns. These precede the terminal-release and query-barrier changes; final-source gates are running again.
- Native-resource regression: the real socket-API test timed out waiting for PTY descriptors before the close (7.61 seconds); passed after it (1.48 seconds), preserving final output and exit code 3.
- Actual final-source PTY API smoke: launched the real host entry under `owned-run`, created three shell sessions, read each final marker and exit code 3 through the socket API, and shut down the host with code 0 (2.46 seconds).
- Whole host file after restoring an accidentally removed protocol import and fixing D11: 33 pass, 0 fail, 73 assertions. The accidental import removal was found by full-file verification, restored exactly, and is not shipped.
- A local scripts-gate attempt after the resource change failed one protected loop-fixture test at its five-second deadline (62 pass/1 fail). No protected loop code was changed. The normal prescribed gate is running again after the final source corrections; do not claim it passed yet.
- Separate `bun scripts/suite.ts packages/pty-host` exited 0 with a host.test.ts flaky rerun, not a clean result (D9). Diagnostic remote runs exposed a retained native terminal handle (D10); those results do not establish closure.
- Final Round 1: Gemini returned no actionable findings, STATUS: PASS. No open findings to append to BLOCKERS.md.

## Progress
Step 6: all production changes and deterministic fixture corrections are now frozen. Native PTY release passed red/green and the real-host smoke; bulk raw-tail cases passed targeted checks after removing the echo-writer assumption. Two sequential remote PTY suites are running against the corrected raw subscription mode; full-repository gates started before the last fixture corrections and must be reported with that scope. No diagnostic code remains. Wait for all jobs, then record fresh results and let normal land verify the exact merge result.

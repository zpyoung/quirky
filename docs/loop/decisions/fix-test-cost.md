# fix-test-cost decisions

## D1: Optimize test execution, not product behavior
- **Question:** What can change while preserving coverage in the test-cost fix?
- **Options:** Change production terminal startup; optimize test fixtures and readiness waits.
- **Chose:** Optimize test fixtures and measurement only; preserve login/integration scenarios and all behavioral assertions.
- **Why:** The item explicitly names redundant test daemons, login shells and fixed sleeps, not a product behavior change.
- **Evidence:** Queue item `fix-test-cost`; `docs/loop/LOOP.md:188-200`; `research/orca-features/term-daemon.md` Spawn path and Shell-ready barrier.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A fixture optimization changes what the scenario exercises.
- **Source:** assumed — autonomous

## D2: Use omp implementers and the reachable Gemini reviewer
- **Question:** Which cross-family review pairing is available on this omp lane?
- **Options:** omp + Opus; omp + Sonnet; omp + Gemini.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; one final review round.
- **Why:** `pi-watch --check` reports Opus and Sonnet unavailable, Gemini available as google/gemini-3.1-pro-preview:high.
- **Evidence:** Iteration 4 backend preflight; `docs/loop/LOOP.md:127-143`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch fails.
- **Source:** assumed — autonomous

## D3: Measure on the existing configured remote runner
- **Question:** How to measure suite cost without loading this workstation or changing the shared runner configuration?
- **Options:** Run locally; use the configured test host at its existing scheduling limits.
- **Chose:** Use `bun run test` with the existing runner configuration; retain per-file measurements and compare the same workload before and after.
- **Why:** The queue asks for suite wall/CPU measurements and the existing suite runner moves work to the shared host; current configuration is jobs=2, slots=16, not the older four-job assumption in the item title.
- **Evidence:** `scripts/suite.ts:8-16,243-295`; shared `remote-tests.json` read during orientation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The host is unavailable or concurrent changes make comparisons non-equivalent.
- **Source:** assumed — autonomous

## D4: Profile test commands without claiming whole-host CPU
- **Question:** What CPU and wall measurements can the existing runner attribute to an individual file?
- **Options:** Add a host-wide sampler; use the spawned command's resource usage with explicit accounting limits.
- **Chose:** Opt-in `QUIRKY_TEST_PROFILE=1` prints a `suite-file` JSON row per attempt, including retries, with relative file path, wall milliseconds, user/system CPU milliseconds and exit code. Use Bun's microsecond CPU counters, converting BigInt to Number before dividing by 1000.
- **Why:** OS wait4-style command accounting is attributable and portable. It includes waited-for descendants but excludes independent guardians and unaccounted orphaned descendants; it is not total fixture-tree or whole-host CPU. Wall timing includes spawn/execution/cleanup but excludes initial guardian creation, slot contention, copying and install. The unchanged and optimized remote runs use the same definition.
- **Evidence:** `scripts/suite.ts` exec, runFiles and slotted; red regression expected three attempt rows and received none; first green attempt exposed BigInt division, then two profiling tests passed with 37 assertions after conversion. Runtime probe returned `cpuTime.user: 66930n`, `system: 7116n`.
- **Reversibility:** easy
- **Confidence:** high for measured command cost; limited for total process-tree cost
- **Revisit if:** Resource accounting changes or guardian/process-tree CPU is needed to explain host saturation.
- **Source:** assumed — autonomous

## D5: Share only compatible daemon state, not every test fixture
- **Question:** Which fresh-daemon boundaries can be removed without changing the scenarios?
- **Options:** Global per-file daemon reuse with reset machinery; scoped reuse of compatible inventories and stable transport state.
- **Chose:** Reuse the default server fixture for non-lifecycle transport tests, and homogeneous scripting/catalog groups with identical plugin inventories. Keep lifecycle, inactive-plugin, mutation-sensitive and different-inventory cases isolated.
- **Why:** Most daemon tests use an in-process fake PTY host, not a shell process. Their main removable cost is repeated stores, listeners and plugin setup. Sharing mutable inventories indiscriminately would couple tests and invalidate lazy-activation and marker assertions.
- **Evidence:** `packages/daemon/test/helpers.ts:62-79`; `fixtures/fake-pty-host.ts`; `server.test.ts`; `plugins/scripting-cli.test.ts`; `plugins/cli-catalog.test.ts`; two read-only surveys.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A test relies on state established by another test or no longer passes alone.
- **Source:** assumed — autonomous

## D6: Make clean real shells explicit and keep integration scenarios on login shells
- **Question:** How can unrelated real terminal layout tests avoid login startup without changing production launch behavior?
- **Options:** Change production shell argv; globally replace E2E shells; explicitly opt eligible layout cases into a test-owned adapter.
- **Chose:** Test-owned `sh` adapter under the disposable home consumes the generated `-l` and executes zsh with `-f`, or bash with `--noprofile --norc`. Default E2E mode remains integrated/login. Clean-mode readiness proves real computed-sentinel command output; login mode still checks real shell-ready state.
- **Why:** Merely changing the executable to `/bin/sh` still leaves production-generated `-l`. Existing agents E2E already uses a similar adapter. No fabricated OSC markers or replacement fake PTYs are needed.
- **Evidence:** `packages/daemon/src/launch.ts:38-50`; `plugins/quirky.agents/test/support/e2e.ts:150-152`; CleanLayouts scenario classification; `plugins/quirky.terminal/test/e2e-support.ts` and `e2e/support.ts`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An opted-in scenario needs rcfiles, login PATH, OSC cwd/command-finished integration or login-specific signal behavior.
- **Source:** assumed — autonomous

## D7: Replace positive-completion sleeps, retain real observation windows
- **Question:** Which fixed delays are redundant synchronization rather than behavior under test?
- **Options:** Remove every delay; wait for positive state/output/checkpoint conditions and retain duration-based negative/timer assertions.
- **Chose:** The latter; retain scheduler disabled/no-repeat, timeout and overlap windows, shell startup latency fixtures and actual terminal-query timing coverage.
- **Why:** An immediate negative assertion cannot prove something stayed absent for an interval. A renderer-output wait also cannot substitute for persistence before a crash; that case needs checkpoint/file evidence.
- **Evidence:** `packages/daemon/test/plugins/scheduler.test.ts:60-119,165-270`; `packages/pty-host/test/process.test.ts:195-215`; ReuseAndWaits investigation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A replacement wait drops an ordering, persistence or duration obligation.
- **Source:** assumed — autonomous

## D8: Apply the incoming verification policy without an unstarted review round
- **Question:** Does the catch-up change this item's remaining delivery procedure?
- **Options:** Continue the original review plan; follow the updated rule for items claimed before the policy change.
- **Chose:** Finish the affected tests and typecheck, then land; skip the unstarted cross-family review round.
- **Why:** The updated LOOP.md explicitly applies this procedure to items claimed before the new rule. Gemini availability was verified, but no review dispatch had started.
- **Evidence:** `docs/loop/LOOP.md:61-65`; the one integration catch-up merged after implementation commit `7116e9b`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A required gate exposes a blocking defect.
- **Source:** locked by docs/loop/LOOP.md

## D9: Preserve the real output and restart-observation boundaries
- **Question:** Why did the first optimized measurement fail, and what needed correction?
- **Options:** Increase timeouts; make the output sentinel a complete line and retain the scheduler's negative observation window.
- **Chose:** Print a newline before `facts-done`; require the overdue daily job's new run to start at or after the seed time; retain the original 500 ms no-duplicate/not-yet-due observation.
- **Why:** The facts fixture first prints `a` without a newline, so the new exact-line wait saw `afacts-done`, not `facts-done`. The scheduler's persisted successful run was not evidence of a new post-restart execution. Neither problem warrants a timeout increase or lost assertion.
- **Evidence:** First optimized run failed the facts test both initially and on the runner's isolated retry; after correction the targeted facts scenario passed with its exact five-fact assertion, 1 test/2 assertions. `packages/pty-host/test/manager.test.ts:257-275`; `packages/daemon/test/plugins/scheduler.test.ts:294-310`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The stream parser or persisted job-run schema changes.
- **Source:** assumed — autonomous

## D10: Keep incoming feature decisions and default test semantics intact
- **Question:** Do the incoming Handoff, Session Info, Ledger or Browser decisions conflict with fixture optimization?
- **Options:** Change their product contracts; retain opt-in fixture-only behavior and all ownership boundaries.
- **Chose:** Retain their contracts; the full incoming logs were read by the reconciliation scout, with no binding conflict found.
- **Why:** Their decisions reinforce per-file runner isolation, explicit scope ownership, private user/browser state, observable readiness and honest flaky reporting. No product shell argv, agent settings, API, UI or native behavior changes here.
- **Evidence:** `m3-handoff.md:634-729,774-783,840-855`; `m3-session-info.md:181-206,255-261,353-364`; `m5-ledger.md:212-220,278-305`; `sa-browser-agent.md:47-55,165-177,220-265,320-330,424-460`, all under `docs/loop/decisions/`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A fixture begins exercising one of those integration-specific contracts.
- **Source:** locked by docs/loop/decisions/m3-session-info.md

## D11: Retain the POSIX test platform boundary
- **Question:** Does this test-shell adapter add Windows support?
- **Options:** Introduce a second shell/process ownership implementation; keep the existing macOS/remote POSIX fixture boundary.
- **Chose:** Keep POSIX shell executables and the existing guardian cleanup; Windows needs a native test-shell/ownership implementation.
- **Why:** The test suite already requires `/bin/zsh`, `/bin/bash` and POSIX PTYs. This item does not change the supported product platform or weaken cleanup.
- **Evidence:** `plugins/quirky.terminal/test/e2e-support.ts`; `docs/loop/decisions/fix-test-process-leaks.md` D7.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Windows becomes a supported build/test platform.
- **Source:** deferred: platform

## D12: Keep the established flaky-rerun policy and report each non-first-pass gate
- **Question:** How should the observed unchanged cleanup/host failures affect delivery?
- **Options:** Change timeout or selection policy; preserve the existing runner and report exact outcomes.
- **Chose:** Preserve all timeouts, selections and assertions. The scripts cleanup test passed alone and the whole scripts gate then passed unchanged; the remote host file passed the runner's existing isolated retry.
- **Why:** The scripts timeout was not reproducible in its isolated run (1 test, 2 assertions, 2.53 seconds). The final affected suite completed successfully with the explicit flaky list naming `packages/pty-host/test/host.test.ts`. This is not a claim of eliminating load sensitivity.
- **Evidence:** Initial scripts gate 64 pass/1 fail, 149.26 seconds; repeat 65 pass/0 fail, 503 assertions, 94.82 seconds. Affected suite 188 remote files: 187 first-pass, host isolated retry 32 tests/69 assertions; 2 macOS-only files passed; exit 0, 407.69 seconds. Typecheck exited 0 in 41.39 seconds.
- **Reversibility:** easy
- **Confidence:** high for observed results; no attribution of the intermittent failures
- **Revisit if:** An isolated rerun fails or a reproducible ownership regression appears.
- **Source:** locked by scripts/suite.ts

## Verification and workload changes

- Profile reporter regression: failed before implementation with no per-file rows; after the BigInt conversion fix, 2 targeted tests passed with 37 assertions. The local CLI profile regression also failed before its local branch and passed afterward (1 test, 2 assertions). Final scripts verification includes both.
- Actual profiling CLI smoke: real CLI against an owned temporary Git repo, deterministic checksum, one emitted row (`wallMs=804.396375`, user/system CPU `5.653/6.343` ms), exit 0; temporary repo/home removed.
- Actual real-daemon/real-PTY smoke: clean zsh command `/bin/zsh -f` and clean bash `/bin/bash --noprofile --norc` skipped their private startup-file sentinel; default zsh `/bin/zsh -l` read it and reached `shellState=ready`. All three produced real command output, exited 7 and removed their temporary homes. Smoke exited 0 in 6.13 seconds; throwaway script removed.
- Static daemon fixture starts in the reuse slice: server 10→3, scripting CLI 44→32, catalog 13→10, scheduler 6→6; total 73→51. The 135 PTY fixtures in the inspected slice retain fresh-state/lifecycle boundaries. These are structural counts, not timing measurements.
- Nominal fixed delays removed total 3.3 seconds across selected positive-completion paths. Condition waits still take the time the operation actually needs; this is not a measured 3.3-second suite speedup.
- Login-shell integration scenarios remain in `packages/daemon/test/shell-path.test.ts` and `plugins/quirky.terminal/test/e2e.test.ts`, unchanged by this item. Opted-in layout tests still use real daemon, CLI, PTY and shell processes.
- The updated incoming LOOP.md waives an unstarted review for this item (D8); no final reviewer pass is claimed. There are no product UI or native scenarios added by this test-only change.

## D13: Report the measured costs without claiming an aggregate suite speedup
- **Question:** Do the before/after runs demonstrate cheaper total suite execution?
- **Options:** Report only improved files; report complete suite costs, failed attempts and the bounded per-file improvements.
- **Chose:** Report all measurements. The structural setup reduction and most changed files improved, but the full measured suite did not.
- **Why:** Both runs selected the same 455 remote and 2 macOS-only files with the same configured jobs/slots. The final after run passed under the existing policy but its host and manager files hit widespread guardian/timeout failures before passing alone. Their failed work stays in the totals. Shared scheduling is not a controlled benchmark, and no whole-host CPU claim is supported.
- **Evidence:** Complete `suite-file` rows in lane 10's `.orca/loops/omp-until-done-50bc6f72/evidence-test-cost/{before,after}.json` and `.log`; intermediate failed run in `after-first.{json,log}`. Source snapshot for the corrected after measurement is implementation commit `7116e9b`, before the integration catch-up; the affected suite then verified the integrated tree.
- **Reversibility:** easy
- **Confidence:** high for observed costs; no causal aggregate speedup claim
- **Revisit if:** A controlled quiet-host comparison or guardian-cost investigation changes the result.
- **Source:** assumed — autonomous

### Full suite measurements

Both columns use `env QUIRKY_TEST_PROFILE=1 bun run test`. CPU is user plus system command accounting, with D4's limits; all failed attempts and retries remain included.

| Measurement | Before | Corrected after |
| --- | ---: | ---: |
| Suite elapsed seconds | 791.15 | 1141.66 |
| Executed file attempts | 457 | 459 |
| Sum of per-file wall seconds | 1382.303 | 1911.515 |
| Attributable user CPU seconds | 599.755 | 1086.068 |
| Attributable system CPU seconds | 175.573 | 193.281 |
| Attributable total CPU seconds | 775.327 | 1279.349 |
| Files requiring isolated retry | 0 | 2 |

The corrected after run ended `ok:true`, with `host.test.ts` and `manager.test.ts` in `flaky`. The manager's first attempt took 331.574 wall seconds and 319.880 CPU seconds amid guardian-start failures and timeouts; its isolated retry passed all 57 tests/227 assertions in 20.96 seconds (profile wall 21.052 seconds). The host retry passed all 32 tests/69 assertions. These outcomes explain which work was measured, not a proven root cause for the host's behavior.

An earlier optimized run failed in 1921.38 seconds because of the facts-line barrier mistake corrected in D9; it also recorded a worktree Git ref-lock failure. It is retained as failed evidence, not substituted for the corrected after result.

### Changed files, first attempts

All values below are seconds. The failed manager attempt is shown, not replaced with its faster retry.

| Test file | Before wall | After wall | Before CPU | After CPU |
| --- | ---: | ---: | ---: | ---: |
| `daemon/test/plugins/cli-catalog.test.ts` | 0.408 | 0.327 | 0.095 | 0.093 |
| `daemon/test/plugins/scheduler.test.ts` | 15.510 | 14.518 | 0.142 | 0.164 |
| `daemon/test/plugins/scripting-cli.test.ts` | 2.218 | 1.892 | 2.173 | 1.892 |
| `daemon/test/server.test.ts` | 0.325 | 0.162 | 0.073 | 0.047 |
| `pty-host/test/clear.test.ts` | 4.176 | 3.748 | 0.908 | 0.855 |
| `pty-host/test/manager.test.ts` (failed after attempt) | 20.747 | 331.574 | 4.890 | 319.880 |
| `pty-host/test/process.test.ts` | 3.695 | 3.125 | 1.794 | 1.578 |
| `quirky.agents/test/core/shell.test.ts` | 0.155 | 0.155 | 0.012 | 0.012 |
| `quirky.terminal/test/e2e/floating.test.ts` | 5.032 | 4.368 | 5.035 | 4.578 |
| `quirky.terminal/test/e2e/groups.test.ts` | 5.981 | 5.138 | 7.424 | 6.334 |
| `quirky.terminal/test/e2e/quick-commands.test.ts` | 7.327 | 6.752 | 6.476 | 6.017 |
| `quirky.terminal/test/e2e/workspace.test.ts` | 7.403 | 5.856 | 7.238 | 5.914 |

The eleven changed files that passed initially total 52.231→46.041 wall seconds and 31.370→27.485 CPU seconds. That bounded subset is 11.85% lower in summed wall and 12.38% lower in attributable CPU; it does not erase the manager failure or establish a whole-suite improvement. The remaining per-file measurements are retained in the complete profiles.

## Progress
Implementation, real CLI/daemon/PTY smoke, corrected full-suite measurement, one integration catch-up, affected suites, scripts and typecheck completed. Final corrected measured suite passed with two explicitly reported isolated retries; integrated affected suite passed with one host retry; scripts passed unchanged after its isolated cleanup check. No unstarted review is required under incoming LOOP.md:61-65. Ready for step 7: commit this log, detach, run `queue.ts land fix-test-cost`, and wait for its integration gate. All implementers and verification jobs have returned; owned smoke processes/homes and throwaway scripts are removed. No product shell/UI behavior, protected loop code, real user state, main branch or remotes changed.

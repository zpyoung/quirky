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

## Progress
Claimed on lane 10; clean branch created from build/roadmap. Root-cause survey underway. Next: capture baseline wall and per-file CPU, optimize safe fixtures/waits using at most three implementers, catch up once, run scoped verification and final cross-family review, then land. No user questions, real user state, protected loop edits or shared queue edits.

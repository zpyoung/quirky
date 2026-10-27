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

## Progress
Step 2: CPU-load reproduction confirmed hook timeout and cross-test ECONNRESET cascade (D4). GuardianRegression authored a deterministic 4.5-second guardian identity-lookup delay test; parent requested narrowing cleanup to the guardian PID written by its private shim. Run that regression red before changing the four-second bootstrap deadline. LSP references attempted but no language server is available.

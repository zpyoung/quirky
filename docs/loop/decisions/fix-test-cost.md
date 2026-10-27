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

## Progress
Claimed on lane 10; clean branch created from build/roadmap. Root-cause survey underway. Next: capture baseline wall and per-file CPU, optimize safe fixtures/waits using at most three implementers, catch up once, run scoped verification and final cross-family review, then land. No user questions, real user state, protected loop edits or shared queue edits.

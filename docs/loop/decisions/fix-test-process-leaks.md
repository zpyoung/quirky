# fix-test-process-leaks decisions

## D1: Treat test subprocess ownership as the fix boundary
- **Question:** Should a PTY host always exit when quirkyd dies?
- **Options:** remove production detachment; give test/UI runs explicit bounded ownership while preserving production adoption.
- **Chose:** preserve production PTY persistence and investigate explicit test-run ownership.
- **Why:** The queue item concerns leaked test processes; production terminals must survive runtime crashes and upgrades.
- **Evidence:** docs/architecture.md:39-51; queue item fix-test-process-leaks title.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a test-owned host cannot be distinguished safely from a production host.
- **Source:** locked by docs/architecture.md

## D2: Use OpenAI implementers and Gemini review
- **Question:** Which cross-family reviewer is reachable on this omp lane?
- **Options:** Opus; another authenticated non-OpenAI family.
- **Chose:** task subagents implement; pi-watch gemini reviews.
- **Why:** pi-watch --check opus returned exit 5, no authenticated/shipping model; pi-watch --check reports Gemini available and all Anthropic aliases unavailable.
- **Evidence:** preflight commands in this iteration, 2026-10-27.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini review dispatch fails.
- **Source:** assumed — autonomous

## D3: Fix item skips brainstorming and specs
- **Question:** Does this repair require the feature-spec workflow?
- **Options:** full feature workflow; fix-item workflow.
- **Chose:** systematic debugging and test-first repair, then verification and land.
- **Why:** Its id starts with fix-; LOOP.md explicitly directs that path.
- **Evidence:** docs/loop/LOOP.md:153-165.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the item requires changing a locked product decision.
- **Source:** locked by docs/loop/LOOP.md

## D4: Own disposable runs with an external process-scope guardian
- **Question:** How can cleanup still run after SIGKILL of the test worker?
- **Options:** exit hooks only; tie production host to daemon; test-only detached guardian with explicit home and process registration.
- **Chose:** shared ProcessScope with a guardian, transactional harness startup, and awaited full-tree cleanup.
- **Why:** SIGKILL cannot execute an exit hook. The lock tests start detached fake hosts but kill only their daemon; terminal e2e has exit hooks but no hard-death protection. A separate owner preserves daemon-restart tests and production adoption.
- **Evidence:** packages/daemon/test/lock.test.ts:100-150; packages/daemon/test/helpers.ts:62-102; plugins/quirky.terminal/test/e2e-support.ts:112-138; packages/daemon/src/pty-client.ts:409-419.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a scope can signal a process outside its registered roots/private home.
- **Source:** assumed — autonomous

## D5: Add an owned CLI launch for unattended web passes
- **Question:** Which repository harness owns the like-a-user daemon?
- **Options:** manual kill instructions; an owned-command wrapper using the same guardian as tests.
- **Chose:** add an explicit temporary-home command wrapper and document it for web passes.
- **Why:** LOOP.md specifies an externally started daemon, not a repository UI launcher; the desktop guide currently relies on manual PID cleanup, which does not run after a killed pass.
- **Evidence:** docs/loop/LOOP.md:124-131; apps/desktop/README.md:45-61.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a dedicated UI pass launcher supersedes it.
- **Source:** assumed — autonomous

## D6: Keep UI and native product behavior unchanged
- **Question:** Does this repair need product UI or native-window acceptance scenarios?
- **Options:** change persistent service lifetimes; limit changes to disposable verification launch and test harnesses.
- **Chose:** no product UI or native scenarios; verify the owned launcher through the real daemon and CLI.
- **Why:** This item repairs process ownership, not the UI. The smoke launched real quirkyd and quirky-pty under owned-run, ran JSON status successfully, SIGKILLed the wrapper and observed both processes gone and its home removed.
- **Evidence:** actual owned-run smoke in this iteration; terminal hard-killed owner regression passed with a real shell after previously timing out.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a product UI behavior changes.
- **Source:** assumed — autonomous

## D7: The test guardian requires POSIX process inspection
- **Question:** Which platforms does the independent process-tree owner support?
- **Options:** implement Windows job objects now; use POSIX ps/process-group signaling for the macOS build and Linux remote test host.
- **Chose:** POSIX inspection and group signaling; Windows needs a native process-tree/job-object implementation before its test runs.
- **Why:** macOS is the locked build platform and Linux runs the remote suite. Numeric PIDs without process identity or a tree owner are not an acceptable Windows substitute.
- **Evidence:** scripts/test-support/process-scope.ts processSnapshot, processEnvironment and signalRecords.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Windows becomes a supported build/test platform.
- **Source:** deferred: platform

## D8: Preserve incoming integration decisions
- **Question:** Do the catch-up changes alter this ownership repair?
- **Options:** change the SC-31 contract or PTY collector repair; retain the landed changes.
- **Chose:** retain all incoming changes without altering their contracts.
- **Why:** Catch-up merged the SC-31 decision log and a repaired PTY kill-test replay race. Neither changes process ownership. SC-31 correctly allows the ordinary first shell while suppressing setup; its blocked full-suite evidence is not proof of a process-group bug.
- **Evidence:** docs/loop/decisions/fix-sc31-first-shell-race.md D2-D6; docs/loop/BLOCKERS.md final unblocked note; merged packages/pty-host/test/host.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** fresh suite output demonstrates a conflicting lifecycle contract.
- **Source:** locked by docs/loop/decisions/fix-sc31-first-shell-race.md

## D9: Final cross-family review returned no actionable findings
- **Question:** Which Final Round 1 findings need a fix batch?
- **Options:** accept evidence-backed findings; manufacture extra changes despite no findings.
- **Chose:** no fix batch; rerun the build and required checks on the integrated branch.
- **Why:** pi-watch Gemini reviewed build/roadmap...HEAD read-only and returned STATUS: PASS with no actionable file:line findings. This records the review outcome, not a completeness guarantee.
- **Evidence:** actual pi-watch --check gemini and --alias gemini review dispatch, exit 0, STATUS: PASS; Opus availability failure recorded in D2.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** verification exposes a lifecycle race the review missed.
- **Source:** assumed — autonomous

## D10: Guardian control state must outlive the resource home
- **Question:** Why did the first full-suite run fail the socket replacement scenario?
- **Options:** reorder one test; suppress ENOENT; move guardian records/control files to an independent private temporary directory.
- **Chose:** independent guardian state plus a regression that removes a caller-owned home before scope cleanup.
- **Why:** Harness cleanup legitimately removes its home before an enclosing process scope ends. Keeping the only process identities and dispose channel under that home loses ownership state. The failure was reproduced as ENOENT at the dispose-file write; no error is suppressed.
- **Evidence:** initial full suite: 407 remote files, 405 passed, 2 failed; socket.test.ts SC-4 and artifact://33; new state-lifetime regression failed at the same write before the fix. The other failure was the pre-catch-up PTY replay race, already repaired upstream and verified by a passing remote host.test.ts run.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** deleting the disposable home can still erase ownership records or prevent guardian exit.
- **Source:** assumed — autonomous

## D11: Scope every suite subprocess, including transport commands
- **Question:** Does the suite runner own only bun-test children?
- **Options:** leave SSH/rsync subprocesses unowned; use the same process-scope boundary for every asynchronous exec.
- **Chose:** make exec own a scope by default, including remote transport commands.
- **Why:** A killed local suite must not leave its SSH transport running while test subprocess launches are protected. The remote worker retains its existing per-test ownership.
- **Evidence:** scripts/suite.ts exec and runRemote.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a transport requires a lifetime longer than its exec call.
- **Source:** assumed — autonomous

## D12: Retain the runner's existing isolated-rerun policy
- **Question:** Does a load-only floating-window failure require another repair in this item?
- **Options:** change the floating-window behavior; retain the runner's established one-file isolated rerun.
- **Chose:** retain the existing policy and report the flake without claiming a first-pass clean run.
- **Why:** The repaired full suite exited 0. Its one initial failure was SC-55's floating-workspace button under load; the runner's automatic isolated rerun passed all five tests. No test was excluded or suppressed.
- **Evidence:** repaired bun run test, 407 remote files: 406 initially passed, 1 failed then passed alone; 3 macOS-only files passed. suite-result ok:true, flaky:[plugins/quirky.terminal/test/e2e-ui/features-floating.test.ts].
- **Reversibility:** easy
- **Confidence:** high for the observed result; no claim of eliminating the unrelated load sensitivity
- **Revisit if:** the file fails its isolated rerun or a deterministic ownership regression appears.
- **Source:** locked by scripts/suite.ts

## Verification
- `bun run test`: exit 0 after the guardian-state repair and integration catch-up. 407 remote files plus 3 macOS-only files; the floating-window file passed the runner's isolated rerun (D12).
- `bun test scripts`: 48 pass, 0 fail, 217 assertions across 6 files. Inner suite fixtures intentionally print their own failed-test examples while the outer suite passes.
- `bun run typecheck`: exit 0, no diagnostics.
- `bun run build`: exit 0; packaged app built. Electrobun reported its optional missing icon source and unset release base URL.
- Regression red/green: failed harness startup left its fake PTY socket bound before the fix; daemon-stop failure skipped fake-host cleanup before the fix; hard-killed real harness owner left daemon/host/shell alive before the fix; suite completion left a detached worker alive before the fix. All now pass.
- Guardian state regression: deleting the registered caller home produced ENOENT at dispose before the fix; all 5 process-scope tests now pass, including full-tree and guardian exit after home removal.
- Targeted remote checks: daemon socket.test.ts and PTY host.test.ts each passed without a flaky rerun after their respective repairs.
- Actual CLI smoke repeated after the final guardian-state fix: start real quirkyd/quirky-pty through owned-run, run JSON status (exit 0), SIGKILL the wrapper, observe both services gone and the fresh home removed. No real profile used.
- Final Round 1: cross-family Gemini read-only review returned no actionable findings. No unresolved review findings to append to BLOCKERS.md.

## Progress
Verified and ready to land this one item. All agents and verification commands have returned. Commit the final guardian-state repair, suite transport ownership and this log, detach, then run queue.ts land fix-test-process-leaks; its integration gate must pass before the item is marked done.

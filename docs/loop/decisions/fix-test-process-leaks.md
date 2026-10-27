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

## Progress
Implementation and targeted regression checks are complete. `bun test scripts` passed 47 tests; `bun run typecheck` passed. The real owned-run smoke ran JSON CLI status, SIGKILLed its wrapper, and observed real daemon/PTY exit plus home removal. `start-harness.test.ts` passed both failure-cleanup regressions; terminal hard-killed owner and CLI restart regressions passed. Full remote-aware suite is running. Next: catch up with build/roadmap, read incoming decisions, final Gemini review and accepted fix batch, final required checks, then land.

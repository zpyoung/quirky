# fix-sc31-first-shell-race decisions

## D1: Follow the fix-item workflow without new feature specs
- **Question:** Does this regression repair require brainstorming and feature specs?
- **Options:** repeat the feature workflow; follow the fix-item exception.
- **Chose:** use systematic debugging and test-driven repair, then verification and landing.
- **Why:** this queue item starts with `fix-` and names one existing SC-31 regression.
- **Evidence:** docs/loop/LOOP.md:153-165; queue item fix-sc31-first-shell-race.
- **Reversibility:** easy (workflow only)
- **Confidence:** high
- **Revisit if:** investigation identifies an unspecified feature rather than an existing regression.
- **Source:** locked by docs/loop/LOOP.md

## D2: Skipping setup does not suppress the window's normal first shell
- **Question:** Is the automatically opened shell or the SC-31 zero-session assertion wrong?
- **Options:** disable the first shell after Skip for now; assert that setup did not run while allowing the ordinary shell.
- **Chose:** preserve the first shell and correct the regression's contract.
- **Why:** the feature document explicitly says a new active workspace opens a terminal, while Skip for now suppresses the Setup tab and setup-file side effect only. The reported Linux race is accepted failure evidence; it is not rerun merely to reconfirm.
- **Evidence:** external research/orca-features/worktrees.md:96-109; plugins/quirky.worktree/test/window-create.test.ts:310-342; queue title records 6/10 failures on the Linux test host.
- **Reversibility:** easy (test-only correction)
- **Confidence:** high
- **Revisit if:** tracing shows setup running despite the explicit skip choice.
- **Source:** locked by /Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/worktrees.md

## D3: Wait for the terminal override's ensured shell before asserting setup was skipped
- **Question:** Which completion condition makes the formerly racy assertion meaningful?
- **Options:** fixed delay; check immediately after dialog closure; wait for activation and the ordinary shell.
- **Chose:** wait for the real window's activation and automatically created ordinary shell, then assert no Setup session and no setup side effect.
- **Why:** `quirky.terminal` overrides `view:quirky.session/worktree` (m1-term-ui D6). Its controller starts with `load(true)` for a nonfloating workspace and requests `quirky.terminal/workspace` with `ensure:true`. LayoutService reconciles existing sessions, then creates a first shell when no tab exists. Dialog closure does not await this independent sequence. The old zero-session assertion mistakes that valid shell for setup execution.
- **Evidence:** plugins/quirky.terminal/quirky-plugin.json:17-20; plugins/quirky.terminal/src/window/workspace/controller.ts:201-217,251-257; plugins/quirky.terminal/src/layout/service.ts:393-401; docs/loop/decisions/m1-term-ui.md D6, D10, D11, D35; docs/loop/decisions/m1-worktrees.md D30, D31.
- **Reversibility:** easy (test synchronization only)
- **Confidence:** high
- **Revisit if:** the first-shell ensure contract changes.
- **Source:** locked by docs/loop/decisions/m1-term-ui.md

## D4: Keep the fake PTY boundary explicit in the script side-effect assertion
- **Question:** How can the positive setup path prove the sentinel script works?
- **Options:** wait for the fake PTY to execute it; execute the generated setup runner as existing setup tests do.
- **Chose:** use the existing generated-runner execution pattern for the positive branch; inspect no Setup session and no sentinel for the skipped branch.
- **Why:** startHarness uses a fake PTY that records requests but does not run shell commands. Waiting for it to write a file would time out rather than test setup behavior.
- **Evidence:** packages/daemon/test/helpers.ts:62-76; plugins/quirky.worktree/test/setup.test.ts:31-35,57-67.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the window test harness switches to real PTYs.
- **Source:** assumed — autonomous

## D5: Record the guarded browser smoke as tool-blocked, not passed
- **Question:** How should the unattended web result be classified when the driver cannot reveal the lower setup controls?
- **Options:** claim a pass from the headless test; label the app broken; record the guarded run's tool limitation separately.
- **Chose:** record both browser goals as tool-blocked under LOOP.md:130-131; retain the passing headless real-daemon regression as separate evidence.
- **Why:** the browser showed disabled Create and the setup-choice hint. Expanding Advanced put the setup choices below the 720px viewport. Two guarded ref-targeted scrolls and the PageDown alternate returned NO_EFFECT. The guarded web driver's `_scroll_steps` ignores `--ref` and only moves the mouse when coordinates are supplied; the skill prohibits coordinate targeting on a nonsparse tree. No evidence establishes an app defect.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T132828-b991/report.md; obs-2.png (disabled Create), obs-7.png (F1); using-apps-like-a-user/scripts/_web.py:384-396. Report: setup-choice blocked, skip-setup blocked, one tool finding F1, no test overrides, no console/network errors. The guarded report initially retained browser session `20261027T132828-b991`; post-report cleanup closed that owned session successfully. The isolated daemon stopped (exit 0) and deleted its temporary home. Temporary smoke script and goals file were removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the guarded driver's scroll targeting supports element refs or the viewport is configurable.
- **Source:** assumed — autonomous

## D6: Preserve the repaired item and block on the failing required full-suite gate
- **Question:** Can the item land after its regression passes but the required suite fails elsewhere?
- **Options:** bypass the failing PTY test; expand this item into PTY lifecycle/test repairs; block with evidence and preserve the completed correction.
- **Chose:** block at step 6 without attempting a noncompliant land.
- **Why:** LOOP.md requires the full suite to pass. The runner already retried the PTY file alone and failed at the same child-output wait. A separate remote run of the entire changed window-create file passed without a flaky rerun. Read-only diagnosis found no dependable environment-only remedy. Lane 7 owns `fix-test-process-leaks` across PTY/harness files; this item is the SC-31 setup/ordinary-shell oracle correction, not an authorization to alter other test contracts or add exclusions.
- **Evidence:** full suite artifact://26 (407 files, 404 passed, 3 failed; isolated PTY rerun 31 pass, 1 fail, 1 error); `bun scripts/suite.ts plugins/quirky.worktree/test/window-create.test.ts` (1 remote file passed, no flaky rerun); packages/pty-host/test/host.test.ts:21-27,422-430; packages/pty-host/src/session.ts:752-761.
- **Reversibility:** easy (restore the preserved branch once the gate is repaired)
- **Confidence:** high for the gate failure; medium for its cause
- **Revisit if:** the required full suite passes.
- **Source:** locked by docs/loop/LOOP.md

The PTY failure diagnosis is [INFERENCE]: the collector sees live DATA only, while the test discards subscribe's replay. Output printed between create and subscribe can be in replay but absent from the collector. The timeout occurs before the test issues kill; it does not demonstrate a process-group termination failure. `/bin/sh` is explicit, so no evidence supports a login-shell environment workaround.

## D7: Resume the preserved correction after integration repairs
- **Question:** Does the current integration change SC-31's contract or require a new implementation?
- **Options:** repeat the repair; retain it and rerun the required gate after catch-up.
- **Chose:** retain the test-only correction and merge `build/roadmap`.
- **Why:** the catch-up includes the PTY replay fix and process-scope ownership repair. Read both incoming logs: fix-test-process-leaks preserves normal terminal lifetimes and SC-31's first-shell contract; m2-sidebar-extras is blocked with its implementation unlanded. Neither changes the setup choice. The scout independently traced the ensured-shell path and found no new repair needed.
- **Evidence:** integration merge output (44 files); docs/loop/decisions/fix-test-process-leaks.md D8, D10-D12; docs/loop/decisions/m2-sidebar-extras.md D22-D24; Sc31Contract investigation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the caught-up regression or required suite fails.
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D8: Use Gemini for the resumed final review
- **Question:** Which independent reviewer is reachable, and which findings need a fix batch?
- **Options:** Opus; the next reachable cross-family reviewer.
- **Chose:** Gemini through pi-watch; no fix batch because the narrow test review returned no actionable findings.
- **Why:** Opus preflight returned exit 5; Gemini resolved google/gemini-3.1-pro-preview:high and returned STATUS: PASS. Its statement that catch-up changed only queue/README repeats the old log and is stale; D7 records the actual incoming files and decisions. The inspected SC-31 code and fake-PTY boundary were current.
- **Evidence:** actual pi-watch preflights and read-only final review, exit 0; plugins/quirky.worktree/test/window-create.test.ts:310-352.
- **Reversibility:** easy
- **Confidence:** medium (review is not runtime proof)
- **Revisit if:** verification exposes a missed integration issue.
- **Source:** assumed — autonomous

## D9: Prove the skip/ordinary-shell contract with real CLI and PTY processes
- **Question:** What runtime smoke covers the repaired assertion without another permanent test?
- **Options:** rely only on the headless regression; exercise the public CLI with real quirkyd and an owned temporary home.
- **Chose:** create a Git project, set setup policy to ask with a sentinel script, create through `quirky wt create --setup skip`, ensure the terminal workspace through the public API, and inspect sessions.
- **Why:** the smoke observed an ordinary shell in the created worktree, no Setup session, and no sentinel. ProcessScope cleanup removed the private home and owned processes. No product UI changes were made; D5's guarded web report remains tool-blocked rather than being relabeled as passing.
- **Evidence:** isolated smoke exit 0: worktree wt_ad89b5a84901, shell s_4ce87cdafecc, setupSession:false, setupSentinel:false, cleaned:true; resumed SC-31 test 1 pass/0 fail/11 assertions. The throwaway script was removed.
- **Reversibility:** easy
- **Confidence:** high for the exercised CLI/API path; the guarded visual limitation remains D5.
- **Revisit if:** setup choice or first-shell behavior changes.
- **Source:** assumed — autonomous

## D10: Retain the suite's existing isolated-rerun policy
- **Question:** Can the repaired item land when an unrelated file passes only its built-in isolated rerun?
- **Options:** change unrelated PTY behavior; retain the runner's existing policy and report the load-sensitive failure.
- **Chose:** retain the policy; proceed to the landing gate without exclusions or timeout changes.
- **Why:** `bun run test` exited 0. Of 408 remote files, 407 passed initially; PTY manager's raw-attach test timed out under load, then the whole file passed all 50 tests alone. Both macOS-only files passed. The SC-31 file now runs remotely, not in the macOS exception list.
- **Evidence:** resumed required suite, 442.85 seconds; suite-result {"ok":true,"flaky":["packages/pty-host/test/manager.test.ts"]}; artifact://17.
- **Reversibility:** easy
- **Confidence:** high for the observed result; no claim that the independent load sensitivity is fixed.
- **Revisit if:** the file fails the runner's isolated rerun.
- **Source:** locked by scripts/suite.ts

## Verification before the initial block
- `bun test plugins/quirky.worktree/test/window-create.test.ts --test-name-pattern 'SC-31'`: 1 pass, 0 fail, 15 filtered, 11 assertions. Exercises the real daemon API and rendered headless window, automatic first-shell creation, run-script sentinel and skip behavior. React emitted synchronous-unmount warnings during harness teardown.
- `bun run build`: exit 0; packaged app built. Electrobun reported the missing optional icon source and unset release base URL.
- Integration catch-up: `git merge build/roadmap` fast-forwarded to `9af0ad4`; only docs/loop/README.md and queue.json changed, no new decision logs.
- `bun run test`: failed on the remote Linux host. Initial run: 407 files, 404 passed, 3 failed. `packages/pty-host/test/host.test.ts:422-430` timed out waiting for `child=(digits)` before the kill request; the suite's isolated rerun failed the same way (31 pass, 1 fail, 1 error). The other initial failures were `plugins/quirky.git/test/ui/panel-layout.test.ts` capped-status timeout and `plugins/quirky.worktree/test/window-projects.test.ts:281` stale group report; the runner stopped rerunning when the PTY file failed. Full output: artifact://26.
- `bun test scripts && bun run typecheck`: exit 0; scripts 41 pass, 0 fail, 187 assertions; TypeScript no diagnostics. Fixture subprocesses intentionally printed failing tests while the outer scripts suite passed.
- Read-only final review (`ReviewSkipRepair`): no actionable findings; approved the fake-PTY runner pattern, explicit activation/ordinary-shell barrier and removal of the macOS exception. No fix batch needed.
- `bun scripts/suite.ts plugins/quirky.worktree/test/window-create.test.ts`: 1 file passed on the Linux host, 0 failed, 0 macOS-only files, no flaky rerun (`suite-result {"ok":true,"flaky":[]}`).

## Verification after resuming
- `bun test plugins/quirky.worktree/test/window-create.test.ts --test-name-pattern SC-31`: 1 pass, 0 fail, 11 assertions; real daemon and mounted headless window. React teardown synchronous-unmount warnings remain.
- `bun run test`: exit 0; 408 remote files and 2 macOS-only files. PTY manager passed its isolated rerun (D10). SC-31's file passed remotely.
- `bun test scripts && bun run typecheck`: exit 0; scripts 48 pass, 0 fail, 217 assertions; TypeScript no diagnostics. Inner script-runner fixtures intentionally printed failed-test examples.
- `bun run build`: exit 0; packaged macOS app. Optional missing icon source and unset release base URL warnings remain.
- Real public CLI/PTY smoke: normal first shell exists after explicit setup skip; no Setup session or sentinel; fresh home removed after owned cleanup (D9).
- Final Round 1: Gemini read-only review returned STATUS: PASS and no actionable findings (D8). No fix batch or unresolved review findings.

## Progress
Step 6 passed after integration catch-up; ready for step 7. Commit this log, detach, then run `queue.ts land fix-sc31-first-shell-race`; its integration gate must pass before the item is marked done. All agents and verification jobs have returned, smoke processes were stopped and temporary files/home removed. No production API/callsite changes or open review findings. The inherited `.serena/` directory remains uncommitted and untouched.

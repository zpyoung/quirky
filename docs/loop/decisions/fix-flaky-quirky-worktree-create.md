# fix-flaky-quirky-worktree-create decisions

## D1: Diagnose this explicitly queued flaky-test repair on the configured remote host
- **Question:** How should the fix item reconcile its explicit remote reproduction requirement with build-first defaults?
- **Options:** skip execution until triage; follow the claimed fix item's explicit reproduction instructions
- **Chose:** follow the fix item's explicit remote reproduction instructions, without artificial CPU load on the Mac
- **Why:** the queue specifically requests systematic debugging and `bun scripts/suite.ts plugins/quirky.worktree`; a timing repair needs evidence rather than an arbitrary timeout increase
- **Evidence:** queue wait returned `fix-flaky-quirky-worktree-create`; `.git/build-loop/flakes.log` records repeated create.test.ts failures; configured suite run announced 44 remote files and zero macOS-only files
- **Reversibility:** easy (verification choice only)
- **Confidence:** high
- **Revisit if:** the queue owner removes the explicit repair requirement
- **Source:** assumed — autonomous

## D2: Investigate the background-fetch completion assertion without changing production semantics
- **Question:** Which concrete timing assumption warrants a controlled reproduction?
- **Options:** increase all test timeouts; alter production create to await background refresh; deterministically delay the real fetch and inspect the existing completion assertion
- **Chose:** controlled delay of the existing real-Git fetch seam, then completion-gated verification if reproduced
- **Why:** create.test.ts polls synchronous Git every 10ms for at most five seconds, while existing-base refresh is deliberately background work. The file's overall timeout is 60 seconds. Historical flakes.log contains filenames and timestamps, not assertion output; it does not establish the exact historical failing assertion.
- **Evidence:** `plugins/quirky.worktree/test/create.test.ts:411-420`; `plugins/quirky.worktree/src/daemon/base.ts:85-91`; `packages/daemon/test/helpers.ts` waitFor; neighboring refresh tests already use `useTestGit` and promise gates
- **Reversibility:** easy (test synchronization only)
- **Confidence:** medium
- **Revisit if:** controlled delayed-fetch execution fails at another boundary or preserved historical assertion evidence identifies another cause
- **Source:** assumed — autonomous

## D3: Await the real fetch promise and gate refresh release after creation
- **Question:** How should the reproduced test deadline be removed while retaining behavioral coverage?
- **Options:** extend the five-second poll; await real fetch completion only; explicitly hold fetch until create returns, assert the stale commit, then release and await real completion
- **Chose:** a promise gate around the existing real `fetchRemote`, preserving the daemon API and actual Git operations
- **Why:** controlled remote execution with a temporary 5.5-second fetch delay failed at the original `waitFor` deadline twice (41 pass/1 fail each), then passed with the identical delay when the assertion awaited the fetch promise. The permanent test removes that diagnostic sleep entirely, proves create returns while refresh is held, checks the created HEAD and remote ref still equal the stale commit, and checks the exact new remote commit after release. Finally releases/drains the fetch and restores the global Git seam even when it rejects.
- **Evidence:** `plugins/quirky.worktree/test/create.test.ts:411-444`; remote `bun scripts/suite.ts plugins/quirky.worktree/test/create.test.ts` returned `suite-result {"ok":false,"flaky":[]}` with the original poll plus diagnostic delay, then `{"ok":true,"flaky":[]}` with promise completion and the same delay, and again with the permanent timer-free gate
- **Reversibility:** easy (one existing regression scenario; no public or production contract change)
- **Confidence:** high
- **Revisit if:** retained historical assertion output identifies additional independent causes or the nonblocking refresh contract changes
- **Source:** assumed — autonomous

## D4: Retain package baseline failures for the existing end-phase owner
- **Question:** What should happen to failures outside the claimed creation-timing regression discovered by the requested baseline command?
- **Options:** expand this repair into all 25 failing files; hide the package result; record the complete inventory and concrete evidence without adding a debugging follow-up
- **Chose:** append the observed baseline failures to BLOCKERS.md, keep this repair on the existing background-refresh assertion, and use the current typecheck landing gate
- **Why:** the initial suite started before this item's edit; its remote attempt failed and the suite automatically ran locally, ending with 19 passing files and 25 failing files. That is not a passing package suite. LOOP assigns remaining suite debugging to its end phase and forbids verification/debugging successor items. The isolated permanent creation regression passed remotely without fallback or flaky rerun. Scripts passed 81/81 and typecheck passed root/mobile/desktop.
- **Evidence:** `docs/loop/BLOCKERS.md` section `fix-flaky-quirky-worktree-create: baseline suite failures retained for end-phase triage`; `bun scripts/suite.ts plugins/quirky.worktree` exit 1; final focused `suite-result {"ok":true,"flaky":[]}`; `bun test scripts` 81 pass/0 fail/820 assertions; `bun run typecheck` exit 0
- **Reversibility:** easy (evidence routing only; no failing scenario suppressed or changed)
- **Confidence:** high
- **Revisit if:** an observed package failure is demonstrated to be introduced by this test-only change
- **Source:** locked by docs/loop/LOOP.md

## D5: Migrate the shared fixture to the newly required runtime dependency after catch-up
- **Question:** Why did the post-merge creation file fail before reaching the regression, and should its assertions be bypassed?
- **Options:** ignore the new failures; remove the production dependency; install the real required CLI plugin in worktree test worlds
- **Chose:** preserve the real worktree dependency on quirky.cli and add that plugin once to the shared harness whenever worktree is selected, including explicit real-session plugin lists
- **Why:** the sole roadmap catch-up introduced `quirky.cli` as a required worktree dependency. The existing fixture linked only repo/worktree or its explicit session list, disabling the worktree plugin: the post-merge remote file returned 1 pass/41 fail at `setting:quirky.worktree/worktreesRoot`, before any creation. Adding the genuine dependency restores activation without a fake setting, altered admission, narrowed assertion or production fallback. Existing creation scenarios themselves provide consumer coverage; no wiring-only test was added.
- **Evidence:** `plugins/quirky.worktree/quirky-plugin.json:12-15`; `plugins/quirky.repo/test/harness.ts:123-134`; post-merge remote run `1793222299634-12034`; corrected focused remote run passed with `suite-result {"ok":true,"flaky":[]}`, 21.83s; final root/UIlint/mobile/desktop typecheck exited 0, 30.29s
- **Reversibility:** easy (test-world dependency installation only)
- **Confidence:** high
- **Revisit if:** the production worktree dependency declaration changes
- **Source:** locked by docs/loop/decisions/m7-terminal-owner-provisioning-and-selector-flows.md D2,D14

## Progress
Repair committed initially as f99a1510, then caught up once with build/roadmap. Read the four incoming logs completely: fix-flaky-pty-host-manager, fix-flaky-terminal-features-pane, m7-terminal-owner-provisioning-and-selector-flows, ui-screenshot-review (including truncated evidence/progress lines). Their condition-based synchronization and owner boundaries do not conflict. The newly required CLI dependency needed the fixture migration in D5; the final caught-up creation file passes remotely without fallback or flaky rerun, and fresh final root/UIlint/mobile/desktop typecheck passes. Scripts passed 81/81 before catch-up; not claimed rerun against the newly merged UI review tests. Broad baseline failed 25/44 files, retained in BLOCKERS.md. All jobs/scout returned; no owned scratch, worktree, daemon or service was created outside test-runner-managed scopes. Ready to commit final fixture/receipt, detach and canonical queue land. No production/public API change or UI/native scenario added.

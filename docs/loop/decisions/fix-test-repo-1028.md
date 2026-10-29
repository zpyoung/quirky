# fix-test-repo-1028 decisions

## D1: Repair only demonstrated repository removal and hook-contract failures
- **Question:** Which failures and workflow does this iteration own?
- **Options:** repair the named repository area; expand into unrelated plugins.
- **Chose:** the named repository area, with current canonical coverage and ownership coordination for any cross-plugin failure.
- **Why:** the authoritative queue item lists project/repository/CLI removal failures and an incidental hooks-default assertion from baseline 97aaa12d.
- **Evidence:** docs/loop/reports/m7-test-triage.json; authoritative queue wait --lane 10, iteration 20.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current evidence identifies a defect in a shared owner.
- **Source:** locked by docs/loop/LOOP.md

## D2: Keep all process fixtures isolated and run tests through the canonical suite
- **Question:** How should checks avoid the overloaded shared Mac and real state?
- **Options:** direct local suites; canonical remote suite with documented macOS exceptions.
- **Chose:** bun scripts/suite.ts for every test target; use private HOME and QUIRKY_HOME for smoke processes and clean them up.
- **Why:** the operator's recorded remote-test rule and the loop's process-isolation requirement bind this iteration.
- **Evidence:** .orca/loops/omp-until-done-50bc6f72/notes.md iteration 13 operator rule; docs/loop/LOOP.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a target is explicitly native/macOS-only.
- **Source:** locked by docs/loop/LOOP.md

## D3: Register the existing worktree ownership provider, without a removal fallback
- **Question:** What breaks every named project/repository/CLI removal?
- **Options:** bypass ownership lookup; invent an alias; register the already-declared existing implementation.
- **Chose:** add `ownedIds` to the worktree handler table.
- **Why:** canonical baseline coverage reproduces all named removal failures with `quirky.worktree did not provide method:quirky.worktree/ownedIds`. Its implementation already preserves recorded vanished worktrees and exact repository ownership, but the table-driven provider loop never registered it.
- **Evidence:** plugins/quirky.worktree/main.ts ownedIds and handlers; plugins/quirky.repo/src/projects.ts closeSessions; canonical 7-file run artifact 5; corrected 9-file run artifact 9.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** runtime evidence shows an ownership error after the provider is reachable.
- **Source:** locked by docs/loop/decisions/m1-worktrees.md D48

## D4: Delete the stale empty-hook shape mirror and exercise CLI removal through the real process
- **Question:** Should default fields and output copy be repinned to make the tests pass?
- **Options:** update object inventories and exact output strings; remove incidental mirrors and retain behavioral coverage.
- **Chose:** delete the no-file/default hook-object assertion and migrate removal coverage to real CLI state transitions.
- **Why:** the hooks failure is only three additional default fields, not a missing policy behavior. Existing command-source, trust and parsing tests retain meaningful boundaries. The operator explicitly forbids repinning incidental copies/default inventories.
- **Evidence:** plugins/quirky.repo/test/hooks.test.ts baseline exact shape; canonical artifact 5; queue item instructions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a missing-file consumer-visible defect is reported.
- **Source:** assumed — autonomous

## D5: Publish the exact registration checkpoint for the CLI owner
- **Question:** How should lane 8 consume the shared provider fix without competing edits?
- **Options:** independent duplicate repair; committed source checkpoint with no fallback.
- **Chose:** commit this registration and publish the SHA to `/tmp/quirky-lane8-cli-repo-coordination.md`.
- **Why:** lane 8's current canonical CLI suite independently reproduces three v1 repo-rm failures at the same missing provider. Lane 8 owns only CLI text-test migration and will consume the committed source before its final gate.
- **Evidence:** lane 8 operator interjection iteration 20; current authoritative queue status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** lane 8 reports a different remaining failure.
- **Source:** assumed — autonomous

## D6: Verify real removal with live owned processes and exact surviving identity
- **Question:** What runtime evidence distinguishes successful dispatch from a working removal?
- **Options:** tests only; a fake session echo; private real Git/daemon/PTY/CLI and process liveness checks.
- **Chose:** the real private runtime, including two same-named projects, primary and external worktrees, three physical shell/sleep processes, CLI selector removal, repeated refusal, retained folders/group and re-add with fresh settings.
- **Why:** the final source smoke removes both owned sessions and their actual PIDs while the other exact project/session/PID remains alive. A final explicit close reaps the survivor before daemon/PTY shutdown. The composed repeat exercises the same path after the single catch-up.
- **Evidence:** actual smoke exit0/2.49s before catch-up and exit0/3.96s after; `REPO_REMOVAL_REAL_CLI_PROCESS_SMOKE_OK` and `REPO_REMOVAL_SMOKE_CLEANED`; two owned IDs, second remove exit1, folders retained, fresh settings and all tracked PIDs gone. Scope cleanup observes private-home absence.
- **Reversibility:** easy
- **Confidence:** high for these exercised flows
- **Revisit if:** another exact runtime ownership/removal scenario fails.
- **Source:** assumed — autonomous

- **Fixture failures retained:** first attempt compared macOS `/var` and `/private/var` spellings instead of real paths. The next attempts used a semicolon command without `sh -c`; the launcher prefixes `exec`, so it legitimately exited after `echo` instead of reaching `sleep`. One diagnostic omitted the required PTY read `lines` argument. Corrected only the throwaway harness, not production launch semantics, limits or deadlines. Every failed scope reported cleanup; the passing scopes still log the existing inactive-worktree shutdown warning, not pristine output.

## D7: Preserve the incoming owners and separate exact closure from wider failures
- **Question:** Does the sole roadmap catch-up change repository-removal authority?
- **Options:** duplicate concurrent repair work; override incoming decisions; preserve ownership and report each snapshot separately.
- **Chose:** clean merge after source commits `1fb3789e` and `883a5c7f`; read Hosting D1–D6, Tasks D1–D9 including raw Progress, and Vault D1–D11 plus Progress completely. No conflict with exact project ownership, session teardown or public provider registration.
- **Why:** incoming fixes concern hosting push identity, Tasks fixture/UI boundaries and Vault search/isolation, not this method's contract. Lane 8 reports consuming the exact registration checkpoint by merge and independently passing a private real-source daemon/PTY/Git/CLI live-session removal smoke in5.22s; that is reported coordination evidence, not lane10's own execution.
- **Evidence:** sole clean roadmap merge brought23files; incoming decision logs; `/tmp/quirky-lane8-cli-repo-coordination.md`; operator lane8 receipt. Own final canonical repo+scripts19/19files, zero failures/flaky retries in43.40s, following32.02s before catch-up.
- **Reversibility:** easy
- **Confidence:** high for current owned closure and reported coordination
- **Revisit if:** the controller's merge check or a consumer owner reports an actual contradiction.
- **Source:** assumed — autonomous

## D8: Preserve all26 wider Worktree failures instead of expanding the removal repair
- **Question:** Does the owning plugin's broad red gate justify unrelated changes or a green claim?
- **Options:** expand into every Worktree flow; suppress or omit the red gate; preserve the exact inventory and existing repair ownership.
- **Chose:** preserve all26failed files and concrete boundaries in BLOCKERS.md under this item. Keep `fix-test-worktree-1028`, its lane4 dependency, and lane2's newly reported shared visibleText repair ownership. Do not add a second debugging item.
- **Why:** the full46file snapshot is20pass/26fail328.63s, while all named repository failures and the existing real ownedIds/removal regression are green. The wider failures include fixture dependencies, identity parameters, DOM consumers and shape mirrors; one common cause for all26has not been proven.
- **Evidence:** canonical run1793237394183-79307/artifact12; BLOCKERS exact26file inventory; final owned repo+scripts19/19/no flakes43.40s. Earlier targeted9files8pass1fail25.00s retains three separate Worktree-file failures.
- **Reversibility:** easy
- **Confidence:** high for observed inventory; not a wider root-cause attribution
- **Revisit if:** the existing owner identifies a failure caused by this registration.
- **Source:** locked by queue ownership; assumed — autonomous

## D9: Reconcile independently added registrations to one handler during integration
- **Question:** How should lane2's independently committed identical provider registration combine?
- **Options:** keep duplicate object properties; introduce an alias; retain exactly one existing ownedIds registration.
- **Chose:** exactly one registration. Publish the constraint and checkpoint in `/tmp/quirky-lane2-ledger-repo-coordination.md`; resolve any actual merge-result duplicate without touching Ledger/shared DOM ownership.
- **Why:** lane2 reports899636d6 adds ownedIds after origins; checkpoint1fb3789e already adds it at the start of handlers. They implement the same contract, not two methods. The normal catch-up here happened before Ledger landed.
- **Evidence:** operator lane2 coordination receipt; current owned source registration; lane2 reports owning the shared test/window/dom.ts TEXT_NODE base case while preserving aria-hidden behavior.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the controller combines a different contract or identifies a real merge conflict.
- **Source:** assumed — autonomous

## D10: Bound independent review to the fixed source artifact and report its actual protocol
- **Question:** What assurance did the final review supply?
- **Options:** same-family self-review; unavailable Opus; reachable cross-family Gemini high with fresh promote/refute contexts.
- **Chose:** standard two-stage Google Gemini3.1pro high over the fixed130line patch containing only the owned worktree registration and repo hook/CLI tests. Opus probe exits5; actual Gemini probe resolves. Both actual stage responses are `[]`. Mechanical gate PASS with0blocking/0advisory/0suppressed/0contested, no limitations/questions/excluded/unreviewed paths.
- **Why:** author rationale, decision logs, commit messages and documentation are excluded from the review artifact; only requirements and exercised check facts are supplied. Grant read/grep/find/ls, not shell or writes, to keep this a static review with parent-owned runtime verification. Observed traces contain only reads/searches; no reviewer check or mutation is counted as evidence.
- **Evidence:** artifact594be92a576b180d95d10947d0047ee350f17049f86b8e13fb20e67433bef4f8; run376d3d5c0873f204; actual review106.19s; live typecheck prepass29.414s; claims/merge/gate/manifest and raw promote/refute outputs preserved beside loop notes. Plugin validator independently reports no namespace/schema/public-boundary inconsistency.
- **Reversibility:** easy
- **Confidence:** high for scoped provenance, not completeness beyond the fixed source artifact
- **Revisit if:** an actual consumer or merge-result gate shows a concrete defect.
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Source1fb3789e and883a5c7f complete; sole normal roadmap catch-up and incoming decisions complete. Final canonical repo+scripts19/19/no flakes43.40s, full typecheck29.414s, composed real-process removal smoke3.96s with scope cleanup. Standard two-stage cross-family review PASS/no findings; plugin validator no inconsistency. Wider Worktree46files20pass26fail328.63s remains preserved under its existing owner; not a full Worktree/repository/native acceptance claim. All workers, finite checks, smoke and reviewer jobs returned; no owned runtime/browser/service/component worktree. Next commit final docs/receipts, detach and run the authoritative queue land; wait for actual receipt and resolve any independently duplicated ownedIds registration to exactly one if the controller identifies it. After successful land remove only owned scratch. Exactly one item; no second claim or global completion sentinel.

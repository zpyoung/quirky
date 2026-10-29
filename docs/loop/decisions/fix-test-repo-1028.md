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

## Progress
Registration and hook-mirror correction implemented. Canonical 9-file check: 8 pass, worktree.test.ts fails only its separate SC-43/SC-45 Ask fixture and dependency inventory cases; its real ownedIds/removal regression passes. Current repo-only coverage passes in that snapshot. CLI regression worker owns only plugins/quirky.repo/test/cli.test.ts. Next: publish the exact committed checkpoint to lane 8, finish CLI test migration, actual private Git/daemon/CLI smoke, affected checks/typecheck and final review, single roadmap catch-up/read decisions, then commit/detach/authoritative land. No full worktree-suite pass claimed.

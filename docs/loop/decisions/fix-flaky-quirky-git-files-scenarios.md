# fix-flaky-quirky-git-files-scenarios decisions

## D1: Diagnose the recorded load failure without expanding feature scope
- **Question:** Which workflow and acceptance applies to this fix item?
- **Options:** Rebuild Git file features; trace and repair the recorded scenario flake.
- **Chose:** Trace the scenario and reproduce under owned CPU load before a minimal repair.
- **Why:** The queue explicitly identifies repeated under-load failures followed by isolated passes. Fix items skip brainstorming/specs.
- **Evidence:** docs/loop/LOOP.md:188-200; shared build-loop/flakes.log lists files.test.ts on 2026-10-27 at 13:38, 13:47, 14:53 and 15:28 UTC; the log contains file names only, not assertion output.
- **Reversibility:** easy (test/runtime repair only)
- **Confidence:** high
- **Revisit if:** Reproduction identifies an unrelated feature contract problem.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use a reachable cross-family reviewer
- **Question:** Which reviewer can independently review the OpenAI implementation?
- **Options:** Opus via pi-watch; next authenticated cross-family alias.
- **Chose:** Gemini via `pi-watch --alias gemini`, after Opus and Sonnet preflights failed.
- **Why:** Opus and Sonnet each exited 5 with no authenticated/shipping combinations; Gemini preflight succeeded at `google/gemini-3.1-pro-preview:high`. No login state was changed.
- **Evidence:** Lane 10 iteration 3 preflight tool outputs; skill://pi-dev.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A cross-family alias becomes reachable.
- **Source:** assumed — autonomous

## D3: Stop local load and use the shared test host
- **Question:** Where is contention reproduction allowed after the operator's intervention?
- **Options:** Continue local workers; stop them and run the scoped suite on the busy test host.
- **Chose:** Cancelled the local load job immediately, verified no `git-flake-load` or `/usr/bin/yes` processes remained, and ran `bun scripts/suite.ts plugins/quirky.git/test/scenarios`.
- **Why:** The operator reported another lane drove this Mac to load 346 and explicitly forbade further local load. The shared host already has competing lane runs.
- **Evidence:** Operator intervention in iteration 3; process cleanup returned no matches; shared-host baseline passed 13 files with `flaky: []`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Operator changes the resource policy.
- **Source:** assumed — autonomous

## D4: Establish subscriber receipt by ordered RPC, not elapsed time
- **Question:** How do the file scenarios know synchronous mutation events reached their separate subscriber?
- **Options:** Increase sleeps; poll for a count with a deadline; send an idempotent subscription RPC on the subscribed connection after the mutation.
- **Chose:** Add `Scenario.flushEvents()` using the subscriber's existing `events.subscribe` round-trip, and replace the three 60/80 ms sleeps in files.test.ts.
- **Why:** Git save/ignore handlers emit synchronously before replying. After the mutation reply, the subscription response on the subscriber must follow those earlier event frames. This proves exact counts and absence after a rejected save without an arbitrary delivery deadline. It does not wait for future background work. An initial probe using the legacy typed `status` method failed with MethodNotFound; the existing connection-level subscription RPC is present in this minimal harness and reasserting it does not duplicate its event listener.
- **Evidence:** plugins/quirky.git/src/daemon/files.ts:73-79,106-111; src/daemon/env.ts:129; packages/daemon/src/service.ts:75-82; packages/protocol/src/client.ts:250-261. A throwaway FIFO 250 ms delivery lag on subscribed WebSockets made the unmodified save scenario fail at files.test.ts:42 (expected 2, received 0), while both API writes succeeded; evidence retained beside loop notes as evidence-git-flake/delayed-before-1.log. The busy-host baseline passed; original shared flake log has no assertion output, so identity with those historical failures remains inferred.
- **Reversibility:** easy (test-only helper and synchronization)
- **Confidence:** high for the demonstrated race; medium for attribution to historical flakes
- **Revisit if:** A recorded files.test.ts failure identifies a different assertion, or mutation events become deferred background work.
- **Source:** assumed — autonomous

## D5: Preserve consumer assertions and use controlled latency as red/green evidence
- **Question:** Which regression coverage is appropriate for a test-only synchronization change?
- **Options:** Add tests of helper forwarding; weaken event counts; exercise the existing real daemon/API/CLI scenarios with delayed subscriber delivery.
- **Chose:** Keep all exact-count, file-content, stale-hash, and CLI assertions. Use the unchanged 250 ms subscribed-frame delay for the before/after probe, then run the plugin suite on the busy host and a standalone real daemon/PTY/CLI smoke.
- **Why:** The old save scenario failed expected 2/received 0; after the receipt barrier both affected scenarios pass (2 tests, 14 assertions). The probe adds no CPU load and preserves frame order. A helper-forwarding test would not prove consumer behavior.
- **Evidence:** evidence-git-flake/delayed-before-1.log and delayed-after-subscribe-1.log beside lane 10 notes. `xd://lsp` references was attempted and reported no language server available. Implementation touches only test/scenarios/{fixture,files.test}.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Future asynchronous mutation events require a different explicit completion signal.
- **Source:** assumed — autonomous

## D6: Verify the existing surface without adding UI or feature scope
- **Question:** What runtime proof and integration catch-up apply to a test-only repair?
- **Options:** Rebuild/dogfood unrelated UI; exercise the actual daemon/PTY/CLI file flows and leave product/UI unchanged.
- **Chose:** A standalone smoke used a fresh temporary QUIRKY_HOME and HOME, actual daemon and PTY host, real Git, and real CLI save/stale-save/ignoreFolder operations. Caught up once with build/roadmap before final checks/review; the merge brought only queue additions, no new decisions.
- **Why:** The smoke observed one event after a successful save, no event or write after stale save, and one after ignore-folder, using the same subscriber barrier. No runtime/UI code changes are needed. Existing UI/native acceptance stays intentionally unchanged.
- **Evidence:** evidence-git-flake/runtime-smoke.json beside lane 10 notes; implementation commit 2681291; catch-up merge output lists only docs/loop/queue.json. All owned runtime homes/processes were cleaned; cancelled local load's empty home removed; throwaway probes/smoke scripts removed after preserving results.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Final review or verification reveals a product defect.
- **Source:** assumed — autonomous

## D7: Final verification and cross-family review clear the test-only repair
- **Question:** Does the completed fix satisfy the item's verification and review gate?
- **Options:** Land after observed scoped checks and review; retain as incomplete.
- **Chose:** Land the tested synchronization repair with historical attribution explicitly limited to the available evidence.
- **Why:** The changed Git plugin suite passed all 67 files on the busy test host with no flakes; scripts passed 62 tests / 462 assertions; frozen-install typecheck passed. Gemini's one final review round returned STATUS: PASS with no correctness, regression or security blockers, confirming synchronous broadcast/FIFO receipt and idempotent subscription. Runtime smoke and delayed-subscriber red/green proof were already observed.
- **Evidence:** `bun scripts/suite.ts plugins/quirky.git`: 67 passed, 0 failed, flaky []; `bun test scripts`: 62 passed, 0 failed, 462 assertions; `bun run typecheck`: exit 0. Gemini google/gemini-3.1-pro-preview:high via pi-watch, exit 0, STATUS: PASS; archived evidence-git-flake/review-round1.json beside notes.
- **Reversibility:** easy
- **Confidence:** high for repair/verification; medium for exact attribution to original filename-only flake reports
- **Revisit if:** A future files.test.ts failure identifies another timing assumption or shared-state cause.
- **Source:** assumed — autonomous

## Progress
Implementation, controlled delayed-subscriber red/green proof, actual daemon/PTY/CLI smoke, scoped 67-file remote suite, 62-test scripts suite and typecheck all passed. Catch-up completed once (queue-only merge). Cross-family final review passed with no reported findings. All owned background jobs/subagents returned and runtime/probe scaffolds were cleaned. Next: commit this verification log, detach, and run queue.ts land fix-flaky-quirky-git-files-scenarios; landing owns whole-suite verification.

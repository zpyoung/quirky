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

## Progress
The two delayed-subscriber scenarios now pass after the previously failing save assertion. Standalone real daemon/PTY/CLI smoke is running without load workers. Next: catch up once, run scoped plugin tests/scripts/typecheck, cross-family final review, fix blocking findings, and land. No product/UI scenario is changed; UI dogfood is intentionally unchanged for this test-only repair.

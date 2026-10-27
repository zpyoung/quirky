# fix-flaky-quirky-worktree-window-projects decisions

## D1: Treat the load-sensitive failures as a fix item
- **Question:** Which workflow and scope apply to the claimed flaky window-projects test?
- **Options:** Re-spec the worktree feature; investigate and repair the named failure only.
- **Chose:** Systematic debugging and a failing-before/passing-after reproduction; skip brainstorming and specs.
- **Why:** The queue item is a fix item and explicitly requires finding a timing assumption or shared state and reproducing under CPU load.
- **Evidence:** docs/loop/LOOP.md:159–171; queue.ts wait lane 12 returned fix-flaky-quirky-worktree-window-projects.
- **Reversibility:** easy (test/fix scope only)
- **Confidence:** high
- **Revisit if:** Evidence exposes a broader consumer-visible defect requiring a runtime change.
- **Source:** locked by docs/loop/LOOP.md

## D2: Isolate all process-based experiments and own cleanup
- **Question:** How should reproduction avoid changing real state or leaving load workers running?
- **Options:** Run against the developer home; use fresh temporary HOME and QUIRKY_HOME with explicit cleanup.
- **Chose:** Fresh temporary homes for process experiments, finite load workers, cleanup in finally.
- **Why:** Tests must not touch real state; load generation must not outlive this iteration.
- **Evidence:** docs/loop/LOOP.md:30–38; prior lane notes record an isolation incident.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A required fixture cannot run isolated; resolve the fixture rather than exposing real state.
- **Source:** locked by docs/loop/LOOP.md

## D3: Reuse the already-landed condition-based report wait
- **Question:** Does this item still need another product or test fix after investigating the recorded failure?
- **Options:** Add another wait or runtime synchronization; validate the existing repair and close the stale queued repair.
- **Chose:** Validate the existing repair; do not change runtime ordering or duplicate the wait.
- **Why:** Historical check.stdout shows SC-10 reading one project from the report after observing two in the DOM. WorktreesSection publishes reports in a post-render effect, then the host sends them asynchronously. Commit fce1b6a already replaced the immediate report assertion with HeadlessWindow.waitFor on report readiness. The current branch contains this fix, landed through m1-agent-status-scripting D45.
- **Evidence:** /tmp/m5-runner-KYwwFv/final-verification/check.stdout:220–243; plugins/quirky.worktree/src/WorktreesSection.tsx:89–95; packages/ui/src/plugins/host.ts:459–462; plugins/quirky.worktree/test/window-projects.test.ts:280–286; git show fce1b6a; docs/loop/decisions/m1-agent-status-scripting.md:453–459.
- **Reversibility:** easy
- **Confidence:** high for the recorded failure; fresh controlled red/green verification remains pending.
- **Revisit if:** The current test fails under the same controlled conditions or a distinct failure is observed.
- **Source:** assumed — autonomous

## D4: Confirm the original assertion races under macOS CPU load
- **Question:** Can the named timing assumption be reproduced without changing product code?
- **Options:** Trust historical failures only; restore the old assertion in a throwaway sibling test and run with bounded CPU workers.
- **Chose:** Restore only the old immediate report assertion in a throwaway copy and run SC-10 with 12 CPU workers.
- **Why:** Attempt 2 failed at the identical assertion with one reported project instead of two, after the DOM readiness condition passed. This confirms an ordering assumption, not incorrect persisted group membership. The unchanged repaired file also passed three whole-file runs under 12 workers (18 tests each, 54 passes total, zero failures).
- **Evidence:** /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/lane12-projects-load-2xw8lk/run-1.log (red, 6.92 seconds); /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/lane12-projects-load-E9e0yv/run-{0,1,2}.log (green, 51.93/52.90/106.54 seconds).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The repaired condition-based wait fails under equivalent load.
- **Source:** assumed — autonomous

## D5: Use the available cross-family reviewer
- **Question:** Which reviewer can inspect the reuse decision and verification without using the implementing model family?
- **Options:** Opus through pi-watch; next available cross-family Gemini through pi-watch.
- **Chose:** Gemini (google/gemini-3.1-pro-preview, high).
- **Why:** pi-watch --check opus exited 5 with no authed/shipping model (0/8 combinations); pi-watch --check gemini exited 0 and resolved the Google model. No authentication state changed.
- **Evidence:** Current iteration bg_2 and bg_3 preflight outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini cannot complete the read-only review.
- **Source:** assumed — autonomous

## D6: Keep the existing regression scenario rather than a duplicate
- **Question:** Should the historical throwaway copy or CPU stress harness become permanent tests?
- **Options:** Commit a duplicate test/load harness; keep the repaired SC-10 scenario and record the controlled evidence.
- **Chose:** Keep the existing behavior scenario; remove the throwaway copy and leave CPU-load scaffolding outside the repository.
- **Why:** Ten focused repaired SC-10 runs with the same 12-worker load passed (10 passes, zero failures; 57.56 seconds total). Together with the three whole-file runs and the restored-assertion failure, this validates the precise existing fix. A duplicate test or permanent machine-saturating test would add maintenance/load without covering a distinct behavior.
- **Evidence:** /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/lane12-projects-load-s7ywUm/run-{0..9}.log; bg_5 exit 0 and owned-worker cleanup. Original throwaway red test was removed before the focused green runs.
- **Reversibility:** easy
- **Confidence:** high for the observed race; finite repetitions do not prove absence of all scheduling failures.
- **Revisit if:** Another failure shows a different state transition racing.
- **Source:** assumed — autonomous

## D7: Bind standalone smoke subprocesses to the harness home
- **Question:** Why did the standalone smoke's CLI see no window report after the group DOM was ready?
- **Options:** Change report behavior; correct the throwaway smoke's process-scope home.
- **Chose:** Pass the same temporary QUIRKY_HOME to createProcessScope and startHarness.
- **Why:** The first two smoke attempts reached the filled group but timed out waiting for CLI reports. createProcessScope() allocates a separate home and its spawn method overwrites supplied QUIRKY_HOME, so CLI calls were reading a second isolated daemon with no window. Correcting the smoke's scope binding is necessary; product code is unchanged. All attempts cleaned owned processes/homes. Provider hook messages referred only to the smoke's temporary HOME.
- **Evidence:** bg_6 and bg_7 outputs; scripts/test-support/process-scope.ts:441–469,493–500; /tmp/lane12-window-projects-smoke.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Same-home CLI state disagrees with the real window.
- **Source:** assumed — autonomous

## D8: Keep headless HTTP globals out of the daemon smoke
- **Question:** Why did the same-home CLI smoke still fail with “Expected a Response object”?
- **Options:** Alter daemon response handling; retain native HTTP constructors in the throwaway in-process window smoke.
- **Chose:** Save Bun's Response/Request/Headers before headless registration and restore them after mounting the window.
- **Why:** happy-dom replaces global HTTP classes while the daemon still needs native Bun Response objects. The websocket-based regression scenario does not cross this HTTP boundary. This was smoke scaffolding, not the reported report race. With native constructors restored, actual DOM actions created a group and moved a second project into it, the real CLI read matching report project IDs, and the API returned the same persisted membership. Output printed SMOKE_OK and SMOKE_CLEANUP_OK, exit 0 (2.11 seconds).
- **Evidence:** bg_8 failure, artifact://18; bg_9 success output: domProjects=2, matching reportProjectIds and persistedProjectIds. No source change. Teardown emitted React unmount and plugin-deactivated RPC warnings; these occurred after successful assertions and cleanup completed.
- **Reversibility:** easy
- **Confidence:** high for the named smoke flow; this is a headless UI/CLI/API smoke, not native-window visual verification.
- **Revisit if:** The real separate-process application exhibits the HTTP-class error.
- **Source:** assumed — autonomous

## D9: Preserve operator ownership and catch up before final review
- **Question:** How should the lane proceed after the operator restored the earlier structured-runner item?
- **Options:** Land the earlier item again; leave it to the operator and finish this claimed fix.
- **Chose:** Continue only fix-flaky-quirky-worktree-window-projects. Do not run land for m5-structured-runner.
- **Why:** The operator explicitly took ownership of that landing. After committing this item's investigation, git merge build/roadmap brought only docs/loop/queue.json status changes; no new decision logs or product source arrived, so no decision contract changed.
- **Evidence:** Operator interjection in this iteration; git merge build/roadmap output (one queue file changed).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Integration catches up with additional source/decision changes before this item's land.
- **Source:** assumed — autonomous

## D10: Verify the affected plugin and required gates without changing shipped behavior
- **Question:** Which verification and documentation obligations apply when the exact repair already landed?
- **Options:** Rebuild/reimplement the worktree feature; verify the existing repair, affected plugin and prescribed gates, then let land verify the whole merge result.
- **Chose:** The existing SC-10 test remains the regression scenario, the controlled load run proves the old assertion fails, and the standalone daemon/CLI/window smoke checks the consumer path. Record results in this decision log; no duplicate product documentation, new UI scenario or native handoff.
- **Why:** No runtime, exported API, caller, package or test source changed in this item. Fresh catch-up verification passed: bun test scripts (62 pass, 0 fail, 460 assertions), bun run typecheck (exit 0), and bun scripts/suite.ts plugins/quirky.worktree (25 files passed, 0 failed, no flaky reruns; 196.29 seconds). The standalone smoke verifies report/persistence agreement, not native visuals. queue.ts land owns full-suite verification on the eventual merge.
- **Evidence:** bg_10, artifact://24; bg_11, suite-result {\"ok\":true,\"flaky\":[]}; D4/D6/D8. No new logic spec/UI/native scenarios because fix items skip specifications and shipped behavior is unchanged.
- **Reversibility:** easy
- **Confidence:** high for exercised paths
- **Revisit if:** Final review or the merge-result gate exposes another defect.
- **Source:** locked by docs/loop/LOOP.md

## D11: Accept the final review and retain no duplicate implementation
- **Question:** Does cross-family final review confirm that the existing repair plus new evidence closes this fix item?
- **Options:** Add speculative source/test changes; accept the exact-fix reuse after review.
- **Chose:** Accept the review: no findings, STATUS: PASS. No fix batch needed and no accepted findings remain open.
- **Why:** The first Gemini invocation stopped after a read tool without final text/trailer (exit 6), so it supplied no verdict. Retried the same Round 1 as an evidence-bundled no-tools review containing the exact test/runtime excerpts, pre-fix failure, repaired load results, standalone smoke and fresh gates. It returned “No findings. STATUS: PASS” (exit 0). This was transport recovery, not another discovery round. The removed throwaway test and both external load/smoke scripts are not shipped.
- **Evidence:** bg_12 (missing trailer), bg_13 (google/gemini-3.1-pro-preview:high, no findings, PASS); successful edit removal of /tmp/lane12-window-projects-{load,smoke}.ts. All owned workers, smoke daemons/homes, remote suite and reviewer have returned.
- **Reversibility:** easy
- **Confidence:** high for the confirmed timing race and existing fix; review used supplied evidence rather than independent tool execution.
- **Revisit if:** Merge-result verification fails.
- **Source:** assumed — autonomous

## Progress
Ready to land fix-flaky-quirky-worktree-window-projects only. CPU-load red/green, standalone DOM/API/CLI smoke, scripts (62 passes), typecheck and affected plugin (25 files, no flakes) passed. Final cross-family review: no findings, PASS; cleanup complete. No product/test changes because fce1b6a already repairs the confirmed race. Commit the completed decision log, detach and invoke queue.ts land for this fix item; operator owns m5-structured-runner landing. Full merge-result verification remains the land command's responsibility.

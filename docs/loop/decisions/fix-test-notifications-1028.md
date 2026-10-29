# fix-test-notifications-1028 decisions

## D1: Repair the claimed notification failures without changing delivery ownership
- **Question:** What scope and runtime contracts govern the end-phase repair?
- **Options:** Restore historical immediate Ask delivery; repair current-contract regressions and fixture failures; change the shared policy.
- **Chose:** Diagnose the exact claimed failures against the current public contracts, retaining the sole notification policy, private process homes and cleanup. No aliases or cross-plugin policy bypasses.
- **Why:** The claimed baseline predates delayed Ask attention; current README requires silence at registration and three uninterrupted minutes for a surfaced head. Heimdall notifications must still use the shared enabled/focus/cooldown gates.
- **Evidence:** plugins/quirky.notifications/README.md:33-41; plugins/quirky.notifications/src/service.ts:692-739; authoritative queue item fix-test-notifications-1028.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reproduction demonstrates a consumer-visible policy defect rather than an obsolete fixture assumption.
- **Source:** locked by plugins/quirky.notifications/README.md

## D2: Run every test through the canonical remote suite
- **Question:** How should reproduction and verification avoid competing for this Mac?
- **Options:** Local bun test; canonical remote suite for every target, including individual files and scripts.
- **Chose:** `bun scripts/suite.ts <file-or-directory>` for every test run; local typecheck and disposable API smoke only.
- **Why:** The operator instruction recorded at iteration 13 overrides LOOP.md's older single-file exception.
- **Evidence:** .orca/loops/omp-until-done-50bc6f72/notes.md:114; initial canonical notification suite launched.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The operator explicitly changes test-host policy.
- **Source:** assumed — autonomous

## D3: Synchronize tests with asynchronous Ask lifecycle boundaries
- **Question:** Do the timed-out gate counts and missing loop Ask prove lost notification delivery?
- **Options:** Emit an immediate Ask decision again; add sleeps/timeouts; await only actual producer decisions and the matching public pending Ask.
- **Chose:** Keep Ask registration silent, remove it from immediate gate-decision expectations, and wait for the loop session's matching pending Ask before cancelling it.
- **Why:** Initial canonical reproduction had SC-18 and SC-43 timeouts while their setups produced only two and four immediate decisions respectively. The additional loops.test.ts failure saw needs-you and its notification before asynchronous Ask registration completed, the same boundary documented by fix-test-loops-1028 D7.
- **Evidence:** canonical remote suite artifact://7:50-66,119-134,293-314; plugins/quirky.notifications/src/service.ts:202-216; plugins/quirky.notifications/test/loops.test.ts:223-244.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A pending Ask never appears for that exact waiting loop session within its existing condition watchdog.
- **Source:** assumed — autonomous

## D4: Diagnose Heimdall through its public trace rather than assume a kind collision
- **Question:** Does isolating the fixture from unrelated kind producers repair the three Heimdall timeouts?
- **Options:** Assume all-builtins composition is the cause; inspect the actual enrolled watcher's trace in an isolated daemon.
- **Chose:** Inspect the trace and repair the demonstrated fixture prerequisite without weakening kind ownership or lease fencing.
- **Why:** An actual daemon with only recursive notifications/ask/Heimdall dependencies and the control fixture still timed out before watching. Its public detail reported unreachable/lease-unverifiable with snapshotReadCount 0 and ownerContact unverifiable. Competing kinds are not established as the root cause.
- **Evidence:** disposable API smoke artifact://9:4 (full JSON); plugins/quirky.notifications/test/heimdall.test.ts:23-27.
- **Reversibility:** easy
- **Confidence:** high for observed failure; fixture repair remains under investigation
- **Revisit if:** A valid lease still fails before the producer reads its snapshot.
- **Source:** assumed — autonomous

## D5: Use the reachable cross-family review backend
- **Question:** Which reviewer can independently review OpenAI-authored changes?
- **Options:** Opus as LOOP.md recommends; next reachable cross-family backend; same-family task fallback.
- **Chose:** Gemini through pi-watch for the final scoped read-only review.
- **Why:** `pi-watch --check opus` exited 5 with no authenticated/shipping model. The all-alias probe resolved google/gemini-3.1-pro-preview:high; OpenAI task agents implement.
- **Evidence:** review preflight tool receipts (opus 0/1 ready; Gemini available).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual Gemini dispatch fails, in which case follow the documented fallback ladder and record the result.
- **Source:** assumed — autonomous

## D6: Select custom sound controls by their associated labels
- **Question:** Why did all six reached custom-path scenarios receive a null input after the shared form cutover?
- **Options:** Force a product type attribute to satisfy the selector; query the rendered accessible control; delete the behavioral scenarios.
- **Chose:** Query the select/path field through their actual associated labels. Retain path preview/save, refused-path error and draft retention, hiding/reopening, and report transitions. Delete incidental copy/default/inventory/manifest/bundle assertions instead of repinning them.
- **Why:** The shared TextField renders a valid default-text input without an explicit type attribute. `input[type=\"text\"]` therefore misses it even though the associated label points to the control. No product change is required.
- **Evidence:** plugins/quirky.notifications/src/window/NotificationsView.tsx:138-155; plugins/quirky.notifications/test/window-view.test.ts; initial canonical six failed scenarios and corrected window-view+loops canonical 2/2 files, zero flaky reruns,27.83s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The accessible label no longer resolves to the interactive field, or the behavioral regression fails.
- **Source:** assumed — autonomous

## D7: Give the watcher fixture a registered Git workspace with real lease storage
- **Question:** What fixture prerequisite prevents every Heimdall notification scenario from reaching its first snapshot?
- **Options:** Weaken lease fencing; change kind registration; supply the fixture's real registered workspace identity and Git metadata.
- **Chose:** Pass repoId with worktreeId, initialize the temporary Rig worktree as an actual Git repository, and symlink the control fixture's workspace directory to that worktree. Keep shared Heimdall fixture/runtime and notification policy unchanged.
- **Why:** Registered workspace kind resolution requires both IDs; Git leases require a real regular `.git` directory/file at workspacePath. The old fixture supplies neither repoId nor a matching Git path. The first isolated smoke fails before snapshot with lease-unverifiable; adding only IDs and the symlink still fails without actual Git metadata. With all prerequisites present, approval delivery/repeat folding, disabled terminal suppression and final terminal reason/navigation pass.
- **Evidence:** plugins/quirky.heimdall/src/workspace-lifecycle.ts:43-48; plugins/quirky.heimdall/src/lease.ts:57-79,257-260; actual API smoke first two attempts exit1 with public trace snapshotReadCount0, corrected attempt exits0 in181.78s with NOTIFICATIONS_HEIMDALL_SOLE_POLICY_SMOKE_OK.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A fully registered temporary Git workspace cannot acquire its normal lease or cleanup leaves it held.
- **Source:** assumed — autonomous

## D8: Bound the runtime proof to the exercised daemon paths
- **Question:** What does the smoke establish beyond unit-clock and rendered-fixture tests?
- **Options:** Infer native OS acceptance; exercise real public API and wall-clock transitions with disposable homes.
- **Chose:** Exercise actual daemon RPC creation/FIFO promotion, disabled and focused program delivery gates, watcher approval/repeat/disabled terminal/final reason, then wait for the real promoted Ask escalation. No delay override or private policy mutation.
- **Why:** The corrected smoke delivers the exact promoted question once after180017ms, sets the real session/worktree unread markers and emits attention/decided. It exits0 in181.78s with cleanup and home absence. The actual native OS banner/click, real paid provider, full UI/native/platform acceptance are not exercised.
- **Evidence:** NOTIFICATIONS_FIFO_PROMOTION_SILENT_OK; NOTIFICATIONS_HEIMDALL_SOLE_POLICY_SMOKE_OK; NOTIFICATIONS_REAL_THREE_MINUTE_FIFO_ESCALATION_SMOKE_OK 180017; NOTIFICATIONS_SMOKE_CLEANED.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical regressions show a different lifecycle outcome.
- **Source:** assumed — autonomous

- **Observed shutdown output:** inactive-worktree cleanup, fake-Git cwd/not-repository, and revoked notification-context lookup warnings remain visible. Both failed fixture diagnostic attempts and the successful run acknowledge cleanup and remove their private homes; no pristine-output or product shutdown fix is claimed.

## D9: Adopt the incoming exact-workspace fixture and remove the obsolete symlink
- **Question:** Does the sole roadmap catch-up change the fixture contract used by this repair?
- **Options:** Keep redundant path scaffolding; change the shared fixture again; consume its exact registered resolver and remove obsolete local setup.
- **Chose:** Commit source a0d3ac78, merge roadmap once, read incoming fix-test-heimdall-1028 D1–D12 and raw Progress completely, retain its authority semantics. Remove this repair's temporary fixture-workspace symlink and widened home state; keep repoId and real Git initialization.
- **Why:** The incoming shared control fixture now resolves the exact worktree through the public API and verifies repoId before authorizing its canonical path. The old symlink is no longer used. The same incoming decision preserves nullable positively certified worker contact and exact preflight mutation identity; neither conflicts with notification policy.
- **Evidence:** sole clean merge18files; plugins/quirky.heimdall/test/control-fixture.ts:23-47; incoming fix-test-heimdall-1028 D5–D6,D11. Final watcher+Ask narrow suite2/2files,zero flaky reruns,39.06s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The final composed runtime or typecheck finds a concrete integration mismatch.
- **Source:** locked by docs/loop/decisions/fix-test-heimdall-1028.md

## D10: Retain Ask gate coverage at escalation, not registration
- **Question:** Does deleting the obsolete immediate-Ask gate expectation remove useful enabled/focus behavior coverage?
- **Options:** Restore immediate decisions; rely only on non-Ask source tests; exercise disabled and focused-worktree gates at the actual escalation boundary.
- **Chose:** Add two bounded manual-clock behaviors: disabled Ask still emits attention/unread but no notification; another focused session in the same worktree permits the timer yet suppresses its banner. Await the actual decision event before asserting terminal outcomes.
- **Why:** Exact-session focus cancellation and worktree banner suppression are different boundaries. The migrated immediate-producer gate test must not erase the Ask coverage those assertions originally intended. Removed the incidental public-list call-count assertion rather than pin internal reconciliation frequency.
- **Evidence:** plugins/quirky.notifications/test/ask-escalation.test.ts; current NotificationsService handle/deliver path; full three-minute API smoke proves the delivered case separately.
- **Reversibility:** easy
- **Confidence:** high; final targeted canonical file passes without retries and the fresh-context same-family static delta review reports no findings.
- **Revisit if:** The direct escalation tests identify different policy behavior.
- **Source:** assumed — autonomous

- **Pre-merge verification receipt:** full typecheck40.18s; remote scripts12/12files52.87s; remote notifications ok:true in173.59s after configured isolated retries (initial20/22files; banners and gates flaky). Exact load-only failures are appended to BLOCKERS.md, not relabelled as zero initial failures. No deadline/retry change.

## D11: Land the exercised baseline repair without claiming load stability
- **Question:** Which final results establish this repair, and which failures remain observations?
- **Options:** Claim every combined run was green; increase blanket startup/watchdog budgets; retain exact canonical outcomes and unchanged policy.
- **Chose:** Final notifications canonical returns ok:true in128.86s with delivery-sound and gates in its configured flaky list (initial20/22files; both isolated retries pass). Final full typecheck passes48.13s. Final added Ask gate file passes1/1files without retries28.31s, composed watcher/FIFO2/2files39.06s. Scripts pass12/12files52.87s and again occupy the passed set of the combined34-file run.
- **Why:** Every named baseline regression and the reached loop/UI contract failures are repaired without production changes. The combined34-file run still exits1 in174.67s because other scenarios exceed their enclosing5second watchdogs; BLOCKERS.md preserves the exact evidence and changing failed scenarios across runs. No source/runtime gate, blanket test watchdog or retry policy is weakened.
- **Evidence:** canonical receipts and appended docs/loop/BLOCKERS.md section fix-test-notifications-1028. The final real disposable daemon smoke after catch-up exits0 in184.52s with all behavior and cleanup markers; Ask arrives179577ms after the public promotion read (its timer begins before that observer read).
- **Reversibility:** easy
- **Confidence:** high for exercised baseline/API paths; startup-under-load cause is unproven.
- **Revisit if:** A dedicated fixture-lifecycle investigation identifies the remaining teardown/startup cause, or the controller reports a concrete new failure.
- **Source:** assumed — autonomous

## D12: Complete static review through the available fallback and report reduced independence
- **Question:** Can an authenticated alias probe be mistaken for a completed independent review?
- **Options:** Treat empty/timed-out cross-family dispatches as passes; block without trying the documented fallback; use the reachable reviewer and disclose its limits.
- **Chose:** Do not count the unsuccessful Google dispatches. Gemini's first call returned no JSON, its retry timed out240s; Flash tool-driven and captured no-tools attempts each timed out150s. A fresh same-family reviewer then read the exact final patch and all five current tests/README, returning no findings. A separate fresh-context reviewer covered the final added gate test seam and also returned no findings.
- **Why:** Actual parseable review output is required; successful authentication alone establishes no review result. The fallback is a real cooperative static review with reduced model-family independence, not a formal adversarial campaign or cross-family clearance.
- **Evidence:** NotificationPatchReview completed with source-backed Ask/FIFO, gate, lease, cleanup and UI coverage checks; NotificationGateReview completed with no findings. All four unsuccessful pi-watch jobs and both fallback review jobs have returned; no review process remains running.
- **Reversibility:** easy
- **Confidence:** high for observed review execution and scope only.
- **Revisit if:** A reachable cross-family runtime returns a concrete evidence-backed defect, or actual acceptance contradicts the reviewed behavior.
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Source a0d3ac78 and one clean18file roadmap catch-up are preserved; incoming Heimdall D1–D12 and raw Progress read fully. Final source passes typecheck48.13s and notifications canonical128.86s with explicitly declared delivery/gates flaky retries. Scripts12/12passed; earlier combined34-file failure remains in BLOCKERS. Added Ask gate file1/1clean; composed watcher/FIFO2/2clean; final composed actual API smoke184.52s exits0 with cleanup/home absence. Both static fallback reviewers report no findings; no cross-family/formal review pass claimed. Every implementer/scout/check/runtime/review job returned; no owned browser or runtime remains. Commit final source/docs/receipts, detach and invoke the exact authoritative queue.ts land fix-test-notifications-1028, then receive its actual result in this turn. Remove owned scratch only after successful land. No second item and no global completion/stuck state observed.

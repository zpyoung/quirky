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

## Progress
Both scoped test implementers returned. Parent audited all assigned changes and restored the accidentally omitted bun:test import before checks. No production source changed. Corrected actual API smoke exits0 after real three-minute Ask delivery and watcher policy proof; all three diagnostic/smoke attempts cleaned their private homes. Full local typecheck passes40.18s. Canonical full notifications and scripts checks are running. Next collect both, commit source/decisions, merge roadmap exactly once and read every incoming decision, run final composed checks and scoped review, then commit/detach/canonical land and receive its actual receipt before ending this one-item iteration.

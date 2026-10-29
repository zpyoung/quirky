# fix-test-session-1028 decisions

## D1: Repair the assigned session failures without weakening lifecycle boundaries
- **Question:** What constitutes the end-phase fix, given the baseline triage and newer integration changes?
- **Options:** Repin all old expectations; repair substantive regressions and stale fixtures; change public contracts to satisfy fixtures.
- **Chose:** Repair substantive regressions and stale fixtures, deleting incidental wording, inventory, source and default-copy assertions rather than repinning them.
- **Why:** The queue assignment explicitly requires consumer-visible repairs and rejects aliases or cross-plugin bypasses. Provider/account identity, exact worktree incarnation, launch snapshots, history and admission must remain authoritative.
- **Evidence:** docs/loop/reports/m7-test-triage.json, plugins/quirky.session area; authoritative docs/loop/LOOP.md, Fix items.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current baseline evidence identifies a conflicting locked requirement.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use OpenAI implementers and the reachable Gemini reviewer
- **Question:** Which implementation/review pairing is available on this omp lane?
- **Options:** OpenAI tasks with Opus; OpenAI tasks with Gemini; same-family review.
- **Chose:** OpenAI task implementers and google/gemini-3.1-pro-preview at high reasoning for independent review; Flash is a reachable cross-family fallback.
- **Why:** Fresh pi-watch checks found Opus and Sonnet unavailable; Gemini, Codex, Terra and Flash resolved. No person is available or asked.
- **Evidence:** Iteration 13 pi-watch --check outputs for all six aliases, preserved in loop progress.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual reviewer dispatch fails after its retry.
- **Source:** assumed — autonomous

## D3: Leave inherited metadata untouched and test only private state
- **Question:** How should the inherited untracked .serena directory and process isolation be handled?
- **Options:** Stash or delete unrelated metadata; preserve it outside every staged scope.
- **Chose:** Preserve inherited metadata untouched, use isolated component trees if implementation can split, and retain fresh temporary homes and exact process cleanup in tests and smoke runs.
- **Why:** The inherited metadata is not this item's work. End-phase tests must not touch real Quirky or provider state.
- **Evidence:** Initial git status showed only untracked .serena/; docs/loop/LOOP.md Hard rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Attribution detects another writer touching an owned source path.
- **Source:** locked by docs/loop/LOOP.md

## D4: Restore structured-session startup reconciliation alongside interrupted workspace recovery
- **Question:** Why does a structured record remain working after its daemon is gone?
- **Options:** Repin the restart assertion; move ownership to the fake structured plugin; restore the lost startup reconciliation.
- **Chose:** Restore startup finalization of non-exited structured records, before reconciling interrupted workspace sleep. Keep terminal reconciliation dependent on actual PTY inventory.
- **Why:** Commit 48083f14 replaced the structured startup loop with workspace recovery rather than retaining both. Structured runners and their kernel leases are daemon-owned; an old working record cannot represent a live runner after restart. The existing public restart test fails at the structured record while correctly retaining the still-live terminal.
- **Evidence:** Baseline canonical session suite, sessions.test.ts:1095; git show 48083f14, sessions.ts startup reconciliation hunk; plugins/quirky.structured/main.ts shutdown and lease ownership.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Structured processes gain a supported independent host capable of surviving daemon restart.
- **Source:** assumed — autonomous

## D5: Respect asynchronous provider-update serialization instead of widening lock admission
- **Question:** Should a provider update issued during spawn appear in the launch response?
- **Options:** Remove workspace locking; invent an unfenced startup fast path; await the asynchronous update and inspect the committed record.
- **Chose:** Preserve the production lock and have the regression await the actual update promise after creation releases the workspace lock, then verify durable provider identity and launch snapshot together.
- **Why:** setProviderSession is asynchronous and serializes ordinary updates behind workspace launches. The old unit test discarded its promise and compared an earlier response snapshot. No committed identity was lost in the demonstrated source path; relaxing the lock would race sleep and stale-workspace checks.
- **Evidence:** plugins/quirky.session/src/sessions.ts:334-345,921-987,1702-1738; baseline sessions-launch.test.ts:242.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An awaited successful provider update is subsequently overwritten by launch completion.
- **Source:** assumed — autonomous

## D6: Correct the test prerequisites without changing public contracts
- **Question:** How should the remaining red restore and sleep fixtures be repaired?
- **Options:** Weaken missing-directory checks and nullable schemas; alter launch argv globally; supply truthful fixture prerequisites and commands.
- **Chose:** Existing private cwd for cold restore; honest fake plan support before account preparation; omit absent optional transcriptPath inputs; wrap compound fixture commands in an explicit child shell. Delete the catalog inventory mirror rather than updating its copied list.
- **Why:** Missing-directory refusal is intentional, optional-string requests do not accept null, and commandArgv execs the supplied executable. Fixtures using exec printf never reach later shell statements. These failures do not justify a changed runtime or account authorization model.
- **Evidence:** Baseline session suite; plugins/quirky.session/src/sessions.ts:680-690,1291-1318; packages/daemon/src/launch.ts:48-50; session public manifest setProviderSession; m1-providers D24-D26; m5-structured-runner D4.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Consumer-visible failures remain after valid prerequisites and exact API requests.
- **Source:** assumed — autonomous

## D7: Keep the substantive startup regression while consuming the adjacent owner's narrow cleanup
- **Question:** How do this repair and lane3's published session-sweep fixtures coexist?
- **Options:** Import the whole unfinished sweep; delete the structured restart behavior assertion; reconcile the narrowly relevant evidence under one owner.
- **Chose:** Cherry-pick only 666e590a993c40ed62f45808305739be09b32f78 (one Session Info inner-title wording assertion deletion). Inspect fe7ab4f1 and 67ef7782 without importing their unrelated plugin changes. Lane3 freezes further session edits; retain and strengthen the structured startup regression here.
- **Why:** PTY absence cannot prove structured death during ordinary reconnect. Startup is different: structured leases are memory-only, native runners are daemon-owned, and plugin release cascades through dependents before reactivation. The regression now checks preserved provider/cwd identity after restart and an exact live structured lease surviving ordinary PTY reconnect; existing structured startup-owner coverage protects lazy activation within one lifetime.
- **Evidence:** Lane3 direct handoff and accepted coordination receipts; packages/daemon/src/session-authority.ts structuredLeases; plugins/quirky.structured/main.ts shutdown; packages/daemon/src/plugins/host.ts release ordering; m7-terminal-runtime-native-and-worktree-parity D12; StructuredStartupInvariant source trace; plugins/quirky.structured/test/startup-owner.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Runtime evidence shows a supported structured owner surviving session-plugin startup.
- **Source:** assumed — autonomous; locked by m7-terminal-runtime-native-and-worktree-parity D12

## D8: Exercise real retained history rather than assert a fake host's buffer policy
- **Question:** What did the first post-repair gate reveal beyond the original failures?
- **Options:** Change production history or relax authorization; modify the shared fake host; verify retained history through the real PTY and remove incidental fake-call echoes.
- **Chose:** Keep the real sleep/wake history regressions, push their markers into scrollback, declare the fake account preparation DTO's nested fields, and verify cold-agent history independently through an actual PTY. Remove the newly introduced fake-buffer expectation and old mock forwarding assertions, not consumer-visible state/identity checks.
- **Why:** The fake PTY reconstructs its buffer on restore; that is not the production retained-history implementation. The real runtime smoke proves a first-launch-only marker remains after a second launch of the same agent/session. The gate also exposed new null optional-input spreads and a first-mock-call assertion displaced by the new real CLI restore; those fixtures are corrected without public-schema or timeout changes.
- **Evidence:** First targeted gate: 3/5 files passed; residual CLI mock-call, fake-buffer and null-input failures. Actual integrated private smoke exits0 in1.74s: same-session Codex-shaped executable restore, two real launches, captured --resume identity, first-launch history retained; structured startup exits while a live terminal survives, descendant stopped by sleep, wake retains history; explicit daemon/PTY/home cleanup.
- **Reversibility:** easy
- **Confidence:** high for exercised process/API boundaries; no native provider-service or UI acceptance inferred
- **Revisit if:** Real PTY history, canonical regressions or merge-result verification disagrees.
- **Source:** assumed — autonomous

## D9: Complete one bounded independent review over the repaired session boundary
- **Question:** What independent assurance accompanies the passing integrated gates?
- **Options:** Trust worker reports; run repeated discovery campaigns; one fixed-artifact standard cross-family promote/refute review.
- **Chose:** Standard Gemini high-reasoning promote and fresh-context refute, with mechanical resolve/prepass/model/claims/merge/gate/manifest. The reviewed 558-line source/test/README patch excludes author decision logs and reasoning. The explicit standard depth is bounded rather than three separate lenses or an exhaustive review.
- **Why:** Both real reviewer dispatches returned empty finding arrays; the gate returned PASS with full family independence and zero blocking, advisory, suppressed, contested, limitation, question, excluded or unreviewed entries. An additional source-hash audit confirmed no source drift or inherited-metadata changes during review.
- **Evidence:** Review source 8bcccb80aa33b85222b1db2fbf8e642db53363d4; run7b0abafe64ac3fc1; artifact0e89ca539613a35266283cd4c00449fdb4af179f7266c56a8bf1a3807d126e88; canonical launches-test prepass exit0/19.607s; actual review chain exit0/517.54s; raw prompts, replies, gate and manifest preserved.
- **Reversibility:** easy
- **Confidence:** high for performed protocol; bounded for completeness
- **Revisit if:** A new consumer failure contradicts the reviewed boundary.
- **Source:** assumed — autonomous

## D10: Close the static fake-account result declaration mismatch in one bounded batch
- **Question:** Does the separate static plugin validator require a repair after the formal review?
- **Options:** Treat the formal PASS as covering all later changes; leave an inaccurate fake result contract; align the fixture declaration and rerun affected gates.
- **Chose:** Accept V1 at low severity and declare the actual preparation result fields: open env map, nullable shellInit/account DTOs, optional resumeTranscriptPath, and the same required fields as the public preparation contract. No new production API, grant or validation path.
- **Why:** The fake's empty-object schema contradicted the object it returns. Matching that existing public result makes schema-aware fixture consumers truthful. The formal review remains explicitly pre-batch; static finding closure and fresh tests/typecheck/runtime smoke cover the later fixture-only delta. No permanent source/schema-copy test is added.
- **Evidence:** SessionFixtureContractValidation V1 at fake accounts quirky-plugin.json:60; fake main.ts:21; actual quirky.accounts/prepare result schema; final bounded batch changes only the fake result declaration.
- **Reversibility:** easy
- **Confidence:** high; static closure and post-batch current suite/typecheck/runtime pass
- **Revisit if:** The preparation provider's result shape changes.
- **Source:** assumed — autonomous

## D11: Land only after current post-batch gates and private cleanup
- **Question:** What establishes the final state without overstating UI, native-provider or review coverage?
- **Options:** Reuse the pre-batch suite and formal PASS; run fresh affected verification and retain exact limits.
- **Chose:** Fresh canonical session/structured suite:38 files passed,0 failed, flaky[] in78.25s. Fresh full frozen-install/UIlint/root/mobile/prepared-desktop typecheck plus actual private runtime smoke exited0 in35.68s. The earlier integrated12-file scripts gate passed and no script changed afterward. Static V1 closure confirms the corrected result schema; the formal review remains bounded to8bcccb80.
- **Why:** Covers the only later delta (fixture result schema) and the actual daemon/PTY paths without relabeling earlier evidence. The real Codex-shaped executable is a controlled local provider fixture, not a claim of native Codex-service integration. No renderer or native OS surface changed; no UI/native acceptance is inferred. All component trees are removed, unknown metadata preserved and private daemon/PTY/home cleanup observed.
- **Evidence:** Canonical final suite-result ok:true/flaky:[]; full typecheck chain exit0; smoke receipts s_dd403a997166 (same-session cold restore/provider/history), s_1a5ab058117f (structured restart), s_df7aad5c5d32 (terminal survival/history/wake); PRIVATE_SESSION_DAEMON_PTY_AND_HOME_CLEANED; authoritative queue deps ready:true/pending[]; fix-batch scope and metadata audit.
- **Reversibility:** easy
- **Confidence:** high for exercised code/API/process boundaries; bounded for unexercised native/UI surfaces
- **Revisit if:** Canonical landing reports a concrete merge or typecheck failure.
- **Source:** locked by docs/loop/LOOP.md verification and landing; assumed — autonomous for bounded proof


## Progress
Ready for canonical landing. Current post-batch38-file session/structured suite, full typecheck and actual private restart/sleep/wake/cold-agent smoke pass with cleanup;12 integrated script files pass. Standard independent Gemini review passed before the low fixture-only batch, whose exact finding is statically closed and freshly verified. All incoming decisions are read and compatible, all workers/review/runtime jobs returned, both component trees removed after metadata preservation, and authoritative deps is ready. Next: commit this evidence and the fixture result declaration, detach, run the canonical absolute queue.ts land, await its actual verdict, preserve the landing receipt and remove only owned scratch after success.

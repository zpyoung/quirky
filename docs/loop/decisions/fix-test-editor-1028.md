# fix-test-editor-1028 decisions

## D1: Repair the exact triaged editor behaviors without compatibility shims
- **Question:** Which failure evidence and acceptance boundary govern this fix item?
- **Options:** rerun the baseline merely to confirm; use the authoritative failure transcript and investigate its data paths
- **Chose:** Use baseline `97aaa12d` and `docs/loop/reports/m7-test-triage.{json,log.gz}` as failing-before evidence. Repair Changes shared-draft/lease handling, Explorer worktree isolation, CSV lossless edit/copy/paste, and document-link completion. Delete incidental wording/source/default assertions rather than repin them. Preserve exact window, worktree and lease authority.
- **Why:** The fix item names these four files and the triage explicitly forbids aliases, bypasses and incidental assertion mirrors. Reported failures are ground truth; new runs must validate repairs or a distinct hypothesis, not confirm the report.
- **Evidence:** docs/loop/decisions/m7-test-triage.md D5; queue wait lane 2; docs/loop/reports/m7-test-triage.json groups plugins/quirky.editor
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** detailed transcript or current code demonstrates an already-consumed correction
- **Source:** locked by docs/loop/LOOP.md and triage ownership

## D2: Run the end-phase fix workflow unattended with bounded disjoint implementation
- **Question:** How should skills, reviews, isolation and human questions be adapted?
- **Options:** new feature brainstorming/specs; fix workflow with root-cause investigation and existing behavioral regression coverage
- **Chose:** Skip feature specs per Fix items. Use up to three disjoint omp/OpenAI implementers after ownership mapping; parent integrates and runs checks once workers finish. Use external temporary worktrees. Keep inherited untracked `.quirk/` and `.serena/` untouched. No asks. All checks use `bun scripts/suite.ts ...` for the configured remote host, never direct `bun test`. Choose cross-family Gemini reviewer because `pi-watch --check opus` and `sonnet` reported no authenticated/shipping model, while Gemini resolved to `google/gemini-3.1-pro-preview:high`. One final review round and one fix batch per LOOP, not an open-ended campaign.
- **Why:** This is after m7-test-triage, so end-phase testing is enabled. LOOP overrides interactive questions and feature-spec requirements. Developer dispatch contract prohibits worker build/lint/test/formatter runs mid-flight. Existing authoritative failed tests provide the red evidence. No LSP servers are configured.
- **Evidence:** authoritative LOOP.md Fix items and end phase; reviewer probes; xd://lsp status; initial HEAD `18d47686ea4ff65d7b920a2d240d073eacb20f77`
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker scope intersects another or a reachable reviewer dispatch fails
- **Source:** assumed — autonomous

## D3: Display rejected preview errors and fence mail before asynchronous teardown
- **Question:** Which reported failures require production changes rather than altered assertions?
- **Options:** disable orchestration in the Explorer fixture; weaken detached-preview ownership; repair the missing error projection and lifecycle ordering
- **Chose:** Changes renders its existing previewError through an accessible shared EmptyState alert. Orchestration synchronously starts mail.dispose before awaiting engine and peer cleanup in both deactivation and failed activation, attaches rejection handling immediately, then awaits its existing drain position. Keep the real Explorer worktree-isolation/daemon-cleanup test unchanged.
- **Why:** The renderer already rejects mismatched lease/worktree/path metadata and releases resources but omitted the error from JSX. The mail timer reaches engine.bindings while the host has revoked plugin authority and engine/peer teardown is awaiting; mail.dispose immediately fences callbacks and unbinds hooks before its first await. No storage bypass or timeout extension is needed.
- **Evidence:** ChangesSurface.tsx preview validation/render branch; orchestration main.ts cleanup/deactivate; federation/mail.ts dispose; daemon plugins/host.ts deactivate; triage transcript Changes/Explorer stacks
- **Reversibility:** easy
- **Confidence:** high for traced causes; verification recorded separately
- **Revisit if:** an in-flight teardown callback still accesses revoked state
- **Source:** assumed — autonomous

## D4: Exercise actual cursor state and CSV data rather than incidental formatting
- **Question:** Should the other assertions change production completion/filter/quoting semantics?
- **Options:** trigger suggestions for every loaded document; remove TSV quoting; narrow filtering semantics; correct fixtures to drive intended behavior
- **Chose:** Keep production behavior. Document-link tests drive cursor selection and contenteditable input, waiting for observable state rather than one-tick flushes; opening an existing query does not automatically autocomplete. CSV tests copy then paste and assert preserved comma-containing cell data; the filter uses LINE 1 rather than B, which also matches the b in tab case-insensitively. Inline Changes reconstructs the original and modified text across diff fragments, not whole textContent with marker interruptions. Remove the invalid-preview wording pin rather than repin its new full text.
- **Why:** These tests previously assumed incidental DOM chunking, initial cursor position and serializer quoting, while the B fixture genuinely matched two rows. Consumer-visible semantics remain lossless data, accurate selection and guarded insertion.
- **Evidence:** triage transcript assertion diffs; scoped component commits 3e30f926, ddf3a73f, 97f5c1e4; parent removed the worker's newly expanded wording pin before committing
- **Reversibility:** easy
- **Confidence:** high for failure explanation; fresh post-fix checks pending
- **Revisit if:** real browser typing or semantic CSV roundtrip fails
- **Source:** assumed — autonomous

## D5: Remove overlapping fixture daemons instead of changing orchestration lifecycle
- **Question:** Why did the first mail-disposal ordering change fail to close the Explorer error?
- **Options:** catch revoked-store errors; clone only the orchestration plugin per fixture; split independent fixture scenarios and remove the speculative production change
- **Chose:** Split stale-anchor/collapse/filter and empty-tree checks into separate tests, each owning one harness and its normal teardown. Revert both orchestration main.ts changes completely. Keep the actual linked-worktree isolation test unchanged. Normalize only the terminal display-only blank row in the inline semantic reconstruction.
- **Why:** Detailed tracing confirmed that the preceding test, not the named failing isolation test, started two overlapping daemons with a shared builtin import path. Bun module caching shares orchestration's module-global active instances; the second activation overwrites the first, and teardown leaves the first timer live. One harness per independent test restores the intended fixture lifetime without a plugin-specific copy convention or a production workaround. The first inline reconstruction also included the renderer's terminal blank-line placeholder.
- **Evidence:** first affected-suite.log lines 60–92 and 625–651; EditorResidualFix source trace; packages/daemon/test/helpers.ts sharedBuiltinDir; Explorer tests before/after split
- **Reversibility:** easy
- **Confidence:** high for confirmed module/harness collision; post-fix suite recorded separately
- **Revisit if:** one-harness cleanup still leaks an orchestration timer
- **Source:** supersedes fix-test-editor-1028 D3 for orchestration; preview error projection remains

## D6: Keep the broad failing inventory with its existing repair owner
- **Question:** Does the initial broad affected gate establish a green editor or orchestration suite?
- **Options:** claim partial passes as green; expand this item into orchestration API/CLI repairs; retain precise failures and rerun only after fixing this item's residuals
- **Chose:** Record the first broad result: 46/59 remote files passed, 13 failed; one macOS-only file passed; exit 1 in 162.47s. Two editor residuals were repaired under D5. The other eleven orchestration files retain queued fix-test-orchestration-1028 ownership and are listed in BLOCKERS.md. The final delivered source makes no orchestration change.
- **Why:** The broad failures include unknown quirky.session/create, missing send subject, worker output identity, setup UI wording and Promise assertions, not proof that the editor's UI/CSV/completion changes broke those contracts. No compatibility alias or assertion suppression is justified.
- **Evidence:** .quirk/build-loop/fix-test-editor-1028/first-affected-suite.log (complete 900 lines); authoritative queue ownership; first typecheck/UI build passed exit 0 in 37.09s
- **Reversibility:** easy
- **Confidence:** high for observed output and ownership; no general orchestration root-cause claim
- **Revisit if:** the orchestration owner traces any failure to this item's final source delta
- **Source:** assumed — autonomous

## D7: Bound actual runtime evidence and keep UI findings visible
- **Question:** Which actual API/UI paths were exercised, and what is not established?
- **Options:** infer success from tests; run shared/foreground browser; use a private daemon and exclusively owned testing browser with guarded actions
- **Chose:** Actual daemon CSV copy/paste/save preserved two UTF-8 rows, multiline content and tab-containing cells. Guarded web run 20261028T235426-2bc0 passed both named goals: HEAD versus shared draft, modified-only Markdown preview and return to Source; real cursor query, Tab extensionless Guide insertion and Escape without insertion. No console/network errors or test overrides were reported. Keep the observed shared-draft comparison banner as report finding F1; this run does not certify rich-editor draft persistence or Save acknowledgement.
- **Why:** Browser proof used only the private fixture data and shared shipped renderer. Two earlier tool-limited runs attempted no feature actions because their 756x413 viewport clipped the document. MCP viewport context options do not resize an already attached context; explicit owned Chrome launch window size plus absolute supported CLI CDP config yielded a visible 1600x957 surface. These were infrastructure corrections, not production fallbacks. A first API smoke fixture compared a symlink spelling instead of canonical worktree path; fixing the throwaway path match made the exact-owner lookup work.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T235426-2bc0/report.json and obs2–11 screenshots; earlier partial run reports 20261028T234942-cfdf and 20261028T235019-afd3; CSV_SMOKE_PAGE actual rows; daemon service cleanup exit 0
- **Reversibility:** easy
- **Confidence:** high only for named observations
- **Revisit if:** real Save fails or an independently reproduced conflict is traced to the final source delta
- **Source:** assumed — autonomous

## D8: Keep linked-worktree fixture registration in its original repository
- **Question:** What caused the different selector failure after overlapping fixture lifetime was removed?
- **Options:** bypass worktree ambiguity; deduplicate production selectors without evidence; keep one registered repository while listing its two Git worktrees
- **Chose:** Retain the original repoId in the fixture and refresh worktree/list against that ID after Git creates the linked worktree. Do not call repo/add on the linked path. Keep both worktree-isolation assertions.
- **Why:** The corrected lifecycle test reached a previously masked fixture error: registering both primary and linked paths as separate projects made global lookup see the same worktree ID twice. The test intended one repository with two worktrees, not two project registrations. Production ambiguity refusal remains unchanged.
- **Evidence:** second affected gate: 31/33 remote files passed, Explorer duplicate-ID refusal remained on configured isolated retry; one macOS-only file passed; lifecycle.test.ts also reported an initial beforeEach/afterEach timeout, but the runner stopped retrying after Explorer failed. Exit 1 in 98.88s. No timeout was increased.
- **Reversibility:** easy
- **Confidence:** high for duplicate registration cause; fresh final verification follows
- **Revisit if:** original-repository worktree listing does not preserve the intended two identities
- **Source:** assumed — autonomous

## D9: Correct the integration-test budget without changing production deadlines
- **Question:** Does the full-daemon restart failure justify an arbitrary timeout increase or a fixture contract correction?
- **Options:** suppress late errors; disable startup plugins; retain a 5-second deadline shorter than one allowed daemon operation; use the existing real-daemon editor test budget and await owned cleanup
- **Chose:** Use the existing 60-second editor integration-test budget in lifecycle.test.ts, preserving the full shipped builtin set and every lifecycle assertion. Reuse registerIsolatedEditorFixtures before setup-hook registration, restore environment only after cleanup, and clean a partially started fixture/home on setup failure. Do not change production activation, shutdown or RPC deadlines.
- **Why:** The restart scenario legitimately performs two full daemon startups and a stop; each plugin activation/deactivation is already allowed 10 seconds, and shutdown awaits plugins sequentially. The observed restart test took 6089.65ms against Bun's 5000ms default, followed by cascading hooks/null-fixture/ConnectionLost. The exact slow sub-operation is not identified; no broader runtime-performance fix is claimed. Other real-daemon editor suites already use 60/120-second budgets. Missing process environment isolation is a separate safety boundary, not claimed as the cause of this timeout.
- **Evidence:** failed caught-up prepass; lifecycle fixture and daemon startup/PluginHost bounds; viewers.test.ts and viewer/notebook acceptance conventions; source commit aac694a1
- **Reversibility:** easy
- **Confidence:** high for deadline-contract mismatch; individual operation latency unmeasured
- **Revisit if:** the bounded fixture still times out or operation-level evidence reveals a hang
- **Source:** assumed — autonomous

## D10: Exclude ignored generated bundles while retaining authored-source UI enforcement
- **Question:** How should typecheck handle the actual mobile bundle diagnostics after the integration catch-up?
- **Options:** remove user-generated artifacts; add mobile/assets or plugin-specific exemptions; apply Git source-admission semantics once for all lint candidates
- **Chose:** Batch candidate paths through git check-ignore once, excluding only Git-ignored/unindexed output. Indexed sources remain linted even beneath ignored directories. Non-Git fixture trees continue scanning; unexpected Git execution errors fail honestly. Preserve all raw CSS/color/pixel rules and plugin enrollment. Add a behavioral regression for ignored output plus forced-indexed source in the same directory.
- **Why:** All 13 caught-up UI-lint diagnostics named generated, ignored mobile bundle assets, not tracked plugin source. The recursive source collector ignored Git admission rules while already excluding conventional dist/build output. No user artifact deletion, lint baseline, plugin-specific exception or build-output path migration is needed.
- **Evidence:** caught-up prepass typecheck output; git ls-files/check-ignore for plugins/quirky.mobile/assets/mobile/{index.html,page.css,page.js}; scripts/ui-lint.test.ts behavior; source commit aac694a1
- **Reversibility:** easy
- **Confidence:** high for actual generated-output admission failure
- **Revisit if:** authored/indexed source is excluded or Git errors silently reduce enforcement
- **Source:** assumed — autonomous

## D11: Preserve all four incoming restyle authorities
- **Question:** Do the sole roadmap catch-up's decisions conflict with this repair?
- **Options:** reopen resolved shared UI ownership; preserve the four incoming contracts and their evidence limits
- **Chose:** Read ui-restyle-ask D1–D12, ui-restyle-settings D1–D11, ui-restyle-tasks D1–D10 and ui-restyle-worktrees D1–D17 completely, including raw terminal Progress/recovery lines, through the scoped incoming-decisions reader. Preserve inert sanitized Ask previews, feature-owned API/validation/trust authority, canonical host slots, measured menus/stacked-dialog focus, and shared component/token enforcement. No editor-specific diff/cursor/EmptyState contract conflicts were found.
- **Why:** Those restyles intentionally leave feature ownership and semantics unchanged. Their historical build-first test/review limits remain historical rather than evidence that this end-phase fix is verified. Worktrees' browser Library-access warning also prevents a universal native-state-isolation claim from temporary HOME/profile alone.
- **Evidence:** sole clean roadmap merge after 01946b2e; ReadEditorIncomingDecisions full-file/raw receipt; four incoming decision logs
- **Reversibility:** easy
- **Confidence:** high for consumed contracts; no inherited whole-suite/native pass claim
- **Revisit if:** canonical landing identifies a concrete integration conflict
- **Source:** locked by incoming decision logs

## D12: Preserve green runner outcomes and their actual flaky qualifications
- **Question:** What do the final configured test receipts establish?
- **Options:** report every file as first-attempt clean; weaken tests to avoid configured retries; retain success with named retry history
- **Chose:** Source 08c595b9 passed editor/scripts plus typecheck, with core.test.ts initially failing and its configured isolated retry passing. Final canonical-root source 6d2b800a passed the complete 33-remote/1-macOS-file gate: remote initially 32 pass/1 fail, then markdown-acceptance.test.ts's configured isolated retry passed; the macOS-only file passed. Final test command exited 0 in 85.043s; root/UI-lint/mobile/prepared-desktop typecheck exited 0 in 35.764s. Preserve raw logs and both retry histories; do not claim a first-attempt or universal suite pass.
- **Why:** The runner explicitly treats a successful isolated retry as ok with a flaky inventory. The final initial markdown failure was a 5013.32ms hook timeout; the earlier core failures also followed 5-second timeout/cascade. Their individual slow operations are not diagnosed here, and no assertion is suppressed. The newly reached lint regressions also exposed and corrected an undersized Git diagnostic buffer and a missing required fixture source directory before this green gate.
- **Evidence:** .quirk/build-loop/fix-test-editor-1028/final-{tests,types}.log; review/prepass.json run bee4c95b76fdd41c; tests-with-core-retry.log and review/prepass-with-core-retry.json; lint-regression-tests.log and review/prepass-lint-regression.json
- **Reversibility:** easy
- **Confidence:** high for exercised configured outcomes
- **Revisit if:** an isolated retry stops passing or operation-level tracing identifies a real lifecycle hang
- **Source:** assumed — autonomous

## D13: Canonicalize fixture paths and prove actual macOS worktree isolation
- **Question:** Does a raw mkdtemp spelling match the daemon's canonical worktree identity on macOS?
- **Options:** compare symlink spellings; bypass identity selection; canonicalize the two fixture roots before registration and assertions
- **Chose:** Resolve both Explorer fixture roots with realpathSync. An actual macOS daemon API smoke registered one repository, listed two linked worktrees with distinct IDs, expanded/selected the first and independently selected the second, then asserted exact per-worktree expanded/selection state. It printed EXPLORER_MACOS_ISOLATION_OK and EXPLORER_MACOS_SMOKE_CLEANED and exited 0 in 2.90s.
- **Why:** The earlier real API smoke already demonstrated /var versus /private/var aliasing. Canonical fixture paths preserve the existing production identity authority rather than weakening matching. This makes the repaired linked-worktree test portable to the required macOS path layout.
- **Evidence:** source 6d2b800a; .quirk/build-loop/fix-test-editor-1028/macos-explorer-smoke.log; final remote/editor regression gate
- **Reversibility:** easy
- **Confidence:** high for named API/state assertions
- **Revisit if:** another supported filesystem alias changes canonical path selection
- **Source:** assumed — autonomous

## D14: Keep platform and native evidence bounded
- **Question:** Does portable code or a remote runner receipt certify every platform and native surface?
- **Options:** infer broad platform/native acceptance; retain only exercised macOS API/web evidence and explicitly defer remaining platform qualification
- **Chose:** Use portable Node/Git APIs and canonical paths. Keep Linux/Windows platform qualification and real native OS dialogs, focus, clipboard and window behavior outside these macOS API/web receipts; they remain with their platform/native owners. Do not claim that temporary HOME and a unique browser profile prove zero Library access.
- **Why:** LOOP locks macOS build/qualification scope, and browser controls are not OS-native acceptance. Remote suite execution reports test outcomes, not comprehensive platform approval.
- **Evidence:** docs/loop/LOOP.md platform/native rules; incoming Worktrees D13; actual isolated API/web receipts and configured suite result
- **Reversibility:** easy
- **Confidence:** high for the stated evidence boundary
- **Revisit if:** supported-platform or native qualification requirements change
- **Source:** deferred: platform

## D15: Recover review transport without altering or rerolling model findings
- **Question:** Did the first review runner failure mean Gemini was unavailable or that the review passed?
- **Options:** synthesize a pass; rerun every model; repair the transport parser and consume the original actual responses
- **Chose:** Preserve the failed transport receipt and every raw response. Fix only the scratch runner's header parser to accept pi-watch's real `(alias gemini)` suffix, then reuse the first valid recorded promote output for each unchanged prompt/artifact/model triple. Run fresh independent refute calls and the existing deterministic claims/merge/gate/manifest stages. No hand-edited model JSON, skipped lens or new source check is substituted.
- **Why:** All actual promote processes exited 0 with the selected Google/Gemini high triple; the runner incorrectly returned None from its stricter header regex. Those were successful model calls, not missing reviews or evidence of a clean branch.
- **Evidence:** review/protocol-output/bee4c95b76fdd41c/receipt-transport-failure.json; untouched promote.attempt{1,2}.{stdout,stderr}.raw and process metadata; completed resumed receipt.json
- **Reversibility:** easy (throwaway transport only)
- **Confidence:** high
- **Revisit if:** a recorded prompt/artifact/model differs or a deterministic stage refuses its chain
- **Source:** assumed — autonomous

## D16: Apply the single retained review finding within the bounded fix batch
- **Question:** How should the completed C/S/X review be adjudicated?
- **Options:** ignore the observed fixture timeout; change production deadlines; align the named full-daemon integration fixture with the established test budget
- **Chose:** Correctness C and security X passed with zero retained findings/advisories. C1, the duplicate budget observation, was refuted because its file was beyond the original diff. Spec compliance retained S1 at effective MEDIUM, low confidence: markdown-acceptance.test.ts lacked the permitted full-daemon budget and actually hit a 5013.32ms hook timeout in the gate. Accept S1 as a reached verification prerequisite; set that file's test budget to 60 seconds while preserving all assertions and production deadlines. Run one post-fix editor/scripts/typecheck batch; do not run a second model round, as LOOP explicitly directs.
- **Why:** The full-builtin fixture's allowed operation bounds already exceed Bun's default five seconds, as D9 records. This is a test-operation contract correction, not proof of a particular slow sub-operation or a production performance fix. The unmodified formal review receipt remains NEEDS_FIXES for its reviewed 6d2b800a snapshot, not a fabricated PASS for later source.
- **Evidence:** completed deep Google/Gemini C/S/X manifests; S/gate.first.json S1; C/merged.json C1 refutation; markdown-acceptance.test.ts; post-fix checks recorded next
- **Reversibility:** easy
- **Confidence:** high for observed timeout and applied budget contract; operation latency unmeasured
- **Revisit if:** the bounded integration fixture still fails or a later review finds a regression in the fix
- **Source:** assumed — autonomous

## D17: Land only after the accepted fix batch passes the complete affected gate
- **Question:** What final evidence closes the retained review prerequisite?
- **Options:** relabel the old S manifest as PASS; rely on source inspection alone; keep the historical review verdict and verify the actual fixed source
- **Chose:** Commit the S1 fixture-budget correction as ce0f355f and run the complete `bun scripts/suite.ts plugins/quirky.editor scripts` plus `bun run typecheck`. All 33 remote test files passed on the initial run, the one macOS-only file passed, and suite-result returned ok true with an empty flaky list. Root/UI-lint/mobile/prepared-desktop typecheck passed. The combined commit/check command exited 0 in 127.37s.
- **Why:** This directly exercises the corrected review-note fixture together with every editor and scripts test, without weakening assertions or relabeling earlier flaky runs. S1's requested budget is applied and the post-fix gate is green. There is no unaddressed accepted finding; no second model closure round was run, following LOOP's cap. The formal manifests still correctly describe the earlier reviewed snapshot.
- **Evidence:** .quirk/build-loop/fix-test-editor-1028/final-{tests,types}.log; source ce0f355f; completed C/S/X receipt and D16 adjudication
- **Reversibility:** easy
- **Confidence:** high for exercised checks and applied requirement
- **Revisit if:** canonical merge-result verification or later independent evidence identifies a regression
- **Source:** assumed — autonomous

## Progress
Ready for canonical land. Source ce0f355f closes S1; final complete affected gate passed 33/33 remote plus 1/1 macOS file with no retry/flaky entry, and full root typecheck passed. One bounded deep C/S/X round and its single accepted fix batch are complete; historical review verdicts and prior retries are preserved. Actual CSV, guarded web and macOS linked-worktree API smoke evidence and cleanup limits remain explicit. All four incoming decision logs were consumed after the sole catch-up; no source agent/model/runtime job remains. Commit this receipt, detach and run authoritative queue land for this item only; on a failed land follow the required recovery path.

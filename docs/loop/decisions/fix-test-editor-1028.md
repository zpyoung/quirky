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

## Progress
Final fixture correction is ready. Actual isolated API/browser smoke finished with D7 receipts; both owned browsers stopped and daemon printed EDITOR_SMOKE_CLEANED with exit 0, while unrelated revoked worktree/notification shutdown warnings remain visible (not pristine shutdown output). No orchestration source change remains. Next: commit, sole integration catch-up/read decisions, fresh editor/scripts/typecheck gate and bounded cross-family review, then canonical land.

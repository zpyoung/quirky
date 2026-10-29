# fix-test-ledger-1028 decisions

## D1: Restore the declared ownership provider rather than bypass project-removal safety
- **Question:** What explains the triaged ledger owner-removal and import/recovery failures?
- **Options:** bypass session discovery in repo removal; add a ledger-specific alias/fallback; register the existing declared Worktree method
- **Chose:** Add the existing `ownedIds` implementation to Worktree's handler map. Its implementation, manifest contract and repo caller remain unchanged. Preserve existing consumer-visible ownership, removal, retention, identity and import tests.
- **Why:** The baseline reports `quirky.worktree did not provide method:quirky.worktree/ownedIds`. The method is implemented and declared, but the sole provider loop only registers handler-map members. Repo removal invokes it before closing sessions and forgetting the owner. The existing Worktree ownership test and ledger removal/recovery tests are the failing-before regression evidence; duplicating a registration inventory test would not test a consumer-visible invariant.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.ledger; plugins/quirky.worktree/main.ts:306-311,431-642; quirky-plugin.json ownedIds contribution; plugins/quirky.repo/src/projects.ts:135-139; plugins/quirky.worktree/test/worktree.test.ts:339 onward
- **Reversibility:** easy
- **Confidence:** high for the missing provider; current post-repair gate pending
- **Revisit if:** canonical verification identifies an ownership/session-safety error after registration
- **Source:** assumed — autonomous

## D2: Consume the landed Ask repair without adding another confirmation path
- **Question:** Does the older connection-bound ask/wait failure need a ledger workaround?
- **Options:** weaken Ask's client admission; duplicate confirmation handling; reuse the landed kernel confirmation repair
- **Chose:** Preserve ledger's real confirmation and one-use replay assertions. The current broker already consumes durable answers through public ask/list, as fix-test-ask-1028 D3 requires.
- **Why:** The prior owner traced the kernel's illegal connection-bound wait, repaired its source and exercised the actual Ledger confirmation consumer. The baseline error does not justify undoing that cutover. Shared repo harness already includes required quirky.cli whenever Worktree is selected; no duplicate fixture dependency change is needed.
- **Evidence:** docs/loop/decisions/fix-test-ask-1028.md D3,D7; packages/daemon/src/plugins/confirm.ts; plugins/quirky.repo/test/harness.ts:126-127; plugins/quirky.ledger/test/ledger.test.ts:542-563
- **Reversibility:** easy
- **Confidence:** high for already-landed repair; current gate pending
- **Revisit if:** current real confirmation consumer fails
- **Source:** locked by docs/loop/decisions/fix-test-ask-1028.md D3

## D3: Keep the cross-plugin repair narrow and expose it to the queued owner
- **Question:** Who owns a missing Worktree method blocking Ledger when Worktree and Repo repairs are still queued?
- **Options:** block Ledger waiting for unclaimed repairs; take over all their failures; fix this single shared defect and document ownership
- **Chose:** Repair only the existing ownedIds registration here. At claim time fix-test-worktree-1028 and fix-test-repo-1028 are todo/unassigned. Their future owners must consume this landed repair rather than duplicate it. No other Worktree/Repo behavior is adopted. Run affected consumer verification and retain unrelated failures under their existing queue owners.
- **Why:** Ledger cannot exercise removal, detach, recovery or import with this declared method absent. There is no concurrent owner to conflict with, and no new API or alias is required.
- **Evidence:** canonical queue claim; read-only queue status; source baseline bb169fdb2a93b341e2de3b008226db21bce0b85b; D1 consumers
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an active owner lands a conflicting registration or changes the public contract
- **Source:** assumed — autonomous

## D4: Use bounded unattended repair and independent cross-family review
- **Question:** How should implementation, runtime verification and review run without a person?
- **Options:** new feature specs; human decisions; focused end-phase fix with owned resources and an available cross-family reviewer
- **Chose:** One omp/OpenAI worker registers the method; parent owns evidence, checks and landing. Workers skip checks mid-flight. Use canonical remote suites, private process homes, actual daemon/API smoke, typecheck and one final review round with at most one accepted-finding fix batch. Opus and Sonnet preflight each exit5; Gemini resolves google/gemini-3.1-pro-preview:high. No LSP server is configured. Preserve inherited untracked .quirk/ and .serena/.
- **Why:** This is an existing-flow repair, not feature development. The older window timeout includes a successful retention preview but not its precise failed wait; test its current behavior before inventing a UI fix. No UI/native contract changes are planned. No platform/native qualification is inferred from remote test execution.
- **Evidence:** current LOOP.md Fix items/end phase; pi-watch preflights; xd://lsp status; triage window page snapshot
- **Reversibility:** easy
- **Confidence:** high for process/tool evidence
- **Revisit if:** current verification traces a distinct ledger or UI defect
- **Source:** assumed — autonomous

## D5: Prove the ownership repair through an actual isolated subprocess daemon
- **Question:** What runtime evidence distinguishes a registered route from a merely compiling map entry?
- **Options:** provider-inventory assertion; only tests; actual daemon, real temporary Git, public API and public CLI
- **Chose:** The private subprocess daemon returned the primary worktree ID, rejected a stale ledger snapshot without removing the repo, accepted a fresh snapshot while preserving disk contents, exposed the detached entry, recovered the same ledger and edited title after same-root re-add, and let the real `ledger show --json` CLI read the exact entry. Smoke exited0 in1.71s, printed LEDGER_REAL_DAEMON_API_CLI_OK and LEDGER_SMOKE_CLEANED, and asserted owned home removal after daemon/process-scope cleanup.
- **Why:** This exercises the restored route through a real caller and proves the immutable retention/recovery boundary without aliases or mocked owner APIs. Session shutdown remains covered by existing affected tests; this smoke used the selected real Repo/CLI/Worktree/Ledger/Ask plugins and no session fixture.
- **Evidence:** .quirk/build-loop/fix-test-ledger-1028/macos-smoke.log and .result.json; scratch smoke.mjs; existing Worktree ownership regression passed in affected-tests.log:15420
- **Reversibility:** easy
- **Confidence:** high for exercised behavior
- **Revisit if:** a consumer discovers a missing recorded ID or removal loses ledger state
- **Source:** assumed — autonomous

## D6: Retain actual browser observations and the guard's explicit partial verdict
- **Question:** Can the previously failing removal UI be exercised on the real built web surface?
- **Options:** infer it from headless tests; fabricate a clean pass after tooling refuses an optional step; retain observed removal/retention and the partial report
- **Chose:** Built UI/desktop successfully (exit0/18.85s), launched a private actual daemon and real seeded Git projects, then used only guarded web actions with owner yours/unattended. Screenshots show the one-entry retention notice, successful removal of only the seeded source, detached chooser row and retained proposal-1 titled Keep after owner removal. Optional details clicks twice returned STALE despite a fresh observation of visible e2048. The report remains partial, not relabelled pass. Search fill returned NO_EFFECT for the value signal although its screenshot and tree showed the intended filter. No application defect is inferred from either driver result.
- **Why:** The real removal and retained-record surface is visible, but a tool-limited optional interaction is not verified. LOOP permits a recorded partial caused by the tool. No direct page scripting/API calls performed the UI task; API use only seeded fixture setup before begin. The browser report lists no findings, no overrides, no kept-open resources and no cleanup errors. The owned UI service subsequently exited0 and removed its home.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261029T012913-ab8f/report.json; obs3/4/8/10/11 screenshots; ui-build.log; supervised ledger-lane2-ui exit0
- **Reversibility:** easy
- **Confidence:** high for observed removal/retention; no optional-details clearance
- **Revisit if:** a supported guard can act on the current detail reference or the app exhibits an actual failed action
- **Source:** assumed — autonomous

## D7: Keep the broad failed gate and investigate the newly reached ledger fixture boundary
- **Question:** What did the first current affected run establish?
- **Options:** claim full success; take over every queued Worktree/Repo defect; retain raw failures and repair Ledger's actual fixture failure
- **Chose:** Preserve the complete broad receipt: canonical Ledger/Repo/Worktree/scripts gate exited1 in361.00s,41/69files passed,28failed,flaky:[]. All Ledger API/import files passed; its window file failed seven times before its behavior assertions because boot's `section.repo` selection found no rendered project despite the visible api heading. Existing Worktree ownership removal regression passed. The other failures are26Worktree files and Repo hooks, with existing queued owners; no broad-suite clearance is claimed.
- **Why:** The missing provider is closed on the actual ownership path. Ledger's current all-window startup failure needs a causal DOM-contract trace rather than a product fallback or an increased deadline. Shared source/UI behavior is not changed to satisfy stale fixture structure.
- **Evidence:** .quirk/build-loop/fix-test-ledger-1028/affected-tests.log and .result.json; raw ledger failure571-672; ownership pass15420; queue fix-test-worktree-1028/fix-test-repo-1028
- **Reversibility:** easy
- **Confidence:** high for observed outcomes; semantic fixture repair pending
- **Revisit if:** fixture trace identifies an actual product UI defect
- **Source:** assumed — autonomous

## D8: Preserve the selectors and restore text nodes at the shared accessible-name boundary
- **Question:** Why does a rendered api heading fail the existing semantic heading matcher?
- **Options:** remove repo/group classes from test selectors; increase waits; restore the missing text-node recursion base case
- **Chose:** Add only `if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''` to shared `test/window/dom.ts`'s private visibleText helper. Preserve `aria-hidden` exclusion, descendant traversal, all current selectors and every Ledger assertion. Existing actual UI scenarios are the red regressions; no source-text/registration inventory test is added.
- **Why:** Tree still renders section.repo/section.group. SectionHeader gives h2 ordinary child text; sectionHeading calls accessibleName, whose fallback previously recursed into text nodes with zero children and returned empty strings. Removing a class cannot repair that data loss. The initial scout suggestion was rejected on this contradictory source evidence, then independently corrected. The second identical broad canonical gate tests the addition under the same check as the first red receipt.
- **Evidence:** plugins/quirky.worktree/test/window/dom.ts:13-17,39-46; src/Tree.tsx:691-702,747-758; packages/ui/src/design-system/navigation.tsx SectionHeader; current Ledger boot failures; LedgerWindowTrace corrected report
- **Reversibility:** easy
- **Confidence:** high for causal trace; corrected gate pending
- **Revisit if:** the preserved meaningful Ledger scenarios still fail after text is retained
- **Source:** assumed — autonomous

## D9: Coordinate the newly active Repo owner and retain exactly one ownership registration
- **Question:** What if another lane claimed Repo after this branch's queue snapshot?
- **Options:** silently diverge; remove the provider from either consumer; exchange the exact shared repair and preserve one map entry
- **Chose:** Read the authoritative integration queue: Worktree remains todo, Repo is now in progress on lane10. Sent the exact ownedIds registration checkpoint899636d6, broad gate outcomes and shared text-node helper ownership to its live omp terminal. Receipt accepted:true/input_accepted; delivery/turn proof is unsupported, so do not claim the peer read it. Future Worktree owner must consume the shared helper fix; neither lane needs an alias or a second ownedIds entry.
- **Why:** Lane10's decision log independently names the same missing provider and its correct regression passes. Identical shared edits can be merged without inventing a compatibility path. Its unrelated hooks mirror repair stays with Repo.
- **Evidence:** integration queue read; lane10 docs/loop/decisions/fix-test-repo-1028.md D3–D5/Progress; Orca request30cbb6cd-6c7c-4816-9220-307957ba094f
- **Reversibility:** easy
- **Confidence:** high for source/receipt; peer consumption not observed
- **Revisit if:** integration reports a concrete shared-line conflict
- **Source:** assumed — autonomous

## Progress
Ownership registration and one shared test-helper base case are implemented without changing Ledger assertions. Actual private subprocess API/CLI lifecycle smoke passed. Guarded browser removal/retention was observed; optional-details tool limit remains honestly partial. Initial two-file independent Gemini review passed; incremental helper review and identical broad rerun pending. Next: resolve only Ledger's current failures, complete affected gate/review, sole roadmap catch-up/read incoming decisions and typecheck, then commit/detach/canonical land exactly this item.

# fix-test-git-1028 decisions

## D1: Repair the entire assigned Git failure inventory at its consumer boundary
- **Question:** Which failures and workflow belong to this end-phase fix?
- **Options:** rerun the reported baseline; repin presentation/default/catalog copies; diagnose the evidence and repair consumer behavior and meaningful regression coverage.
- **Chose:** Treat baseline failures as ground truth, trace each assigned file, delete incidental assertions rather than repinning them, and retain acceptance checks for actual actions, ownership, refusal, persistence and state transitions.
- **Why:** The end-phase item names the entire plugins/quirky.git group; no flow may be silently discarded. Fix items skip brainstorming and specifications.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups.plugins/quirky.git; complete compressed transcript; authoritative build/roadmap:docs/loop/LOOP.md Fix items and The end phase.
- **Reversibility:** easy (repair scope and test ownership)
- **Confidence:** high
- **Revisit if:** root-cause evidence identifies a separately owned upstream change.
- **Source:** locked by docs/loop/LOOP.md

## D2: Use the canonical test host and isolated runtime ownership
- **Question:** Where may verification run, and what state may it touch?
- **Options:** direct local suites against inherited state; canonical suite runner with its remote placement and explicit native exceptions, fresh temporary runtime homes.
- **Chose:** All test commands use bun scripts/suite.ts <paths>, retaining the runner's macOS exceptions. Real CLI/API smoke uses fresh HOME/QUIRKY_HOME and owned process cleanup. Preserve unrelated .quirk/.serena files. No asks, authentication changes, or real provider launches.
- **Why:** Prior operator instruction forbids competing local suite load and LOOP forbids real-state mutation. Existing agent-status hooks manifest correction is inherited; do not create a compatibility alias for its historical missing setting.
- **Evidence:** docs/loop/decisions/fix-test-agent-status-1028.md D4,D7; scripts/suite.ts:8-19,96-117; docs/loop/LOOP.md Hard rules.
- **Reversibility:** easy (execution placement only)
- **Confidence:** high
- **Revisit if:** the authoritative execution policy changes.
- **Source:** locked by docs/loop/decisions/fix-test-agent-status-1028.md D7

## D3: Partition three disjoint repair slices without changing public contracts
- **Question:** Which execution, ownership, backend and specification choices apply to this fix?
- **Options:** one broad worker; concurrent edits to shared UI files; three isolated slices with a single integration owner.
- **Chose:** One parallel wave of three omp task implementers: daemon/pure/scenarios (src/daemon, test/pure, test/scenarios, plugin manifest/CLI); window integration (test/window only); component UI (other src UI and test/ui plus test/ui.test.ts). Parent owns docs, integration and verification. Existing public API signatures and shared types remain the contract; no new schema/type/API is planned. Fix items skip new specs. Workers do not commit or run checks mid-flight.
- **Why:** All 25 reported files fit these scopes without overlap; shared fixture corrections can repair multiple consumer scenarios without changing product semantics. Window owner requests production changes from the component owner through the parent. External temporary worktrees avoid inherited unrelated files.
- **Evidence:** read-only GitFailureMap inventory; exact triage assertion diffs; docs/loop/LOOP.md Fix items; source fixture locations in scout handoff.
- **Reversibility:** easy (ownership only)
- **Confidence:** high
- **Revisit if:** diagnosis requires an overlapping or upstream file; amend ownership explicitly before writing.
- **Source:** assumed — autonomous

## D4: Use the reachable cross-family reviewer without authentication changes
- **Question:** Which model pairing can execute the required final review unattended?
- **Options:** omp task implementers with opus; next reachable cross-family alias; same-family fallback.
- **Chose:** OpenAI omp task implementers and Gemini google/gemini-3.1-pro-preview:high reviewer. One final review round and one accepted-finding fix batch as LOOP requires.
- **Why:** pi-watch full preflight found opus unavailable (0/8), sonnet unavailable (0/6), Gemini reachable. LSP status found no configured servers, so reference searches fall back to existing source tools.
- **Evidence:** this iteration's pi-watch --check and xd://lsp status output; /tmp/quirky-git26-p2p11C/journal.json.
- **Reversibility:** easy (review backend only)
- **Confidence:** high
- **Revisit if:** the selected reviewer actually fails dispatch.
- **Source:** assumed — autonomous

## D5: Preserve whole-pick shadowing and repair the actual API test boundaries
- **Question:** Does raw-model precedence require changing the provider resolver, and which daemon tests remain meaningful?
- **Options:** change upstream effort inheritance; repin provenance/schema/catalog copies; preserve locked launch behavior and assert actual argv/refusal/nonmutation.
- **Chose:** No production changes. Raw model wins exactly once and discards the model-dependent structured effort, as launch-settings SC-15 requires. Invalid CLI/API actions are rejected at their real dispatcher boundary without persisting anything; branch/name generation preserves its captured context and branch/title. Split all three malformed Git argument calls. Wait for the captured structured turn before inspecting it. Use an explicit real-newline baseline to distinguish HEAD, index and working content.
- **Why:** The earlier launch-settings amendment explicitly says model extras shadow the whole pick because options belong to the picked model. Dispatcher validation precedes handler reason payloads; structured/create schedules journaling asynchronously. The original HEAD assertion used literal escaped newlines. A first worker revision used a trimming Git helper; parent rejected it before execution and retained byte-exact input/output checks.
- **Evidence:** docs/quirk/specs/2026-10-26-m1-launch-settings/logic.md:10,261-268; tech.md:241-244; raw triage log:2750-2970,7739; test/scenarios/ai-world.ts runGit; test/scenarios/diff.test.ts.
- **Reversibility:** easy (tests only)
- **Confidence:** high for source/evidence; canonical tests remain pending below.
- **Revisit if:** actual launched argv or persisted state contradicts the locked precedence.
- **Source:** locked by docs/quirk/specs/2026-10-26-m1-launch-settings/logic.md SC-15

## D6: Correct fixture ownership instead of changing Git UI behavior
- **Question:** What explains the UI and window failure families?
- **Options:** restore legacy layout/CSS/DOM behavior; adapt fixture lifecycle, public hosted authority and semantic user controls.
- **Chose:** Let startHeadlessWindow own its DOM registration; load component ReactDOM/portal modules after registerDom. Read hosted diff identity from the terminal workspace instead of legacy layout.view, and scope editor access to its Git view root. Follow shared toast/alert controls and enabled primary readiness; install the reveal seam before daemon activation. Preserve plugin-owned listeners when checking component disposal, and ensure disposed views do not refresh. Retain actual API/CLI/window actions while removing obsolete catalog/whole-report/copy/mock-forwarding mirrors.
- **Why:** The restyle and terminal-hosted cutovers preserve product flows but invalidate private presentation and legacy routing assumptions. A plugin lifetime is longer than a single panel/view mount. No compatibility alias, timeout increase, source bypass or new product state is needed.
- **Evidence:** component8099413b/window6869d500/UI8ed17e60; raw triage hosted registration and UI event failures; src/view/hosted-tabs.ts; test/window/world.ts and dom.ts; test/ui/ai.test.ts.
- **Reversibility:** easy (tests only)
- **Confidence:** high for identified boundaries; composed checks remain pending.
- **Revisit if:** the canonical suites expose a remaining consumer-visible defect.
- **Source:** assumed — autonomous

## D7: Compose all incoming restyles at the single catch-up
- **Question:** Do concurrent Worktrees, Tasks and Settings decisions conflict with the repair?
- **Options:** discard incoming presentation contracts; preserve their shared controls and authority.
- **Chose:** Single clean roadmap merge after the three audited component merges; read all three incoming logs fully, including untruncated Worktrees D17 and Settings D8/Progress. Preserve canonical rich ContextMenu geometry, native shared fields and stacked Dialog ownership, host tool placement and unchanged feature APIs. All worker trees retained14ab2a40; parent source delta was empty at the barrier. Their copied .serena metadata was not staged.
- **Why:** The repair owns tests, not another presentation convention or unrelated source. Current shared source must be exercised rather than earlier isolated branches.
- **Evidence:** all-tree HEAD/path/untracked barrier; component merge receipts; docs/loop/decisions/ui-restyle-{worktrees,tasks,settings}.md.
- **Reversibility:** easy (composition only)
- **Confidence:** high
- **Revisit if:** required canonical landing recovery brings an actual conflict.
- **Source:** locked by incoming ui-restyle decisions

## D8: Exercise actual CLI/API behavior and disclose driver and generated-cache limits
- **Question:** Which runtime observations support the test-only repair?
- **Options:** claim tests alone; relabel failed smoke probes; retain exact real-daemon CLI/API outcomes and clean source compiler scope.
- **Chose:** Disposable real Git repository/daemon/CLI proved staged HEAD-to-index, unstaged index-to-working and editor HEAD-to-working bytes; save; stale-write refusal without mutation; global recipe save/read through CLI; branch unchanged. All private homes/process scopes removed. Initial probes incorrectly compared /tmp with canonical /private/tmp and required a working-file hash on read-only staged diffs; corrected only the throwaway driver. Cleanup logged the inherited worktree deactivation warning; no pristine-output claim.
- **Why:** Real runtime state is independent evidence; fixture mistakes are not product defects. Root typecheck encountered13lint diagnostics in an inherited ignored generated Mobile bundle after incoming Mobile lint enrollment. Those are build outputs, not source edits: preserve them in the user's worktree and run the same compiler command in an owned source-only verification checkout, removing only its newly copied ignored bundle. Do not weaken the scanner or mutate another area's implementation.
- **Evidence:** actual smoke exit0/4.73s GIT_PUBLIC_CLI_API_SMOKE_OK and GIT_PUBLIC_SMOKE_CLEANED true; failed root typecheck artifact23; git check-ignore -v names .gitignore:12 /plugins/quirky.mobile/assets/mobile/.
- **Reversibility:** easy (throwaway verification environment)
- **Confidence:** high for named exercised runtime paths; compiler and suite results recorded when available.
- **Revisit if:** canonical merge-result typecheck reports a source error rather than inherited ignored output.
- **Source:** assumed — autonomous

## D9: Finish every composed failure instead of stopping at the baseline inventory
- **Question:** How should the first caught-up canonical suite's27failed files be handled?
- **Options:** stop after the original25file inventory; file another owner for unclosed flows; repair all exercised Git failures in this item.
- **Chose:** second disjoint three-worker repair wave, same ownership boundaries plus API ownership of the newly exercised merge-preview test. Retain all user flows; no production changes. Canonical full suite is the gate rather than worker reports. All workers keptb9d380e9, changes matched their scopes, and copied metadata stayed unstaged. Commits e6fbf495/c51f3905/9176e44c were merged and their worktrees removed.
- **Why:** first composed suite observed57/84passing files,27failures, no flakes,450.59s; changed controls exposed additional outdated selectors beyond the baseline. A partial repair is not completion.
- **Evidence:** parent artifact18 full1834line suite output; second all-tree HEAD/path barrier; source candidate bfeef3df; follow-up canonical gate below.
- **Reversibility:** easy (tests and fixtures only)
- **Confidence:** high for observed inventory; final gate pending.
- **Revisit if:** the full composed gate exposes another unresolved consumer path.
- **Source:** locked by docs/loop/LOOP.md end-phase verification

## D10: Exercise real confirmation consumption and preserve security boundaries
- **Question:** Why did accepted CLI confirmations still exit1, and why was merge preview's worktree API unavailable?
- **Options:** add --yes or fake a success; widen production confirmation; supply complete real providers in the fixture.
- **Chose:** Real quirky.ask provider and public list/answer lifecycle in the Git scenario fixture; answer exactly the newly created pending ask, retaining accept/decline/no-mutation checks and verifying explicit --yes creates no additional ask. Remove obsolete fakeAsks/answerAsk exports and all their consumers. Include quirky.cli in merge-preview's hosting fixture so the worktree plugin's declared dependency can activate.
- **Why:** the old fake implemented create/wait but not list; current confirmation consumption reads list and maps absence to asks-off. Fixture incompleteness is not a reason to bypass the kernel. The merge fixture omitted a declared plugin dependency.
- **Evidence:** source-traced kernel confirmation and real Ask methods; test/scenarios/fixture.ts/discard.test.ts; test/merge-preview.test.ts; existing plugin dependency declarations.
- **Reversibility:** easy (fixture only)
- **Confidence:** high for source trace; actual confirmation smoke and suites recorded below.
- **Revisit if:** real confirmation receipt is not consumed exactly once by the exercised CLI.
- **Source:** assumed — autonomous

## D11: Keep semantic action coverage rather than private rendering copies
- **Question:** How should the newer restyle's selector/glyph/label failures be repaired without weakening flows?
- **Options:** restore old classes or re-pin newer text; use existing semantic controls and remove incidental snapshots.
- **Chose:** Follow labeled inputs, action names, active hosted Git root, contenteditable editor state, alert/status roles and aria-expanded section state. Explicitly close the panel when noPanel is requested instead of assuming a shell default. Resolve Create PR by its actual action, not the first nested button. Delete decoration/class/glyph/size/catalog/chrome/copy-only assertions, preserving conflict parser boundaries, real conflict navigation, editing/save/stale recovery, note selection/send, preview/pin/split/dirty close, badge counts, disabled duplicate prevention, confirmation cancellation and error retry recovery.
- **Why:** restoring private presentation would create a compatibility layer. Parent rejected replacement decoration-label wording mirrors and empty-array collapse tautologies; each known file section now exercises its actual collapse transition. Hosted-diff tests omitted the existing real-daemon test category argument: use that category's90second outer budget, not Bun's5second unit-test default; no product polling/RPC deadline changed.
- **Evidence:** second-wave test deltas; test/window/dom.ts/world.ts/hosted-diff.test.ts; test/ui/notes-panel.test.ts/panel-remote.test.ts/view-combined.test.ts; pure/conflict-markers.test.ts.
- **Reversibility:** easy (test drivers only)
- **Confidence:** high for intended coverage; final exercised results follow.
- **Revisit if:** a semantic selector cannot locate the actual active action or a claimed path still fails.
- **Source:** assumed — autonomous

## D12: Supply headless geometry and respect the intentional embedded-report contract
- **Question:** Why did valid active hosted tabs still have no rendered Git root, and why would hosted report waits remain invalid?
- **Options:** change terminal rendering or embedded host reporting; emulate the existing headless stage and assert the actual supported public/visible state.
- **Chose:** Actual disposable runtime diagnostic found a valid active Git tab, no errors, and an empty qt-groups element. Adopt the terminal acceptance fixture's measured-stage convention in Git world:1024×768 only for terminal groups/panes/body, before opening the workspace, restoring the exact prototype at cleanup. Keep production's zero-size guard and mountView unchanged. Embedded views deliberately have no slot report: use active public tab input, real editor selection/document, rendered controls and persisted file state for hosted flows. SC65 separately exercises the supported explicit top-level ui.view.open report after validating hosted rendering.
- **Why:** GroupView renders no groups while useBoxSize measures0×0 in Happy DOM. Source host.ts explicitly documents no embedded status/report and calls providers with input only; inventing reports or remounting every hosted flow as a top-level view would hide the contract. A focused worker owned only six content-test files, with parent owning geometry/hosted/action/helper corrections. No production source or public signature changed.
- **Evidence:** actual hosted diagnostic artifact43, HOSTED_DIAGNOSTIC_CLEANED; plugins/quirky.terminal/src/window/workspace/GroupView.tsx:287-288/useBoxSize.ts; existing test/e2e-ui/support.ts stubLayout; packages/ui/src/plugins/host.ts:129,595-621; focused content-test delta artifact45.
- **Reversibility:** easy (fixtures and tests)
- **Confidence:** high for source/runtime boundary; post-repair runtime and suite receipts follow.
- **Revisit if:** the actual measured fixture still cannot mount its active hosted view.
- **Source:** locked by existing public embedded mountView contract

## D13: Preserve complete failure evidence and correct asynchronous action readiness
- **Question:** What did the second composed gate prove, and which remaining test defects did it expose?
- **Options:** call71passing files complete; rerun failures unchanged; repair their demonstrated driver and ownership errors.
- **Chose:** Retain second gate71/84pass,13failed,no flakes,598.44s as failed evidence. Fix a missing selector bracket, wait for the preview-backed Cancel action instead of the dialog shell, prefer explicit aria labels where present and associated labels for current native fields, and avoid expecting a folder-unavailable EmptyState to be an alert with arbitrary fake copy. Hosted split waits for both the new group and final tab rekey; dirty-preview replacement waits for the new tab before checking the old dirty one.
- **Why:** action shell existence and tab existence can precede completion. Earlier predicates could inspect transient state or an existing tab. The expanded real CLI/API smoke passed with confirmed discard and zero pending asks; clean-source full typecheck passed in the same47.48second combined command, so no production security/reporting change is justified.
- **Evidence:** second complete suite artifact40; expanded smoke/typecheck bg7; corresponding parent driver corrections; no product changes.
- **Reversibility:** easy (test drivers)
- **Confidence:** high for the observed failures and exercised smoke, not a final suite claim.
- **Revisit if:** current acceptance still fails after the demonstrated fixture corrections.
- **Source:** assumed — autonomous

## D14: Finish the headless platform prerequisites and audit lost actions
- **Question:** What did the measured-runtime checks and subsequent targeted suites establish?
- **Options:** bypass terminal rendering; increase waits; supply the existing fixture platform and restore every real user action.
- **Chose:** Pair measured layout with the terminal fixtures' existing Canvas2D test context, restoring both prototypes. Actual hosted diagnostic then mounted the real Git editor with problems[] and cleanup in5.15s. Keep the earlier geometry-only Canvas failure and20file2pass/18fail result as failed evidence. Later targeted results were11/20pass9fail, then14/20pass6fail. A read-only audit of the entire task-owned test delta found three accidentally deleted combined-view actions; restore both open-changes calls and the actual oversized editor replacement. No renderer or deadline workaround.
- **Why:** enabling layout exposed Happy DOM's missing native Canvas context. A test that never opens its view or applies its draft cannot prove acceptance. Parent also restored the omitted buttonText import; full source compiler then passed56.58s at4d19eb8e.
- **Evidence:** actual diagnostics artifacts43/48/54; canonical targeted artifacts47/51; GitActionLossAudit; commits2ff52de9/cd3c2521/4d19eb8e; complete current test actions.
- **Reversibility:** easy (test platform and drivers)
- **Confidence:** high for exercised boundaries; not a pixel-rendering claim.
- **Revisit if:** a native/browser renderer disagrees with the deterministic DOM fixture.
- **Source:** assumed — autonomous

## D15: Repair actual hosted navigation at its public API boundary
- **Question:** Why did a fully acknowledged Option-click still create only one group, and why could navigation remain behind a standalone view?
- **Options:** weaken the split assertion; add retries or legacy aliases; use the existing legal tab-owner API and canonical navigation.
- **Chose:** Remove the forbidden workspace field from Git's moveTab call; retain tab, side, target group and revision. After final hosted identity is established, select that worktree's workspace view when a different top-level view was showing. Return the existing open promise from open-changes/open-commit. Route CombinedDiff's branch, conflict and file links through the same registered Git commands. Preserve ConflictReview's explicit standalone snapshot/return behavior and generic top-level reporting; no host/protocol API change.
- **Why:** the actual before diagnostic surfaced “Could not open diff: params.workspace is not allowed”, with the split-marked tab stranded in its original group. After the source correction, the same real event flow produced two groups, exact active group/tab identities, split:true, no toast and problems[]. Direct combined links previously bypassed the hosted owner, and the two handlers replied before their asynchronous operation. No retry, source suppression or new schema is needed.
- **Evidence:** actual before/after flow diagnostics; plugins/quirky.git/src/view/{hosted-tabs,commands,CombinedDiff}.tsx/ts; quirky.terminal moveTab schema/service; public hosted-diff and combined-navigation regressions; README Hosted diff navigation.
- **Reversibility:** easy (local caller corrections)
- **Confidence:** high for demonstrated split repair; combined and real-browser receipts follow.
- **Revisit if:** final real navigation or source-level review contradicts tab/selection ownership.
- **Source:** assumed — autonomous

## D16: Consume the landed Hosting correction without duplicating its repair
- **Question:** How does the other lane's canonical handoff affect the remaining GitHub creation flow?
- **Options:** modify Hosting again; wait without doing reachable Git work; consume its exact independently landed source commit.
- **Chose:** Read the complete Hosting D1–D6 log and exact two-file source inventory, then consume sourcec96115df only. Keep its independently verified fixtures and two newline delimiter corrections unchanged. No second unsolicited roadmap merge and no competing Hosting implementation.
- **Why:** the owning lane explicitly handed off its canonically landed correction at roadmapbc52520e. Current pushRepository still splits on literal backslashes, which can refuse an otherwise configured creation push. The owner reports17/17/no-flake, compiler/scripts127/0 and actual exact-fork push/closed refusal; those are its evidence, not a rerun or whole-consumer pass by this lane. Its broader85/151 red remains disclosed under the original owners.
- **Evidence:** user lane9 handoffs; git show c96115df inventory; bc52520e:docs/loop/decisions/fix-test-hosting-1028.md; current pr-review.ts:1052,1061.
- **Reversibility:** easy (dependency integration)
- **Confidence:** high for exact handoff/source boundary.
- **Revisit if:** this lane's final Git consumer scenario still fails with the landed parser fix.
- **Source:** locked by user lane9 canonical handoff

## Progress
All fixture/action repairs are committed through4d19eb8e. Parent now has three Git source caller corrections plus README and directly affected test coverage, including the demonstrated forbidden moveTab field fix. Read complete landed Hosting handoff; consume its exact source commit after committing this candidate. Next: compiler/UI build, affected canonical suites, fresh actual split/navigation/browser proof, deep3lens review and one accepted-finding batch, then final receipts and canonical land. No second unsolicited roadmap merge.

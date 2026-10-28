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

## Progress
Three test-only components audited, committed, merged and removed; sole roadmap catch-up complete. All four agents returned. Canonical full Git+scripts suite and clean-source verification typecheck are running. Actual isolated public CLI/API smoke passed with cleanup and explicit warning/driver limits above. Next: fix any exercised residual failure, complete one deep cross-family review round and accepted-finding batch, update receipts/notes, detach and land exactly fix-test-git-1028 through the canonical absolute controller.

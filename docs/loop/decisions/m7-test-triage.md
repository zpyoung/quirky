# m7-test-triage decisions

## D1: Triage the exact integration snapshot without product changes
- **Question:** What changes and checks belong to the first end-phase item?
- **Options:** repair failures immediately; report failures and enqueue independent repair owners
- **Chose:** report failures and enqueue one repair item per failing package, app or plugin; do not change product code
- **Why:** LOOP.md explicitly assigns triage the three complete commands and reserves debugging for queued fix items.
- **Evidence:** build/roadmap:docs/loop/LOOP.md, “The end phase”; baseline commit `97aaa12d9fdf91a966cbc78d5557e113fc9789b3`
- **Reversibility:** easy (report and queue metadata only)
- **Confidence:** high
- **Revisit if:** the operator changes end-phase ownership
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve complete command outcomes and configured retries
- **Question:** How should suite retry outcomes and unrelated concurrent integration changes be reported?
- **Options:** treat isolated retry passes as an unconditional clean run; preserve initial failures and final configured retry status on the exact baseline
- **Chose:** preserve initial failures, final outcomes, failing files/tests, and the tested commit; do not attribute failures to load without evidence
- **Why:** Repair lanes need reproducible evidence, and a later integration snapshot is not the tested snapshot.
- **Evidence:** required commands `bun scripts/suite.ts packages apps plugins`, `bun test scripts`, `bun run typecheck`
- **Reversibility:** easy (report wording only)
- **Confidence:** high
- **Revisit if:** the suite exposes additional failure evidence
- **Source:** assumed — autonomous

## D3: Keep existing flaky and native repair ownership
- **Question:** Should triage file a second repair for a failing file already assigned to an open flaky/native item?
- **Options:** duplicate per-area items; retain existing owners and queue only uncovered failures
- **Chose:** run authoritative `queue.ts status` immediately before filing, read open repair scopes, and omit files already named by open `fix-flaky-*` or `fix-native-*` items
- **Why:** The operator explicitly permits those repairs and sweeps in parallel and prohibits duplicate repair ownership.
- **Evidence:** operator interjection during this item; authoritative status and queue scopes read after the interjection
- **Reversibility:** easy (queue metadata only)
- **Confidence:** high
- **Revisit if:** an existing owner closes without repairing its failing file
- **Source:** locked by operator instruction

## D4: Leave sidebar-extras runtime and renderer repairs with lane 4
- **Question:** Who repairs the sidebar-extras activity fallback if the complete suite reports it?
- **Options:** create a competing implementation; report the failure and consume lane 4's correction
- **Chose:** report exact failures without editing sidebar-extras; any uncovered extras repair item must coordinate with `m2-sidebar-extras-followup` on `build/m2-sidebar-extras-followup`
- **Why:** Lane 4 explicitly owns `activity.test.ts:157` maximum-activity fallback and is already repairing its broad and isolated-retry failure; its renderer owner also controls Menu, Tree, ActivityFilters and sidebar-extras UI tests.
- **Evidence:** operator/lane-4 interjection during triage; no completion inferred
- **Reversibility:** easy (repair ownership only)
- **Confidence:** high
- **Revisit if:** lane 4 lands without closing the reported failure
- **Source:** locked by operator instruction
- **Coordination update:** lane 4 reports an affected 60-file gate with 42 failures (full output not yet gathered), a concrete incoming window-navigation fixture collision (`quirky.session` plus `fakeSession: true`, `EEXIST` across 10 tests), and migration of the ui-report pending-row whole-shape pin. Its owner is switching that fixture to real session plus agents and repairing missing group-menu controls. These are reported work in progress, not this triage's observed results or completed corrections.

## Required command results

Tested integration snapshot: `97aaa12d9fdf91a966cbc78d5557e113fc9789b3`.

| Command | Outcome | Evidence |
| --- | --- | --- |
| `bun scripts/suite.ts packages apps plugins` | Exit 1; 701/853 remote files passed, 152 failed; 6/7 macOS files passed, 1 failed; 2284.91 seconds | `artifact://64`; complete compressed transcript and grouped inventory linked below |
| `bun test scripts` | Exit 0; 81 pass, 0 fail, 844 assertions across 7 files; 75.45 seconds | `artifact://70`; synthetic failing test output belongs to suite/controller fixtures, not failed script tests |
| `bun run typecheck` | Exit 0; frozen install, UI lint, root/mobile TypeScript and desktop typecheck passed; 31.33 seconds | Parent job bg_62 output |
| `bun run typecheck` after the single integration catch-up | Exit 0; frozen install, UI lint, root/mobile TypeScript and desktop typecheck passed; 35.18 seconds | Candidate `faeac9702db1643fa740f81ed40f46eecfb9dce2`; parent job bg_63 |

## Failure report and repair ownership

Reader: repair lanes and the operator — Decision: which existing or new owner repairs each observed failure.

- [Grouped inventory](../reports/m7-test-triage.json): all 153 unique failed files across 30 areas, exact failed test names, extracted errors, and transcript line anchors.
- [Complete transcript](../reports/m7-test-triage.log.gz): raw output, including full assertion diffs and daemon errors. The JSON abbreviates individual long errors; the compressed transcript does not.
- Remote returned `suite-result {"ok":false,"flaky":[]}`. Its 152 failing files exceeded the runner's configured retry limit, so no isolated remote retry ran. Empty `flaky` does not establish determinism.
- The Mac failure was `plugins/quirky.terminal/test/e2e.test.ts`, “SC-23: kill asks first, force-quits the session and keeps its output”: expected process exit 0, received 1 at line 420. The configured isolated retry failed the same assertion. No extra confirmation run was performed.
- Newly queued owners: `fix-test-{apps-mobile,packages-daemon,packages-ui,packages-pty-host,agent-status,ask,browser,cli,editor,git,heimdall,mobile,loops,orchestration,notifications,session,tasks,terminal,worktree,vault,hosting,handoff,ledger,packages-cli,repo,terminal-dock,agents,accounts,packages-protocol}-1028`. Each title names its exact files and failed tests; all depend on `m7-test-triage`.
- `plugins/quirky.sidebar-extras/test/activity.test.ts`, “workspace activity projection > uses maximum activity and departure recency before creation and repository fallbacks,” failed with expected `1793222829668`, received `1793222769232`. No duplicate item: `m2-sidebar-extras-followup` retains this explicit repair. Worktree's repair also depends on that owner, preserving its window-navigation/ui-report and renderer corrections before residual repair.
- Immediately before filing, authoritative status and open flaky/native titles were read. No baseline failing file was named by an open flaky/native title; all four earlier flaky items were already done. Native repairs still own their independent OS scenarios; this suite is not native-window acceptance.
- `fix-test-scripts-1028` already existed, filed by another lane for the later `ui-screenshot-review` integration (reported 113 pass/13 fail). It was not added or modified here. This baseline's 81-pass script result does not contradict failures on that later snapshot.

## D5: Queue residual area repairs without repinning incidental assertions
- **Question:** How should 153 failing files be distributed without changing code in triage?
- **Options:** repair shared symptoms here; queue per-area owners with exact evidence and explicit cross-owner coordination
- **Chose:** 29 new area items plus the existing sidebar-extras owner, with complete failure names/errors in the report and exact names in queue titles
- **Why:** This retains every observed failure while preserving the operator's active repair ownership. Repair titles explicitly prohibit compatibility aliases, bypasses, or repinning wording/source/default/catalog mirrors; behavior remains the acceptance boundary.
- **Evidence:** complete suite transcript, generated grouped inventory, successful controller add, and authoritative queue readback
- **Reversibility:** easy (queue metadata and report only)
- **Confidence:** high for observed failures; root causes are intentionally uninvestigated
- **Revisit if:** later owners demonstrate extraction error or a consumed integration correction
- **Source:** locked by docs/loop/LOOP.md

## D6: Keep the baseline immutable across concurrent integration repairs
- **Question:** Do incoming repair commits replace the earlier complete-suite results?
- **Options:** relabel earlier failures as passing from later partial receipts; preserve the exact baseline and tell residual owners which corrections to consume
- **Chose:** preserve `97aaa12d` results and mark caught-up candidate `faeac970` as typechecked only
- **Why:** All eight incoming decision logs were read. Their four flaky fixes target different files from this baseline. The later terminal-owner item overlaps `worktree/test/window-navigation.test.ts` and repairs successful-navigation history; the worktree repair must consume that landed correction as well as lane 4's pending fixture/renderer work before repairing residual failures. Accounts' native sign-in Open repair is not accounts API/profile acceptance; browser native C2 remains blocked, not fixed. The incoming screenshot-review command has a separately owned scripts failure.
- **Evidence:** incoming decisions `fix-flaky-{pty-host-clear,pty-host-manager,quirky-worktree-create,terminal-features-pane}`, `fix-native-{m3-accounts-1028,sa-browser-agent-1028}`, `m7-terminal-owner-provisioning-and-selector-flows`, `ui-screenshot-review`; current typecheck exit 0
- **Reversibility:** easy (evidence and ownership annotation only)
- **Confidence:** high
- **Revisit if:** a repair owner supplies a newer complete-suite receipt for its residual area
- **Source:** assumed — autonomous

## Progress
All required baseline checks completed and all observed failing areas have repair ownership. The exact failed-file inventory and Mac retry were independently cross-checked against the transcript. The single integration catch-up is complete; all eight incoming decision logs were read, and caught-up root typecheck passed. No product/test source changed. Ready to commit this final report and land through the authoritative controller. Baseline failures are the intended triage deliverable; the later merged tree has not been claimed suite-green.

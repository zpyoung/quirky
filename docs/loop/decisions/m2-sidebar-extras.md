# m2-sidebar-extras decisions

Reader: autonomous builders and later operator review — Decision: preserve the scope and resume the exact next workflow step.

## D1: Implement the four M2 sidebar additions; leave review filters for M4
- **Question:** which sidebar-extras.md flows belong to this item (brainstorming scope)
- **Options:** all five additions; the four named by this item and roadmap M2
- **Chose:** cross-repo worktree groups, activity window, dirty Source Control marker, section separators. Review filters belong to M4. Source feature docs remain read-only outside this worktree.
- **Why:** the roadmap explicitly assigns these four to M2 and review filters to M4; every in-scope user flow and recorded defect remains required.
- **Evidence:** docs/roadmap.md:162-163,193; sidebar-extras.md “What the user can do”; docs/loop/LOOP.md:27-29,87
- **Reversibility:** medium (acceptance scope)
- **Confidence:** high
- **Revisit if:** another binding decision changes this slice
- **Source:** locked by docs/roadmap.md

## D2: Resolve decisions autonomously; skip human-only offers
- **Question:** how to run brainstorming and execution in an unattended lane
- **Options:** ask a person; apply LOOP.md's autonomous defaults
- **Chose:** no orca ask, quirky ask, or human questions. Skip visual companion and adhd offers; select every material standard gray area, work through its questions, and record recommended or source-mandated answers.
- **Why:** unattended questions would block the lane; LOOP.md specifies the replacement workflow.
- **Evidence:** docs/loop/LOOP.md:11-15,175-200; operator iteration note
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** this is no longer an unattended loop
- **Source:** locked by docs/loop/LOOP.md

## D3: Research Visual, Organization, API, CLI and Data concerns before design
- **Question:** domain classification and research phases (brainstorming steps 1-2)
- **Options:** visual-only; cross-surface design with repository survey and external pattern/pitfall research
- **Chose:** Visual (sidebar rows, controls, dot), Organization (membership and nesting), API/CLI (every view change scriptable), Data (local presentation persistence, identity/race correctness). Phase A dispatches SidebarCodeMap, SidebarPatterns and SidebarPitfalls concurrently in 2026; no implementation before design/spec review.
- **Why:** sidebar presentation must be observable through the public plugin API and must not change execution ownership.
- **Evidence:** docs/roadmap.md:19-38; sidebar-extras.md:3,88-150
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** research finds another necessary domain
- **Source:** assumed — autonomous

## D4: Select the material gray areas across all five domains
- **Question:** which standard gray areas require resolution (brainstorming Gray Areas Step 1)
- **Options:** Visual layout/information/loading/empty/error/interaction; Organization grouping/naming/duplicates/exceptions; API response/errors/versioning; CLI output/flags/recovery; Data persistence/idempotency
- **Chose:** all listed areas. Layout and information density follow compact sidebar rows; every added control has a scriptable counterpart; lifecycle writes retain repo ownership.
- **Why:** filters, membership and status decoration cross all these observable contracts; authentication, pagination, retries and progress reporting introduce no new choice beyond existing kernel conventions.
- **Evidence:** sidebar-extras.md “What the user can do” and “Edge cases and failure behaviour”; docs/roadmap.md:31-38
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** review finds an unconsidered observable ambiguity
- **Source:** assumed — autonomous

## D5: Activity windows are a visibility filter, not a new workspace list
- **Question:** primary options, cutoff semantics, exceptions, and empty-state recovery (Visual/Organization drill-in)
- **Options:** All or recent by default; rolling durations or calendar periods; hide or preserve current row; one total hidden count or activity-specific count
- **Chose:** default All; All, Live only, Past 24 hours, Past 7 days, Past 30 days, Custom. Rolling 1/7/30/custom days with inclusive cutoff. Preserve the open workspace for every mode. Live only uses workspace sleeping/liveness and exposes Except default branch (default on). Count only rows this window hides, including folder workspaces; clicking the count and Clear filters reset to All. A non-All window contributes one badge count.
- **Why:** explicit feature behavior; deriving visibility avoids a stale second list.
- **Evidence:** sidebar-extras.md:50-66,113-120; https://react.dev/learn/you-might-not-need-an-effect
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the existing sleeping rule cannot be matched without a contradictory scope change
- **Source:** locked by research/orca-features/sidebar-extras.md

## D6: Preserve recency, validate custom days, and do not let another client's preferences overwrite this client
- **Question:** input, error-state, activity precedence, quiet aging, persistence and client scope (Visual/API/Data drill-in)
- **Options:** free-form durations or positive whole days; clamp invalid or reject; creation-only activity or max of activity/visits/exits; global or per-client filter state
- **Chose:** default 30 custom days; digits only and positive safe integer, commit on Enter or blur, reject with “Enter a positive whole number.” and retain previous value. Activity=max(lastActivityAt,lastVisitedAt,lastExitedAt), falling back to createdAt, then repo addedAt. Departure stamps are separate session-lived state and must not reorder visit history. Reevaluate cutoff each 60 seconds. Persist presentation preferences per client; never replicate them as execution state. Legacy hide-sleeping migration maps true to Live only; legacy show-sleeping must not widen a time window.
- **Why:** these are observable boundaries specified by the source, including the recorded Tab/blur validation discrepancy; Quirky follows the documented blur contract rather than reproducing the failed Tab observation.
- **Evidence:** sidebar-extras.md:54,88-100,113-120,144-146; SidebarPitfalls research
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** client identity/persistence contracts need an explicit API extension
- **Source:** locked by research/orca-features/sidebar-extras.md

## D7: Worktree membership stays separate from repo ownership and group-folder identity
- **Question:** grouping criteria, naming, duplicates, lineage, and fallback (Organization/API drill-in)
- **Options:** move the repo; reinterpret existing groupId; add independent projectGroupId display membership
- **Chose:** independent nullable projectGroupId, never change repoId, path, parentId or existing groupId. Only Git worktrees of Git projects hold membership. A new group starts with selected “<display name> group”; only that row moves. Existing-group submenu disables the current group; remove clears membership. A grouped parent leaves children behind as flat rows, and ungrouping restores nesting. Loose rows precede grouped repo sections, carry a repo chip, and leave an empty repo placeholder if all its visible worktrees are diverted. Missing/unrendered groups fall back to repo placement.
- **Why:** the feature is sidebar presentation; changing execution ownership corrupts terminals and git. Existing groupId identifies folder workspaces on a group's parent folder and cannot be repurposed.
- **Evidence:** sidebar-extras.md:23-48,102-110,137-143; packages/protocol/src/model.ts:25-66; https://git-scm.com/docs/git-worktree
- **Reversibility:** hard (metadata and external API)
- **Confidence:** high
- **Revisit if:** the feature source changes ownership semantics
- **Source:** locked by research/orca-features/sidebar-extras.md

## D8: Membership actions use one guarded write path and preserve deletion safety
- **Question:** interaction-style, duplicate handling, stale operations and group deletion (Visual/Data/API drill-in)
- **Options:** drag-only; menu-only; equivalent menu and drag actions; last async result wins or compare captured identity/prior membership
- **Chose:** menu and drag both. Project grouping gates drag; eligible rows highlight group headers, current-group drop is a no-op, the row's own project target clears membership, and header hit wins. Compare immutable workspace instance identity and prior membership before applying delayed create-then-assign. Deleting a group releases members throughout its child-group subtree without deleting their metadata; normalize parent cycles on load. Folder rows get project-level actions instead of pretending membership succeeded.
- **Why:** every interaction and race guard is explicit parity; current geometry must determine the intended target.
- **Evidence:** sidebar-extras.md:30-48,103-110,139-143; https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** group lifecycle review finds a cross-plugin atomicity gap
- **Source:** locked by research/orca-features/sidebar-extras.md

## D9: Dirty status is active-worktree-only and accessible without relying on color
- **Question:** information density, loading/error states, count meaning and update scope (Visual/API drill-in)
- **Options:** all-worktree badge; active-worktree dot; unique paths or panel-entry count; independent status scan or existing snapshot
- **Chose:** Source Control branch icon plus dot and textual “Source Control — N uncommitted change(s)”; capped snapshots say N+. Count staged, unstaged and untracked panel entries separately, excluding lazy submodule-detail rows. Clean/no active/no status clears decoration; background worktrees never decorate it. Reuse the existing Source Control status API and refresh contract; delayed responses from a previously active workspace must not decorate the new one.
- **Why:** the dot is an addition to the Source Control activity tab, not a new count definition or a repository-wide indicator.
- **Evidence:** sidebar-extras.md:77-79,128-132,148-149; packages/protocol/src/model.ts:249-292
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** source-control status changes its count contract
- **Source:** locked by research/orca-features/sidebar-extras.md

## D10: Separators are visual-only and default on
- **Question:** layout, default, exceptions and persistence (Visual/Data drill-in)
- **Options:** borders affecting layout; pseudo-element hairlines; off/on default
- **Chose:** default-on “Sidebar section separators” in Appearance > Window & Sidebar, with description “Show divider lines between top-level projects and groups.” Hairlines above eligible top-level project/group headers; no line on the first header, after a host header, on the active sticky header, or on nested groups. No change to row heights or drop geometry.
- **Why:** explicit feature contract; decorative geometry must not shift row hit testing.
- **Evidence:** sidebar-extras.md:15,83-85,134-135,150
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the existing settings renderer needs a public section-placement extension
- **Source:** locked by research/orca-features/sidebar-extras.md

## D11: Keep existing CLI/error conventions and expose every new action
- **Question:** API response/errors/versioning and CLI output/flags/recovery (remaining drill-in)
- **Options:** renderer-only controls; typed daemon methods/commands with generated CLI and JSON readback
- **Chose:** declared namespaced methods and CLI for preferences, membership/create-group, group hierarchy, dirty state and rendered projection; view commands routed through the open window where appropriate. Reuse selectors, strict unknown-param validation, errors, text/JSON envelopes and existing confirmation behavior. Invalid values fail without mutation; omitted membership fields never clear stored membership. New fields are additive; no protocol bump or compatibility shims.
- **Why:** an agent must be able to drive every UI action and read the same result. Method names and schemas are build-only questions deferred to tech.md.
- **Evidence:** docs/roadmap.md:31-41,47-53; docs/loop/decisions/m0-scripting.md; sidebar-extras.md:140,145
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the API survey finds an existing conflicting contract
- **Source:** locked by docs/roadmap.md

## D12: Add a thin presentation plugin and extend canonical owners
- **Question:** which validated approach to build (brainstorming options and design approval)
- **Options:** A extend all existing plugins with presentation policy; B dedicated sidebar-extras presentation plugin plus canonical owner extensions
- **Chose:** B, without replacing/forking the entire sidebar: `quirky.sidebar-extras` owns client-local activity policy/recency/projection and activity icon. `quirky.worktree` still renders the sidebar and owns membership/activity metadata; `quirky.repo` owns group hierarchy/lifecycle. Calls cross public APIs only. The feature has its own namespaced API and CLI; canonical records are not mirrored.
- **Why:** preserves the explicit feature-plugin requirement and replaceability while avoiding a duplicate sidebar or competing data ownership. Both option-validation researchers found this boundary viable; in-place-only is simpler but gives extras no independent off switch.
- **Evidence:** ValidateInPlace and ValidateExtrasPlugin research; docs/loop/decisions/m0-core.md D5; https://backstage.io/docs/frontend-system/architecture/extension-overrides/ ; https://code.visualstudio.com/api/extension-guides/tree-view
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dependency review finds a cycle; extras must depend on canonical owners, never the reverse
- **Source:** assumed — autonomous

## D13: Add the activity item without changing D10 panel placement or activation
- **Question:** whether the missing activity-bar surface conflicts with binding UI API placement
- **Options:** substitute a header badge; relocate panel toggles; add a public icon slot while retaining existing controls
- **Chose:** additive public activity-item slot beside the right sidebar, with a Source Control item using existing panel-toggle commands. Keep every main-header panel toggle and the one-panel/right-column layout. Add optional public setting category/section metadata for Appearance > Window & Sidebar.
- **Why:** SidebarScopeReview and SidebarUiSurvey independently found the additive design preserves D10; the roadmap expressly authorizes API growth. A header badge alone misses parity, while direct host DOM access violates D6.
- **Evidence:** docs/loop/decisions/m0-ui-api.md D6,D10; docs/roadmap.md:29-30,47-53; sidebar-extras.md:9-15,77-85
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** implementation would replace rather than supplement the existing controls
- **Source:** locked by docs/loop/decisions/m0-ui-api.md (invariants); assumed — autonomous (additive extension)

## D14: Exclude only roadmap-owned navigation/platform flows, not the four additions
- **Question:** Open ledger, host labels, pairing/legacy transports, and unrelated stock workspace options
- **Options:** implement every dependency now; expose stubs; retain roadmap slice boundaries
- **Chose:** Open ledger navigation waits for M5 ledger; review filters for M4; SSH/WSL/host transport are not introduced. Keep per-client preference isolation and omission-safe membership now. Stock workspace grouping/sorting/card-layout controls and sleep/wake actions remain M7 parity-sweep, as m1-worktrees D3 assigned; the current Project grouping permits membership drag and any non-Project mode must gate it.
- **Why:** SidebarScopeReview confirmed ledger navigation may follow its roadmap owner; no fake buttons or transports. This does not shrink dirty marker, separators, activity window or cross-repo groups.
- **Evidence:** docs/roadmap.md:162-163,193,207-208; docs/loop/decisions/m1-worktrees.md D3; BRIEF.md:67-75; sidebar-extras.md:41,106,144
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a dependency lands during catch-up and materially changes the flow
- **Source:** locked by docs/roadmap.md; deferred: platform

## D15: Use runtime liveness, not timestamps or saved layout, for Live only
- **Question:** exact upstream sleeping predicate and folder behavior
- **Options:** status=working only; any retained session; live runtime facts with documented exemptions
- **Chose:** live terminal PTY, fresh live-agent evidence, live structured session, or live browser-tab fact (when that feature exists) retains a Git workspace. Completed records and dormant saved layouts alone do not. Folder rows bypass the sleeping sweep, but obey time windows. Keep selected and main-worktree exemptions from the feature wrapper/control. Worktree birthtime, not createdAt, guards path-reuse identity.
- **Why:** direct upstream source survey resolved feature-doc open questions. Do not invent a recency-based sleep threshold or mistake idle for dead.
- **Evidence:** Orca src/renderer/src/lib/worktree-activity-state.ts:14-106; src/shared/workspace-view/workspace-row-filters.ts:82-114; src/renderer/src/components/sidebar/fork-workspace-activity-window/workspace-activity-filter.ts:26-90; Quirky plugins/quirky.worktree/src/daemon/list.ts:22-27,56-68; LiveRuleSurvey
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** new browser/structured runtime facts need a public liveness contribution
- **Source:** locked by research/orca-features/sidebar-extras.md (shared sleeping rule), assumed — autonomous (resolved source reading)

## D16: Author both specifications and use Codex for their one adversarial pass
- **Question:** essential coverage, tech-spec gate and review approval
- **Options:** stop after logic; write both and perform required review
- **Chose:** purpose/consumers/success/constraints/scope/primary flows are established by D1-D15 and the source. Take remaining recommended defaults, present the design and accept it autonomously under LOOP.md. Write both Markdown specs; one Codex promote/refute adversarial pass over both satisfies LOOP.md and the tech-spec reviewer requirement.
- **Why:** work crosses canonical metadata, plugin projection, shell public UI and renderer; the tech-spec complexity gate and LOOP.md mandate both.
- **Evidence:** docs/loop/LOOP.md:89-105,175-200; skill://writing-specs/tech-spec.md; logic.md Behavior & scenarios
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** spec review finds an uncovered flow
- **Source:** locked by docs/loop/LOOP.md

## D17: Use omp OpenAI implementers with Gemini review after Opus preflight fails
- **Question:** execution backend pairing
- **Options:** omp task + opus; next cross-family omp task + gemini; same-family Codex reviewer
- **Chose:** omp OpenAI task implementers and Gemini reviewer via pi-watch. Scratch preflight `pi-watch --check` returned exit 5: codex/terra/gemini/flash ready; opus/sonnet unavailable. No implementation has been dispatched. Specs use Codex as explicitly required; its same-family independence is recorded honestly.
- **Why:** LOOP.md specifies omp task implementers and Opus, then the next reachable cross-family pair. Gemini resolved google/gemini-3.1-pro-preview:high.
- **Evidence:** actual preflight output, iteration 3; docs/loop/LOOP.md:99-105
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real reviewer dispatch fails; use the skill's fallback ladder and record it
- **Source:** locked by docs/loop/LOOP.md

## D18: Accept confirmed spec defects and reject planned-artifact reference false positives
- **Question:** adjudication of mandatory Codex spec review
- **Options:** accept mechanical counts wholesale; adjudicate against source and current artifacts
- **Chose:** accept F1 (SC-03 fixture sequence), F4 (zero-birthtime replacement guard), F6 (unknown liveness), F7 (Purpose heading). Also accept source-required restoration of remembered pre-Live window and Git-card Move project to group despite refuter F2/F3 suppression: their criteria explicitly require both. Keep F5 refuted: activity counting belongs to the existing pipeline. Amend logic first, then tech. Reject F8-F33 as stale-reference defects: they are planned APIs/tests/plugin paths, resolvable shorthand/range tokens, or executable names not on PATH, not absent existing implementation prerequisites. Expand ambiguous shorthand paths where useful.
- **Why:** criteria-free refutation cannot negate a source requirement. Prepass “unresolved today” is not proof a planned file should already exist. Zero-birthtime async identity now holds a directory descriptor across the delay and compares filesystem identity; unknown Live-only providers preserve rows while reporting unavailability.
- **Evidence:** /tmp/m2-sidebar-extras-review.4jLvDM/final/{gate.json,manifest.json,prepass-adjudication.md,criteria.md}; actual promote/refute exit 0; final gate NEEDS_FIXES (1 HIGH,29 MEDIUM,3 suppressed), reviewer Codex independence reduced; amended specs
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** implementation or review finds these amendments still ambiguous
- **Source:** assumed — autonomous

## D19: Execute two waves with isolated component trees and tests-first checkpoints
- **Question:** decomposition, dirty-state preservation and verification ownership
- **Options:** one broad worker; parallel shared-tree edits; two disjoint waves with orchestrator checks
- **Chose:** W1 canonical repo/worktree metadata/lifecycle plus public UI slots/settings in parallel; W2 new extras plugin plus existing-sidebar integration in parallel using the committed public contract. Width cap 4, not binding. Workers own isolated /tmp worktrees and never commit. Tests-first preparation returns before implementation so the orchestrator can observe expected red results without workers running checks mid-flight; orchestrator checks after each barrier. Main inherited .serena/ stays untouched and outside item commits. Full commands are bun run test (remote), bun test scripts, bun run typecheck, bun run build.
- **Why:** canonical and UI API files are independent in W1; W2 has a fixed method contract and disjoint write scopes. Avoids private cross-plugin imports and concurrent hub-file edits. Scope and HEAD audits are meaningful only before orchestrator commits.
- **Evidence:** /tmp/quirky-sidebar-extras-lane5-plan.md; ProtocolFactoryInventory source/reference inventory; bun 1.4.0 probe; likeuser doctor web ready (playwright-cli 0.1.22)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a real semantic dependency or unowned caller requires an explicit re-plan
- **Source:** assumed — autonomous

## D20: Preserve accepted W1 components and repair only observed integration defects
- **Question:** which implementation and fixture changes can be accepted after tests-first preparation
- **Options:** accept worker reports; audit HEAD/scope and exercise real acceptance
- **Chose:** audited both isolated component trees and the integration tree before any component commit. Canonical component c849e21 and public UI component 18b5103 merged at 4d87155. Canonical tests went from 13 expected missing-feature failures to 15 passing assertions-driven tests. Public UI tests went from 5 expected missing-feature failures to 5 passing real-daemon/mounted-window tests. Parent restored a missing store import, repaired the test-only groupCreate return barrier and its missing path import, migrated the orphan WorktreeRow factory, and fixed TypeScript-only test typing/SQLite binding issues. Deleted obsolete exact warning wording and exact command-list assertions instead of repinning them.
- **Why:** the original race fixture observed a group-created event without holding the async assignment boundary; production CAS correctly rejected its later stale write. The repaired fixture pauses the real repo handler after creation, changes state, then releases it. Worker reports alone did not establish correctness.
- **Evidence:** /tmp/quirky-sidebar-lane5-journal.json and *-audit.json; artifact://68 (UI red), artifact://73 (canonical red), artifact://83 and artifact://85 (diagnosis), artifact://91 (15 pass/97 assertions); public UI targeted run 5 pass/43 assertions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** W1 checkpoint review finds another defect; no checkpoint review has run yet
- **Source:** assumed — autonomous

## D21: Preserve notification unread semantics when catching up
- **Question:** integration catch-up conflicts and newly binding decisions
- **Options:** take either side of SetEnv; combine membership services with the notifications unread event contract
- **Chose:** merge build/roadmap at 7ce182f. Read imported m1-notifications and fix-sc31-first-shell-race decision logs. Combine SetEnv resolveRepo/groups/call/identitySource with changed(data) carrying optional unread. Preserve the automatically merged unread emission and notification/UI presence changes. Install caught-up package links with bun install --frozen-lockfile --ignore-scripts.
- **Why:** notifications D46 requires explicit unread:false even when the prior marker was already clear; dropping that field would break Mark Read. No imported decision changes the four-addition sidebar scope.
- **Evidence:** docs/loop/decisions/m1-notifications.md D35,D45,D46; fix-sc31-first-shell-race D6 and line 69 diagnosis; plugins/quirky.worktree/src/daemon/set.ts changed emission; merge 7ce182f
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** resumed catch-up brings another conflicting contract
- **Source:** locked by docs/loop/decisions/m1-notifications.md

## D22: Do not advance past the red required W1 suite gate
- **Question:** whether to start W2 or review despite independent required-suite failures
- **Options:** bypass or weaken failures; repair unrelated features inside this item; queue the independent repair and formally block at the gate
- **Chose:** formal block at LOOP.md step 5 / W1 gate, before checkpoint review and W2. First required full remote run failed on PTY child-output capture, cold-restore query output, ask regex timing, a stale worktree report, and two incidental assertions this item had invalidated. Fixed the two owned assertions and own type migrations. An isolated remote run of ask/spec, worktree/window-projects and PTY/manager passed the latter two but reproducibly failed ask's accepted unanchored a*a*a*b pattern at 116-118 ms against its 100 ms budget. Queue repair item fix-ask-regex-budget-20261027 was added through queue.ts; lane 7 owns fix-test-process-leaks and received the PTY evidence via one accepted terminal message, not a human ask. No private branch cherry-pick, suite exclusion, timeout relaxation or regex semantics change.
- **Why:** the SDD gate forbids reviewers over a red suite or advancing a successor wave. A repeated isolated regex failure is not a load flake. Unrelated regex redesign and a concurrent owner's PTY work are not silently absorbed into the sidebar scope. The required full suite has not passed, so this item cannot land.
- **Evidence:** artifact://94 (full suite exit 1, 436.53 seconds); isolated remote command bun scripts/suite.ts plugins/quirky.ask/test/core/spec.test.ts plugins/quirky.worktree/test/window-projects.test.ts packages/pty-host/test/manager.test.ts exited 1 with suite-result ok:false/flaky:[]; docs/loop/decisions/fix-sc31-first-shell-race.md D6 and diagnosis; queue.ts add /tmp/quirky-lane5-ask-regex-fix.json exited 0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the independent repairs land and the required gate passes
- **Source:** locked by docs/loop/LOOP.md (verification); assumed — autonomous (repair routing)

## D23: Keep measured passing checks separate from the failing full suite
- **Question:** what verification can honestly be claimed on the preserved implementation
- **Options:** call the branch green from targeted tests; record each exercised check and remaining gate
- **Chose:** after repairs, four targeted files passed 50 tests/273 assertions; bun run typecheck exited 0 and bun run build exited 0 (packaged macOS app). The scripts suite passed 41 tests/187 assertions before typecheck exposed missing caught-up links and owned typing issues. No full-suite pass, checkpoint review, W2, final review or complete sidebar acceptance is claimed. Build warnings are the missing optional icon source and unset release base URL. The full-suite run exceeded 300 seconds; record the slow-suite advisory without mutating test-runner configuration (Bun runner, not pytest).
- **Why:** separate checks do not substitute for the mandatory full-suite gate.
- **Evidence:** artifact://107 (50 pass, clean typecheck/build); artifact://102 (scripts pass, prior diagnostic output); artifact://94 (failed full suite)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** any resumed source change invalidates this evidence
- **Source:** locked by docs/loop/LOOP.md

## D24: Smoke the completed W1 paths without calling them full sidebar-extras parity
- **Question:** runtime/visual proof before preserving a blocked item
- **Options:** rely on tests; exercise real CLI plus the built web UI in an isolated home
- **Chose:** real daemon/CLI smoke created a Git worktree, guarded-created a group, made a child group, moved membership, and deleted the parent subtree; repo/path/instance and filesystem survived, membership became null. A disposable installed plugin exercised the new public activity-item and categorized-setting surfaces. Guarded web run 20261027T143936-c1dd: activity-slot pass (closed-panel item opens right Source Control panel while retaining header toggle); categorized-setting tool-limited partial (Appearance > Window & Sidebar and checkbox toggle visible; Save below viewport, Control+End/Meta+End NO_EFFECT). One visibility finding, no gates, no test overrides, nothing left open. Headless tests separately prove saved-value persistence. Managed browser also opened/visually inspected/closed. Daemon stopped; owned PTY PID no longer existed; temporary HOME/QUIRKY_HOME and fixture plugin were deleted.
- **Why:** real runtime output proves the changed W1 paths, while the partial and missing W2 prevent any full-feature completion claim.
- **Evidence:** /tmp/quirky-sidebar-lane5-w1-smoke.json; .quirk/using-apps-like-a-user/runs/20261027T143936-c1dd/report.md and obs-1..7; smoke service exit; cleanup verification
- **Reversibility:** easy
- **Confidence:** high for exercised behavior; no claim on unexercised Save/reopen
- **Revisit if:** the guarded driver gains ref-aware scrolling or W2 changes these surfaces
- **Source:** assumed — autonomous

## D25: Resume the preserved item after its independent repairs landed
- **Question:** whether the returned existing branch should restart design or continue at the preserved gate
- **Options:** discard accepted W1 work; resume the exact recorded checkpoint
- **Chose:** resume W1 on lane 7; merge current integration, install frozen links, rerun required checks, then run the required three-lens Gemini checkpoint before W2. Preserve D17's OpenAI/Gemini binding; the resumed Gemini reachability probe passed. Incorporate the preserved exact W2 JSON seam into tech.md before dispatch.
- **Why:** queue.ts returned the existing item and its branch; D22's regex/process prerequisites are landed. New notes/AI decisions preserve public ownership and add no sidebar scope conflict. The blocked browser item supplies no runtime browser liveness provider. ProcessScope remains the required owner for new process-starting verification.
- **Evidence:** integration merge 0a186b8; docs/loop/decisions/fix-ask-regex-budget-20261027.md; fix-test-process-leaks.md; fix-sc31-first-shell-race.md; m2-source-control-notes-ai.md; sa-browser-agent.md; /tmp/quirky-sidebar-lane5-w2-api-contract.md; pi-watch --check gemini exit 0
- **Reversibility:** easy (resume procedure and precise JSON contract)
- **Confidence:** high
- **Revisit if:** fresh gate or checkpoint reveals an integration defect
- **Source:** locked by docs/loop/LOOP.md

## Progress
Blocked at LOOP.md step 5, W1 mandatory suite gate; do not land. Both reviewed specs and W1 canonical/public-UI implementation are preserved. W2 presentation plugin and worktree-renderer integration were not started, so the four-feature item is not complete. All agents and finite/background commands have returned; smoke processes and browsers were stopped and temporary homes removed. Required prerequisite: repair fix-ask-regex-budget-20261027 and lane-7 PTY gate, restore this preserved branch to build/m2-sidebar-extras, merge current integration/read new decisions, install links, run the required gate; only then run the W1 three-lens Gemini checkpoint and proceed with W2. The resumable journal/plan/audits are in /tmp/quirky-sidebar-lane5-*; an exact W2 JSON seam draft is /tmp/quirky-sidebar-lane5-w2-api-contract.md and must be incorporated into tech.md before worker dispatch. Inherited .serena/ remains untouched/uncommitted.

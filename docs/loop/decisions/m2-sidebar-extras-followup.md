# m2-sidebar-extras-followup decisions

## D1: Complete the original seventeen-scenario continuation without redesigning the sidebar
- **Question:** what does the follow-up own (brainstorming scope)?
- **Options:** documentation-only audit; rewrite sidebar; repair parity gaps and verify original scenarios.
- **Chose:** repair and verify all SC-01–SC-17 from the original logic spec, including deferred quiet aging, fresh runtime, corrupt preferences and guarded web flows.
- **Why:** predecessor D30 explicitly assigned this continuation; source verification gaps do not remove requirements.
- **Evidence:** docs/loop/decisions/m2-sidebar-extras.md D30; docs/quirk/specs/2026-10-27-m2-sidebar-extras/logic.md:49-129.
- **Reversibility:** medium (acceptance scope).
- **Confidence:** high.
- **Revisit if:** binding source changes acceptance.
- **Source:** locked by docs/loop/decisions/m2-sidebar-extras.md

## D2: Resolve standard gray areas autonomously and reuse the existing architecture
- **Question:** design answers for Visual, Organization, Data, API and Integration (brainstorming).
- **Options:** new state/renderer; extend canonical owners and existing presentation plugin.
- **Chose:** compact existing UI; menu+drag equivalent; strict eligibility; current empty/error recovery; rolling labels; existing client-local state, CAS and canonical projections. Every material standard area is considered: layout/density/loading/errors/interactions; grouping/naming/exceptions; mutation/validation/idempotence; API errors and scripting; runtime availability and freshness. No new transport, pagination or synchronization contract.
- **Why:** original D1–D18 and feature docs settle outcomes; duplicating owners introduces unnecessary state. No human offers/questions. Original research supplies Git ownership, derived visibility and hit-testing evidence.
- **Evidence:** research/orca-features/sidebar-extras.md sections What the user can do, Edge cases; original logic Decisions Locked.
- **Reversibility:** medium.
- **Confidence:** high.
- **Revisit if:** a demonstrated flow requires a new public contract.
- **Source:** locked by docs/loop/LOOP.md

## D3: Audit hypotheses do not override precise existing runtime contracts
- **Question:** should absent optional methods or unknown main liveness change behavior?
- **Options:** mark every missing optional method unavailable and retain all mains; preserve original optional-source/default-main semantics.
- **Chose:** preserve MethodNotFound as absent optional fact and unknown non-main retention; main retention follows its explicit exception. Add evidence at provider-failure/freshness boundaries instead of changing semantics from a scout hypothesis. Persisted legacy renderer booleans are not a new extras-store migration input; existing legacy API patches remain supported.
- **Why:** original tech explicitly distinguishes optional absence and failed providers, and scopes unknown retention to non-main. The audit proposed otherwise but did not establish a contract defect. Browser public pane/page records are persisted metadata, not an authoritative runtime-live predicate; do not count saved tabs as live or introduce private browser imports.
- **Evidence:** docs/quirk/specs/2026-10-27-m2-sidebar-extras/tech.md:69-71,83,97; plugins/quirky.browser/src/pane-contract.ts:8-15; SidebarAudit and follow-up source map.
- **Reversibility:** medium.
- **Confidence:** high for existing contract; no claim of browser runtime presence coverage.
- **Revisit if:** canonical browser provider supplies explicit live runtime facts or a new binding decision changes main behavior.
- **Source:** locked by docs/quirk/specs/2026-10-27-m2-sidebar-extras/tech.md

## D4: Preserve public contribution behavior while the newer shell owns placement
- **Question:** old SC-17 header placement versus the approved UI redesign?
- **Options:** duplicate old header controls; preserve contribution/API behavior under canonical host placement.
- **Chose:** the newer approved UI spec governs host placement. Do not edit packages/ui or public shell schemas while ui-shell-slots is concurrent. Tests prove activity contribution/report/disable and core operation, not obsolete top-row geometry.
- **Why:** redesign explicitly removes the old top plugin tab row and button piles; duplicating them would violate the newer contract.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,166-180.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** incoming shell changes the public contribution contract.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Restore normal end-phase verification now that triage is claimed
- **Question:** whether build-first skips apply to this early continuation?
- **Options:** typecheck only; normal tests/review/guarded web.
- **Chose:** normal verification; m7-test-triage was already claimed lane8. Its branch exists and merge reported already up to date. Dependency must be ready before land. Fresh homes, automatic hooks disabled before activation, all processes owned and cleaned.
- **Why:** LOOP.md ends build-first overrides once triage is claimed.
- **Evidence:** canonical queue status; docs/loop/LOOP.md:58-59,97-110; actual early dependency merge output.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** explicit operator instructions supersede this phase.
- **Source:** locked by docs/loop/LOOP.md

## D6: Use omp OpenAI implementers and verified Gemini cross-family review
- **Question:** execution model pairing and inherited state?
- **Options:** required preferred Opus; next reachable Gemini; same-family reviewer.
- **Chose:** omp task implementers (OpenAI), Gemini3.1Pro high reviewer. Actual Opus probe exit5 unavailable; all-alias probe Gemini ready, Anthropic aliases unavailable. Specs receive the required Codex pass with reduced independence. No language server configured. Inherited untracked .serena/ remains untouched and outside source commits.
- **Why:** obey omp pairing fallback without pretending unavailable reviewer access. Preserve unrelated user state.
- **Evidence:** actual pi-watch probes; xd://lsp status; scratch /tmp/quirky-sidebar-followup.e9Wt3N/journal.json.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** dispatch fails; follow bounded retry/fallback ladder.
- **Source:** locked by docs/loop/LOOP.md

## D7: Adjudicate mechanical spec references separately from model findings
- **Question:** whether the mandatory Codex specification pass found a real design blocker?
- **Options:** blindly accept prepass shorthand failures; inspect each reported reference against its full contextual path.
- **Chose:** standard Codex promote and fresh refute both emitted empty arrays; no model findings, advisories, limitations or questions. Mechanical gate reported NEEDS_FIXES with nineteen LOW-confidence MEDIUM reference candidates. F1–F4/F7–F11 are contextual short filenames with full paths in Code references; F5–F6 are valid comma-separated line selectors unsupported by the checker; F12–F13 are runnable command text misclassified as paths; F14–F19 are valid sibling/relative links whose context was lost when staging both docs in a scratch artifact. Reject these candidates as false positives after resolving their full repository/spec context. No claim that the unmodified mechanical gate returned PASS.
- **Why:** the gate cannot resolve markdown sibling links after concatenation into /tmp or recognize shell commands as commands. Rewriting execution contracts to satisfy that heuristic would not improve implementation fidelity.
- **Evidence:** /tmp/quirky-sidebar-followup.e9Wt3N/spec-review/{resolve,prepass,findings,refute,gate,manifest}.json; actual model dispatches returned; named sources read in this run.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a worker cannot resolve the contextual full pointer.
- **Source:** assumed — autonomous

## D8: Replace the incorrect activity expectation with consumer-visible fallback precedence coverage
- **Question:** why did the baseline activity scenario fail, and should production projection change?
- **Options:** take the maximum of every timestamp; preserve observed-activity precedence and use creation/repository values only as fallbacks.
- **Chose:** remove the old incorrect unconditional-maximum scenario, not repin it. Add real-daemon cutoff/visibility regressions proving departure recency takes precedence over later fallback timestamps, then creation-only/repository-only fallback and all rolling-window boundaries. Preserve fresh/stale canonical agent evidence; add failed-provider versus absent-optional-source and positive-evidence precedence cases. Corrupt preferences now exercise restart and valid recovery. Actual extras contribution override/disable keeps worktrees usable. Disable automatic hooks before enabling agent-status in test homes.
- **Why:** projection.ts returns positive observed activity before fallback fields, exactly as the locked contract requires. The failed test expected a later fallback timestamp even though positive observations existed. No production runtime defect was established.
- **Evidence:** actual baseline suite failure at activity.test.ts157, normal and automatic isolated retry; corrected runtime suite six files passed without retries in26.95s; component source/tests under plugins/quirky.sidebar-extras.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a canonical runtime source demonstrates incorrect activity precedence.
- **Source:** locked by docs/quirk/specs/2026-10-27-m2-sidebar-extras/tech.md

## D9: Prove guard failures before changing renderer behavior
- **Question:** which guard defects and preparation-fixture repairs were actually observed?
- **Options:** accept worker claims; run parent-owned tests after the component barrier.
- **Chose:** parent observed folder-owned/ownerless drag changing Team→Release and Status/mid-mode drag changing null→Team; ownerless menus exposed membership. Existing Project drag and manual reorder passed. Repair Menu/Tree eligibility and mode gates, retain independent reorder, use rolling labels. Preparation initially activated stock filtering against incomplete WorktreeControl fixtures, hiding rows because archivedAt was undefined; fill required canonical fixture fields, not weaken production. Select the activity filter control instead of the stock-options control. Remove obsolete copied label inventories and exact unrelated separator-position pins while preserving first/nested/sticky/geometry assertions.
- **Why:** these are presentation-only membership safety boundaries; neither folder writes nor grouping changes may silently alter membership. Tests must exercise actual semantic controls.
- **Evidence:** parent red run15pass/13fail with five concrete mutation/menu failures; updated two-file renderer/e2e run passed without retry21.70s. Additional immediate-preview cleanup seam is still being completed; no final source acceptance claim yet.
- **Reversibility:** easy.
- **Confidence:** high for exercised cases.
- **Revisit if:** final source or caught-up shell invalidates a tested interaction.
- **Source:** assumed — autonomous

## D10: Compose incoming owner authority without changing sidebar presentation ownership
- **Question:** whether the required catch-up changes the parity contract or needs a conflicting cutover?
- **Options:** keep the old integration snapshot; merge and preserve authenticated identity and canonical selector ownership.
- **Chose:** one catch-up at9624e2a, no conflicts. Read every decision and Progress in four incoming logs (40 decisions: PTY4, terminal-pane4, owner-provisioning17, screenshot-review15). Preserve exact owner-qualified navigation/create, positive-evidence-only other-client filtering, unknown-origin retention and hooks authority. Do not restore caller-invented ownership, use layout as liveness, or duplicate the screenshot-review/shell owners.
- **Why:** incoming decisions are compatible and strengthen canonical identity boundaries.
- **Evidence:** SidebarIncomingDecisions handoff; docs/loop/decisions/{fix-flaky-pty-host-manager,fix-flaky-terminal-features-pane,m7-terminal-owner-provisioning-and-selector-flows,ui-screenshot-review}.md; actual caught-up root/mobile/desktop typecheck, UI lint and build exited0 in47.94s.
- **Reversibility:** medium.
- **Confidence:** high.
- **Revisit if:** later integration changes the public contribution or owner contract.
- **Source:** locked by docs/loop/LOOP.md

## D11: Treat the red affected gate as a stop, not review evidence
- **Question:** how to proceed when the post-catch-up affected gate fails?
- **Options:** review anyway; suppress failures; repair demonstrated causes and capture full remaining evidence.
- **Chose:** no final reviewers were dispatched. The shared prepass failed60files with18pass/42fail, and its bounded output retained only the tail. Known failures: window-navigation fixture explicitly links real session and also requests a fake session symlink (EEXIST before all10 assertions); ui-report pins the entire pending-row copy and rejects new additive fields. A scoped fixer owns only these two files: use a genuine session+agents closure and preserve consumer navigation/session-survival assertions; delete the incidental whole-row pin and retain pending/removing outcomes. Full remaining failures are not yet attributed; preserve complete output on the next gate instead of inferring causes.
- **Why:** neither fixture collision nor copied implementation shape is a reason to change production behavior, weaken safety assertions or call the gate green.
- **Evidence:** /tmp/quirky-sidebar-followup.e9Wt3N/final-review/prepass.json; window-navigation.test.ts23-28; ui-report.test.ts197-224; actual prepass115.40s exit1. Lane8 notification accepted input only, not proven delivered.
- **Reversibility:** easy.
- **Confidence:** high for known causes; remaining failures unclassified.
- **Revisit if:** the focused corrected files expose a real owner-contract defect.
- **Source:** assumed — autonomous

## D12: Complete project-scoped folder row actions rather than substitute the project header
- **Question:** is hiding invalid worktree membership enough for SC-06?
- **Options:** use project-header navigation as a substitute; implement the required project actions on the folder row itself.
- **Chose:** folder/worktree-owned-by-folder rows get New Group from Project, Move project to group, and Remove project from group when grouped, reusing the existing project group dialog and canonical repo mutation. Unknown owners fail closed. Preserve workspace membership/metadata and Git execution ownership.
- **Why:** source feature row48 explicitly names project-scoped row actions. The real guarded notes-row menu has only Move project to group; the separate project-header action does not satisfy that path.
- **Evidence:** research/orca-features/sidebar-extras.md48; Menu.tsx199-236,247-258; guarded run20261028T212309-540d obs-5 screenshot/tree.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** a binding source changes folder-row interaction scope.
- **Source:** locked by research/orca-features/sidebar-extras.md

## D13: Keep production API boundaries distinct from isolated fixture seeding
- **Question:** should the plugin validator's private-SQL test finding change production or replace real API evidence with fixture responses?
- **Options:** add privileged test APIs; replace canonical producers with mocked responses; retain isolated test setup and public subject dispatch.
- **Chose:** reject the validator's Major public-API-only violation label. It cites only run-owned test database seeding/corruption injection, not shipped plugin imports/calls. Production sidebar consumes public APIs only. Timestamp fixtures and deliberately failed providers are followed by real daemon public projection calls; no privileged runtime test endpoint ships. Retain the test coupling as a maintenance risk, not a claim of plugin sandboxing or private production access.
- **Why:** deterministic corruption/expiry setup cannot be expressed by a legitimate production mutation; adding one would expand privileges merely for tests. Replacing canonical producers with response echoes would weaken the actual boundary proof.
- **Evidence:** SidebarPluginValidation handoff; plugins/quirky.sidebar-extras/test/activity.test.ts isolated harness homes; unchanged src/daemon/projection.ts public context.call and pty API.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** fixture paths stop being run-owned, or shipped source imports a private plugin store.
- **Source:** assumed — autonomous

## D14: Attribute and adopt only the two misplaced fixture edits
- **Question:** why did the first corrected gate-file run still execute old source?
- **Options:** blindly restore parent files; assume worker claims; trace checkout identity and exact content.
- **Chose:** stop and re-plan the gate correction after the worker confirmed its initial relative edits landed in the parent checkout rather than its assigned tree. Preserve the two attributed parent test edits; do not restore user state. The worker reapplied identical fixes to its assigned tree, then stopped. SHA256 pairs for both files match exactly. Parent owns their integration commit; discard only the duplicate run-owned tree after that commit. No production source or unrelated user files changed.
- **Why:** directory intent is not a write boundary. Actual parent source and the worker's explicit attribution identify the safe correction; a passing report or scope declaration alone does not.
- **Evidence:** history://SidebarGateFixtures initial relative edit and later absolute reads; actual parent status; matching SHA2562080b1e7… for window-navigation and72c329e8… for ui-report; parent two-file corrected suite passed without retry27.71s. The earlier old-source run is not represented as testing the fix.
- **Reversibility:** easy.
- **Confidence:** high.
- **Revisit if:** future worker changes appear outside their assigned absolute paths.
- **Source:** assumed — autonomous

## Progress
Components eb4b4657/23453d9d accepted, merged and original trees removed; final immediate-preview red27/1 then two-file green. Caught up9624e2a; types/UIlint/build pass. Live real web service and SidebarWebUser guarded campaign; parent browser smoke settled all fixtures with zero errors then closed. Broad gate red18/42, no reviewers dispatched. Additional folder-action test-prep and two-file incoming-fixture repair returned; parent targeted checks running. Finish red/green folder correction, audit/merge correction trees, capture full remaining gate failures, then final review only after green. Dependency triage still pending; no final UI/suite/item completion claim.

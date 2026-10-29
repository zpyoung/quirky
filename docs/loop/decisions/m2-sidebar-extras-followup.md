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

## D15: Migrate isolated fixtures to the canonical CLI dependency
- **Question:** why did the complete caught-up affected gate fail across forty files?
- **Options:** weaken the production dependency; invent an automatic dependency resolver; update explicit test plugin sets.
- **Chose:** preserve `quirky.worktree`'s required repo+CLI dependencies and update the existing isolated fixture lists and default harness set. Keep tests that intentionally omit optional providers explicit. Use real agents/session/terminal owners for terminal-layout integration instead of conflicting real+fake session links.
- **Why:** the missing `quirky.cli` prevented worktree activation, so its settings/methods were absent. A successful fixture must exercise the shipped dependency contract.
- **Evidence:** acceptance-full.log's forty-file failure set; quirky.worktree/quirky-plugin.json12-15; accepted fixture components f676dd4e and3e453bfb. Corrected API gate reached32/36 passing files, then the final four passed without retry18.99s.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the canonical plugin dependency changes.
- **Source:** locked by docs/loop/decisions/m7-terminal-owner-provisioning-and-selector-flows.md

## D16: Restore the declared ownedIds producer rather than weaken repo-removal callers
- **Question:** why did real repo removal remain blocked after fixture dependency repair?
- **Options:** ignore the owner query failure; change callers; register the existing canonical producer.
- **Chose:** restore `ownedIds` in the worktree handler map. Its implementation and public declaration already existed; the map omitted it. Preserve its recorded+listed+primary ownership union and every repo/session/filesystem removal assertion.
- **Why:** consumers correctly refused deletion when the declared producer was missing.
- **Evidence:** main.ts306-310 and431-433; actual failed RPCs saying `did not provide method:quirky.worktree/ownedIds`; root window-projects remote file passed69.11s after7d19f1d0. Fresh real daemon startup independently proved all five API workspaces and excluded a foreign folder owner (`OWNERSHIP_API_OK`).
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public ownership-query contract changes.
- **Source:** assumed — autonomous

## D17: Give tracker resolution a canonical worktree selector
- **Question:** why did valid tracker metadata still fail through the real provider path?
- **Options:** loosen the selector parser; skip provider validation; qualify the already canonical repo path.
- **Chose:** pass `path:${repo.path}` to `quirky.hosting/projectRef`. Keep credential-free HTTPS validation and provider approval. The test provider returns a fixed canonical project record; trailing-slash input must persist the provider's canonical URL and survive restart.
- **Why:** a bare absolute path is not the public worktree selector contract. It was being interpreted as an ID/name/branch and failed before provider resolution.
- **Evidence:** src/daemon/project.ts142; hosting/src/env.ts133-150; selector.ts41-65; f676dd4e; final four-file remote gate18.99s exit0. No real provider-account campaign is claimed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public selector contract changes.
- **Source:** locked by docs/loop/decisions/m7-terminal-owner-provisioning-and-selector-flows.md

## D18: Verify consumer outcomes instead of re-pinning fixture encodings
- **Question:** how should caught-up rendering, consent and persistence tests adapt?
- **Options:** repin every changed label/default/payload; remove meaningful safety checks; migrate faithful fixtures and retain behavior.
- **Chose:** provide canonical WorktreeControl facts and authenticated window/origin read models; select Name when a scenario intends a name rather than Smart input; emit real-shaped change events after fixture mutations. Remove incidental label/heading/default/command-inventory/old-envelope/warning-count pins. Keep creation, setup trust, model choice, pending-focus, filesystem, metadata and session-survival outcomes. Reorder is consumed through real public navigation after restart, not its numeric storage encoding. Forged desktop identity is rejected without creating a workspace. Nested Git fixture paths create/reuse their actual parents.
- **Why:** fixture copies are not a reason to weaken production owner checks or preserve an obsolete encoding.
- **Evidence:** f676dd4e and3e453bfb; corrected four-file API gate passed; seven renderer files passed under the configured retry policy. window-create SC-33 failed the broad run and passed its isolated retry, so this is not a zero-flake claim.
- **Reversibility:** easy
- **Confidence:** high for observed outcomes
- **Revisit if:** a replacement fixture stops exercising the real consumer contract.
- **Source:** assumed — autonomous

## D19: Activate the lazy feature before asserting prepared-pool restart cleanup
- **Question:** does the retained preparation after daemon restart require bypassing revoked plugin authority?
- **Options:** cache repo authority and mutate after revocation; weaken the foreign-lock assertion; drive the lazy feature through its public API.
- **Chose:** after restart call `quirky.worktree/list`, then keep the existing assertion that its exact owned preparation is gone and a foreign locked registration survives. No production lifecycle or cached-authority fallback was added.
- **Why:** absent activation metadata defaults to lazy; restart alone does not import/activate worktree. Its activation already performs fresh-owner cleanup. Calls after deactivation remain revoked.
- **Evidence:** packages/daemon/src/plugins/host.ts374,400-403; worktree/main.ts275-284; prepared-create.test.ts restart scenario; that file passed in the corrected API run. Deactivation still emits the observed revocation warning; that warning is not represented as successful cleanup.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the feature's activation contract changes.
- **Source:** locked by docs/loop/decisions/m0-core.md

## D20: Preserve guarded UI failures and verify their actual corrections
- **Question:** how to close the first campaign without falsely claiming every goal passed?
- **Options:** relabel partial/fail results; stop the item; complete the remaining reachable checks and retain original evidence.
- **Chose:** retain initial run20261028T212309-540d (one pass, two fails, six partials). The parent did not authorize a scope reduction. Fixed missing folder-row project actions and verified-empty ledger disclosure; fresh closure run20261028T221749-dbd2 passed both. Its screenshots show cancel/create/project removal, empty-ledger assurance only after verification, cancel preservation and deletion of only run-created state. Menu occlusion/hover visibility findings stay recorded rather than becoming zero-findings claims.
- **Why:** project-header navigation is not a substitute for a required row action, and an absent ledger message is not a successful empty preview.
- **Evidence:** guarded reports and obs-5/obs-66 in the initial run; closure obs-3,9,10,14,17,19,21,22,24,25; commits472c7889 andb9bdc8fe. Both closure goals passed with no windows kept open.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final UI checks reproduce either corrected behavior.
- **Source:** assumed — autonomous

## D21: Offload every file test and close completed UI fixtures
- **Question:** how does the operator's overloaded-Mac instruction change verification?
- **Options:** continue direct local test commands; route all files through the canonical remote suite.
- **Chose:** every test, including scripts and single files, uses `bun scripts/suite.ts`; only its macOS-only list and packaged native checks run here. Updated the active tech contract and acceptance runner. Run local guarded browser fixtures serially and close each after its checks.
- **Why:** the operator explicitly reported load260 and reserved local testing for the listed exceptions. No machine-load confirmation was run.
- **Evidence:** operator interjection; all exercised file-test commands in this run use suite.ts. Initial retained failed-run browser was explicitly closed without rewriting verdicts. Initial, closure and filter fixture services exited0 after `WEB_FIXTURE_CLEANED`; guarded closure/filter reports list no kept windows.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes routing.
- **Source:** locked by operator instruction in this conversation

## D22: Report the real-clock observation limit without changing the timer to force a pass
- **Question:** does the quiet-aging campaign prove the strict sixty-second UI bound?
- **Options:** call an after-deadline screenshot a pass; shorten the production timer just for the check; report the actual timing and retain deterministic schedule coverage.
- **Chose:** custom/hidden recovery passed in run20261028T224401-6209; the complete Live-only exception toggle passed in supplemental run20261028T230705-ed8a. Quiet aging remains a tool-observation partial: visible before cutoff and at+43.885s, absent with hidden count3→4 at+61.130s. The final observation landed1.130s after the required deadline; artifact timestamps cannot recover a within-deadline bound. Do not claim strict wall-clock success or a demonstrated app violation. Keep the real sixty-second scheduler and the deterministic no-store-event regression.
- **Why:** the row actually aged out without a user/store mutation, but a late sample cannot establish when it disappeared. LOOP.md permits a recorded tool-limited partial; it does not permit fabricated timing.
- **Evidence:** filter run obs-46/47/48, events.jsonl and exact cutoff receipt quiet-fixture.json; observation48 PNG/tree timestamps are after the deadline; remote `quiet activity aging refreshes at sixty seconds without store events` regression passed.
- **Reversibility:** easy
- **Confidence:** high about the observation limit
- **Revisit if:** precise timing evidence demonstrates a scheduler failure rather than sampling overhead.
- **Source:** assumed — autonomous

## D23: Keep missing-group membership recoverable with no rendered targets
- **Question:** can a Git worktree clear a missing/foreign group when the available group list is empty?
- **Options:** require creating another group first; hide removal with the Add submenu; keep removal conditional only on held membership and eligibility.
- **Chose:** move Remove worktree from group outside the non-empty target-list guard, retaining Git/worktree+Git/repo eligibility. Extend the existing canonical createGroup acceptance through a non-null-membership restart before clearing it. The UI fixture checks CAS guards but does not persist those request-only fields as domain metadata; no payload-forwarding assertion substitutes for state/placement outcomes.
- **Why:** missing/unrendered group membership must remain stored and fall back to its repo, but the user must still be able to remove it.
- **Evidence:** focused UI regression first failed with missing Remove at1189 while the non-null restart file passed; the source correction exposed a fixture-only guard-field leak, corrected without weakening metadata preservation. Final two-file remote verification passed without retry11.86s; component6298bf91 is merged and its tree removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** missing-group recovery changes execution ownership or any unrelated metadata.
- **Source:** locked by research/orca-features/sidebar-extras.md

## D24: Consume the landed shell, shared controls and script repairs without compatibility layers
- **Question:** how should the corrective roadmap merge affect this continuation?
- **Options:** retain legacy slot/DOM assumptions; consume the current public model and migrate fixtures.
- **Chose:** merge current roadmap as b2b82c58, resolve the four fixture conflicts without restoring old CSS or copy inventories, and read all thirty incoming decision logs through the incoming-decision audit. Preserve original contribution IDs, exact-window input ownership, canonical daemon UI state, shared ContextMenu/ListRow controls, and Ask confirmation authority. No binding conflict required an override.
- **Why:** the approved shell owns placement; a test expecting a legacy host or inline menu must not dictate a production compatibility path. The incoming script repair also supplies explicit process.env and isolated review captures rather than masking malformed reports.
- **Evidence:** b2b82c58; SidebarFinalIncoming audit of all D/Progress sections; source ownership/membership/path-selector guards retained. UI lint, root/mobile/desktop compilation and UI build passed45.15s after removing only stale ignored generated phone assets from the source tree.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a canonical public contribution or ownership invariant is lost.
- **Source:** locked by docs/loop/decisions/ui-shell-slots.md and incoming shared-control decisions

## D25: Refute the dirty-marker failure from its original visual evidence
- **Question:** did the appearance run show a stale Source Control activity marker after cleaning?
- **Options:** change production decoration; inspect the actual activity item rather than the separate header badge.
- **Chose:** retain the original report and adjudicate the apparent failure as a visual misread. Dirty obs-3 contains the red activity marker; clean obs-10 does not. The lingering generic badge belongs to the separate top-header button, not the right-side Source Control activity item. The actor confirmed the correction from the same evidence; no verdict rewrite or new mutation was used to conceal a failure.
- **Why:** changing the working activity decoration would solve the wrong element.
- **Evidence:** guarded run20261028T234022-66ea, obs-3/10 PNGs and trees; clean tree top-header e19/e339 versus activity e511; independently inspected dirty/clean crops; SidebarAppearanceUser adjudication.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the actual activity item retains decoration after a fresh clean response.
- **Source:** assumed — autonomous

## D26: Prove the empty owning-project placeholder on the current shell
- **Question:** does grouping every workspace make its owning project disappear?
- **Options:** infer from projection tests; exercise all five rows through visible menus.
- **Chose:** create a run-owned PlaceholderProof group, assign main/feature/docs/old/aging through actual controls, inspect the empty API project header, then delete only that created group and verify restoration. Preserve seed projects/groups.
- **Why:** this closes the actual-surface placeholder case without substituting API writes for menu interaction.
- **Evidence:** guarded run20261029T003357-6753 report pass; obs-17 shows all five rows with API identity and the empty API header; obs-20 restores rows and the feature child chip. End closed the browser, kept_open=[] and cleanup_errors=[].
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** empty project visibility or restored lineage regresses.
- **Source:** locked by research/orca-features/sidebar-extras.md

## D27: Repair current-contract fixture failures before dispatching final reviewers
- **Question:** can a failed prepass be presented as a completed final review?
- **Options:** dispatch against a red gate; preserve the failed receipt and migrate the failing fixtures first.
- **Chose:** the367.373s remote prepass stopped before model dispatch. Of61 affected files,46 passed and15 failed. Split current-shell window/report fixtures, shared-control DOM fixtures, and Ask/dependency/activity API fixtures into disjoint corrective slices, with parent integration and no mid-flight checks. Investigate the isolated list timeout from retained evidence rather than increasing timeouts by default.
- **Why:** visible UI was mounted during legacy readiness timeouts; menu and editable-element queries also targeted obsolete DOM. Consent failures must be repaired at the fixture authority, not by weakening production confirmation. Unmounted activity defaults are not proof of mounted behavior.
- **Evidence:** retained acceptance-full.log and final-review/prepass.json; no final-review model dispatch occurred. The suite remains remote per D21, including scripts and single-file checks.
- **Reversibility:** easy
- **Confidence:** high about failures; individual causes remain subject to corrective verification
- **Revisit if:** migrated meaningful scenarios expose a production defect.
- **Source:** assumed — autonomous

## D28: Keep user documentation about behavior, not the verification transcript
- **Question:** what does the README reader need after the continuation?
- **Options:** preserve stale header/deferred-parity prose; document current controls and link the acceptance contract.
- **Chose:** Reader: plugin/API users — Decision: organize and filter worktrees safely. Replace old-header placement text with current rolling-window controls, validation, selected-row recovery, divider behavior and closed-tool decoration. Name Git/Git eligibility and Project-only membership drag; link the continuation spec. Keep verification/adjudication history here rather than in the README.
- **Why:** the six-slot shell superseded header placement, while eligibility and non-destructive behavior remain user-facing contracts. No section removal or unrelated README rewrite is needed.
- **Evidence:** README Public plugin UI and grouping APIs; logic.md locked decisions and SC-01–17.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** public controls or eligibility change.
- **Source:** assumed — autonomous

## D29: Preserve the list timeout as an uncertainty, not a justification to widen timeouts
- **Question:** does the single five-second list failure establish a daemon deadlock?
- **Options:** raise the timeout or change list concurrency; inspect the retained failure and verify the integrated batch first.
- **Chose:** no source or timeout change. The failing test lists both projects, renames one checkout away, and requires only the remaining listable project. Its ordinary real-Git fixture has no special blocking wait or missing dependency. Git exit143 and ConnectionLost appear after timeout cleanup; they do not establish an earlier hang. Isolate this file after the integration barrier if needed.
- **Why:** concurrent load is plausible, but not proven. Retain the failure and the invariant instead of manufacturing a fix from the cleanup symptom.
- **Evidence:** acceptance-full.log667–702; list.test.ts123–132; real-project.ts14–28/42–43; src/daemon/list.ts173–190; shared harness cleanup136–154; SidebarListTimeout read-only audit.
- **Reversibility:** easy
- **Confidence:** high that no code change is justified by this receipt; low about the timeout's underlying cause
- **Revisit if:** isolated verification or a later full run demonstrates a repeatable failure.
- **Source:** assumed — autonomous

## D30: Verify separator persistence with a fresh page, not ineffective reload shortcuts
- **Question:** how can the browser prove persistence without a visible reload control?
- **Options:** claim modal reopen is reload; repeat unsupported keyboard shortcuts; end the browser and begin a fresh guarded run against the same daemon/home.
- **Chose:** phase1 run20261029T004449-46b1 saved separators off and ended its browser; phase2 run20261029T004725-d397 opened a new browser at the same URL, observed dividers absent and the setting unchecked before any mutation, then restored on through Settings and Save. Both reports pass with kept_open=[] and cleanup_errors=[].
- **Why:** a distinct page hydrates the persisted value instead of reusing the prior modal state. No JS/API setting write or reload substitute was used. Phase1's checkbox action returned NO_EFFECT for the requested value signal, but its screenshot/tree show checked→unchecked and Save was observed; checkbox checked state, not its unchanged value string, is the relevant evidence.
- **Evidence:** phase1 obs-1/2/3/5; phase2 obs-1/2/4; parent inspected phase2 unchecked Settings and restored divider screenshots. Rows retain their positions in both states. The sole owned service sidebar-current-web-8 then exited0 with WEB_FIXTURE_CLEANED; all owned UI browsers/daemons are closed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** fresh-page hydration loses the saved setting or toggling changes geometry.
- **Source:** assumed — autonomous

## D31: Repair the current shell's missing live activity mount, not replace it with panel counts
- **Question:** does the new shell preserve SC-14/15 when Changes is closed?
- **Options:** treat panel status counts as equivalent; restore a legacy rail; mount the effective public activity alias in the canonical stripe.
- **Chose:** the generic alias mount. If an available activity-item aliases a tool with a different body contribution, its public renderer owns the stripe control and live decoration, independently of panel visibility. Keep the existing substantive panel, placement and move authority; avoid nested buttons/double toggles and duplicate cached host badges. Reflect that stripe visibility in public slot state. Standalone activity-tool bodies keep their current semantics.
- **Why:** current source mounts only the Git panel body and uses a host icon/cached badge on the stripe. The real current-shell run confirms stale decoration: dirty main count1 survives closing Changes, remains after switching to clean feature, and clears only when Changes reopens. This is distinct from D25's old-host visual misread. A Changes section-count test alone would silently narrow the requested surface.
- **Evidence:** SidebarDirtyMountAudit source chain ToolShell372–457/660–663/734–739, tool-layout aliases48–50/115–132, public activity provider ui.tsx91–131/278–289. Guarded run20261029T005852-55f5 FAIL F1 obs-4, with dirty/closed obs-2/3 and clear only on reopen obs-5/6. Readonly actual CLI ui state shows Worktrees original ID shown/reported, but activity alias shown:false and no report while Changes is closed. Failed browser was explicitly closed; daemon exited0. Earlier full packaged build passed21.36s but predates this new host correction.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** alias rendering duplicates mounts, changes standalone contribution behavior, loses move/activation, or the corrected closed-panel scenario remains stale.
- **Source:** assumed — autonomous, preserving ui-shell-slots D3/D11 and original sidebar SC-14/15

## Progress
Current source is b2b82c58 plus committed documentation7d4e5de8. Core/source corrections and prior fixture components are integrated; all thirty incoming decision logs were audited. Current-shell empty-project and two-phase separator persistence UI passed; every owned browser/daemon is closed, with final service cleanup observed. The latest remote prepass is red as D27 records; three disjoint corrective workers are migrating current shell/DOM/Ask fixtures, with no checks mid-flight. A packaged build is running on unchanged production source. No final code-review model has run yet. Remaining: integrate and remotely verify corrections, finish build and three-lens review with one accepted fix batch, record complete criterion evidence, commit and canonical land. Dependency readiness is true; quiet aging retains the explicit D22 observation limit. No global completion claim.

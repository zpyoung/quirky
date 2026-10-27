# m5-ledger decisions

## D1: Implement the complete Project ledger feature
- **Question:** Which ledger flows are in scope (brainstorming, scope)?
- **Options:** all documented ledger flows; a CLI-only slice
- **Chose:** all documented CLI, UI, owner lifecycle, import, review and settings flows, including the clipped-footer regression
- **Why:** This queue item is not a slice; roadmap parity requires every feature-doc flow without its defects.
- **Evidence:** docs/roadmap.md:27-28,43-53; research/orca-features/ledger.md (external feature source), sections What the user can do and Open questions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue explicitly splits the feature
- **Source:** locked by docs/roadmap.md

## D2: Use the same authenticated scripting surface for every ledger action
- **Question:** Should Quirky preserve Orca's CLI bans on review approval, settings, attachment and deletion (brainstorming, permissions)?
- **Options:** reproduce Orca's UI-only channels; expose the actions through the same public API with revision guards and standard irreversible-action confirmation
- **Chose:** expose every action; derive actor provenance from authenticated call context, never a caller-asserted human identity
- **Why:** Quirky's locked same-token/everything-scriptable requirement explicitly supersedes Orca's transport privilege split. No separate IPC or remote-UI HMAC channel is needed on Quirky's unified authenticated API.
- **Evidence:** docs/architecture.md:61-81,316-324; docs/roadmap.md:31-41; external ledger.md:78-89
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** the locked authentication contract changes
- **Source:** locked by docs/architecture.md

## D3: Use omp implementers with the reachable Gemini reviewer fallback
- **Question:** Which cross-family implementation/reviewer pair is reachable (subagent-driven-development preflight)?
- **Options:** omp OpenAI task implementers plus opus; omp OpenAI task implementers plus Gemini
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; use codex for the separately mandated spec review
- **Why:** `pi-watch --check opus` exited 5 with 0/8 combinations; `pi-watch --check` resolved gemini to google/gemini-3.1-pro-preview:high and codex to openai-codex/gpt-6.1-sol:medium. Sonnet was also unreachable. Gemini is the next reachable cross-family pair.
- **Evidence:** iteration-2 preflight tool output; docs/loop/LOOP.md:99-105
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the resolved model fails a real dispatch
- **Source:** assumed — autonomous

## D4: Normalize ledger storage in the public plugin SQLite store
- **Question:** Which persistence design meets atomicity without unbounded rewrites (brainstorming options)?
- **Options:** normalized SQLite ledger/entry/history/anchor tables; one JSON document row per ledger; standalone JSON files
- **Chose:** normalized SQLite, JSON only for typed content/snapshots
- **Why:** avoids rewriting all accumulated history on each small edit, preserves public-store migrations and atomic bulk changes. Document storage is simpler but proportional-copy cost grows with history; standalone files conflict with binding D9.
- **Evidence:** packages/protocol/src/plugins.ts:211-227; m0-daemon-api D9-D10; https://www.sqlite.org/lang_transaction.html ; https://www.sqlite.org/foreignkeys.html ; https://www.sqlite.org/json1.html
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** real workload shows normalized query overhead dominates
- **Source:** locked by docs/loop/decisions/m0-daemon-api.md

## D5: Keep stable ledger codebase identity separate from generated repo IDs
- **Question:** How does re-add restore the same ledger when repo IDs are regenerated (brainstorming identity)?
- **Options:** change all repo IDs; bind forever to ephemeral repo ID; ledger-local canonical origin/root mapping
- **Chose:** ledger-local mapping from canonical origin remote, otherwise canonical root; unique live recovery only
- **Why:** preserves existing public repo identifiers while meeting retention/re-add parity across clones. Same-name groups are not identity.
- **Evidence:** plugins/quirky.repo/src/projects.ts:43-70,145-153; external ledger.md Owner lifecycle and remove/re-add verification
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** distinct live repositories share an ambiguous canonical identity
- **Source:** assumed — autonomous

## D6: Preserve target distinctions and reject ambiguous selector combinations
- **Question:** Which scope, aliases, read allocation and folder behavior should callers observe (brainstorming API/CLI)?
- **Options:** infer silently; explicit mutually exclusive scope plus documented current aliases
- **Chose:** default cwd project; current/active aliases; group membership; explicit live owner or direct ledger; no ledger creation on reads; folder only through group
- **Why:** follows feature requirements and avoids silently filing in a different owner. Existing groups are flat; their eligible chain contains their direct membership only.
- **Evidence:** external ledger.md CLI flow 8, Owner resolution, Store semantics; packages/protocol/src/model.ts ProjectGroup
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** group catalog gains a parent hierarchy
- **Source:** locked by external research/orca-features/ledger.md

## D7: Preserve validation, history and no-op semantics exactly
- **Question:** How should missing content, enums, stale revisions, no-ops and revert behave (brainstorming error/data handling)?
- **Options:** last-write-wins; immutable typed records with guarded editable fields
- **Chose:** required per-type fields, valid enums, immutable type/sequence/origin, optimistic revisions, effective changes only, full successful-change snapshots, currentRevision conflict data
- **Why:** concurrent agents must not overwrite newer observations; read-only review is not content mutation; approval must not replace latest content actor.
- **Evidence:** external ledger.md Required content, Store semantics, Concurrent writers; https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** authoritative feature requirements change
- **Source:** locked by external research/orca-features/ledger.md

## D8: Keep imports replay-safe and evidence advisory
- **Question:** How should import conflicts, malformed records, deleted records and unavailable evidence behave (brainstorming integration)?
- **Options:** overwrite/resurrect; anchor/baseline/tombstone with per-record partial success
- **Chose:** anchor by source scope/path/explicit legacy id, baseline comparison, tombstone suppression, duplicate-anchor copies all skipped, nonzero CLI exit for skips, no source writes or external dereference
- **Why:** preserves local ledger edits and intentional deletions while allowing source-only updates. Missing files/revisions cannot imply resolution.
- **Evidence:** external ledger.md Import and Review; https://www.sqlite.org/atomiccommit.html ; https://nodejs.org/api/fs.html#fspromisesrealpathpath-options
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** source identity format changes
- **Source:** locked by external research/orca-features/ledger.md

## D9: Reconcile owner recovery before reads, not only mutations
- **Question:** Preserve Orca's delayed recovery or eagerly reconcile (brainstorming lifecycle)?
- **Options:** next-mutation-only recovery; startup/catalog-event/request reconciliation
- **Chose:** startup/catalog events and requests, including read requests; catalog failures remain explicit, never detach all owners from a failed read
- **Why:** fixes the recorded delayed re-add behavior while preserving retained records and unique-identity checks.
- **Evidence:** external ledger.md:169-171,294-309
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** catalog events cannot provide a consistent snapshot
- **Source:** assumed — autonomous

## D10: Preserve documented UI surfaces with scriptable controls and pinned detail actions
- **Question:** Which layout, density, loading, empty/error and interaction choices apply (brainstorming Visual)?
- **Options:** CLI-only or generic JSON viewer; documented chooser/page/panel/forms and dialogs
- **Chose:** complete documented controls, typed forms, visible validation, per-owner settings, scoped filters, generation-fenced refresh, 200ms spinner delay, scrollable detail body and pinned footer; unbound Open Ledger command
- **Why:** the feature doc specifies these observable controls; clipped detail actions are the recorded UI defect. UI-only controls must be routed commands with reported state.
- **Evidence:** external ledger.md UI flows and clipped footer; packages/protocol/src/ui.ts UiPluginContext/MountFunction; docs/roadmap.md:31-38
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** browser smoke exposes unreachable controls
- **Source:** locked by external research/orca-features/ledger.md

## D11: Build and verify macOS behavior without claiming other platforms
- **Question:** Which host/path/native surfaces are verified (brainstorming constraints)?
- **Options:** portable API with macOS verification; implement unrequested cross-platform transports
- **Chose:** portable Node/Bun paths where available, macOS verification only; Linux/Windows filesystem durability, case-folding and remote-host integration remain platform verification work
- **Why:** LOOP.md fixes platform scope and requires honest deferral records; this feature adds no native-only scenario.
- **Evidence:** docs/loop/LOOP.md:48-49,124-137
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform lanes are authorized
- **Source:** deferred: platform

## D12: Correct genuine spec-review gaps and reject planned-path prepass false positives
- **Question:** Which findings from the mandatory Codex review are real defects (spec review)?
- **Options:** accept every mechanical path guess; adjudicate against the live contracts and declared new-file intent
- **Chose:** accept F3 (identity normalization), F4 (missing Purpose heading), F5 (external feature path precision), and independently verified runtime-label/confirmation API gaps; reject F6–F32 as examples, explicitly planned new files/types, API/contribution identifiers, command strings or CLI flags mistaken for existing paths/executables
- **Why:** a feature spec must name files not yet built, not create implementation before review. Defined canonical remote equivalence and sticky repo mapping, changed the external path to its absolute location, named Purpose, specified plugin-scoped persisted profile/activation UUIDs, and replaced nonexistent ctx.confirm/confirmed-only bypass with the standard destructive/describe/yes dispatcher contract.
- **Evidence:** /tmp/quirky-ledger-review.ucKhCw/{promote.raw,refute.raw,gate.json,manifest.json}; packages/protocol/src/cli.ts:5-29; packages/daemon/src/plugins/confirm.ts:20-24,67-81; packages/daemon/src/plugins/dispatch.ts:120-135,188-195
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** live API/CLI tests disprove the corrected contracts
- **Source:** assumed — autonomous

## D13: Use two independent implementation components with one integration owner
- **Question:** How to partition implementation and checks (subagent-driven-development planning)?
- **Options:** one monolithic worker; separate horizontal store/API/CLI tasks; daemon+CLI/import vertical slice and UI+owner-surface vertical slice
- **Chose:** two disjoint component worktrees, omp tasks implement; daemon component owns ledger manifest/types/daemon/CLI/API tests and repo daemon guard changes; UI component owns ledger UI/window tests and worktree owner-menu/settings/retention UI; orchestrator integrates, runs all checks and reviews
- **Why:** backend and UI contracts are fixed in tech.md, so parallel implementation is safe without shared file edits. No artificial checkpoint wave or tiny hub-only task. Worker checks are deferred until the authoritative integration gate per tool policy.
- **Evidence:** docs/quirk/specs/2026-10-27-m5-ledger/tech.md; packages/ui/build.ts:37-53 discovers UI modules automatically
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a worker requires an out-of-scope shared file
- **Source:** assumed — autonomous

## D14: Enforce the actual public schema subset and canonical filesystem paths
- **Question:** Why did the first integration gate fail (implementation/debugging)?
- **Options:** bypass schema validation; use supported schemas and fix fixture preconditions
- **Chose:** remove unsupported maxItems declarations while keeping handler bounds; explicitly describe closed target/filter objects and permit dynamic content; use the canonical path returned by makeRepo and create nested fixture parents
- **Why:** plugin diagnostics proved malformed JSON and unsupported array keywords invalidated repo/worktree contributions; later real requests proved empty object schemas reject all properties. macOS /var aliases invalidated direct fixture path comparison. None are reasons to weaken the public validator.
- **Evidence:** plugin.list diagnostic in iteration 2; packages/protocol/src/schema.ts:3-30,168-183; targeted ledger tests; docs/quirk/specs/2026-10-27-m5-ledger/tech.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** public schema vocabulary grows
- **Source:** assumed — autonomous

## D15: Test consumer invariants rather than SQLite bytes or asynchronous loading frames
- **Question:** Which failing assertions were invalid assumptions rather than feature defects (verification)?
- **Options:** change production behavior to satisfy every assertion; remove incidental checks and exercise meaningful transitions
- **Chose:** remove raw database-byte equality, default-order assumptions, CSS-property assertions and premature loading-frame assertions; test preserved corrupt content, unordered filter membership, actual detail state/revert actions, and await rendered result states
- **Why:** SQLite checkpoint headers legitimately change; collection filtering does not imply sequence order; happy-dom CSS values cannot prove a footer is visible. The built browser smoke remains the visual regression check. Canonical import matching with one equivalent anchor is replay, not a collision: original Orca code skips only when more than one anchor matches.
- **Evidence:** /Users/zpyoung/PycharmProjects/orca/src/main/ledger/ledger-import-record.ts:25-31,54-91; plugins/quirky.ledger/test/{ledger,import-cli,window}.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** browser evidence contradicts the reachable-footer requirement
- **Source:** assumed — autonomous

## D16: Correct import paths, value flags and Quirky JSON rather than copy Orca's transport envelope
- **Question:** Which CLI/import failures changed consumer behavior (verification)?
- **Options:** adapt tests to broken imports/envelopes; correct the feature to the reviewed contract
- **Chose:** join legacy source names to the selected workspace root; parse both bold label forms and ADR source-path identity fallback; keep standard Quirky JSON results; make reviewed/stale value-taking true/false flags; route list type/state only into filters
- **Why:** actual CLI imports had ignored legacy files relative to process cwd, boolean switches treated false as a positional, and an extra Orca envelope hid result fields. Added a failing-before/passing-after ADR identity test.
- **Evidence:** plugins/quirky.ledger/src/daemon/imports.ts; plugins/quirky.ledger/cli.ts; CLI suite 11 pass; API suite 25 pass; window suite 7 pass; typecheck/build exited 0 before nested-root teardown correction
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** direct CLI/API scenario tests fail
- **Source:** assumed — autonomous

## D17: Do not rewrite protected queue infrastructure to clear the scripts gate
- **Question:** Can this lane safely repair the required scripts failure after integration catch-up (verification)?
- **Options:** edit shared queue ordering directly; add or set a queue item; block until the protected prerequisite is repaired
- **Chose:** do not edit protected files; finish reachable smoke/cleanup and block if the integration queue remains invalid
- **Why:** bun test scripts exited 1 with 54 pass/1 fail at queue.test.ts:85. Queue item m6-objective-landing precedes its already-declared dependency m6-sitter-github. A read-only scout found the same single violation on build/roadmap and no existing queue.ts operation that reorders existing items; add rejects duplicate ids and set/block only change status. The required correction is to move m6-sitter-github before m6-objective-landing through authorized loop maintenance, not silently weaken the test.
- **Evidence:** docs/loop/queue.json:700-725; scripts/build-loop/queue.test.ts:82-85; scripts/build-loop/queue.ts:7-16; scripts gate artifact://114; LedgerQueueGateScout output
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** build/roadmap supplies a supported queue-order repair
- **Source:** locked by docs/loop/LOOP.md

## D18: Treat an unchanged fast refresh as a visual-probe limitation, not a proved dead request
- **Question:** Is the first web smoke's Refresh NO_EFFECT a confirmed application defect (verification)?
- **Options:** add gratuitous refresh animation; claim pass; preserve the observed limitation and continue missing scenarios
- **Chose:** preserve the partial visual result without changing the intentionally delayed spinner; run focused continuations for unfinished scenarios
- **Why:** both clicks used unchanged backend data, with no console/network failures. The specified spinner appears only after 200ms, so identical fast refresh can legitimately yield no screenshot change. The initial worker stopped at its tool request-count cutoff, not a main-session user decision; unexercised goals are not passed.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T182959-3362/report.json; obs-21.png; source spinner guard in plugins/quirky.ledger/src/ui/LedgerApp.tsx; worker handoff
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a refresh fails to display changed data or produces an actual request error
- **Source:** assumed — autonomous

## D19: Preserve separate visual outcomes and the constrained-viewport footer proof
- **Question:** What did the built-web smoke actually prove (verification)?
- **Options:** collapse partial runs into a claimed full pass; keep exact run-level outcomes and focused completion evidence
- **Chose:** keep all reports; the focused detail/edit/triage run passed 3 goals and the separate-runtime retention run passed 7 goals; initial chooser/navigation passed and initial forms created all five types
- **Why:** real 1280x720 screenshots show the long-history body scrolled with its action footer visible, followed by resolved revision 17 and reverted revision 18. Focused evidence also covers external-host validation, captured-revision edit, triage approval, immutable confirmations, settings Save/Saved, retained owner removal, attachment, per-entry/bulk/ledger deletion. The initial unchanged-data refresh remains a partial visual-probe limitation under D18, not a fabricated pass. The supported driver has no viewport-size option, so no 1452x1050 run is claimed.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T182959-3362/report.json; runs/20261027T185253-f04a/report.json and obs-10.png; runs/20261027T185557-5bee/report.json and obs-24.png
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** visual controls become unreachable or a real request fails
- **Source:** assumed — autonomous

## D20: Fix asynchronous test readiness, retain the red infrastructure gate, and stop superseded verification
- **Question:** How to handle remote failures and the caught-up loop's verification policy (verification)?
- **Options:** weaken assertions or extend arbitrary waits; await consumer-visible ready states and preserve every unresolved gate
- **Chose:** await loaded chooser/detail/attachment controls and enabled removal-confirmation buttons, preserving data/revision assertions; remove incidental immediate floating-button and copy assertions. Do not change protected queue/test infrastructure. Cancel the already-started whole suite and use targeted remote verification after reading the updated LOOP.md.
- **Why:** captured failures showed Loading entry, Checking retained ledger records, missing not-yet-rendered selectors and an early floating button. Local corrected runs passed ledger window 7, worktree window 18 and floating 5, followed by typecheck. The cancelled whole-suite run has no final verdict; its exact owned remote copy/process tree was terminated and removed. Final review must not start on a red mandatory scripts gate.
- **Evidence:** cancelled proc://bg_14 output; local artifact://362; targeted remote bg_41 output; scripts/suite.ts process ownership; cleanup of /home/quirkyci/runs/1793125374884-31860; docs/loop/LOOP.md:121-127
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** targeted remote checks still fail or protected queue ordering is repaired
- **Source:** assumed — autonomous

## D21: Resume the restored ledger item on the authorized queue repair
- **Question:** which item, baseline and gates to use after the operator restored lane 3
- **Options:** claim another item; resume the preserved implementation and complete its remaining gates
- **Chose:** resume build/m5-ledger only, merge build/roadmap, and pin final-review integration baseline 0152c82cf691a1067fab693222033429de17eb55 before discovery. Preserve the original implementation baseline in the scratch journal as history.
- **Why:** the operator fixed queue ordering in 4cf9720 and restored this item in-progress for lane 3. Catch-up imported only queue/blocker/index changes and the m5-structured-runner decision log; the complete incoming log was read and introduces no conflicting ledger source contract.
- **Evidence:** operator note; merge 0a3afe166325d93a2f26db640122ff28da570b6d; docs/loop/decisions/m5-structured-runner.md D3–D13,D18–D27
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** integration adds a conflicting public plugin contract
- **Source:** assumed — autonomous

## D22: Verify affected roots and share one observed prepass across the three review lenses
- **Question:** which checks cover the restored feature without repeating the whole landing suite
- **Options:** whole suite in every lane; affected roots plus integration and boundary suites
- **Chose:** scripts, typecheck and build, then remote suites for quirky.ledger, quirky.repo, quirky.worktree, the entire quirky.terminal plugin, plugins/test, packages/daemon, packages/ui, packages/cli and apps/desktop. Reuse that exact observed prepass for correctness/spec/security lenses.
- **Why:** production cross-plugin relationships use the public API, not private static imports. The terminal plugin has an item-owned test change, so its whole suite is retained rather than narrowing to the one file. Host/CLI/window/bundling roots exercise discovery, generated commands and delivery. queue.ts land remains responsible for the whole repo suite.
- **Evidence:** LedgerAffectedSurvey; docs/loop/LOOP.md:121-127; plugins/test/imports.test.ts; apps/desktop/test/bundle-plugins.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the final fix batch changes another root or shared core code
- **Source:** locked by docs/loop/LOOP.md

## Progress
Resumed on build/m5-ledger after the operator's authorized queue repair; integration catch-up complete and incoming runner decisions read. Prior implementation, API/CLI/window tests and built-web smoke evidence remain D14–D20. Next: rerun affected remote suites, scripts/typecheck/build; run the mandatory one Gemini three-lens final review and one accepted-finding fix batch; rerun checks/build, record all findings/remaining limitations, and land through queue.ts. Do not claim or begin another item. No current review clearance or fresh gate pass is claimed yet.

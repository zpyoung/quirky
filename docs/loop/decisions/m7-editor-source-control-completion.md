# m7-editor-source-control-completion decisions

## D1: Complete existing owners without changing the locked platform or exclusions
- **Question:** What scope and authority govern this completion item?
- **Options:** replace the editor/Git/sidebar stack; extend each canonical built-in owner.
- **Chose:** extend canonical editor, Git, hosting and sidebar APIs and UI. Preserve CodeMirror 6, public cross-plugin calls, disk/content CAS and exact note settlement. Exclude non-GitHub forges, Objective runner and PR sitter. Keep Finder source-path support in its separately blocked item.
- **Why:** the queue names concrete unfinished flows, not a new replacement stack or permission to fabricate native capabilities.
- **Evidence:** queue title; docs/roadmap.md:13–53,259–287; docs/architecture.md:290–324; m7-sweep-editor-source-control D1/D3/D5/D10.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a supported public capability conflicts with an earlier binding decision.
- **Source:** locked by docs/roadmap.md and docs/architecture.md

## D2: Resolve gray areas autonomously with source-grounded defaults
- **Question:** How should design questions be resolved in this unattended iteration?
- **Options:** ask a person or run external research swarms; decide from feature docs, locked decisions and current owners.
- **Chose:** no asks, companion offers, divergent ideation, external research swarms or spec review. Domains are Visual/API/CLI/Data/Integration. Preserve compact existing layouts and schema-generated CLI. Choose explicit loading/empty/error states; fail closed on stale ownership, permission denial and ambiguous links; preserve drafts and notes on failure; keep state in its current canonical store. Inspect all material interaction, error, persistence, grouping, response and conflict-resolution gray areas. One combined logic spec with a technical final section, self-reviewed against the named flows.
- **Why:** authoritative build-first LOOP instructions replace interactive gates and separate tech/spec reviews. Purpose, consumers, success, constraints, scope and primary behavior come from the queue and three feature docs.
- **Evidence:** authoritative git show build/roadmap:docs/loop/LOOP.md; external editor.md, sidebar-extras.md and source-control.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** source documents leave an observable behavior unresolved.
- **Source:** locked by docs/loop/LOOP.md

## D3: Author acceptance now and defer execution to the end phase
- **Question:** Which verification cadence applies before m7-test-triage?
- **Options:** run suites/dogfood/review now; author tests and native handoffs, run the typecheck-only landing gate.
- **Chose:** write behavior/defect regressions without running them; do not run suites, UI dogfood or review campaigns. Typecheck is the landing gate. Use at most three disjoint implementers after committing shared contracts. Runtime smoke required by engineering policy will be narrowly scoped and isolated, not a test-suite or dogfood campaign.
- **Why:** current LOOP explicitly moved testing/debugging to the end phase; typecheck or authored tests must never be described as behavioral acceptance.
- **Evidence:** authoritative LOOP Build first, test at the end section; queue status has feature items in progress.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end phase is claimed or an operator changes the policy.
- **Source:** locked by docs/loop/LOOP.md

## D4: Preserve unrelated diagnostic metadata
- **Question:** How should inherited untracked .serena/ be handled?
- **Options:** stage/stash/delete it; leave it untouched and explicitly stage only owned paths.
- **Chose:** preserve it unchanged and uncommitted. Implementers use separate temporary worktrees and absolute file-tool paths.
- **Why:** it was restored from a previous iteration and is not this item's work.
- **Evidence:** initial git status --short --branch; loop notes iteration4 completion and iteration6 receipt.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** metadata interferes with a required command.
- **Source:** assumed — autonomous

## Progress
Claimed item and created build/m7-editor-source-control-completion from build/roadmap. Read prior sweep decisions/spec, locked roadmap/architecture, feature sections and remaining SC-3–22 acceptance matrix. One read-only owner mapper is running; no implementer or check launched. Next: finalize combined spec/shared public contracts, commit, dispatch at most three disjoint implementation components. Preserve .serena/.

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

## Progress
Both specs authored and reviewed in one real Codex promote/refute pass (reduced same-family independence, mandated by LOOP.md); confirmed findings corrected. D12 records the NEEDS_FIXES gate and all adjudications; not a claimed clean gate. Next: commit specs/decisions; create disjoint daemon and UI component worktrees, implement, audit/integrate, run API/CLI/window and whole-suite checks, merge build/roadmap and read incoming decisions, run one Gemini final review/fix batch, built-web smoke, and land m5-ledger. No implementation yet.

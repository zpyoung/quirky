# m7-sweep-automation-completion decisions

## D1: Complete independent local provenance and actual phone composition
- **Question:** Which remaining flows can ship against the current landed owners?
- **Options:** infer attribution from api/name; add a parallel feature store; extend workspace metadata and actual phone pages.
- **Chose:** durable authenticated creation provenance, sidebar badge/navigation/deletion states, persisted desktop/phone hide filter and compact phone loop summaries.
- **Why:** automation dispatch currently passes createdBy api only; sidebar/filter lacks provenance; sb-mobile-app is now done and its actual workspace page explicitly disables the filter and omits summaries.
- **Evidence:** MapCompletion scout; packages/protocol/src/model.ts:22-97; plugins/quirky.automations/dispatch.ts:787-800; apps/mobile/src/pages/WorkspacesPage.tsx:44-50,148-180; prior sweep D9.
- **Reversibility:** medium (public attribution shape and persisted metadata)
- **Confidence:** high
- **Revisit if:** concurrent owner lands equivalent functionality before catch-up.
- **Source:** locked by docs/loop/decisions/m7-sweep-automation.md D9

## D2: Attribute only creation authorized by a live dispatch
- **Question:** How does a public worktree create distinguish real automation from arbitrary claimed snapshots?
- **Options:** trust supplied IDs/snapshots; infer from current run; consume an opaque single-use dispatch capability.
- **Chose:** new public WorktreeAutomationProvenance and request types; request token bound to automation/run/resolved repository and live dispatching state. Worktree calls quirky.automations/claimWorkspaceProvenance before side effects and persists the returned immutable snapshots with its row. Existing createdBy remains api; existing-workspace runs receive no attribution.
- **Why:** feature doc uses dispatch-authorized creation. A name prefix or generic api value cannot prove provenance; definition deletion must not erase snapshots. Restart-stranded dispatches already fail closed without automatic replay.
- **Evidence:** automations.md entry points and renderer creation provenance; dispatch.ts:787-828; worktree/src/daemon/create.ts:509-539; store.ts:53-109,141-178.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public host routing extends local-only creation authority or exact-once retries are introduced.
- **Source:** assumed — autonomous

## D3: Resolve standard gray areas with existing surfaces and truthful uncertainty
- **Question:** What are the Visual/API/Data/Integration defaults for unattended brainstorming?
- **Options:** redesign cards/pages; extend current layouts and public navigation; add hidden-only state.
- **Chose:** current layouts with accessible badge/details/actions; immutable ID navigation; explicit checking/missing/history-unavailable/read-failure states; existing persisted client preference scope and phone storage; no heuristic backfill. Hide is off initially. Compact phone labels use completed counts/caps/reasons and deterministic needs-you/running/paused priority. Failed/disconnected reads invalidate cached labels; successful empty removes them. Full history and mutations stay denied to phones.
- **Why:** preserves essential consumers/purpose, scope, constraints, success scenarios and observable safety. Logic spec A1–A5 gives before/after examples and all consequential defaults. No human/visual/adhd prompt or external research swarm in this unattended loop.
- **Evidence:** automations.md:25-28; fork-loops.md:11-14; specs/2026-10-28-m7-sweep-automation-completion/logic.md Decisions Locked and A1–A5; sb-mobile-app D2,D7,D10.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a concrete consumer contract contradicts the chosen presentation.
- **Source:** assumed — autonomous

## D4: Keep SSH ledger flow whole behind the missing public authority
- **Question:** Can this item safely implement SSH workspace ownership/routing/import/evidence and selected-runtime availability now?
- **Options:** treat remote paths as local; invent ledger-private SSH generations; defer the isolated flow and ship independent local work.
- **Chose:** defer only this flow to one prerequisite-gated follow-up before land. Do not duplicate existing remote automation owners and do not add metadata-only scaffolding.
- **Why:** protocol has local Repo/Worktree paths and no host registration/incarnation/filesystem authority. Ledger normalization/import/evidence dereference local paths. Host fields are metadata, not an execution route. Canonical remote dispatch item is blocked; remote UI remains its existing owner.
- **Evidence:** MapLedgerHost scout; ledger/src/daemon/owners.ts:7-56,135-169; content.ts:29-52,169-190; imports.ts:195-251; engine.ts:755-800,1030-1070; prior remote dispatch D1–D4; canonical queue status.
- **Reversibility:** easy
- **Confidence:** high for inspected contracts; no remote runtime behavior claimed
- **Revisit if:** public host registration/generation lookup, remote workspace identity and fenced filesystem/execution land.
- **Source:** deferred: SSH ledger ownership/routing/import/evidence/selected-runtime availability

## D5: Apply one-spec build-first workflow with three disjoint implementers
- **Question:** Which workflow gates and worker contracts apply?
- **Options:** ordinary reviews/suites/dogfood now; current authoritative one-spec build-first mode.
- **Chose:** combined logic spec with final tech contracts; commit shared protocol types before at most three omp/OpenAI task implementers. No worker checks/commits. Parent integration owner runs final typecheck; broader tests/reviews/dogfood remain end-phase-owned. Reviewer pairing would be omp-task + cross-family reviewer when end phase requires it; no review dispatched now. Preserve inherited .serena unchanged through explicit paths and isolated worktrees.
- **Why:** current LOOP Build first overrides ordinary skill phases. Developer verification still requires narrow runtime evidence for changed behavior; this is not a broad suite or UI dogfood campaign. No language server is configured, as actual xd://lsp status reports.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; xd://lsp status; initial git status shows only inherited untracked .serena.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts end phase or typecheck reports integration diagnostics.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Scope mapped with two returned read-only scouts. Combined spec self-reviewed against inherited flow inventory and feature docs; shared protocol provenance types authored. Next commit contracts/spec/decisions, dispatch <=3 disjoint workers in isolated worktrees, integrate, record narrow evidence and typecheck, register the single remote-ledger unbuilt-flow follow-up, catch up once and land through absolute queue executable. No tests/build/review/dogfood/runtime checks run yet; no success claim.

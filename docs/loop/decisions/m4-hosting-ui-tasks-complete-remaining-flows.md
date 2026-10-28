# m4-hosting-ui-tasks-complete-remaining-flows decisions

## D1: Retain the full original scenario catalog and implement missing public joins
- **Question:** which remaining flows are absent rather than simply unexercised?
- **Options:** rewrite Tasks; treat all untested flows as absent; preserve existing surfaces and close concrete integration gaps.
- **Chose:** preserve SC01–SC25 as authoritative, reuse Tasks/issue/Projects/settings implementations and add targeted behavior/coverage for canonical workspace consent/delivery, source-qualified PR navigation and uncertain stale-write boundaries.
- **Why:** current source has real public methods/UI for the whole catalog. Independent read-only maps distinguish implementation from acceptance; prior D22 did not claim exhaustive acceptance.
- **Evidence:** original Tasks logic.md SC01–SC25; m4-hosting-ui-tasks D17/D19/D22/D23; TasksMap and WorkspaceReadinessMap source maps; src/list/workspace.ts239–329 and src/review-navigation.ts1–8.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a source-defined flow lacks an actual owner or runtime operation.
- **Source:** locked by docs/quirk/specs/2026-10-27-m4-hosting-ui-tasks/logic.md

## D2: Resolve standard gray areas without a human and defer campaigns to the end phase
- **Question:** how do brainstorming/spec/implementation questions and verification apply to this unattended item?
- **Options:** wait for a person; invent research/review work; apply current build-first protocol and recorded defaults.
- **Chose:** Visual layout/density/loading/errors/interaction; API response/errors/auth/pagination; CLI output/flags/recovery; Integration sync/conflict/mapping; Data persistence/ownership. Preserve source layout, accurate loading/empty/unavailable/stale states, shared CLI/API, exact source, reversible writes, durable preferences and session drafts. One combined logic spec, autonomous self-review, no asks/visual/adhd/research swarm/separate spec review. Write behavioral tests, do not run suites or exhaustive dogfood/review campaigns before end phase. Final typecheck is the landing gate. A disposable changed-path smoke supplies required runtime evidence without claiming exhaustive acceptance.
- **Why:** canonical LOOP.md explicitly supersedes older item/spec campaign timing. Existing native scenarios remain pending; no test/review follow-up item may be added.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Build first/test at end and Answering a skill's questions; source hosting-ui.md sections1–4,6–8,12.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage is claimed or loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep one creator, independent pinned hook consent and canonical readiness
- **Question:** how should sourced creation and agent delivery be completed?
- **Options:** plain-create fallback; duplicate launch/readiness runner; integrate existing owning public methods.
- **Chose:** exact item URL to worktree/create, independent setup/issue command run/skip and content pins, retained approvals across the other hook's refusal. Select default through agents/pick(forAgentTab:true); session/agents own readiness and exactly-once paste. Return real agent session/pending/setup/issue-command/warnings and observed promptDelivery; pending/unconfirmed/failure is not delivered. Post-create warnings retain the created/link state, not a retryable creation failure.
- **Why:** canonical create and session delivery already exist. Tasks currently drops the issue consent kind/hash and launch outcomes; a second owner would bypass locked trust/readiness semantics.
- **Evidence:** m4-worktrees-create-from-github D7/D16/D19; quirky.worktree create.ts663–670,750–806; quirky.agents delivery.ts25–57; quirky.tasks workspace.ts239–329; WorkspaceComposer.tsx155–190.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** canonical creation or session delivery contracts change.
- **Source:** locked by docs/loop/decisions/m4-worktrees-create-from-github.md

## D4: Commit contracts then use three disjoint OpenAI implementation components
- **Question:** which decomposition preserves independent ownership and the omp model pairing?
- **Options:** one broad worker; overlapping list/project work; three disjoint components with parent integration.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai; review skipped under build-first policy (no unperformed Opus/Gemini probe or review claimed). Three external temporary worktrees: workspace/composer+manifest+new workspace tests; list/issue/env/ui+their tests; Projects+its tests. Parent owns shared contracts, PR navigation helper, docs, smoke and integration. Cap3, one wave, no semantic edges; width cap does not bind. Workers do not commit or run checks. Inherited untracked .serena remains untouched and excluded.
- **Why:** existing vertical modules provide disjoint scopes. Shared source/outcome and helper signatures are committed before dispatch; no need to add a new lifecycle or schema dialect. No language servers are configured, confirmed through xd://lsp status.
- **Evidence:** committed shared contracts and spec; two scout maps; actual LSP status; initial git status only untracked .serena.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required change crosses scopes; parent replans before accepting it.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous (decomposition)

## D5: Carry explicit PR source identity into Reviews
- **Question:** how to avoid navigating same-number PRs from the wrong remote?
- **Options:** worktree+number only; import Reviews internals; public Reviews open with validated prRepo.
- **Chose:** extend the Tasks helper input with optional URL/host/owner/repo, resolve the exact PR identity, reject mismatches, and pass prRepo to quirky.reviews/open. List/check/Project consumers forward their complete ItemTarget. Preserve canonical confirmation and queue outcomes in row actions.
- **Why:** Reviews already declares prRepo; Tasks currently discards its resolved target identity.
- **Evidence:** quirky.tasks src/review-navigation.ts1–8, list/useReviewNavigation.ts24, projects/ProjectsSurface.tsx744; quirky.reviews src/contracts.ts8.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviews open contract changes.
- **Source:** locked by docs/loop/decisions/m4-hosting-ui-reviews.md D3/D5

## D6: Restrict runtime proof to isolated macOS state
- **Question:** where may new tests and smoke run?
- **Options:** real forge/user credentials; fresh owned HOME/QUIRKY_HOME and stateful upstream/agent fixtures.
- **Chose:** disposable local repositories, fixture executables, isolated homes and owned process teardown. Preserve original native handoff; Linux/Windows shell/keyboard/clipboard/process behaviors remain unverified on those platforms.
- **Why:** automated work must not touch real ~/.quirky, ~/.claude or ~/.codex; web/API evidence does not establish native OS effects.
- **Evidence:** LOOP.md Hard rules/Platforms; original Tasks native handoff and D6.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported execution platforms expand.
- **Source:** deferred: platform

## Progress
Scope and contracts recorded. Next: commit shared contracts/spec and dispatch the three disjoint components; integrate, run typecheck and isolated changed-path smoke, catch up once, then land. No tests/review/dogfood campaign has run or been claimed.

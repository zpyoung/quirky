# m7-sweep-hosting decisions

## D1: Sweep all remaining GitHub flows and preserve the explicit exclusions
- **Question:** what does this parity sweep include beyond the four landed dependencies?
- **Options:** repeat only prior tests; audit both source documents and repair confirmed gaps; rebuild all hosting providers.
- **Chose:** audit every GitHub flow in hosting-api.md and hosting-ui.md, including earlier deferred GitHub flows. Exclude GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner and PR sitter exactly as the claimed item specifies. Reuse quirky.hosting, quirky.tasks and quirky.reviews rather than create a second owner.
- **Why:** the queue explicitly asks for remaining flows, not only already-verified core behavior; roadmap parity and public scripting remain locked.
- **Evidence:** queue.ts wait --lane 8 returned m7-sweep-hosting; docs/roadmap.md:13–55; hosting-api.md and hosting-ui.md.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a confirmed gap requires changing a locked architectural decision.
- **Source:** locked by docs/roadmap.md; locked by item title

## D2: Use the unattended night-mode procedure and existing feature owners
- **Question:** how are brainstorm questions, specifications and implementation resolved without a person?
- **Options:** interactive questions; autonomous source-grounded defaults under LOOP.md.
- **Chose:** no asks or visual/adhd offers; one markdown logic spec with final technical contracts and self-review. Standard gray areas: API response/error/auth/rate-limit/pagination; Visual loading/empty/error/density/interaction; Integration auth/sync/conflict/retry/data mapping; Data persistence/ownership/idempotency; CLI flags/output/errors. Source-defined behavior and prior decisions win; explicit unknown/unavailable states beat fabricated empty success. API/CLI remain canonical for UI state and operations. Inspect earlier followups rather than treating them as exclusions.
- **Why:** authoritative LOOP.md night mode applies: observed local time 2026-10-28T02:47:48-0500, before its 4am target. Existing providers own auth and policy; renderer must not shell out or import private daemon internals.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; m4-hosting-api-github D4–D10; m4-hosting-ui-tasks D3/D5/D8/D9; m4-hosting-ui-reviews D3/D5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** this item's runtime evidence contradicts a prior binding decision; name and supersede it explicitly.
- **Source:** locked by docs/loop/LOOP.md

## D3: Pair OpenAI task implementers with the reachable Gemini reviewer
- **Question:** which reachable cross-family pair satisfies an omp lane?
- **Options:** task+Opus; task+Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini high. At most three disjoint implementation components; contracts committed before dispatch. Parent audits scope and owns all acceptance commands; workers skip checks/commits. Preserve unrelated untracked .serena state. RUN_BASE=2d00b2931121b5f1bf309d7dd155ea33d94d6c9b.
- **Why:** actual pi-watch --check reports Opus/Sonnet unavailable, Gemini google/gemini-3.1-pro-preview:high ready; Bun1.4.0 available. LSP status reports no configured language servers.
- **Evidence:** observed preflight output; xd://lsp status; git branch created from build/roadmap. Commands: bun run build; bun scripts/suite.ts for changed/importing directories; bun test scripts; bun run typecheck; queue.ts land owns whole-suite gate.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails; follow documented fallback and record it.
- **Source:** locked by docs/loop/LOOP.md

## D4: Repair three confirmed gaps without changing source-control ownership
- **Question:** which remaining flows are actionable and how should independent implementation be partitioned?
- **Options:** verify-only sweep; focused repairs in current owners; broad forge rewrite.
- **Chose:** one wave of three disjoint components: Hosting search batching/cursor reuse, repository-owned Project issue types with Tasks picker gates, and Reviews Browser routing with exact-worktree callers/descriptor. No semantic dependency edges or checkpoint round. Parent owns legacy fixture alignment, docs and final integration. Lane11 retains Git WorktreePanel/ladder/CommitArea/Markdown notes; public review lookup/createOpen contracts stay unchanged.
- **Why:** scouts found concrete deferred source paths, not speculative feature requests. Existing owner boundaries cover all three without a new provider or kernel abstraction.
- **Evidence:** HostingApiCoverage and HostingUiCoverage reports; item-search.ts:88–133; project-mutations.ts:250–256; ProjectsSurface.tsx:627–665; reviews/ui.tsx:129–137; user lane11 coordination; /tmp/quirky-lane11-hosting-sweep-reply.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required behavior needs another public contract; publish it rather than copy uncommitted foreign source.
- **Source:** assumed — autonomous; locked by user lane11 ownership

## D5: Follow repository owner capability, not Project owner
- **Question:** how should a personal Project containing an organization Issue discover and change issue types?
- **Options:** preserve temporary unsupported boundary; use Project-owner types; inspect the actual content repository owner.
- **Chose:** query Repository.owner typename and Organization.issueTypes; personal repositories return no organization types. Validate type availability/enabled state, page shape/cursor/issue identity and mutation readback; invalidate after accepted provider writes before response validation. Remove matching Project-owner UI gates. Preserve existing Project-field clear; no invented new Issue-type clear selector.
- **Why:** Project containers do not own their items' repository types. A missing/malformed connection is unavailable, not an authoritative empty list. This completes the temporary D38 ownership deferral without changing ambient Project authentication.
- **Evidence:** m4-hosting-api-github D38; actual ownership RED unsupported_operation, then2pass21assertions; malformed-page RED resolved unexpectedly, then final3pass31assertions in11.81seconds. Actual picker/web proof still pending.
- **Reversibility:** easy
- **Confidence:** high for API regressions; UI not yet verified
- **Revisit if:** GitHub changes supported RepositoryOwner/type connections.
- **Source:** supersedes m4-hosting-api-github D38 (temporary user-Project unsupported boundary only)

## D6: Correct fixture transport assumptions before accepting a red test
- **Question:** can setup/parser failures stand in for missing feature behavior?
- **Options:** count every red as TDD evidence; repair isolation/fixtures and observe the actual missing behavior.
- **Chose:** fixed a nested fixture template parse error, recognized host-qualified gh arguments, included Browser's real Editor dependency and used declared Browser methods before settings. No production deadline/semantic assertion relaxed. Search RED then returned correct rows/counts but made12provider calls instead of2 and replayed the first cursor block; Reviews RED reached a false app-route result with Browser active.
- **Why:** missing fixture data and unavailable plugin registration prove neither batching nor route behavior. Source tests must describe real provider transport.
- **Evidence:** bg5/bg8 fixture failures; bg11 two behavioral failures in5.62seconds; bg6/bg9 setup errors and bg12 actual route failure in4.12seconds. Baseline packaged Projects discovery worked, then fixture viewer/mixed-owner assumptions failed; guarded run20261028T075709-4945 is partial, not a product pass. Its service exited0 after owned cleanup.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a provider fixture again accepts an impossible shape or bypasses a required validation.
- **Source:** assumed — autonomous; locked by LOOP.md isolated-state and evidence requirements

## Progress
Contracts committed06f3e8cc; three components audited at unchanged HEAD and merged as9cc24e68/eafde4d7/390cdc37. Source acceptance search8pass37assertions, types3pass31assertions, routing1pass35assertions. Actual generated CLI type mutation/readback passed after an interrupted first attempt. Component trees removed. Parent legacy fixture alignment and native handoff are ready. Next: one roadmap catchup/read incoming decisions, affected directories/scripts/types/build, final actual UI proof, record remaining acceptance with existing owners, normal queue land. No combined-gate, full-parity, review or native success claimed.

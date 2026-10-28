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

## Progress
Claimed and oriented at 02:47 local. Two read-only scouts map complete API/UI coverage and exact gaps. Next: select confirmed repairs, commit combined logic/technical contracts, implement disjoint slices, run affected gates and actual UI/API smoke, catch up once, final review and normal land. No feature behavior has changed or passed verification in this item yet.

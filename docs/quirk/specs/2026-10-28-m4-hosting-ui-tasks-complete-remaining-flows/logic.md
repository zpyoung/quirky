# Complete GitHub Tasks integration

## Status & amendments
Approved autonomously under the current build-first LOOP.md policy. The original [SC01–SC25 catalog](../2026-10-27-m4-hosting-ui-tasks/logic.md#behavior-and-acceptance-scenarios) remains authoritative. This completion supplies missing cross-feature behavior and regression coverage; exhaustive acceptance, reviews and dogfood run in the end phase, not here.

**Amendments:** 2026-10-28 — initial completion specification; one logic spec with technical decisions, no separate tech.md or spec-review campaign.

## Purpose and conceptual model
Tasks owns list/issue/Projects navigation and composition. Hosting owns source authorization and mutations. Worktree owns exact GitHub checkout, hook consent, creation and launch. Agents/session own default selection, readiness and one-time prompt delivery. Reviews owns PR conversation/checks/files. Completion joins those existing owners without a second creator, provider client or delivery runner.

## Scope and non-goals
All original SC01–SC25 requirements remain in scope: source/frame/settings, sticky-all/deep links/search/pagination, row edits/checks/merge, issue detail/Markdown/comments/create, Projects discovery/table/board/roadmap/edit/start, stale ownership/rollback and scripting parity. Existing implemented flows are retained rather than rewritten merely because their full acceptance campaign was not run. Add targeted API/CLI/UI regressions at uncertain boundaries. Native clipboard/browser/menu/focus scenarios remain in the original pending native handoff. GitLab/Linear/Jira implementations, Reviews internals, provider auth policy and native SDK work are not allocated to this item.

## Decisions locked
- **Visual:** keep the existing compact layout, table/board/roadmap and accessible equivalent controls; show specific hook kind, script and pending/error state. No false agent-delivery success.
- **API/CLI:** same daemon methods drive the window and generated CLI. Additive consent/outcome fields use the existing schema subset. Preserve source-qualified identities across plugin navigation.
- **Integration:** exact canonical GitHub URL goes to worktree/create; no plain-create fallback. Setup and issue-command approvals are independent, bound to displayed hashes and preserved over the other hook's refusal. No automatic mutation or prompt-delivery retry.
- **Data:** sticky-all remains null and includes newly registered repos; temporary deep-link selection must not overwrite a durable explicit preference. Reads and failures cannot overwrite newer source/view/write ownership; confirmed comments survive index/read lag.
- **Errors:** failures preserve drafts/data and identify the action; post-create warnings never invite duplicate creation. Queued/pending is not merged. Unknown merge policy is not permission.
- **Process:** no questions/research swarm/review campaign. Three implementation components maximum, contracts committed first. macOS only; real state untouched.

## Behavior and examples
### C1 — Canonical workspace create and consent (SC09, SC19, SC23)
Start from Tasks or a Project uses the exact issue/PR source URL and the single worktree creator. A PR retains authenticated head/link/push metadata; an issue retains its issue identity. An unavailable source fails rather than creating an unrelated checkout. Attached work resumes; Start new deliberately creates a new workspace.

Before: issue7 has shared setup A and issue command B, neither approved. Walkthrough: submit, inspect setup A, Run once, inspect issue command B, Run once. After: one linked workspace; each approved script runs only with its displayed content hash. If A or B changes, the creator refuses before workspace/script creation and displays the replacement for fresh consent. Skip issue command must not skip setup, and vice versa. A canceled or superseded composer cannot close or submit a newer request.

### C2 — Default-agent readiness and truthful outcomes (SC19, SC24)
Project direct Start uses agents/pick(forAgentTab:true), with composer fallback for no agent or setup decision. Worktree/session receive the item context once; their canonical runner owns readiness. Tasks returns the actual agentSessionId/agentPending, setup/issue command/warnings and observed promptDelivery where a session exists. Pending, unconfirmed and not-delivered are never labelled delivered. Post-create launch failure retains and links the created workspace and reports warning; no automatic second creation.

Before: a detected paste-mode agent is not ready. Walkthrough: Start Project issue7, then agent emits its ready signal. After: exact item context is delivered once after readiness; session state reports pasted. A no-ready/exit case reports its actual unconfirmed/not-delivered result, not a successful delivery.

### C3 — Exact PR navigation and action outcomes (SC06, SC08, SC24)
List row opens conversation; Checks opens checks; Project PR opens the same exact source in Reviews. Explicit URL/host/owner/repo survives as prRepo; same-number origin/upstream PRs cannot be confused. Invalid or conflicting target identity fails before navigation. Guarded merge preserves current head/method consent; auto-merge and queue use canonical hosting guards and report their actual state.

Before: origin and upstream both have PR12. Walkthrough: select upstream PR12 and its Checks pill. After: Reviews opens upstream PR12 Checks, not origin PR12. Queue acceptance keeps PR open/queued, not merged; stale-head merge remains open with visible error.

### C4 — Remaining list/issue/Projects edge parity (SC01–SC25)
Add Gamma while sticky-all is selected: next repository projection includes Gamma. Explicit Alpha preference stays Alpha after a temporary Beta deep link. Late sourceA/viewA reads cannot repaint sourceB/viewB. A failed earlier edit cannot undo a later successful edit. Quiet adoption keeps the confirmed status across lagging search; confirmed comments survive lagging detail. New-issue drafts retain body on warning/failure and cannot double-submit. Table/board/roadmap and settings retain their public state projection and accessibility.

Before: Todo card has estimate3, a slow old view read, and editA outstanding. Walkthrough: editB succeeds, editA fails, old view read finishes after selecting another view. After: editB remains authoritative; current view is unchanged; error belongs to the attempted action. Existing bounded timeline, restricted-content and typed-error behavior remains.

## Essential coverage and rationale
Consumer: local developers and scripts. Success: public API/CLI/window paths use the same exact source and state; canonical launch/consent joins work without false delivery or duplicate creation. Alternatives considered: a new creator/delivery runner would duplicate trust and readiness policy; shell-owned navigation would violate plugin replacement. Reuse the existing public seams instead.

## Industry insights
Research source is LOOP.md's prescribed feature doc, roadmap and previous decision logs. Binding decisions include Tasks D5/D8/D9/D17/D19/D22/D23, worktrees-create-from-github D4–D7/D16/D19 and Reviews D3/D5/D7. No external research or completed acceptance/review is claimed.

## Deferred ideas
None. Testing and exhaustive UI/review campaigns are assigned by LOOP.md to the end phase, not a new follow-up item. Existing native-only scenarios remain pending, not silently removed.

## Glossary
- **Canonical source:** exact authenticated host/owner/repository/item tuple carried by URL.
- **Content pin:** creator-issued script hash that binds one-time consent.
- **Delivery:** session promptDelivery state, not workspace creation success.
- **Sticky all:** null selected-repository preference, including later additions.

## Technical decisions and contracts
Parent commits shared signatures before dispatch. `src/contracts.ts` declares `WorkspaceComposerRequest`, including separate setup/issue-command choices, current trust kind/hash/script and independent retained approvals; `TaskWorkspaceCreated` carries canonical worktree outcomes and promptDelivery. `src/review-navigation.ts` accepts optional URL/host/owner/repo and translates validated PR identity to public Reviews prRepo. Existing signatures stay compatible; no provider schema/lifecycle change.

One wave, three disjoint external worktrees. Workspace component owns `src/list/workspace.ts`, `src/list/WorkspaceComposer.tsx`, manifest workspace fields and its new fixture/tests. List/issue component owns remaining `src/list/**`, `src/issue/**`, env/ui/navigation use hook, and corresponding existing/new list/issue/state tests except workspace-owned files. Projects owns `src/projects/**` and corresponding tests/fixture. Parent owns shared contracts, review helper, docs, cross-feature smoke and integration. No workers run builds/tests/typecheck/formatters or commit. Parent gates at the wave barrier.

Verification: final `bun run typecheck`; a disposable actual API/CLI smoke for changed integration paths (required runtime proof). Permanent acceptance tests are written but not run before the end phase. Do not claim exhaustive web/native acceptance from typecheck or smoke.

## Self-review
No unresolved requirements, placeholders or asks. C1–C4 retain every original scenario; scope additions are only missing joins and uncertain-edge coverage. No new auth/checkout/readiness owner, no hidden native success, no narrowed campaign claimed complete.

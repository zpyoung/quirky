# GitHub hosting parity sweep

## Status & amendments
Status: autonomously approved under LOOP.md night mode; self-reviewed against both source documents. Technical contracts are the final section, not a separate tech.md.

**Amendments:** 2026-10-28 initial sweep specification. Prior delivered behavior is retained; earlier deferred GitHub flows are audited rather than excluded. Implementation mapping correction: route ownership includes all five actual Review/Checks callers. “Clearing” in the type slice refers to existing Project-field clear behavior, not a new Issue-type selector/API. Tasks has no existing DOM interaction harness; prove the type picker through the built guarded-web surface rather than add a second framework.

## Goal and conceptual model
Complete reachable gaps in the existing GitHub hosting, Tasks and Reviews plugins. Hosting owns authenticated provider calls and safe mutations; Tasks owns list/issue/Projects navigation; Reviews owns PR detail, Checks, creation and hosting settings. Every observable operation remains scriptable through their existing public methods and generated CLI.

## Scope and non-goals
All GitHub flows in external hosting-api.md and hosting-ui.md are acceptance inputs, including deferred API search/type behavior and Reviews in-app links whose Browser prerequisite has now landed. No GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner or PR sitter. No new OAuth/token store, direct renderer forge transport, remote-runtime system, native SDK fiction or unsafe real-user hosting writes. OS clipboard/external application/focus effects remain native handoffs. Linux/Windows need their own platform verification.

## Key decisions & rationale
Prefer focused repairs in current feature owners. Reject rebuilding the provider abstraction: it duplicates trusted-host, account, budget and mutation policy. Reject verification-only signoff: at least two explicitly deferred API behaviors and one Browser routing gap remain in source. Reuse stateful isolated upstream fixtures through real daemon API/CLI; distinguish fixture-backed provider behavior from live GitHub proof.

Project ownership does not determine issue-type capability. The content repository's actual owner controls its issue types. A user-owned Project can contain an organization-owned repository Issue; a personal repository cannot acquire another organization's types merely because its Project is organizational.

Search batching is scoped by effective host/account/execution identity, not just query text. A bounded batch must not share results or credentials across scopes, replay mutations, resurrect stale generation results or defeat forced refresh. Cached cursor pages are bounded and invalidated with the canonical hosting generation.

Review links use the public Browser openLink method, preserving its configured destination and exact gesture inversion, and the current worktree context. The historical review-only rejection is removed. Missing Browser can fall back to the established system opener only when the requested destination is system; other routing failures stay visible and must not launch another destination.

## Data flow
A registered worktree resolves trusted remote and account identity in Hosting. GitHub search reads are grouped and cached only inside that scope; each caller receives its own result or classified failure. Project actions validate project/item membership then inspect the Issue repository's owner and available types before a mutation. Review UI link actions carry the active Review/Checks worktree into Browser's canonical router; hosted view/tab state is read back through the public daemon API.

## Acceptance catalog
Each row includes all source subflows; existing behavioral tests are retained and targeted gap tests are added. Prior evidence is historical, not a fresh full-parity claim.

| ID | Source flows | Observable acceptance |
|---|---|---|
| H01 | API identity/auth/account binding/remote selection | Registered worktrees, forks, GHES/SSH aliases and origin/upstream resolve to exact trusted repository; failed binding never uses ambient account; Projects use documented ambient route. |
| H02 | API runner/cache/budget/refresh | Bounded subprocesses/concurrency, host/account budget, reported cost, no mutation retries, generation-safe cache, visibility/manual/post-push pacing and explicit unavailable outcomes remain correct. |
| H03 | API lookup/create/stack/mutations | Exact branch/number/linked PR; merged/default hiding; eligibility and templates; unique uncertain-create recovery; real stack members; guarded expected-head merge/queue/auto-merge/state/reviewers; queued is not merged. |
| H04 | API checks/logs/conversation/files | Rollups and fallbacks, bounded logs/annotations, rerun grouping/partial failure, status-only refusal, comments/reactions/threads/inline coordinates/viewed files and bounded raw contents. |
| H05 | API issues/work items | List/count/search/details/timeline/create/edit/comments/labels/assignees; explicit source partial errors; safe pagination and input limits. Same-tick independent searches batch within provider limits; later pages reuse valid earlier cursor/page results, forced refresh and mutations invalidate them. |
| H06 | API Projects | Discovery/resolve/views/table/board/roadmap data/field edits/issue fields/comments/type edits, GHES compatibility and classified errors. User Projects with organization Issues discover/change the actual repository's issue types; personal-repository Issues never borrow Project-owner types. |
| U01 | UI sections1–3 | Tasks entry/source availability, context chip, durable selections/presets, query/filter controls, explicit pagination, stale/error states and optimistic row edits with rollback/search-lag ownership. |
| U02 | UI sections4,6–7 | Issue details and create drafts/preview/image URLs/labels/assignees/status/duplicate; successful creation opens detail; workspace Start/Resume uses canonical sourced creation and guarded ready delivery. |
| U03 | UI section8 | Projects picker/pins/recent/view/search/preferences; table sort/group/fields; board write/clear/read-only; roadmap inference/zoom/today; foreign-repo authorized preview/start flow and truthful auth/error states. |
| U04 | UI section5 | PR Conversation/Checks/Files, actual merge metadata, safe merge/auto-merge/close/reopen, comment audiences/threads/compose/reviewers/assignees, files/viewed/inline comments, stale reads and failure feedback. |
| U05 | UI sections10–11 | Active Checks context/poll/empty blockers, link/unlink/stack/title/actions/conflicts/check details/agent actions/comments, eligibility/create/generate/cancel/defaults. All HTTP review links route to chosen Browser/system destination with gesture inversion and no hidden tab. |
| U06 | UI section12 | Discoverable Hosting/Task settings, source/sidebar/defaults/account/budgets and source-level persistence. Existing native-only View menu/clipboard/external delivery remain explicitly pending. |

### S1: Batch scoped search and reuse cursor pages
- Given a registered GitHub repository and two independent work-item searches under the same authenticated execution scope, when reads become ready in the same scheduling turn, then they share a bounded provider query and return their own results. Requests in different scopes never share that batch or cache. Invalidating/forced-refresh generations cannot reuse old pages.
- Data before: **Repository search** has issue "Alpha" and issue "Beta" under separate search expressions; no cached result.
- Walkthrough: client requests Alpha and Beta; then requests a later Alpha page; then mutates an Alpha issue and refreshes.
- Data after: **Repository search** returns only the matching rows per request, reuses valid cursor pages before mutation and returns the new provider state after mutation.

### S2: Use repository owner for issue types
- Given a user-owned Project with an organization-repository Issue, when a client lists and sets an enabled type, then the available types and resulting issue type come from that repository organization. An unavailable type is refused before mutation. Personal repositories report no supported types rather than inventing a Project-owner capability.
- Data before: **Project** belongs to user Pat; **Issue** belongs to Acme/tool with type Task; **Acme types** contain Task and Bug.
- Walkthrough: client discovers types and chooses Bug; client then tries a nonexistent type.
- Data after: **Issue** has Bug; the unavailable choice fails without another mutation. Project ownership remains Pat.

### S3: Navigate review links through the landed Browser
- Given a review for a registered worktree and in-app HTTP-link preference enabled, when a user opens its GitHub/check/comment/stack link, then Browser opens and reveals that exact URL for that worktree. The inversion gesture chooses the opposite destination. Routing failures remain errors, not silent system fallback.
- Data before: **Review** shows PR7 in worktree ReviewFixture; no Browser tab for its URL.
- Walkthrough: click PR7 link; read Browser and layout state; repeat with inverted gesture against an isolated system opener.
- Data after: **Browser tab** has PR7's exact URL/worktree and is visible; inverted action reaches only the system opener.

## Orca defect regressions
Retain and exercise actionable status-only rerun refusal, no false "No checks" on unavailable/loading state, no unsafe merge affordance from missing metadata, explicit provider context, no stale-write overwrite, no cross-account budget/cache bleed, lookup failure distinct from no PR, generation-safe mutation invalidation and shared guarded merge API. No sitter implementation is claimed. An org/user Project distinction is not allowed to hide repository-supported types.

## Decisions Locked
- Visual: existing compact surfaces/layouts; explicit loading/empty/error states and current actual context.
- API/Integration: trusted repository/account identity; safe classified failures; canonical confirmation/expected-head policy; no new retry layer.
- CLI: existing generated aliases/flags/JSON/error conventions; no separate transport.
- Data: durable preferences, session navigation/drafts, bounded caches and request ownership.
- Verification: disposable HOME/QUIRKY_HOME/provider fixtures and owned process cleanup only; no user credentials/forge writes.

## Industry insights
The supplied source documents and earlier hosting decisions are the night-mode research. Provider query/response shapes must match supported GitHub GraphQL, not permissive fabricated fixtures. Prior schema correction: m4-hosting-api-github D31–D38. No new external research swarm.

## Deferred ideas
Only explicit outside limits or remaining flows too large for this sweep may be recorded as named followup work under the item title/LOOP procedure. They must include exact prerequisite, acceptance and evidence; this document does not pre-authorize silent reduction. Existing deferred other-provider/sitter flows remain excluded by the item title.

## Glossary
- Scope: effective registered repository, host, account and execution context used for authenticated requests.
- Project owner: user/organization owning the ProjectV2 container, distinct from its item repository owner.
- Search page: provider results plus authoritative cursor/count metadata, never an empty stand-in for failure.

## Technical contracts and implementation boundaries
1. Search component owns plugins/quirky.hosting/src/item-search.ts, optional src/search-batch.ts and its own test/search-batch.test.ts plus test/search-batch-fixture.ts. Use existing HostingEnv.cache/cacheKey/onInvalidate/onDispose. Public listWorkItems/countWorkItems responses and caller identity remain unchanged. Max10 aliases/12000query characters;120s cache; bounded512entries/16MiB result cache and1024cursor entries/1MiB;1000result window. Coalesce equivalent reads; batches partition by env.cacheKey plus scope identity. Caller-specific failures/GraphQL alias errors remain isolated. No provider mutation or production timeout changes.
2. Issue-type component owns plugins/quirky.hosting/src/project-mutations.ts and test/project-issue-types.test.ts plus test/project-issue-types-fixture.ts; also plugins/quirky.tasks/src/projects/ProjectsSurface.tsx. Existing projectItemMutation discovery/set methods/schema stay unchanged. Validate real repository.owner typename; Organization exposes issueTypes, User does not. Remove matching Project-owner UI restrictions so either owner loads authoritative options. Preserve project/item membership, trusted-host ambient route, enabled-type validation, existing Project-field clear behavior and invalidation. Reject malformed pagination rather than return false empty success. Parent replaces the obsolete unsupported-boundary test in test/work-items.test.ts and aligns legacy provider fixtures to actual nested owner responses.
3. Review route component owns plugins/quirky.reviews/src/ui.tsx, src/env.ts, optional src/link-routing.ts, detail/{Actions,ChecksList,Comments,ReviewPage}.tsx, checks/ChecksPanel.tsx and test/link-routing.test.ts. The existing openLink public method keeps optional worktree; the window command gains the same argument. Resolve/forward exact Review/Checks worktree across backend/window boundary; reject ambiguous targets instead of using another active worktree. Delegate to quirky.browser/openLink preserving URL and mapping inversion intent to modifier:true/shift:true under Browser's actual settings. No system opener for requested in-app route and no fallback for ordinary Browser errors. Public review lookup/createOpen contracts remain unchanged; lane11 owns Git WorktreePanel/ladder/CommitArea handoffs.
4. Parent owns combined spec/decision/changelog/native receipts, integration, coverage-map gaps not yet assigned and exact acceptance. No worker commits/build/lint/tests mid-flight; parent captures unchanged HEAD and changed-path audit before acceptance. Tests first, parent runs owned red cases before implementation where possible. Three independent components in one wave, width cap3; no semantic dependencies or checkpoint review.
5. Acceptance commands: bun test plugins/quirky.hosting/test/search-batch.test.ts; bun test plugins/quirky.hosting/test/project-issue-types.test.ts; bun test plugins/quirky.reviews/test/link-routing.test.ts. Final bun scripts/suite.ts plugins/quirky.hosting plugins/quirky.tasks plugins/quirky.reviews and any changed importers; bun test scripts; bun run typecheck; bun run build; actual private-daemon API/CLI and compiled-web scenarios through the public UI. One roadmap catchup, one final review round and normal queue.ts land. No tests may touch real auth/state.

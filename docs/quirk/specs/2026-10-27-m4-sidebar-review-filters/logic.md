# Sidebar review filters

## Status & amendments
Status: Approved autonomously under docs/loop/LOOP.md night mode; one combined logic/technical specification.

**Amendments:** 2026-10-27: initial specification; self-reviewed against sidebar-extras.md review-filter flows and edge cases.

## Goal and conceptual model
Hide workspace rows by known review completion or successful checks, without fetching remote information just to filter. The existing sidebar-extras plugin owns client-local preferences and the canonical visibility projection; the worktree plugin renders it. Hosting owns review resolution and cache truth.

## Scope & non-goals
In scope: sidebar-extras.md Review filters flows 1–3, cached-data and stale-merged safeguards, filter badge, Clear filters, persistence and client isolation, scriptable API/CLI and mounted sidebar behavior.
Non-goals: all other sidebar-extras flows (already owned by M2), review pages/card decorations, fetching reviews on filter activation, adding providers that hosting does not yet implement, native window/menu changes. Other hosting providers can supply the same normalized cache projection when implemented; unknown providers stay visible.

## Data flow
Normal hosting lookups/refreshes populate hosting-owned cached workspace review facts. A new public cache-only read exposes the resolved review for a canonical workspace identity, or an explicit unknown/missing outcome. Sidebar projection reads this API only while a review toggle is active and intersects its result with activity visibility. Rendering consumes the projection's IDs; it never mutates canonical records or review state. Hosted lookup outcomes remain the single resolution source; filters never call a fetching lookup, auth probe or remote refresh.

## Key decisions & rationale
Recommended: extend existing extras projection and expose a narrow hosting cache-only read. This preserves scriptability and one visibility result for UI/API. Rejected: renderer-only filtering (CLI would disagree); calling forBranch while filtering (it fetches on misses and resolves auth); a second independently fetched review cache (duplicated resolution and invalidation).

## Decisions Locked
- **Layout/interactions:** two labelled off-by-default checkboxes in Workspace options > Filters: “Hide merged/closed reviews”, “Hide passing checks”. No inert Hide default branch control is added merely to copy source ordering.
- **Visibility:** completion hides merged or closed; passing hides only checksStatus success. With both enabled, either predicate can hide. The selected-workspace activity exemption does not override review filtering.
- **Unknown/error state:** no review, cache miss/expiry, unavailable hosting, folder workspace, changed workspace instance/branch/head or invalid cache data cannot hide a row by review. Ordinary read failures remain diagnosable in projection rows. Other independently active filters still apply.
- **Merged head safety:** a resolved merged review is usable only for the same current branch head or an already established current resolution from hosting. Never perform remote ancestry/commit queries during filtering. If the head changes after caching, retain the row until normal hosting resolves it again. This also prevents old successful checks from hiding new work.
- **Composition:** hiddenIds is the final combined list. hiddenCount remains activity-only; reviewHiddenIds separately records review-hidden rows, and reviewHiddenCount its size. A row rejected by both predicates appears once in final hiddenIds. Activity recovery widens activity only; Clear filters resets activity All and both review toggles off.
- **Badge/reporting:** each enabled review toggle adds one to filterCount, independently of matching row count; an active activity window adds one. Public UI reports include both flags and review hidden facts.
- **Persistence/isolation:** both flags are strict booleans; absent/corrupt stored values hydrate false. Invalid writes fail atomically. Per-client storage follows existing extras state; another client's writes do not change desktop state. No review data is persisted by extras.
- **Refresh/performance:** hosting changed/refresh events reproject active review filters; stale response guards remain. With both flags off there is no hosting cache call or hosting-event-driven projection churn. No new polling or fetch loop.
- **CLI/API:** existing sidebar-extras set gains hideCompletedReviewWorkspaces and hidePassingCheckWorkspaces and corresponding kebab-case flags. Existing output/error conventions remain. Hosting cache-only read gets generated CLI discovery.
- **Platform:** macOS build/test only; no new native-only scenario. Linux/Windows runtime validation is deferred, not claimed.

## Behavior & scenarios
### RF-01: Completed reviews
Before: two Git workspaces have normally cached reviews: A merged, B open/conflicting; no activity filter. Walkthrough: enable Hide merged/closed reviews through API, CLI or the UI checkbox. After: A hidden, B visible, badge1. Closed reviews behave like merged; open/draft do not. Parent child chip loses A when A is its only visible child; canonical lineage and deletion scope remain intact.

### RF-02: Passing checks
Before: cached reviews A success, B failure/conflicting, C pending, D neutral. Walkthrough: enable Hide passing checks alone. After: only A is review-hidden and badge1. Missing checks do not imply success.

### RF-03: Conservative unknowns and stale heads
Before: uncached workspace A, no-review B, unavailable C, merged-and-success D resolved for an earlier head, folder E. Walkthrough: enable both toggles. After: none is hidden by review; badge2. Populate A through a normal hosting lookup with current merged/success data: A then hides on the hosting event. Advance A's branch head or replace its instance: A becomes visible again without a filter-induced remote call. No calls to gh/auth/provider transport occur during cache reads.

### RF-04: Composition and clear
Before: activity Week active, an old row O and recent merged row M; both review toggles enabled. After: final hiddenIds contains O and M, hiddenCount counts only activity-hidden O, reviewHiddenIds contains M, badge3. Activity recovery sets All but retains review flags and M stays hidden. Clear filters sets All/off/off, reveals O and M, badge0. Each toggle can be independently disabled.

### RF-05: Persistence and local clients
Before: desktop and phone default off. Walkthrough: desktop enables one flag and phone enables the other; restart the isolated daemon. After: desktop and phone retain their independent flags; ordinary partial activity updates retain flags. Strings/null/numbers fail set without modifying either flag; absent/invalid persisted values hydrate false.

### RF-06: Failures, disabled providers and stale UI responses
Before: active filters and a known hidden row. Walkthrough: invalidate hosting cache via mutation/configuration, disable hosting, or advance branch/head. After: row is not hidden using invalid old data; cache read reports unknown/unavailable rather than fabricating success. UI refresh tickets cannot apply older projections after a newer toggle/identity change. Off/off ignores hosting cache churn. No new review fetch is triggered by toggling, projecting or clearing.

## Defects and acceptance coverage
The feature doc records no separately named review-filter defect. Its explicit safety regressions are RF-03 (empty/stale caches keep rows), RF-04 (correct badge and parent child visibility), and RF-06 (no fetch side effects or stale projection). Keep API/CLI scenarios against a real isolated daemon with controlled hosting provider responses, and mounted UI scenarios for actual controls/rows/reports. Every process fixture owns a fresh temporary HOME/QUIRKY_HOME and cleanup.

## Industry Insights
No external research swarm under night mode. Requirements: external sidebar-extras.md lines68–75,122–126,147; docs/roadmap.md M4 and locked plugin/scriptability rules. Existing hosting forBranch is cache-backed but not cache-only (pr-review.ts resolves/fetches on misses); a separate read-only cache projection is required.

## Deferred Ideas
None beyond named non-goals. No parity flow from this review-filter slice is deferred.

## Glossary
- Current review: normal hosting resolution bound to current canonical workspace instance, branch and head.
- Unknown: no usable cached result; not equivalent to no remote review.
- Activity hidden count: rows rejected by activity rules, unaffected by review-toggle matches.

## Technical decisions and contracts
### Public schemas
CONTRACT: sidebar-extras Preferences and SetPatch add boolean hideCompletedReviewWorkspaces and hidePassingCheckWorkspaces (optional in patch, required in returned preferences). Both default false. Every state/set/activate/projection/changed schema and CLI flag declaration must match.

CONTRACT: quirky.hosting/cachedReviews params {worktrees:string[]} (canonical selectors, bounded at1000); result {workspaces:CachedWorkspaceReview[]}. Each entry has worktreeId:string, instanceId:string, branch:string|null, headOid:string|null, review:{state:'open'|'draft'|'closed'|'merged',checksStatus:'neutral'|'pending'|'success'|'failure',headRefOid:string,number:number,url:string}|null, stale:boolean, error?:string. No fetching/provider/auth subprocess is allowed. Local canonical resolution and git reads are allowed for identity checks. Missing/stale review returns null with stale true for changed facts, false for an ordinary miss. Same normalized resolution as forBranch/review; never invent or independently query a review. Cache bounded/ephemeral and invalidated with hosting repository mutations/configuration/disposal; in-flight old generations cannot repopulate valid snapshots.

CONTRACT: sidebar-extras projection adds reviewHiddenIds:string[], reviewHiddenCount:number and workspace optional reviewReason:'completed'|'passing'|'unknown', reviewError?:string. Existing activity reason stays activity-specific. visibleIds/hiddenIds reflect intersection; hiddenCount remains activity-only. filterCount includes all three independent enabled filters. Hosting MethodNotFound is optional absence; other errors are reported, never interpreted as completed/passing.

### Ownership and seams
- Hosting component: src/pr-review.ts lookup cache resolution/capture, src/pr.ts public handler, env invalidation hook if necessary, cached-review-types.ts, manifest method/CLI, and hosting-owned cache tests. Reuse normalized Review and exact/branch precedence. No sibling plugin imports.
- Extras component: src/daemon/state.ts, projection.ts and optional review helper; main/manifest/cli; extras test/support files. Calls public hosting API only. No static hosting dependency forcing eager auth.
- Renderer component: quirky.worktree src/useSidebarActivity.ts, ActivityFilters.tsx, report.ts and corresponding sidebar tests. No private extras/hosting imports; hook uses public API/event contracts, existing error/ticket/identity behavior retained.
- Parent owns specification/decisions/README/integration and final smoke/review/landing. No protected loop files or inherited untracked paths may be changed.

### Verification
Implementers do not run checks mid-flight; parent runs owned targeted test files after barrier. Final night gate: bun scripts/suite.ts plugins/quirky.hosting plugins/quirky.sidebar-extras plugins/quirky.worktree; bun test scripts; bun run typecheck. Build bun run build. Real daemon/CLI smoke and one bounded web dogfood run target RF-01/RF-02/RF-04 controls and visibility using a fresh disposable home. No screenshots of Quirky are committed. Reviewer: OpenAI task implementers; Opus unavailable at actual probe, so verified Gemini cross-family fallback. Final one round, fix blocking findings, rerun affected proof; no speculative review rounds.

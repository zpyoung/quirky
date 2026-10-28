# GitHub Tasks, issues and Projects

Reader: implementers and reviewers — Decision: which visible and scriptable behavior must ship before this item lands.

## Status & amendments
Status: approved autonomously under LOOP.md night mode; technical decisions included below. Self-reviewed against hosting-ui.md sections1–4,6–8 and task-related section12.

**Amendments:** 2026-10-27: initial composite-scope specification; no separate tech.md or spec review under night mode. Source clarification: the original “add files” footer opens only the HTTP(S) image-URL picker (`GitHubMarkdownComposer.tsx:349–360`, `use-image-input.ts:31–72`), so SC13 removes an inferred binary-upload feature and labels the real URL action accurately. Public API growth: Project-origin detail reads use an authenticated project-item route rather than weakening ordinary configured-remote restrictions.

## Purpose and conceptual model
Tasks is a built-in plugin view over the existing GitHub hosting plugin. A repository selects an authenticated local source; an issue or pull request has a stable host/repository/kind/number identity; a Project contains views and independently addressable items. A workspace attachment links work without changing its forge identity. The daemon owns visible navigation, filters, selected repositories, page, open item/project/view, and drafts so API callers can drive what the window shows.

Reads paint retained data immediately and revalidate quietly. Writes show pending state, use the same public hosting methods as scripts, reconcile confirmed server data, and restore prior data on failure. Older requests cannot overwrite newer selections or confirmed writes. Errors retain useful data and expose a retry rather than silently becoming empty results.

## Scope and non-goals
All three assigned parts are included: GitHub Tasks lists, inline edits/checks/merge/workspace/settings; issue detail/creation and shared Markdown composer; Projects v2 picker/table/board/roadmap. Source requirements are hosting-ui.md sections1–4,6–8 and Tasks settings in12. Section7's Project Start path is included.

Non-goals: full PR detail/conversation/files/checks page (owned by another queue item), GitLab Tasks, Linear/Jira providers themselves, Checks sidebar, PR creation, PR sitter, source-control AI. Existing registry navigation can open a PR detail contribution when present; otherwise a PR row provides an explicit GitHub link rather than pretending issue detail is PR detail. No authentication/token entry or renderer shell execution.

## Decisions locked
- **Layout and density:** compact source band, mode/selection toolbar, presets/search/filters, accessible table, full-page issue detail; board and roadmap scroll within their pane. Context remains visible at narrow widths; action controls do not trigger row navigation.
- **Loading and errors:** initial loading differs from empty, no-source, unavailable, partial and stale-error; refresh never wipes usable data. Explicit retry and source guidance remain reachable.
- **Interaction:** keyboard-accessible rows and controls; source-defined Esc/Cmd+F/Cmd+Enter semantics, no default global Tasks shortcut; no global shortcut steals focus from an open modal.
- **Authentication:** use public hosting availability/identity/account binding; Projects use ambient login; unavailable sources explain installation/login and never masquerade as successful empty lists.
- **Paging and search:** source limits, query parsing and direct numbered provider pages; persisted sticky-all versus explicit selection; no accumulating earlier pages for a far jump.
- **Writes:** shared server mutation/confirmation guard, optimistic reversible changes and rollback; no duplicate mutation retry, generation protection, confirmed comments retained across stale detail reads.
- **Persistence:** durable task preferences and project pins/recent/view; per-window/session-only issue draft; no token or provider body stored in global user settings.
- **Boundaries:** public plugin API only; full CLI/API scripting for view commands and preferences. macOS verification; no claim of other-platform proof.

## Behavior and acceptance scenarios
Each numbered scenario is a required real-daemon API/CLI flow with behavioral assertions. UI scenarios additionally go through the visible web view once at the end. Tests use fresh HOME/QUIRKY_HOME, disposable repos, stateful gh fixture and owned-process teardown.

### Tasks frame and preferences
1. **SC01 — Open, source and close.** Given a registered git repo, opening Tasks through sidebar or generated command selects GitHub and shows Close, available provider controls and `GitHub · Local Mac · owner/repo`. Source choice persists; provider visibility cannot hide the final source. Missing tool/auth produces a disabled source and explanatory blocking notice, including retry/setup guidance. Close restores the prior view; Escape blurs inputs first and leaves menus/dialogs in control. Cmd+F focuses active list/project search.
   - **Screen states:** signed-in = source context and work; signed-out = authentication notice, not “No matching work”; no eligible repository = selection guidance.
2. **SC02 — Sticky and explicit repositories.** Given repos Alpha/Beta, sticky-all includes both and later-added Gamma; explicit Alpha remains Alpha; an incoming Beta deep-link temporarily wins. Only git repositories with paths appear. Opening GitHub is disabled for multi-selection. Persisted preferences survive daemon restart.
   - **Data before:** **Selection** all; **Repositories** Alpha, Beta.
   - **Walkthrough:** add Gamma; choose Alpha; deep-link Beta.
   - **Data after:** **Selection** explicit Alpha remains stored; visible deep-link target Beta; all formerly included Gamma.
3. **SC03 — Presets, search and filters.** Issues offer Open/Assigned; PRs Open/Mine/Needs review. Preset context action persists the default. Search commits Enter or750ms idle; Clear restores kind default. Status/author/labels/assignee and PR requested/reviewed-by filters have removable pills/count and clear-all. Draft-only forces open draft PR. Free logins/quoted free text survive, repo qualifiers are stripped, absent kind is added, >8KiB is rejected without a provider request.
   - **Screen states:** `label:"needs triage" author:@me` remains a valid combined query; switching Issues to PRs never leaves an issue-only kind filter active.
4. **SC04 — Direct pagination and list restore.** Per-repo limit=max(1,min(36,floor(100/repoCount))), total pages=max per-repo count pages capped by1000 results; count failure uses full-page continuation. A jump to page10 requests API page10 only. Previous/Next/number ellipses and loading disable competing navigation. Returning from detail restores context-matching page/scroll; changed context resets page1.
   - **Data before:** **List** page1, ten pages.
   - **Walkthrough:** select10; open issue; go back.
   - **Data after:** **List** page10 and prior position; fixture log contains no page2–9 fetches.
5. **SC05 — Source and list states.** Distinct upstream/origin offers explicit persisted issue source; default upstream; PR target unchanged. No remote, no selected source, zero matches, full outage, partial repo failure and per-source error each have accurate copy/retry. Initial loading shows shimmer, stale refresh preserves rows. Old source responses cannot appear after a source flip.
   - **Screen states:** one failing repo plus one successful repo shows successful rows and partial warning; an outage is never presented as zero matches.
6. **SC06 — Accessible rows and checks.** Issue columns ID/title-context/assignees/status/updated/actions; PR columns ID/title-context/reviewers/checks/merge/updated/actions. Sticky ID/title; author fallback, repo/labels/workspace/draft/state/delta context; relative updated with absolute tooltip. Click/Enter/Space opens the appropriate target; controls stop propagation. First20 PR checks load eagerly, later on visibility/hover/focus; statuses distinguish pending/failing/passed/neutral/no-checks. A check click navigates the shared PR checks target where available.
   - **Screen states:** a pending check cannot be green; absent checks do not imply merge eligibility.
7. **SC07 — Inline issue status and assignees.** Open, close-completed/not-planned/duplicate and reopen update the same issue identity. Duplicate target must be positive whole different issue in the same repo. Assignees come from the issue source, and failures restore earlier values with visible error. Filter-exiting rows retain soft-hidden/pending disposition until deliberate refresh; stale search data cannot resurrect the old status during bounded quiet adoption.
   - **Data before:** **Issue7** open, assignee alex.
   - **Walkthrough:** close as duplicate7 (reject), duplicate8 (save), simulate assignee failure.
   - **Data after:** **Issue7** closed duplicate8; assignee alex; error visible.
8. **SC08 — Reviewers and guarded merge.** Reviewer picker splits comma/space logins, strips@, caps15 and2KiB, supports add/remove and restores on failure. Merge presentation follows server metadata precedence; method confirm shows target/method and uses the shared expected-head guarded destructive seam. Failed/stale-head merge shows error, never a merged row. Auto-merge/queue enable/disable honor server capability and explicit outcomes; queued is not merged.
   - **Data before:** **PR12** open at headA.
   - **Walkthrough:** confirm squash while upstream advances headB.
   - **Data after:** **PR12** stays open; stale-head error and fresh state; no unguarded merge.
9. **SC09 — Start or Resume work.** Issue/PR row or header Start opens the existing workspace creation flow with exact repository, item identity/context and title prefilled. Existing attachment changes to Open/Resume and activates that workspace; Start new bypasses attachment reuse. Failure names the action, and no unrelated workspace is activated.
   - **Data before:** **Issue7** linked to workspace W7.
   - **Walkthrough:** choose Open; then Start new.
   - **Data after:** **Active workspace** W7 first; fresh composer still links Issue7.
10. **SC10 — Task settings.** Sidebar show/hide/restore, provider visibility/default, preset and repo selection, project pins/recent/last view are scriptable and durable. Integrations show actual public CLI availability and actionable install/login/recheck guidance. Existing repository GitHub account binding remains honored, not duplicated with token entry.
   - **Screen states:** hiding sidebar Tasks never removes the command/API route used to restore it.

### Issue detail and creation
11. **SC11 — Issue navigation and read.** Opening issue from list or Project shows Back to correct origin, host/repo/number, copy and external link actions, title/state/author/updated/source/attached workspace, primary Start/Open and edit strip. Readable description, Activity timeline, comments and writable controls reflect server capability. Cached content remains on refresh failure; uncached failure has Retry.
   - **Screen states:** a Project item outside registered repos has a slug-addressed preview and explicit repository/start guidance, not a mismatched local issue.
12. **SC12 — Edit issue fields and body.** Status shares SC07 validation. Workspace linkage, labels and assignees edit through public API and update both open issue and retained list/Project rows. Read-only descriptions cannot be edited. Save body updates confirmed content; failure preserves draft and restores cached data.
   - **Data before:** **Issue7** label bug, body old.
   - **Walkthrough:** add triage; save body new; fail next save.
   - **Data after:** **Issue7** labels bug/triage, body new; failed draft remains available.
13. **SC13 — Markdown and comments.** Shared composer has Write/Preview, empty preview copy, safe rendered Markdown, HTTP(S)-only image URL insertion (8KiB max) through a clearly labelled picker and URL paste/drop, keyboard submit and bounded comments. Binary file drops report that an image URL is required and never silently discard draft text or claim an upload. Post success shows comment immediately and retains it if a lagging read omits it; failure retains text and shows error. Timeline distinguishes comment/assignment/closure events. Raw HTML or script/data links never execute.
   - **Data before:** **Comments** one; composer `hello **team**`.
   - **Walkthrough:** preview, submit, receive stale detail.
   - **Data after:** **Comments** two with rendered new comment; composer empty only after success.
14. **SC14 — New issue session draft.** Dialog targets first selected repo, explicit repo picker when multiple, issue-source control, required title, optional Markdown, scoped labels/assignees and submit hint. Cancel/reopen restores current-session draft; repo switch clears label/assignee IDs. Title Enter/Cmd+Enter creates exactly once; blank title/no repo disables. Success opens created issue immediately, refreshes list, clears draft. Body-save warning clears title but keeps body to avoid duplicate creation. Full daemon/window-session restart does not resurrect session-only draft.
   - **Data before:** **Draft** title Repair parser, body details, repo Alpha, label bug.
   - **Walkthrough:** cancel/reopen; switch Beta; create.
   - **Data after:** **Created issue** Beta with no Alpha-only label; opened detail; successful draft empty.

### Projects v2
15. **SC15 — Project discovery and identity.** Projects empty prompts Choose a project. Picker includes pinned/recent(max10)/browse/search, add owner/number or org/user URL with optional view, trusted enterprise hosts, pin/remove. Missing-scope/auth has copyable host-correct refresh/login, exported-token and SAML guidance, Reload/Docs. Partial discovery suggests pasted URL. New selection without remembered view chooses a view; unsupported layouts are disabled and explained. Browse cache bounded32/5min.
   - **Screen states:** `https://github.example/orgs/team/projects/3/views/4` preserves host and view; a scope error is not “No projects.”
16. **SC16 — View navigation and query.** Table/board/roadmap tabs and last view persist per project identity. Toolbar has search applying Enter/blur, Esc revert, unapplied indicator, per-view override, item count, external view link and Refresh. Switching views never adopts older-view reads.
   - **Data before:** **ViewA** filter is:open; **ViewB** no override.
   - **Walkthrough:** apply assignee:@me toA; switchB; backA.
   - **Data after:** **ViewA** override retained; **ViewB** unchanged.
17. **SC17 — Project table projection.** View fields plus synthetic Type after Title; first two frozen; local sort ASC/DESC/server order, stable server-position tiebreak. Configure columns cannot hide Title; per-device hide/width preferences(min60); group by saved first field, option/iteration order, unassigned last, collapse, iteration dates/current badge.
   - **Screen states:** hiding Assignees does not remove its server field or change GitHub's saved view; same-valued rows keep server order.
18. **SC18 — Inline Project fields.** Editable select/iteration/text/number/date/assignees/labels/issue type use typed update/clear and correct issue source/ambient project authorization. Repository/parent fields read-only; draft/restricted not editable. Optimistic table/board/detail patches reconcile or rollback and display partial writes accurately. Existing API limitation for user-owned project issue types is explicit, not a fake success.
   - **Data before:** **ItemI7** Status Todo, estimate3.
   - **Walkthrough:** change Status Done; invalid numeric text; clear estimate.
   - **Data after:** **ItemI7** Status Done, estimate empty; invalid number never written.
19. **SC19 — Project item open and Start work.** Registered match opens issue/appropriate PR target; unknown repo offers preview plus Add repo/Open GitHub, ambiguous/excluded/updating matches explain why Start cannot run. Direct Start creates workspace, launches default detected agent, and pastes context after readiness. Ask setup policy/no agent/unknown repo falls back to real composer, without duplicate creation.
   - **Data before:** **Project issue7** known repo, no workspace.
   - **Walkthrough:** Start work using detected default agent.
   - **Data after:** **Workspace** exact repo/item; **Agent session** item context delivered once after ready.
20. **SC20 — Board movement.** Group field precedence vertical select/iteration, named Status, first select; 272px columns per option/iteration plus read-only deleted values and No-field bucket. Cards show title/type/number/repo/three avatars. Drag between valid columns updates/clears field; restricted/draft/read-only reject. Failure returns card and shows error. No usable field falls back to table with explanation; accessible equivalent move control required.
   - **Data before:** **CardI7** Todo.
   - **Walkthrough:** move Done, then No Status; failed move Todo.
   - **Data after:** **CardI7** unassigned, error visible, no false Todo.
21. **SC21 — Roadmap placement.** Infer start/target by documented name patterns, first two dates, iteration, then date marker. Month/Quarter/Year zoom persists per device; Today reachable, placed-by field and undated count visible, <=480ticks even absurd dates. No date/iteration falls back with explanation. Invalid dates never explode range or drop accessible item actions.
   - **Screen states:** Jan1–Jan14 item has a bar; lone Jan8 has a marker; no date increments undated and remains discoverable.
22. **SC22 — Project errors and bounds.** Distinguish auth/scope, too-large, unsupported layout, not-found, schema-drift and generic failures, each with actionable retry/open URL. Retain stale data on transient failure. Restricted content stays restricted; sub-issue permission warning appears once. Empty with filter differs from no items/recent indexing.
   - **Screen states:** too_large shows limit/narrow-filter instruction, never tries to render an unbounded table.

### Defect and seam regressions
23. **SC23 — No stale mutation overwrite.** Slow old reads, source flips, view flips, rapid edits and stale search index cannot replace newer state. Failed earlier mutation must not undo a later successful mutation. Confirmed partial write reports completed steps and retains actual provider state, not an all-or-nothing fiction.
   - **Data before:** **Issue7** open; first read pending.
   - **Walkthrough:** close issue; old read resolves open.
   - **Data after:** **Issue7** remains closed until authoritative reconciliation, never reverted by old read.
24. **SC24 — Scriptable view parity.** API/CLI discovery lists all Tasks commands and schemas. API actions drive open/close/mode/repos/query/page/detail/dialog/project/view/settings and daemon UI state reports exact resulting view; no renderer-only user action exists. Disabled plugin removes its own view/commands without disabling hosting API. Scripts still work with no UI attached, except explicitly routed OS clipboard/browser actions which return a delivery error when no window exists.
   - **Data before:** **Visible Tasks state** Issues/page1.
   - **Walkthrough:** generated CLI selects PRs/page3; UI reads state.
   - **Data after:** **Visible Tasks state** PRs/page3 in daemon and window.
25. **SC25 — Native handoff, safe links and scoped defects.** Copy-link failures are visible rather than false success; external links retain exact HTTP(S) identity and source. Context chip never disappears silently. Listed defects relevant to this scope (missing context, incomplete list merge metadata, stale checks, silent error/optimistic loss) have behavioral regressions. Status-only rerun is a PR-detail/API-owned defect and unchanged here. Real clipboard/system browser/OS focus effects remain pending native scenarios; web evidence proves only controls and delivery.
   - **Screen states:** no shell means explicit clipboard unavailable; invalid image javascript URL is rejected; no native-copy claim from a headless screenshot.

## Essential coverage and design rationale
Consumer: local developers and agents replacing Orca. Outcome: browse/edit/create GitHub work and Projects without leaving Quirky. Boundary: registered source identities and public hosting policy, not raw gh forwarding. Success: every scenario above exercises daemon API or CLI, then visible web goals pass. Failures: explicit typed errors, rollback/stale preservation, no swallowed mutation. Constraints: plugin-only, bounded data, isolated state, no asks and macOS-only build.

Alternatives: shell-owned Tasks couples all features to core; full Orca port retains Electron and remote runtime branches. Chosen plugin with focused vertical slices reuses the public API and allows replacement without a second auth/cache/merge policy.

## Industry insights
LOOP.md explicitly replaces research swarms with feature docs, roadmap and earlier logs. The source's stale-write ownership, provider-qualified cache keys and direct page loading are correctness requirements, not optional performance embellishments. Binding dependency decisions: m4-hosting-api-github D6/D9/D17/D19/D33/D34/D38; user-project issue-type limitation must remain explicit until its queued API parity item resolves it.

## Deferred ideas
None added. Non-goals remain assigned elsewhere. Any unavailable in-scope integration is recorded under LOOP.md's explicit defer/follow-up process, never silently removed from this specification.

## Glossary
- **Source:** authenticated host/repository identity chosen by hosting resolution.
- **Sticky all:** null saved selection, including future eligible repositories.
- **Quiet adoption:** retain confirmed optimistic state while lagging search catches up within bounded attempts.
- **Project view:** saved table/board/roadmap with fields/filter/grouping.
- **Restricted item:** provider-hidden content, never editable or inferred.

## Technical decisions and contracts
Implementation contracts are committed in `plugins/quirky.tasks/src/contracts.ts` before workers start. `quirky.tasks` is the replaceable UI feature plugin; `quirky.hosting` remains the canonical provider API plugin. Parent owns `main.ts`, `src/ui.tsx`, `src/contracts.ts`, `src/env.ts`, `quirky-plugin.json`, package/build integration and shared test helpers. Three disjoint owners own `src/list/` plus `test/list.test.ts`, `src/issue/` plus `test/issue.test.ts`, and `src/projects/` plus `test/projects.test.ts`. Each exports `listMethods`, `issueMethods`, or `projectMethods` from its `methods.ts`, returning `TaskMethodTable`. Components export `TasksList`, `IssueSurface`, `NewIssueDialog`, and `ProjectsSurface` with `TasksSurfaceProps`. `TasksEnv.update` is synchronous/atomic, persists preferences/project preferences/workspace links only, increments revision and emits `changed`; issue drafts/navigation remain daemon-session-only. `navigate` updates the daemon-owned layout input. All slices use public `context.call` and shared contracts, never private hosting imports. Workers may add their own internal modules/styles/tests but never modify another slice or parent-owned files. Parent assembles method declarations after each owner reports exact names/schemas, preserving CLI discovery. Existing hosting identity, error envelopes, destructive merge and Project authorization remain canonical.

`quirky.hosting/projectItemDetails({worktree?,projectId,itemId,host?})` returns the existing bounded detail shape (`item`, `comments`, `participants`, `timeline`, `partialFailures`, `truncated`; PR detail may additionally contain files/checks). It validates project membership and exact content identity with the existing Project context resolver, then preserves ambient/trusted-host routing on every internal REST/GraphQL/CLI read. Normal work-item references remain configured-remote restricted. The shared bounded detail loader is reused, not copied. Parent owns the hosting manifest, detail loader seam, Project method implementation and `test/project-details.test.ts`; sibling slices do not edit those files.

Project iteration reads include actual `ProjectV2IterationField.configuration` completed/active options and `ProjectV2ItemFieldIterationValue` identity/title/start/duration. The public normalized field exposes ordered `options` with dates and completion state; row values expose `{iterationId,title,startDate?,duration?}`. Missing intervals remain undated. No fixture-only fabricated iteration values.

Boolean setting contributions may declare `menu: "view"`. The public `SettingDeclaration`/setting schemas and manifest validator expose this optional metadata; existing declarations remain unchanged. The native shell derives checked View items from effective `setting.list` results, refetches after plugin/setting changes, and toggles through fresh `setting.get` then `setting.set`. Tasks declares its visibility switch this way, without core knowledge of a Tasks plugin ID. Standard native app/Edit/Window roles remain present. Parent owns these protocol/daemon/desktop seams and their real-daemon regression.



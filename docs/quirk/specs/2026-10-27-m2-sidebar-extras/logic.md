# Sidebar extras

Reader: builders and operator review — Decision: implement the four M2 additions without changing workspace execution ownership.

## Purpose

A sidebar is a presentation of existing workspaces, not another workspace registry. A Git worktree may appear under a project group independently of its repository. Git, terminals and agents continue to use the same repository and path. Activity windows hide rows without archiving or deleting them. Source Control gets an active-worktree dirty indication, and top-level sidebar boundaries get optional hairlines.

## Data flow

Canonical repository/group and worktree APIs supply identity, membership and activity. The built-in sidebar-extras plugin owns client-local presentation preferences and visit/departure recency, computes visibility, and exposes its API/CLI. The existing worktree sidebar renders that projection through public methods, preserving its row/menu pipeline. Source Control status supplies the dirty count; a public activity-item slot draws its icon even while the panel is closed. Observable state is readable through the API and `quirky ui state`.

## Key decisions & rationale

- Keep repository/group lifecycle in `quirky.repo` and workspace metadata in `quirky.worktree`; a thin `quirky.sidebar-extras` built-in owns only presentation policy. This avoids duplicate domain data and a whole-sidebar fork.
- Preserve `m0-ui-api` D10: panels remain in the right column, one open at a time, with their existing main-header toggles. Add a Source Control activity item, not a replacement activity-bar/container navigation model. The public API may grow for this feature.
- Keep filtering in one visibility pass. Hidden rows remain available for lineage and execution, and users can recover with the hidden-count action.
- Do not implement review filtering before M4 or ledger navigation before the M5 ledger feature. Do not introduce SSH/WSL hosts, mixed-version synchronization, or mobile transports in this item; existing partial writes must nevertheless preserve membership, and client preferences remain isolated.

## Decisions Locked

### Membership and organization

- Cross-repo membership is nullable `projectGroupId`, distinct from group-hosted folder workspace `groupId` and lineage `parentId`.
- New-group action affects only the selected eligible worktree, with selected default name “<display name> group”. Current membership is disabled in the target submenu. Git cards also offer Move project to group when groups exist; folder rows expose only project-level actions instead.
- Menu and drag are equivalent. A group-header hit wins over a leave target, current-group drop does nothing, and only the row's owning project is a valid leave target. Drag membership is enabled only in Project grouping.
- Loose rows render directly under the group, before repo sections, with repo identity. A moved parent leaves its child flat in the repo; returning restores nesting. Empty owning repos remain placeholders. Missing/unrendered groups do not erase membership.
- Group deletion clears member references across its subtree but preserves Git worktrees and metadata. Parent cycles/missing parents are normalized so every group is renderable. A delayed create-then-assign must not overwrite replacement identity or newer membership.

### Activity and client state

- Windows: All (default), Live only, Past 24 hours, Past 7 days, Past 30 days, Custom. Day windows are rolling durations, inclusive at the cutoff, not calendar dates.
- Activity=max(workspace activity, last visit, last departure), falling back to creation then repository addition. Departure stamps are session-lived and separate from visit ordering. Quiet lists reevaluate at least every 60 seconds.
- Open workspace is always retained. Live only has an Except default branch switch, default on. Sleeping derives from terminal/agent workspace liveness, not recency or whether an agent is currently busy. Unknown/unavailable runtime liveness conservatively retains the row and reports the unavailable source instead of claiming it is live.
- Custom days defaults to 30; digits and positive safe integer only. Enter or blur commits. Invalid input keeps the stored value and shows “Enter a positive whole number.” This fixes the recorded Tab/blur discrepancy rather than preserving it.
- A selected non-All window counts as one filter. Hidden count includes Git and folder rows hidden by activity only. Clicking the count or Clear filters selects All. Preferences survive restart and are client-local; remember the pre-Live window so toggling sleeping off/on returns to it, while legacy hide/show sleeping cannot silently widen another time window.

### Dirty marker and separators

- Dirty marker counts Source Control panel entries, including separately staged/unstaged rows for the same path, excluding lazy submodule children. Dirty active worktree shows a dot plus “Source Control — N uncommitted change(s)”; capped count says “N+”. Color is never the only signal.
- No active workspace, clean workspace, unknown status or a background dirty workspace does not decorate the tab. Switching workspaces invalidates old responses. Refresh works with the Source Control panel closed.
- Settings > Appearance > Window & Sidebar contains default-on Sidebar section separators, described as “Show divider lines between top-level projects and groups.” Hairlines do not change geometry. Exclude first header, headers after host headers, active sticky headers and nested group headers.

### Surfaces and autonomous approval

- Every mutation and view action is scriptable using declared schemas and generated CLI; every rendered state has JSON readback. Invalid requests do not mutate stored state, omission never clears membership, and existing error/selector/confirmation conventions apply.
- LOOP.md supplies autonomous defaults and approval in lieu of human questions. The design is accepted under those rules, subject to the mandatory spec review. Implementation does not begin before both specs are committed and reviewed.

## Behavior & scenarios

Each scenario is an acceptance criterion. API/CLI tests must drive real daemon/plugin dispatch; UI scenarios also run against the built web app in an isolated home. Assertions inspect outcomes, not source strings or mocked forwarding. Shared names in examples refer to fresh temporary fixtures.

### SC-01: Create a group from one worktree

Before: Git project `api` contains `fix` and `other`, neither grouped. Walkthrough: right-click `fix`, choose New group from worktree; New Project Group dialog selects `fix group`, offers Cancel/Create, and explains only this worktree moves. Cancel changes nothing; reopen, name Team, Create. After: Team contains only `fix` with `api` chip; `api` keeps `other`; repository identity/path/lineage and execution remain unchanged. Equivalent CLI creates and assigns through the same guarded operation.

### SC-02: Add, move and remove membership

Before: groups Team and Release, `fix` in Team. Walkthrough: Add worktree to group disables Team; choose Release, then Remove worktree from group; with a group present, use Move project to group on a Git card and verify its repo moves as a whole independently of loose membership. After: loose membership moves to Release then null, persists across restart, and unrelated metadata remains unchanged. A set request omitting membership, including a mobile-shaped partial metadata edit, preserves it.

### SC-03: Parent/child placement and empty projects

Before: parent `fix` and child `docs` are nested in `api`. Walkthrough: group only `fix`; remove it to verify nesting restoration. In a separate fixture group every visible row to verify empty-project retention, then explicitly return both `fix` and `docs`. After each step: child stays flat in its repo while parent is elsewhere; returning parent while child is repo-owned restores nesting and child count; repo remains as an empty placeholder once all rows are diverted. Group folder rows precede loose Git rows, which precede repo sections.

### SC-04: Drag join and leave

Before: Project grouping, ungrouped `fix`, rendered Team header. Walkthrough: drag to Team, to Team again, then to own repo section; overlap a header and leave target, and attempt an unrelated repo. After: assignment, no-op, removal respectively; header wins overlap; unrelated repo does not remove membership; hovered header highlights and clears after drop/cancel. API/CLI membership outcomes match drag.

### SC-05: Group header actions and subtree deletion

Before: Team has a nested group Child, repos and loose worktrees in both. Walkthrough: hover header, collapse/expand, use ellipsis Rename group then Delete group; right-click does not open a second menu. Delete Project Group dialog names the group, shows Ledger records retained / No affected ledgers., Cancel and Delete Group. Cancel preserves state; confirm deletes the subtree and releases worktrees to repos. After: no deleted group membership remains; Git folders, registrations and worktree metadata survive. Ledger navigation is explicitly excluded until M5.

### SC-06: Membership guards and corrupted group parents

Before: folder project/workspace, group-folder workspace, missing group reference, and stored parent cycle. Walkthrough: inspect menus/drag gates; attempt API assignment to folders; load groups. After: folders expose project actions and reject worktree membership instead of reverting silently; missing group member falls back to its repo without clearing its stored reference; cycle/self/missing parent edges are repaired deterministically so all groups remain reachable. New cycle writes refuse without mutation.

### SC-07: Async identity and concurrent regroup protection

Before: `fix` has instance A and no membership; group creation is delayed. Walkthrough: separately delete/replace the worktree at the same path (including a filesystem reporting zero birthtime), or assign it to another group, before creation finishes. After: stale create never assigns the replacement or overwrites newer membership. The new group may remain empty; the caller gets an explicit stale-assignment result, not a misleading move success.

### SC-08: Activity window controls, badge and clear

Before: Workspace options closed; All. Walkthrough: open Filters and select each of six windows; choose Custom; use Clear filters. After: selected value and default custom 30 are shown; badge is one for any non-All window and zero for All; Clear restores All. API and generated CLI can read/change the same state.

### SC-09: Rolling time cutoffs and fallbacks

Before: active `open` is old; non-active rows have activity exactly at cutoff, one millisecond older, recent visit, recent departure, creation-only, or repository-added-only fallback. Walkthrough: select each time window with deterministic time in tests. After: inclusive boundary/recent/fresh fallback rows stay; older rows hide; `open` stays. Both Git and folder workspaces follow time windows. Changing the clock past cutoff without other state changes hides quiet rows within 60 seconds.

### SC-10: Live only and default-branch exception

Before: one workspace has live terminal/agent state, one is sleeping, one has unknown runtime liveness, default workspace is sleeping, and sleeping `open` is selected. Walkthrough: choose Live only, then disable Except default branch. After: live and selected rows stay; unknown stays with its unavailable source reported; ordinary sleeper hides; main stays only with exception on. Agent idle versus working alone does not decide sleeping. Folder rows bypass this sleeping sweep but still obey time windows.

### SC-11: Custom validation fixes blur behavior

Before: Custom 30. Walkthrough: enter 0, -1, 1.5, text, an unsafe integer; press Enter or blur via Tab; then enter 3 and commit. After each invalid input: inline positive-whole-number error, stored 30 unchanged, no invalid filter commit. After 3: error clears, cutoff uses three days. Direct invalid API values reject; corrupt persisted values hydrate to 30.

### SC-12: Hidden-count recovery and lineage

Before: old Git and folder rows fail activity, while an unrelated ordinary filter hides another row. Walkthrough: apply recent window, inspect list/count, click hidden count. After: count includes only rows hidden by activity, retained descendants do not corrupt lineage, count remains reachable in an otherwise empty filtered list, click restores All without changing other filters or membership.

### SC-13: Recency, restart and client isolation

Before: old workspace A open, B next, independent clients desktop and phone. Walkthrough: switch A→B; read stamps and visit ordering; restart daemon; reload preferences; change phone filter; from week toggle sleeping off/on; apply legacy hide/show sleeping patches. After: A's departure makes it recent without moving it ahead in visit ordering; departure stamps do not survive session restart; preferences do; phone changes do not clobber desktop; hide=true selects Live only, show=true restores the remembered week/custom selection, and a bare show=true while already on week/custom never widens it.

### SC-14: Active dirty marker including count boundaries

Before: active clean Git `fix`, dirty background `other`. Walkthrough: externally edit active file; stage and modify same path; add untracked file; inspect Source Control activity item title/accessibility and `ui state`; clean active. After: background alone gives no dot; counts match panel rows; singular/plural labels are correct; staged+unstaged counts twice; clean removes decoration. Capped snapshot renders N+ and missing status does not fabricate a dirty state. Expanded submodule children do not inflate count.

### SC-15: Dirty marker refresh and workspace switch races

Before: panel closed, active `fix`. Walkthrough: edit disk; wait existing status refresh; switch to clean `other` before delayed `fix` status resolves; remove active selection; disable/re-enable relevant plugin. After: closed-panel activity item still updates; old response never decorates `other`; no active clears it; disabled contributions unmount without orphan timers, and ordinary status errors surface without stale dirty state.

### SC-16: Appearance separators without geometry changes

Before: top-level groups/projects, nested group, pinned/sticky header. Walkthrough: Settings > Appearance > Window & Sidebar, toggle Sidebar section separators off/on and reload; inspect row geometry and eligible boundaries. After: default/on hairlines match exceptions, off removes them, setting persists and CLI setting.set does the same; row heights and drop targets are unchanged. Host-specific exception is covered by pure projection tests; no remote host transport is added.

### SC-17: Public plugin and scripting contracts

Before: stock built-ins and a replacement contribution/distro. Walkthrough: discover `quirky api --json`, run sidebar-extras commands, change view controls through API, override/disable extras contributions. After: schemas and commands describe real behavior; UI state matches the displayed projection, preferences, activity item and dialogs; disabled extras does not prevent core worktree/git operation; installed overrides use public APIs only; header panel toggles, right-column placement and one-panel selection remain intact.

## Recorded Orca defects and regression evidence

- SC-11 tests the observed Tab/blur validation discrepancy: Quirky commits or validates on blur as documented, instead of silently doing neither.
- SC-06 tests folder membership silent-revert protection; SC-07 tests stale asynchronous assignment; SC-06 tests group-parent cycle repair. The source documents these as avoided hazards rather than confirmed failing app flows; keep them as invariant regressions, not claims that Orca currently fails them.
- Unexercised source flows (drag, hidden old rows, restart, pairing-local state) are still requirements and are exercised here; a source verification gap is not permission to omit behavior.

## Scope & non-goals

All seventeen scenarios are in scope. Excluded: M4 review filters and hosted-review caches; M5 Open ledger navigation and ledger implementation; full stock workspace grouping/sorting/card-layout options not needed for this slice (M7 parity sweep); SSH/WSL and cross-host labels/transport/mixed-version protocol; mobile transport implementation; unrelated sleep/wake actions and OS window behavior. Project grouping remains the mode in which membership drag operates; a mode guard must reject other groupings if present. No screenshot requirement or native-only scenario is introduced.

## Industry Insights

- [Apple sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): shallow labeled hierarchy and disclosure controls support loose rows rather than moving repository ownership.
- [React derived data](https://react.dev/learn/you-might-not-need-an-effect): compute visibility from canonical data, not an effect-maintained second workspace list.
- [Git worktrees](https://git-scm.com/docs/git-worktree): each linked worktree still belongs to its repository regardless of presentation grouping.
- [MDN point hit testing](https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint): live viewport geometry determines drag targets.
- [VS Code tree views](https://code.visualstudio.com/api/extension-guides/tree-view) and [Backstage overrides](https://backstage.io/docs/frontend-system/architecture/extension-overrides/): explicit contributions and contextual actions avoid private DOM coupling; a separate presentation owner need not duplicate entity storage.

## Deferred Ideas

Only [tech-spec] questions remain: exact method/schema names, client keys, activity persistence/event hooks, cross-store group deletion ordering, public activity-item/settings category schema and test topology. Review filtering and ledger navigation remain with their roadmap owners, not new queue items.

## Glossary

- Loose worktree: Git workspace displayed directly in a group independently of its repo.
- Project group: sidebar grouping entity, optionally nested; not a Git repository.
- Group-folder workspace: folder workspace rooted at a scanned group's parent folder; `groupId` is location identity, not loose membership.
- Sleeping: workspace without the active terminal/agent state used by the shared sleeping rule; not the same as an idle agent.
- Client-local: persisted preferences keyed to one client, not overwritten by another client.
- Activity item: public right-sidebar icon surface associated with Source Control; not a replacement panel/container model.

## Status & amendments

Status: Accepted autonomously after the mandatory Codex spec review; confirmed findings amended. Tech spec required by LOOP.md and cross-subsystem/file-count complexity.

**Amendments:** 2026-10-27 — correct SC-03 fixture sequence; define unknown-liveness retention/reporting and zero-birthtime replacement protection; restore remembered pre-Live window and Git-card project move. Rename the purpose heading for deterministic coverage. Review/adjudication evidence is in the item decision log.

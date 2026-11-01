# Tasks compact and expanded: tech spec

**Status:** Draft  
**Logic spec:** [logic.md](logic.md). Behavior and rationale live there; this file says where to work and what must hold.

## Architecture

Back-link: [Tasks is in one of three places](logic.md#tasks-is-in-one-of-three-places), [Data flow](logic.md#data-flow).

Two mounts, one state. The tool slot mounts the compact panel and the center tab mounts the expanded view, each from its own contribution ID, so neither has to guess where it is.

| Layer | Owns | Files |
|---|---|---|
| Daemon layout | "A tool has an expanded view": the panel and tab are never both open; `ui.tool.open` and `ui.view.open` enforce it | `packages/daemon/src/plugins/layout.ts`, `packages/daemon/src/plugins/tool-layout.ts`, `packages/protocol/src/tool-slots.ts`, `packages/protocol/src/kernel-schemas.ts` |
| Tasks daemon | Navigation state, the `open` and `close` entry rules, counts | `plugins/quirky.tasks/src/env.ts`, `plugins/quirky.tasks/src/contracts.ts`, `plugins/quirky.tasks/src/list/methods.ts`, `plugins/quirky.tasks/quirky-plugin.json` |
| Row model | Pure parsing and row status, shared by both forms | `plugins/quirky.tasks/src/list/model.ts`, `plugins/quirky.tasks/src/list/row-status.ts` (new) |
| Compact panel | The slot mount | `plugins/quirky.tasks/src/list/CompactTasks.tsx`, `plugins/quirky.tasks/src/list/useCompactList.ts`, `plugins/quirky.tasks/src/list/useAgentActivity.ts` (new) |
| Expanded view | The center mount: list beside detail | `plugins/quirky.tasks/src/list/TasksList.tsx`, `plugins/quirky.tasks/src/list/PrDetail.tsx` (new), `plugins/quirky.tasks/src/issue/IssueSurface.tsx`, `plugins/quirky.tasks/src/ui.tsx` |
| Place memory | Scroll position and focus target that survive a mount change | `plugins/quirky.tasks/src/list/place.ts` (new) |
| Styles and icons | Semantic layouts, the Collapse icon | `packages/ui/src/design-system/tasks-compact.css` (new), `tasks-list.css`, `styles.css`, `scripts/gen-icons.ts`, `packages/ui/src/design-system/icons/generated-controls.ts` |

Tech stack: Bun, React 19 with `createRoot` per mount, `@quirky/ui` shared components, the plugin manifest in `quirky-plugin.json`, tests with `bun:test` and happy-dom.

## Code references

| Symbol | Location | Change |
|---|---|---|
| `RULES`, `TASKS`, `TASKS_VIEW` | `packages/daemon/src/plugins/tool-layout.ts:17,27,74` | Tasks rule: drop `body: TASKS_VIEW`, add `expandedView: TASKS_VIEW` |
| `projectTools` | `packages/daemon/src/plugins/tool-layout.ts:124` | Copy `expandedView` onto the entry; the Tasks tool's `contributionId` becomes `TASKS` |
| `UiToolEntry` | `packages/protocol/src/tool-slots.ts:11` | Add optional `expandedView?: string` |
| tool entry schema | `packages/protocol/src/kernel-schemas.ts:190` | Add the optional property; update the `ui.tool.open` and `ui.view.open` descriptions at `:596` and `:616`, including `ui.tool.open`'s stale claim that it toggles |
| `LayoutService.openTool` | `packages/daemon/src/plugins/layout.ts:655` | Apply the [layout contract](#layout-contract) |
| `LayoutService.openView`, `openWindowView` | `packages/daemon/src/plugins/layout.ts:378,504` | Opening an expanded view closes its tool's slot |
| `LayoutService` construction or first layout read | `packages/daemon/src/plugins/layout.ts` | Normalize a stored layout that has both open, once at load |
| `TASKS_TOOL` (new constant) | `plugins/quirky.tasks/src/contracts.ts` | `'sidebar-section:quirky.tasks/tasks'` |
| `currentTasksToolState` | `plugins/quirky.tasks/src/env.ts:121` | Find the tool by `entry.id === TASKS_TOOL`, not by `contributionId === TASKS_VIEW` |
| `env.navigate` | `plugins/quirky.tasks/src/env.ts:189` | Applies the [navigation contract](#tasks-daemon-contract) |
| `coreMethods.open`, `close`, `restoreTasksCenterFromSettings` | `plugins/quirky.tasks/src/env.ts:235,280,142` | Apply the [entry rules](#tasks-daemon-contract) |
| `TaskNavigation` | `plugins/quirky.tasks/src/contracts.ts:93` | Add `lastList` |
| `validateNavigation`, `defaultState` | `plugins/quirky.tasks/src/env.ts` | Accept and default `lastList` |
| `state` result schema | `plugins/quirky.tasks/quirky-plugin.json` | Add `lastList` under `navigation`; add the `counts` method and `cli-command` |
| pure helpers in `TasksList.tsx:29-396` | `plugins/quirky.tasks/src/list/TasksList.tsx` | Move `object`, `strings`, `parseItem`, `parseRepo`, `parseListResult`, `parseIdentity`, `parseSource`, `rowKey`, `rowTarget`, `relativeTime`, `tokenize`, `qualifier`, `filtersFromQuery`, `quoteQualifier`, `replaceFilters`, `presetQuery`, `normalizedPreset`, `currentPreset`, `filterPills`, `countFilters`, `checkSummary`, `mergeMeta`, `reviewState`, `nonnegativeInteger`, `optionalLogins`, `reviewAuthors`, `checkResult`, `errorMessage`, and the types `ListItem`, `ListData`, `ListFailure`, `ListSource`, `FilterValues`, `Preset`, `CheckResult`, `MergeMetadata`, to `list/model.ts`, unchanged |
| table render | `plugins/quirky.tasks/src/list/TasksList.tsx:1381-1538` | Replaced by list rows and a detail pane |
| `onRow` | `plugins/quirky.tasks/src/list/TasksList.tsx:1172` | Selects the row with `navigate({ detail })`; a PR no longer opens Review directly |
| `TasksApp`, `TasksSidebar`, `activate` | `plugins/quirky.tasks/src/ui.tsx:96,141,179` | `TasksSidebar` is replaced by the compact mount; `TasksApp` gains Collapse and the new Escape rule |
| `IssueSurface` back button | `plugins/quirky.tasks/src/issue/IssueSurface.tsx:508` | In the pane it closes the row; keeps "Back to Project" for project origins |
| `ToolPanelFrame` | `packages/ui/src/design-system/panels.tsx:75` | Use `tabs`, `actions`, `onMinimize`; no change to the component |
| `ListRow`, `Menu`, `ContextMenu`, `StatusDot`, `Tabs` | `packages/ui/src/design-system/navigation.tsx`, `context-menu.tsx`, `primitives.tsx` | Reuse; `TabItem.count` already exists |
| control icon list | `scripts/gen-icons.ts:25` | Add `arrows-in`, regenerate with `bun scripts/gen-icons.ts` |

## Contracts and interfaces

### Layout contract

Back-link: [Tasks is in one of three places](logic.md#tasks-is-in-one-of-three-places).

`CONTRACT:`
```
type UiToolEntry = { ...existing, expandedView?: string }
```

For a tool with `expandedView = V`, in the layout of the focused window, or of the only window, or the shared layout when none is connected:

| Call | Layout before | Layout after |
|---|---|---|
| `ui.tool.open(tool)` | `V` is the active view | `V` closed as `closeView` would; tool open in its slot |
| `ui.tool.open(tool)` | `V` in `viewTabs`, another view active | `V` active with its stored input; slots unchanged |
| `ui.tool.open(tool)` | `V` not in `viewTabs` | Tool open in its slot, as today |
| `ui.view.open(V)` or `ui.window.view.open(V)` | Tool open in a slot | `V` active; that slot is null, so the other slot on that side fills the space |
| `ui.view.close` while `V` is active | Any | `V` closed; slots unchanged |
| `ui.tool.close(slot)` | Any | As today |

- Invariant: after any call above, the tool isn't open in a slot while `V` is in `viewTabs`. Only the panel-to-tab call clears a slot, and only for this tool.
- Loading a stored layout with both open keeps the tab and clears the slot, so an existing install settles to one form without rewriting anything else. See Windows below for when this runs.
- A tool without `expandedView` behaves exactly as today. The Heimdall, Automations and Mobile rules keep `body`.
- `moveTool`, `resizeTools` and placements don't change.
- Error behavior: `projectTools` sets `expandedView` only when that view is an effective contribution, so a disabled view leaves the tool behaving as today. These rules add no new throws, and `ui.tool.open` keeps its not-found error.

Windows:

- Tool layout is shared and views are per window, so the invariant holds for the focused main window, not across all windows.
- `openTool` reads `focusedConn()`, or the only window, with `windowLayout(connId)`, and closes or activates through `closeWindowView(connId)` and `openWindowView(connId, ...)`. It never calls `closeView`, which throws a conflict with more than one window.
- `openWindowView(V)` clears the slot only for a main window. An auxiliary window has no `tools`, so opening `V` there leaves the main window's slot alone.
- Stored-layout normalization runs once at load, and only when at most one window is connected. It must not run inside `layout()`, because with two windows the shared `viewTabs` can still hold `V` after a window closed its own copy, which would keep clearing a panel the user just opened.

### Tasks daemon contract

Back-link: [Opening from elsewhere](logic.md#behavior-and-scenarios), scenarios 1, 8, 9, 10.

`SCHEMA:`
```
TaskNavigation.lastList: { mode: 'issues' | 'prs', query: string, page: number }
```

- `lastList` starts as `{ mode: 'issues', query: 'is:issue is:open', page: 1 }`, and the first `open` sets it from the default preset. After every update where the resulting `mode` isn't `projects`, it equals that mode, query and page. It's session state, like the rest of navigation, and isn't persisted.
- `navigate(patch)` updates state and returns it, and it never touches layout. The UI reads live state from `quirky.tasks/state`, so nothing needs the view input republished. This is what keeps the phone's `quirky.tasks/navigate` calls from opening anything on the desktop, and it stops a slow call from reopening a tab the user just collapsed.
- `prepare()` is a new method that applies the first-open defaults once and returns the state: `defaultTaskViewPreset`, `defaultRepoSelection` and `lastList`. The `opened` flag moves out of the `open` closure so `open` and `prepare` share it. Both mounts call `prepare` once on mount, because the stripe opens the panel through `ui.tool.open` and never reaches `open`. It changes no layout. It adds a `cli-command` entry like other methods.
- `open(params)`:
  - Applies the first-open defaults once through the same path, as today. A later `open` applies only `params` and no longer clears `detail`, so a plain open keeps your place.
  - Expands, meaning `ui.view.open(TASKS_VIEW, { navigation, revision })`, when `params` has a non-null `detail` or `project`, `newIssue: true`, or `mode: 'projects'`.
  - Otherwise, if `TASKS_VIEW` is in `viewTabs`, makes it active. If not, runs `ui.tool.open(TASKS_TOOL)`.
  - Returning from `TASKS_SETTINGS_VIEW` closes that view first, then applies the rule above.
- `close()`: if the tool is open in a slot, closes that slot. If `TASKS_VIEW` is active, closes it. If `TASKS_VIEW` is a background tab, makes it active and then closes it. Otherwise does nothing. It returns `{ closed: true }` in every case.
- `settings()` keeps its worktree handling and result.
- `counts(params)`:

`CONTRACT:`
```
quirky.tasks/counts({ mode?: 'issues' | 'prs', query?: string, repoIds?: string[] | null })
  -> { issues: number | null, prs: number | null }
```

  It reads `quirky.hosting/workItemPage` with `limit: 1` and sums `totalCount` for each kind, across the same qualified repositories and worktrees `list` uses (`list/methods.ts:250-288`). `countWorkItems` is not usable here because it returns one combined count across issues and PRs. The given `mode` uses the given `query`; the other mode uses its default open query. A mode is `null` when any repository's read throws or its `totalCount` isn't a non-negative safe integer. It is read-only and adds a matching `cli-command` entry, as every other method has.

The UI's own transitions don't go through `open`, so they stay safe with several windows:

- **Expand:** `context.openView(TASKS_VIEW, { navigation, revision })` from the mount.
- **Row click in the panel:** `await context.call('quirky.tasks/navigate', { detail: rowTarget(item) })`, then Expand.
- **More tasks and the empty-state action:** Expand.
- **Collapse:** `context.call('ui.tool.open', { id: TASKS_TOOL })`.

`quirky.tasks/open` is the entry for everything outside the panel and tab, such as ⌘K and links.

### Row status contract

Back-link: [Compact rows use the worktree row and its dots](logic.md#compact-rows-use-the-worktree-row-and-its-dots).

`CONTRACT:`
```
rowStatus(item, { viewer: string | null, checks?: CheckResult, merge?: MergeMetadata, activity?: AgentActivity })
  -> { status: 'needs-you' | 'failing' | 'working' | 'done' | 'idle', detail: string }
```

Pure, in `list/row-status.ts`. The first match wins:

| Status | When | `detail` |
|---|---|---|
| `needs-you` | `activity.bucket === 'attention'`, or `requestedReviewers` includes `viewer`, or the item's author is `viewer` and `reviewDecision === 'CHANGES_REQUESTED'` | The agent name and label, or `review requested`, or `changes requested` |
| `failing` | Author is `viewer` and the check summary tone is `danger` | `N checks failing`, or `1 check failing` |
| `working` | `activity.bucket === 'working'` | The agent name and label |
| `done` | `state` is `merged` or `closed` | `merged 3d ago`, or `closed 3d ago` |
| `idle` | Otherwise | `waiting on <first requested reviewer>` when one is known, otherwise the relative age |

- Inputs: `viewer` is `quirky.hosting/viewer`'s `login`, read once per mount with the first selected repository's `worktree`; a failed read gives null. `requestedReviewers` comes from `merge.review`, because list items don't carry it. `activity` is the entry for `item.linkedWorkspace.worktree`.
- With `viewer` null, the viewer-based rules don't match. A row whose checks and merge metadata haven't arrived resolves to `idle` with its age.
- The compact second line is `#<number> · <detail>`, except it's `#<number> · <repoName> · <detail>` when `detail` doesn't start with the agent's name.

### Agent activity contract

Back-link: [Compact rows use the worktree row and its dots](logic.md#compact-rows-use-the-worktree-row-and-its-dots).

`CONTRACT:`
```
useAgentActivity(context) -> Map<worktreeId, { bucket: 'attention' | 'working', agent: string, label: string }>
```

It reads `quirky.agent-status/dashboard`, re-reads on the `quirky.agent-status/activityChanged` event, and keeps only `attention` and `working` cards. For a worktree with more than one card, attention wins. Any failure, including the plugin being disabled, gives an empty map and no error UI. `quirky.tasks` adds no manifest dependency, because the panel must work without agent status.

### Compact panel contract

Back-link: [The panel is for glancing](logic.md#the-panel-is-for-glancing-the-tab-is-for-working), scenarios 1, 11 to 17.

- Mount: `context.provide('sidebar-section:quirky.tasks/tasks', ...)` renders `CompactTasks`.
- List request: `quirky.tasks/list` with the effective `{ mode, query, page }`, which is `navigation` unless `navigation.mode === 'projects'`, when it's `navigation.lastList`.
- Frame: `ToolShell.tsx:893` already wraps every slot in a `ToolPanelFrame`, so the panel's own `ToolPanelFrame` is nested and renders only `tabs` and `actions`; the host draws the title and Minimize, which calls `ui.tool.close`. Pass `Tabs` for Issues and PRs with counts, and `actions` holding Expand (`arrows-out`, label `Expand Tasks`). `onMinimize` would be dead there, so don't pass it.
- Row: `ListRow` with `status`, `description`, `selected` matching `navigation.detail`, `onClick` running the row click transition above, and `trailing` holding Start or Resume plus a `Menu`. Right-click opens `ContextMenu` with the same items.
- Row actions stay in the DOM and in tab order at all times. CSS hides them with opacity until the row has `:hover` or `:focus-within`, so keyboard users can reach them.
- Metadata loading reuses the rule in `TasksList.tsx:896-917`: the first 20 rows at once, the rest through `IntersectionObserver`. A view change discards in-flight results, using the same generation approach as `fetchGeneration` and `viewGeneration`.
- Clear filters: `navigate({ query: presetQuery(normalizedPreset(defaultTaskViewPreset, kind), kind), page: 1, scrollTop: 0 })`, moving `presetQuery` and `normalizedPreset` to `list/model.ts`.
- Filter line: shows when the query differs from the default preset's query. The label is the name of the preset with the most qualifiers that are all present in the query, else `Custom`. The count is `countFilters` minus the qualifiers that preset already contains, so `is:open` isn't counted under Open, and it's shown as `N filter` or `N filters` when above zero.
- More tasks: shows when `page < totalPages` and calls Expand.
- Refresh on `quirky.tasks/changed` when the revision's effective list changes, as `TasksList` does through `currentKey`.
- The compact mount always renders in a slot and ignores `showTasksButton`, which matches today's tool behavior. `TasksSidebar`, its prefetch and its hover `GH` button are removed.
- The `report` prop keeps reporting `{ visible: true }` for the existing slot report path.

### Expanded view contract

Back-link: [The expanded tab](logic.md#the-expanded-tab-is-a-list-beside-a-detail-pane), scenarios 2 to 6, 18 to 20.

- Mount: `TASKS_VIEW` renders `TasksApp` in the center, with Collapse (`arrows-in`, label `Collapse Tasks`) in frame actions. `onMinimize` is removed, since the tab's × closes it.
- `TasksApp` chooses: `mode === 'projects'` shows `ProjectsSurface`, or `IssueSurface` full width when `detail` is set, as today. Otherwise it shows `TasksList`.
- `TasksList` keeps its state machine, mutations, freshness generations and toolbar. Its body becomes a list column beside a detail column. A list row shows dot, title, `#number · repo · author`, checks and age, and it doesn't show the previous cell buttons.
- Detail column: no `detail` shows `EmptyState` with `Select a task`. A `detail` of kind `issue` shows `IssueSurface`. A `detail` of kind `pullRequest` shows `PrDetail`.
- `PrDetail` is presentational: `TasksList` passes the item, metadata, checks and the existing handlers. It moves these out of the table unchanged: the reviewers dialog, the merge menu with all its eligibility text, `toggleAutoMerge`, `mergeItem`, `saveReviewers` and Start, Resume and Start new. Review calls `openReview(rowTarget(item), 'conversation')`, and the checks line calls `openReview(rowTarget(item), 'checks')`.
- `PrDetail` when the target isn't on the current page: it loads `quirky.tasks/mergeMetadata` for the target, uses `review.title`, `state`, `url`, reviewers and changes from it, and omits the description.
- Timeline: built from `review.reviews` with one line per review, newest first, and omitted when there are none or it's null.
- A new `toolbar` menu holds Task settings, Open repository in GitHub and the issue source control. The current inline versions are removed from the body.
- Narrow layout: `tasks-list.css` uses `@container (max-width: 47.5rem)`, with the tab body as the container. Below it, `[data-has-detail='true']` hides the list column and `[data-has-detail='false']` hides the detail column. A back button in the detail column is shown only there and calls `navigate({ detail: null })`. `47.5rem` is literal because container queries can't read custom properties, and rem passes `ui:lint`'s pixel rule. Hiding the column resets its scroll position, so save it with `place.setScrollTop` on selection and restore it when the list shows again.
- Escape, in `TasksApp`'s document handler: the existing dialog and menu guard returns first; a focused input or textarea blurs; a set `detail` is cleared with `navigate({ detail: null })`; otherwise Collapse runs. `ProjectsSurface`'s inline inputs handle Escape themselves. `IssueSurface` has no Escape handler, so Escape in its comment box blurs first and only a second press clears the row, which protects a draft.
- Compact mounts have no document Escape handler.

### Place memory contract

Back-link: [Tasks is in one of three places](logic.md#tasks-is-in-one-of-three-places), scenarios 4, 5, 9.

`CONTRACT:`
```
place.scrollTop(form: 'compact' | 'expanded', viewKey: string): number; place.setScrollTop(form, viewKey, value): void
place.requestFocus(target: 'row' | 'collapse' | 'expand'): void
place.takeFocus(): 'row' | 'collapse' | 'expand' | null
```

A module-level store in `list/place.ts`, living as long as the window's plugin UI module, because a `createRoot` remount loses component state and writing scroll to the daemon on every scroll would churn revisions. `viewKey` is the existing `currentKey` shape. `navigation.scrollTop` keeps its current behavior and is not used for this.

- `place.listSnapshot(key)` and `place.setListSnapshot(key, { list, checks, merge })` hold the last list and row metadata per view, bounded to 20 views, with the key from `listViewKey` in `list/model.ts`. Both forms seed from it on mount and revalidate in the background, showing skeletons only when there's no snapshot, so moving between forms doesn't drop your rows.
- Seeded merge metadata is display-only. `mergeItem` and `toggleAutoMerge` refuse to act until a fresh read lands, so a merge can't run from a snapshot.
- Expand and row click request focus on `row`, which lands on the selected row or the first row.
- Collapse requests `row`. The compact mount scrolls the selected row into view and focuses it once rows render.

## Data models and schemas

`SCHEMA:` `AgentActivity` is `{ bucket: 'attention' | 'working', agent: string, label: string }`, from `dashboard.cards[].bucket`, `.thread.agent` and `.thread.label`, keyed by `.thread.worktreeId`.

`SCHEMA:` the `counts` result is `{ issues: number | null, prs: number | null }`.

No stored schema changes. `lastList` isn't durable, because `update` only persists `preferences`, `projects` and `links`.

## DO-NOT-CHANGE fences

- `plugins/quirky.tasks/src/list/TasksList.tsx:691-821` (`mutate`) and `:661-690` (`startQuietAdoption`), because they hold the optimistic write and freshness rules that the merge and assignee tests depend on. Move calls to them, not their logic.
- `plugins/quirky.tasks/src/list/methods.ts` `mergeMetadata` and `row`, because merge eligibility is the safety contract the spec promises to keep.
- `plugins/quirky.tasks/src/review-navigation.ts` and `list/useReviewNavigation.ts`, because the Review tab is out of scope.
- `plugins/quirky.tasks/src/projects/*`, because Projects' behavior is out of scope.
- `apps/mobile/**`, `plugins/quirky.mobile/**` and `packages/protocol/src/mobile.ts`, because the phone is out of scope.
- `packages/daemon/src/plugins/tool-layout.ts` rules other than Tasks, because Heimdall, Automations and Mobile must behave exactly as before.
- `packages/ui/src/shell/ToolShell.tsx`, because the stripe already calls `ui.tool.open` when the tool isn't open, so the daemon rule covers it.

## Always, Ask, Never

**Always**
- Use only `@quirky/ui` components and `--ui-*` or existing `--compat-*` tokens. `quirky.tasks` is on the `ui:lint` enforced list, and `bun run ui:lint` must pass.
- Put semantic CSS in `packages/ui/src/design-system/`, imported from `styles.css`, never in the plugin.
- Follow the repo's comment rules: docstrings for public units, inline comments only for a hidden why.

**Ask**
- Anything that would change a Decisions Locked entry in `logic.md`.

**Never**
- Run the full test suite locally or on OVH (`AGENTS.md`). Task acceptance uses the literal commands in the plan.
- Add a Tasks-specific branch to `ToolShell`, `MainArea` or `host.ts`.
- Have the panel and tab fetch different versions of the same query. Both key their reads on the effective `{ mode, query, page, repoIds }`.

## Cross-cutting

- **Security:** `open-link` validation and the `copy-link` command are reused unchanged. No new input reaches a shell. `counts` takes the same `query` limits as `list` (8192 bytes via `queryForKind`).
- **Observability:** The existing slot `report` path stays. No new logging.
- **Data migration:** None. The layout normalization only clears an open slot.
- **Rollback:** Revert the branch. Stored layouts stay valid because the tool ID is unchanged.
- **Performance:** The panel's metadata reads are bounded the same way as the table's. `counts` runs once per effective view change, not per render.

## Testing strategy

| File | Must cover |
|---|---|
| `packages/daemon/test/plugins/tool-slots.test.ts` | Update the `contributionId` assertion at `:149`. Every row of the layout contract; stored layout normalization; a tool without `expandedView` is unaffected; two windows |
| `plugins/quirky.tasks/test/state.test.ts` | Rewrite the tests at `:12`, `:52`, `:75` to the new `open` and `close` rules. Plain `open` keeps `detail`; `navigate` never changes layout when no tab is active; `lastList`; `prepare` applies defaults once and leaves layout alone; a `detail` open expands; settings return; `counts` per kind and null on failure |
| `plugins/quirky.tasks/test/row-status.test.ts` (new) | Every row of the status table, priority order, null viewer, missing metadata, singular and plural |
| `plugins/quirky.tasks/test/compact-ui.test.tsx` (new) | Tabs and counts, unknown count, row click navigates then opens the view, Expand, `prepare` on mount, row actions present in the DOM, menu items by kind, filter line and clear, More tasks, loading, empty, problem, Projects falls back to `lastList`, focus after Collapse |
| `plugins/quirky.tasks/test/expanded-ui.test.tsx` (new) | Row selection, Select a task, issue and PR detail, Review opens Review, merge menu contents match eligibility, narrow data attribute, toolbar menu, Escape order, Collapse calls `ui.tool.open` |
| `plugins/quirky.tasks/test/frame-ui.test.tsx` | Keep passing against the center mount; add Collapse |
| `plugins/quirky.tasks/test/remaining-list-issue.test.ts`, `workspace-composer.test.tsx`, `review-navigation.test.ts` | Update only where they pin the removed table or the old `open` behavior |

The bar is the four criteria in [How we know it's done](logic.md#how-we-know-its-done). The "no sideways scroll" and screenshot criteria are checked with `bun run ui:review --only quirky.tasks` and a real-app capture, since happy-dom can't measure layout.

`COMMAND:`
```bash
bun scripts/suite.ts plugins/quirky.tasks packages/daemon/test/plugins
bun run ui:lint
bunx tsc --noEmit -p tsconfig.json
```

## Non-goals

- A shared compact and expanded abstraction beyond `expandedView`. Automations is deferred in the logic spec.
- Paging inside the panel, or a `navigation.scrollTop` rewrite.
- New host events, or any change to the Review tab's data.

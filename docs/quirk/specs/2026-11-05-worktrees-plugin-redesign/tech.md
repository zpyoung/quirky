# Worktrees redesign: tech spec

**Status:** Reviewed. Tier gate fired: the work touches far more than three source files and crosses the plugin, UI shell, protocol and daemon boundaries.
**Logic spec:** [logic.md](logic.md)

`W` means `plugins/quirky.worktree`, and `DS` means `packages/ui/src/design-system`. Every line reference was read from commit `dd7898a5`.

## Architecture

The Worktrees plugin is split in two. The daemon half lives in `W/main.ts` and `W/src/daemon/*`. It owns the data in a plugin SQLite store (`W/src/daemon/store.ts`, with append-only migrations) and the `meta(key, value)` JSON blobs (`W/src/daemon/options.ts`). The UI half (`W/src/ui.tsx` mounts `WorktreesSection`) reads and writes that data only through RPC wrappers in `W/src/actions.ts`, and refreshes on `quirky.worktree/*` events.

The redesign keeps that split as it is:

- **Tags** are new store tables plus RPCs in the worktree plugin. ([logic: The model](logic.md#the-model))
- **Sections** are today's project groups. They're owned by `plugins/quirky.repo` (the `groups` table, `repos.group_id`), and a single worktree joins one through `worktrees.project_group_id`. Only the UI wording changes, so there's no data migration. ([logic: Glossary](logic.md#glossary))
- **Views** are a new `meta` blob in the worktree plugin. The **All** view is the existing `stock-worktree-options` blob (`W/src/daemon/options.ts:4`) plus the sidebar-extras activity preferences, so today's settings become All with no migration. ([logic: SC-7](logic.md#sc-7-save-a-view-switch-to-it-go-back-to-all))
- **The active view per window** is a `meta` map keyed by the window id from `currentWindowId` (`W/src/actions.ts:23`).
- **View drafts** (unsaved changes) are React state in the window only.
- **Filtering, grouping and sorting** stay client-side, in a new pure module `W/src/view-model.ts`, replacing `orderedWorktrees` and `passesStockFilters` (defined near `W/src/WorktreesSection.tsx:70-130`).
- **Activity and review filters** are computed by `plugins/quirky.sidebar-extras` (`src/daemon/projection.ts:208`). The projection call gains an optional preferences override, so a view can be evaluated without writing the shared preferences.
- **Rail badge:** `setPanelBadge` gains a tone and accepts the plugin's own sidebar-section ids, and `ToolShell` renders the tone.
- **Styling** goes only in `DS/*.css`. `scripts/ui-lint.ts` rejects plugin CSS, raw colors and raw `px` outside `DS/tokens.css`.

## Code references

**Data (worktree daemon)**
- `W/src/daemon/store.ts:11-41`: `WorktreeRow`. Migrations are appended to the existing list (`:67`).
- `W/src/daemon/list.ts:43`: `joinMetadata` builds `WorktreeControl` (`W/src/control-types.ts:63`).
- `W/src/daemon/options.ts`: the `meta` blob pattern (`readStockOptions` `:63`, `setStockOptions` `:74`, normalise `:30`) to copy for views.
- `W/main.ts:156`: emits `quirky.worktree/changed`. `:581,598`: `optionsChanged`.
- `W/quirky-plugin.json`: declares methods and events (for example `setOptions` `:1844`, `optionsChanged` `:3167`). **Every new RPC and event in C2 and C3 must be declared here, with its param schema**, or the daemon rejects the call.
- `W/src/actions.ts`: UI RPC wrappers (`set` `:309`, `currentWindowId` `:23`).

**Sidebar UI**
- `W/src/WorktreesSection.tsx`:
  - The header portal (`:554-604`), where the funnel "Worktrees options" `IconButton` and `Popover` (`:564-604`) are replaced.
  - Options load and change (`:184-196`, `:319-323`), the Tree mount (`:626-652`) and dialogs (`:657-710`).
- `W/src/Tree.tsx`:
  - `WorktreeCard` (`:157-390`) becomes the one-line row, and the activity precedence moves into view-model (`:181-207`).
  - `project()` (`:774-840`) and `groupSection()` (`:845-898`) become muted headers with always-visible `+`/`…`.
  - The Pinned section (`:1006-1026`) must stop duplicating.
  - The single `ContextMenu` (`:1063`) stays.
- `W/src/Menu.tsx`: `workspaceMenu` (`:33`), `projectMenu` (`:153`), `groupMenu` (`:169`).
- `W/src/StatusDot.tsx`: `semanticStatus` (`:18`) and `UnreadBell` (`:44`). `UnreadBell` is replaced by the unread dot.
- Removed or replaced: `W/src/StockOptions.tsx` becomes the Display and Filter menus, and `W/src/ActivityFilters.tsx` folds into Filter.
- `W/src/useSidebarActivity.ts:6-14,30-48,228-232`, `W/src/useWorktreeAttention.ts:12-54` and `W/src/useTree.ts:115-130` are data hooks, kept and extended.
- `DS/worktree-tree.css`: hover-only reveals (`:36-43`, `:70-77`) and narrow `@container ui-tool-panel` rules (`:45-79`, `:108-131`).

**Dialogs**
- `W/src/DeleteDialog.tsx:47,79`: "Delete Workspace" becomes "Delete worktree".
- `W/src/CreateDialog.tsx:605`: "New workspace" becomes "New worktree".
- `W/src/UpdateDialog.tsx:49`: "Workspace details" becomes "Worktree details". It's opened from More › Details…, and its Display Name field stays.
- `W/src/CleanupDialog.tsx:127`: only `idle-clean` is humanized today.
- `W/src/GroupDialogs.tsx`: says "group", and becomes "section".

**Remote**
- `W/src/RemoteWorkspacesSection.tsx`, `W/src/RemoteWorkspace.tsx` (all inline styles) and `W/src/VmEnvironments.tsx` (`className="form"` and bare elements).

**Shell and protocol**
- `packages/protocol/src/ui.ts:355-357`: `setPanelBadge(panelId, count, title?)`.
- `packages/ui/src/plugins/host.ts:1082-1091`: the owner check allows only `model.panels` today. `setBadge` is at `:1224`, and the state is `badges`/`badgeTitles` (`:82,212`).
- `packages/ui/src/shell/ToolShell.tsx:287-296`: `toolBadge`. `:485` hard-codes `<Badge tone="needs-you">`.

**Activity projection**
- `plugins/quirky.sidebar-extras/src/daemon/projection.ts:25` (`ActivityProjection`), `:208` (`projectActivity`), and the review decisions at `:224`.
- `src/daemon/reviews.ts:5-34`: the `checksStatus` source, cache-only.

## Contracts and interfaces

### C1 Shared view types: `W/src/view-types.ts` (new)

Every task imports from this file, and nothing redefines these shapes. ([logic: The model](logic.md#the-model))

SCHEMA:
```
TagColor = 'blue' | 'violet' | 'teal' | 'coral' | 'magenta' | 'mint' | 'sand' | 'rose'
Tag = { id: string; name: string; color: TagColor | null }          // null = grey
GroupBy = 'section-project' | 'project' | 'status' | 'tag' | 'pull-request' | 'none'
SortBy = 'recent' | 'agent-activity' | 'name' | 'project' | 'manual'
RowFact = 'pr' | 'last-activity' | 'branch' | 'status'
ActivityMarkState = 'running' | 'waiting' | 'error' | 'idle' | 'asleep'
ActivityPreferences = { workspaceActivityWindow, workspaceActivityWindowBeforeLiveOnly, workspaceActivityCustomDays,
  alwaysShowDefaultBranchWorkspace, hideCompletedReviewWorkspaces, hidePassingCheckWorkspaces, hideAutomationCreated }
  // exactly the fields and value types of the local type in W/src/useSidebarActivity.ts:6-14; move that type here
ViewFilter = { tagIds: string[]; sectionIds: string[]; repoIds: string[]; statuses: WorktreeStatus[];
  hideCliCreated, hideOtherDesktopClients, hideDefaultBranch, hideDetachedHead, hideArchived: boolean;
  activity: ActivityPreferences }
ViewDisplay = { groupBy: GroupBy; sortBy: SortBy; projectOrder: 'manual' | 'recent'; showAsleep: boolean; showNested: boolean }
ViewSpec = { filter: ViewFilter; display: ViewDisplay }
SavedView = { id: string; name: string; starred: boolean; spec: ViewSpec }
ViewsState = { views: SavedView[]; needsYouHidden: boolean; rowFact: RowFact }
ViewId = 'all' | 'needs-you' | string                                 // string = SavedView.id
```
The hide flags map one-to-one onto the existing `StockWorktreeOptions` hide fields (`W/src/control-types.ts:23-41`). `allSpecFromStock(stock, activity): ViewSpec` and `stockFromAllSpec` live in this file, so All round-trips through the existing blob.

### C2 Tags RPC (worktree daemon)

([logic: SC-5](logic.md#sc-5-tag-two-worktrees-and-filter-to-the-tag), [SC-11](logic.md#sc-11-bulk-actions))

CONTRACT:
```
quirky.worktree/tags {} -> { tags: Tag[]; assignments: Record<worktreeId, tagId[]> }
quirky.worktree/tagCreate { name: string; color?: TagColor | null } -> { tag: Tag }
quirky.worktree/tagUpdate { id: string; name?: string; color?: TagColor | null } -> { tag: Tag }
quirky.worktree/tagDelete { id: string } -> {}
quirky.worktree/tagAssign { worktreeIds: string[]; tagId: string; assigned: boolean } -> {}
event quirky.worktree/tagsChanged {}
```
- Names are trimmed, 1 to 40 characters, and unique case-insensitively.
  - `tagCreate` with an existing name returns the existing tag.
  - A rename that collides with another tag is rejected with an error message naming the clash.
- Unknown ids are an error. A worktree id that no longer exists is ignored by `tagAssign`.
- Deleting a worktree deletes its assignments, and deleting a tag deletes its assignments.
- Every tag mutation emits `quirky.worktree/tagsChanged`. The UI refetches both `tags` and the worktree list on it, because `tagIds` comes from `joinMetadata`.
- `WorktreeControl` gains `tagIds: string[]`, filled by `joinMetadata`. `packages/protocol` `Worktree` does not change, so the mobile app is untouched.

### C3 Views RPC (worktree daemon)

([logic: SC-7](logic.md#sc-7-save-a-view-switch-to-it-go-back-to-all))

CONTRACT:
```
quirky.worktree/views {} -> ViewsState
quirky.worktree/setViews { state: ViewsState } -> ViewsState        // normalised; validates every field, drops unknown keys
quirky.worktree/activeView { window: number } -> { viewId: ViewId }  // unknown window or deleted view -> 'all'
quirky.worktree/setActiveView { window: number; viewId: ViewId } -> {}
event quirky.worktree/viewsChanged {}
```
- Storage uses the `meta` keys `worktree-views` (ViewsState) and `worktree-last-view` (ViewId).
- The default ViewsState is `{views: [], needsYouHidden: false, rowFact: 'last-activity'}`.
- **Active view is session-scoped.** `currentWindowId` returns a connection id (`packages/daemon/src/plugins/layout.ts:320`), which changes on reload and can be reused by another window. So `worktree-active-views` is kept **in memory only** in the daemon, keyed by that id and pruned when the connection closes. It persists one `meta` key, `worktree-last-view` (a `ViewId`), and a window with no entry starts on that view. Within a session each window keeps its own view, and after a restart every window opens on the last view used.
- A view id that no longer exists (deleted or hidden) resolves to `'all'`, and `setActiveView` with an unknown id is an error.
- Saving over All is not an RPC. All changes only through `setOptions`, which the redesigned UI never calls for a view edit, because All can't be overwritten.

### C4 Activity projection override (sidebar-extras daemon)

([logic: Display and Filter in Screens](logic.md#screens))

CONTRACT:
```
quirky.sidebar-extras/projection { client?: string; preferences?: ActivityPreferences } -> ActivityProjection
ActivityProjection.workspaces[id] gains { checks: 'pending' | 'success' | 'failure' | 'neutral' | null }
```
- The edit sites are:
  - the handler at `plugins/quirky.sidebar-extras/main.ts:52`
  - `READ_KEYS` and `validateReadParams` in `src/daemon/state.ts:49,100`, which today reject any key but `client`; `preferences` is added and validated field by field with the existing preference validators
  - `projectActivity` (`src/daemon/projection.ts:208`), which takes the override in place of `state.preferences` everywhere it reads it (`:173-302`)
  - the projection schema in `plugins/quirky.sidebar-extras/quirky-plugin.json`
- With `preferences`, the projection is computed from those values and nothing is written. An invalid field is a param error, as for any other bad param.
- Without it, behavior is unchanged.
- `checks` comes from the cached review (`reviews.ts`), is always filled when a cached review exists (independent of the hide flags), and is `null` otherwise. No network fetch is added.

### C5 Rail badge tone (protocol, host, shell)

([logic: SC-4](logic.md#sc-4-rail-badge-when-the-sidebar-is-collapsed))

CONTRACT:
```
setPanelBadge(panelId: string, count: number | null, title?: string, tone?: 'needs-you' | 'failing'): void
```
- `panelId` may be any panel or sidebar-section contributed by the calling plugin. The owner check at `packages/ui/src/plugins/host.ts:1082-1084` also searches `model.sidebarSections`. Anything else still throws.
- The Worktrees plugin passes `'sidebar-section:quirky.worktree/worktrees'`. That id is in the Worktrees tool entry's aliases (`packages/ui/src/shell/tool-layout.ts:12`), and `toolBadge` sums over the aliases.
- The host adds `badgeTones: Record<string, 'needs-you' | 'failing'>` beside `badges`/`badgeTitles` (`host.ts:82,212`). `setBadge` (`:1224`) sets or clears it together with them, including the auto-clear on dispose.
- The signature becomes `toolBadge(entry, badges, titles, tones, inboxCount)`, and every caller passes `badgeTones` through, as it already does `badgeTitles` (`ToolShell.tsx:375-692`).
- The default tone is `'needs-you'`, so existing callers render the same.
- `toolBadge` returns `{count, title, tone}`. When aliases disagree, `'failing'` wins.
- `ToolShell` renders `<Badge tone={badge.tone}>`.

### C5b Badge producer: `W/src/attention-badge.ts` (new), started from `W/src/ui.tsx`

([logic: SC-4](logic.md#sc-4-rail-badge-when-the-sidebar-is-collapsed))

CONTRACT:
```
startAttentionBadge(context: UiPluginContext): () => void   // called once in ui.tsx activate; returns dispose
```
- It runs for the plugin UI's lifetime, not the section's, so the badge stays while the sidebar is collapsed or the section is unmounted.
- It reads **unfiltered** data, never the active view:
  - the worktree list
  - sessions
  - pending asks (the same source as `useWorktreeAttention.ts`)
  - `checks` from the projection (no override)
- It computes `needsYou` and `activityMark` through C6, and refreshes on the same events those hooks already listen to.
- It calls `setPanelBadge('sidebar-section:quirky.worktree/worktrees', n || null, title, errored > 0 ? 'failing' : 'needs-you')`. The title reads `"<n> worktree(s) need(s) you"`, plus `", <e> errored"` when e > 0. For example: "3 worktrees need you, 1 errored", or "1 worktree needs you".

### C6 View model (pure): `W/src/view-model.ts` (new)

([logic: SC-1](logic.md#sc-1-tree-order), [SC-3](logic.md#sc-3-attention-survives-folding), [SC-6](logic.md#sc-6-group-by-tag))

CONTRACT:
```
activityMark(worktree, sessions, pendingAsks, now): ActivityMarkState
needsYou(worktree, mark, checks): boolean     // mark 'waiting' | mark 'error' | unread | checks 'failure'
buildTree(input: { worktrees: WorktreeControl[]; repos; groups: ProjectGroup[]; tags: Tag[]; spec: ViewSpec;
  viewId: ViewId; projection; marks: Map<id, ActivityMarkState>; checks: Map<id, checks> }) -> ViewTree
ViewTree = { groups: ViewGroup[]; hidden: { count: number; reasons: string[] }; needsYouCount: number; erroredCount: number }
ViewGroup = { key: string; kind: 'pinned' | 'section' | 'project' | 'status' | 'tag' | 'untagged' | 'pr' | 'flat';
  title: string; attention: 'none' | 'waiting' | 'error'; attentionCount: number; rows: ViewRow[] }
ViewRow = { worktree: WorktreeControl; depth: number; mark: ActivityMarkState; childCount: number;
  childAttention: 'none' | 'waiting' | 'error'; inSectionFromProject?: string }
```
- `activityMark` mapping:
  - A pending ask or the `needs-you` UI status gives `waiting`.
  - `failing` gives `error`.
  - `sleeping` gives `asleep`.
  - `working` or `queued` gives `running`.
  - Everything else gives `idle`.
  - The precedence matches `W/src/Tree.tsx:181-207`.
- Group order for `section-project`: Pinned, then sections in `sort_order`, then projects in the project order (manual `meta stock-project-order`, or recent activity). A pinned worktree appears only in Pinned.
- In `tag` grouping, a worktree with several tags appears under each of them, and untagged worktrees come last.
- `viewId 'needs-you'` ignores the spec's filters and shows only `needsYou` rows, grouped by `section-project`.
- Attention counts include folded children, and a group's attention is `error` if any row or descendant is `error`.
- **Error rules.** `buildTree` never throws on stale data:
  - An unknown `viewId` is treated as `'all'`.
  - A `project_group_id` naming a missing group puts the worktree under its project.
  - Unknown tag ids in a filter or an assignment are ignored.
  - A parent id that's missing or filtered out shows the child at depth 0.
  - An empty result returns `groups: []` with `hidden` filled.
- `hidden.reasons` holds short plain phrases, such as "archived" or "asleep", for the filter line ("2 hidden: archived").

### C7 Tree props (`W/src/Tree.tsx`)

`Tree` takes the `ViewTree` plus callbacks. It no longer filters or sorts.

CONTRACT:
```
Tree props: { model: ViewTree; tagsById: Map<string, Tag>; rowFact: RowFact; selectedId: string | null;
  multiSelected: Set<string>; onOpen(id); onSelectToggle(id, mode: 'toggle' | 'range'); onRename(id, name);
  onTagsOpen(ids: string[], anchor: HTMLElement); onMenuAction(id, action: RowAction); onGroupAction(group, action);
  collapsed: Set<string>; onToggleCollapsed(key) } plus the existing drag, create and parent callbacks unchanged
RowAction = 'rename' | 'tags' | 'move-section' | 'move-status' | 'sleep' | 'wake' | 'open-terminal' | 'open-changes'
  | 'copy-path' | 'copy-name' | 'set-parent' | 'remove-parent' | 'mark-unread' | 'mark-read' | 'pin' | 'unpin'
  | 'archive' | 'details' | 'delete'
```

### C8 Design-system primitives: `DS/worktree-primitives.tsx` (new, exported from `DS/index.ts`)

([logic: Design direction](logic.md#design-direction))

CONTRACT:
```
ActivityMark { state: ActivityMarkState; label: string }                  // role="img", aria-label=label; shapes per logic
TagChip { name: string; color: TagColor | null }                           // never clips mid-word: caller passes the chips that fit
TagChips { tags: Tag[]; max?: number = 2 }                                 // renders up to max whole chips + "+N"
Checkbox { checked: boolean; indeterminate?: boolean; label: string; onChange(checked) ; hideLabel?: boolean }
SwatchGroup { value: TagColor | null; onChange(c); label: string }         // radiogroup, 8 hues + grey, arrow keys
NoticeLine { children: ReactNode; actions?: { label: string; onAction(): void }[] }
HoverCard { anchor: HTMLElement | null; open: boolean; children }           // does not take focus; role="tooltip"-style region
BulkBar { count: number; actions: { label: string; onAction(): void }[]; onClear(): void }
```
`DS/contracts.ts` declares `UiTagColor` and `UiActivityMarkState` with exactly the literals of C1's `TagColor` and `ActivityMarkState`. They're kept apart so the design system never depends on a plugin, and the plugin types stay usable in the daemon without the UI package. TypeScript's structural typing makes the two interchangeable. `W/test/view-model.test.ts` asserts that they're assignable both ways (a type-level check). The names `ViewTree`, `ViewGroup` and `ViewRow` avoid the existing `TreeModel` and `TreeRow` in `W/src/report.ts:9`.

## Data models

SCHEMA (worktree store migration, appended):
```
CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, color TEXT, created_at INTEGER NOT NULL)
CREATE TABLE worktree_tags (worktree_id TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (worktree_id, tag_id))
```
`name_key` is the lower-cased trimmed name, and tag ids are `tag_<random>`.

CONFIG (meta keys): `worktree-views` holds the JSON ViewsState, and `worktree-last-view` holds the JSON ViewId. The active view per window is in memory only (C3).

## DO-NOT-CHANGE fences

- **`plugins/quirky.repo` group storage and RPCs** (`src/store.ts:123-146`, `main.ts:29-37`). Sections reuse them as they are, and changing them would break the existing groups data and the repo plugin tests.
- **`packages/protocol/src/model.ts` `Worktree` and `ProjectGroup`.** The mobile app consumes them through the bridge allowlist (`apps/mobile/src/shell/bridge-policy.ts`), so new fields go on `WorktreeControl` only.
- **The `stock-worktree-options` blob format and `setOptions`.** It's the All view's storage and the CLI uses it (`W/cli.ts`). Read it, never reshape it.
- **`CleanupDialog`'s candidate computation** (`W/src/daemon/controls.ts:560-680`). The redesign changes presentation only. The safety blockers are what keep unpushed work from being deleted.
- **`CreateDialog.tsx` contents.** Only the title changes, because the dialog's contents are out of scope (logic: Scope and non-goals).

## Always / Ask / Never

- **Always:**
  - Use `var(--ui-*)` tokens. Add any new size as a token in `DS/tokens.css`, in both the dark and the light blocks where colors differ.
  - Use `transition` on opacity and transform only, at 150ms ease-out, with a `prefers-reduced-motion` rule that stops the spinner.
  - Give every mark state its own shape and an aria-label.
  - Use "worktree" in local copy.
- **Ask** (through the orchestrator): any change to a locked decision in logic.md, or a needed edit inside a fence.
- **Never:**
  - Add CSS under `plugins/`.
  - Raw hex or `px` outside tokens.
  - `transition: all`.
  - Fetch reviews over the network from the projection.
  - Change mobile allowlists.

## Cross-cutting

- **Migration.** There's no data migration. All reads the existing stock options and activity preferences, and groups become sections in place. The new tables start empty.
- **Rollback.** The new tables and meta keys are additive. An older build ignores them.
- **Performance.**
  - `buildTree` is pure and memoised on its inputs.
  - Tag assignments load once and refresh on `tagsChanged`.
  - The projection with an override is one RPC per view change and per existing refresh trigger.

## Testing strategy

Run tests with `bun test <file>`, one file per process. Never run the whole suite locally (AGENTS.md).

- **Daemon:**
  - `W/test/tags.test.ts` (new): C2 CRUD, uniqueness, cascade on tag and worktree delete, `tagIds` on list.
  - `W/test/views.test.ts` (new): C3 normalisation, active view per window, fallback to `all`.
- **Projection:** `plugins/quirky.sidebar-extras/test/projection-override.test.ts` (new): the override writes nothing, `checks` is filled.
- **Badge:** `packages/ui/test/tool-shell.test.ts`: tone rendering and the sidebar-section owner check.
- **View model:** `W/test/view-model.test.ts` (new): SC-1, SC-3, SC-6, Needs you, hidden count and reasons.
- **Primitives:** `packages/ui/test/worktree-primitives.test.tsx` (new), with a gallery entry in `packages/ui/src/gallery.tsx` (`CategoryName`) so `packages/ui/test/gallery.test.tsx` still mounts it.
- **Sidebar UI** (happy-dom): `W/test/ui.test.ts`, `sidebar-extras-ui.test.ts`, `tree-reveal.test.tsx`, `narrow-tree.test.ts`, `loop-status.test.tsx`, `attention-ui.test.ts`, `automation-sidebar.test.tsx`, `window-tree.test.ts`, `window-projects.test.ts` and `W/test/window/dom.ts`.
  - Update the assertions coupled to the old markup: the `Worktrees options` dialog, `.ui-list-row__description`, `.ui-list-row__main` and `Unread` labels.
  - Each test the owning task touches must assert the new behavior, not just stop failing.
- **Remote:** `W/test/vm-environments.test.ts`, `remote-owner-workspaces.test.ts`.
- **Lint and types** at every gate: `bun run ui:lint` and `bunx tsc --noEmit -p tsconfig.json`.
- **After pass:** replay `goals.json` with `seed.sh`, then run `bun scripts/redesign/score.ts run --plugin quirky.worktree` and `gate --before scores/before.json` ([logic: Redesign checks](logic.md#redesign-checks)).

## Non-goals

- Smart sections, tag groups and tags on projects (logic: Deferred ideas).
- Mobile UI changes.
- The New worktree dialog's contents, the Workspace board and the Settings page.
- Changes to how groups are stored.

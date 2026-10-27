# Sidebar extras technical specification

Status: Accepted autonomously after mandatory Codex promote/refute review; confirmed findings incorporated. Logic: [logic.md](logic.md). Complexity: crosses daemon metadata, UI contribution API, presentation plugin and renderer; both specs required by LOOP.md.

## Architecture

Implements [logic purpose and conceptual model](logic.md#purpose) and [data flow](logic.md#data-flow). Root is `/Users/zpyoung/orca/workspaces/quirky/build-lane-5`; paths below resolve against it, not the external Orca tree.

- `packages/protocol/src/model.ts:25-66`: extend `Worktree` and `ProjectGroup` canonical records.
- `plugins/quirky.worktree/main.ts:60-276`, `plugins/quirky.worktree/src/daemon/store.ts`, `plugins/quirky.worktree/src/daemon/list.ts`, `plugins/quirky.worktree/src/daemon/set.ts`: metadata migration/projection, display membership, activity and instance-safe assignment.
- `plugins/quirky.repo/src/groups.ts:24-94`, `plugins/quirky.repo/src/store.ts`: canonical hierarchy, normalization, subtree deletion and durable deletion record.
- New `plugins/quirky.sidebar-extras/`: public presentation preferences, activity projection and dirty activity-item plugin. It depends on worktree/repo, not vice versa. Git/session are optional consumers: unavailable facts are explicit unknown/unavailable states, never fake clean/live results.
- `plugins/quirky.worktree/src/{useTree,WorktreesSection,report,Tree,Menu,GroupDialogs}.tsx/ts`: preserve the existing sidebar and compose extras via public method calls. No cross-plugin implementation imports. When extras is disabled, ordinary sidebar functionality remains; membership metadata still belongs to worktree.
- `packages/protocol/src/ui.ts`, `packages/daemon/src/plugins/{ui-kinds,ui-model}.ts`, `packages/ui/src/plugins/{host,PluginSlot}.tsx/ts`, UI state resolution and shell layout: add a public code-backed `activity-item` slot. Keep main-header toggles, right-column bodies and one-panel selection.
- `packages/ui/src/components/SettingsDialog.tsx`, `packages/ui/src/plugins/settingsGroups.ts`: optional category/section metadata supports Appearance > Window & Sidebar without special-casing the built-in plugin.

No generic row-decoration framework or second sidebar renderer is introduced. Canonical list data stays in its owning plugins. Extras supplies visible IDs/reasons/preferences; the worktree renderer applies that visibility to its existing row model.

## Code references

Supports [logic decisions](logic.md#decisions-locked).

Absolute source root: `/Users/zpyoung/orca/workspaces/quirky/build-lane-5/`.

| Relative path and live anchor | Responsibility |
| --- | --- |
| `plugins/quirky.worktree/src/daemon/store.ts` `openWorktreeStore`, metadata projection | append migrations; retain legacy migrations unchanged |
| `plugins/quirky.worktree/src/daemon/list.ts` `joinMetadata`, `listEverything`, `listGroup` | project new fields; preserve `groupId` folder hosting; reconcile deleted-group references |
| `plugins/quirky.worktree/src/daemon/set.ts` `setWorktree`, `SetParams` | omission-safe membership, folder guard, instance/prior-membership CAS |
| `plugins/quirky.worktree/main.ts:196-207` `pruneRemovedRepos` | preserve existing repo cleanup; handle group release separately without deleting member metadata |
| `plugins/quirky.repo/src/groups.ts` `groupCreate`, `groupDelete`, `groupList` | hierarchy, deterministic cycle repair, tombstones, subtree release |
| `plugins/quirky.worktree/src/report.ts:57-125` `arrangeRows`, `buildTreeModel` | groups/loose rows/project placeholders/nesting; filter before placement, keep unfiltered ancestry for delete behavior |
| `plugins/quirky.worktree/src/WorktreesSection.tsx:27-95` `selectedWorktree`, `WorktreesSection` | layout observation, options/preferences, projection and report, dialogs |
| `plugins/quirky.worktree/src/Tree.tsx:39-79,95-279` `WorktreeCard`, `Tree` | repo chips, menus, drag targets, group hierarchy and separator rendering |
| `plugins/quirky.worktree/src/Menu.tsx:126-185` `workspaceMenu`, `projectMenu`, `groupMenu` | equivalent membership actions, folder project fallback, ellipsis-only group actions |
| `plugins/quirky.worktree/src/GroupDialogs.tsx` `NameForm`, group dialogs | prefilled selected name, create from worktree, delete text and metadata retention |
| `plugins/quirky.git/src/panel/data.ts` `useStatus`; `plugins/quirky.git/src/SourceControl.tsx` | existing status API/refresh reference; avoid importing private modules into extras |
| `packages/protocol/src/ui.ts:4-7,72-81,105-125,128-178` | public activity-item kind/model/state; category/section declarations |
| `packages/daemon/src/plugins/ui-model.ts:248-335` `buildUiModel` | resolve new slot through normal effective owner, ordering and lazy module rules |
| `packages/daemon/src/plugins/ui-kinds.ts:16-28,159-177` `checkUiKindEntry` | validate activity-item/category/section declarations |
| `packages/ui/src/plugins/PanelToggles.tsx` | DO NOT replace existing header toggles |
| `packages/ui/src/App.tsx`, `src/plugins/PluginSlot.tsx` | activity-item strip through standard plugin mount/unmount/report lifecycle |
| `packages/ui/src/components/SettingsDialog.tsx`, `src/plugins/settingsGroups.ts` | render declared category/section grouping generically |
| `plugins/quirky.terminal/test/e2e-ui/support.ts:99-220` | real daemon/headless window/CLI integration pattern; fresh temp home and cleanup |
| `packages/ui/test/exit.e2e.test.ts` | distro override and `ui state` acceptance precedent |

Language-server status was probed: no language servers configured. Use existing semantic/manual reference enumeration; do not claim LSP reference coverage. Exported type additions require every factory/caller to be updated or verified consistent.

## Contracts & interfaces

### Canonical membership and hierarchy

Satisfies [SC-01–SC-07](logic.md#sc-01-create-a-group-from-one-worktree).

- Extend `Worktree` with `projectGroupId: string | null`, `lastActivityAt: number`, and `instanceId: string`. These are required output fields. Keep `groupId`, `repoId`, `parentId`, path and all existing semantics.
- Append worktree migrations for membership, activity and stable instance token. Instance must change for a different filesystem object at the same path; use birthtime plus device/inode identity where available, never createdAt alone. For zero-birthtime filesystems, hold an open directory handle across asynchronous create-group work, then compare its fstat device/inode to the current path immediately before assignment; the held handle prevents inode reuse from passing the check. Always close the handle. If reliable identity cannot be obtained, refuse delayed assignment explicitly rather than accepting a random token as replacement proof. Include a zero-birthtime path-replacement regression.
- `quirky.worktree/set` accepts optional nullable `projectGroupId`; omission leaves it untouched. Assignment requires Git workspace and Git owning repo. Explicit clear on a folder with impossible/corrupt membership may clean it; ordinary assignment must reject, not silently vanish.
- Add optional `expectedInstanceId` and `expectedProjectGroupId` CAS fields to the mutation. Mismatch is a conflict with no membership mutation. Re-resolve identity immediately before writing, after any async group creation/list work. Ordinary unrelated metadata edits do not need CAS.
- Add `quirky.worktree/createGroup` with worktree selector, name, expected instance/prior membership; create group via repo public API then conditionally assign. Return `{group, worktree, assigned}`; stale assignment returns `assigned:false` with an explicit reason, leaves the created group empty, never reports a move that did not happen. Delete/path replacement/concurrent regroup are separate regressions.
- Add `ProjectGroup.parentId: string | null`; extend groupCreate with optional parent and add groupSetParent (selector + nullable parent). Missing/self/cyclic new parents reject before mutation. Persisted data normalizes self/missing parent to null and deterministically cuts the closing edge when walking groups ordered by order then ID; emit all groups exactly once in the tree. Group deletion includes descendants.
- Private plugin stores do not support cross-store transactions. Repo commits deletion plus durable deleted IDs in its own transaction. Expose `quirky.repo/groupDeletedIds` read method. Worktree public `releaseGroups({groups:string[]})` clears only display membership and preserves metadata; normal worktree list/set reconciles durable deleted IDs, so a disabled/unloaded worktree plugin cannot resurrect deleted membership on reactivation. Releasing is idempotent. Do not clear a merely unknown/hidden group: only a recorded deleted ID. Public failure paths must not claim atomic cross-store rollback.
- Existing group-folder deletion semantics stay intact; loose Git worktrees are never deleted by deleting a group. No reverse static plugin dependency or private-store access.

### Worktree activity

Satisfies [SC-09](logic.md#sc-09-rolling-time-cutoffs-and-fallbacks), [SC-10](logic.md#sc-10-live-only-and-default-branch-exception), [SC-13](logic.md#sc-13-recency-restart-and-client-isolation).

Worktree activity advances monotonically from associated session lifecycle/activity events, including session creation/change/finish/restore and agent updates carrying activity evidence. Worktree listens through public events and session API where needed; do not create a session→worktree import/dependency cycle. A removed session cannot erase already observed worktree activity. Projection may also max current session activity. Do not claim PTY-byte freshness unless implemented through the public PTY fact stream; live session and agent runtime facts, not saved layout, determine sleeping. Relevant live PTY data is available through public `PluginContext.pty.list()`; structured running sessions use their owning public API. Folder rows bypass the Live-only sleeping sweep, but not time filters. Selected Git rows and default-main exception stay visible.

Unknown/unavailable liveness conservatively keeps an unselected non-main Git workspace visible under Live only. Projection reports `live: null` and the unavailable provider/error, never labels the row live. A missing future browser feature contributes no browser fact; an existing provider's failed query must not be treated as authoritative sleeping. UI can show the report's availability notice. Folder rows bypass the sweep independently of provider availability.

### Presentation plugin API

Satisfies [SC-08–SC-13](logic.md#sc-08-activity-window-controls-badge-and-clear), [SC-17](logic.md#sc-17-public-plugin-and-scripting-contracts).

`quirky.sidebar-extras` is a lazy built-in with its own manifest, daemon module, UI module, API methods/events and CLI group `sidebar-extras`. It consumes canonical public APIs only. It owns no repo/worktree mirror table.

SCHEMA: preferences keyed by `client` (nonempty string, default `desktop`): `workspaceActivityWindow: 'all'|'live-only'|'today'|'week'|'month'|'custom'`, `workspaceActivityCustomDays: number` positive safe integer (default 30), `alwaysShowDefaultBranchWorkspace: boolean` (default true), `workspaceActivityWindowBeforeLiveOnly` (non-live mode, default All). Persistent last visits are keyed by workspace identity; exit stamps and current activation are session-lived, not serialized.

CONTRACT: methods `state({client?})`, `set({client?,workspaceActivityWindow?,workspaceActivityCustomDays?,alwaysShowDefaultBranchWorkspace?,hideSleepingWorkspaces?,showSleepingWorkspaces?})`, `activate({client?,worktree:string|null})`, `projection({client?})`, `dirty({worktree?:string|null})`. Declare full result schemas and generated CLI commands `state`, `set`, `activate`, `projection`, `dirty`. `set` rejects invalid values before any mutation. `activate` atomically stamps previous departure and next visit in its state update; it records recency, not a second execution registry. UI calls it when daemon layout's worktree changes; command/API consumers may do the same. Expose current activation, visit/exit stamps and preferences in state for verification. State must not make a merely read method mutate recency. Input changes outside the sidebar still trigger layout observation.

Entering Live only remembers the previous non-Live mode; toggling sleeping back on restores that mode (All only if there was no prior mode). Explicit window wins over legacy fields. Legacy hide-sleeping true selects Live only; false/show=true lifts Live only to the remembered window but never widens an already selected non-Live time window. No obsolete runtime routes or shim aliases; optional patch fields implement the source's merge semantics. Hydration validates enum, boolean and custom fields; corrupt custom days fall back to 30.

`projection` returns preferences, selected ID, `visibleIds`, `hiddenIds`, `hiddenCount`, `filterCount`, and per-workspace effective activity/liveness reasons sufficient to compare the drawn filter with API state. It reads canonical worktrees/repos/sessions/runtime facts, not caller-supplied fake rows. For All no cutoff; otherwise rolling cutoff `now - days*86_400_000` with overflow-safe arithmetic. Compare inclusive. Activity=max(canonical worktree/session activity, last visit, last exit), then positive creation, then repo addedAt. Active selected row is never hidden. Preserve main only for Live when exception true. Folder rows stay under Live.

API clock uses runtime Date.now, with injectable clock only at construction/testing, never a public “set production time” test endpoint. UI refreshes projection on canonical/session/sidebar/settings/layout events and a 60s timer only while a time window is selected. Concurrent load tickets prevent stale preference/projection results. Coalesce refreshes to avoid event loops. `changed` events are emitted after preference/activation mutation, not on reads.

`dirty` uses `quirky.git/status` for requested selector, or active workspace from daemon ui layout when omitted; explicit null is no active. Return `{worktreeId,count,capped,title,dirty,available,error?}`. Count `entries` (staged/unstaged/untracked/conflict panel rows) excluding any future `submoduleRoot` detail entries; never unique paths. No active/clean has stock Source Control title. Unavailable status clears decoration and reports unavailability/error rather than manufacturing cleanliness. Existing git status is not duplicated or persisted.

### Public UI slot and setting metadata

Satisfies [SC-14–SC-17](logic.md#sc-14-active-dirty-marker-including-count-boundaries).

Add `activity-item` to public UI and code-backed kinds, slot entry/state unions and model `activityItems`. Declaration has title/order like sidebar-section. Use ordinary module resolution, provide/mount, override, errors, reports, deactivate cleanup and `ui.state` shown/report handling. Shell renders a compact right-side strip even when the panel is closed; it does not move panels or remove header toggles. UI host must not special-case `quirky.sidebar-extras` or Git. An item's plugin owns its icon/button DOM and toggles the existing Source Control panel through public UI context. No new badge/context global is necessary.

The extras UI provides `activity-item:quirky.sidebar-extras/source-control`, draws branch icon and optional dot with title/aria text, reports active ID/count/capped/title/availability, and updates at the existing status-poll cadence (3s safety while item mounted), on git/canonical/layout/reconnect events. Keep latest-ticket/identity guard and cancel/ignore after unmount. Errors clear stale decoration and remain visible as status/report information. No unbounded polling work while UI item is unmounted.

Extend SettingDeclaration with optional `category?:string`, `section?:string`; reject empty/non-string fields. Preserve uncategorized plugin settings grouping. Render categorized settings generically. Extras declares boolean `sidebarSectionSeparators` default true, category Appearance, section Window & Sidebar. UI reads full setting ID and reacts to setting changes. No hardcoded plugin ID or setting label in shell.

### Existing sidebar renderer integration

Satisfies [SC-01–SC-16](logic.md#behavior--scenarios).

Keep `buildTreeModel`/`arrangeRows`, extend their models for hierarchy/loose rows/visibility. Separate full canonical descendants (delete behavior) from filtered/natural section nesting (display child chips), so filtering/grouping cannot hide descendants from destructive confirmation. Missing group falls back without erasing metadata. Loosely grouped rows retain execution repo chip. Every repo exists once even if its remaining worktree list is empty. Pinned duplicates retain the same canonical identity and membership actions.

Add Workspace options/Filters control with six exact labels, Custom days inline input and validation, Except default branch under Live, badge and Clear filters. Hidden-count action remains visible in empty state. Group header ellipsis is sole menu trigger; no right-click menu. Dialog default text is selected on initial focus. Drag measures current painted header rectangles inside plugin-owned DOM, including sticky geometry, honors header-over-leave precedence and ignores invalid/current targets. Provide menu alternatives; cancel cleans preview. Add a pure membership-target resolver for deterministic geometry edge tests.

Eligible Git worktree cards also expose Move project to group when groups exist; it calls the existing public repo groupAdd/groupRemove path and moves the entire owning repo independently of the selected worktree's loose membership. Folder rows expose these project actions without offering worktree membership.

Separators use pseudo-element, no height change. Compute eligibility from logical top-level boundaries plus sticky/host context; no leading/nested/sticky line. Public reports include applied filter, hidden count, visible placement, group depth, separator state and current dialogs. Disabled extras falls back to the original sidebar without global error swallowing; catch only missing/disabled contribution conditions as optional absence, propagate/report ordinary errors. Do not hard-depend worktree on extras.

## Data models / schemas

See [logic Decisions Locked](logic.md#decisions-locked) for behavior; exact public fields are specified above. Append private migrations, reflect required output additions in manifests and every factory, and keep command catalogs consistent. Group parent and worktree membership fields are different. Membership CAS is optional on ordinary set, mandatory on create-from-worktree's delayed assignment. Public positive integer validation uses safe-integer bounds, not finite-number alone.

## DO-NOT-CHANGE fences

Supports [logic scope](logic.md#scope--non-goals).

- `docs/loop/LOOP.md`, `scripts/build-loop/**`, shared queue/DECISIONS index: protected workflow, never edit.
- External feature docs/Orca source: read-only requirements, never write.
- Existing store migrations: append only, because installed stores have already applied them.
- Worktree remove/create filesystem protections, branch cleanup, hook trust and repo ownership: unchanged except identity projection needed here; prevents data loss unrelated to grouping.
- `packages/ui/src/plugins/PanelToggles.tsx` existing toggle placement and `App` one-panel/right-column semantics: retain D10.
- Mount boundary: plugins may access their own container only, never shell DOM or another plugin's store/private exports.
- Inherited `.serena/`: user/runtime state, not this item; do not add/remove.

## Always / Ask / Never

Supports [logic surfaces](logic.md#surfaces-and-autonomous-approval).

Always: public calls, declared schemas, full cutover of callers, deterministic temp-home tests, cleanup started processes, CAS protection, source-aligned empty/errors, per-client preference isolation. Before exported changes enumerate references; LSP unavailable was verified.

Ask: no human questions in the unattended loop. Record decisions autonomously. A real locked-decision conflict halts and formally blocks the item under LOOP.md; missing APIs are implementable work.

Never: mirror repo/worktree registries, infer live from recency, change repo ownership when regrouping, fake absent Git/runtime facts, rewrite production timestamps for tests, add unimplemented controls, create a reverse static dependency cycle, suppress normal operational errors as optional plugin absence, run tests against real user state.

## Cross-cutting

Supports [logic scope](logic.md#scope--non-goals).

Security: same local token/public dispatch and strict schemas; no new transport. Native/Linux/Windows specifics are not introduced; drag geometry and public slots need later platform smoke, recorded as deferred: platform. Persistence: separate plugin stores; durable group-deletion reconciliation prevents reference resurrection without pretending atomic cross-store writes. Rollback: disabling extras removes its contribution/controls, not canonical data. Observability: projection/state and item reports are API facts; no telemetry. Performance: reuse existing status API, avoid reads causing writes/events except established canonical reconciliation, no idle hidden renderer instances or duplicate history.

## Testing strategy

Implements every [logic scenario](logic.md#behavior--scenarios). Tests are acceptance behavior, not manifest/source string snapshots.

- Canonical membership/hierarchy API tests: new `plugins/quirky.worktree/test/sidebar-membership.test.ts` and `plugins/quirky.repo/test/sidebar-groups.test.ts`, using existing plugin harnesses and temporary real repo/folder state. SC-01–07, release during disable/reactivation, identity and group-cycle races. CLI acceptance through generated `wt set`, create-group and repo group commands.
- New extras plugin tests `plugins/quirky.sidebar-extras/test/activity.test.ts`, `api.test.ts`, `dirty.test.ts`, `cli.test.ts`: dispatch state/set/activate/projection/dirty; SC-08–15,17; deterministic injected clock boundary and quiet-aging logic. Process-starting tests set fresh temp QUIRKY_HOME and HOME and always kill children.
- Public UI tests beside daemon/UI plugin tests for activity-item mount/override/disable/report and categorized settings; no tautological kind-array snapshots.
- Sidebar renderer tests `plugins/quirky.worktree/test/sidebar-extras-ui.test.ts` and real daemon/window/CLI test `sidebar-extras.e2e.test.ts`: drive controls, membership, hidden count, custom Enter/Tab, reports, dirty switch races, separator geometry, group deletion and unchanged full descendants. Pure geometry resolver tests supplement actual web drag smoke rather than replacing it.
- Delete tests that pin obsolete menu wording/implementation details; do not re-pin them. Preserve meaningful preexisting behavioral tests.
- Orchestrator runs task-scoped files after workers return, then `bun run test` (remote suite runner only), `bun test scripts`, `bun run typecheck`, `bun run build`. No full raw `bun test` suite on this Mac.
- Actual web UI: built app, fresh temp HOME/QUIRKY_HOME, daemon UI URL, `using-apps-like-a-user --surface web --owner yours --unattended` for all visible goals. Record tool-only blocked/partial reports, fix app failures, stop daemon/PTY and delete temp homes. No native-only scenario in this item.

## Non-goals

See [logic scope & non-goals](logic.md#scope--non-goals). No review cache/filter, ledger implementation/navigation, remote/mobile transport, whole-sidebar replacement, generic row-provider framework, filesystem cleanup refactor, unrelated stock options, artificial production time setter, or new native shell behavior.

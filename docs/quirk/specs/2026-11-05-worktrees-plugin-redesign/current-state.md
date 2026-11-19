# Worktrees: current state

Walked 2026-11-06 on the fixture at 1280x720, dark, with the Worktrees tool (left slot) and Changes (right slot) open. g16 was walked in the user's own Quirky window, which has no remote hosts or VMs.

The fixture held three projects (ui-review-fixture, harbor-api, ledger-web) with seven worktrees. The seed added spike-delete-me (to delete), old-experiment in harbor-api (archived eight days ago), and an unregistered repo, inbox-service, to add as a project.

## Where things live

- **Worktrees tool**, left slot, opened from the top of the left tool rail. The list is projects, each with its worktrees as two-line rows: name, then activity · branch.
- **Sidebar header**: Add project (folder icon), Worktrees options (funnel icon), Minimize. The icons show only while the sidebar is hovered or focused.
- **Project header**, hover only: `+` new worktree in this project, `…` project menu (Open ledger, Project Settings…, New Group from Project…, Move to Group, Remove Project…). The project header disappears when grouped by status.
- **Row `…` menu**, hover or selected only: Rename…, Archive, Move to Status, Open in (Terminal, Changes), Copy Path, Copy Worktree Name, Pin/Unpin, Mark Unread, Set Parent Worktree…, Sleep/Wake, Delete, New group from worktree…. Add worktree to group and Move project to group appear only once a group exists.
- **Group header**: collapse chevron and `…` menu (Open ledger, Rename…, Delete Group…).
- **Options popover** (funnel icon): a "Show N filtered worktree" button, then three collapsibles. Workspace options holds group, sort, card and visibility settings plus Review cleanup. Activity filters holds the time window and hide toggles. More workspace tools holds Workspace board and Edit workspace statuses.
- **Window bar**: All projects, worktree selector, New worktree `+`, back and forward.
- **Remote workspaces**: a tool on the right rail. It holds a VM environments button, a Saved owner runtime field and Register host.
- **VM environments**: a view that opens as a center tab from that button.
- **Remote workspace view**: opens from a remote workspace row. There were none to open.
- **Command palette** (⌘K): All, Worktrees, Commands, Files tabs.

## The walk

### g1: Create a new worktree in a project

Result: partial. The project `+` (hover only) opens New workspace, with Smart, GitHub, Branch and Name tabs plus Base, Agent and Advanced. Creating walk-new added a row, raised the count from 4 to 5 and opened a terminal. The Create act came back UNSETTLED while the terminal spawned, so the walk has no clean proof of the effect.

![Sidebar at rest](img/current/01-sidebar-initial.png)
![New workspace dialog](img/current/03-create-dialog.png)
![Filled dialog](img/current/04-create-dialog-filled.png)
![Worktree created](img/current/05-worktree-created.png)

### g2: Switch to another worktree and see it open in the center

Result: pass. Clicking a row changes the window-bar selector, the center terminal and the Changes panel. The selected row is a saturated blue block.

![Selected worktree](img/current/02-worktree-selected-ui-review-ready.png)
![Switched, with hover actions](img/current/06-switch-worktree-hover-actions.png)

### g3: Rename a worktree

Result: pass. Rename… opens a "Workspace details" dialog (Display Name, Notes, linked work, Reference URL and label). Only the display name changes, so the subtitle still shows the old branch name.

![Row actions menu](img/current/07-row-actions-menu.png)
![Workspace details dialog](img/current/08-rename-workspace-details-dialog.png)
![Renamed](img/current/09-renamed-display-name.png)

### g4: Pin a worktree, then unpin it

Result: pass. Pin adds a PINNED section at the top, and the worktree is also still listed under its project. Unpin removes the section.

![Pinned section](img/current/10-pinned-section.png)
![Unpinned](img/current/11-unpinned.png)

### g5: Group the list by status and sort it by name

Result: pass. Both live under Workspace options in the options popover. Status groups stay inside each project ("UI-REVIEW-FIXTURE · IN PROGRESS"), so there is no single "In review" list across projects, and the project controls disappear.

![Options popover](img/current/12-options-popover.png)
![Workspace options expanded](img/current/13-workspace-options-expanded.png)
![Grouped by status, sorted by name](img/current/14-group-by-status-sort-name.png)

### g6: Move a worktree to a different status

Result: pass. Move to Status offers Todo, In progress, In review and Done. walk-renamed moved to In review.

![Move to Status submenu](img/current/15-move-to-status-submenu.png)
![Moved to In review](img/current/16-moved-to-in-review.png)

### g7: Put a worktree to sleep, then wake it

Result: pass. Sleep shows only as the word "Sleeping" in the subtitle, with no icon or dimming. The menu item flips to Wake, which reverses it.

![Sleeping row](img/current/17-sleeping-row.png)

### g8: Nest one worktree under another as its parent

Result: pass. Set Parent Worktree… is one select listing every worktree in every project. The child is indented under a "1 child" chip that takes a line of its own.

![Set parent dialog](img/current/18-set-parent-dialog.png)
![Nested child](img/current/19-nested-child-worktree.png)

### g9: Delete a worktree

Result: pass. Delete opens a "Delete Workspace" confirmation showing the folder path and a "Don't ask again" option. spike-delete-me was removed.

![Delete confirmation](img/current/20-delete-confirm-dialog.png)
![After delete](img/current/21-after-delete.png)

### g10: Add a second project

Result: pass. The header folder icon opens Add project (Path, Browse, Add). inbox-service appeared as a new project.

![Add project dialog](img/current/22-add-project-dialog.png)
![Project added](img/current/23-project-added-inbox-service.png)

### g11: Review cleanup suggestions for archived worktrees

Result: pass. Review cleanup sits at the bottom of Workspace options, below the popover's visible area. The dialog lists old-experiment with a checkbox, Ignore, Restore ignored suggestions, Refresh preview and Delete selected. The walk selected it and stopped before deleting.

![Popover clipped at the top](img/current/24-options-popover-clipped.png)
![Scrolled to Review cleanup](img/current/25-options-popover-scrolled-review-cleanup.png)
![Cleanup dialog](img/current/26-review-cleanup-dialog.png)
![Item selected](img/current/27-cleanup-item-selected.png)

### g12: Put worktrees from two different projects into one group

Result: pass, though the path is hard to find. "New group from worktree…" creates a project group, and only then does "Add worktree to group" appear on other rows. One group held retry-queue (harbor-api) and ui-review-notes (ui-review-fixture). The group sits above the project list with no icon and is named "<worktree> group".

![New project group dialog](img/current/28-new-project-group-dialog.png)
![Group created](img/current/29-project-group-created.png)
![Add worktree to group](img/current/30-add-worktree-to-group-submenu.png)
![Cross-project group](img/current/31-cross-project-group.png)
![Group actions](img/current/32-group-actions-menu.png)
![Grouped by project with a group](img/current/33-grouped-by-project-with-group.png)
![Project actions](img/current/34-project-actions-menu.png)

### g13: Tag two worktrees and filter the list to that tag

Result: blocked. No tag control exists in the row, project or group menus, the details dialog, the options popover or the command palette.

![Command palette, no tags](img/current/35-command-palette-no-tag.png)
![Activity filters](img/current/36-activity-filters.png)
![More workspace tools](img/current/37-more-workspace-tools.png)

### g14: Group the list by tag

Result: blocked. Group by offers only Project, Status, Pull request and None (see 13-workspace-options-expanded.png).

### g15: Save the current grouping and filters as a view, switch to it, then go back to all worktrees

Result: blocked. Grouping, sort and filters are one global setting with no way to save or switch between sets. "Worktree View" in the palette only opens the tool.

![Palette, no saved views](img/current/38-command-palette-no-saved-views.png)

### g16: See a remote workspace and the VM environments list

Result: partial (real app). Remote workspaces opened in the right slot showing "No owner hosts registered.", and VM environments opened as a center tab showing "No VM environments recorded." With no remote workspace in the app, the Remote workspace view could not be reached.

![Real app Worktrees sidebar](img/current/90-real-app-worktrees.png)
![Remote workspaces, empty](img/current/91-real-app-remote-workspaces-empty.png)
![VM environments, empty](img/current/92-real-app-vm-environments-empty.png)

## Capabilities

| Capability | Where it lives |
|---|---|
| Create worktree (Smart, GitHub, Branch, Name; Base; Agent; Advanced; Create more) | project `+` (hover), window-bar `+`, New worktree command |
| Select worktree | click a row |
| Rename display name, notes, linked references | row `…` > Rename… (Workspace details dialog) |
| Archive | row `…` |
| Move to status (Todo, In progress, In review, Done) | row `…` > Move to Status |
| Open in Terminal or Changes | row `…` > Open in |
| Copy path, copy worktree name | row `…` |
| Pin, unpin | row `…` |
| Mark unread | row `…` |
| Set parent worktree (nesting, "N child" chip) | row `…` > Set Parent Worktree…, Remove from Parent |
| Sleep, wake | row `…` |
| Delete with confirmation | row `…` > Delete |
| Project groups: create from worktree or project, add worktree, move project, rename, delete, collapse, open ledger | row `…`, project `…`, group `…` |
| Add project (path or Browse) | sidebar header folder icon, Add project command |
| Project settings, remove project, open ledger | project `…` |
| Manual project order | Workspace options (up and down arrows) |
| Group by Project, Status, Pull request, None | options popover > Workspace options |
| Sort by Recent, Agent activity, Name, Project, Manual | options popover > Workspace options |
| Project order Manual or Recent activity | options popover > Workspace options |
| Compact cards; show properties (branch, notes, PR, issue, automation, activity) | options popover > Workspace options |
| Show sleeping; hide CLI-created, other desktop clients, default branch, detached HEAD, archived; external worktrees default; per-project visibility | options popover > Workspace options |
| Reveal filtered worktrees | options popover > "Show N filtered worktree" |
| Review cleanup: select, ignore, restore ignored, refresh preview, delete selected | options popover > Workspace options > Review cleanup |
| Activity window (All, Live only, 24 hours, 7 days, 30 days, Custom); hide merged or closed reviews, passing checks, automation-created; clear filters | options popover > Activity filters |
| Workspace board; edit workspace statuses | options popover > More workspace tools |
| Navigation history and index (Mod+Alt+Left/Right, Mod+Shift+Up/Down, Mod+1…9) | keyboard |
| Remote workspaces: saved owner runtime, register host | right rail > Remote workspaces |
| VM environments: create from a recipe, refresh lifecycle, backend diagnostics, recorded list | Remote workspaces > VM environments |
| Settings: worktrees folder, nest by project, branch prefix, confirm before deleting | Settings |

## Bugs

- The cleanup row runs the worktree name into its reason, which shows the raw code "archived-7day" instead of a sentence, because only `idle-clean` gets readable text. Screenshot: img/current/26-review-cleanup-dialog.png. Cause: `plugins/quirky.worktree/src/CleanupDialog.tsx:127`.
- The options popover opens past the top of the window. The "Show 1 filtered worktree" row is clipped under the window bar, and Review cleanup starts off screen. Screenshot: img/current/24-options-popover-clipped.png. Cause: `plugins/quirky.worktree/src/WorktreesSection.tsx:573` with the fixed-position popover in `packages/ui/src/design-system/components.css:1411`.
- "Show 1 filtered worktree" doesn't say what is filtered or why (here, one archived worktree). Screenshot: img/current/13-workspace-options-expanded.png. Cause: `plugins/quirky.worktree/src/StockOptions.tsx:78`.
- A pinned worktree is listed twice, under PINNED and under its project. Screenshot: img/current/10-pinned-section.png. Cause: not found.
- The same object goes by three names: the menu says Delete and New worktree, the dialogs say Delete Workspace and New workspace, and Rename… opens "Workspace details". Screenshot: img/current/20-delete-confirm-dialog.png. Cause: `plugins/quirky.worktree/src/DeleteDialog.tsx:47`, `plugins/quirky.worktree/src/Menu.tsx`.

## Design themes

- **Hover-only controls.** Row `…`, project `+` and `…`, and the header icons are invisible at rest (`packages/ui/src/design-system/worktree-tree.css:69`). The walk could only reach them by clicking where they appear on hover.
- **One global lens.** Grouping, sort and filters are one setting with no saved views and no quick way back to "all". The popover gives no summary of what is active beyond "Activity filters 0".
- **Organizing stops at the project.** Status grouping can't cross projects. Groups are "project groups" you find only after making one from a worktree. There are no tags or labels at all.
- **The options popover is a long sheet.** Three nested collapsibles of checkboxes, scrolling and clipped, mixing layout, filters, maintenance (cleanup) and tools (board, statuses).
- **State is text.** Idle, Running, Sleeping and In review are words in a dim subtitle. The status dot is the same grey for every state, and sleeping has no visual treatment.
- **Weak hierarchy in rows.** Two lines per row, with a subtitle that truncates fast ("Idle · ui-review-fixture · …"). The bright blue selected block and the blue "Unread" badge (90-real-app-worktrees.png) overpower everything else.
- **Nesting costs a line.** The "1 child" chip takes its own row, and a child leaves its status group.
- **Rename isn't rename.** It edits a display name only, so the branch subtitle keeps the old name.

## Before scores

| Surface | Dark | Light |
|---|---|---|
| Worktrees section | 73 | 74 |
| Remote workspaces section | 72 | 74 |
| VM environments view | 78 | 64 |
| Remote workspace view | not scored | not scored |

Read from `scores/before.json`. The Remote workspace view can't render on the fixture (`workspace must be a registered remote mirror ID`), so it was left out of the run. The reviewer's main notes on the Worktrees section: header actions hidden, Unread badges breaking the name alignment, and low-contrast secondary text.

## Goals not walked

- g16, the Remote workspace view part: the user's app has no remote workspace to open.

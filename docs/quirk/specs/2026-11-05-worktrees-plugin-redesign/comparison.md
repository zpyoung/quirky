# Worktrees: before and after

## Still failing

- view:quirky.worktree/environments: light 76 below 85
- sidebar-section:quirky.worktree/worktrees: dark 74 below 85; light 46 below 85; light 46 below before 74
- sidebar-section:quirky.worktree/remote-workspaces: dark 73 below 85
- g7 Put a worktree to sleep, then wake it: Sleep dims the row and Wake restores it on screen, but the harness got no OBSERVED act (Sleep UNSETTLED, Wake NO_EFFECT), so the replay can't prove it
- g12 Put worktrees from two different projects into one group: The cross-project section was created and filled on screen, but every Move to section act returned UNSETTLED (running-terminal spinners), so the replay can't prove it

## Goals

| Goal | Before | After | Result |
| --- | --- | --- | --- |
| Create a new worktree in a project | <img src="img/current/05-worktree-created.png" width="420"> | <img src="img/after/05-worktree-created.png" width="420"> | ✓ replayed |
| Switch to another worktree and see it open in the center | <img src="img/current/06-switch-worktree-hover-actions.png" width="420"> | <img src="img/after/06-switch-worktree-hover-actions.png" width="420"> | ✓ replayed |
| Rename a worktree | <img src="img/current/09-renamed-display-name.png" width="420"> | <img src="img/after/09-renamed-display-name.png" width="420"> | ✓ replayed |
| Pin a worktree, then unpin it | <img src="img/current/10-pinned-section.png" width="420"> | <img src="img/after/10-pinned-section.png" width="420"> | ✓ replayed |
| Group the list by status and sort it by name | <img src="img/current/14-group-by-status-sort-name.png" width="420"> | <img src="img/after/14-group-by-status-sort-name.png" width="420"> | ✓ replayed |
| Move a worktree to a different status | <img src="img/current/16-moved-to-in-review.png" width="420"> | <img src="img/after/16-moved-to-in-review.png" width="420"> | ✓ replayed |
| Put a worktree to sleep, then wake it | <img src="img/current/17-sleeping-row.png" width="420"> | <img src="img/after/17-sleeping-row.png" width="420"> | ✗ failed: Sleep dims the row and Wake restores it on screen, but the harness got no OBSERVED act (Sleep UNSETTLED, Wake NO_EFFECT), so the replay can't prove it |
| Nest one worktree under another as its parent | <img src="img/current/19-nested-child-worktree.png" width="420"> | <img src="img/after/19-nested-child-worktree.png" width="420"> | ✓ replayed |
| Delete a worktree | <img src="img/current/21-after-delete.png" width="420"> | <img src="img/after/21-after-delete.png" width="420"> | ✓ replayed |
| Add a second project | <img src="img/current/23-project-added-inbox-service.png" width="420"> | <img src="img/after/23-project-added-inbox-service.png" width="420"> | ✓ replayed |
| Review cleanup suggestions for archived worktrees | <img src="img/current/26-review-cleanup-dialog.png" width="420"> | <img src="img/after/26-review-cleanup-dialog.png" width="420"> | ✓ replayed |
| Put worktrees from two different projects into one group | <img src="img/current/31-cross-project-group.png" width="420"> | <img src="img/after/31-cross-project-group.png" width="420"> | ✗ failed: The cross-project section was created and filled on screen, but every Move to section act returned UNSETTLED (running-terminal spinners), so the replay can't prove it |
| Tag two worktrees and filter the list to that tag | <img src="img/current/35-command-palette-no-tag.png" width="420"> | <img src="img/after/36-filtered-to-tag.png" width="420"> | ✓ replayed |
| Group the list by tag | <img src="img/current/13-workspace-options-expanded.png" width="420"> | <img src="img/after/37-grouped-by-tag.png" width="420"> | ✓ replayed |
| Save the current grouping and filters as a view, switch to it, then go back to all worktrees | <img src="img/current/38-command-palette-no-saved-views.png" width="420"> | <img src="img/after/38-saved-view-active.png" width="420"> | ✓ replayed |
| See a remote workspace and the VM environments list | <img src="img/current/92-real-app-vm-environments-empty.png" width="420"> | <img src="img/after/92-real-app-vm-environments.png" width="420"> | ✓ replayed |

## Scores

| Surface | Before (dark / light) | After (dark / light) | Result |
| --- | --- | --- | --- |
| view:quirky.worktree/environments | 78 / 64 | 87 / 76 | ✗ light 76 below 85 |
| sidebar-section:quirky.worktree/worktrees | 73 / 74 | 74 / 46 | ✗ dark 74 below 85; light 46 below 85; light 46 below before 74 |
| sidebar-section:quirky.worktree/remote-workspaces | 72 / 74 | 73 / 89 | ✗ dark 73 below 85 |

## Capabilities

| Capability | Decision |
| --- | --- |
| Create worktree (Smart, GitHub, Branch, Name; Base; Agent; Advanced; Create more) | kept |
| Select worktree | kept |
| Rename display name, notes, linked references | moved to the name is renamed inline; notes and links go to row `…` › More › Details… |
| Archive | moved to row `…` › More › Archive |
| Move to status | kept |
| Open in Terminal or Changes | kept |
| Copy path, copy worktree name | moved to row `…` › Copy |
| Pin, unpin | moved to row `…` › More › Pin or Unpin; a pinned worktree shows once |
| Mark unread | moved to row `…` › More |
| Set parent worktree, remove from parent | moved to row `…` › More; the child count sits on the parent row instead of its own line |
| Sleep, wake | kept |
| Delete with confirmation | kept |
| Project groups (create, add worktree, move project, rename, delete, collapse, open ledger) | moved to sections: section `+` creates one, Move to section or drag adds, and section `…` renames, deletes and opens the ledger |
| Add project (path or Browse) | moved to header `…` › Add project, plus the empty state; the command stays |
| Project settings, remove project, open ledger | kept |
| Manual project order | moved to project `…` › Move up and Move down, when Display › Project order is Manual |
| Group by Project, Status, Pull request, None | moved to Display › Group by, which adds Section and project, and Tag |
| Sort by Recent, Agent activity, Name, Project, Manual | moved to Display › Sort by |
| Project order Manual or Recent activity | moved to Display › Project order |
| Compact cards; show properties | cut: rows are always one line, with one right-side fact chosen in Display, and the other properties are in the hover card |
| Show sleeping; hide CLI-created, other desktop clients, default branch, detached HEAD, archived; external worktrees default; per-project visibility | moved to Show asleep to Display; the hide toggles to Filter › Hide; per-project visibility to Filter › Projects; the external worktrees default stays in Settings |
| Reveal filtered worktrees | moved to the filter line ("2 hidden: archived · Show") |
| Review cleanup (select, ignore, restore ignored, refresh preview, delete selected) | moved to header `…` and the footer line; every action kept |
| Activity window; hide merged or closed reviews, passing checks, automation-created; clear filters | moved to Filter › Activity, Filter › Hide and Clear filters |
| Workspace board; edit workspace statuses | moved to header `…` |
| Navigation history and index shortcuts | kept |
| Remote workspaces: saved owner runtime, register host | kept |
| VM environments: create from a recipe, refresh lifecycle, backend diagnostics, recorded list | kept |
| Settings: worktrees folder, nest by project, branch prefix, confirm before deleting | kept |

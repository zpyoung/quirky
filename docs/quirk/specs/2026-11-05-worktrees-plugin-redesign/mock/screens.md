# Screens (mock v1)

## Worktrees, All (`all`)

See every worktree in sections and projects, spot what needs you, switch to one.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | filtered |  |
| state | empty |  |
| skipped state | loading | the list comes from the local daemon and renders at once |
| skipped state | error | a daemon disconnect is handled by the shell, not this panel |
| element | Display (`display-btn`) | Button |
| element | Filter (`filter-btn`) | Button |
| element | New worktree (`new-btn`) | IconButton |
| element | Header … menu (`more-btn`) | IconButton |
| element | View strip (`view-strip`) | Tabs |
| element | All tab (`view-tab-all`) | Tabs |
| element | Needs you tab (`view-tab-needs-you`) | Tabs |
| element | Needs you count (`needs-you-count`) | Badge |
| element | Saved view tab (`view-tab-release`) | Tabs |
| element | More views (`view-overflow`) | PopupMenu |
| element | Section header (`section-header`) | SectionHeader |
| element | Project header (`project-header`) | SectionHeader |
| element | Attention count (`attention-count`) | Badge |
| element | Section + and … (`header-actions`) | IconButton |
| element | Worktrees rail icon (`rail-worktrees`) | IconButton |
| element | Worktree row (`row`) | ListRow |
| element | Agent activity mark (`state-mark`) | StatusDot |
| element | Tag chip (`tag-chip`) | gap |
| element | Right-side fact (`row-fact`) | ListRow |
| element | Unread dot (`unread-dot`) | Badge |
| element | Row … button (`row-more`) | IconButton |
| element | Child chevron (`child-chevron`) | IconButton |
| element | Child count (`child-count`) | Badge |
| element | Child worktree row (`child-row`) | ListRow |
| element | Cleanup footer line (`cleanup-footer`) | gap |
| element | Filtered line (`filter-line`) | gap |
| element | Active filter chip (`filter-chip`) | ScopeChip |
| element | Hidden count (`hidden-note`) | gap |
| element | No projects (`empty-state`) | EmptyState |
| element | Add project (`add-project-btn`) | Button |
| element | Bulk bar (`bulk-bar`) | gap |

## Needs you view (`needs-you`)

Every worktree waiting on you, errored or failing checks, across projects.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | empty |  |
| element | Display (`display-btn`) | Button |
| element | Filter (`filter-btn`) | Button |
| element | New worktree (`new-btn`) | IconButton |
| element | Header … menu (`more-btn`) | IconButton |
| element | View strip (`view-strip`) | Tabs |
| element | All tab (`view-tab-all`) | Tabs |
| element | Needs you tab (`view-tab-needs-you`) | Tabs |
| element | Needs you count (`needs-you-count`) | Badge |
| element | Saved view tab (`view-tab-release`) | Tabs |
| element | More views (`view-overflow`) | PopupMenu |
| element | Worktree row (`row`) | ListRow |
| element | Agent activity mark (`state-mark`) | StatusDot |
| element | Tag chip (`tag-chip`) | gap |
| element | Right-side fact (`row-fact`) | ListRow |
| element | Unread dot (`unread-dot`) | Badge |
| element | Row … button (`row-more`) | IconButton |
| element | Child chevron (`child-chevron`) | IconButton |
| element | Child count (`child-count`) | Badge |
| element | Errored / Waiting header (`section-header`) | SectionHeader |
| element | Nothing needs you (`empty-state`) | EmptyState |

## Saved view: Release 2.4 (`saved-view`)

A saved filter, grouping and sort; change it and save, save as new, or revert.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | changed |  |
| element | Display (`display-btn`) | Button |
| element | Filter (`filter-btn`) | Button |
| element | New worktree (`new-btn`) | IconButton |
| element | Header … menu (`more-btn`) | IconButton |
| element | View strip (`view-strip`) | Tabs |
| element | All tab (`view-tab-all`) | Tabs |
| element | Needs you tab (`view-tab-needs-you`) | Tabs |
| element | Needs you count (`needs-you-count`) | Badge |
| element | Saved view tab (`view-tab-release`) | Tabs |
| element | More views (`view-overflow`) | PopupMenu |
| element | Worktree row (`row`) | ListRow |
| element | Agent activity mark (`state-mark`) | StatusDot |
| element | Tag chip (`tag-chip`) | gap |
| element | Right-side fact (`row-fact`) | ListRow |
| element | Unread dot (`unread-dot`) | Badge |
| element | Row … button (`row-more`) | IconButton |
| element | Child chevron (`child-chevron`) | IconButton |
| element | Child count (`child-count`) | Badge |
| element | What the view shows (`view-summary`) | gap |
| element | Changed line (`changed-line`) | gap |
| element | Save (`save-view-btn`) | Button |
| element | Save as new (`save-as-new-btn`) | Button |
| element | Revert (`revert-btn`) | Button |
| element | Status header (`section-header`) | SectionHeader |
| element | Project header (`project-header`) | SectionHeader |

## Grouped by tag (`by-tag`)

A worktree shows under each of its tags, Untagged last.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Worktree row (`row`) | ListRow |
| element | Agent activity mark (`state-mark`) | StatusDot |
| element | Tag chip (`tag-chip`) | gap |
| element | Right-side fact (`row-fact`) | ListRow |
| element | Unread dot (`unread-dot`) | Badge |
| element | Row … button (`row-more`) | IconButton |
| element | Child chevron (`child-chevron`) | IconButton |
| element | Child count (`child-count`) | Badge |
| element | Tag group header (`tag-group-header`) | SectionHeader |
| element | Untagged header (`untagged-header`) | SectionHeader |

## Display menu (`display-menu`)

Group by, sort, the right-side fact, and save as view.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Display menu (`display-menu`) | PopupMenu |
| element | Group by section and project (`group-section`) | PopupMenu |
| element | Group by tag (`group-tag`) | PopupMenu |
| element | Right side shows (`row-fact-setting`) | PopupMenu |
| element | Save as view (`save-as-view`) | PopupMenu |

## Filter menu (`filter-menu`)

Filter by tags, status, sections, projects, activity and hide toggles.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Filter menu (`filter-menu`) | Popover |
| element | Tag choices (`filter-tags`) | gap |
| element | A tag choice (`filter-tag`) | ScopeChip |
| element | Activity window (`activity-window`) | PopupMenu |
| element | Clear filters (`clear-filters`) | Button |

## Header … menu (`more-menu`)

Add project, board, statuses and cleanup.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Header … menu (`more-menu`) | PopupMenu |
| element | Review cleanup (`review-cleanup-item`) | PopupMenu |

## Row menu (`row-menu`)

Everyday actions first, the rest in submenus, Delete apart.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Row menu (`row-menu`) | ContextMenu |
| element | Rename (`rename-item`) | ContextMenu |
| element | Tags… (`tags-item`) | ContextMenu |
| element | Move to section (`move-section-item`) | ContextMenu |
| element | More (`more-item`) | ContextMenu |
| element | More submenu (`more-submenu`) | ContextMenu |
| element | Details… (`details-item`) | ContextMenu |
| element | Delete worktree (`delete-item`) | ContextMenu |

## Row hover card (`hover-card`)

Branch, project, status, review and tags without leaving the list.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Hover card (`hover-card`) | Popover |

## Tags popover (`tags-popover`)

Add, create and color a worktree's tags.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Tags popover (`tags-popover`) | Popover |
| element | Add or create a tag (`tag-input`) | TextField |
| element | Tag color (`tag-color-btn`) | gap |
| element | Color swatches (`color-swatches`) | gap |

## Inline rename (`rename`)

Rename the visible name in place; the branch stays.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Name field (`rename-field`) | TextField |
| element | Rename hint (`rename-hint`) | gap |

## Several selected (`bulk`)

Tag, move or sleep several worktrees at once.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Worktree row (`row`) | ListRow |
| element | Agent activity mark (`state-mark`) | StatusDot |
| element | Tag chip (`tag-chip`) | gap |
| element | Right-side fact (`row-fact`) | ListRow |
| element | Unread dot (`unread-dot`) | Badge |
| element | Row … button (`row-more`) | IconButton |
| element | Child chevron (`child-chevron`) | IconButton |
| element | Child count (`child-count`) | Badge |
| element | Bulk bar (`bulk-bar`) | gap |
| element | Tag (`bulk-tag`) | Button |
| element | Section (`bulk-section`) | Button |
| element | Status (`bulk-status`) | Button |
| element | Sleep (`bulk-sleep`) | Button |

## Save view dialog (`save-view`)

Name the current filter, grouping and sort as a view.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| element | Save view dialog (`save-view-dialog`) | Dialog |
| element | Name (`view-name`) | TextField |
| element | What it saves (`view-saves`) | gap |
| element | Show as a tab (`star-view`) | gap |
| element | Save view (`save-view-confirm`) | Button |

## Panel closed (`rail`)

The Worktrees icon shows the Needs you count while the panel is closed.

| Kind | Name | Notes |
|---|---|---|
| state | errored | default |
| state | waiting |  |
| state | quiet |  |
| element | Worktrees rail icon (`rail-worktrees`) | IconButton |
| element | Needs you badge (`rail-badge`) | Badge |

## Clean up archived worktrees (`cleanup`)

Delete or ignore worktrees archived past the threshold.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | empty |  |
| element | Cleanup dialog (`cleanup-dialog`) | Dialog |
| element | Cleanup row (`cleanup-row`) | gap |
| element | Reason (`cleanup-reason`) | gap |
| element | Ignore (`cleanup-ignore`) | Button |
| element | Delete (`cleanup-delete`) | Button |

## Remote workspaces (`remote`)

Restyled: hosts, owner runtime, register host, open VM environments.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | empty |  |
| element | Remote workspaces panel (`remote-panel`) | ToolPanelFrame |
| element | Host header (`host-header`) | SectionHeader |
| element | Remote workspace row (`remote-row`) | ListRow |
| element | Saved owner runtime (`owner-runtime`) | TextField |
| element | Replace identity (`replace-identity`) | gap |
| element | Register host (`register-host`) | Button |
| element | VM environments (`vm-btn`) | Button |
| element | No hosts (`empty-state`) | EmptyState |

## VM environments (`vm`)

Restyled: create from a recipe, refresh, list, diagnostics.

| Kind | Name | Notes |
|---|---|---|
| state | default | default |
| state | empty |  |
| element | VM environments view (`vm-view`) | gap |
| element | Recipe (`vm-recipe`) | SelectField |
| element | Create VM (`create-vm`) | Button |
| element | Refresh (`refresh-vm`) | Button |
| element | Environment list (`vm-table`) | gap |
| element | Backend diagnostics (`vm-diagnostics`) | gap |
| element | No VMs (`empty-state`) | EmptyState |

## Gaps

- Worktrees, All / Tag chip (`tag-chip`)
- Worktrees, All / Cleanup footer line (`cleanup-footer`)
- Worktrees, All / Filtered line (`filter-line`)
- Worktrees, All / Hidden count (`hidden-note`)
- Worktrees, All / Bulk bar (`bulk-bar`)
- Needs you view / Tag chip (`tag-chip`)
- Saved view: Release 2.4 / Tag chip (`tag-chip`)
- Saved view: Release 2.4 / What the view shows (`view-summary`)
- Saved view: Release 2.4 / Changed line (`changed-line`)
- Grouped by tag / Tag chip (`tag-chip`)
- Filter menu / Tag choices (`filter-tags`)
- Tags popover / Tag color (`tag-color-btn`)
- Tags popover / Color swatches (`color-swatches`)
- Inline rename / Rename hint (`rename-hint`)
- Several selected / Tag chip (`tag-chip`)
- Several selected / Bulk bar (`bulk-bar`)
- Save view dialog / What it saves (`view-saves`)
- Save view dialog / Show as a tab (`star-view`)
- Clean up archived worktrees / Cleanup row (`cleanup-row`)
- Clean up archived worktrees / Reason (`cleanup-reason`)
- Remote workspaces / Replace identity (`replace-identity`)
- VM environments / VM environments view (`vm-view`)
- VM environments / Environment list (`vm-table`)
- VM environments / Backend diagnostics (`vm-diagnostics`)

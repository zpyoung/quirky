# Worktrees redesign

**Status:** Approved

This redesign makes the Worktrees sidebar answer one question at a glance: which worktree needs me? It also adds the organizing tools the walk found missing: tags, cross-project sections, saved views, and a fast way back to All. The input was the walk in [current-state.md](current-state.md) and the clickable mock in [mock/mock.html](mock/mock.html), which was approved on v1 with all 17 screens visited.

The reader is whoever builds or reviews this branch. Every item under Screens, Capabilities and Redesign checks is something the after pass checks.

## The model

A worktree lives in exactly one place in the tree, and tags and views only change how you look at it.

- **Place.** A worktree sits under its project, or in one section if you moved it there. Pinned is a built-in section at the top. A pinned worktree shows once, in Pinned.
- **Tags.** Any number per worktree. Tags are global, so one tag can span projects. A tag is grey unless you give it one of eight colors.
- **Views.** A view is a saved filter, grouping and sort. All is always first and can't be removed or overwritten. Needs you is built in, read-only and can be hidden. Your own views can be starred, which puts them on the tab strip. Views are shared across windows, and each window remembers the view it shows.
- **State.** Agent activity drives the mark on every row: running, waiting on you, error, idle or asleep. Workflow status (Todo, In progress, In review, Done) stays a separate field you group or filter by.
- **Attention.** A worktree needs you when its agent is waiting on you, it's unread, or its checks are failing. That set is the Needs you view, the count on its tab, and the rail badge.

## Glossary

- **Worktree:** a local checkout Quirky manages. Every local menu and dialog uses this word.
- **Workspace:** a remote checkout, used only in Remote workspaces.
- **Section:** a named container in the tree that holds whole projects or single worktrees. It replaces today's project groups.
- **Tag:** a label on a worktree, used to filter or group across projects.
- **View:** a saved filter, grouping and sort, shown as a tab.
- **Mark:** the 8px agent-activity ring at the start of a row.
- **Right-side fact:** the one muted value at the end of a row (PR, last activity, branch or status), chosen in Display for the whole panel.
- **Needs you:** waiting on you, unread, or failing checks.

## Design direction

The panel should feel like a quiet instrument: grey when things are fine, and obvious when something isn't.

- **Tokens.** It uses the existing graphite tokens in `packages/ui/src/design-system/tokens.css` and adds no palette.
  - Structure: `--ui-surface`, `--ui-border`, `--ui-muted`.
  - The one accent, `--ui-accent`, marks only the active view tab, the dirty-view dot, unread dots, focus and a dialog's primary button.
  - State colors (`--ui-working`, `--ui-needs-you`, `--ui-failing`) appear only on marks, attention counts and the rail badge.
  - Tag colors come from eight `--ui-hue-*` tokens.
- **Depth.** Tonal surfaces only: rail, surface, selected. Menus and popovers keep the existing overlay shadow. Rows and sections have no borders.
- **Type and rhythm.**
  - Rows are `--ui-row-single` (26px) with 12px names.
  - Headers are 11px, weight 500, muted and in sentence case.
  - Spacing is 4px between rows in a group and 12px above a header, with 12px of indent per nesting level.
- **Motion.** 150ms ease-out on opacity and transform, used for menu and popover reveals, the fold chevron, the hover `…` and the bulk bar. The running spinner is the only loop, and it stops under `prefers-reduced-motion`.
- **Signature.** The agent mark repeats in five places: the row, the folded child count, the section or project count, the Needs you tab and the rail badge.
- **Color is never the only cue.** Each mark state has its own shape and an `aria-label`:
  - running: spinning ring
  - waiting: filled dot
  - error: broken ring
  - idle: hollow ring
  - asleep: dashed ring

## Screens

The approved mock is [mock/mock.html](mock/mock.html), and its inventory is [mock/screens.md](mock/screens.md). Each item below passes when the built screen matches the mock in that state, at 1280x720, in dark and light.

1. **Worktrees, All:**
   - Default: matches the mock.
   - Filtered: the filter line names the filter and the hidden count.
   - Empty: "No projects yet" with Add project.
2. **Needs you view:**
   - Default: only worktrees waiting on you, unread or failing checks, across projects.
   - Empty: "Nothing needs you" with Show all worktrees.
3. **Saved view (Release 2.4):**
   - Default: matches the mock.
   - Changed: the tab shows a dot, and the changed line offers Save, Save as new and Revert.
4. **Grouped by tag:** each tag is a group, a worktree with two tags shows under both, and untagged worktrees come last. On All, Save is replaced by Save as new.
5. **Display menu:** Group by, Sort by, Project order, Right side shows, Show asleep, Show nested children, Save as view.
6. **Filter menu:** Tags, Sections, Projects, Status, Activity, Hide, and Clear filters with an Esc hint.
7. **Header … menu:** Add project, Workspace board, Edit statuses, and Review cleanup with its count.
8. **Row menu:** the groups and order under [Row actions](#sc-9-row-actions), with Delete set apart in danger text.
9. **Row hover card:** name, branch, project, status, agent state in words, PR and checks, every tag, last activity.
10. **Tags popover:** search, checkboxes, Create *name*, and eight color swatches plus grey.
11. **Inline rename:** a field the size of the row. Enter or blur saves, Esc cancels.
12. **Several selected:** selected rows are tinted, and the bulk bar shows the count with Tag, Section, Status, Sleep and ×.
13. **Save view dialog:** Name, what it saves, Show as a tab (on), Save view.
14. **Panel closed (rail):**
    - Errored: a red count.
    - Waiting: an amber count.
    - Quiet: no badge.
15. **Clean up archived worktrees:**
    - Default: one row per candidate, with a readable reason on its own line, Ignore, Refresh preview, Restore ignored, and Delete selected.
    - Empty: "Nothing to clean up".
16. **Remote workspaces:**
    - Default: restyled rows and headers, the same fields and actions.
    - Empty: "No owner hosts registered" with Register host.
17. **VM environments:**
    - Default: a dense table, status marks, and actions in a row `…`.
    - Empty: "No VM environments recorded" with Create VM.

Loading and error states were skipped in the mock. The list comes from the local daemon and renders at once, and the shell handles a daemon disconnect.

### Open questions from the mock's gaps

Each element below has no repo component yet. My proposed answer comes after the arrow, and approving the spec approves it.

- **Tag chip** (on rows, the by-tag view, bulk) → a new `TagChip` in the design system: 10.5px text, 4px radius, the hue at about 18% alpha. A crowded row shows 2 chips plus "+N". Chips never clip mid-word, so a chip that doesn't fit whole goes into +N.
- **Tag choices, tag color and color swatches** (Filter, Tags popover) → one checkbox list row and one swatch radio group, both new design-system pieces.
- **Filter line, hidden count, changed line and view summary** → one new "panel notice line" component with a text slot and link actions.
- **Cleanup footer line** → the same notice line.
- **Bulk bar** → a new bar pinned to the panel bottom, built from Button.
- **Rename hint** → TextField's existing hint slot.
- **Save view's "What it saves" and "Show as a tab"** → plain text and a checkbox inside Dialog.
- **Cleanup row and reason** → ListRow with a second muted line for the reason.
- **Replace identity** (Remote workspaces) → a Button, the same action as today.
- **VM environments view, environment list and diagnostics** → a view frame, a dense table and a collapsible diagnostics block, all restyled from the existing markup rather than invented.

## Behavior and scenarios

### SC-1 Tree order

- **Given** worktrees in projects, sections and Pinned
- **When** All is shown with its default grouping (Section and project)
- **Then** Pinned comes first, then sections in your order, then projects with their remaining worktrees. Every worktree appears exactly once.
- **Data before:**
  - **Pinned:** release-notes
  - **Section "Release 2.4":** retry-queue (harbor-api), export-csv (quirky), ui-review-notes (quirky)
  - **Project quirky:** main, sidebar-tags, docs-refresh, release-notes
- **Data after:**
  - Pinned: ✓ release-notes
  - Release 2.4: ✓ retry-queue, export-csv, ui-review-notes
  - quirky: ✓ main, sidebar-tags, docs-refresh, with release-notes not repeated

### SC-2 Rows show state without words

- **Given** a worktree's agent is running, waiting on you, errored, idle or asleep
- **When** its row is visible
- **Then** the mark shows that state by shape and color, with an `aria-label` naming it. The row stays one line: mark, name, up to 2 tag chips plus "+N", and the right-side fact.
- **Hover, focus or selection:** the fact fades out and the row `…` appears in its place, so the row doesn't reflow.
- **Unread:** shows a 6px accent dot.
- **Selection:** a neutral tint and a bold name.

### SC-3 Attention survives folding

- **Given** export-csv has a child export-csv-tests whose agent is waiting on you, and the parent is folded
- **When** the tree renders
- **Then** the parent's child count ("› 1") is amber. The Release 2.4 header shows an amber count, which stays when that section is folded. If any hidden worktree errored, these counts are red.

### SC-4 Rail badge when the sidebar is collapsed

- **Given** the Worktrees panel is closed
- **When** 3 worktrees need you and one of them errored
- **Then** the Worktrees rail icon shows "3" in the failing tone, with a title such as "3 worktrees need you, 1 errored". Nothing else pops up or makes a sound.
- **Clicking the icon:** opens the panel on the last view used in this window.
- **Zero worktrees need you:** the badge is hidden.
- **Screen states:**

     | Situation | Badge |
     |---|---|
     | 3 need you, 1 errored | "3", red |
     | 2 need you, none errored | "2", amber |
     | none need you | no badge |

### SC-5 Tag two worktrees and filter to the tag

- **Given** retry-queue (harbor-api) and sidebar-tags (quirky) have no tags
- **When** you open Tags… on each row and check "urgent", creating it on the first row, then check "urgent" under Filter › Tags
- **Then** the list shows only those two worktrees, and the filter line reads "Filtered: tag: urgent ×".
- **Data before:** **Tag "urgent"**: none; **retry-queue**: no tags; **sidebar-tags**: no tags
- **Walkthrough:**
  1. You type "urgent" in retry-queue's tags popover and pick Create "urgent". The tag is created grey and checked.
  2. You check "urgent" on sidebar-tags.
  3. You check "urgent" under Filter › Tags. The list narrows at once, with no Apply button.
- **Data after:**
  - **Tag "urgent"**: grey
  - **retry-queue**: ✓ urgent
  - **sidebar-tags**: ✓ urgent
  - **List**: ✓ the 2 rows only, with the filter line showing

### SC-6 Group by tag

- **Given** retry-queue has the tags urgent and release-2.4, and docs-refresh has no tags
- **When** you choose Display › Group by › Tag
- **Then** retry-queue shows under both urgent and release-2.4, docs-refresh shows under Untagged at the bottom, and the All tab gets the changed dot.

### SC-7 Save a view, switch to it, go back to All

- **Given** All is shown with a tag filter and Group by project
- **When** you pick Save as new, name it "Release 2.4" and keep Show as a tab on
- **Then** a Release 2.4 tab appears and becomes active, and All goes back to its saved state.
- **Changing a saved view:** the tab gets a dot, and the changed line offers Save, Save as new and Revert. Revert restores the saved filter, grouping and sort.
- **Going back to All:** click All, or press Esc twice. The first Esc clears filters and the second switches to All.
- **Other windows:** they see the new view in their strip but stay on their own view.
- **Data before:** **Views**: All, Needs you; **Window 1**: showing All (changed)
- **Data after:** **Views**: All, Needs you, ✓ Release 2.4 (starred); **Window 1**: ✓ showing Release 2.4; **Window 2**: still on its own view

### SC-8 Cross-project section

- **Given** retry-queue (harbor-api) and ui-review-notes (quirky)
- **When** you create the section "Release 2.4" from the section `+` and move both into it, with Move to section or by dragging
- **Then** both rows sit under Release 2.4, each showing its project name as the right-side fact, and neither still shows under its project. Removing one from the section puts it back under its project.

### SC-9 Row actions

- **Given** any row
- **When** you click its `…` or right-click it
- **Then** the menu offers, in this order:
  1. Rename, Tags…, Move to section ›, Move to status ›, Sleep (or Wake)
  2. Open in › (Terminal, Changes), Copy › (Path, Worktree name), More › (Set parent…, Remove from parent, Mark unread, Pin or Unpin, Archive, Details…)
  3. Delete…, set apart, which confirms as today in a "Delete worktree" dialog

### SC-10 Rename

- **Given** a worktree named walk-new on the branch walk-new
- **When** you pick Rename, type "walk-renamed" and press Enter
- **Then** the row reads walk-renamed and the branch stays walk-new, as the hover card shows. Esc cancels the rename and blur saves it. Notes and links are edited in More › Details….

### SC-11 Bulk actions

- **Given** three rows selected with Cmd-click or Shift-click
- **When** the selection exists
- **Then** the bulk bar shows "3 selected" with Tag, Section, Status, Sleep and ×. In Tag, a tag that only some of the rows have shows a mixed checkbox. Esc or × clears the selection.

### SC-12 Cleanup

- **Given** old-experiment was archived 8 days ago with no unpushed work
- **When** the footer line "1 archived worktree can be deleted · Review" is shown and you click Review (or pick header … › Review cleanup)
- **Then** the dialog lists old-experiment with the reason "Archived 8 days ago, no unpushed work" on its own line. Delete selected confirms with the count.
- **Unpushed work:** a worktree with unpushed work is never a candidate.
- **Nothing to clean:** the footer line is hidden.

### SC-13 Remote screens keep their behavior

- **Given** Remote workspaces and VM environments
- **When** they are opened
- **Then** they show the same fields, actions and data as today, with design-system controls, the tree's row anatomy (remote rows) or a dense table (VMs), and real empty states.

## Capabilities

Every capability from [current-state.md](current-state.md#capabilities):

| Capability | Decision |
|---|---|
| Create worktree (Smart, GitHub, Branch, Name; Base; Agent; Advanced; Create more) | kept; the dialog is titled "New worktree", and the section/project `+` is always visible |
| Select worktree | kept |
| Rename display name, notes, linked references | moved: the name is renamed inline; notes and links go to row `…` › More › Details… |
| Archive | moved to row `…` › More › Archive |
| Move to status | kept (row `…` › Move to status, plus bulk) |
| Open in Terminal or Changes | kept (row `…` › Open in) |
| Copy path, copy worktree name | moved to row `…` › Copy |
| Pin, unpin | moved to row `…` › More › Pin or Unpin; a pinned worktree shows once |
| Mark unread | moved to row `…` › More |
| Set parent worktree, remove from parent | moved to row `…` › More; the child count sits on the parent row instead of its own line |
| Sleep, wake | kept (row `…`, plus bulk); asleep now has a dashed mark |
| Delete with confirmation | kept; the dialog says "Delete worktree" |
| Project groups (create, add worktree, move project, rename, delete, collapse, open ledger) | moved to sections: section `+` creates one, Move to section or drag adds, and section `…` renames, deletes and opens the ledger |
| Add project (path or Browse) | moved to header `…` › Add project, plus the empty state; the command stays |
| Project settings, remove project, open ledger | kept (project `…`) |
| Manual project order | moved to project `…` › Move up and Move down, when Display › Project order is Manual |
| Group by Project, Status, Pull request, None | moved to Display › Group by, which adds Section and project, and Tag |
| Sort by Recent, Agent activity, Name, Project, Manual | moved to Display › Sort by |
| Project order Manual or Recent activity | moved to Display › Project order |
| Compact cards; show properties | cut: rows are always one line, with one right-side fact chosen in Display, and the other properties are in the hover card |
| Show sleeping; hide CLI-created, other desktop clients, default branch, detached HEAD, archived; external worktrees default; per-project visibility | moved: Show asleep to Display; the hide toggles to Filter › Hide; per-project visibility to Filter › Projects; the external worktrees default stays in Settings |
| Reveal filtered worktrees | moved to the filter line ("2 hidden: archived · Show") |
| Review cleanup (select, ignore, restore ignored, refresh preview, delete selected) | moved to header `…` and the footer line; every action kept |
| Activity window; hide merged or closed reviews, passing checks, automation-created; clear filters | moved to Filter › Activity, Filter › Hide and Clear filters |
| Workspace board; edit workspace statuses | moved to header `…` |
| Navigation history and index shortcuts | kept |
| Remote workspaces: saved owner runtime, register host | kept (restyled) |
| VM environments: create from a recipe, refresh lifecycle, backend diagnostics, recorded list | kept (restyled) |
| Settings: worktrees folder, nest by project, branch prefix, confirm before deleting | kept |

New: tags, saved views, the Needs you view, the rail badge, bulk select, the hover card and the agent mark.

## Redesign checks

The after pass runs these on the branch. They are part of the build, not a later step.

### Goals

None are removed. Every goal in [goals.json](goals.json) replays on the new UI:

| Goal | New path |
|---|---|
| g1 Create a new worktree in a project | project `+` (always visible) › New worktree |
| g2 Switch to another worktree and see it open in the center | click a row |
| g3 Rename a worktree | row `…` › Rename, inline |
| g4 Pin a worktree, then unpin it | row `…` › More › Pin, then Unpin |
| g5 Group the list by status and sort it by name | Display › Group by › Status, then Sort by › Name |
| g6 Move a worktree to a different status | row `…` › Move to status |
| g7 Put a worktree to sleep, then wake it | row `…` › Sleep, then Wake |
| g8 Nest one worktree under another as its parent | row `…` › More › Set parent… |
| g9 Delete a worktree | row `…` › Delete… |
| g10 Add a second project | header `…` › Add project |
| g11 Review cleanup suggestions for archived worktrees | footer line › Review, or header `…` › Review cleanup |
| g12 Put worktrees from two different projects into one group | section `+`, then Move to section on both (SC-8) |
| g13 Tag two worktrees and filter the list to that tag | SC-5 |
| g14 Group the list by tag | SC-6 |
| g15 Save the current grouping and filters as a view, switch to it, then go back to all worktrees | SC-7 |
| g16 See a remote workspace and the VM environments list | Remote workspaces, then VM environments |

### Before scores

| Surface | Dark | Light |
|---|---|---|
| Worktrees section | 73 | 74 |
| Remote workspaces section | 72 | 74 |
| VM environments view | 78 | 64 |
| Remote workspace view | not scored | not scored |

The Remote workspace view can't render on the fixture, so it stays unscored. No surface is new or removed.

### Gates

1. **Scores:** every scored surface reaches at least 85 and at least its before score, in dark and in light.
2. **Goals:** every goal above replays successfully on the new UI, each with an OBSERVED act and a screenshot.
3. **Real app:** g16 is tagged real-app and is walked in the user's own Quirky only after the after pass's go-ahead screen.

## Walk bugs

All five bugs from the walk are fixed by this redesign:

| Bug | Decision |
|---|---|
| The cleanup row runs the name into a raw reason code ("archived-7day") | fixed by this redesign: each candidate gets a readable reason on its own line (SC-12) |
| The options popover opens past the top of the window and clips Review cleanup | fixed by this redesign: the popover is replaced by the Display and Filter menus, and cleanup moves to the header `…` |
| "Show 1 filtered worktree" doesn't say what is filtered | fixed by this redesign: the filter line names the count and the reason |
| A pinned worktree is listed twice | fixed by this redesign: a pinned worktree shows only in Pinned (SC-1) |
| One object has three names (worktree, workspace, workspace details) | fixed by this redesign: local menus and dialogs all say worktree |

## Decisions locked

**Organizing**
- Sections give a worktree its place, and tags filter across places.
- Today's project groups become sections. A section holds whole projects or single worktrees.
- Moving a worktree into a section shows its project name there, and removing it puts it back.
- Only worktrees carry tags. A tag is grey by default, with one of eight colors optional.
- Group by tag lists a worktree under each of its tags, with untagged worktrees last.
- Bulk select with Cmd or Shift offers Tag, Move to section, Move to status and Sleep.

**Views**
- Views live in a tab strip: All, then starred views, with the rest behind a chevron.
- A view saves filter, grouping and sort.
- Changes are temporary until saved: a dot on the tab, then Save, Save as new or Revert.
- All is always first and can't be removed. Esc clears filters, a second Esc returns to All, and a filter line names what is filtered.
- Tags are filtered through the Filter menu only, with no chip row.
- One built-in view, Needs you (waiting, unread, failing checks): hideable, not editable, with a count on its tab.
- Views are shared across windows, and each window picks its own.

**Rows and state**
- Rows are one line: mark, name, tags, one right-side fact. Everything else is in the hover card.
- The leading mark is agent activity.
- Tags appear as chips on the row (2 plus "+N" when crowded).
- Selection is a neutral tint and a bold name. Unread is a small accent dot.
- Children fold under the parent behind a chevron with a count, and an amber child colors the folded count.

**Attention**
- The rail badge is the Needs you count: amber, red when any errored, hidden at zero, with a title naming what waits.
- Clicking the badged icon opens the last view.
- Nothing beyond the badge and the marks: no toasts, no sounds.

**Menus and naming**
- Display and Filter are two flat menus in the header.
- The row menu has the grouping in SC-9, and right-click opens it.
- Pinned is a built-in section at the top.
- Local items are always "worktree".
- Header buttons and section/project `+` and `…` are always visible, in muted color. The row `…` shows on hover, selection or focus.
- The header `…` holds Add project, Workspace board, Edit statuses and Review cleanup, with a footer line when something can be cleaned up.
- Rename edits the visible name inline. The branch doesn't change.

**Scope and approach**
- Remote workspaces and VM environments get a restyle only.
- Layout: a quiet single tree.
- UX review: Looks right on mock v1.

## Industry insights

From [organizing-research.md](research/organizing-research.md) and [approach-research.md](research/approach-research.md):

- **Agent managers are thin on organizing.** Conductor has pinning and status groups, and Cursor users ask for pinning and favorites. None has tags or saved views. ([Conductor changelog](https://www.conductor.build/changelog/page/10), [Cursor forum](https://forum.cursor.com/t/allow-for-pinning-workspaces-in-the-sidebar-of-new-agent-window/156829))
- **A dirty dot on a view tab** is the cleanest answer to "adjust for now, or save?" GitHub Projects uses it, which is where Save, Save as new and Revert come from. ([GitHub docs](https://docs.github.com/en/enterprise-server@3.17/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views))
- **Starred views reach the sidebar** in Linear, and display options are kept separate from filters, which is why Display and Filter are two menus here. ([Linear favorites](https://linear.app/docs/favorites), [custom views](https://linear-web.pages.dev/docs/custom-views))
- **Manual sections mix items from anywhere** in Slack, and removing an item returns it to the default area. Sections here behave the same way. ([Slack help](https://slack.com/help/articles/360043207674))
- **Dimmed navigation** lets content lead. Linear's 2026-03-12 refresh did this, and it's the basis for the muted headers. ([Linear changelog](https://linear.app/changelog/2026-03-12-ui-refresh))
- **Color can't be the only cue**, so every mark state has its own shape and a label. ([WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html))
- **A pinned attention shelf gets ignored** like a banner, and Slack and GitHub use view tabs instead. That's why Needs you is a tab, not a strip. ([NN/g](https://www.nngroup.com/articles/banner-blindness-original-eyetracking/), [Slack Activity](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack))
- **A stuck agent with no badge** is a real complaint. In a Cursor bug report, a subagent waited on a permission prompt and nothing showed it, which motivates the rail badge. ([Cursor forum](https://forum.cursor.com/t/background-subagent-can-get-stuck-when-permission-prompt-disappears-and-the-agent-list-does-not-show-that-attention-is-required/161539))
- **Collapsed groups can hide attention,** so folded headers carry the attention count. ([setproduct](https://www.setproduct.com/blog/sidebar-navigation-ui-design), [Slack sidebar](https://slack.com/help/articles/212596808-Manage-your-sidebar))

## Scope and non-goals

- In scope: the Worktrees sidebar section, Remote workspaces section, VM environments view and Remote workspace view (restyle), plus the rail badge.
- Not in scope:
  - The New worktree dialog's contents (only its title changes).
  - The Workspace board.
  - The Settings page.
  - The mobile app.
  - Tags on projects or sections.
  - Rule-based (smart) sections.

## Deferred ideas

- Smart sections that fill from a rule, as Slack users ask for. Views cover this for now.
- Tag groups that work like a single-select field (Linear's label groups).
- [tech-spec] Where tags, sections and views are stored, so they're shared across windows and survive restarts, and how today's project groups and global options migrate into sections and the All view.
- [tech-spec] Where "failing checks" comes from for Needs you, and how often it refreshes.
- [tech-spec] How the existing `setPanelBadge` call reports the failing tone and the title.

## Status & amendments

**Status:** Approved 2026-11-09 on the companion, from mock v1 and four approved design sections.

**Amendments:** none.

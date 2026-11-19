# Organizing many worktrees in a narrow sidebar: comparable patterns

3 rounds run on web sources (about 30 searches and fetches). Reddit and HN complaint threads were mostly not found; where a complaint is a forum post it is labelled. Not covered: Crystal, Claude Squad, Height, Plane, Jira quick filters, JetBrains, Superset's and Sculptor's sidebars (no usable sources surfaced).

## 1. Agent and worktree managers: all thin

None offers tags, saved views or cross-project groups. They stop at pin, collapse, reorder and status grouping.

| Product | What it offers | Source |
|---|---|---|
| Conductor | Pinned workspaces at the top (v0.25.3, Dec 2025). Repos collapse and drag-reorder. Experimental sidebar groups by status, with counts on collapsed groups. A Workspaces page lists all repos, with archive and restore. Cloud Home filters by teammate, project and archived. A July 2026 release improved sidebar speed with many workspaces. | [changelog](https://www.conductor.build/changelog/page/10), [changelog p7](https://www.conductor.build/changelog/page/7), [docs](https://docs.conductor.build/workflow), [cloud](https://www.conductor.build/docs/cloud/collaboration) |
| Orca | Per a third-party wiki: sort smart/recent/name, group by repo, workspace status or PR status, or none. Matches Quirky's current model. | [DeepWiki](https://deepwiki.com/stablyai/orca/4-sidebar) (generated, may be stale) |
| Cursor 3 Agents window | Repo sections drag-reorder and persist. A project vanishes once its last chat is archived, and users ask for pinned workspaces and a Favorites section. These are forum requests, not shipped features. | [pinning](https://forum.cursor.com/t/allow-for-pinning-workspaces-in-the-sidebar-of-new-agent-window/156829), [favorites](https://forum.cursor.com/t/favorites-in-the-cursor-agents-window-sidebar/168619) |
| Codex app | Projects (one per folder) hold threads, plus search. No filters documented. | [OpenAI Academy](https://openai.com/academy/working-with-codex) |
| Vibe Kanban | The one different model: a board of tasks, each launching an agent in its own worktree. The vendor reportedly shut down in April 2026. | [VirtusLab](https://virtuslab.com/blog/ai/vibe-kanban/), [roundup](https://nimbalyst-website.pages.dev/blog/best-agent-management-tools-2026/) |

Complaint signal: one hands-on review says telling workspaces apart becomes its own problem as their number grows ([The New Stack](https://thenewstack.io/?p=22802860), single source).

## 2. Work trackers

**Linear**
- Model: saved filter views, plus labels and label groups. A label group holds single-select labels, so it works like a field.
- Creating a view: Views, then New view, then choose a type. Views can be shared or personal.
- Reaching a view: star it to put it in sidebar Favorites. Favorites can hold folders you create by hovering and clicking the icon. A favorited view can be the startup page.
- Grouping and getting back to all: "display options" (group by status, project, priority, label, label group) are separate from the filter. Label views show all issues under a label.
- Sources: [favorites](https://linear.app/docs/favorites), [label views](https://linear.app/docs/label-views.md), [custom views](https://linear-web.pages.dev/docs/custom-views)
- Caveat: team-scoped label views can't span teams, so you need a custom view instead.

**GitHub Projects**
- Model: each view is a tab (filter, sort, group-by).
- Editing: changing a view puts a dot by its name, and you choose "Save changes" or ignore the dot. Unsaved edits are private.
- This "dirty dot" pattern is the cleanest answer to "adjust temporarily, or save?"
- Source: [GitHub docs](https://docs.github.com/en/enterprise-server@3.17/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views)

## 3. Personal organizers

**Things**
- Model: areas (one per item, a hierarchy) plus flat tags (many per item).
- A tag filter bar sits at the top of the current list. It only offers tags used in that list, Cmd-click ANDs tags, and "All" clears the filter.
- Tag search is separate: it jumps to a cross-app tag list.
- Sources: [Cultured Code](https://culturedcode.com/things/support/articles/2803581/), [3.5 nested-tag search](https://www.iclarified.com/65429/things-35-update-brings-collapsible-areas-searchable-tags-today-widget-improvements-more)
- This is the best narrow-width tag pattern found. It adds no sidebar rows and shows only tags that apply.

**Todoist and OmniFocus**
- Todoist: a query-language filter is created with "+" beside the Filters section. Labels are tags. The free plan caps filters at 3. Sources: [MacStories](https://www.macstories.net/?p=187261).
- OmniFocus: a perspective is a stack of nested filter rules, and 4.3 added a favorite shortcut. Users complain the rule set is too limited ([forum](https://discourse.omnigroup.com/t/more-customizable-perspective-filter-rules/62110)). Source: [MacDrifter](https://www.macdrifter.com/2019/03/brief-examples-of-omnifocus-perspectives.html).

**Bear and Obsidian nested tags**
- Hierarchy lives in the tag name (`a/b`).
- Complaints: large trees become a long alphabetical list ([Bear request](https://community.bear.app/t/feature-request-small-but-impactful-improvement-to-the-tag-system/2805)). Counts, collapse state and sort bugs recur ([Obsidian](https://forum.obsidian.md/t/tags-are-no-longer-working-as-expected/76513)).

**Finder**
- Tags are many-per-item, and clicking one in the sidebar shows matches from anywhere.
- A smart folder is a saved search. Its criteria are editable through "Show Search Criteria" ([Macworld](https://www.macworld.com/article/1438328/how-to-add-finder-smart-folder-to-sidebar.html)).
- Complaint (one HN comment): a smart folder with a tag criterion won't accept drops ([HN](https://news.ycombinator.com/item?id=24091707)). Rule-based membership has no manual add.

## 4. Sidebars and IDEs

**Slack sections**
- Model: manual sections that mix channels, DMs and apps from anywhere. The sections are personal, and items sit in one section at a time.
- Each section has its own sort and unread-only filter. Removing an item returns it to the default area.
- A default section that can't be renamed catches new items.
- Sources: [Slack help](https://slack.com/help/articles/360043207674)
- Complaint: a user wants a section that auto-fills with unreads and empties after reading ([Atlassian community post](https://community.atlassian.com:443/t5/Assist-questions/Dynamic-slack-sections/qaq-p/2194740)). Users hack around this with a collapsed "don't care" section ([blog](https://critter.blog/2022/05/05/slack-tweaks-for-compulsive-inbox-zero-addicts/)). Manual and dynamic membership are both wanted.

**Arc**
- Spaces are colored, and color is praised as a cue for being in the wrong space.
- Complaint: pinned tabs ended up in another space under "Recovered" or vanished, which is data-loss anxiety ([Reddit mirror](https://t.sudovanilla.org/r/ArcBrowser/comments/19eej9s/anyone_else_experiencing_pinned_tab_shenanigans), single anecdote).

**VS Code Project Manager extension**
- Projects get multiple tags, and the favorites list is filtered by tag. Source: [README](https://github.com/vijaykm01/vscode-project-manager).

## 5. Design directions for a 260-320px sidebar

1. **Slack-style manual sections.** The user creates named sections and drags worktrees in, from any project, one section per worktree. Cheap to build and it directly answers "free grouping". Cost: a worktree can't be in two sections, there is no auto-fill, and sections go stale. Add a rule (see 5) to fix that.
2. **Tag chip bar (Things-style).** A one-row chip strip under the header shows only tags present in the visible list. Click filters, Cmd-click ANDs, "All" clears. It uses no extra sidebar rows and a tag can sit on many worktrees. Cost: chips overflow, so use a horizontal scroll plus a "+N" popover. "Group by tag" duplicates a multi-tag worktree across groups, which needs a rule.
3. **Saved views in a pinned strip (Linear/GitHub).** A view is a filter plus group and sort, shown as an icon row or segmented control at the top ("All", plus 3-5 starred views), with the rest in a menu. Dirty-dot "Save changes" for tweaks. Cost: more concepts, and filter UI is cramped at this width. Needs a popover editor.
4. **Smart-rule sections (Finder, Todoist).** A section whose membership is a query (tag, project, PR state, activity). It keeps itself current. Cost: items can't be dragged in, and users want both manual and rule-based membership (Finder and Slack complaints).
5. **Hybrid sections: manual members plus an optional rule.** A section holds pinned manual members and a rule that fills in the rest, shown as a "from rule" divider. This covers the Slack/Finder gap, with more to build and explain.
6. **Project filter lens plus a persistent "All" anchor.** Treat projects, groups and tags all as lenses over one flat list. A single "All worktrees" row or Esc always resets, with an active-lens breadcrumb. This is the cheapest answer to "fast way back to all", and it composes with any of the above.

Recommended combination: 2 for tags, 3 for saved views, 6 for reset. Use 1/5 only if cross-project groups must be hand-curated.

## 6. Praised vs hated

Praised (consistent):
- Filters that show only tags that apply (Things).
- A dirty-dot save flow (GitHub).
- Personal, non-shared organization (Slack, Linear favorites).
- Color cues (Arc).
- One-click clear back to All (Things "All", Finder tags).

Complained about:
- Large nested tag trees in the sidebar (Bear, Obsidian).
- Rule-only membership with no manual override (Finder).
- Manual-only membership that decays (Slack).
- Items that disappear or move without notice (Arc, Cursor projects with no chats).
- Favorites sidebars that grow chaotic ([Backendless forum](https://support.backendless.com/t/should-the-console-sidebar-be-the-same-as-in-the-mission-videos/19449), a different product, so low relevance).

Confidence: agent-manager facts are medium (vendor changelogs plus forum requests). Complaint evidence is low to medium (forum posts, mostly single anecdotes).

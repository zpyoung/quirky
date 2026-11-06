# Changes plugin: current state

This is what the Changes experience looks like and does on 2026-11-02, as a baseline for the redesign. The plugin is `quirky.git`. Its right-slot panel is titled "Changes", its tool button says "Source Control", and it opens diffs as tabs in the center area.

I drove it like a user through the `using-apps-like-a-user` skill. The renderer ran in a headless browser at 1280×720 against the web fixture, with an isolated daemon on commit `54402d63`. I seeded the fixture repo with every state the panel can show: unstaged, staged, partly staged, deleted, renamed, untracked, a feature branch three commits ahead, and a merge in progress. Screenshots are in [`img/current/`](img/current/). The full run report, with all 98 observations, is in `.quirk/using-apps-like-a-user/runs/20261102T110504-0002/`, which git ignores.

Not covered: push, pull, and sync against a real remote (the fixture has none), AI generation with a logged-in agent, dark mode, narrow windows, and keyboard-only use.

## Where everything lives

| Surface | How you reach it | Screenshot |
| --- | --- | --- |
| Changes panel | Right tool slot, top button | [01](img/current/01-panel-overview.png) |
| Single-file diff tab | Click a file row | [04](img/current/04-file-diff-inline.png) |
| Combined diff, uncommitted | Palette "View All Changes", or a section's hover-only "View all" | [10](img/current/10-combined-unstaged.png) |
| Combined diff, branch | Palette "Open Branch Diff", or the combined diff's button | [25](img/current/25-branch-diff.png) |
| Combined diff, all | "Open All Changes" button in the branch diff | [26](img/current/26-all-diff.png) |
| Commit diff tab | Click a commit card in the panel | [03](img/current/03-commit-diff-tab.png) |
| Conflict review tab | "Review conflicts" in the panel's conflict card | [28](img/current/28-conflict-review-tab.png) |
| Conflicted file | "Open" on a conflict review card | [29](img/current/29-conflict-file.png) |
| Change Base Ref dialog | Click the base chip next to the branch name | [24](img/current/24-change-base-ref.png) |
| Source Control AI defaults | Palette only | [33](img/current/33-ai-defaults.png) |

## The panel, top to bottom

The panel stacks a lot above the file list. On a dirty worktree at 1280×720, the first changed file sits about 400px down ([01](img/current/01-panel-overview.png)).

1. Header with "Changes", plus a filter, a ⋯ menu, and minimize. All three appear only while the pointer is over the panel.
2. Branch row: `main → main`. The base is a chip that opens Change Base Ref. On a feature branch it adds a `+10 −0` line count ([23](img/current/23-feature-branch-panel.png)).
3. NOTES shelf, only when review notes exist ([31](img/current/31-note-added.png)).
4. Commit message box and an AI sparkle button.
5. A primary split button whose label changes with state: "Commit" with staged files, "Stage All" with only unstaged files ([22](img/current/22-after-commit.png)), "Publish Branch" when clean ([34](img/current/34-clean-worktree.png)). Its ▾ holds every remote action.
6. A status line that, without an origin remote, reads "GitHub pull-request lookup unavailable".
7. "Summarize branch with AI" and "Commit, push & Create PR".
8. Sections: Conflicts, Changes, Staged Changes, Untracked Files, Committed on Branch, Commits. Each header has a count badge, a ▾ collapse button, and hover-only bulk actions (discard all, stage or unstage all, view all).
9. File rows show an icon, the name, the folder dimmed, and a status letter. The `+/−` counts and the discard and stage buttons appear only on hover or selection ([16](img/current/16-row-hover-actions.png)).

The ⋯ menu offers View as tree, Change Base Ref…, and Refresh branch compare ([07](img/current/07-panel-header-menu.png)). Tree mode groups files under grey folder chips ([08](img/current/08-panel-tree-mode.png)). The filter narrows every section live ([13](img/current/13-panel-filter.png)).

Selecting a row adds a footer bar, "1 selected · Stage (1) · ×", which stays in sync as the file moves between sections ([15](img/current/15-selection-bar-staged.png)). Right-click offers only View, Copy Path, Copy Relative Path, and Reveal in Finder, with no stage or discard ([14](img/current/14-row-context-menu.png)). Discard asks first in a modal ([17](img/current/17-discard-confirm.png)).

The Commits section lists commit cards. ▸ expands a card to show its files inline, and clicking the card opens the commit diff ([02](img/current/02-panel-commits-expanded.png)).

## Diff tabs

Single-file diffs open inline by default, with a red "Revert Block" button on each hunk ([04](img/current/04-file-diff-inline.png)). The toolbar has previous and next change, an inline or side-by-side toggle, a ⋯ menu with Word Wrap and Show Whitespace, and close. Side-by-side gives each side about 300px at this window size ([05](img/current/05-file-diff-side-by-side.png)), so most lines wrap or get cut off.

Combined diffs stack one card per file. Each card has collapse, path, `+n −n` chips, Copy path, and Open diff. The toolbar adds a file count, Collapse All or Expand All, a button that jumps to the other mode, and "Show file tree" in ⋯. That option adds a column of boxed path buttons, not an actual tree ([11](img/current/11-combined-file-list.png)), and long paths get cut off ([25](img/current/25-branch-diff.png)).

Every mode opens a new tab with a lowercase name: "unstaged Diff", "branch Diff", "all Diff", "Commit f5429a17". The commit tab uses an 8-character sha, while its header uses 7. Tabs belong to their worktree, so switching worktrees swaps the whole tab set.

## Branch compare

On a feature worktree the panel adds a "Committed on Branch" section next to uncommitted Changes ([23](img/current/23-feature-branch-panel.png)). The branch diff is headed "Branch Changes (main)" ([25](img/current/25-branch-diff.png)). The "all" diff concatenates uncommitted and branch files with no divider between them ([26](img/current/26-all-diff.png)).

## Conflicts

During a merge, the commit box is replaced by an amber card: "Merge conflicts: 1 unresolved", with Review conflicts, Resolve with AI ▾, and Abort merge. Below it, a Conflicts section shows a "1 conflict(s)" chip that repeats the count badge ([27](img/current/27-conflict-panel.png)). The review tab is mostly empty space next to a narrow file card whose Open button gets cut off ([28](img/current/28-conflict-review-tab.png)). The file view shows raw conflict markers captioned "Current change", "Incoming change", and "End conflict", with a 1/1 counter ([29](img/current/29-conflict-file.png)).

## Review notes

Hovering a line in a diff shows a "+" in the gutter. Clicking it opens an inline composer with the placeholder "Add note for the AI" ([30](img/current/30-note-composer.png)). A saved note shows up in four places: inline in the diff with send, edit, and delete, as a NOTES shelf at the top of the panel, as a "✎ 1" badge on the file row, and as "✦1" in the diff toolbar ([31](img/current/31-note-added.png)). Send offers a list of new agents: OpenCode, Gemini, and Rovo Dev ([32](img/current/32-send-notes-menu.png)).

## Remote actions

All of them sit behind the ▾ on the commit button, in three groups: Commit, Commit & Push, Commit & Sync; then Push, Force Push, Pull, Fast-forward, Sync, Rebase from main; then Fetch and Publish Branch ([20](img/current/20-commit-remote-menu.png)). With no remote, everything except Commit and Fetch is greyed out, and nothing says why. The "Ahead and behind" status-bar item is blank when there's no upstream.

## AI

AI shows up as the commit sparkle, Summarize branch with AI, Resolve with AI, and send notes. The sparkle opens a dialog asking for an agent and a command template on every run ([18](img/current/18-ai-commit-dialog.png)). The defaults view is one long form: a global toggle, a custom command, then ten recipe blocks, each with agent, CLI arguments, model, launch choices, command template, and reset ([33](img/current/33-ai-defaults.png)). It replaces the center area with its own "Worktree | Source Control AI defaults" strip, and that strip was still there after I switched to another worktree ([34](img/current/34-clean-worktree.png)).

## Defects found

These are bugs or clear mismatches, separate from the design themes below.

- "View All Changes" in the palette shows only unstaged files, in a tab named "unstaged Diff". The command falls back to area `unstaged` when no area is passed (`plugins/quirky.git/src/view/commands.ts:80`). Staged and untracked files are missing ([10](img/current/10-combined-unstaged.png)).
- Fetch with no remote shows the error twice, once inline in red and once as a toast that covers the file list. The inline error then stays after a successful commit ([21](img/current/21-fetch-failed.png), [22](img/current/22-after-commit.png)).
- The "all" diff lists `src/feature/flags.ts` twice, once uncommitted and once committed on the branch, with nothing to tell the two cards apart ([26](img/current/26-all-diff.png)).
- The gutter "+" for review notes has no accessible name and doesn't appear in the accessibility tree.
- The AI defaults view strip persists across worktree switches ([34](img/current/34-clean-worktree.png)).

## Design themes for the redesign

These are observations, not proposals.

- Hover hides most actions. Panel header icons, section bulk actions, row stage and discard, line counts, the worktree ⋯, and the note "+" all show only on hover. A first-time user sees a commit box and a list of names.
- The commit area pushes the files down. Message, AI, split button, PR status, two more buttons, and sometimes notes and errors all sit above the first file. On a clean worktree it still shows four disabled or irrelevant controls ([34](img/current/34-clean-worktree.png)).
- One button, many meanings. The primary button changes between Commit, Stage All, and Publish Branch, and hides about ten remote actions behind its ▾.
- Three ways into the same diff. File tabs, combined tabs in three modes, and commit tabs each open separately, with lowercase internal names, so tabs pile up and spill into "2 more".
- Names don't match. "Changes" or "Source Control", "View All Changes" versus "Open All Changes", "unstaged Diff", "README.MD (CONFLICT)" in caps, and "1 conflict(s)".
- Conflict resolution is thin. There are no accept-current, accept-incoming, or accept-both controls. The paths are hand-editing or AI.
- Side-by-side doesn't fit. With both tool slots open, the center area is too narrow for two columns.
- Notes are strong but scattered. One note shows up in four places, and the shelf competes with the commit box for the top of the panel.

# QA areas

The QA lane takes one area per round, in this order: sessions, worktrees, git, files, terminals,
panels. Each list is the set of goals for that round. Start every round from a fresh `QUIRKY_HOME`
with the scratch repo added, as [QA.md](QA.md) describes. Keep agent prompts tiny (for example
"Reply with the single word OK") so a round costs little.

## sessions

- Start a Claude session from New tab > Claude with an initial prompt; the tab appears and Claude answers.
- While it works, the sidebar row and status bar show it working; when it finishes they show done.
- Start a Claude (background) session; it shows up somewhere a user would look for it.
- A refused start (for example an agent disabled in Agent settings) keeps the dialog open with the reason.
- The Inbox shows a pending `quirky ask` question from a session and answering it clears it.

## worktrees

- New workspace from the `+` beside the repo, typed name kept as typed, with and without an agent.
- Switch worktrees from the sidebar and from the Search palette.
- Pin and unpin, Sleep and wake, rename (display name), and Delete a worktree this round created.
- Each worktree keeps its own tabs across switches.

## git

- An edit made in a terminal appears in Changes; open its diff (inline, side by side, Source).
- Stage, unstage, discard an untracked file this round created, commit with a typed message.
- Branch controls: the base ref picker and the commit list.

## files

- The Files panel lists the tree; open a file, edit it, save it; the change appears in Changes.
- New file, new folder, rename, delete (only things this round created).
- Markdown preview of a `.md` file and of its diff.
- Search in Files finds text in the scratch repo.

## terminals

- New terminal tab, split a pane both ways, close a split, reorder tabs by dragging.
- Many tabs in a narrow window: the selected tab stays visible.
- The floating workspace opens and closes.
- Closing a tab with a running command asks first; Cancel keeps it.

## panels

- Every tool in the left and right rails opens, shows its content or an empty state, and minimizes.
- Settings opens, a change saves and persists after reopening, Cancel discards.
- The Search palette finds commands, views and worktrees.
- Tasks, Checks, Usage and the status bar items open and read sensibly for the scratch repo.
- Dialogs and popovers draw above the side panels and nothing covers their buttons.

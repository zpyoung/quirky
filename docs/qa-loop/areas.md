# QA areas

A QA agent takes one area per round from its own rotation, and each list is that round's goals. Foreground ([QA.md](QA.md)) rotates through workflows, new-features, sessions, terminals and panels. Background rotates through worktrees, git and files, and skips any goal that needs a real agent login, because its daemon has none. Foreground starts every round from a fresh `QUIRKY_HOME` with the scratch repo added. Keep agent prompts tiny (for example "Reply with the single word OK") so a round costs little.

## workflows

Do each of these from start to finish, the way someone would on a normal day, and judge the whole experience as well as each step.

- Add a project from the header, create a worktree in it, start a Claude session there with a small task such as adding one line to a file, and wait for it to finish. Review its change in Changes, commit it, and see the commit in the commit list.
- Run two sessions in two worktrees at once. Tell from the sidebar which one is working, which is done and which needs you, then switch between them without losing either's tabs.
- Have a session ask a question with `quirky ask`, notice it from the Inbox, answer it and see the session carry on.
- Open a file from a session's output, edit it, save it, review the diff, and discard the change.
- Quit the app with a session running, reopen it, and see the session and layout come back.

## new-features

- Feedback mode: turn it on, comment on part of the UI, and see the comment captured with enough context to act on. Turn it off and see that the UI is back to normal.
- Add project header button: it grows from an icon to a label on hover and on keyboard focus without moving the controls beside it, and its label truncates rather than clipping in a narrow panel. It's absent in the empty state, which has its own way to add a project. It opens the Add project flow.
- Redesigned layout: tool slots, rails and panels open, move, resize and minimize, and the layout survives a restart.
- Redesigned layout: panels are readable at the default window size and at a narrow one, with nothing clipped or overlapping.

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

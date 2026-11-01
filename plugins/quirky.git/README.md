# Source Control

The Git plugin stores independent recipes for commit messages, fix/review actions, branch names, and conversation names. `aiRecipe` resolves each field from the repository recipe, then the global recipe, then the default, and reports each field's source. `setAiRecipe` saves or resets a recipe at repository or global scope.

## Commit messages

With staged changes and an empty commit message, the sparkle button's tooltip and accessible name both read “Generate commit message with AI” when an agent is available. Other states explain why generation is unavailable or direct you to the AI settings.

## Keyboard focus

Committing and deleting an untracked file keep keyboard focus in Source Control. If the active control is disabled or removed, focus returns to the base-ref button or, when no base is available, More commit and remote actions. A valid control focused during a pending operation keeps focus.

Closing the base-ref picker returns focus to the current base-ref button, including when the picker opened from More source control actions. If no base is available after closing, focus returns to More commit and remote actions.

## Name candidates

`aiName({ action: 'branchName' })` returns a branch-name candidate from the exact worktree's checked-out branch, resolved base comparison, committed changed paths, and staged/unstaged paths. An optional `session` adds user/assistant messages from that exact structured session as captured work-prompt context. The returned branch name must pass Git's `check-ref-format --branch` validation.

`aiName({ action: 'conversationName', session })` requires an exact structured session in the selected worktree. It reads the captured user/assistant messages through the public structured-session API and returns a bounded title candidate.

Both actions use their own `branchName` or `conversationName` recipe. The one-shot generator must support the selected provider. Raw provider arguments are passed through the one-shot resolver, so singleton flags in raw arguments take precedence over structured model/option picks, which take precedence over inherited picks. `providerSource` identifies the provider plugin and recipe/request source for the chosen launch settings.

Names are drafts only. Generating a candidate does not create or rename a Git branch, rename a conversation, or otherwise mutate either owner. A failed generation leaves the UI's current candidate draft intact. The generated CLI method is `quirky git aiName --action branchName` or `quirky git aiName --action conversationName --session <session-id>`; add `--json` for the full provenance result.

## Provider model snapshots

`quirky.agents/options` and `discoverModels` take an exact host identity. `local` means the current runtime; a paired host is its saved peer ID. The Source Control settings and automation editor target their captured local owner explicitly. A successful nonempty provider snapshot retires only structured model picks tagged for that provider on that host; valid options common to the refreshed default catalog are retained. Empty, malformed, unavailable, or unsupported probes do not retire picks. Raw CLI arguments are not rewritten by model snapshot retirement.

## Hosted diff navigation

Click a Source Control row to preview its diff in the selected terminal workspace. Double-click to keep the tab; Option-click to open it in a split group. Dirty diff tabs refuse close and are not replaced by another preview.

Conflict-file tabs keep the editor draft while status changes. A staged resolution shows “Resolved” without deletion choices or conflict navigation; when the Git operation ends, the tab shows a neutral ended status and removes conflict controls.

Opening a file row in Changes or Committed on Branch moves the opened-diff highlight to that row. Rows in different sections remain distinct even when they name the same file; bulk selection stays separate from the opened diff.

File diff tabs include `(Diff)` after the path so they remain distinguishable from editor tabs for the same file. Branch file diffs use `(Branch Diff)` and commit file diffs use `(Commit Diff)`; staged, unstaged, and unspecified file diffs keep the generic `(Diff)` label.

Single-file diff headers preserve the path's casing for unstaged, staged, branch, and commit diffs. The full path remains available in the header tooltip.

Renamed-file headers and tooltips show `old path → new path` for staged, branch, and commit diffs, including pure renames with no content changes. Staged renames compare the old path in HEAD with the new path in the index. An open staged diff refreshes its rename metadata from current status after a commit. If unstaged edits remain, it switches to their diff and clears the committed rename's old path.

In the command palette, **Save Source Control File** saves edits in the focused Source Control diff. **Save File** saves the focused editor draft.

Screen readers announce file rows with their Git state (such as modified or untracked) and history rows as commits. Row colors do not change those names to agent activity states.
Tree-view folder counts use singular wording for one file and plural wording for multiple files. Folder discard confirmations describe the same count in their heading and warning.

The Commits dock gives the subject its own full-width line and wraps refs beneath it. Long ref labels are ellipsized visually; the full value remains available in the tooltip and screen-reader label.

The Changes header ellipsizes long branch names, keeping the comparison arrow and base-ref button beside the name on one row.

Right-click a file row for its Source Control actions. Blank Changes areas follow the [shell's context-menu behavior](../../README.md#shared-desktop-ui-components), including native editing and selected-text menus.

For Markdown files, **Preview** shows only the rendered modified content and hides both source diff sides. **Source** restores the diff.

Combined-diff navigation and Git open commands use the same hosted-tab route. Opening a diff selects its workspace view if another top-level view was showing. The `open-changes` and `open-commit` commands await the hosted-tab operation before replying.

Combined diffs open at the first file and keep their scroll position as sections load. Single-file diffs still jump to the first change; change-navigation commands remain available in both views.

Combined-diff headers preserve commit-subject casing and keep the compact toolbar on the padded title row. Long subjects remain available in the header tooltip.

Plugin integrations split a tab through `quirky.terminal/moveTab` with `tab`, `split`, `of`, and the acknowledged `revision`; the tab determines its workspace, so this method does not accept a `workspace` field.

Explicit standalone diffs opened through `ui.view.open` publish a top-level slot report. Embedded hosted views intentionally have no separate slot report; their tab identity and placement are available through `quirky.terminal/workspace`.

## Review notes

Choose “Add Review Note to Diff” in the command palette to open a note for selected text in an open diff. The editor's “Add Review Note” command targets a Markdown selection instead.

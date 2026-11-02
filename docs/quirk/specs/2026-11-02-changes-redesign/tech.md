# Changes redesign: tech spec

Status: Draft, written 2026-11-02 for implementation. Logic spec: [logic.md](logic.md) (approved). This document says where the work goes and what must hold. The logic spec owns the why and the behavior, and wins on any disagreement.

All paths are relative to the repository root. Line numbers come from the survey on commit `0019235f` and are approximate (`~`). Find each symbol by name before trusting a line number.

## Architecture

The redesign touches five areas. Arrows mean "calls".

- `packages/git` gains the one git primitive the review needs: a change list and a per-file diff from a commit (the merge base) to the working tree, untracked files included.
- `plugins/quirky.git` daemon half (`main.ts`, `src/daemon/*`) gains:
  - a review-marks store and the `review` read model, which merges branch compare, uncommitted status, marks and note counts into one flat list per worktree
  - review-mark RPCs, a `review` diff source, own-write hooks on `save`, and a subscriber for editor saves
- `plugins/quirky.editor` daemon emits one new event after a successful save. Nothing else in the editor changes.
- `packages/ui` gains four shared components (review mark, split button with reasons, inline error line, scope chip) plus row CSS in the shared `git-rows.css`. Plugins compose them; no plugin CSS (the ui-lint rule `ui/no-plugin-css`).
- `plugins/quirky.git` window half:
  - a new Review view mode, which replaces the file and combined modes in the one `view:quirky.git/diff` view
  - a rewritten panel: flat list, ship bar, keyboard, context menu
  - rerouted commands

The conflict views (`ConflictReview.tsx`, `ConflictFile.tsx`), history (`HistoryDock.tsx`), the AI defaults view and the PR form in `quirky.reviews` stay as they are.

Libraries in play: React 19, CodeMirror 6 with `@codemirror/merge` (`plugins/quirky.git/src/view/merge.ts`), the plugin SQLite store (`PluginContext.openStore`, `packages/protocol/src/plugins.ts:~85`), and `bun test` with happy-dom for window tests.

## Code references

Each row serves a part of the logic spec's [Conceptual model](logic.md#conceptual-model) or a scenario under [Behavior and scenarios](logic.md#behavior-and-scenarios).

### packages/git

| Symbol | Where | Change |
| --- | --- | --- |
| `DiffRequest` | `packages/git/src/diffs.ts:42` | Widen `source` to `GitDiffSource \| 'worktree'` and add `from?: string` (required when `source` is `'worktree'`). `'worktree'` is internal to `packages/git`. The daemon returns such diffs with `source: 'review'`. |
| `diffSource` | `packages/git/src/diffs.ts:~178` | Handle `'worktree'`: the original side is `<from>:<path>` (empty when absent there), the modified side is the working file, with `modifiedHash` and `modifiedDeleted` set exactly as for `unstaged`. Untracked files have an empty original side. |
| `changeList` | `packages/git/src/compare.ts:75` | Unchanged. The new function sits beside it. |
| new `worktreeChangeList` | `packages/git/src/compare.ts` | New export. See contracts. Re-export from `packages/git/src/index.ts` and add to `gitApi()` (`packages/git/src/api.ts:14`) and the fake in `packages/git/src/testing.ts`. |
| `statusV2` options | `packages/git/src/status.ts:312` | Reference only. `worktreeChangeList` takes the same `{ limit?, sharedSymlinks? }` options and applies them the same way. |
| `contentHash` | `packages/git/src/diffs.ts:38` | Unchanged. Review marks use this exact hash (sha-256 hex of the bytes). It matches `quirky.editor`'s `hashText`/`hashBytes` (`plugins/quirky.editor/src/daemon/files.ts:27-33`). |

### plugins/quirky.git daemon

| Symbol | Where | Change |
| --- | --- | --- |
| `migrations` | `src/daemon/store.ts:7` | Append one migration for `review_marks`. Never edit earlier entries. |
| new `ReviewMarks` | new `src/daemon/review-marks.ts` | Store class over `review_marks`, in the style of `NotesStore` (`src/daemon/notes.ts:46`). |
| new `review` handler | new `src/daemon/review.ts` | Builds the review read model. |
| `methodTable` | `src/daemon/methods.ts:23` | Register `review`, `setReviewMark`, `reviewedContent`. |
| `diff` handler | `src/daemon/files.ts:25` | Accept `source: 'review'` with `against: 'base' \| 'reviewed'`. |
| `save` handler | `src/daemon/files.ts:83` | After a successful write, move a mark whose hash equals `expected` to the new hash. |
| `setBase` | `src/daemon/compare.ts:39-56` | Clear the worktree's marks after a successful write. |
| `generateCommitMessage` | `src/daemon/ai-generate.ts:39` | Accept `scope: 'staged' \| 'all'`. `'all'` builds the prompt from every uncommitted change, untracked included, and doesn't fail with `nothing-staged` when nothing is staged. |
| `activate` subscriber | `main.ts:16` | Also handle `quirky.editor/saved`. |
| manifest | `plugins/quirky.git/quirky-plugin.json` | Declare the new methods (`contributes.method`), the new diff params, the `generateCommitMessage` `scope` param and the `reviewChanged` event. |

### plugins/quirky.editor daemon

| Symbol | Where | Change |
| --- | --- | --- |
| `performSave` | `src/daemon/service.ts:1396`, save finish `~1455-1485` | After a successful write, emit `saved`. |
| manifest event list | `plugins/quirky.editor/quirky-plugin.json:759` | Declare `saved`. |

### packages/ui

| Symbol | Where | Change |
| --- | --- | --- |
| new `ReviewMark` | new `packages/ui/src/design-system/review-mark.tsx` | Glyph component. |
| new `SplitButton` | new `packages/ui/src/design-system/split-button.tsx` | Primary button plus caret. The caret opens `ContextMenu` (`context-menu.tsx:202`) anchored under the caret, using `enabled` + `detail` for greyed items with reasons. |
| new `InlineError` | new `packages/ui/src/design-system/inline-error.tsx` | One-line `role="alert"` with an optional action and a dismiss button. |
| new `ScopeChip` | new `packages/ui/src/design-system/scope-chip.tsx` | Label plus a remove button. |
| barrel and types | `packages/ui/src/design-system/index.ts`, `contracts.ts` | Export the four components and their props types. |
| styles | `packages/ui/src/design-system/components.css` (components), `git-rows.css` (row mark slot, uncommitted dot, left-truncated folder, selected-row inline actions) | Tokens only. |
| gallery | `packages/ui/src/gallery.tsx` | One entry per new component, in each state. |

### plugins/quirky.git window: Review tab

| Symbol | Where | Change |
| --- | --- | --- |
| `DiffViewInput`, `diffViewKey` | `src/shared/view-input.ts:15-52` | Add mode `'review'` with `reveal?: string` and `commit?: string`. The key for `'review'` is per worktree only, so commit scope and reveal never create a second tab. |
| `parseInput` | `src/view/DiffWindow.tsx:20` | Map legacy `'file'` and `'combined'` inputs to `'review'` (path to `reveal`, commit to `commit`). Keep `'conflicts'` and `'conflict-file'`. |
| mode switch | `src/view/DiffWindow.tsx:~160` | Route `'review'` to the new `ReviewDiff`. |
| new `ReviewDiff` | new `src/view/ReviewDiff.tsx` | The stacked Review tab. Reuses `DiffPane` (`src/view/DiffPane.tsx`) for each card body, `SectionLoader` (`src/view/loader.ts`) and the lazy-load limits in `src/view/entries.ts` (`EAGER_SECTIONS`, `AUTO_LOAD_MAX_LINES`). |
| `CombinedDiff`, `FileDiff` | `src/view/CombinedDiff.tsx`, `src/view/FileDiff.tsx` | Delete once nothing imports them. Move pieces that `ReviewDiff` still needs (the section card, toolbar menu items) into `ReviewDiff` or small siblings first. |
| `openHostedDiff`, `titleOf` | `src/view/hosted-tabs.ts:110`, `~95` | Add `openReview`. The title of a `'review'` tab is `Review`. |
| `registerView`, `activeView` | `src/view/registry.ts` | Let a mounted `ReviewDiff` register per worktree, so `openReview` can reveal and rescope without remounting. |
| `commandHandlers` | `src/view/commands.ts:~52` | Reroute `open-diff`, `open-changes`, `open-branch-changes` and `open-commit` to `openReview`. `open-diff` with `source: 'conflict'` still opens `conflict-file`. Fix `open-changes` defaulting to `'unstaged'` (`:78-82`) as a side effect. |
| `merge.ts` | `src/view/merge.ts:135-205` | The Review tab reverts on disk after a confirm (see contracts). Inline vs side-by-side comes from the caller (`MergeOptions.sideBySide`), which `ReviewDiff` sets from width. |
| notes gutter | `src/notes/extension.ts:145-153`, `409-426` | Show the add-note marker on the line holding the cursor as well as the hovered line. Name it `Add note on line N`. |
| `noteViewInput` | `src/notes/open-note.ts:10-20` | Open the Review tab revealing the note's file. |
| `settings.ts` | `src/view/settings.ts:19-27` | `ReviewDiff` ignores `diffDefaultView`. Remove the setting from the manifest and code only if no consumer is left once `ReviewDiff` lands. `DiffPane` reads it through `sideBySide`, so check the conflict views before removing it. `diffWordWrap`, `diffShowWhitespace` and `diffCollapseUnchanged` stay. |

### plugins/quirky.git window: panel

| Symbol | Where | Change |
| --- | --- | --- |
| `WorktreePanel` | `src/panel/WorktreePanel.tsx` (1360 lines) | Rewrite its layout around the review read model. Keep the mutation, remote, force-push lease, `exactStatus` and Create PR chain logic (`~818-940`). Extract them into modules rather than leaving one 1300-line file. |
| `ladder.ts` | `src/panel/ladder.ts` (`primaryAction` :141, `menuItems` :197) | Replace with `nextStep` and `shipMenu`. See contracts. Keep `shouldForcePushWithLease`. |
| `Rows.tsx` | `src/panel/Rows.tsx` | Flat list and tree rows with the new anatomy. No hover-only buttons. |
| `sections.ts` | `src/panel/sections.ts` | Remove the section grouping (`groupSections`, `SECTION_HEADINGS`, `sectionButtons`). Keep `entryActions` and `isStageable` as row actions. |
| `CommitArea.tsx` | `src/panel/CommitArea.tsx` | Becomes the ship bar: notes button, message field with ✦ at its right end, `InlineError`, `SplitButton`. |
| `Header.tsx` | `src/panel/Header.tsx` | Header line (branch → base chip, totals), count line, filter, ⋯ menu items. |
| `GitHubReview.tsx` | `src/panel/GitHubReview.tsx` | Keep `readGitHubReview` and `useGitHubReview`. Remove the `GitHubReviewStatus` block from the panel. Its PR AI flows move to the ⋯ menu when a PR is found (logic spec Amendments, 2026-11-02). |
| `Cards.tsx` | `src/panel/Cards.tsx` | `OperationCard` (conflicts) takes the ship bar's place. `CleanState` becomes the one quiet line. `BlockedCard` is replaced by the error line. `HugeBanner` stays as one line above the list. |
| `Notices.tsx`, `SourceControl.tsx` | `src/panel/Notices.tsx`, `src/SourceControl.tsx:36` | Row-action failures become toasts with a Retry action (`Toast.action`). The persistent notices stack goes. |
| `NotesShelf` | `src/notes/NotesShelf*` | Removed from the panel. |
| `CommitSparkle`, `GenerateDialog` | `src/ai/CommitSparkle.tsx:32`, `src/ai/GenerateDialog.tsx:19` | ✦ is a button at the right end of the message field and calls `generateCommitMessage { scope }` directly (`'staged'` when anything is staged by hand, else `'all'`). After it succeeds, a muted line under the field reads `Written by <agent label>`, with the label from `quirky.agents/list` for the returned `agent`. It clears when the message is edited. `GenerateDialog` opens only from the ✦ menu's "Choose agent…". Generation failures go to the error line. |
| `SendMenu` | `src/notes/SendMenu.tsx:103` | Reused for "Send N notes to agent ▾", with scope `all`. |
| `HistoryDock` | `src/panel/HistoryDock.tsx` | Unchanged except that opening a commit calls `openReview` with `commit`. |
| `ChangeBaseDialog` | `src/panel/ChangeBaseDialog.tsx:67` | When the review model has `counts.reviewed + counts.changed > 0`, show `This clears N review marks` above the confirm (scenario 12). The base write itself is unchanged. |
| keybindings | `quirky-plugin.json:3190-3213` | Unchanged (`mod+shift+g`, `f7`, `shift+f7`, `mod+shift+a`). |

### Other plugins and tools

| Symbol | Where | Change |
| --- | --- | --- |
| `openView` | `plugins/quirky.worktree/src/daemon/navigation.ts:141` | Pass `{ worktree, mode: 'review' }` instead of `{ mode: 'combined', area: 'all' }`. Update `plugins/quirky.worktree/test/parity.test.ts:266`. |
| ui-review capture | `scripts/ui-review/capture.ts:466-469` | Open `{ mode: 'review' }`. Seed one reviewed file and one changed-since-review file through `quirky.git/setReviewMark` in `scripts/ui-review/shell-scenes.ts`. |

## Contracts & interfaces

Every contract here traces to the logic spec's [Conceptual model](logic.md#conceptual-model) and [Behavior and scenarios](logic.md#behavior-and-scenarios).

### The review read model ([What a file's diff compares](logic.md#what-a-files-diff-compares))

`CONTRACT:`
```
quirky.git/review { worktree?: string } -> ReviewModel
packages/git worktreeChangeList(cwd: string, from: string, options?: { limit?: number, sharedSymlinks?: string[] }): Promise<{ changes: GitChange[], capped: boolean }>
```

- `worktreeChangeList` lists every path whose working-tree content differs from commit `from`, in two parts:
  - Tracked files come from `git diff --numstat` and `--name-status` with `-z --find-renames` against `from`, with the working tree as the other side. That covers committed, staged and unstaged changes. Binary files come back from numstat as `-`, which maps to `binary: true` and null counts.
  - Untracked files come from `git ls-files --others --exclude-standard -z`, with status `untracked`. Counts come from reading the file: a NUL in the first 8000 bytes means binary, with null counts. A file over `MAX_BLOB_BYTES` gets null counts and `binary: false`. Otherwise `added` is the line count and `removed` is 0.
  - The `sharedSymlinks` exclusion and the `limit` cap apply exactly as `statusV2` applies them (`packages/git/src/status.ts:312`). The daemon passes the same options `readStatus` passes (`plugins/quirky.git/src/daemon/env.ts:~91`).
  - It never reads the index as the comparison side.
- `review` resolves the merge base the same way `compare` does (`readCompare`, `src/daemon/compare.ts:9`). When compare isn't `ready` (`invalid-base`, `unborn-head`, `no-merge-base`), `files` is the uncommitted status only, and `compare.status` tells the panel why.
- Each file appears once. `ReviewFile.status` maps from `GitChangeStatus` (`packages/protocol/src/model.ts:326`): `modified` gives `M`, `added` and `untracked` give `A`, `deleted` gives `D`, `renamed` gives `R`, and `copied` gives `A` with `oldPath` kept. A type change (git's `T`) reports as `modified`. `uncommitted` is true when the path is in `status.entries` in any area, and `staged` when it's in the `staged` area. A file that's partly staged is both.
- Conflicted paths (area `conflicts`) are included, with `conflict` set and `mark` always `'none'`.
- `capped` mirrors `GitStatus.capped`. The list is cut at the same `STATUS_ENTRY_LIMIT` (`packages/git/src/status.ts:17`).
- Review marks are evaluated on every call. A file's state is `'reviewed'` when the sha-256 of its current disk bytes (or the deletion sentinel) equals the stored hash, `'changed'` when it doesn't, and `'none'` with no row.
  - Rows for paths that no longer differ from the base are deleted on read, but only when `compare.status` is `ready` and `capped` is false. Otherwise a path can be missing from `files` without matching the base, and pruning it would lose the mark. That's the logic spec's "file matches base again".
  - When the stored base key differs from the current effective base, every row for the worktree is deleted on read. This catches base changes made outside `setBase` (`quirky.worktree/set`, `quirky.repo/set`).
- Errors: unknown worktree gives a plugin `not-found` error. Git failures go through `env.errors.translate` like every other method.

### Review marks ([Review marks](logic.md#review-marks))

`CONTRACT:`
```
quirky.git/setReviewMark { worktree?: string, path: string, reviewed: boolean, expected?: string | null } -> { mark: ReviewMarkState }
quirky.git/reviewedContent { worktree?: string, path: string } -> { content: string | null, hash: string, binary: boolean, tooLarge: boolean }
event quirky.git/reviewChanged { worktreeId: string }
```

- `setReviewMark reviewed: true` stores the current disk content of `path` and its hash. With `expected` given (the `modifiedHash` the user was looking at), a mismatch fails with a `conflict` whose `data.reason` is `changed-on-disk` (the reason `save` uses) and stores nothing, so a mark never records content the user didn't see. `null` means the file is deleted. A deleted file stores the deletion sentinel and no content.
- `setReviewMark reviewed: false` deletes the row. It's idempotent.
- Content is stored for text files up to `MAX_BLOB_BYTES` (`packages/git/src/diffs.ts`, 10 MiB). Binary and larger files store the hash only, and their changed-since-review diff falls back to the existing binary or too-large notice.
- `reviewedContent` returns the stored content for the reviewed → now diff. With no row it fails with `not-found`.
- Own writes keep the mark, and nothing else does:
  - `quirky.git/save` with `expected` equal to the row's hash moves the row to the new content and hash after a successful write.
  - On `quirky.editor/saved`, when `beforeHash` equals the row's hash, the row moves to `afterHash` and the new content, read from disk and checked against `afterHash`.
  - Any other write leaves the row alone, so the next `review` call reports `'changed'`.
- `setBase` clears every row for the worktree after its write succeeds. The panel's Change Base dialog shows the count first, from `ReviewModel.counts.reviewed + counts.changed`.
- Every mutation emits `reviewChanged` and `changed` for the worktree.

### Review diff source

`CONTRACT:`
```
quirky.git/diff { worktree?, path, source: 'review', against: 'base' | 'reviewed', oldPath? } -> GitDiff
```

- `against: 'base'` gives the merge base → disk, through `diffSource` with source `'worktree'` and `from` set to the merge base. When compare isn't `ready`, `from` is `HEAD`, or empty for an unborn HEAD.
- `against: 'reviewed'` gives the stored reviewed content → disk. With no row it fails `not-found`.
- Both return `GitDiff` (`packages/protocol/src/model.ts:445`) with `source: 'review'` and `modifiedHash` and `modifiedDeleted` filled. That lets the card pass `expected` to `setReviewMark` and `save`. Add `'review'` to `GitDiffSource` in the protocol model.

### Editor save event

`CONTRACT:`
```
event quirky.editor/saved { path: string /* absolute */, beforeHash: string | null, afterHash: string }
```

- Emitted once per successful `performSave`, after the write lands and before `this.emit()`. `beforeHash` is the baseline hash the guarded write checked (`null` for a new file). `afterHash` is the hash of the bytes written. Overwrite saves (`forceWrite`) emit with `beforeHash: null`.
- Accepted limits:
  - The subscriber runs asynchronously, so a `review` poll that lands between the write and the mark move can briefly report `changed`. The next poll corrects it.
  - If the `quirky.git` daemon half isn't active when the editor saves, the event is missed and the file shows changed since review.
- `quirky.git` resolves the worktree with `quirky.worktree/resolve { selector: 'current', cwd: <dirname of path> }`. A path outside every git worktree is ignored, and so is a resolve failure. The handler never throws back into the editor.

### Review tab ([The Review tab](logic.md#the-review-tab))

`CONTRACT:`
```
openReview(context: UiPluginContext, input: { worktree: string, reveal?: string, commit?: string | null, noteId?: string }): Promise<void>
ReviewViewHandle { worktree: string, reveal(path: string, noteId?: string): void, scrollToTop(): void, setScope(commit: string | null): void, loadedHash?(path: string): string | null | undefined }
```

- At most one Review tab per worktree in a window, whatever opened it. That's done by the `'review'` key being per worktree, and by `openReview` preferring a mounted `ReviewViewHandle` for that worktree (activate its tab with `quirky.terminal/activateTab`, then `reveal`/`setScope`) over remounting.
- When a window restores tabs from before this change, the first mounted legacy-mode tab for a worktree becomes that worktree's Review tab. Any later one closes itself (`closeHostedDiff`) after revealing its path in the surviving tab.
- With a mounted handle, `openReview` always calls `setScope(commit ?? null)` (a same-scope call is a no-op), then `reveal(path, noteId)` when `reveal` is given, else `scrollToTop()`. So `openReview` without `reveal` scrolls the tab to the top of the stack (scenario 3), and a row, palette or note open returns a commit-scoped tab to the worktree review.
- `reveal(path)` scrolls the card into view, expands it, and makes it the active card for F7/⇧F7. `setScope(commit)` swaps the card list to `commitFiles` and shows the `ScopeChip`. `null` returns to the worktree review.
- Card order is the panel's order: path order, or tree order when the panel is in tree mode.
- Each card shows `against: 'base'` by default. A `'changed'` card shows `against: 'reviewed'` with a "Full diff" toggle back to `'base'`, which holds until the card's state changes.
- Collapse: `'reviewed'` cards start collapsed, everything else starts expanded. A user's manual collapse or expand holds until the card's mark changes.
- Layout: a `ResizeObserver` on the tab body gives inline below 900 CSS px of body width and side-by-side at or above it. The header toggle overrides that for the tab's lifetime (component state, not a setting).
- Mark reviewed (the card button, or Space in the panel) calls `setReviewMark` with `expected` set to the card's last `modifiedHash`. The panel gets it from the mounted tab's `loadedHash(path)`. When no diff is loaded for the file (no tab, or a card never expanded), the caller first reads `quirky.git/diff { source: 'review', against: 'base' }` and passes its `modifiedHash` (`null` for a deletion), so a mark is never sent without `expected`. On `conflict`, refresh and leave the mark unset. On success, the panel selection and the tab move to the next file in panel order whose mark is `'none'` or `'changed'`. When there isn't one, nothing moves (scenario 4).
- Revert one change: confirm through `confirmForPlugin`, apply the chunk revert to the card's buffer, then `quirky.git/save { path, content, expected: modifiedHash }` right away. A save failure restores the buffer and shows a toast. Revert is offered on every card whose disk side exists, committed changes included. Writing base lines to disk is the intended result (scenario 9).
- Notes: unchanged storage and composer. Note counts appear on the card header (`✎ N notes`) and on the panel row.
- Commit scope: no review controls, and Revert is hidden, because the modified side isn't the working tree.

### Ship button ([The ship bar](logic.md#the-ship-bar), scenario 22)

`CONTRACT:`
```
nextStep(state: ShipState): ShipStep | null
shipMenu(state: ShipState): ShipMenuItem[]
ShipStep = { kind: 'commit-staged' | 'commit-all' | 'commit-selected' | 'pull' | 'sync' | 'publish' | 'push' | 'create-pr' | 'view-pr' | 'up-to-date', label: string, enabled: boolean, reason?: string }
ShipMenuItem = { id: string, label: string, enabled: boolean, detail?: string, separatorBefore?: boolean, danger?: boolean }
```

- `nextStep` picks the first row of logic scenario 22's table that applies, in table order. It returns `null` only for the clean case, where there's no ship bar.
- When no row applies but the case isn't clean, `nextStep` returns `{ kind: 'up-to-date', label: 'Pushed to <upstream>', enabled: false, reason }`. That covers everything pushed with no GitHub remote, and the base branch with nothing to push. The ship bar renders it as a muted status line with the caret beside it, not as a disabled button (logic spec Amendments, 2026-11-02). Add `'up-to-date'` to `ShipStep.kind`.
- While the GitHub lookup is `loading` or `waiting`, the Create PR row renders `Create PR` disabled with the reason `checking for a pull request…`. When it's `unavailable`, `Create PR` stays enabled, and pressing it reports the lookup failure in the error line through the existing chain.
- `nextStep` and `shipMenu` are pure functions in `src/panel/ship.ts`. `ShipState` holds the review model, `GitStatus` (`packages/protocol/src/model.ts:371`), the GitHub review result (`GitHubReviewResult`, `src/panel/GitHubReview.tsx`), the message, busy state, the commit-selected set, and whether the branch is the base branch.
- The commit steps carry no message guard. Clicking with an empty message sets the error line instead (scenario 26).
- Every caret entry from logic scenario 22's caret list plus Fast-forward and Rebase from base is always present. An entry that can't run has `enabled: false` and a `detail` reason. Reason strings are short and lowercase-led, such as `no GitHub remote`, `no upstream yet`, `this is the base branch`, `nothing to force`.
- Commit steps:
  - `commit-all` stages scope `all` (`quirky.git/stage { scope: 'all' }`) then commits.
  - `commit-staged` commits the index as is.
  - `commit-selected` stages exactly the ticked paths and unstages any other staged path, then commits.
  - Each step re-reads status with the existing `exactStatus` validation (`WorktreePanel.tsx:~825-848`) before and after.
- Create PR calls `quirky.reviews/createOpen { worktree }` after the existing guards. View PR calls `quirky.reviews/openLink` (`GitHubReview.tsx:253`).
- One step per click. The caret's combined entries (Commit & push, Commit, push & create PR) chain the existing steps and stop at the first failure.

### Errors at the ship bar ([The ship bar](logic.md#the-ship-bar), scenarios 26 and 29)

- One `InlineError` sits above the ship button. A ship-step failure sets it, with the next useful action where one exists: Pull first, Retry, Fix with AI (existing `useAiFix`), or Details (existing details dialog). Remote errors map through `toastFor` copy (`src/panel/remote-messages.ts`).
- It clears on the next ship-step attempt, on ×, or when the worktree changes.
- A failure shown in the error line raises no `context.toast`. Remove the duplicate toasts at `WorktreePanel.tsx:~654, 679, 695, 702, 713, 720, 757, 932`. Toasts stay for failures outside the ship bar (row actions, diff open).

### Panel keyboard and rows ([The panel](logic.md#the-panel), scenarios 16-19)

- The list is a single tab stop with `role="listbox"`. Rows are `role="option"` with `aria-selected`. ↑/↓ move the selection, Enter calls `openReview` with `reveal`, Space toggles the mark (with auto-advance on mark), Backspace or Delete starts Revert file with its confirm. Escape clears the selection, or leaves commit-selected mode.
- The selected row shows inline buttons for Revert and Open. Unselected rows show no buttons, and nothing reveals on hover.
- The right-click menu (`ContextMenu`) lists, in order: Open in Review, Open file (`quirky.editor/open`), Mark reviewed or Unmark, Revert file…, Stage or Unstage, Copy path, Copy relative path, Reveal in Finder.
- "Revert all…" in the ⋯ menu confirms with `Revert all N files?`, then applies the Revert file rule below to every file in the list, in path order. It isn't atomic. It stops at the first failure and shows a toast naming the file and how many are left, and files already reverted stay reverted.
- Revert file uses `quirky.git/discard { paths }` after the confirm. For a file whose changes are committed, discard has nothing to undo, so Revert file instead writes the base content (`showFile` at the merge base) through `quirky.git/save`. For an untracked file, discard deletes it and the confirm says so.

## Data models / schemas

These shapes carry the [Review marks](logic.md#review-marks) and [What a file's diff compares](logic.md#what-a-files-diff-compares) rules.

`SCHEMA:` the `review_marks` table, as one appended migration in `src/daemon/store.ts`:
```
review_marks(
  worktree_id TEXT NOT NULL,
  path TEXT NOT NULL,
  base_key TEXT NOT NULL,      -- effective base ref name when marked, e.g. "main" or "origin/main"
  hash TEXT NOT NULL,          -- sha-256 hex of the bytes, or "deleted"
  content BLOB,                -- null for binary, too-large or deleted
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (worktree_id, path)
)
```

`SCHEMA:` the review read model, returned by `quirky.git/review`:
```
ReviewModel = {
  worktreeId: string
  branch: string | null
  base: { name: string, source: 'param'|'upstream'|'worktree'|'project'|'detected', isCurrentBranch: boolean }
  compare: { status: GitCompare['status'], mergeBase: string | null, headOid: string | null, message?: string }
  totals: { added: number, removed: number }
  counts: { files: number, reviewed: number, changed: number, uncommitted: number, staged: number }
  capped: boolean
  files: ReviewFile[]          // sorted by path, byte order
}
ReviewFile = {
  path: string, oldPath?: string
  status: 'M' | 'A' | 'D' | 'R'
  added: number | null, removed: number | null, binary: boolean
  uncommitted: boolean, staged: boolean
  conflict?: GitStatusEntry['conflict']
  mark: 'none' | 'reviewed' | 'changed'
  notes: number
  submodule?: GitStatusEntry['submodule']
}
```
Add `ReviewModel`, `ReviewFile` and `ReviewMarkState = 'none' | 'reviewed' | 'changed'` to `packages/protocol/src/model.ts`, beside `GitCompare` (`:407`).

`SCHEMA:` the new `DiffViewInput` mode, in `src/shared/view-input.ts`:
```
{ worktree: string, mode: 'review', reveal?: string, commit?: string, commitMessage?: { subject, body }, noteId?: string }
key: `git-diff:${JSON.stringify([worktree, 'review'])}`
```

## DO-NOT-CHANGE fences

- `src/view/ConflictReview.tsx`, `src/view/ConflictFile.tsx`, `src/view/conflict-markers.ts` and the `conflicts`/`conflict-file` modes. Conflict resolution is out of scope ([Scope and non-goals](logic.md#scope-and-non-goals)). The only conflict change is dropping the "1 conflict(s)" chip in the panel.
- `src/ai/AiSettingsView.tsx` and the recipe store (`src/daemon/ai-recipes.ts`). The AI defaults form is out of scope.
- `plugins/quirky.reviews` (the PR form and `createOpen`). Out of scope. The panel only calls it.
- The git operations in `packages/git` (`stagePaths`, `unstagePaths`, `discardPaths`, `commit`, remote ops, `compare`). Their behavior stays. Only `worktreeChangeList`, the `'worktree'` diff source and `workingPatch` (HEAD to the working tree, untracked included, beside `stagedPatch`, for `generateCommitMessage { scope: 'all' }`) are added.
- The `notes` table and the note RPCs' shapes. Note placement changes, storage doesn't.
- Earlier entries in `src/daemon/store.ts` `migrations`. The store is append-only, and editing an applied migration breaks existing databases.
- The panel's Create PR safety checks (`exactStatus` revalidation, head-change detection, cancel). They protect against racing agent commits. Move them, never weaken them.

## Always / Ask / Never

Always:
- Compose new visuals from `@quirky/ui`, and put any new style in `packages/ui` with tokens (`--ui-accent`, `--ui-working`, `--ui-needs-you`, `--ui-failing`, `--ui-muted`, `--ui-selected`). `bun run ui:lint` must pass.
- Compute content hashes with `contentHash` (sha-256 hex). Never compare git blob ids with content hashes.
- Pass `expected` hashes on every mark and save, so a racing agent write is caught.
- Keep focus-revealed panel header icons. That's the CSS in `packages/ui/src/design-system/components.css:~993-1001`, so don't touch it.
- Write doc comments on new exported functions and components, per the repo's comment rules.

Ask the orchestrator before:
- Removing a manifest command id that another plugin, the CLI or a test outside `plugins/quirky.git` calls.
- Adding a dependency.
- Changing `GitStatus` or `GitCompare` shapes.

Never:
- Add CSS files, `<style>` tags or inline raw colors and pixels inside `plugins/quirky.git`.
- Run the full suite locally or on OVH (`AGENTS.md`).
- Show a ship-step error both in the error line and as a toast.
- Let a review mark stage, commit or block anything.

## Cross-cutting

- **Migration.** The `review_marks` migration is additive. Existing notes and recipes are untouched. On first run every file shows ○.
- **Legacy tabs.** Restored layouts may hold `file` or `combined` diff tabs. `parseInput` maps them, and the per-worktree fold closes extras (see the Review tab contract). `quirky.worktree` tests that assert the old input shape need updating with the navigation change.
- **Rollback.** The release is one merge. Reverting it leaves an unused `review_marks` table, which is harmless because the old code never reads it.
- **Performance.** `review` hashes only files that have a mark row, at most `STATUS_ENTRY_LIMIT`. The window polls `review` on the existing 3 s status cadence plus `changed` and `reviewChanged` events. Don't add another poll.
- **Security.** Paths from RPC params go through `containedPath` (`src/daemon/paths.ts`) like `save` does. The `saved` event handler ignores paths outside a resolved worktree.

## Testing strategy

Where tests run follows `AGENTS.md`: `bun test <file>` here while editing, `bun scripts/suite.ts <dir>` or `bun run test:affected` on OVH, and the full suite only on the PR with the `full-suite` label.

- `packages/git/test`: `worktreeChangeList` against a real temp repo covers committed, staged, unstaged, untracked, deleted, renamed and binary files, and a file both committed and edited again (once). Cover the `'worktree'` diff source for the same cases, including `modifiedDeleted`.
- `plugins/quirky.git/test/scenarios` (real daemon, real git): the review model and marks lifecycle.
  - Mark, then an outside write gives `changed`, and restoring the content gives `reviewed` again.
  - `save` with a matching `expected` keeps `reviewed`.
  - A `quirky.editor/saved` event with a matching `beforeHash` keeps `reviewed`.
  - `setBase` clears marks, and so does a base change through `quirky.worktree/set`.
  - A deleted file shows D and `none`. A file returning to the base drops its row. Marks survive a daemon restart on the same home.
  - `expected` mismatch gives `conflict`.
  - `generateCommitMessage { scope: 'all' }` with nothing staged.
- `plugins/quirky.editor/test`: `saved` is emitted once per successful save with the right hashes, and not on a failed guarded write.
- `plugins/quirky.git/test/pure`: `nextStep` returns the right step for every row of logic scenario 22's table, plus their precedence. `shipMenu` gives the right reasons for no remote, no upstream, base branch and nothing to force. Also cover the keyboard selection reducer, including auto-advance.
- `plugins/quirky.git/test/ui` (happy-dom, fake context): scenarios 1-4, 8 and 14-33 at the panel and Review-tab level, including the confirms, toasts and error lines they name.
  - Delete or rewrite tests that assert the removed sections, the selection footer, `CombinedDiff` or `FileDiff`. Never leave a skipped test behind.
- `plugins/quirky.git/test/window` (headless window, real daemon): one Review tab per worktree across row, palette, history and note opens. Restoring a layout with two legacy diff tabs leaves one Review tab.
- `packages/ui/test`: each new component's states, roles and labels, dark and light classes, and the caret menu's disabled items with `detail`.
- Done criteria ([How we know it's done](logic.md#how-we-know-its-done)):
  - Criteria 1-3 are asserted in `test/window`. Criterion 1 measures the first row's top against the panel's client height at a 720 px window.
  - Criterion 4 runs `COMMAND: bun run ui:review -- --author-family anthropic --output <new dir> --only quirky.git` with every image at 85 or more.
  - The twelve-goal click-through runs through `quirk:using-apps-like-a-user` against the whole branch before merge ([Rollout](logic.md#rollout)).

## Non-goals

- Line-level staging, three-way merge, conflict accept buttons, and branch-named conflict labels ([Deferred Ideas](logic.md#deferred-ideas)).
- Any change to how notes are stored, formatted or delivered.
- A daemon file watcher for `quirky.git`. The 3 s poll plus events is the change signal, as today.
- Sharing review marks across machines or worktrees.

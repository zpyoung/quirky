# Source control: remote operations, discard, branch compare, history, conflicts

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m2-source-control-core.md](../../../loop/decisions/m2-source-control-core.md)). Tech spec: requested; authored as [tech.md](tech.md) (gate: requested, crosses the git package, the plugin's daemon half and its window half).

**Amendments:** none yet.

## Conceptual model

The Source Control panel is Quirky's git client for one worktree. v1 already shows the branch, a
flat list of changed files, a diff for the chosen file, staging and a commit box. This item brings
the rest of Orca's client
([source-control.md](../../../../research/orca-features/source-control.md)) into the built-in
plugin `quirky.git` ([D5](../../../loop/decisions/m2-source-control-core.md)): Orca's sections
(Conflicts, Staged Changes, Changes, Untracked Files, Committed on Branch, Commits), discard,
every remote operation, branch compare against a base, history, merge and rebase conflicts, and
the diff views that open from those rows. Diff notes and the AI actions belong to the sibling item
`m2-source-control-notes-ai` ([D6](../../../loop/decisions/m2-source-control-core.md)), and
anything about pull requests to M4 ([D7](../../../loop/decisions/m2-source-control-core.md)).

Three ideas carry it:

1. **One snapshot drives the panel.** Everything the panel shows comes from one status read
   (`git status --porcelain=v2`) plus the upstream counts, the in-progress operation and the
   running remote call. A fixed decision ladder picks the one primary button from that snapshot.
   The daemon builds the snapshot, so `quirky git status --json` shows an agent exactly what the
   panel shows a person.
2. **Every action is one daemon method.** Push, pull, sync, discard-all and stage-all are each a
   single `quirky.git` method, and the panel calls the same method the CLI does. Orca composes
   Sync in its window; Quirky does it in the daemon, so `quirky git sync` and the Sync button can't
   differ ([D15](../../../loop/decisions/m2-source-control-core.md)).
3. **Nothing irreversible happens without a yes.** Discard, force push and abort are destructive
   methods. The window shows Orca's own dialogs and passes `yes`; the CLI and other callers
   confirm through `quirky ask` unless they pass `--yes`
   ([D11](../../../loop/decisions/m2-source-control-core.md)). Git never prompts: a credential or
   host-key question fails the call instead of hanging it.

The roadmap requires every flow to be scriptable. Each flow below is a script against the `quirky`
CLI or the daemon API, and the window scenarios are also used like a user.

## Data flow

**Reading.** The panel follows the worktree of the open view. While it is shown it calls
`quirky.git/status` every 3 seconds and after every action or `quirky.git/changed` event
([D30](../../../loop/decisions/m2-source-control-core.md)). The daemon resolves the worktree
selector through `quirky.worktree/resolve`, refuses folder workspaces, runs one porcelain-v2
status (stopping past 1,000 entries), adds line counts, works out the effective upstream and
whether the commits behind it are patch-equivalent, checks for `MERGE_HEAD`, a rebase directory
or `CHERRY_PICK_HEAD`, and adds the remote call running in that worktree, if any. Branch compare is
a second read (`quirky.git/compare`) every 30 seconds and after HEAD moves; history
(`quirky.git/history`) loads when its dock opens.

**Acting.** A row button, a section button, the primary button or its menu calls one method. A
remote method takes the worktree's remote lock for its duration, so a second remote call there is
refused ([D10](../../../loop/decisions/m2-source-control-core.md)). A failed call returns Orca's
normalised message and a `reason` the window turns into a toast or a card
([D18](../../../loop/decisions/m2-source-control-core.md)). Every successful mutation emits
`quirky.git/changed`, and every window refreshes.

**Viewing a diff.** Clicking a row opens the `quirky.git/diff` view in the main area with the
worktree, source and path as its input; the view reads both sides through `quirky.git/diff` and
renders them with `@codemirror/merge`. View all opens the same view in combined mode, which lists
the section's files and loads each one's diff lazily. Edits in an unstaged diff or a conflict file
save through `quirky.git/save`, which refuses when the file changed on disk since it was read.

**Conflicts.** When a pull, sync, merge or rebase stops on conflicts, the status shows them first
with their kind, and the panel replaces the commit box with the conflict card. Opening a conflict
file reads it through `quirky.git/conflictFile`, which also records that it was opened, so once git
stops listing it as unmerged it shows as "Resolved locally" until the operation ends
([D9](../../../loop/decisions/m2-source-control-core.md)). With no unresolved conflicts left, the
card offers Continue, which finishes the merge, rebase or cherry-pick
([D17](../../../loop/decisions/m2-source-control-core.md)), and Abort, which confirms first.

## Key decisions

- Extend `quirky.git` in place, with every composite as one daemon method
  ([D5](../../../loop/decisions/m2-source-control-core.md)).
- Grow the status record additively from porcelain v2, keeping v1's `files`
  ([D8](../../../loop/decisions/m2-source-control-core.md)).
- One remote operation per worktree at a time, visible as `busy`
  ([D10](../../../loop/decisions/m2-source-control-core.md)).
- Force push leases on the exact upstream commit it decided on
  ([D13](../../../loop/decisions/m2-source-control-core.md)).
- Continue finishes a merge, rebase or cherry-pick from the panel
  ([D17](../../../loop/decisions/m2-source-control-core.md)).
- The compare base is the worktree's base, else the project's, else the detected default
  ([D20](../../../loop/decisions/m2-source-control-core.md)).
- Diffs open in a main-area view and render with CodeMirror
  ([D23](../../../loop/decisions/m2-source-control-core.md),
  [D25](../../../loop/decisions/m2-source-control-core.md)).

Success is the scenarios below passing as scripts against a real `quirkyd` with real git, the
window scenarios passing when used like a user, and the three Orca defects of
[D33](../../../loop/decisions/m2-source-control-core.md) each having a test showing Quirky doesn't
have them.

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real
`quirkyd` and the built-in plugins, driven through the `quirky` CLI or the daemon API as it says.
Repositories are temporary and use real git with a global config of `/dev/null`. "(UI)" scenarios
are also used like a user in the window.

Most scenarios use project **api** at `/tmp/s/api` (branch `main`) whose `origin` is a local bare
repository `/tmp/s/origin.git` holding `main`, and its worktree **feat** at `/tmp/s/ws/api/feat`
on branch `zoe/feat`, created from base `origin/main`. A second clone **peer** at `/tmp/s/peer`
pushes to `origin` to make the remote move. "The agent" runs commands from inside **feat** unless
a scenario says otherwise, so `--worktree` defaults to it.

### Status and sections

1. **SC-1: status lists every row with its area, status and line counts** (CLI)
   - **Given** **feat** with `README.md` modified and staged, `math.ts` modified and not staged, `old.ts` renamed to `new.ts` and staged, and `notes.txt` untracked
   - **When** the agent runs `quirky git status --json`
   - **Then** the result keeps v1's `branch` (`zoe/feat`), `upstream`, `ahead`, `behind` and `files`, and adds one entry per row: `README.md` staged modified, `math.ts` unstaged modified, `new.ts` staged renamed from `old.ts`, `notes.txt` untracked; each entry carries its added and removed line counts (an untracked file counts its lines from disk); `operation` is `none`, `capped` is false, `busy` is null
   - **Data before:** **feat**: `README.md` (+2 −1, staged); `math.ts` (+5, unstaged); `old.ts` → `new.ts` (staged); `notes.txt` (3 lines, untracked)
   - **Walkthrough:**
     1. The agent runs `quirky git status --json`
     2. The daemon reads porcelain v2, then the staged and unstaged numstat, then counts `notes.txt`'s lines
   - **Data after:** **Entries**: ✓ `README.md` staged M +2 −1; ✓ `math.ts` unstaged M +5; ✓ `new.ts` staged R from `old.ts`; ✓ `notes.txt` untracked U +3

2. **SC-2: one path can be both staged and changed** (API)
   - **Given** `math.ts` with one hunk staged and another edited after
   - **When** an API client calls `quirky.git/status`
   - **Then** `math.ts` appears twice, once staged and once unstaged, each with its own counts; v1's `files` has it once with both letters

3. **SC-3: conflicts are listed first with their kind** (API)
   - **Given** a merge into **feat** that stopped with `a.ts` both modified, `b.ts` deleted by them and `c.ts` added by us
   - **When** an API client calls `quirky.git/status`
   - **Then** `operation` is `merge`; the three files are entries in the conflicts area, unresolved, with kinds `both_modified`, `deleted_by_them` and `added_by_us`; they sort before every other entry
   - **Conflict kinds:**

     | Porcelain code | Kind | Label |
     |---|---|---|
     | UU | both_modified | Both modified |
     | AA | both_added | Both added |
     | DD | both_deleted | Both deleted |
     | AU | added_by_us | Added by us |
     | UA | added_by_them | Added by them |
     | DU | deleted_by_us | Deleted by us |
     | UD | deleted_by_them | Deleted by them |

4. **SC-4: the operation in progress is read from the git directory** (API)
   - **Given** three worktrees: one mid-merge, one mid-rebase that stopped on a conflict, one mid cherry-pick with no conflicts left
   - **When** an API client calls `quirky.git/status` on each, and once more after each operation ends
   - **Then** `operation` is `merge`, `rebase` and `cherry-pick` (the linked worktree's own git directory is read, not the main checkout's), then `none` for each

5. **SC-5: detached and unborn HEADs are reported** (API)
   - **Given** worktree **feat** checked out at a commit with no branch, and a fresh repository **empty** with no commits
   - **When** an API client calls `quirky.git/status` on each
   - **Then** **feat** has `detached` true, `branch` null and `head` the commit; **empty** has `unborn` true, `head` null and `branch` its initial branch

6. **SC-6: shared-directory symlinks are hidden from untracked files** (API)
   - **Given** project **api** with `node_modules` in its shared directories, so **feat** has a `node_modules` symlink git sees as untracked, plus an untracked real file `scratch.txt`
   - **When** an API client calls `quirky.git/status`, then `quirky.git/stage` with scope `all`
   - **Then** only `scratch.txt` is listed as untracked, and stage-all stages `scratch.txt` but not the symlink

7. **SC-7: submodule rows are read-only and expand** (CLI)
   - **Given** **feat** with submodule `vendor/lib` whose own working tree has `x.c` modified
   - **When** the agent runs `quirky git status --json`, then `quirky git submoduleStatus --path vendor/lib --json`, then `quirky git stage --paths vendor/lib`
   - **Then** `vendor/lib` is an entry flagged as a submodule with tracked changes; the submodule status lists `x.c` modified; the stage fails with "Stage inside submodule" and stages nothing

8. **SC-8: the panel shows Orca's layout** (UI)
   - **Given** **feat** one commit ahead of `origin/zoe/feat`, with the changes of SC-1, and the panel open
   - **When** the person looks at the panel
   - **Then** top to bottom: the header with the filter toggle and the "More source control actions" menu; the branch row `zoe/feat → origin/main` with `↑1` and the line-total chip; the commit box; the sections Changes, Staged Changes and Untracked Files (the default "Changes first" order), each heading uppercase with its count; then Committed on Branch and the collapsed Commits dock. Rows show the file name in bold, the folder muted, `+N` and `−N` only when above zero, and the status letter in its colour (M, A, D, R, U, C). Empty sections are not shown.
   - **Data before:** **feat**: 1 commit ahead; SC-1's four changes
   - **Walkthrough:**
     1. The panel reads status, then compare
     2. It orders the sections by the group-order setting and hides empty ones
   - **Data after:** **Panel**: ✓ Changes (1); ✓ Staged Changes (2); ✓ Untracked Files (1); ✓ Committed on Branch (1); ✓ Commits (collapsed)

9. **SC-9: the group order setting reorders the sections** (UI)
   - **Given** the panel of SC-8
   - **When** the agent sets Source Control Group Order to "Staged first", then "Untracked first", through `quirky setting set`
   - **Then** the sections reorder live to Staged, Changes, Untracked, then Untracked, Changes, Staged; Conflicts, when present, always stays first

10. **SC-10: the panel's empty states** (UI)
    - **Given** (a) no view showing a worktree, (b) a folder workspace, (c) **feat** with no changes and nothing ahead of its base
    - **When** the person opens the panel in each
    - **Then** (a) "Select a workspace to view changes"; (b) "Opened as folder. Git features are unavailable for this workspace." as m1-worktrees set it ([D37](../../../loop/decisions/m2-source-control-core.md)); (c) "No changes on this branch" with "This workspace is clean and this branch has no changes ahead of origin/main"

11. **SC-11: the panel toggle shows the uncommitted count** (UI)
    - **Given** **feat** with the four changes of SC-1
    - **When** the person looks at the source control panel toggle, then commits everything
    - **Then** the toggle's badge shows 4 (one per row), then no badge; with a capped status (SC-58) it shows 1000

### Staging

12. **SC-12: rows, sections and renames stage and unstage** (CLI)
    - **Given** SC-1's changes
    - **When** the agent runs `quirky git stage --paths math.ts --paths notes.txt`, then `quirky git unstage --paths new.ts`
    - **Then** `math.ts` and `notes.txt` are staged; unstaging the rename resets both `new.ts` and `old.ts`, so `old.ts` shows deleted and `new.ts` untracked; each call emits `quirky.git/changed` once

13. **SC-13: staging follows Orca's eligibility** (API)
    - **Given** a merge with `a.ts` unresolved, `d.ts` resolved locally (SC-41), and submodule `vendor/lib`
    - **When** an API client stages `a.ts`, then `d.ts`, then `vendor/lib`
    - **Then** `a.ts` is refused with "Resolve the conflict before staging a.ts" because staging would erase the unmerged record; `d.ts` stages, which is how a resolution is finalised; `vendor/lib` is refused as in SC-7

14. **SC-14: row and section buttons follow eligibility** (UI)
    - **Given** the panel with SC-1's changes plus a deleted tracked file `gone.ts`
    - **When** the person hovers each row and each section heading
    - **Then** a changed row shows "Discard changes" and "Stage"; `gone.ts` shows "Restore file" and "Stage"; an untracked row shows "Delete untracked file" and "Stage"; a staged row shows only "Unstage". Section headings offer Discard all (Untracked says "Delete all untracked"), "Stage all" or "Unstage all", and "View all".

15. **SC-15: selection and the bulk bar** (UI, Orca defect)
    - **Given** the Changes section listing `a.ts`, `b.ts`, `c.ts` and `d.ts`
    - **When** the person clicks `a.ts`, then Shift-clicks `c.ts`, then Cmd-clicks `b.ts`, then presses Escape
    - **Then** the click opens `a.ts`'s diff and selects nothing; Shift-click selects `a.ts` to `c.ts` and the bulk bar reads "3 selected" with "Stage (3)"; Cmd-click toggles `b.ts` off ("2 selected"); Escape clears the selection and the bar. Orca opens a split on Shift-click and Cmd-click, so its range and toggle selection can't be reached. A context-click on an unselected row selects only it; changing worktree or view mode clears the selection.
    - **Data before:** **Selection**: none
    - **Walkthrough:**
      1. Click `a.ts` → diff opens; anchor `a.ts`; selection none
      2. Shift-click `c.ts` → `a.ts`, `b.ts`, `c.ts`
      3. Cmd-click `b.ts` → `a.ts`, `c.ts`
      4. Escape → none
    - **Data after:** **Selection**: ✓ none; **Bulk bar**: ✓ hidden

16. **SC-16: the filter narrows rows and pauses bulk actions** (UI)
    - **Given** the panel with SC-1's changes
    - **When** the person opens the filter and types `MATH`, then pastes 3,000 characters
    - **Then** only `math.ts` shows (case-insensitive substring of the path), the Commits dock and the section and bulk buttons are hidden; the long query shows "Search text is too large" and "Use a shorter file filter."; "Clear and close filter" or Escape restores everything

17. **SC-17: the tree view groups rows by folder** (UI)
    - **Given** changes `src/app/a.ts`, `src/app/b.ts` and `lib/c.ts`
    - **When** the person picks "View as tree" from the menu, then "Stage folder" on `src/app`
    - **Then** the section shows the compacted folder `src/app` (2 files) and `lib` (1 file), folders before files; staging the folder stages both its files; the choice persists as the view-mode setting

18. **SC-18: the row menu and dragging** (UI)
    - **Given** a row for `src/app/a.ts`
    - **When** the person opens its context menu and picks each item, then drags the row
    - **Then** the menu has View (opens its diff), Copy Path (the absolute path), Copy Relative Path (`src/app/a.ts`) and Reveal in Finder; dragging carries the absolute path as text. There is no "Open in" submenu ([D29](../../../loop/decisions/m2-source-control-core.md)).

### Discarding

19. **SC-19: discarding a changed file asks first** (CLI)
    - **Given** `math.ts` modified and not staged
    - **When** the agent runs `quirky git discard --paths math.ts`, then answers the ask yes; then edits it again and runs the same command with `--yes`
    - **Then** the first run prints "confirm in Quirky: Discard changes to \"math.ts\"?" and waits; after yes the file matches the index; the second discards without asking
    - **Data before:** **math.ts**: working copy differs from the index
    - **Walkthrough:**
      1. The CLI calls `quirky.git/discard`; the kernel asks with the text from `describeDiscard`
      2. The ask is answered yes; the CLI repeats the call with the confirmation
    - **Data after:** **math.ts**: ✓ matches the index; **Ask**: ✓ answered

20. **SC-20: untracked files are deleted and deleted files restored** (API)
    - **Given** untracked `notes.txt`, untracked folder `tmp/` with two files, and tracked `gone.ts` deleted from disk
    - **When** an API client discards `notes.txt`, `tmp/x` and `gone.ts` with `yes`
    - **Then** `notes.txt` and `tmp/x` are gone from disk; `gone.ts` is back with its index content

21. **SC-21: discarding staged changes unstages first** (API)
    - **Given** staged `README.md` (modified) and staged new file `added.ts`
    - **When** an API client discards the staged area with `yes`
    - **Then** both are unstaged, `README.md` matches HEAD, and `added.ts` is deleted, as Orca's "Staged new files will be deleted" says

22. **SC-22: discard refuses what it must not touch** (API)
    - **Given** a merge with `a.ts` unresolved and `d.ts` resolved locally, submodule `vendor/lib`, and a path `../outside.txt`
    - **When** an API client discards each with `yes`
    - **Then** each is refused and nothing changes: conflicts must be resolved or aborted, a submodule is changed inside itself, and a path outside the worktree is invalid

23. **SC-23: the window's discard dialogs** (UI)
    - **Given** the rows of SC-14 and two more untracked files
    - **When** the person clicks each discard button, and Discard all on each section
    - **Then** each dialog matches Orca's text, its confirm button has focus so Enter confirms, and Cancel changes nothing
    - **Dialog text:**

      | Case | Title | Body | Confirm |
      |---|---|---|---|
      | untracked file | Delete "notes.txt"? | This will permanently delete this file. This cannot be undone. | Delete |
      | deleted tracked file | Restore "gone.ts"? | This will restore the last staged version and discard the deletion. This cannot be undone. | Restore |
      | other file | Discard changes to "math.ts"? | This will revert the unstaged changes to this file. This cannot be undone. | Discard |
      | untracked section | Delete 3 untracked files? | This will permanently delete these 3 untracked files. This cannot be undone. | Delete 3 |
      | staged section | Discard all staged changes? | This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone. | Discard all |
      | changes section | Discard all unstaged changes? | This will revert all unstaged changes. This cannot be undone. | Discard all |

24. **SC-24: discard and stage failures are toasted once, with Retry** (UI)
    - **Given** a row whose discard fails (the file is locked read-only in a read-only folder)
    - **When** the person discards it twice, then a bulk discard of three files where two fail
    - **Then** one toast "Failed to discard “math.ts”" with the message and a Retry action (shown for 10 seconds), reused rather than stacked; the bulk case toasts "Failed to discard 2 file(s)" with the first message and up to three paths

### Committing

25. **SC-25: the commit box enables only with staged files and a message** (UI)
    - **Given** the panel with nothing staged, then one file staged
    - **When** the person reads the commit box, types a message, and presses Cmd+Enter
    - **Then** with nothing staged the primary button reads "Stage All" (SC-28 row 9); once staged and before typing it reads "Commit", disabled, titled "Enter a commit message to commit"; Cmd+Enter commits, clears the box and moves the file to Committed on Branch

26. **SC-26: an empty message is refused** (CLI)
    - **Given** one staged file
    - **When** the agent runs `quirky git commit --message "   "`
    - **Then** it fails with "Commit message is required" and nothing is committed

27. **SC-27: a failing hook blocks the commit with a summary** (CLI, UI)
    - **Given** a `pre-commit` hook that prints `eslint found 2 problems` and exits 1, and a staged file
    - **When** the agent runs `quirky git commit --message "Add math" --json`, then the person commits the same from the panel
    - **Then** the CLI's error has reason `lint`, summary "Lint failed during commit." and the hook's output; the panel shows the "Commit blocked" card with a "Lint" pill, the summary, and "Details", which opens "Commit Failed" with the raw output and "Close". A hook printing only `pre-commit: missing header` gives reason `hook` and "Pre-commit hook failed."; any other failure gives its first meaningful line, or "Commit failed."

### The primary button and its menu

28. **SC-28: the primary button follows Orca's ladder** (UI)
    - **Given** the panel of **feat** in each state of the table, in turn
    - **When** the person reads the primary button
    - **Then** the first row that matches gives its label, state and title, and the panel reports the same to `quirky ui state`
    - **Decision ladder:**

      | # | State | Label | Enabled | Title |
      |---|---|---|---|---|
      | 2 | committing | Commit | no | Commit in progress… |
      | 3 | a remote operation is running | its label (SC-30) | no | "<Label> in progress…" |
      | 4 | unresolved conflicts | Commit | no | Resolve conflicts before committing |
      | 7 | staged files and a message | Commit | yes | Commit staged changes |
      | 8 | staged files, no message | Commit | no | Enter a commit message to commit |
      | 9 | nothing staged, something stageable | Stage All | yes | Stage all changes |
      | 10 | upstream still loading | Commit | no | Stage at least one file to commit |
      | 11 | detached HEAD | Commit | no | Check out a branch before publishing commits. |
      | 11 | no upstream | Publish Branch | yes | Publish this branch to origin |
      | 12 | ahead and behind, the behind commits patch-equivalent | Force Push | yes | Remote only has older copies of local commits. Force push 2 branch commits with lease to update origin/zoe/feat. |
      | 12 | ahead and behind | Sync | yes | Pull 1, push 2 |
      | 13 | behind | Pull | yes | Pull 1 commit(s) |
      | 14 | ahead | Push | yes | Push 2 commit(s) |
      | 16 | otherwise | Commit | no | Nothing to commit. Branch is up to date. |

      Rows 1, 5, 6 and 15 need a pull request and come with M4 ([D7](../../../loop/decisions/m2-source-control-core.md)).

29. **SC-29: the menu lists every action, dimming what doesn't apply** (UI)
    - **Given** **feat** with an upstream, 2 ahead and 1 behind (not patch-equivalent), and a staged file with a message
    - **When** the person opens the chevron ("More commit and remote actions")
    - **Then** in order: Commit; Commit & Push; Commit & Sync; Push (2); Force Push (2); Pull (1); Fast-forward (1); Sync (↓1 ↑2); Rebase from origin/main; Fetch; Publish Branch, dimmed because an upstream exists. Each dimmed row's tooltip says why ("Commit changes first", "Check out a branch first", "Push first"). During a merge or rebase the menu ends with "Abort merge" or "Abort rebase". A compound action commits first and runs its remote part only if the commit succeeded.

30. **SC-30: a running remote call shows in every client and refuses a second** (CLI, UI)
    - **Given** a push to a slow remote (a pre-receive hook that sleeps 3 s), started with `quirky git push` from a terminal
    - **When** the panel is open during it, and the agent runs `quirky git fetch` meanwhile
    - **Then** the panel's primary reads "Push in progress…" disabled with a spinner and every menu row is disabled; status reports `busy` as push; the fetch fails with "A push is already running in this worktree." and reason `busy`; after the push the panel returns to the ladder
    - **Data before:** **feat**: 1 ahead; **Lock**: free
    - **Walkthrough:**
      1. The terminal's push takes the lock → status `busy`: push
      2. The agent's fetch ✗ refused
      3. The push ends → lock free; `quirky.git/changed` emitted
    - **Data after:** **feat**: ✓ 0 ahead; **Lock**: ✓ free

### Remote operations

31. **SC-31: publishing and pushing** (CLI)
    - **Given** **feat** with one commit and no upstream
    - **When** the agent runs `quirky git push`, makes another commit, and runs `quirky git push` again
    - **Then** the first push creates `zoe/feat` on `origin` and sets it as the upstream; the second pushes the new commit; both leave `ahead` at 0. With `branch.zoe/feat.pushRemote` set to `fork`, the push goes to `fork` instead.

32. **SC-32: a rejected push says to pull first** (CLI, UI)
    - **Given** **peer** has pushed a commit to `origin/zoe/feat` that **feat** hasn't fetched, and **feat** has its own commit
    - **When** the agent runs `quirky git push --json`, then the person clicks Push
    - **Then** the CLI fails with reason `non-fast-forward` and "Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first."; the window toasts "Push rejected — remote has changes. Pull first, then try again." and fetches, so the ladder moves to Sync

33. **SC-33: pulling, including divergent branches** (CLI)
    - **Given** (a) **feat** 1 behind; (b) **feat** 1 ahead and 1 behind with `pull.rebase` unset; (c) **feat** 1 behind where the incoming commit changes `math.ts`, which has uncommitted local edits
    - **When** the agent runs `quirky git pull` in each
    - **Then** (a) fast-forwards; (b) git's "Need to specify how to reconcile divergent branches" is retried with `--no-rebase`, making a merge commit; (c) fails with reason `local-changes` and "Pull would overwrite local changes. Commit, stash, or discard them before pulling." and nothing changes. With `pull.rebase=true`, (b) rebases instead.

34. **SC-34: fast-forward and fetch** (CLI)
    - **Given** **peer** has pushed one commit to `origin/zoe/feat` and deleted `origin/old`
    - **When** the agent runs `quirky git status --json`, `quirky git fetch`, `quirky git status --json`, then `quirky git fastForward`
    - **Then** behind goes from 0 to 1 after the fetch and `origin/old` is pruned; the fast-forward brings **feat** level; a fast-forward of a diverged branch fails with "Fast-forward failed." and git's detail, changing nothing

35. **SC-35: sync pulls then pushes, or force-pushes a rebased branch** (CLI)
    - **Given** (a) **feat** 1 ahead and **peer** pushed 1 different commit; (b) **feat**'s branch rebased locally onto a newer `origin/main`, so `origin/zoe/feat` only has older copies of its 2 commits
    - **When** the agent runs `quirky git sync` in each
    - **Then** (a) fetches, pulls (merging), and pushes, leaving 0 ahead and 0 behind; (b) fetches, sees every behind commit is patch-equivalent, and force-pushes with a lease on the upstream commit it just read, leaving `origin/zoe/feat` equal to **feat**
    - **Data before:** (b) **feat**: commits A′ B′ on new main; **origin/zoe/feat**: A B on old main
    - **Walkthrough:**
      1. fetch → ahead 2, behind 2
      2. cherry-mark: A ≡ A′, B ≡ B′ → patch-equivalent
      3. push with lease on the sha of B
    - **Data after:** (b) **origin/zoe/feat**: ✓ A′ B′

36. **SC-36: force push confirms and leases on what status showed** (CLI)
    - **Given** **feat** in state (b) of SC-35, after a fetch, then **peer** pushes another commit C on top of B without **feat** fetching
    - **When** the agent runs `quirky git forcePush --expected <sha of B> --yes`
    - **Then** the push is refused with reason `stale-lease` and "Force push rejected — remote changed since last fetch. Fetch first, then try again."; C is still on `origin`. Without `--yes` the kernel first asks "Force push zoe/feat to origin? This replaces the remote branch with your local commits." Orca's bare lease would have passed after a background fetch ([D13](../../../loop/decisions/m2-source-control-core.md)).

37. **SC-37: git never prompts, and errors never show credentials** (CLI)
    - **Given** a remote `https://zoe:s3cr3t@127.0.0.1:9/repo.git` that refuses connections, and a remote over ssh to a host that asks for a password
    - **When** the agent runs `quirky git fetch` against each
    - **Then** each fails within the timeout, without waiting for input: the first with reason `network` and "Network error. Check your connection.", the second with reason `auth` and "Authentication failed. Check your remote credentials."; no message, log line or error data contains `s3cr3t`

38. **SC-38: a failing pre-push hook blocks the push** (CLI, UI)
    - **Given** a `pre-push` hook printing `lint-staged failed` and exiting 1
    - **When** the agent runs `quirky git push --json`, then the person clicks Push
    - **Then** the error has reason `hook`, summary "Lint failed during push." and the output; the panel shows the "Push blocked" card with its pill and a Details dialog titled "Push Failed", and no inline remote error under the button

39. **SC-39: rebase from base** (CLI)
    - **Given** **peer** pushed a commit to `origin/main` touching a file **feat** doesn't, and **feat** has 2 commits
    - **When** the agent runs `quirky git rebaseFromBase`, then sets the base to the local branch `main` and runs it again
    - **Then** the first fetches `main` from `origin`, rebases **feat**'s 2 commits onto it, and leaves no temporary refs; the second fails with "Rebase needs a remote base branch (like origin/main)." When the incoming commit conflicts, the rebase stops and status shows `operation` rebase with the conflicts (SC-42).

40. **SC-40: operations that need an upstream or a branch say so** (CLI)
    - **Given** **feat** with no upstream, and separately with a detached HEAD
    - **When** the agent runs `quirky git pull`, `quirky git fastForward` and `quirky git sync` in each
    - **Then** with no upstream each fails with reason `no-upstream` and "Branch has no upstream. Publish the branch first."; detached, each (and `push`) fails with "Check out a branch first."

### Conflicts

41. **SC-41: a pull that stops on conflicts leads to Continue** (CLI, UI, Orca defect)
    - **Given** **feat** and **peer** both changed line 3 of `math.ts`; **peer** pushed
    - **When** the person clicks Sync; then opens `math.ts` from the Conflicts section, edits the markers away and saves with Cmd+S; then clicks Stage on it; then clicks "Continue merge"
    - **Then** the sync ends with the toast "Pull stopped with merge conflicts. Resolve them in Source Control, then continue the merge."; the commit box is replaced by "Merge conflicts: 1 unresolved" with Review conflicts and Abort merge; after the save git no longer lists `math.ts` as unmerged, so it shows "Resolved locally" with its check badge; once staged, the card becomes "Merge in progress" with "Continue merge", which commits the merge without opening an editor; the panel then offers Push. In Orca the commit box stays hidden during the merge and nothing continues it, so the person has to leave for a terminal. `quirky git continue` does the same from the CLI.
    - **Data before:** **feat**: 1 ahead, 1 behind; **math.ts**: both changed line 3
    - **Walkthrough:**
      1. Sync: fetch, pull → conflict; operation merge; `math.ts` unresolved, both_modified
      2. The person opens `math.ts` → recorded as opened
      3. Save without markers → `math.ts` resolved locally (git shows it as changed)
      4. Stage → 0 unresolved; Continue merge → merge commit
    - **Data after:** **feat**: ✓ 2 ahead, 0 behind; ✓ operation none; **math.ts**: ✓ resolved

42. **SC-42: a rebase continues commit by commit** (CLI)
    - **Given** a rebase of 2 commits that stops on the first with `a.ts` both modified
    - **When** the agent resolves and stages `a.ts`, runs `quirky git continue`, and the second commit conflicts on `b.ts`
    - **Then** `continue` applies the first commit and returns with the rebase stopped again; status shows `b.ts` unresolved and `operation` rebase; after resolving `b.ts` a second `continue` finishes and `operation` is `none`. `continue` with unresolved conflicts fails with "Resolve every conflict before continuing." and changes nothing; with no operation it fails with "Nothing to continue."

43. **SC-43: abort asks first** (CLI, UI)
    - **Given** a merge stopped on conflicts
    - **When** the agent runs `quirky git abort`, answering the ask no; then the person clicks Abort merge in the panel and confirms
    - **Then** the CLI's ask reads "Abort merge? This cancels the merge in progress and can discard conflict resolutions made during this merge."; declining changes nothing; the window's dialog has the same text and a destructive "Abort merge" button, and confirming returns **feat** to its pre-merge commit. A failed abort toasts "Abort merge failed". For a rebase every "merge" reads "rebase"; a cherry-pick has no Abort (Orca's), only Continue.

44. **SC-44: the conflict file view** (UI)
    - **Given** `math.ts` with two conflict blocks, the second with a common-ancestor section
    - **When** the person opens it from the Conflicts section and uses Next conflict twice
    - **Then** the view shows the banner "Unresolved conflict · Both modified" and "1 / 2"; marker lines are tinted, with the labels "Current change", "Common ancestor", "Incoming change" and "End conflict"; Next moves to "2 / 2" then wraps to "1 / 2". A "deleted by them" file shows "Decide whether to keep the file or accept deletion"; a side with no working file shows "No working-tree file is available to edit for this conflict."

45. **SC-45: the conflict review view** (UI)
    - **Given** a merge with `a.ts` and `b.ts` unresolved
    - **When** the person clicks Review conflicts, resolves and stages `a.ts`, deletes `b.ts` with `git rm` in a terminal, and clicks Refresh
    - **Then** the view lists both under "Files" as Unresolved with "2 unresolved conflicts · Snapshot captured at <time>."; after Refresh `a.ts` reads Resolved and `b.ts` Gone, and the view shows "All conflicts resolved" and "This review snapshot no longer has any live unresolved conflicts." with "Source Control" and "Dismiss"

46. **SC-46: a finished operation leaves only its banner** (UI)
    - **Given** a cherry-pick stopped on conflicts, then resolved and staged
    - **When** the person looks at the panel
    - **Then** it shows "Cherry-pick in progress" with Continue cherry-pick and no Abort; the commit box stays hidden until the operation ends

### Branch compare

47. **SC-47: Committed on Branch lists what the branch changed since its base** (CLI, UI)
    - **Given** **feat** with 2 commits since `origin/main` changing `math.ts` (+12 −3) and adding `util.ts` (+40), while `origin/main` has 1 commit **feat** lacks
    - **When** the agent runs `quirky git compare --json`, then the person opens the panel
    - **Then** status `ready`, base `origin/main`, 2 ahead, 1 behind, entries `math.ts` modified and `util.ts` added with their counts, totals +52 −3; the panel's Committed on Branch section lists both with the hover title "2 files changed vs origin/main", and the branch row chip shows `+52 −3`. The compare shows committed changes only, from the merge base, so `origin/main`'s own commit isn't listed.

48. **SC-48: compare explains when it can't run** (CLI, UI)
    - **Given** (a) the base set to `origin/gone`, which doesn't exist; (b) an unborn HEAD; (c) a branch with no common history with `origin/main`
    - **When** the agent runs `quirky git compare --json` in each, and the person looks at the panel
    - **Then** (a) `invalid-base`: "Base ref origin/gone could not be resolved in this repository."; (b) `unborn-head`: "This branch does not have a committed HEAD yet, so compare-to-base is unavailable."; (c) `no-merge-base`: "This branch and origin/main do not share a merge base, so compare-to-base is unavailable." The panel shows the message with "Change base ref" and "Retry"; with no uncommitted changes it shows the card "Branch compare unavailable" instead.

49. **SC-49: which base the compare uses** (API)
    - **Given** four worktrees: **w1** created with base `origin/release`; **w2** with no base in a project whose default base is `origin/develop`; **w3** with neither, in a repo whose `origin/HEAD` is `origin/main`; **w4** like **w3** with upstream `origin/zoe/w4`
    - **When** an API client compares each, then sets Default Compare Base to "Branch upstream" and compares **w4** again
    - **Then** **w1** uses `origin/release`, **w2** `origin/develop`, **w3** and **w4** `origin/main`; with the setting, **w4** compares against `origin/zoe/w4`. Rebase from base always uses the base, never the upstream.

50. **SC-50: Change Base Ref writes where the base came from** (CLI, UI)
    - **Given** **w1** and **w2** of SC-49, and local branches `main` and `release`, remote branches `origin/main` and `origin/release`
    - **When** the person opens "Change Base Ref…" on **w1**, searches `rel` and picks the local branch `release`; then on **w2** picks `origin/main`; then on **w2** clicks Use Primary
    - **Then** the dialog reads "Change Base Ref" with "Pick the branch compare target for this repository.", lists branches matching the search, and marks the current one; **w1**'s worktree base becomes `release`; **w2** has no base of its own, so the project's default base becomes `origin/main`, which every worktree of the project without its own base now uses; Use Primary clears the project's default, so **w2** falls back to the detected default. `quirky git setBase --base release` and `quirky git setBase --clear` do the same from the CLI.

51. **SC-51: compare refreshes on its own** (UI)
    - **Given** the panel showing Committed on Branch
    - **When** the person commits a file, and separately an agent commits in a terminal
    - **Then** after the panel's own commit the section updates at once; after the terminal's commit it updates within 30 seconds, or at once on the next status read that shows HEAD moved; "Refresh branch compare" in the menu reloads it immediately

### History

52. **SC-52: history lists recent commits from HEAD** (CLI)
    - **Given** **feat** with 60 commits, the newest a merge, the tip also tagged `v1`
    - **When** the agent runs `quirky git history --json`, then `quirky git history --limit 500 --json`
    - **Then** the first returns 50 commits newest first in topological order, each with its id, parents, author name and email, author and commit times, subject, body and refs (the tip shows `HEAD -> zoe/feat` and `tag: v1`), and `hasMore` true; the second returns all 60 because the limit is capped at 200, with `hasMore` false

53. **SC-53: a commit's files and diffs** (CLI)
    - **Given** commit **C** changing `math.ts` and renaming `old.ts` to `new.ts`, and the repo's root commit **R** adding `a.txt`
    - **When** the agent runs `quirky git commitFiles --commit <C>`, `quirky git diff --source commit --commit <C> --path new.ts`, and `quirky git commitFiles --commit <R>`
    - **Then** **C** lists `math.ts` modified and `new.ts` renamed from `old.ts` with counts; the diff's left side is `old.ts` at **C**'s parent and its right side `new.ts` at **C**; **R** lists `a.txt` added, diffed against nothing

54. **SC-54: the Commits dock** (UI)
    - **Given** **feat** with the history of SC-52
    - **When** the person expands Commits, clicks the newest commit, expands it and clicks one of its files, then clicks "Load more"
    - **Then** the dock is collapsed by default; each row shows the subject, short id, author and relative time, with ref chips; clicking the commit opens the combined diff titled "Commit 1a2b3c4: Merge main"; clicking a file opens its single commit diff; Load more shows the rest up to 200

### Diffs

55. **SC-55: each diff source reads the right sides** (API)
    - **Given** `math.ts` committed as v1, staged as v2 and edited on disk to v3; untracked `notes.txt`; branch compare ready from SC-47
    - **When** an API client calls `quirky.git/diff` for `math.ts` with sources `staged` and `unstaged`, for `notes.txt` unstaged, and for `util.ts` with source `branch`
    - **Then** staged is v1 → v2, unstaged v2 → v3, `notes.txt` empty → its content, and `util.ts` empty at the merge base → its content at HEAD; v1's `staged: true` still means the staged source
    - **Data before:** **math.ts**: HEAD v1; index v2; disk v3
    - **Walkthrough:**
      1. staged: HEAD → index
      2. unstaged: index → disk
    - **Data after:** **Diffs**: ✓ staged v1 → v2; ✓ unstaged v2 → v3

56. **SC-56: binary, image, huge and deleted files** (API)
    - **Given** a changed `logo.png`, a changed `blob.bin` with NUL bytes, a `big.txt` with 130,000 lines changed, an 11 MiB `huge.json`, and `gone.ts` deleted from disk
    - **When** an API client diffs each unstaged
    - **Then** `logo.png` is kind `image` with both sides as base64 PNG; `blob.bin` and `huge.json` are kind `binary`; `big.txt` is text with empty bodies and a too-large marker giving the line counts, the character count and the reason "line count exceeds the safe display limit"; `gone.ts` has its index content on the left and is marked deleted on the right

57. **SC-57: a diff that can't be read says so** (API, UI, Orca defect)
    - **Given** a branch compare from SC-47, after the merge base's objects were made unreadable (the base commit pruned from a shallow clone)
    - **When** an API client calls `quirky.git/diff` with source `branch` for `math.ts`, and the person opens it
    - **Then** the call fails with git's message rather than returning an empty diff, and the view shows "Error loading diff: <message>". Orca swallows branch and commit diff errors into an empty diff, which looks like "no changes".

58. **SC-58: huge repositories are capped** (CLI, UI)
    - **Given** **feat** with 1,500 untracked files and 2 modified tracked files
    - **When** the agent runs `quirky git status --json`, then the person clicks the banner's Stage All, then Retry
    - **Then** status has the first 1,000 entries and `capped` true, with no line counts; the panel shows "Too many changes detected. Only the first 1000 are shown." with Stage All and Retry; the Changes section's Stage all stages tracked files only and the Untracked one has none; the banner's Stage All stages everything (scope `all`); the badge shows 1000

59. **SC-59: huge folders can be ignored** (CLI, UI)
    - **Given** the state of SC-58, where 1,400 of the untracked files are under `node_modules`
    - **When** the person sees the panel, and clicks "Add to .gitignore"
    - **Then** once per worktree the panel toasts `This repository has too many active changes. Add "node_modules" to .gitignore?`; the click appends `node_modules/` to `.gitignore`; `quirky git ignoreFolder --folder ../etc` is refused, since only `node_modules`, `.next`, `dist`, `build`, `target` and `vendor` are allowed

60. **SC-60: the single-file diff view** (UI)
    - **Given** `math.ts` changed in two places far apart
    - **When** the person clicks its row, presses F7, Shift+F7, switches to side-by-side, and toggles Word Wrap and Show Whitespace from the view's menu
    - **Then** the diff opens in the main area titled "math.ts (diff)", scrolled to the first change, inline by default (the Default Diff View setting); F7 and "Next change" move to the second change, Shift+F7 and "Previous change" back, both arrows disabled when there are no changes; the side-by-side toggle ("Switch to side-by-side diff") shows two panes; wrap and whitespace follow their settings; with Collapse Unchanged Regions on, unchanged runs fold into bands; the panel keeps showing **feat**; Close returns to **feat**'s sessions

61. **SC-61: unstaged diffs are editable and save safely** (UI)
    - **Given** the unstaged diff of `math.ts` open, and the staged diff of `README.md`
    - **When** the person edits `math.ts`'s right side and presses Cmd+S; then edits again while an agent rewrites `math.ts` in a terminal, and presses Cmd+S
    - **Then** the first save writes the file; the second shows "This file changed on disk since your edits. Use the banner to compare, reload, or overwrite." with Reload from Disk and Overwrite; Overwrite writes the person's text, Reload discards it. The staged, branch and commit diffs are read-only. `quirky git save --path math.ts --content … --expected <hash>` behaves the same way.

62. **SC-62: View all opens a combined diff** (UI)
    - **Given** 8 changed files, one of them with 12,000 changed lines and one an unresolved conflict
    - **When** the person clicks View all on Changes, then Collapse All, Side by Side, Wrap On, Whitespace On and "Show file tree", then "Load diff" on the large file
    - **Then** the view reads "Changes" with the file count, the toolbar's buttons toggle as named (and write their settings), the first six sections load and the rest load as they scroll into view, the large file shows "Large diffs are not rendered by default." with "Load diff", and the conflict is left out with "Conflicted files are reviewed separately" and "1 unresolved conflicts were excluded from this diff view." with Review conflicts. Each section header shows the path, the counts, copy path and "Open diff". Unstaged sections are editable and save as in SC-61. "Open Branch Diff" switches to the branch's combined diff, titled "Branch Changes (origin/main)".

63. **SC-63: big and binary diffs show a fallback** (UI)
    - **Given** the files of SC-56
    - **When** the person opens each diff
    - **Then** `big.txt` shows "This diff is too large to display safely." with "Original lines", "Modified lines", "Characters", the reason and "Limits: 120,000 lines per side · 6,000,000 combined characters"; `logo.png` shows "Original" and "Modified" image panes ("No preview" for a missing side); `blob.bin` shows "Binary file changed" and "Text diff is unavailable for this file."

### Commands and scripting

64. **SC-64: every window action is a command** (CLI)
    - **Given** a window connected to the daemon
    - **When** the agent runs `quirky ui run quirky.git.show`, `quirky ui run quirky.git.open-diff --args '{"path":"math.ts","source":"unstaged"}'`, `quirky ui run quirky.git.next-change`, `quirky ui run quirky.git.open-changes --args '{"area":"unstaged"}'` and `quirky ui run quirky.git.review-conflicts`, reading `quirky ui state` after each
    - **Then** each does what its button does: the panel opens, the diff view opens on `math.ts`, the view reports the second change as current, the combined diff opens, and the conflict review opens; Mod+Shift+G runs the first and F7 the third

65. **SC-65: the panel and views report what they show** (CLI)
    - **Given** the panel of SC-8 with `math.ts`'s diff open and one row selected
    - **When** the agent runs `quirky ui state --json`
    - **Then** the panel's report has the worktree, branch, base, ahead and behind, the visible sections with their counts, the primary button's label, state and title, the selection, the filter, the view mode, `busy` and the operation; the diff view's report has its mode, source, paths, the current change and whether it has unsaved edits

66. **SC-66: the API lists every method with its schema** (CLI)
    - **Given** a running daemon
    - **When** the agent runs `quirky api --json`
    - **Then** `quirky.git` lists `status`, `diff`, `stage`, `unstage`, `discard`, `describeDiscard`, `commit`, `push`, `forcePush`, `describeForcePush`, `pull`, `fastForward`, `fetch`, `sync`, `rebaseFromBase`, `continue`, `abort`, `describeAbort`, `compare`, `setBase`, `branches`, `history`, `commitFiles`, `conflictFile`, `save`, `submoduleStatus`, `hugeFolders`, `ignoreFolder` and `reveal`, each with params and result schemas, with `discard`, `forcePush` and `abort` destructive; `quirky git --help` lists the same as commands

### Orca defects

Each Orca defect recorded in source-control.md for this slice has a test showing Quirky doesn't
have it ([D33](../../../loop/decisions/m2-source-control-core.md)):

- **Shift-click and Cmd-click can't select.** SC-15.
- **A stopped merge or rebase can't be finished in the panel.** SC-41, SC-42, SC-46.
- **Branch and commit diff errors look like empty diffs.** SC-57.

## Scope & non-goals

In scope: everything in source-control.md except what follows
([D3](../../../loop/decisions/m2-source-control-core.md)).

Out of scope, with where it goes:

- Diff notes: adding, editing, the Notes shelf, sending to an agent, the "AI notes" pill, the note
  counts on rows, and the `sourceControl.sendReviewNotes` and `editor.addReviewNote` shortcuts
  (`m2-source-control-notes-ai`).
- AI actions: generating commit messages, AI Fix on the commit and push cards, Resolve with AI on
  the conflict card, the agent action dialog and every `sourceControlAi` setting
  (`m2-source-control-notes-ai`, [D6](../../../loop/decisions/m2-source-control-core.md)).
- Hosted review: Create PR, the PR link and "Link PR", ladder rows 1, 5, 6 and 15, PR states in
  row 11, push targets from a PR, the fork push notice, Create PR and Push before PR in the menu,
  the creation defaults (M4, [D7](../../../loop/decisions/m2-source-control-core.md)).
- Changes mode on edit tabs and the Markdown diff preview (m2-editor), preview versus permanent
  tabs and split-group opening (editor tabs), the "Open in" submenu
  ([D35](../../../loop/decisions/m2-source-control-core.md)).
- The worktree row's dirty marker (m2-sidebar-extras).
- SSH, WSL and runtime hosts, which Quirky doesn't have; Linux and Windows paths
  ([D34](../../../loop/decisions/m2-source-control-core.md)).
- Accept Current, Incoming or Both, stash and amend, which Orca doesn't have either.

## Decisions Locked

**Visual**
- Diffs open in a main-area `quirky.git/diff` view; Close returns to the worktree's sessions ([D23](../../../loop/decisions/m2-source-control-core.md)).
- The panel follows Orca's layout, sections, rows, dialogs, cards and strings ([D3](../../../loop/decisions/m2-source-control-core.md), [D29](../../../loop/decisions/m2-source-control-core.md)).
- The combined diff loads lazily and on demand past 10,000 changed lines ([D26](../../../loop/decisions/m2-source-control-core.md)).
- Conflict files open in an editable view with Orca's markers and banner, no accept buttons ([D27](../../../loop/decisions/m2-source-control-core.md)).
- The panel toggle's badge is the uncommitted count ([D31](../../../loop/decisions/m2-source-control-core.md)).
- Status polls every 3 s while shown, compare every 30 s, and nothing fetches on a timer ([D30](../../../loop/decisions/m2-source-control-core.md)).

**API**
- Status grows additively and keeps `files` ([D8](../../../loop/decisions/m2-source-control-core.md)).
- Failed remote calls carry Orca's message and a `reason` ([D18](../../../loop/decisions/m2-source-control-core.md)); commit and push failures carry Orca's classification ([D19](../../../loop/decisions/m2-source-control-core.md)).
- Diff results follow Orca's sources, kinds and limits ([D24](../../../loop/decisions/m2-source-control-core.md)); saves have a disk precondition ([D25](../../../loop/decisions/m2-source-control-core.md)).
- History returns 50 by default and 200 at most ([D22](../../../loop/decisions/m2-source-control-core.md)).

**CLI**
- Every method is a generated `quirky git` command; discard, force push and abort confirm unless `--yes` ([D11](../../../loop/decisions/m2-source-control-core.md)).
- Commands, keybindings and settings follow Orca's ([D32](../../../loop/decisions/m2-source-control-core.md)).

**Integration**
- Push sets the upstream every time, and Publish Branch is a push ([D12](../../../loop/decisions/m2-source-control-core.md)).
- Force push leases on the exact upstream commit ([D13](../../../loop/decisions/m2-source-control-core.md)).
- Pull, fast-forward and fetch use Orca's arguments ([D14](../../../loop/decisions/m2-source-control-core.md)); sync is one daemon method ([D15](../../../loop/decisions/m2-source-control-core.md)); rebase from base uses Orca's fork point ([D16](../../../loop/decisions/m2-source-control-core.md)).
- One remote call per worktree at a time ([D10](../../../loop/decisions/m2-source-control-core.md)).
- Continue finishes merges, rebases and cherry-picks ([D17](../../../loop/decisions/m2-source-control-core.md)); "Resolved locally" lives in the daemon ([D9](../../../loop/decisions/m2-source-control-core.md)).
- The compare base comes from the worktree, then the project, then detection ([D20](../../../loop/decisions/m2-source-control-core.md)), and shows committed changes only ([D21](../../../loop/decisions/m2-source-control-core.md)).
- Huge repositories cap at 1,000 entries ([D28](../../../loop/decisions/m2-source-control-core.md)).

## Industry Insights

- VS Code and GitHub Desktop spawn the git binary with stdin ignored and a forced locale, and parse stderr first on failure; Desktop caps captured output at 256 KB. ([VS Code git.ts](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/git.ts), [Desktop core.ts](https://raw.githubusercontent.com/desktop/desktop/development/app/src/lib/git/core.ts))
- Lazygit reads the operation in progress from marker files in the git directory, not from git commands; linked worktrees need `git rev-parse --git-dir`. ([lazygit status.go](https://raw.githubusercontent.com/jesseduffield/lazygit/master/pkg/commands/git_commands/status.go), [Adam Johnson](https://adamj.eu/tech/2023/05/29/git-detect-in-progress-operation/))
- Porcelain v2 lines are `1`, `2`, `u`, `?`, `!` plus `# branch.*` headers; parsers should skip unknown headers. ([git-status](https://git-scm.com/docs/git-status))
- `GIT_TERMINAL_PROMPT=0` doesn't stop ssh from opening `/dev/tty`; `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` or dropping the controlling terminal is needed. ([markcheck #2](https://github.com/donnex/markcheck/issues/2), [git docs](https://git-scm.com/docs/git))
- A bare `--force-with-lease` checks the cached remote-tracking ref, which any fetch refreshes; the explicit `--force-with-lease=<ref>:<sha>` form is the safe one. Desktop uses the bare form. ([git-push](https://git-scm.com/docs/git-push), [israynotarray 2026](https://israynotarray.com/en/git/2026/02/26/git-push-force-with-lease-better-than-force/), [Desktop push.ts](https://github.com/desktop/desktop/blob/development/app/src/lib/git/push.ts))
- VS Code's sync is fetch, pull, then push only when ahead, with no force; neither VS Code nor Desktop passes a fixed pull strategy. ([VS Code repository.ts](https://github.com/microsoft/vscode/blob/main/extensions/git/src/repository.ts), [Desktop pull.ts](https://github.com/desktop/desktop/blob/development/app/src/lib/git/pull.ts))
- `git log --cherry-mark` marks patch-equivalent commits with `=`, which detects a rebased branch, but walks every commit since divergence. ([git-log](https://git-scm.com/docs/git-log))
- `GIT_EDITOR=true git rebase --continue` continues without an editor. ([TIL](https://til.codeinthehole.com/posts/how-to-continue-a-git-rebase-and-skip-editing-the-commit-message/))
- `@codemirror/merge` computes diffs synchronously, falls back to an imprecise diff past `scanLimit`, and has `collapseUnchanged` in both views; reports of crashes with huge documents and nothing on many views per page argue for lazy mounting and Orca's render limits. ([CodeMirror reference](https://codemirror.net/docs/ref/), [merge changelog](https://github.com/codemirror/merge/blob/main/CHANGELOG.md), [forum 7245](https://discuss.codemirror.net/t/how-to-load-large-documents-in-a-mergeview-avoiding-browser-to-crash-and-styling-issues/7245))

## Deferred Ideas

- `[tech-spec]` How the daemon detaches git from a controlling terminal (BatchMode alone, or a new session too).
- `[tech-spec]` Where the remote lock and the "opened conflict" set live, and how they reset on restart.
- `[tech-spec]` How the window shares one `@codemirror/merge` setup between the single, combined and conflict views.
- `[tech-spec]` The save precondition's token (content hash or mtime), shared with m2-editor later.

## Glossary

- **Area:** which section a row belongs to: conflicts, staged, unstaged (Changes) or untracked.
- **Base:** the ref a branch is compared and rebased against; see SC-49.
- **Busy:** the remote call running in a worktree, if any.
- **Compare:** the branch's committed changes from its merge base with the base to HEAD.
- **Ladder:** the ordered rules that pick the panel's one primary button.
- **Lease:** the commit a force push expects the remote branch to be at; the push fails otherwise.
- **Operation:** a merge, rebase or cherry-pick in progress.
- **Patch-equivalent:** commits that make the same change under different ids, as after a rebase.
- **Resolved locally:** a conflicted file opened in Quirky that git no longer lists as unmerged, while the operation is still in progress.
- **Upstream:** the remote branch the current branch tracks.

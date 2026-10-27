# Source control: diff notes sent to an agent, AI commit messages

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m2-source-control-notes-ai.md](../../../loop/decisions/m2-source-control-notes-ai.md)). Tech spec: requested; authored as [tech.md](tech.md) (gate: requested, crosses `quirky.git`'s daemon and window halves, `quirky.agents` and `quirky.terminal`).

**Amendments:**
- 2026-10-27, before build: Codex adversarial review ([D32](../../../loop/decisions/m2-source-control-notes-ai.md)). An unconfirmed delivery keeps the notes (NA-18); agent output is decoded and cleaned before it becomes a message, including OpenCode's JSON events (NA-27); any typing during a generation keeps the box, even if the text typed was deleted again (NA-30).
- 2026-10-27, during build ([D39](../../../loop/decisions/m2-source-control-notes-ai.md)): the CLI flag for a range start is `--start-line` (NA-4); a value that starts with `--` is passed as `--args=--model gpt-5.4` (NA-39); under NA-32's repository recipe Codex also takes the global `--model haiku` in place of its default model; a disabled session's tooltip is the daemon's reason, such as "Codex is waiting for approval." (NA-17).
- 2026-10-27, Final Round 1 ([D43](../../../loop/decisions/m2-source-control-notes-ai.md)): notes are pruned only when their own worktree no longer resolves, never at activation (NA-23).

## Conceptual model

This item finishes Orca's source control
([source-control.md](../../../../research/orca-features/source-control.md)) on top of
`m2-source-control-core`. It adds the two things that turn the git client into a review loop with
an agent: **diff notes** and **AI actions**
([D3](../../../loop/decisions/m2-source-control-notes-ai.md)).

A **diff note** is a short piece of text a person pins to one line, or a range of lines, on the
modified side of a diff. Notes belong to a worktree, stay on this machine, and exist only to be
turned into a prompt and sent to an agent. Sending them pastes one plain prompt (file, lines,
comment) into a running agent or starts a new agent with it, and a delivered note is deleted.

An **AI action** runs the user's own agent CLI. There are four:

- **Generate commit message** runs the agent once, non-interactively, with the staged changes, and
  puts what it prints in the commit box.
- **AI Fix** on the "Commit blocked" and "Push blocked" cards, and **Resolve with AI** on the
  conflict card, open a new agent tab with a prepared prompt that tells the agent how to fix the
  failure or finish the merge or rebase.

Each action has a **recipe**: which agent, which extra CLI arguments, and a command template that
wraps Orca's base prompt. Recipes are saved for all repositories or for one.

Three ideas carry the design:

1. **The daemon holds the state, the window draws it.** Notes, recipes, the last commit and push
   failure, and any running generation live in `quirky.git` in the daemon. `quirky git notes`,
   `quirky git sendNotes`, `quirky git generateCommitMessage` and `quirky git aiFix` do exactly
   what the window's buttons do ([D14](../../../loop/decisions/m2-source-control-notes-ai.md)).
2. **Agent shapes are agent data.** How to run each agent once (binary, arguments, prompt on
   stdin or argv, default model) is a data block on its `agent` contribution in `quirky.agents`,
   which also runs it. `quirky.git` only builds prompts and reads results
   ([D15](../../../loop/decisions/m2-source-control-notes-ai.md)).
3. **Prompts are Orca's, byte for byte.** The note format, the commit message prompt and the three
   fix prompts are the doc's text, so an agent behaves as it does in Orca.

## Data flow

**Adding a note.** In a diff the person clicks the "+" beside a line, drags across line numbers, or
selects lines and presses Mod+Shift+A. A draft card opens below the last line. "Add note" calls
`quirky.git/addNote`, which checks the path and lines, trims the body, stores the note with a new
ID and emits `quirky.git/notesChanged`. Every window showing that worktree re-reads its notes: the
diff draws the card, the file rows get their count, and the Notes shelf appears.

**Sending notes.** The send menu asks the daemon for targets: the worktree's live agent sessions,
each marked sendable or not with a reason, then the installed, enabled agents for a new tab.
Picking one calls `quirky.git/sendNotes` with the scope (one note, one file, or all unsent notes)
and the target. The daemon takes the notes in scope that aren't already in a running send, holds
them, formats them into one prompt, removes control characters, and either pastes the prompt into
the session and presses Enter, or opens a new agent tab with it as the first prompt and waits for
delivery. On success it deletes each sent note whose text and lines haven't changed since the send
began; on failure it keeps them. Either way it releases the hold and emits `notesChanged`.

**Generating a commit message.** The sparkle button (or `quirky git generateCommitMessage`)
resolves the commit message recipe, reads the staged files and patch, builds Orca's prompt inside
the recipe's template, and asks `quirky.agents/generate` to run the agent once in the worktree.
That method spawns the agent's one-shot command in its own process group, writes the prompt to
stdin (or puts it in argv), closes stdin, and returns what it prints, or fails on a timeout, a bad
exit or too much output. `quirky.git` turns the output into a subject and body. The window puts
the message in the box unless the person typed meanwhile or pressed stop.

**Fixing a failure.** When a commit or push fails, the daemon keeps that failure for the worktree
until the next successful commit or push. AI Fix (or `quirky git aiFix`) builds the fix prompt
from it, or the conflict prompt from the current status, applies the recipe's template, picks the
agent, and calls `quirky.terminal/newTab` with the agent, the prompt and the recipe's CLI
arguments. The new tab submits the prompt once the agent is ready.

## Key decisions

- Notes are stored by `quirky.git`, keyed by worktree, and survive a daemon restart
  ([D6](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Notes are anchored by path and line numbers, as Orca does, and show in every diff of that path
  ([D7](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Markdown notes and Changes mode belong to `m2-editor`; the shelf lists diff notes
  ([D4](../../../loop/decisions/m2-source-control-notes-ai.md)).
- A send deletes only what it delivered unchanged, and holds notes out of other sends while it
  runs ([D12](../../../loop/decisions/m2-source-control-notes-ai.md)).
- A send never types into an agent that is starting, waiting for approval or blocked
  ([D13](../../../loop/decisions/m2-source-control-notes-ai.md)).
- One-shot shapes, default models and limits are Orca's, for every agent Orca supports, plus a
  custom command ([D16](../../../loop/decisions/m2-source-control-notes-ai.md),
  [D17](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Recipes are saved per action, globally and per repository, and edited in the launch dialog and
  a "Source Control AI defaults" view
  ([D19](../../../loop/decisions/m2-source-control-notes-ai.md),
  [D20](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Fix actions open a new agent tab; generation runs once and returns text
  ([D23](../../../loop/decisions/m2-source-control-notes-ai.md)).

## Behavior & scenarios

Fixtures are illustrative. Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real
`quirkyd` and the built-in plugins, driven through the `quirky` CLI or the daemon API as it says.
Repositories are temporary and use real git with a global config of `/dev/null`. "(UI)" scenarios
are also used like a user in the window.

Project **api** at `/tmp/s/api` has worktree **feat** at `/tmp/s/ws/api/feat` on branch
`zoe/feat`, as in the core spec. In **feat**, `math.ts` (40 lines) is modified and not staged,
`util.ts` is modified and staged, and `README.md` is committed on the branch. "The agent" runs
commands from inside **feat**, so `--worktree` defaults to it.

Agents are fakes. `quirky agents configure --agent claude --command <fake>` points Claude at a
script that records its argv, stdin and environment to a file, then either prints a canned reply
and exits (one-shot) or behaves as a terminal agent that reports ready and echoes what it receives.
Nothing calls a real model.

### Adding and editing notes

1. **NA-1: the "+" beside a line adds a one-line note** (UI)
   - **Given** the unstaged diff of `math.ts` open, no notes
   - **When** the person hovers line 30 of the modified side, clicks the "+" (title "Add note for the AI"), types "Handle the empty list" and presses Enter
   - **Then** a draft card headed "Line 30" with the placeholder "Add note for the AI", "Cancel" and "Add note" opened below line 30; after Enter it is replaced by a saved card "Note line 30" with "Send", "Edit note" and "Delete note"; the `math.ts` row shows a message icon with 1 (title "1 note"); the diff header shows an "AI notes 1" pill; the Notes shelf appears in the panel with "Notes 1"
   - **Data before:** **feat notes**: none
   - **Walkthrough:**
     1. The person clicks "+" on line 30; the window opens a draft for lines 30-30
     2. Enter calls `addNote` with `math.ts`, line 30 and the text
     3. The daemon stores the note and emits `notesChanged`; the window re-reads notes
   - **Data after:** **feat notes**: ✓ `math.ts` line 30 "Handle the empty list"

2. **NA-2: a range comes from a gutter drag or from Mod+Shift+A** (UI)
   - **Given** the unstaged diff of `math.ts` with no notes
   - **When** (a) the person presses on line number 3 and drags to line 7, then types and presses Enter; (b) selects from line 12 column 1 to line 15 column 1 with Shift+Down and presses Mod+Shift+A; (c) starts a drag and presses Escape before releasing
   - **Then** (a) the draft and saved card read "Lines 3-7" and "Note lines 3-7"; (b) the draft reads "Lines 12-14", because a selection ending at column 1 of a line leaves that line out; (c) no draft opens; a click with no drag makes a one-line draft

3. **NA-3: the draft card's keys and buttons** (UI)
   - **Given** a draft card open on line 30
   - **When** the person tries each of: Shift+Enter; Mod+Enter; Escape; Enter while an input method is composing; clicking outside with text typed; clicking outside with the draft empty; opening a second draft on line 31 with text typed in the first
   - **Then** Shift+Enter adds a line break; Mod+Enter and Enter save; Escape cancels; Enter while composing does not save; a click outside keeps a draft that has text and cancels an empty one; the second draft carries the first draft's text over and the first closes. "Add note" is disabled while the trimmed text is empty and reads "Adding..." while the save runs; the textarea grows from 60 to 240 pixels

4. **NA-4: notes are added, listed and kept across a restart through the CLI** (CLI)
   - **Given** **feat** with no notes
   - **When** the agent runs `quirky git addNote --path math.ts --line 30 --body "  Handle the empty list  " --json`, then `quirky git addNote --path util.ts --start-line 2 --line 4 --body "Rename x" --json`, then `quirky git addNote --path math.ts --line 5 --body "Typo" --json`, restarts the daemon, and runs `quirky git notes --json`
   - **Then** each add returns the note with an ID, the trimmed body, its lines and `createdAt`; the list after the restart holds all three sorted by path, then line: `math.ts` 5, `math.ts` 30, `util.ts` 2-4
   - **Data before:** **feat notes**: none
   - **Walkthrough:**
     1. Three adds store three notes; the body "  Handle the empty list  " is trimmed
     2. The daemon restarts and reopens the plugin store
     3. `notes` reads them back and sorts them
   - **Data after:** **feat notes**: ✓ `math.ts` 5 "Typo"; ✓ `math.ts` 30 "Handle the empty list"; ✓ `util.ts` 2-4 "Rename x"

5. **NA-5: bad notes are refused** (API)
   - **Given** **feat**
   - **When** an API client calls `quirky.git/addNote` with (a) line 0; (b) start line 9 and line 4; (c) the body "   "; (d) a 70 000-byte body; (e) the path `../other/x.ts`; (f) a path with a NUL byte
   - **Then** every call fails with `invalid-params` and stores nothing: (a) and (b) "Lines must be whole numbers from 1, with the start at or before the end."; (c) "Note is empty."; (d) "Comment is too large to submit safely."; (e) and (f) the core spec's path refusal "Path must stay inside the worktree."

6. **NA-6: notes are edited and deleted** (UI)
   - **Given** the saved note "Note line 30" from NA-1
   - **When** the person clicks "Edit note", sees "Cancel" and "Save" with "Save" disabled, changes the text to "Handle empty and null" and presses Enter; then clicks "Delete note"
   - **Then** "Save" is enabled only when the trimmed text is non-empty and differs; Enter saves (Shift+Enter adds a line break, Escape cancels); the card shows the new text and `quirky git notes --json` shows `updatedAt` set; "Delete note" removes the card, the row count and the shelf at once, with no confirmation

7. **NA-7: a note shows in every diff of its path, never where there is no text** (UI)
   - **Given** a note on `util.ts` lines 2-4, `util.ts` staged, and a branch commit that also touched `util.ts`
   - **When** the person opens `util.ts`'s staged diff, its branch diff from Committed on Branch, the commit's diff from the Commits dock, and "View all" on Staged Changes
   - **Then** the same card "Note lines 2-4" appears under line 4 of the modified side in each, and the combined section takes new notes like a single diff; a note on line 99 of a 40-line file is drawn after the last line; an image diff, a binary diff and the "too large to display safely" fallback show no "+" and accept no Mod+Shift+A

8. **NA-8: a failed save keeps the draft** (UI)
   - **Given** a draft with text on `math.ts` line 30, and the worktree removed from Quirky by another client meanwhile
   - **When** the person presses Enter
   - **Then** the toast "Failed to save comment" shows, the draft stays open with its text, and nothing is stored

### Counts and the Notes shelf

9. **NA-9: rows count notes by path** (UI)
   - **Given** two notes on `math.ts` and one on `util.ts`; `util.ts` both staged and changed again
   - **When** the person looks at the panel
   - **Then** the `math.ts` row shows the message icon with 2 (title "2 notes"); both `util.ts` rows, staged and changed, show 1 (title "1 note"); rows with no notes show no icon

10. **NA-10: the Notes shelf lists, opens and scrolls to notes** (UI)
    - **Given** notes on `math.ts` lines 5 and 30, on `util.ts` lines 2-4 (staged, not changed since), on `README.md` line 1 (committed on the branch, no uncommitted change), and on `gone.ts` line 3 (not changed anywhere)
    - **When** the person reads the shelf, then clicks each note
    - **Then** the shelf header reads "Notes 5" and lists `README.md` 1, `gone.ts` 3, `math.ts` 5, `math.ts` 30, `util.ts` 2-4, each with its line label and text; clicking opens, in order of preference, the path's unstaged diff, else its untracked diff, else any uncommitted diff (here `util.ts`'s staged diff), else its branch diff (`README.md`), else the path's diff against HEAD with no changes (`gone.ts`), and scrolls the note's card into view
    - **Opening rule:**

      | Note's path has | Opens |
      |---|---|
      | an unstaged change | the unstaged diff |
      | only an untracked entry | the untracked file's diff |
      | another uncommitted entry | that entry's diff (staged) |
      | only a Committed on Branch entry | the branch diff |
      | nothing | the file's diff against HEAD, showing no changes |

11. **NA-11: notes are copied as their prompt text** (UI)
    - **Given** the three notes of NA-4
    - **When** the person clicks "Copy all notes to clipboard" on the shelf, then "Copy note" on the `util.ts` note, and the agent runs `quirky git formatNotes`
    - **Then** the clipboard holds exactly NA-15's text for all three notes, then for the one note; `formatNotes` prints the same text as the copy-all; when the clipboard write is refused the toast "Failed to copy notes" shows

12. **NA-12: notes are cleared per file or all at once, after a yes** (UI, CLI)
    - **Given** the three notes of NA-4
    - **When** the person opens "More note actions", picks "Clear notes for math.ts", and confirms; then picks "Clear all notes..." and cancels; then the agent runs `quirky git clearNotes` without `--yes` in a non-interactive shell, then with `--yes`
    - **Then** the first dialog reads "Clear 2 notes from math.ts?" and deletes both `math.ts` notes; the second reads "Clear 1 note from this workspace?" and deletes nothing; the CLI without `--yes` fails with the core spec's confirmation error naming that text; with `--yes` it deletes the last note and the shelf disappears. If the clear fails the toast "Failed to clear notes." shows and the notes stay

13. **NA-13: the overflow menu's Notes item and the shelf's presence** (UI)
    - **Given** **feat** with no notes, then with two
    - **When** the person opens "More source control actions"
    - **Then** with no notes there is no "Notes" item and no shelf; with two, the item reads "Notes 2" and choosing it scrolls the shelf into view and expands it if collapsed

14. **NA-14: the diff header pill and the combined view's note controls** (UI)
    - **Given** notes on `math.ts` (2) and `util.ts` (1), and "View all" on all changes open
    - **When** the person looks at the single-file diff of `math.ts`, then the combined view, hovers a section header, and clicks the toolbar's notes pill
    - **Then** the single-file header shows a sparkle "AI notes 2" pill (aria-label "Send AI notes to an agent") that opens the send menu; the combined toolbar shows "Show 3 AI notes" and a "Send" menu; hovering the `math.ts` section header reveals a send icon (only on sections whose file has notes); the pill opens a preview of up to 4 notes with "Copy" and "Clear"

### Sending notes

15. **NA-15: the prompt is Orca's text, with control characters removed** (API)
    - **Given** notes on `src/a.ts` line 12 with the body `Handle null "x"` + line break + `second line`, and on `src/b.ts` lines 40-52 with `Extract this block` followed by the characters ESC `[201~` and ` rm -rf`
    - **When** an API client calls `quirky.git/formatNotes`
    - **Then** the text is the two blocks below joined by one blank line, with no preamble or trailer; the escape character is gone, so the rest of the body stays inside the quoted comment and can't end a bracketed paste
    - **Prompt:**

      ```
      File: src/a.ts
      Line: 12
      User comment: "Handle null \"x\"\nsecond line"

      File: src/b.ts
      Lines: 40-52
      User comment: "Extract this block[201~ rm -rf"
      ```

16. **NA-16: notes are pasted into a running agent and then deleted** (CLI)
    - **Given** the three notes of NA-4, and a fake Claude terminal session **s1** in **feat** whose agent status is `working`
    - **When** the agent runs `quirky git sendNotes --scope all --session s1 --json`
    - **Then** **s1** receives the bracketed paste of the three-note prompt and, after a pause, Enter; the result says `delivered` with the three note IDs; `quirky git notes --json` is empty; `notesChanged` was emitted
    - **Data before:** **feat notes**: `math.ts` 5; `math.ts` 30; `util.ts` 2-4
    - **Walkthrough:**
      1. The daemon checks **s1** is a live terminal agent session in **feat** and not starting, waiting or blocked
      2. It holds the three notes, formats them and pastes the prompt with Enter through `quirky.terminal/send`
      3. It deletes the three notes, whose text and lines are unchanged, and releases the hold
    - **Data after:** **feat notes**: ✓ none; **s1 input**: ✓ ESC[200~ prompt ESC[201~ then Enter

17. **NA-17: the send menu offers scopes, then targets** (UI)
    - **Given** notes on `math.ts` (2) and `util.ts` (1); in **feat**, Claude session **s1** `working` titled "fix tests", Codex session **s2** waiting for approval, a shell session, and Claude and Codex installed and enabled
    - **When** the person opens the send menu from the `math.ts` diff pill, from the shelf, and from a note card
    - **Then** the pill's menu reads "Send notes" with "This file 2" first and "All unsent notes 3" second, each opening "Send notes to": **s1** with its state dot and "Working · 2m ago · fix tests" (enabled), **s2** disabled with the tooltip "Codex is waiting for approval.", no shell; then "New agent" with Claude and Codex. The shelf's menu has only "All unsent notes"; the card's menu has only "This note". The trigger's tooltip is "Send notes to an agent". Sending shows "Sending notes...", then "Notes sent."

18. **NA-18: notes start a new agent tab** (UI, CLI)
    - **Given** the note on `math.ts` line 30 and no sessions
    - **When** the person picks "This note" > New agent > Claude; and the agent runs `quirky git sendNotes --scope file --path util.ts --agent claude --json` for the `util.ts` note
    - **Then** each opens a new Claude tab in **feat** whose first prompt is that note's text, submitted once the agent is ready; each note is deleted once the prompt is confirmed delivered (pasted after the agent reported ready, or passed on the command line); when the prompt can't be delivered the send fails with "The agent did not receive the notes.", and when it was pasted blind (the agent never reported ready, or exited before Enter) it fails with "The agent may not have received the notes. They were kept."; in both cases the note stays

19. **NA-19: a note edited during its send survives** (API)
    - **Given** notes on `math.ts` 5 and 30, and a send of all notes to a new Claude tab whose fake agent takes 2 seconds to become ready
    - **When** an API client edits the line 30 note to "Handle empty and null" while the send runs
    - **Then** the send delivers the old text of both notes; afterwards the line 5 note is gone and the line 30 note remains with its new text and counts as unsent

20. **NA-20: notes in a running send are held out of other sends** (API)
    - **Given** the send of NA-19 still running, plus a third note on `util.ts` added during it
    - **When** another client sends all unsent notes to **s1**, then a third client asks to send all again while both run
    - **Then** the second send delivers only the `util.ts` note; the third fails with `conflict` "All notes are already being sent." In the window the menu trigger reads "Sending…" and is disabled while every unsent note is held; with no notes at all it reads "All notes sent" and is disabled

21. **NA-21: a send to an unready target is refused and the notes stay** (API)
    - **Given** notes on `math.ts`; session **s2** waiting for approval; session **s3** still starting; session **s4** exited; shell session **s5**; session **s6** in another worktree
    - **When** an API client sends to each
    - **Then** each fails with `conflict` and the notes stay: **s2** "Codex is waiting for approval.", **s3** "Claude is still starting.", **s4** "The session has exited."; **s5** and **s6** fail with `invalid-params` "Notes go to an agent session in this worktree."; with no unsent notes in scope the send fails with `conflict` "There are no unsent notes."

22. **NA-22: Send Review Notes to Agent opens the shelf's menu** (UI)
    - **Given** the Source Control panel hidden; first no notes, then one note
    - **When** the person runs "Send Review Notes to Agent" from the command palette each time
    - **Then** with no notes nothing happens; with one, Source Control opens and the shelf's send menu opens on "All unsent notes"; a request the panel can't answer within 5 seconds is dropped. The command has no default chord

23. **NA-23: a removed worktree's notes go with it** (API)
    - **Given** two notes on **feat**
    - **When** **feat** is deleted through `quirky worktree delete --yes`, and an API client lists notes for its ID
    - **Then** the list call fails with the worktree's not-found error, and the notes are gone from the store the next time that worktree's notes are read (activation never prunes, because a transient listing failure would look like a removal)

### Generating commit messages

24. **NA-24: the sparkle button's states** (UI)
    - **Given** the commit box in **feat** with "Show Source Control AI actions" on
    - **When** the person hovers the sparkle (aria-label "Generate commit message with AI") with (a) nothing staged; (b) `util.ts` staged and a message typed; (c) unresolved conflicts; (d) a generation running; (e) a commit running; (f) `util.ts` staged and an empty box; (g) the same with every agent disabled; then turns the setting off
    - **Then** the tooltips are (a) "Stage at least one file to generate a message."; (b) "Clear the message to regenerate."; (c) no sparkle, because the commit box is hidden during conflicts (core rule); (d) "Generating commit message…", and on hover a stop square (aria-label "Stop generating commit message") titled "Generating commit message. Click to stop."; (e) "Commit in progress…"; (f) enabled, "ai commit msg" (Orca's text); (g) "Pick an agent in Source Control AI settings."; with the setting off the sparkle, AI Fix and Resolve with AI are gone

25. **NA-25: the first generation goes through the Generate dialog** (UI)
    - **Given** `util.ts` staged, an empty box, no commit message recipe, and fake Claude printing "Rename x to count." then a blank line and "Clearer name."
    - **When** the person clicks the sparkle, sees "Generate Commit Message" ("Choose the agent and command template for this run.") with an agent picker defaulting to Claude and the template `{basePrompt}`, and clicks "Generate"
    - **Then** the sparkle spins while the run lasts; the box then holds "Rename x to count" (trailing dot removed), a blank line and "Clearer name."; no recipe is saved, so the next click opens the dialog again

26. **NA-26: generation runs the agent once with Orca's command and prompt** (CLI)
    - **Given** `util.ts` staged with a 3-line change, fake Claude as above
    - **When** the agent runs `quirky git generateCommitMessage --json`
    - **Then** the result is `{message, subject, body, agent: "claude"}`; the fake recorded argv `-p --output-format text --model sonnet --permission-mode plan --effort low --strict-mcp-config --settings {"disableAllHooks":true}` (Orca's Claude background arguments; when Claude refuses `--strict-mcp-config` because an enterprise MCP config is present, the run is retried once without it), ran in **feat**, and read exactly Orca's prompt on stdin: the rules, `Branch: zoe/feat`, `Staged files:` with `M	util.ts`, and the minimal patch in a `diff` fence; stdin was closed after the prompt
    - **Data before:** **feat**: `util.ts` staged (+1 −1); box empty
    - **Walkthrough:**
      1. The daemon resolves the recipe: no agent saved, so the default agent, Claude
      2. It reads `git diff --cached --name-status` and the minimal patch, and builds the prompt
      3. `quirky.agents/generate` runs Claude's one-shot command with the prompt on stdin, closes stdin, and returns the output
      4. The daemon splits subject and body
    - **Data after:** **Result**: ✓ subject "Rename x to count"; ✓ body "Clearer name."

27. **NA-27: the output becomes a subject and body by Orca's rules** (API)
    - **Given** fake agents printing (a) "Add parser for the new config format and wire it into the loader and the CLI." ; (b) nothing; (c) "Fix crash..." then two blank lines and "Because the list was empty."; (d) a "Generating…" line, then the message inside a fenced code block; (e) a `<think>` block, then "- Fix crash"; (f) OpenCode's JSON event stream with a `text` event holding "Fix crash"; (g) OpenCode's JSON event stream with an `error` event "model not found"
    - **When** an API client generates each
    - **Then** (a) the subject is the first 72 characters with no trailing dot and no body; (b) "Update project files"; (c) subject "Fix crash", body "Because the list was empty."; (d) the status line and the fence are dropped; (e) the reasoning block and the list marker are dropped, giving "Fix crash"; (f) "Fix crash", never the JSON; (g) the generation fails with "OpenCode failed: model not found"

28. **NA-28: large staged changes are cut to Orca's budget** (API)
    - **Given** (a) two staged files whose patches total 300 000 bytes; (b) a staged file whose patch is over 10 MiB; (c) 400 staged files whose name list exceeds 6000 characters
    - **When** an API client generates a message
    - **Then** (a) the patch in the prompt is at most 200 000 bytes, shared fairly between the two files on line boundaries, ending with `...(diff truncated, N bytes omitted)`; (b) the patch section reads `(diff omitted — too large to read; infer the change from the staged file list above)`; (c) the file list is cut at 6000 characters

29. **NA-29: generation errors are reported, never hung** (API)
    - **Given** (a) nothing staged; (b) a fake agent that sleeps forever and ignores SIGTERM; (c) an agent command that doesn't exist; (d) a fake that exits 3 printing "quota exceeded" to stderr; (e) a fake that prints 5 MiB; (f) default agent set to Aider, whose entry has no one-shot shape
    - **When** an API client generates a message
    - **Then** each fails and the box is untouched: (a) `conflict` "No staged changes to summarize."; (b) after 60 seconds, "Claude did not finish within 60 seconds.", with its whole process group killed; (c) "Claude could not be started. Check the agent command in Settings and try again."; (d) "Claude failed: quota exceeded"; (e) "Claude produced more than 4 MiB of output."; (f) `invalid-params` "Aider can't generate text. Pick another agent."

30. **NA-30: one generation per worktree, and stop means stop** (UI, API)
    - **Given** a fake agent that takes 5 seconds and starts a child process
    - **When** (a) an API client starts a generation and a second client starts another in **feat**; (b) the person clicks the sparkle, then clicks it again (stop); (c) the person clicks the sparkle, then types in the box before it finishes, or types and deletes it again
    - **Then** (a) the second fails with `conflict` "A commit message is already being generated."; (b) `cancelGenerate` ends the run, the agent and its child are gone, and the box is untouched; (c) the run finishes but the box keeps what the person left there, even when that is empty again

31. **NA-31: a custom command takes the prompt in argv or on stdin** (CLI)
    - **Given** `ai-custom-command` set to `my-gen --fast {prompt}`, then to `my-gen --fast`, and the commit message recipe's agent set to "Custom command"
    - **When** the agent runs `quirky git generateCommitMessage` each time
    - **Then** the first runs `my-gen` with `--fast` and the whole prompt as one argument; the second runs `my-gen --fast` with the prompt on stdin; an empty custom command fails with `invalid-params` "Set a custom command in Source Control AI settings."

32. **NA-32: the recipe shapes the run** (CLI)
    - **Given** a global commit message recipe with template `{basePrompt}` + line break + `Use Conventional Commits on {branch}. {unknown}` and CLI arguments `--model haiku`, then a repository recipe for **api** with agent Codex
    - **When** the agent runs `quirky git generateCommitMessage` before and after the repository recipe is saved
    - **Then** before: Claude runs with `--model haiku` in place of `--model sonnet` (never both), and the prompt ends with "Use Conventional Commits on zoe/feat. {unknown}" (unknown variables stay as written); after: Codex runs (`exec --ephemeral --skip-git-repo-check -s read-only` and `-c model_reasoning_effort=low`) with the global template and arguments, because the repository recipe sets only the agent, so the global `--model haiku` replaces Codex's default `--model gpt-5.6-terra` (one `--model`). The sparkle now runs directly, without the dialog

### AI Fix and Resolve with AI

33. **NA-33: AI Fix on the Commit blocked card** (UI)
    - **Given** a pre-commit hook in **feat** that prints "eslint: 2 problems" and exits 1, `util.ts` staged, Claude installed and the default agent
    - **When** the person types "Rename x" and commits, then clicks "AI Fix"
    - **Then** the "Commit blocked" card shows the "Lint" pill, "Lint failed during commit." and a split button "AI Fix" (aria-label "Start the default AI agent to fix this commit failure") with a chevron ("Choose an agent for this commit failure") offering "Customize launch..."; "Details" opens "Commit Failed" with the raw output and "Fix with AI" and "Close". AI Fix opens a new Claude tab in **feat** whose first prompt is NA-34's text, and the toast "Started an AI agent for the commit failure." shows

34. **NA-34: the commit failure prompt is Orca's** (CLI)
    - **Given** the failed commit of NA-33
    - **When** the agent runs `quirky git aiFix --action fixCommitFailure --json`
    - **Then** a new Claude tab opens and the result carries its session and the prompt, which is Orca's `buildFixCommitFailurePrompt` text: "Fix the failed git commit in this worktree and leave the user ready to retry the commit.", the worktree path, the attempted message "Rename x", the summary, "Staged files at failure time (1):" with `- "util.ts" (modified, staged)`, the data-not-instructions line, the rules, `Failure output JSON string:` with the output as a JSON string, and the reply line. Output over 12 000 characters keeps its first 35% and last 65% around `[...N characters omitted...]`. With no failure held the call fails with `conflict` "There is no commit failure to fix."; after a successful commit it fails the same way

35. **NA-35: AI Fix on the Push blocked card** (UI, CLI)
    - **Given** a pre-push hook that prints "husky - pre-push hook exited with code 1" and exits 1, and **feat** one commit ahead
    - **When** the person pushes, then clicks AI Fix; and the agent runs `quirky git aiFix --action fixPushFailure`
    - **Then** the "Push blocked" card shows "Pre-push hook failed." with AI Fix; each opens a Claude tab whose prompt is Orca's push fix text: "Fix the failed git push in this worktree and leave the user ready to retry the push.", Branch `zoe/feat`, the summary, "Changed files at failure time (N):" (at most 40, then "- ...N more changed files omitted..."), rules ending with "Do not push, create a pull request, or assume any hosted git provider."; the toast reads "Started an AI agent for the push failure."

36. **NA-36: Resolve with AI on the conflict card** (UI, CLI)
    - **Given** (a) a merge stopped with `a.ts` both modified and `b.ts` deleted by them; (b) a rebase stopped with `a.ts` both modified
    - **When** the person clicks "Resolve with AI" on the conflict card; and the agent runs `quirky git aiFix --action resolveConflicts`
    - **Then** a Claude tab opens with Orca's conflict prompt: (a) "Resolve the current merge conflicts and complete the current git operation in this worktree.", `- Operation: merge`, `- Continue command: git merge --continue`, no skip command, `- Conflicted files (2):` with `- "a.ts" (Both modified)` and `- "b.ts" (Deleted by them)`; (b) `rebase`, `git rebase --continue` and `- Skip command: git rebase --skip`, and the rule to inspect `git show --stat --patch REBASE_HEAD`. The toast reads "Started an AI agent for the conflicts.". With no conflicts the call fails with `conflict` "There are no conflicts to resolve."

37. **NA-37: Customize launch edits and saves a recipe** (UI)
    - **Given** the Commit blocked card of NA-33, Claude and Codex installed and enabled
    - **When** the person picks "Customize launch...", changes the agent to Codex, adds `--model gpt-5.4` as CLI arguments, appends "Keep the change small." to the prompt template, picks "Save for" "This repository" and clicks "Save & start agent"; then reopens the dialog and clicks "Reset"
    - **Then** the dialog "Fix Commit Failure With AI" ("Review and edit the full command input before starting an agent.") showed the agent select, "Prompt template" holding the full rendered prompt with "Reset", "CLI arguments", and "Save for" ("This repository" / "All repositories"), with "Start agent" and "Cancel"; the button read "Save & start agent" once the values differed from the saved recipe; Codex starts with `--model gpt-5.4` and the edited prompt; the repository recipe for `fixCommitFailure` now holds Codex, the arguments and the template; on reopening, the note "Launch recipe already saved" shows; "Reset" puts the template back to `{basePrompt}`. The titles for the other actions are "Fix Push Failure With AI" and "Resolve Conflicts With AI". While agents are detected the select reads "Detecting agents..."; with none enabled it reads "No enabled agents" and "Start agent" is disabled

38. **NA-38: launch errors use Orca's text** (API)
    - **Given** a held commit failure
    - **When** an API client calls `aiFix` with (a) every agent disabled; (b) a repository recipe naming Gemini, which isn't installed; (c) a template that renders to blank; (d) CLI arguments `--dangerously-skip-permissions --rm-rf`, which Claude's extra-argument allowlist refuses
    - **Then** each fails, opens no tab, and the window shows the same text as a toast: (a) "No enabled AI agents. Configure agents in Settings."; (b) "Saved AI agent is unavailable. Use Customize launch to choose another agent."; (c) "Commit failure prompt is empty. Update Source Control AI settings."; (d) the allowlist's refusal from `m1-launch-settings`

39. **NA-39: recipes are read and saved through the CLI** (CLI)
    - **Given** no recipes
    - **When** the agent runs `quirky git aiRecipe --action commitMessage --json`, then `quirky git setAiRecipe --action commitMessage --scope global --agent codex`, then the same `setAiRecipe` again, then `quirky git setAiRecipe --action commitMessage --scope repo --args=--model gpt-5.4`, then `aiRecipe` again
    - **Then** the first read shows the effective recipe `{agent: null, args: "", template: "{basePrompt}"}` with each field's source `default`; the second `setAiRecipe` reports `saved: false` (identical); the last read shows agent `codex` from `global`, args from `repo`, template from `default`. An unknown action fails with `invalid-params`

40. **NA-40: the Source Control AI defaults view** (UI)
    - **Given** no recipes
    - **When** the person runs "Source Control AI Settings" from the palette, turns off "Show Source Control AI actions", sets the commit message agent to Codex, edits the conflict template, and clicks its "Reset"
    - **Then** the view titled "Source Control AI defaults" shows the switch ("Adds AI buttons that run the selected agent with the command template for that action."), "Custom command" ("Command line Quirky runs when a recipe uses Custom command."), and one row per action ("Commit message", "Commit failure fixes", "Push failure fixes", "Conflict resolution") with agent, "CLI arguments" and "Command template"; each change saves the global recipe at once; the switch hides the AI buttons in the panel live; "Reset" restores `{basePrompt}`

### One-shot generation for any plugin

41. **NA-41: `quirky.agents/generate` runs any agent once** (CLI)
    - **Given** fake Codex printing "ok"
    - **When** the agent runs `quirky agents generate --agent codex --prompt "Say ok" --cwd /tmp/s/api --json`, then `quirky agents list --json`
    - **Then** the result is `{text: "ok", agent: "codex", command, args}` with Codex's one-shot arguments and the prompt on stdin; the agent list marks which agents can generate text; a missing `--cwd` defaults to the caller's worktree and a non-directory fails with `invalid-params`

### Commands and scripting

42. **NA-42: every note and AI method is scriptable** (CLI)
    - **Given** a fresh daemon
    - **When** the agent runs `quirky api --json` and `quirky git --help`
    - **Then** `quirky.git` lists `notes`, `addNote`, `editNote`, `deleteNote`, `clearNotes` (destructive), `formatNotes`, `noteTargets`, `sendNotes`, `generateCommitMessage`, `cancelGenerate`, `aiFix`, `aiFixPreview`, `aiRecipe` and `setAiRecipe`, and the events `notesChanged` and `aiChanged`; `quirky.agents` lists `generate` and `cancelGenerate`; the help shows a command for each

### Orca defects

Each recorded Orca defect has a test showing Quirky doesn't have it.

43. **NA-43: a note body has a maximum everywhere** (API) — Orca has no maximum in its schema, store or IPC. Covered by NA-5 (d): the daemon refuses a 70 000-byte body ([D8](../../../loop/decisions/m2-source-control-notes-ai.md)).
44. **NA-44: a blank note is called empty, not too large** (API, UI) — Orca toasts "Comment is too large to submit safely." for a whitespace-only body. NA-5 (c) gets "Note is empty.", and NA-3 shows the button disabled.
45. **NA-45: edits set `updatedAt`** (API) — Orca declares it and never sets it. NA-6 checks it.
46. **NA-46: one line rule for formatter and storage** (API) — Orca's formatter prints "Scope: file" for line 0 while its schema refuses it. NA-5 (a) refuses line 0, and the formatter has no line-0 branch ([D10](../../../loop/decisions/m2-source-control-notes-ai.md)).
47. **NA-47: no dead "sent" state** (API) — Orca keeps `sentAt` and a Sent chip its desktop never sets. Notes have no sent field, and NA-16 shows a delivered note is gone ([D9](../../../loop/decisions/m2-source-control-notes-ai.md)).

## Scope & non-goals

In scope: everything under "Behavior & scenarios".

Out of scope, with where it goes:

- Markdown review notes, their rail and their own send menu, and the editor's Changes mode
  (`m2-editor`; [D4](../../../loop/decisions/m2-source-control-notes-ai.md)). The shelf shows
  Markdown notes once `quirky.editor` exposes them.
- Pull request fields, branch-name generation, broken-check fixes, review-comment fixes and
  conversation names, and PR review comments in diffs (M4).
- Model discovery, model memory, thinking-level pickers and Orca's legacy `commitMessageAi`
  settings ([D17](../../../loop/decisions/m2-source-control-notes-ai.md)).
- The per-repository on/off switch for AI actions (`m7-parity-sweep`;
  [D21](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Mobile's note fields (`scope`, `oldPath`, `diffIdentity`), whole-file notes and its preamble
  (`sb-mobile`).
- Re-anchoring notes after the file changes
  ([D7](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Remote hosts, SSH and WSL, and Windows command-line limits (`deferred: platform`).
- Telemetry.

## Decisions Locked

**Visual**
- Note cards, the draft card, the shelf, the pills and the send menus follow Orca's text and
  placement (NA-1 to NA-17).
- The recipes get a main-area view, "Source Control AI defaults"
  ([D20](../../../loop/decisions/m2-source-control-notes-ai.md)).
- A note whose path has no diff opens the file's diff against HEAD with no changes (NA-10;
  [D30](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Settings that name Orca's "Settings -> Git" point to the Source Control AI view instead
  ([D20](../../../loop/decisions/m2-source-control-notes-ai.md)).

**API and CLI**
- Note, send, generate, fix and recipe methods on `quirky.git`, `generate` on `quirky.agents`,
  each with a generated command ([D14](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Validation refuses line 0, inverted ranges, blank and oversize bodies
  ([D8](../../../loop/decisions/m2-source-control-notes-ai.md),
  [D10](../../../loop/decisions/m2-source-control-notes-ai.md)).
- `clearNotes` is destructive; adding, editing, deleting one note and sending are not.

**Integration**
- Notes go only to an agent session in the same worktree that isn't starting, waiting or blocked
  ([D13](../../../loop/decisions/m2-source-control-notes-ai.md)).
- One-shot runs close stdin, time out after 60 seconds, cap output at 4 MiB and kill the process
  group ([D16](../../../loop/decisions/m2-source-control-notes-ai.md)).
- One generation per worktree ([D24](../../../loop/decisions/m2-source-control-notes-ai.md)).
- The daemon keeps the last commit and push failure for AI Fix
  ([D22](../../../loop/decisions/m2-source-control-notes-ai.md)).

## Industry Insights

- Stale anchors are the main failure of tools that send review comments to agents; robust tools
  store an excerpt and move a comment only on a unique match
  ([agent-manager](https://agent-manager.dev/writing/live-review-race/),
  [differ #44](https://github.com/JanSmrcka/differ/issues/44)). Quirky keeps Orca's line anchors
  for now ([D7](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Clear-on-success sends lost edits made during a send
  ([aether PR 333](https://github.com/3xDevOps/aether/pull/333)); the snapshot match prevents it.
- Pasted end-of-paste markers end a bracketed paste early
  ([AntanI PR #53](https://github.com/skixmix/AntanI/pull/53)); prompts are stripped of control
  characters (NA-15).
- Typing into an agent waiting for approval answers its question
  ([chda #162](https://github.com/magicsih/chda/issues/162)); sends refuse those states (NA-21).
- `codex exec` hangs on an open non-TTY stdin
  ([openai/codex #20919](https://github.com/openai/codex/issues/20919)) and agent CLIs leave
  orphans after interrupts ([claude-code #76306](https://github.com/anthropics/claude-code/issues/76306));
  one-shot runs close stdin and kill the process group (NA-29, NA-30).
- Commit-message tools budget the diff (aicommit2 compresses over 100 KB; opencommit splits by
  file and hunk) ([aicommit2](https://github.com/tak-bro/aicommit2),
  [opencommit](https://github.com/di-sukharev/opencommit/blob/master/src/generateCommitMessageFromGitDiff.ts));
  Orca's 200 000-byte fair share is kept (NA-28).
- Diffs and failure output can carry prompt injection
  ([GitInject](https://arxiv.org/html/2606.09935v1)); prompts frame them as data and generation runs
  read-only ([D26](../../../loop/decisions/m2-source-control-notes-ai.md)).

## Deferred Ideas

- Re-anchor notes on a unique excerpt match and mark ambiguous ones stale
  ([D7](../../../loop/decisions/m2-source-control-notes-ai.md)).
- A model picker in the Generate dialog, with model discovery
  ([D17](../../../loop/decisions/m2-source-control-notes-ai.md)).
- Fix `quirky.terminal/send` itself to strip paste markers for every caller
  ([D11](../../../loop/decisions/m2-source-control-notes-ai.md)).
- [tech-spec] How the window's CodeMirror gutter, block widgets and drag state are built.
- [tech-spec] The store schema, and how a held send survives a daemon restart (it doesn't need to:
  holds are in memory).

## Glossary

- **Diff note (note):** text pinned to a line range on the modified side of a diff of one path in
  one worktree.
- **Notes shelf:** the list of a worktree's notes at the top of the Source Control panel.
- **Unsent note:** a stored note that isn't held by a running send.
- **Send scope:** which notes a send takes: one note, one file's notes, or all unsent notes.
- **Target:** where a send goes: a running agent session, or a new agent tab.
- **Sendable:** a live terminal agent session in the same worktree that isn't starting, waiting
  for approval or blocked.
- **Recipe:** an action's agent, CLI arguments and command template, saved globally or for one
  repository.
- **Effective recipe:** each recipe field taken from the repository recipe, else the global one,
  else the default.
- **Base prompt:** Orca's fixed prompt for an action, inserted where the template says
  `{basePrompt}`.
- **One-shot run:** running an agent CLI once, non-interactively, to get text back.
- **Held failure:** the last commit or push failure the daemon keeps for a worktree until the next
  success.

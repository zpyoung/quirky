# m2-source-control-notes-ai tech spec

**Status:** Draft for build. Logic spec: [logic.md](logic.md). Decisions:
[m2-source-control-notes-ai.md](../../../loop/decisions/m2-source-control-notes-ai.md).

Paths are relative to the repo root. `QG/` = `plugins/quirky.git/`, `QA/` = `plugins/quirky.agents/`,
`QT/` = `plugins/quirky.terminal/`, `PG/` = `packages/git/src/`. `O/` = Orca's source at
`/Users/zpyoung/PycharmProjects/orca/src/` (read-only; the exact texts and argument lists to port
live there). Builds on [m2-source-control-core tech.md](../2026-10-27-m2-source-control-core/tech.md).

## Architecture

Four layers ([logic: Data flow](logic.md#data-flow)):

1. **`quirky.agents` one-shot runner (`QA/`).** `agent` entries gain an optional `oneShot` data
   block. A new method `quirky.agents/generate` resolves the agent, builds its one-shot argv from
   the block, spawns it once in its own process group, feeds the prompt, and returns its stdout. Pure
   argv building lives in `QA/src/core/one-shot.ts`; spawning in `QA/src/one-shot-run.ts`.
2. **`quirky.terminal/newTab` gains `extraArgs` (`QT/`)**, passed through to
   `quirky.session/create`, which already accepts it.
3. **`quirky.git` daemon (`QG/src/daemon/`).** New modules: `notes.ts` (store, CRUD, format, send,
   holds), `notes-format.ts` (pure), `targets.ts` (send targets), `ai-recipes.ts` (store and
   resolution), `ai-prompts.ts` (pure: commit message, three fix prompts, template rendering,
   output splitting), `ai-context.ts` (staged context read), `ai-generate.ts` (generation lane and
   cancel), `ai-fix.ts` (held failures and launches). One plugin store holds `notes` and `recipes`.
4. **`quirky.git` window (`QG/src/`).** New: `src/notes/` (CodeMirror extension for the gutter
   "+", drag, draft and saved cards; React cards; send menu; shelf; pills; hooks reading notes),
   `src/ai/` (sparkle button, generate dialog, fix split button, launch dialog, the `ai-settings`
   view). Existing components grow small props.

Libraries: `@codemirror/view` (`gutter`, `GutterMarker`, `WidgetType`, `Decoration.widget` with
`block: true` from a `StateField`), `@codemirror/state` (`StateField`, `StateEffect`), React 19.

Small cross-plugin growths (API unstable until M7):
- `quirky.git`'s manifest `dependencies` stays `quirky.worktree` only: `context.call` activates
  `quirky.agents`, `quirky.session` and `quirky.terminal` lazily, and declaring them would make the
  plugin invalid in every harness that doesn't install them (D36).
- `quirky.terminal/newTab` params gain `extraArgs` (string).
- `quirky.agents/list` entries gain `canGenerate: boolean`.

## Code references

### `quirky.agents` ([logic: NA-26, NA-29, NA-41](logic.md#generating-commit-messages))
- `QA/src/core/types.ts:53-87` `AgentEntry`: add `oneShot: OneShotSpec | null`.
- `QA/src/core/entry.ts:21-51` `KNOWN_FIELDS` add `oneShot`; `parse()` (`:76-124`) calls a new
  `parseOneShot` that rejects unknown keys with messages starting `oneShot`, mirroring
  `parseLaunchOptions` (`QA/src/core/launch-options.ts:172`). A malformed block makes the entry
  invalid (m1-launch-settings D25).
- `QA/quirky-plugin.json:1710` `contributes.agent`: add a `oneShot` block to each of claude,
  codex, opencode, pi, amp, cursor, kimi, muse, dsh, copilot, antigravity, jcode and omp, ported
  from `O/shared/commit-message-agent-specs-primary.ts` and `-secondary.ts` (`buildArgs`,
  `promptDelivery`, `singletonOptions`, `models`, `defaultModelId`, default thinking level) and
  `O/shared/claude-background-run-isolation.ts` (`--strict-mcp-config`, `--settings
  {"disableAllHooks":true}` unless the user args set `--settings`; retry once without
  `--strict-mcp-config` when output contains the enterprise refusal text). OpenCode's block sets
  `output: "opencode-json"` because its arguments ask for `--format json`.
- `QA/main.ts:13-29` methods map: add `generate`; manifest entry beside `deliver` (`:1657`).
- `QA/src/service.ts:95` `AgentsService`: `generate` handler. Command and environment come from
  `buildLaunchPlan` (`QA/src/core/plan.ts:267`) with `config: this.configs.get(id)` and
  `resolveExecutable` (`QA/src/detect.ts:131-134`), so a `configure --command` override and
  install-dir absolute paths apply (D43). Not `prepareLaunch`, which writes trust.
- Spawn: `context.launch.commandArgv` and `context.launch.env` as
  `plugins/quirky.agent-status/src/claude-settings.ts:182-190` does, but `detached: true`,
  stdin piped, stdout and stderr piped and counted. Group kill as `killProbe` (`:153-165`):
  SIGTERM to `-pid`, SIGKILL after 2 s.
- `QA/src/service.ts:494-504` `list`: add `canGenerate` per entry.
- Errors through `guard()` (`QA/src/service.ts:402-409`).

### `quirky.terminal` ([logic: NA-18, NA-33 to NA-38](logic.md#ai-fix-and-resolve-with-ai))
- `QT/src/layout/service.ts:32-40` `NewTabSpec`, `:406-419` `newTab`, `:423` `addTab`, `:333-352`
  `startSession` (forward `extraArgs` in the `quirky.session/create` body at `:337-343`), and the
  manifest params at `QT/quirky-plugin.json:659`. Omit `extraArgs` from the create body when it is
  blank, because `quirky.session` refuses any pick for the shell (`plugins/quirky.session/src/sessions.ts:181-183`).

### `quirky.git` daemon ([logic: Behavior & scenarios](logic.md#behavior--scenarios))
- `QG/main.ts:10-14`: open the store once (`context.openStore(migrations)`), pass it into
  `createEnv`.
- `QG/src/daemon/env.ts:15-31` `DaemonEnv`: add `store`, `notes` (service), `ai` (service).
  `resolve` (`:38-51`) gives `Worktree` with `id`, `repoId`, `path`, `branch`.
- `QG/src/daemon/methods.ts:16-46`: add the methods in [Contracts](#contracts--interfaces); the
  wrapper at `:47-58` already translates errors.
- `QG/src/daemon/errors.ts:37-40` `reasoned(kind, reason, message, extra?)` for every new error;
  reasons listed in [Errors](#errors).
- `QG/src/daemon/paths.ts:45-54` `containedPath` validates note paths. Its message is
  `${path} is outside the worktree`; the logic spec's NA-5 (e)/(f) text "Path must stay inside the
  worktree." is the core spec's wording for the same refusal, so the test asserts reason
  `outside-worktree`, not a new message.
- `QG/src/daemon/commit.ts:13-17` and `QG/src/daemon/remote.ts:18-24`: record and clear held
  failures (catch: record; success: clear). `commit.ts` must read the staged entries for the held
  failure before the error is rethrown (`env.readStatus`).
- Staged context: build name-status from `statusV2` staged entries (`PG/status.ts:312`) and the
  patch with a new `PG/diffs.ts` export `stagedPatch(cwd): Promise<{patch: string; omitted:
  boolean}>` running `git diff --cached --patch --minimal --no-color --no-ext-diff` via `runGit`,
  killed and reported `omitted` past 10 MiB; reached through `gitApi()` (`PG/api.ts:14`) so
  `createFakeGit` sees it.
- Destructive `clearNotes` with `describeClearNotes` (`readOnly`), shaped like `discard` /
  `describeDiscard` (`QG/quirky-plugin.json:449-496`, `QG/src/daemon/staging.ts:123-132`).

### `quirky.git` window
- `QG/src/view/merge.ts:86-121` `hostExtensions` side `'b'`: append the notes extension (from
  `QG/src/notes/extension.ts`) when `MergeOptions.notes` is set; `:154-237` `createMerge` passes
  it in both layouts. Notes state lives outside the editor because `TextPane` rebuilds it on
  setting changes (`QG/src/view/DiffPane.tsx:178`); the extension takes notes through a
  `StateEffect` and reports gestures through callbacks.
- `QG/src/view/DiffPane.tsx:29-44` `PaneProps`: add `path` and `notes?: NotesBinding`; image,
  binary and too-large branches (`:72-85`) never mount it.
- `QG/src/view/FileDiff.tsx:120-194` header: the "AI notes N" pill before the arrows.
- `QG/src/view/CombinedDiff.tsx:300-326` toolbar: "Show N AI notes" pill and "Send" menu;
  `:444-486` section header: hover send icon when the section's path has notes.
- `QG/src/shared/view-input.ts:15-26` `DiffViewInput`: add `noteId?: string`; `DiffWindow.tsx`
  `parseInput` (`:16-23`) and `FileDiff` pass it down so the pane scrolls the card into view.
- `QG/src/panel/WorktreePanel.tsx`: Notes shelf between `BranchRow` (`:698`) and `.scm-body`;
  `toItem` (`:96-104`) adds `notes` count; `CommitArea` (`:720-749`) gets the sparkle;
  `BlockedCard` children (`:732-747`) and the details `Dialog` (`:847-856`) get AI Fix and "Fix
  with AI"; `OperationCard` (`:702-711`) gets Resolve with AI. Message state `message` (`:134`)
  is the generation target.
- `QG/src/panel/Rows.tsx:107-131` `Trailing`: note icon and count before the counts.
- `QG/src/panel/Header.tsx:23-27`: "Notes N" item when N > 0.
- `QG/src/panel/Menu.tsx:4-12` `MenuEntry`: add `submenu?: MenuEntry[]` and `icon?` for the
  scope-then-target menus; `PopupMenu` (`:26`) renders a submenu on hover and on ArrowRight.
- `QG/src/panel/Cards.tsx:26` `OperationCard` and `:97` `BlockedCard`: optional `fix?:
  FixButtonProps`.
  Conflict descriptions use the card's available content width, with Review conflicts,
  Resolve with AI and Abort in a wrapping action row below the explanation. The AI primary
  button and agent chooser stay together as one non-wrapping group.
- `QG/src/ui.tsx:10-21`: provide the `ai-settings` view and new commands; `QG/test/ui.test.ts`
  (SC-36) checks provided equals declared, so manifest and `ui.tsx` change together.
- `QG/src/view/commands.ts:40-86` `commandHandlers`: `add-review-note`, `send-review-notes`,
  `ai-settings`.
- Styles: `packages/ui/src/styles.css`, new rules under `scm-note*`, `scm-ai*` and `qgv-note*`.
- Clipboard: `navigator.clipboard.writeText` as `WorktreePanel.tsx:432` does.

## Contracts & interfaces

### `quirky.agents/generate` ([logic: NA-41](logic.md#one-shot-generation-for-any-plugin))

`CONTRACT:`
```
generate({agent: string, prompt: string, args?: string, cwd?: string, worktree?: string,
          timeoutMs?: number /* default 60000, max 60000 */})
  -> {text: string, agent: string, command: string, args: string[]}
```
- `agent` is an agent ID or `custom`; `custom` uses `args` as the whole command line
  (`quirky.git` passes its `ai-custom-command`), tokenized shell-style; a `{prompt}` token is
  replaced by the prompt (one argv element), otherwise the prompt goes to stdin. Port
  `planCustomCommand` from `O/shared/commit-message-plan.ts`.
- For an agent: argv is the `oneShot.args` template with `{model}` and `{thinking}` filled from
  the default model, then `args` tokens inserted before the trailing prompt; a token in `args`
  that matches a `singletonOptions` flag removes Orca's copy of that flag and its value (never
  both, NA-32).
- `cwd`: default the caller's worktree path; must be an existing directory (`invalid-params`).
- stdin: write the prompt (stdin delivery) and close; argv delivery closes stdin at once.
- Result `text`: stdout decoded as UTF-8, ANSI-stripped, then decoded per `oneShot.output`:
  `text` (default) as is; `opencode-json` through a port of `parseOpenCodeGenerationOutput`
  (`O/shared/opencode-generation-output.ts`: concatenated `text` events; an `error` event fails
  the run with reason `failed` and that event's message). Exit 0 required. `generate` returns the
  decoded text untrimmed of content; the caller cleans it.
- Errors (all `conflict` unless noted; message uses the agent's label):
  - not installed / not enabled: `invalid-params` reason `not-installed`
  - no `oneShot` block: `invalid-params` reason `cannot-generate`, "<Label> can't generate text.
    Pick another agent."
  - spawn failed (ENOENT etc.): reason `not-started`, "<Label> could not be started. Check the
    agent command in Settings and try again."
  - timeout: reason `timeout`, "<Label> did not finish within 60 seconds."; group killed
  - output > 4 MiB: reason `too-much-output`, "<Label> produced more than 4 MiB of output.";
    group killed
  - non-zero exit: reason `failed`, "<Label> failed: <first non-blank stderr line, else stdout
    line, capped 200 chars>"
- Cancel: `generate` takes an optional `requestId` string, and
  `quirky.agents/cancelGenerate({requestId}) -> {cancelled: boolean}` kills that run's group. A
  cancelled run fails with reason `cancelled`, "Generation was stopped."

### Notes methods ([logic: Adding and editing notes](logic.md#adding-and-editing-notes))

Every method takes `worktree?` (selector, default current) and resolves it with `env.resolve`.

`CONTRACT:`
```
notes({worktree?, path?}) -> {notes: Note[]}                       readOnly; sorted path, line, startLine, createdAt
addNote({worktree?, path, line, startLine?, body}) -> {note: Note}
editNote({worktree?, id, body}) -> {note: Note}                    sets updatedAt
deleteNote({worktree?, id}) -> {ok: true}
clearNotes({worktree?, path?}) -> {cleared: number}                destructive; describe: describeClearNotes
describeClearNotes({worktree?, path?}) -> string /* the dialog title */   readOnly
formatNotes({worktree?, ids?, path?}) -> {text: string, count}     readOnly; all notes when neither given
noteTargets({worktree?}) -> {sessions: NoteTarget[], agents: {id, label}[]}   readOnly
sendNotes({worktree?, scope: 'note'|'file'|'all', id?, path?, session?, agent?})
  -> {sent: string[], kept: string[], target: {session: string}, delivery: string}
```
- Validation (NA-5): `line` and `startLine` integers ≥ 1, `startLine ≤ line` (default
  `startLine = line`), message "Lines must be whole numbers from 1, with the start at or before
  the end."; `body` trimmed; blank → "Note is empty."; UTF-8 bytes > 65 536 → "Comment is too
  large to submit safely."; path through `containedPath` (it need not exist on disk; a deleted
  file can carry notes). All `invalid-params`.
- `id` unknown in that worktree: `not-found`.
- Every mutation emits `notesChanged {worktreeId}` (new manifest event).
- `describeClearNotes` returns the title string, as the kernel's `describe` contract requires:
  path given → `Clear N note(s) from <path>?`; else `Clear N note(s) from this workspace?`. The
  window's confirm button reads "Clear". Pluralization: "1 note", "N notes".
- `sendNotes`:
  - exactly one of `session` and `agent`; scope `note` needs `id`, `file` needs `path`.
  - picks notes in scope minus held ones; none at all in scope → `conflict` reason
    `no-unsent-notes` "There are no unsent notes."; some in scope but all held → `conflict`
    reason `all-held` "All notes are already being sent."
  - `session` target: `quirky.session/get`; not a terminal agent session (shell, structured) or
    other worktree → `invalid-params` reason `not-a-target` "Notes go to an agent session in this
    worktree."; `status` exited → `conflict` reason `exited` "The session has exited."; `starting`
    → `conflict` reason `starting` "<Label> is still starting."; `agentStatus.state` `waiting` or
    `blocked` → `conflict` reason `waiting` "<Label> is waiting for approval.".
  - holds the picked notes (in-memory per worktree, keyed by note ID) before any await.
  - session delivery: `quirky.terminal/send {session, text, enter: true}`; `delivery: "pasted"`.
  - agent delivery: `quirky.terminal/newTab {workspace: worktree.id, agent, prompt: text}` then
    wait for the new session's `promptDelivery` to leave `pending` (poll `quirky.session/get` or
    subscribe to `quirky.session/changed`, 30 s cap). Only `pasted` and `command-line` count as
    delivered. `unconfirmed` (blind paste: no ready signal, or the session exited before Enter) →
    `conflict` reason `unconfirmed` "The agent may not have received the notes. They were kept.";
    `not-delivered` or the cap → `conflict` reason `not-delivered` "The agent did not receive the
    notes."; in both nothing is deleted. The new session ID comes from the
    workspace returned by `newTab` (the tab added last in the active group).
  - on delivery: delete each picked note whose current row still equals its snapshot (`id`,
    `body`, `path`, `startLine`, `line`); return those as `sent`, the rest as `kept`.
  - release the hold in `finally`; emit `notesChanged`.
- `noteTargets`: `quirky.session/list {worktree}`; terminal sessions whose `agent !== 'shell'`
  and `status !== 'exited'`, each `NoteTarget = {session, agent, label, title, status,
  state, lastActivityAt, sendable: boolean, reason?: string}` with the reasons above; `agents`
  from `quirky.agents/list` entries that are installed and enabled, in auto-pick order.

### Prompt text ([logic: NA-15](logic.md#sending-notes))
- `formatNotes` text: port `O/shared/diff-comments-format.ts` (`formatDiffComment`,
  `formatDiffComments`) without the `Source: markdown` and `Scope: file` branches. Before
  escaping, remove every character in U+0000–U+001F except LF and CR (which the escape turns into
  `\n` / `\r`), and U+007F, from path and body.

### Commit message ([logic: Generating commit messages](logic.md#generating-commit-messages))

`CONTRACT:`
```
generateCommitMessage({worktree?, agent?, template?, args?, requestId?})
  -> {message, subject, body, agent}
cancelGenerate({worktree?}) -> {cancelled: boolean}
```
- Lane: one per worktree ID; a second call while one runs → `conflict` reason `busy` "A commit
  message is already being generated." (`busy` is the core's lock reason name; use a separate map,
  not `env.lock`, so a generation doesn't block commits).
- `agent`/`template`/`args` override the effective recipe for this run only (the Generate dialog);
  `agent: "custom"` uses `ai-custom-command` (blank → `invalid-params` reason `no-custom-command`
  "Set a custom command in Source Control AI settings.").
- Agent pick: effective recipe agent, else `quirky.agents/pick` with no preference (default agent,
  then auto-pick); none → `conflict` reason `no-agents` "No enabled AI agents. Configure agents in
  Settings."
- No staged entries → `conflict` reason `nothing-staged` "No staged changes to summarize."
- Prompt: port `O/shared/commit-message-prompt.ts` (base prompt, `STAGED_DIFF_BYTE_BUDGET =
  200_000` fair share on line boundaries, marker `...(diff truncated, N bytes omitted)`, omission
  text, 6000-character file summary, 4000-character custom text) and the staged context shape
  (`branch --show-current` or `(detached)`, `diff --cached --name-status`). Template rendering:
  port `renderSourceControlActionCommandTemplate` from `O/shared/source-control-ai-actions.ts`
  (`{name}` or `{{name}}` with optional spaces; unknown or null stay verbatim); variables
  `basePrompt, branch, stagedFiles, stagedPatch, linkedIssue` (`linkedIssue` is always empty
  until M4).
- Output cleaning first: port `cleanGeneratedCommitMessage` from
  `O/shared/commit-message-agent-output.ts` (jcode `{"text"}` envelope, trailing `[Tokens]` line,
  a leading "Generating"/"Thinking"/ellipsis line, a leading `<think>` or `◁think▷` block, one
  enclosing fence, a leading list marker), plus `stripPrefilledReasoningPreamble` for the custom
  command only. Failure detail for non-zero exits: port `excerptAgentFailureOutput` and
  `sanitizeAgentFailureDetail` from the same file.
- Output split: port `splitGeneratedCommitMessage` from `O/shared/commit-message-generation.ts`
  (subject = first line, trailing dots stripped, cut to 72; empty → "Update project files"; body
  after the first blank line, trimmed).
- `cancelGenerate` calls `quirky.agents/cancelGenerate` with the lane's request ID.

### Fix actions ([logic: AI Fix and Resolve with AI](logic.md#ai-fix-and-resolve-with-ai))

`CONTRACT:`
```
aiFix({worktree?, action: 'fixCommitFailure'|'fixPushFailure'|'resolveConflicts',
       agent?, template?, args?, save?: 'repo'|'global'})
  -> {session: string, agent: string, prompt: string, saved: boolean}
aiFixPreview({worktree?, action}) -> {prompt: string, recipe: EffectiveRecipe}   readOnly
```
- Held failures (`ai-fix.ts`, in memory, per worktree ID): `CommitFailure = {message, summary,
  output, staged: {path, status, area}[]}`, `PushFailure = {branch | null, summary, output,
  changed: {path, status, area}[]}`. Recorded only for commit failures (every reason) and push
  failures whose reason is `lint` or `hook`; cleared by a successful commit (commit) or a
  successful push, force push or sync (push).
- Missing state → `conflict`: reason `no-failure` "There is no commit failure to fix." / "There
  is no push failure to fix."; reason `no-conflicts` "There are no conflicts to resolve." when
  status has no unresolved conflict entries.
- Prompts: port `buildFixCommitFailurePrompt` (`O/shared/source-control-commit-failure.ts`,
  12 000-character cap, 35/65 split, `[...N characters omitted...]`), `buildFixPushFailurePrompt`
  (`O/shared/source-control-push-failure.ts`, 40 files), `buildResolveConflictsPrompt`
  (`O/shared/source-control-conflict-prompts.ts`). The template wraps `{basePrompt}`; a rendered
  prompt that is blank → `invalid-params` reason `empty-prompt` "Commit failure prompt is empty.
  Update Source Control AI settings." (Push / Conflict wording: "Push failure prompt is empty.",
  "Conflict resolution prompt is empty.").
- Agent pick: explicit `agent`, else effective recipe agent; a recipe agent that isn't installed
  or enabled → `conflict` reason `agent-unavailable` "Saved AI agent is unavailable. Use
  Customize launch to choose another agent."; else default/auto-pick as for generation.
- Launch: `quirky.terminal/newTab {workspace: worktree.id, agent, prompt, extraArgs: args}`;
  allowlist refusals from `quirky.agents` pass through unchanged (`invalid-params`).
- `save`: after a successful launch, write the run's `{agent, args, template}` to that scope
  unless identical to what is stored there; `saved` says whether it wrote.

### Recipes ([logic: NA-39, NA-40](logic.md#ai-fix-and-resolve-with-ai))

`CONTRACT:`
```
aiRecipe({worktree?, action}) -> EffectiveRecipe                          readOnly
setAiRecipe({worktree?, action, scope: 'repo'|'global', agent?, args?, template?, reset?: boolean})
  -> {saved: boolean, recipe: EffectiveRecipe}
```
- `action` ∈ `commitMessage | fixCommitFailure | fixPushFailure | resolveConflicts`, else
  `invalid-params` reason `unknown-action`.
- `setAiRecipe` sets only the fields given (`null` clears one); `reset: true` deletes the row;
  scope `repo` uses the resolved worktree's `repoId`. Emits `aiChanged {repoId | null}` (new
  manifest event) so the view and panel refresh.
- The sparkle "configured" test (D25): effective agent non-null, or args non-blank, or template
  ≠ `{basePrompt}`.

### Settings
`CONFIG:` new `setting` entries in `QG/quirky-plugin.json` (beside `:1898`):
`ai-enabled` boolean default `true`, title "Show Source Control AI actions", description "Adds
AI buttons that run the selected agent with the command template for that action.";
`ai-custom-command` string default `""`, title "Custom command", description "Command line
Quirky runs when a recipe uses Custom command."

### Commands and keybindings
`CONFIG:` commands `add-review-note` ("Add Review Note"), `send-review-notes` ("Send Review Notes
to Agent"), `ai-settings` ("Source Control AI Settings"); keybinding `add-review-note` key
`mod+shift+a` command `add-review-note`, `when` the diff view has focus (same `when` style as
`next-change`). `send-review-notes`: `togglePanel(PANEL_ID, true)` then a panel request
`{nonce, issuedAt}` the shelf answers within 5000 ms; returns without effect when the active
worktree has no unsent notes.

### Window behavior anchors
- Notes hook `useNotes(context, worktreeId)`: `notes` call plus `quirky.git/notesChanged`
  subscription filtered by `worktreeId`; shared by panel and view.
- Draft and saved cards are block widgets below the range's last line (or the document's last
  line when the range is past the end); "+" is a gutter marker on the hovered line; drag uses
  pointer events on the gutter with auto-scroll per Orca (`O/renderer/src/components/diff-comments/diff-comment-range-drag.ts`,
  `diff-comment-drag-auto-scroll.ts`: 24 px zone, 4–32 px per frame, acceleration 0.6, 50 ms
  delta cap). Range rule from `diff-comment-line-range.ts`. Draft keys from
  `DiffCommentDraftCard.tsx:177-197`.
- Send menu: scope entries (with counts) each with a submenu "Send notes to" (sessions, separator,
  "New agent" agents). A single scope shows its targets directly. Toasts "Sending notes...",
  "Notes sent."; errors toast their message.
- Generation in the window: keep an edit counter bumped by every change to the message box;
  record it at click; on result, apply only if the counter is unchanged and no stop was pressed
  (typing then deleting still counts as typing, NA-30).
- Launch dialog fields and texts: port from `O/renderer/src/components/right-sidebar/source-control/ai/`
  and `RS/source-control-fix-split-button.tsx` as the feature doc lists them.

## Data models

`SCHEMA:` store migrations (append-only, `context.openStore`):
```
notes(id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, path TEXT NOT NULL,
      start_line INTEGER NOT NULL, line INTEGER NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER)
  INDEX notes_by_worktree(worktree_id, path, line)
recipes(scope TEXT NOT NULL /* 'global' | repo ID */, action TEXT NOT NULL,
        agent TEXT, args TEXT, template TEXT, PRIMARY KEY(scope, action))
```

`SCHEMA:` API records:
```
Note = {id: string, worktreeId: string, path: string, startLine: number, line: number,
        body: string, createdAt: number, updatedAt: number | null}
NoteTarget = {session, agent, label, title, status, state: string | null,
              lastActivityAt: number, sendable: boolean, reason?: string}
EffectiveRecipe = {action, agent: string | null, args: string, template: string,
                   sources: {agent: Source, args: Source, template: Source}}   Source = 'repo'|'global'|'default'
OneShotSpec = {args: string[] /* may contain {model} {thinking} {prompt} */, prompt: 'stdin'|'argv',
               output?: 'text'|'opencode-json',
               singletonOptions?: string[][], models?: {id, label, thinking?: string}[],
               defaultModel?: string, background?: 'claude'}
```
`background: 'claude'` marks the Claude isolation args and the strict-MCP retry.

Pruning (D6, D43): in `notes` for a worktree that fails `env.resolve` with `not-found`, delete
that worktree's rows. Never prune at activation from a worktree listing: a transient git failure
omits repositories from it.

## DO-NOT-CHANGE fences

- `PG/failure.ts` classifiers and texts and `QG/src/daemon/errors.ts` `commitFailure` — the core
  item's tests pin them; held failures read their output, they don't reclassify.
- `QT/src/terminal.ts:156-170` `send` — owned by m1-term-daemon and being changed by
  m1-agent-status-scripting (lane 1); `quirky.git` cleans its own text instead (D11, D13).
- `QA/src/core/launch-options.ts` and `QA/src/core/extras.ts` — m1-launch-settings' contracts;
  fix launches reuse them as they are.
- `QG/src/view/merge.ts` existing `MergeHandle` methods and `MergeOptions` fields — the core's
  navigation and save tests use them; add only.
- `QG/test/ui.test.ts` SC-36 provided-equals-declared check — keep it passing by declaring
  every new contribution.

## Always / Ask / Never

- **Always:** every new method has a manifest entry with full `params` and `result` schemas
  (undeclared params are rejected, `packages/protocol/src/schema.ts:179-186`); emit
  `notesChanged` after every note mutation; strip control characters from note prompts; close
  stdin of one-shot runs; kill the whole process group on timeout, overflow and cancel; go
  through `gitApi()` for git.
- **Ask (record as a decision, then proceed):** any change to an existing method's result shape;
  a new kernel API; a UI text the feature doc doesn't give.
- **Never:** call a real model in tests; touch the real `~/.claude`, `~/.codex` or `~/.quirky`;
  type into a session that is starting, waiting or blocked; delete a note whose snapshot changed
  during its send; import across plugin directories (`plugins/test/imports.test.ts:89-104`).

## Cross-cutting

- **Security:** prompts carry repo content to the user's own agent CLI, run with each spec's
  read-only flags; generated text is only placed in the commit box. Note paths go through
  `containedPath`. The custom command is tokenized, never run through a shell.
- **Migration:** new store; no existing data.
- **Rollback:** the store tables are additive; removing the feature leaves an unused store.
- **Platform:** process-group kill and argv delivery are POSIX; record `deferred: platform` for
  Windows (`taskkill /T`, command-line budgets).

## Testing strategy

- `QA/test/one-shot.test.ts` (pure): argv for every ported agent against Orca's shapes, singleton
  override, `{prompt}` custom command, `oneShot` validation errors, OpenCode JSON decoding and
  error events (NA-26, NA-27, NA-31, NA-32, NA-41).
- `QA/test/generate.test.ts` (service with fake executables, as `QA/test/service.test.ts:61+`):
  stdin delivery and close, argv delivery, timeout with a child that ignores SIGTERM (group gone),
  4 MiB cap, non-zero exit, ENOENT, cancel, Claude strict-MCP retry (NA-29, NA-30, NA-41).
- `QT/test/*`: newTab forwards `extraArgs`, omits it when blank.
- `QG/test/pure/notes-format.test.ts`, `ai-prompts.test.ts`: NA-15 text byte for byte; Orca's
  prompt texts for commit message (budget, truncation, omission), three fix prompts (12 000 cap
  split, 40 files), template rendering, output splitting (NA-27, NA-28, NA-34 to NA-36).
- `QG/test/scenarios/notes.test.ts`, `ai.test.ts`: a harness running real `quirky.repo`,
  `quirky.worktree`, `quirky.git`, `quirky.agents`, `quirky.session`, `quirky.terminal` (copy
  `plugins/quirky.session/test/support.ts:26-36` `makeBuiltinDir`) with real git and fake agents
  (`QA/test/support/e2e.ts` `addFake`), driving the CLI and the daemon API for NA-4, NA-5, NA-12
  (CLI part), NA-16, NA-18 to NA-21, NA-23, NA-26 to NA-32, NA-34 to NA-39, NA-41, NA-42 and the
  defect tests NA-43 to NA-47.
- `QG/test/ui/*` (happy-dom, `fakeContext`): extension gestures and keys (NA-1 to NA-3, NA-6,
  NA-7), shelf, rows, pills, menus (NA-9 to NA-14, NA-17), sparkle states (NA-24, NA-30 window
  part), fix buttons and dialog (NA-33, NA-37), view (NA-40).
- `QG/test/window/*` (`boot`): end-to-end UI flows NA-1, NA-10, NA-17, NA-22, NA-25, NA-33.
- Acceptance bar: `bun run typecheck`, `bun test scripts`, `bun run test` green; the UI pass with
  `quirk:using-apps-like-a-user` over the "(UI)" scenarios.

## Non-goals

Everything the logic spec's [Scope & non-goals](logic.md#scope--non-goals) excludes, plus: no
change to `quirky.terminal/send`; no shared one-shot spawn helper refactor in `quirky.agent-status`
or `quirky.ask`; no kernel UI API growth (submenus are a `quirky.git` `PopupMenu` feature).

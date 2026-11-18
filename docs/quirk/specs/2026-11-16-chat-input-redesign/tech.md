# Chat input redesign: tech spec

**Status:** Draft, written from logic.md approved 2026-11-16 (tier: crosses subsystems, ≳3 files).
**Logic spec:** [logic.md](logic.md). Mock: [mock/mock.html](mock/mock.html), inventory [mock/screens.md](mock/screens.md).

All paths are relative to the repo root.

## Architecture

The work falls into four units, built as four tasks:

1. **Structured backend** (`plugins/quirky.structured`): queue reorder, resume adopting the old queue, and a per-session list of agent commands and skills. Backs [SC-6](logic.md#sc-6-pick-a--command), [SC-13](logic.md#sc-13-manage-queued-messages) and [SC-17](logic.md#sc-17-session-ended).
2. **Platform support**:
   - a native file picker kernel method (`desktop.file.pick`), following `desktop.folder.pick`;
   - daemon methods in `plugins/quirky.session` that save pasted clipboard images and store drafts;
   - the *Send with Cmd+Enter* setting;
   - `stop` and `arrow-up` control icons.

   Backs [SC-3](logic.md#sc-3-send-with-cmdenter-preference), [SC-7](logic.md#sc-7-attach-images) and [SC-10](logic.md#sc-10-drafts-are-kept-per-session).
3. **Composer editor and transcript markdown** (`plugins/quirky.session/src/window/chat/editor/`, `Turn.tsx`, `Prose.tsx`): a CodeMirror 6 message editor with visible-syntax markdown styling, atomic pills, `@`/`/` triggers, the IME-safe keymap, paste and drop hooks, and long-paste chips. Separately, user bubbles render markdown and agent prose keeps soft line breaks. Backs [SC-1](logic.md#sc-1-send-a-message), [SC-2](logic.md#sc-2-enter-never-sends-during-ime-composition), [SC-4](logic.md#sc-4-markdown-is-styled-as-you-type), [SC-5](logic.md#sc-5-mention-a-file-with-), [SC-9](logic.md#sc-9-long-paste-becomes-a-chip), [SC-19](logic.md#sc-19-sent-messages-render-markdown) and [SC-20](logic.md#sc-20-agent-replies-keep-line-breaks).
4. **Composer shell** (`plugins/quirky.session/src/window/chat/`): the card, toolbar, settings chip and popover, mode badges, working state, queue rows, suggestion list, ended card, inline errors, and the wiring of drafts and Quirky commands. It consumes units 1–3. Backs every remaining scenario and the [Screens](logic.md#screens) table.

**Libraries:**
- CodeMirror 6 is already used by `packages/ui`, `plugins/quirky.editor`, `plugins/quirky.git` and `plugins/quirky.handoff`.
- Plugin window code is bundled per plugin by `packages/ui/build.ts:36-89`, which externalises only react and react-dom. `plugins/quirky.handoff/src/window/PreviewEditor.tsx` is the precedent for importing CM6 in plugin window code.
- Markdown in the transcript uses unified, remark and rehype (`plugins/quirky.session/src/window/chat/Prose.tsx:3-24`).

## Code references

### Unit 1: structured backend
- `plugins/quirky.structured/queue.ts:11-114`: `MessageQueue`, with order defined only by the `slot` column. Add `reorder` and `moveSession`.
- `plugins/quirky.structured/main.ts`:
  - the `dequeue`/`editQueued`/`steer` handlers (steer at `:1482-1522`, provides at `:1669`); add `reorderQueued`, `sendQueued` and `commands` beside them;
  - `resume` at `:1014`, which adopts the old queue;
  - `emitQueue` and the `queueChanged` event;
  - the `quirky.session/removed` queue clear at `:1724`, which stays as is.
- `plugins/quirky.structured/claude-runner.ts:445-461`: the system `init` handler. Read `slash_commands` (string[]) and `skills` (string[], when present) and report them through the runner context.
- `plugins/quirky.structured/runner.ts`: `StructuredContext`. Add a way for a runner to report its command list.
- `plugins/quirky.structured/quirky-plugin.json`: `contributes.method` and `contributes.event`. Add the method and event schemas.
- `packages/protocol/src/chat.ts:39-52`: add the shared `AgentCommand` type beside `AgentCapabilities` and `QueuedMessage`.

### Unit 2: platform support
- `packages/protocol/src/desktop-capabilities.ts:2-3,42-70`: `FolderPickerRequest` and `FolderPickerResult`, the `DesktopShellAction` union, and `NativeDesktopBridge.pickFolder`. Add the file-picker counterparts and a `filePicker` capability flag.
- `packages/daemon/src/methods.ts:547-556`: `desktop.folder.pick`. Add `desktop.file.pick` next to it.
- `packages/daemon/src/plugins/layout.ts:1044-1046`: `pickFolder`. Add `pickFiles` via `requestDesktopShell`. Capabilities are reported at `:1036-1042`.
- `packages/protocol/src/kernel-schemas.ts`: add the schema for the new kernel method. `packages/protocol/src/rpc.ts` gets any method-name union entry the folder method has.
- `packages/ui/src/shell.ts:27-29`: the `folder-picker` action. Add `file-picker`.
- `packages/ui/src/browser-host.ts`: the `folder-picker` kind (`:51,189,326,384,422,655,671`). The browser host reports `filePicker: false` and rejects `file-picker`. It does **not** get a web picker.
- `apps/desktop/src/bun/index.ts:212-221` (`pickFolder` with `Utils.openFileDialog`) plus `apps/desktop/src/bun/native-browser.ts:70` and `native-browser-preload.ts:22,92`: add `pickFiles` with `canChooseFiles: true`, `canChooseDirectory: false` and an image type filter.
- `plugins/quirky.session/main.ts:17,43`: the store is opened via `context.openStore(sessionMigrations(...))`, and methods are registered from a `methods` record. Add `pasteImage`, `draft`, `saveDraft` and `clearDraft`.
- `plugins/quirky.session/src/records.ts:200`: `sessionMigrations`. Add a migration for a `composer_drafts` table.
- `plugins/quirky.session/quirky-plugin.json`: add `contributes.method` entries and a `contributes.setting` entry, in the shape of `plugins/quirky.agents/quirky-plugin.json:4095-4109`.
- `scripts/gen-icons.ts:24`: `CONTROL_ICON_NAMES`. Add `stop` and `arrow-up`, then regenerate `packages/ui/src/design-system/icons/generated-controls.ts`.

### Unit 3: editor and transcript
- New directory `plugins/quirky.session/src/window/chat/editor/`, holding the editor component and its CM6 extensions, split into focused files (markdown styling, pills, triggers, keymap, paste/drop).
- `plugins/quirky.session/package.json`:
  - add `@codemirror/state`, `@codemirror/view`, `@codemirror/language` and `@codemirror/lang-markdown` at the versions in `packages/ui/package.json:22-30`;
  - add `@codemirror/commands` at the version in `plugins/quirky.editor/package.json:8`;
  - add `remark-breaks`, a new dependency not yet in the repo;
  - `bun.lock` changes with it.
- `packages/ui/src/editor-theme.ts:5-38`: the token-only `EditorView.theme` pattern to copy. Do not import its gutter or diff rules.
- `plugins/quirky.session/src/window/chat/Turn.tsx:32-40,130-132`: the user bubble, plain `pre-wrap` text today. Render it through the shared markdown pipeline.
- `plugins/quirky.session/src/window/chat/Prose.tsx:3-24`: the unified pipeline. Make single newlines render as line breaks (`remark-breaks`, added to the plugin's package.json).

### Unit 4: composer shell
- `plugins/quirky.session/src/window/chat/Composer.tsx` (the whole file): replace the body. The `Composer` props `{context, session, capabilities, working, onPick}` stay.
- `plugins/quirky.session/src/window/chat/controls.tsx`:
  - keep `useAgentOptions`, `launchPicks`, `Picks`, `NO_PICKS`, `reasonOf` and `absolutePathsOf`;
  - replace `Controls` with the settings chip, popover and badges;
  - delete the `onAttachHint` toast at `:159`.
- `plugins/quirky.session/src/window/chat/Mentions.tsx`: `useFileSearch` stays as the `@` data source. The list rendering moves into the new suggestion list.
- `plugins/quirky.session/src/window/chat/QueuedList.tsx`: becomes attached rows with drag reorder, pending steer, and read-only mode for ended sessions.
- `plugins/quirky.session/src/window/chat/ChatView.tsx:116,159,185`: loads capabilities, history and live messages. It passes whatever the new composer needs (commands, ended state). `createChat.ts:8-20` is used for New chat, and `ErrorRow.tsx:54` is the existing resume call pattern.
- `plugins/quirky.session/ui-scoreboard.json`: declares states for `view:quirky.session/structured`. Update it if the composer adds a declared error state.

## Contracts & interfaces

### Unit 1 (consumed by unit 4)

All unit 1 methods throw `not-found` for an unknown session id, as the existing `queue` and `dequeue` handlers do.

CONTRACT: `quirky.structured/reorderQueued` `{session: string, ids: string[]}` → `{ok: true}` ([SC-13](logic.md#sc-13-manage-queued-messages))
- **Pre:** `ids` is a permutation of the session's queued ids.
- **Post:** the queue order equals `ids`, and `queueChanged` is emitted.
- **Errors:**
  - `not-found` when any id is unknown;
  - `invalid-params` when `ids` is not a permutation.
- **Invariant:** ids, text and images are unchanged.

CONTRACT: `quirky.structured/sendQueued` `{session: string, id: string}` → `{ok: true}` ([SC-14](logic.md#sc-14-queued-messages-after-stop))
- **Pre:** the session is live and idle (status `done`).
- **Post:** that queued message is taken and sent now as a new turn, through the same path `flushQueue` uses (`main.ts:376-410`: `queue.take`, revalidated images, `runner.send` with `queuedId`). `queueChanged` is emitted, and `flushPaused` is cleared for the session.
- **Errors:**
  - `not-found` when the id isn't queued;
  - `conflict` with `data.reason = 'busy'` when the session is working, because the UI uses `steer` then;
  - `conflict` with `data.reason = 'exited'` when the session has ended.
- **On a send failure:** the message is restored to its slot (`queue.restore`) and the error is rethrown.

The **held-after-Stop** state needs no new flag. After `interrupt`, the turn ends with `flush = false` (`main.ts:488`) and `interrupting` resets (`main.ts:1614`). The queue then sits until one of these:
- (a) `sendQueued` on a row, while idle;
- (b) a new `send`, whose turn end flushes the queue normally;
- (c) `steer` while a turn runs.

The UI shows **Send next** (`sendQueued`) on rows while the session is idle, and **Steer now** (`steer`) while it's working.

CONTRACT: `quirky.structured/commands` `{session: string}` → `{commands: AgentCommand[]}` ([SC-6](logic.md#sc-6-pick-a--command))
- **Pre:** none beyond a known session. It works for live and exited sessions.
- **Post:** returns the most recent list the session's runner reported, or `[]` when none was reported (Codex, pi and omp today, or before the first init). The list is kept in memory per session id and isn't persisted. After a daemon restart it's empty until the next init.
- **Invariant:** names are unique per `kind`. Agent-reported duplicates are dropped.
- **Errors:** `not-found` for an unknown session.

CONTRACT: event `quirky.structured/commandsChanged` `{sessionId: string, commands: AgentCommand[]}`
- Emitted whenever a runner reports a new list.

CONTRACT: `quirky.structured/resume`, with unchanged params.
- **Post (added):** queued messages of the old session move, in order, to the returned session. `queueChanged` is emitted for both ids. The new session then flushes them through the normal idle flush once its first turn settles. If none is running, they send in order once it's idle, following the existing `flushQueue` rule.

### Unit 2 (consumed by unit 4)

CONTRACT: kernel method `desktop.file.pick` `{title?: string, multiple?: boolean, imagesOnly?: boolean}` → `{cancelled: boolean, paths: string[]}` ([SC-7](logic.md#sc-7-attach-images))
- **Pre:** called from a UI connection, or a CLI caller with a focused window, like `desktop.folder.pick`.
- **Post:**
  - `cancelled: true` with `paths: []` when the user dismisses the dialog;
  - otherwise one or more absolute file paths.
  - `imagesOnly` filters the dialog to png, jpg, jpeg, gif and webp.
- **Errors:**
  - `invalid-params` for wrongly typed params;
  - unsupported shells (non-darwin, or the browser host) throw `conflict`. That is the daemon's existing code for a missing desktop capability, the same one `desktop.folder.pick` uses (`layout.ts` `requestDesktopShell`). `RpcErrorCode` has no `unsupported`.
- **Capability:** `NativeDesktopCapabilities` gains `filePicker: boolean`, next to `directoryPicker` (`desktop-capabilities.ts:35`). Update its schema in `kernel-schemas.ts` and `DEFAULT_DESKTOP_CAPABILITIES` (`false`). Add the method schema beside `desktop.folder.pick` (`kernel-schemas.ts:~867`), and add `file-picker` to every enum that lists `folder-picker` (`kernel-schemas.ts:~63` and `:~1036`).
- The UI disables + when `context.call('desktop.capabilities')` reports `filePicker: false`, with the title "Drop or paste images here".

CONTRACT: `quirky.session/pasteImage` `{session: string, mime: 'image/png'|'image/jpeg'|'image/gif'|'image/webp', data: string /* base64 */}` → `{path: string}` ([SC-7](logic.md#sc-7-attach-images))
- **Pre:** the session exists in `SessionRecords`.
- **Post:** writes the decoded bytes under the plugin `dataDir` (`pasted/<session>/<uuid>.<ext>`) and returns the absolute path. The file exists on return.
- **Invariant:** writes only under `dataDir/pasted/`.
- **Errors:**
  - `not-found` for an unknown session;
  - `invalid-params` for another mime type, bad base64, or decoded data over 20 MB (matching `queue.ts:105`).
- **Cleanup:** on the `quirky.session/removed` event (emitted at `plugins/quirky.session/src/sessions.ts:1123`), delete `pasted/<session>/`.

CONTRACT: `quirky.session/draft` `{session}` → `Draft | null`; `quirky.session/saveDraft` `{session, draft: Draft}` → `{ok: true}`; `quirky.session/clearDraft` `{session}` → `{ok: true}` ([SC-10](logic.md#sc-10-drafts-are-kept-per-session))
- **Pre:** a string session id. Drafts aren't checked against `SessionRecords`, because a draft can be saved while a session row is being created.
- **Post:**
  - `draft` returns the last saved value, or `null`;
  - `saveDraft` replaces it, setting `updated_at`;
  - `clearDraft` deletes it.
- **Invariant:** one row per session. A draft survives a daemon restart.
- **Errors:** `invalid-params` when `draft` doesn't match the `Draft` schema (wrong types, or more than 64 KiB of JSON).
- **Cleanup:** the `quirky.session/removed` handler deletes the session's draft row.

CONFIG: setting `setting:quirky.session/send-with-cmd-enter`, `type: "boolean"`, `default: false`, title "Send with Cmd+Enter", description "Enter inserts a new line and Cmd+Enter sends."

### Unit 3 (consumed by unit 4)

CONTRACT: `ComposerEditor` React component (`plugins/quirky.session/src/window/chat/editor/ComposerEditor.tsx`)
- **Props:**
  - `value: string` and `onChange(value)`;
  - `placeholder: string`;
  - `disabled?: boolean`;
  - `sendKey: 'enter' | 'mod-enter'`;
  - `onSubmit(kind: 'send' | 'steer')`;
  - `onTrigger(trigger: Trigger | null)`;
  - `onKeyNav?(key: 'up'|'down'|'enter'|'tab'|'escape'): boolean`, which returns true when the suggestion list consumed the key;
  - `onEscape?(): void`, which stops the turn when no list is open;
  - `onUpInEmpty?(): void`;
  - `onPasteFiles(files: File[]): void` and `onDropFiles(files: File[]): void`;
  - `onLongPaste(text: string): void`;
  - `accessibleName: string`.
- **Imperative handle:** `focus()`; `insertPill(pill: Pill, range?: {from, to})`, which replaces the active trigger range when `range` is omitted; `wrapSelection(marker)`; `clear()`.
- **Pre:** mounted inside a React tree. `value` may hold pill text such as `@README.md`, which is re-rendered as pills on load when the path matches the `@<path> ` pattern.
- **Post:** every user edit calls `onChange` with the full plain text. The editor grows with its content up to `max-height: 50%` of its container, then scrolls (logic.md [Capabilities](logic.md#capabilities)).
- **Errors:** none thrown. Paste and drop handlers swallow non-file payloads.
- **Invariants:**
  - `value` is plain text. A pill serialises to `@<path>` (file) or `/<name>` (command or skill) followed by a space.
  - Enter never submits while `view.composing` is true or the key event `isComposing` is true. A keyCode 229 Enter is treated as composition confirm only when composition ended less than 50 ms earlier (Android keyboards send 229 on plain Enter).
  - `onSubmit('steer')` fires on Mod+Enter, or on Shift+Mod+Enter when `sendKey` is `'mod-enter'`.
  - A paste over 2,000 characters calls `onLongPaste` and inserts nothing. A paste with image files calls `onPasteFiles` and inserts nothing.

SCHEMA (in `editor/types.ts`): `Trigger = {kind: '@' | '/', query: string, from: number, to: number}`; `Pill = {kind: 'file', path: string} | {kind: 'command', name: string}`

CONTRACT: `renderUserMarkdown(text: string): ReactNode` (shared from `Prose.tsx` or a sibling module). It renders the same GFM subset agent prose uses, and shows `@path` tokens as file-name spans.

## Data models / schemas

SCHEMA (`packages/protocol/src/chat.ts`): `AgentCommand = {name: string, kind: 'command' | 'skill', description?: string}` (`name` has no leading slash)

SCHEMA (`plugins/quirky.session`, exported for the UI from `plugins/quirky.session/src/drafts.ts`): `Draft = {text: string, images: string[], pastes: {id: string, text: string}[], picks: {model: string|null, effort: string|null, mode: string|null, plan: boolean}}`

SCHEMA (store migration): `composer_drafts(session_id TEXT PRIMARY KEY, draft TEXT NOT NULL /* JSON Draft */, updated_at TEXT NOT NULL)`

Unit 4 owns these behaviours, each in the named file:

| Behaviour | Spec | File |
|---|---|---|
| Dropped non-image paths become pills: relative to the worktree root when inside it, absolute otherwise. The worktree path comes from the session's worktree record, already loaded by `ChatView`. | [SC-8](logic.md#sc-8-drop-a-non-image-file) | `Composer.tsx` |
| The same image path added twice appears once. This keeps today's dedupe in `Composer.tsx` `attach`. | [SC-7](logic.md#sc-7-attach-images) | `Composer.tsx` |
| The model list shows a search field once it has more than 8 entries. | [SC-15](logic.md#sc-15-change-settings-from-the-chip) | `SettingsChip.tsx` (new) |
| Long-paste chips: their text is appended after the typed message on send, separated by a blank line. | [SC-9](logic.md#sc-9-long-paste-becomes-a-chip) | `Composer.tsx` |
| Inline errors (failed send, rejected setting, refused image) use `InlineError` under the card and clear on the next edit. | [SC-18](logic.md#sc-18-failed-send) | `Composer.tsx` |
| The ended card, read-only queue rows and Resume moving the queue. | [SC-17](logic.md#sc-17-session-ended) | `Composer.tsx`, `QueuedList.tsx` |

SCHEMA: Quirky command table, owned by unit 4 in `plugins/quirky.session/src/window/chat/commands.ts`:

| Command | Action |
|---|---|
| model | open popover at the model section |
| effort | open popover at the effort section |
| mode | open popover at the permission section |
| plan | toggle plan |
| new | `createChat(context, session.agent, session.worktreeId, picks)` |
| stop | `quirky.structured/interrupt` |
| resume | `quirky.structured/resume`, then open the returned session |

## DO-NOT-CHANGE fences

- **`quirky.structured/send` params and `when` semantics** (`main.ts:1263-1304`): other callers (CLI, ask flows) depend on them. The composer keeps calling `send` with `when: working ? 'idle' : 'now'` and `steer` with `{session, id}`. Steering new text (Cmd+Enter while working) is `send` with `when: 'idle'`, then `steer` with the returned `queuedId`. That keeps the `steer` capability check (`main.ts:1482-1522`). Never send `when: 'now'` mid-turn from the composer, because it bypasses the check. The "waiting for next tool call" state is UI-local: it holds from a successful `steer` until a user message with that text arrives on `quirky.structured/message`.
- **The interrupt flush behaviour** (`main.ts:488`, `flush = !entry.interrupting`): this is the held-after-Stop behaviour SC-14 relies on.
- **The queue clear on `quirky.session/removed`** (`main.ts:1724`): the session lifecycle owns cleanup.
- **`useAgentOptions`, `launchPicks` and the `configure` call shape** in `controls.tsx` and `Composer.tsx:100-130`: model and effort loading per agent was fixed in FR7/FR8 (recent commits `83f3351d8`, `0030c45f6`). Keep that logic, and change only how it's presented.
- **`packages/ui/src/editor-theme.ts`**: shared by other editors. Copy the pattern rather than editing it.
- **Plugin CSS**: none. `scripts/ui-lint.ts` `ui/no-plugin-css` bans CSS files and `<style>` in plugin source. Style with inline token objects and `EditorView.theme` using `var(--ui-*)` tokens only (`ui/no-raw-color`, `ui/no-raw-pixel`).

## Always / Ask / Never

**Always**
- Use design-system components where the mock inventory names one: `Popover`, `ListRow`, `Badge`, `ScopeChip`, `InlineError`, `IconButton`, `Button`, `SectionHeader`, `AgentIcon`, `FileIcon`, `ControlIcon`.
- Read every agent difference from `AgentCapabilities`. Unsupported means disabled, with `reasonOf(...)` as the `title`.
- Give the editor an accessible name via `EditorView.contentAttributes`.
- Key drafts by session id. Save them debounced (about 400 ms) and on unmount.

**Ask** (stop and surface)
- Any need to change the `send`, `steer` or `interrupt` contracts.
- Any need for a web (browser-host) file picker.

**Never**
- Add plugin CSS files or raw colors or pixels.
- Send pill markup or HTML to the agent. The agent gets plain text.
- Hide markdown syntax characters.

## Cross-cutting

- **Security:** `pasteImage` validates mime and size and writes only under `dataDir`. File picker paths come from the OS dialog only. Agent-reported command names are rendered as text, never HTML.
- **Migration:** a new store migration in `sessionMigrations`. It is additive, so rollback leaves an unused table.
- **Observability:** none beyond existing toasts. Failures surface inline.

## Testing strategy

Run targeted files only (`bun test <file>`, one file per process). The full suite runs on the draft PR.

| Unit | Test file | Must cover |
|---|---|---|
| 1 | `plugins/quirky.structured/test/queue.test.ts` (extend) | `reorder` keeps ids, text and images and rejects non-permutations; `moveSession` keeps order |
| 1 | `plugins/quirky.structured/test/structured.test.ts` (extend) | `reorderQueued` emits `queueChanged`; `commands` returns the init list for Claude and `[]` for others; `commandsChanged` fires; `resume` moves the queue in order |
| 2 | daemon desktop methods test (beside existing `desktop.folder.pick` tests; find with `grep -rl "desktop.folder.pick" packages/daemon/test`) | `desktop.file.pick` forwards to the shell with `imagesOnly`; unsupported throws |
| 2 | `plugins/quirky.session/test/drafts.test.ts` (new) | draft get, save and clear round trip; deleted on session removal; `pasteImage` writes the file and rejects bad mime and oversize |
| 3 | `plugins/quirky.session/test/composer-editor.test.ts` (new, happy-dom, drive through `EditorView` state and dispatch) | pill serialisation and whole-pill delete; trigger detection for `@` and `/`; Enter, Shift+Enter, Mod+Enter and `sendKey` swap; no submit while composing; long paste over 2,000; image paste routed to `onPasteFiles` |
| 3 | `plugins/quirky.session/test/transcript-markdown.test.ts` (new) | user bubble renders a code block, bold and `@path`; prose keeps single newlines |
| 4 | `plugins/quirky.session/test/composer.test.ts` (rewrite) | one case per Screens row and SC-1, 3, 6, 7, 10–18 using `test/ui-fake.ts` fakes |

**Acceptance bar:**
- Each unit's files pass.
- `bunx tsc --noEmit -p tsconfig.json`, `bun run ui:lint` and `bun run ui:scoreboard:check` are clean.

The redesign after pass (goal replay in the real app and re-scoring) runs after the build. It is not a unit test.

## Non-goals

- The New chat dialog and the prompt dialog.
- Voice input.
- A browser-host file picker.
- Capturing commands for Codex, pi or omp. Their list stays empty until a later change finds a source.
- Shell styling outside the composer.

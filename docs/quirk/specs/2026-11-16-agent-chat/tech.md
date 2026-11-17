# Tech spec: agent chat with agent-drawn views

**Status:** Draft for run chat1. **Logic spec:** [logic.md](logic.md) (approved 2026-11-16). **Mock:** [mock/mock.html](mock/mock.html), inventory [mock/screens.md](mock/screens.md).

All paths are relative to the repo root. Anchors were surveyed on 2026-11-16 at commit `601cb42`.

## Architecture

The chat is split across five plugins. Each plugin owns its own files, and they talk only through public RPC (`context.call`) and embedded views (`context.mountView`, `packages/protocol/src/ui.ts:368`). No plugin imports another plugin's `src/` (`docs/plugin-api.md:7`).

| Plugin | Role in the chat | Back-link |
|---|---|---|
| `packages/protocol` | Shared types: `ChatItem`, `AgentCapabilities`, `QueuedMessage`, and the additive `StructuredMessage.item` field | [Conceptual model](logic.md#conceptual-model) |
| `quirky.structured` (daemon only) | Runners for claude, codex, pi and omp. It normalizes agent events into `ChatItem`s, declares capabilities, queues messages, snapshots the worktree at turn start and end, and maps approvals | [Data flow](logic.md#data-flow) |
| `quirky.ask` | Adds `view:quirky.ask/card`, an embeddable single-ask card with an approval variant | [Approvals and questions](logic.md#approvals-and-questions) |
| `quirky.git` | Tree snapshots and tree-to-tree diffs. Adds `view:quirky.git/turn-changes` (the changes card) and delivers notes to structured sessions | [Reviewing a turn](logic.md#reviewing-a-turn) |
| `quirky.view` (new) | The `quirky view` CLI, view storage, catalog checks, actions, `view:quirky.view/render` (one view) and `view:quirky.view/pane` (the Views pane for a session) | [Agent-drawn views](logic.md#agent-drawn-views) |
| `quirky.session` | `ChatView` replaces `StructuredView`. It covers turns, prose, activity, cards, composer, queue, empty and error states, and it mounts the four embedded views above | [The chat session](logic.md#the-chat-session) |

Technologies already in the repo, with nothing new added to the shell:
- React 19 and `@quirky/ui` (`packages/ui/src/design-system/index.ts`).
- `unified` with `remark-gfm` and `rehype-sanitize` for markdown, as in `plugins/quirky.ask/package.json`.
- SQLite plugin stores, as in `plugins/quirky.git/src/daemon/store.ts:9`.
- `bun:test` with `@happy-dom/global-registrator` for UI tests (`plugins/quirky.session/test/structured-view.test.ts`).

Charts are hand-drawn SVG using `--ui-*` tokens. There is no chart library.

## Code references

### Existing anchors
- Session view switch: `plugins/quirky.session/src/window/SessionView.tsx:70-73`. It renders `StructuredView` when `session.kind === 'structured'`.
- Current transcript: `plugins/quirky.session/src/window/StructuredView.tsx` (props `{context, session}`, `:48`; load `:63-88`; send `:101-111`), `MessageRow.tsx:28` and `transcript.ts:13,18`.
- Embeddable structured view: `plugins/quirky.session/src/ui.tsx:120-125` (`view:quirky.session/structured`).
- Runner contract: `plugins/quirky.structured/runner.ts:21-49` (`StructuredContext`, `StructuredRunner`, `StructuredStartOptions`).
- Agent union and runner choice: `plugins/quirky.structured/main.ts:33` (`StructuredAgent`), `:51` (`AGENT_TITLES`), `:177` (guard), `:499-506` (`runnerFor`), `:671` (rejection message), and the `agent` enum in the `create` params (`quirky-plugin.json:13`).
- Asks from runners: `main.ts:364-420` (`createAsk`). Claude approvals: `claude-runner.ts:236-290`. Codex approvals: `codex-runner.ts:625-695`.
- Journal append and event: `plugins/quirky.structured/journal.ts:134` and `main.ts:281`. Settled event: `main.ts:305`.
- Send and busy refusal: `main.ts:1011-1047`. Manifest methods: `plugins/quirky.structured/quirky-plugin.json:13-232`.
- Claude event mapping: `claude-runner.ts:311-383`. Codex item mapping: `codex-runner.ts:537-580`. Codex steer: `codex-runner.ts:309-360`.
- Agent catalog entries: `plugins/quirky.agents/quirky-plugin.json` (claude and codex `structured` mappings near `:2052,2092,2323,2378`; pi `:3128-3204`; omp `:3206-3290`). The pi RPC probe is `plugins/quirky.agents/src/model-probe.ts:575`.
- Session identity for CLI callers: `caller.sessionAuthority` (`plugins/quirky.ask/main.ts:73-75`). The token is `QUIRKY_SESSION_TOKEN`, issued for structured children at `packages/daemon/src/plugins/runtime.ts:299-307`.
- Ask validator: `plugins/quirky.ask/src/core/spec.ts:515` (`validateAskSpec`), `:553` (`formatSpecErrors`). Card: `src/AskCard.tsx:54`. Fields: `src/QuestionField.tsx:39`. Panel provide: `src/ui.tsx:14-24`.
- Sanitized preview: `packages/ui/src/design-system/read-only-preview.tsx` (CSP `:7-11`, iframe `:46-51`).
- Needs-you count: `packages/ui/src/shell/StatusBar.tsx:107-173`.
- CLI command plumbing: manifest `cli-command` entries (as in `plugins/quirky.ask/quirky-plugin.json`), `plugins/quirky.ask/cli.ts:90` (`commands` export), `packages/cli/src/plugin-commands.ts:53-89`, generated help at `packages/cli/src/command-spec.ts:26-61`.
- Git: `packages/git/src/compare.ts:79` (`changeList`), `:~237` (`worktreeChangeList`), `packages/git/src/diffs.ts:185` (`diffSource`), `plugins/quirky.git/src/daemon/files.ts:27` (`diff` RPC), `daemon/targets.ts:50,112-148` (`noteTargets`, `sendNotes`, terminal-only delivery), `daemon/notes-format.ts:8-26`, `view/DiffPane.tsx:37-87`, `notes/binding.tsx:16-32`, `notes/NoteCards.tsx`, `notes/NotesPill.tsx:4`, `notes/SendMenu.tsx:10-13,103`.

### Files to create
- `packages/protocol/src/chat.ts`, re-exported from `packages/protocol/src/index.ts`.
- `plugins/quirky.structured/items.ts`: the claude and codex normalizers, `toChatItem`.
- `plugins/quirky.structured/capabilities.ts`.
- `plugins/quirky.structured/queue.ts`.
- `plugins/quirky.structured/pi-runner.ts`, `pi-rpc.ts` and `pi-path.ts` (one runner with `variant: 'pi' | 'omp'`).
- `plugins/quirky.ask/src/CardView.tsx`.
- `plugins/quirky.git/src/daemon/snapshots.ts` and `plugins/quirky.git/src/view/TurnChanges.tsx`.
- `plugins/quirky.view/`: `quirky-plugin.json`, `package.json`, `main.ts`, `cli.ts`, `src/core/catalog.ts`, `src/core/store.ts`, `src/ui.tsx`, `src/render/*.tsx`, `src/Pane.tsx`, `README.md`, `test/`.
- `plugins/quirky.session/src/window/chat/` holds the transcript files: `ChatView.tsx`, `turns.ts`, `Turn.tsx`, `Prose.tsx`, `Activity.tsx`, `cards/*.tsx`, `Embedded.tsx` and `ErrorRow.tsx`. It also holds the composer files: `Composer.tsx`, `QueuedList.tsx`, `AgentPicker.tsx`, `Mentions.tsx` and `controls.tsx`.

## Contracts & interfaces

### C1. Chat items ([Conceptual model](logic.md#conceptual-model))
Every runner sets `item` on each message it appends. `item` is additive: `text` and `data` keep their current meaning, so existing callers (`quirky.git`, loops, mobile) are unaffected. A message with no `item` (journals written before this change) renders as plain text through the old `MessageRow` path.

SCHEMA (`packages/protocol/src/chat.ts`):
```
ChatItem =
  | { kind: 'user'; text: string; images?: string[]; queuedId?: string }
  | { kind: 'prose'; text: string; streaming?: boolean }                 // markdown
  | { kind: 'activity'; callId: string; tool: string; summary: string; state: CallState; detail?: string }
  | { kind: 'file-change'; callId: string; path: string; added?: number; removed?: number; state: CallState }
  | { kind: 'tests'; callId: string; command: string; passed?: number; failed?: number; skipped?: number; state: CallState; tail?: string }
  | { kind: 'steps'; callId: string; steps: { text: string; state: 'pending'|'active'|'done' }[] }
  | { kind: 'ask'; askId: string; variant: 'approval'|'question' }
  | { kind: 'view'; viewId: string }
  | { kind: 'view-error'; title: string; errors: string[]; source: string }  // a refused quirky view spec; source capped at 64 KiB
  | { kind: 'changes'; worktree: string; fromTree: string; toTree: string; files: number }
  | { kind: 'turn-end'; state: 'done'|'stopped'|'failed'; durationMs?: number }
  | { kind: 'error'; reason: 'exited'|'spawn'|'protocol'; stderrTail: string[]; resumable: boolean }
  | { kind: 'status'; text: string }                                       // system noise; hidden unless "Show all events"
CallState = 'running'|'done'|'failed'|'stopped'
StructuredMessage.item?: ChatItem   // add to packages/protocol/src/model.ts:568
GitDiffSource gains 'trees'          // packages/protocol/src/model.ts:475, see C4
```
- Invariants:
  - A tool call that starts and later finishes appends one message at the start (`state: 'running'`) and one at the end, with the same `callId`. The UI keeps the last item per `callId`.
  - When a turn is stopped, the runner appends a final item with `state: 'stopped'` for every call still running, then `turn-end` with `state: 'stopped'` (SC-3). The UI also renders any call still `running` in a turn whose `turn-end` is `stopped` as stopped, which covers journals cut off by a crash.
  - `file-change` is used for agent edit tools. `tests` is used when the command matches the test-command list in `items.ts`: `test`, `bun test`, `pytest`, `jest`, `vitest`, `go test` and `cargo test`. `steps` is used for TodoWrite (Claude), the plan/todo item (Codex) and the todo events from pi and omp. Every other tool is `activity`.
- Error behavior: a normalizer that can't classify an event returns `{kind:'status'}` and never throws.

### C2. Capabilities ([Composer](logic.md#composer), SC-8, SC-20)
CONTRACT: `quirky.structured/capabilities {agent} → AgentCapabilities`. It is static per runner and never contacts the agent.

SCHEMA:
```
Capability = { ok: true } | { ok: false; reason: string }      // reason is the hover text, e.g. "pi has no plan mode"
AgentCapabilities = { agent: 'claude'|'codex'|'pi'|'omp'; steer: Capability; planMode: Capability;
  permissionModes: { ok: true; modes: string[] } | { ok: false; reason: string };
  images: Capability; effort: Capability; approveForSession: Capability; resume: Capability }
```
- An unknown agent fails with `invalid-params` ("unknown agent <name>").
- The v1 values are fixed in `capabilities.ts`. The implementer verifies each value against the agent docs linked in logic.md Industry Insights (pi RPC doc) and against the runner code:
  - **claude:** everything ok.
  - **codex:** planMode and permissionModes are off ("Codex runs with on-request approval in Quirky").
  - **pi:** planMode, permissionModes and approveForSession are off.
  - **omp:** the same as pi, unless its RPC proves otherwise.

### C3. Send, queue and steer ([Streaming and working](logic.md#decisions-locked), SC-2, SC-3, SC-12)
CONTRACT (additive to `quirky.structured/send`, manifest `:171`):
- `send` takes `{session, text, images?: string[], when?: 'now'|'idle'}`.
  - The default is `'now'`, so current callers are unchanged.
  - `'idle'` appends the message to the session queue when the agent is working or waiting, and sends it at once when idle.
- `queue {session} → QueuedMessage[]`, `dequeue {session, id} → {ok}`, `editQueued {session, id, text} → {ok}`.
- `steer {session, id} → {ok} | conflict{reason:'steer-unsupported'}`. It removes the message from the queue and sends it now.
- `dequeue`, `editQueued` and `steer` with an id not in the queue fail with `not-found`. A queued message that already flushed is no longer in the queue.
- Event `queueChanged {sessionId, queue}`.

SCHEMA: `QueuedMessage = { id: string; text: string; images?: string[]; at: string }`.
- Invariants:
  - The queue lives in the plugin store and survives a daemon restart.
  - Messages flush in order on `settled` with state `done`, one per turn: the first sends and the rest wait for the next settle.
  - Stop leaves the queue untouched (SC-3).
  - `images` are absolute paths. They are refused with `invalid-params` when `capabilities.images.ok` is false.
- Codex steer keeps `turn/steer` (`codex-runner.ts:309-360`). Claude steer pushes to the input stream (`claude-runner.ts:211-218`). pi and omp use their RPC steer command.

### C4. Turn snapshots and changes ([Reviewing a turn](logic.md#reviewing-a-turn), SC-10)
CONTRACT (`quirky.git`, new public RPCs):
- `quirky.git/snapshotTree {worktree} → {tree: string}`
  - It writes a tree object for the whole working tree (tracked and untracked, honoring `.gitignore`) through a temporary index. It never touches the real index, HEAD or refs.
- `quirky.git/treeChanges {worktree, from, to} → {changes: GitChange[]}`
  - It has the same `GitChange` shape as `changeList` (`packages/protocol/src/model.ts:396`).
- `quirky.git/diff` accepts `source: 'trees'` (added to `GitDiffSource`, `packages/protocol/src/model.ts:475`, and to `DiffRequest` in `packages/git/src/diffs.ts:45`) with two extra string params, `from` and `to` (tree oids). It returns a `GitDiff` for one `path`, the same way the existing string sources do in `plugins/quirky.git/src/daemon/files.ts:27-29`.
- Errors:
  - `snapshotTree` on a worktree that isn't a git work tree fails with `invalid-params` ("not a git work tree").
  - `treeChanges` and `diff` with an unknown tree oid fail with `invalid-params` ("unknown tree <oid>").
  - `treeChanges` detects renames like `changeList` (`-M -C`). Binary files have `added` and `removed` set to `null` and `binary: true`.

`quirky.structured` behavior:
- It calls `snapshotTree` when a turn starts and again on settle.
- If the trees differ, it appends `{kind:'changes', fromTree, toTree, files}`.
- If `quirky.git` is missing (`MethodNotFound`) or either call fails, it appends nothing and carries on. A snapshot failure never fails a turn.

### C5. Notes to structured sessions (SC-11, SC-12)
- `quirky.git/sendNotes` (`daemon/targets.ts:142`) delivers to a session whose `kind` is `structured` through `quirky.structured/send {session, text, when:'idle'}`, using the `formatNotes` text.
- The sent/kept/hold semantics are unchanged. Delivery counts as successful when `send` returns `ok`.
- `noteTargets` lists live structured sessions in the worktree.

### C6. Approvals ([Approvals and questions](logic.md#decisions-locked), SC-6, SC-7)
Approval asks created by runners have exactly these questions:
- `decision` (select, values `allow`, `always`, `deny`, with labels "Allow once", "Allow for this session", "Deny")
- `reason` (text, optional, "Reason, if you deny")

The ask always carries all three `decision` values. When `approveForSession.ok` is false, the card shows "Allow for this session" disabled with the capability reason as its hover text (SC-8). If a stale client still answers `always`, the runner treats it as `allow`. The runner appends `{kind:'ask', askId, variant:'approval'}` and, for native questions, `variant:'question'`.

Deny mapping:
- Claude returns `{behavior:'deny', message: reason || 'Denied from Quirky'}`.
- Codex declines, then sends `Denied: <reason>` with `when:'now'` when a reason was given.
- pi and omp send the deny with their RPC's reason field if it has one, or else the same follow-up text.

CONTRACT: `view:quirky.ask/card`, input `{askId: string; sessionApproveDisabled?: string}`. `sessionApproveDisabled` is the capability reason. When it is set, the "Allow for this session" button is disabled and shows it on hover.
- It renders the existing `AskCard` for that ask.
- When the ask's questions are `decision` and `reason`, it renders the approval variant: the three buttons, with the reason field shown only after Deny.
- An answered or expired ask renders a one-line record ("Allowed once: <summary>").
- It refreshes on `quirky.ask/created` and on answer.

### C7. Views ([Agent-drawn views](logic.md#agent-drawn-views), SC-13 to SC-19)
CLI, in the new plugin `quirky.view`:
- `cli-command` ids are `view` (words `""`), `view-open` (`open`), `view-update` (`update`), `view-close` (`close`) and `view-wait` (`wait`).

COMMAND (agent-facing usage):
```
quirky view open --spec @file.json [--placement inline|pane]
quirky view update --id <viewId> --spec @file.json
quirky view close --id <viewId>
quirky view wait --id <viewId> [--timeout-ms N]
quirky view --help
```
- `--help` prints the generated usage, then the catalog guide from `src/core/catalog.ts`, which lists every component with its props and one example.
- `open` prints `{viewId}`.
- An invalid spec makes the command exit 2 and print `formatViewErrors` on stderr (`path: message; …`, the same style as `formatSpecErrors`).
- With no session identity, the command exits 1 with "quirky view works only inside a Quirky agent session".

RPC:
- `quirky.view/open {spec, placement?} → {viewId}` and `update {viewId, spec}`. The caller's session comes from `caller.sessionAuthority`, as in `plugins/quirky.ask/main.ts:73-75`.
- `close {viewId}`, `wait {viewId, timeoutMs?} → {action} | {status:'timeout'}`.
- `list {session} → ViewRecord[]`, `get {viewId}`, `move {viewId, placement}` (user only).
- `action {viewId, name, source, data?}` (window only).
- Events `changed {sessionId, viewId}` and `rejected` (below).
- Mobile: `quirky.view` methods are deliberately not added to `plugins/quirky.mobile/src/daemon/authorization.ts`, because mobile is out of scope.

SCHEMA:
```
ViewSpec = { title: string; root: ViewNode }
ViewNode = { type: CatalogType; props?: Record<string, unknown>; children?: ViewNode[] }
CatalogType = 'stack'|'columns'|'section'|'markdown'|'kv'|'table'|'stat'|'status-list'|'steps'|'code'|'file-diff'|'bar-chart'|'line-chart'|'callout'|'button'|'field'
ViewRecord = { viewId: string; sessionId: string; title: string; spec: ViewSpec; placement: 'inline'|'pane';
  movedByUser: boolean; updates: number; createdAt: string; updatedAt: string; closed: boolean }
ViewAction = { name: string; viewId: string; source: string; at: string; data?: Record<string, unknown> }
```
Checks (`validateViewSpec(raw) → {ok:true, spec} | {ok:false, errors:{path,message}[]}`, pure, never throws):
- Limits: node count at most 500, depth at most 12, encoded size at most 256 KiB, table rows at most 500, chart points at most 500.
- Strings only. No function, HTML attribute or URL fields, except `markdown` links with an http(s) scheme.
- `field` props follow one ask question object: types select, multiselect, text, number and confirm. The rules mirror `plugins/quirky.ask/src/core/spec.ts`, reimplemented locally and never imported across plugins.
- `button` requires `action` (the action name, matching `[a-z0-9][a-z0-9-]{0,39}`).
- An unknown type is an error naming the type and suggesting the nearest catalog types.

Behavior:
- `open` appends nothing to the journal itself. `quirky.structured` subscribes to `quirky.view/changed` for its sessions and appends `{kind:'view', viewId}` once per new view.
- A refused `open` or `update` emits `quirky.view/rejected {sessionId, title, errors: string[], source}`. The title is the spec's title if one could be read, or else "Untitled view". The source is the raw spec text capped at 64 KiB. `quirky.structured` subscribes and appends `{kind:'view-error', title, errors, source}` (SC-17). The rejected spec is not stored in the view table.
- The view record is stored in the `quirky.view` store, and the journal holds only `{kind:'view', viewId}`. This is how the logic spec's "Views are saved in the session journal" is met: the journal points at the stored record, and both survive restart.
- `update` keeps placement when `movedByUser`, increments `updates` and emits `changed`.
- An action resolves a pending `wait` for that view first.
- With no pending wait, the action is sent as a message through `quirky.structured/send {when:'idle'}`, using this text:
  `View action "<name>" from "<title>" (view <viewId>): <JSON of data or {}>`
- Records live in the plugin store and survive restart (SC-19).

CONTRACT: the embedded views.
- `view:quirky.view/render {viewId}` renders one view card with the "by <agent>" tag and Move to pane or Move inline.
- `view:quirky.view/pane {session}` renders the Views pane (`ToolPanelFrame` with `ToolPanelTabs`) for that session's pane views. It renders nothing when there are none.
- Markdown renders through a `unified` pipeline with `rehype-sanitize`. It allows only the schema of `read-only-preview.tsx` plus `a[href]` with http and https. Clicking a link opens a confirm `Dialog` before opening it externally (SC-18).
- Rendering never uses `dangerouslySetInnerHTML` on unsanitized input.

### C8. The chat view ([The chat session](logic.md#the-chat-session), [Screens](logic.md#screens))
- `SessionView.tsx:70-73` renders `ChatView` instead of `StructuredView` for structured sessions. `view:quirky.session/structured` mounts `ChatView` too.
- `StructuredView.tsx` and `MessageRow.tsx` stay as the fallback renderer for messages without `item`.

CONTRACT: `ChatView({context, session})`.
- **Loading.** It loads `quirky.structured/messages`, subscribes to `message`, `settled`, `queueChanged` and `quirky.view/changed`, and groups by turn (`turns.ts`: a `user` item starts a turn).
- **Activity.** Consecutive `activity` items in a turn fold into one row ("Read 4 files · searched 2 patterns · 12s") that expands.
- **Embeds.** It mounts `view:quirky.ask/card` for `ask` items (passing `sessionApproveDisabled` from the session's capabilities), `view:quirky.view/render` for inline `view` items, `view:quirky.git/turn-changes` for `changes` items, and `view:quirky.view/pane` beside the transcript.
- **Scrolling.** It auto-scrolls only when already at the bottom.

CONTRACT: `Composer({context, session, capabilities, working})`.
- It sends through C3. Enter sends with `when:'idle'` while working.
- It shows the queued list, Steer now, and Stop with elapsed time.
- The agent chip, model and effort come from `quirky.agents/options`. The permission mode and plan toggle are capability-gated.
- Attach images uses a file picker and is capability-gated. `@` mentions call `quirky.editor/quickOpen {worktree, action:'search', query}` (`plugins/quirky.editor/quirky-plugin.json:407-410`) and insert `@path`. If the editor plugin is missing (`MethodNotFound`), the mention list shows "File search unavailable".
- Disabled controls carry `title` set to the capability reason.

Empty state (no session yet, or a new chat):
- `AgentPicker` shows the four agents. Readiness comes from `quirky.agents/list` detection, with "not installed" or "not signed in".
- Picking an agent creates the session through `quirky.structured/create {agent}`.

Error state:
- On `{kind:'error'}`, `ErrorRow` shows the stderr tail, Restart and Open in terminal.
- Restart calls `quirky.structured/resume` and is disabled with the reason when `resumable` is false. That is the provisional answer to SC-5's open question.
- Open in terminal opens a terminal tab for the same agent through the existing `quirky.terminal/newTab`, resuming the native conversation where the agent supports it.

## Data models / schemas
- Every shared shape is pinned in `packages/protocol/src/chat.ts` (C1, C2, C3 types). `ViewSpec`, `ViewRecord` and `ViewAction` are in `plugins/quirky.view/src/core/catalog.ts` and are used only by that plugin and its CLI.
- **Store tables** (each plugin's own SQLite store):
  - `quirky.structured`: `queue(session_id, id, text, images_json, at)`.
  - `quirky.view`: `views(view_id PK, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)`.
- **Fixtures:** `plugins/quirky.view/test/fixtures/bundle-size.json` is the mock's bundle-size view. The session UI tests build `ChatItem` arrays inline.

## DO-NOT-CHANGE fences
- **`StructuredMessage.text` and `.data` meaning** (`packages/protocol/src/model.ts:568-576`). `quirky.git`, loops, objectives and mobile read them. Only add `item`.
- **`quirky.structured/send` default behavior** (`main.ts:1011-1047`): `requireIdle`, `operationId` receipts and the busy refusals. Background automation relies on idempotent send. `when` is additive and defaults to `'now'`.
- **Single-owner resume and lease rules** (`main.ts`, logic in `docs/quirk/specs/2026-10-27-m5-structured-runner/logic.md` AC4). Resume correctness was hard-won, so the new runners join the same lease path.
- **The terminal delivery branches inside `sendNotes` (`plugins/quirky.git/src/daemon/targets.ts:112-140`).** Terminal sessions must keep working exactly as before.
- **`read-only-preview.tsx` CSP and schema.** Other plugins depend on it. Extend in `quirky.view`, never in place.
- **`docs/loop/BLOCKERS.md` mobile and native evidence.** Only the desktop-chat authorization line changes.

## Always / Ask / Never
- **Always:**
  - Use `@quirky/ui` components and `--ui-*` tokens. `bun run ui:lint` bans raw colors and px in listed plugins, so add `quirky.view` to `scripts/ui-lint-plugins.json`.
  - Return a `ChatItem` for every journaled message from the four runners.
  - Treat agent-supplied view content as untrusted.
  - Keep the scrolling transcript accessible (`role="log"`).
- **Ask:**
  - A capability value the agent's docs contradict. Resolve it from the docs and note it in the PR.
  - Any change to a public RPC beyond those listed here.
- **Never:**
  - Import across plugin `src/` folders.
  - Run agent code or load remote content in the window.
  - Add a chart or markdown library to the desktop shell.
  - Run `bun run test` or bare `bun test` (AGENTS.md).
  - Change terminal-session behavior.

## Cross-cutting
- **Security.**
  - View specs are data. They are checked in the daemon before they're stored, and rendered with React elements only.
  - Markdown is sanitized, and links confirm before opening.
  - `quirky view` refuses callers without a live session authority.
  - Images for `send` must be files the user picked. The daemon checks that each path exists and is a regular image file at most 20 MB.
- **Migration.** The new tables are created on plugin start. Old journals without `item` render through the fallback.
- **Docs amendment** ([Scope & non-goals](logic.md#scope--non-goals)):
  - `BRIEF.md:67-69` removes native chat from the dropped list.
  - `docs/architecture.md:175-178` and `:302-303` say interactive structured sessions are allowed through the chat view.
  - `docs/roadmap.md:176` is reworded.
  - `docs/loop/BLOCKERS.md` gets one line under `sb-mobile-chat-voice-native-ruling`: desktop chat is authorized by this spec, and mobile chat, voice and native mirroring remain blocked.
- **Rollback.** All of this is additive behind the structured `kind`. Reverting `SessionView.tsx:70-73` restores the old transcript.

## Testing strategy
Run one test file per process with `bun test <file>`. The full suite runs on the PR (AGENTS.md).
- `packages/protocol`: types only. Covered by typecheck.
- `plugins/quirky.structured/test/items.test.ts`: claude and codex fixtures map to each `ChatItem` kind, `callId` pairing, and the unknown-to-status case.
- `plugins/quirky.structured/test/queue.test.ts`: when idle, flush on settle, stop keeps the queue, steer, persistence across reopen.
- `plugins/quirky.structured/test/capabilities.test.ts` and `test/changes.test.ts`, the latter with a fake `quirky.git` that is missing, failing or returning trees.
- `plugins/quirky.structured/test/pi-runner.test.ts`: a scripted JSONL transport for pi and omp covering start, stream, tool, ask, steer, stop and exit with a stderr tail.
- `plugins/quirky.ask/test/card-view.test.ts`: the approval variant, the reason shown only after Deny, and the answered record.
- `plugins/quirky.git/test/snapshots.test.ts`: a temp repo, untracked files counted, the real index untouched. `test/send-structured.test.ts` covers delivery through `when:'idle'`. `test/turn-changes-view.test.ts` covers the list, expand, comment and send.
- `plugins/quirky.view/test/catalog.test.ts`: every type, every limit, unknown type with a suggestion, links. `test/views.test.ts`: open, update, move, wait, action routing, restart. `test/cli.test.ts`: exit codes and help containing the catalog. `test/render.test.ts`: each component renders, sanitization, and the link confirm.
- `plugins/quirky.session/test/chat-view.test.ts`: turn grouping, folding, cards, embeds mounted with the right input, the fallback for messages without `item`. `test/composer.test.ts`: queue, steer, stop, disabled reasons, mentions, agent picker readiness, error row.
- **Acceptance bar:** every Screens item in logic.md is covered by a UI test assertion on the matching state.

## Non-goals
- MCP Apps, saving views as files, slash commands, multi-agent compare, rewind, ACP, voice, mobile (logic.md Scope & non-goals).
- Virtualizing the transcript. It is deferred, and the v1 transcript renders every turn.
- A shared design-system home for the new chat components. They stay plugin-local in v1, which answers the logic spec's component-gap question.
- Changing Codex's sandbox or approval policy (`codex-runner.ts:7-8`).

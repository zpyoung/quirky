# Native chat port: tech spec

Status: Reviewed (automated tech-spec review, fixes applied). Logic spec: [logic.md](logic.md).

All paths are relative to the repo root. v1 sources are read with `git show quirky-v1-final:<path>`; nothing from the tag is checked out. Port v1 code by rewriting it against this app's primitives, never by pasting it unchanged: v1 used `UiPluginContext`, `context.call('quirky.*/…')` and `@quirky/ui`, and none of those exist here.

## Architecture

Three layers, matching [Conceptual model](logic.md#conceptual-model).

**Engine (kept, extended).** `src/main/native-chat/agent-session-*` and `src/main/runtime/rpc/methods/structured-agent-session*.ts`.

- Adapters (`src/main/claude`, `src/main/codex`, `src/main/acp`, `src/main/pi`) emit `ProviderTimelineEvent`s into `createProviderTimelineAssembler` (`src/main/native-chat/agent-session-timeline/provider-timeline-assembler.ts:82`). The assembler writes journal rows.
- Turns open in `decideTurnOpen` and close in `decideTurnEnd` (`agent-session-timeline/provider-timeline-turn-decisions.ts:43` and `:116`). `decideSessionEnd` (`:256`) closes a turn when the child exits.
- Item bodies are an open union (`src/shared/agent-session-journal-schemas.ts`, `KnownItemBody` at `:223`). `readAgentJournalItemBody` (`src/shared/agent-session-journal-body-admission.ts`) admits an unknown item kind as readable, so an older host still opens a journal holding the new kinds. No row-version bump is needed.
- Per-client downgrade lives at the RPC boundary. The precedent is `src/main/runtime/rpc/methods/structured-agent-session-turn-item-capability.ts`, applied in `structured-agent-session.ts` at `agentSession.history` (`:223`) and the `agentSession.subscribe` emit (`:261`).

**Projection and view (new).** A new directory `src/renderer/src/components/chat/` holds the ported v1 view. It reads `useStructuredAgentSession` (`src/renderer/src/components/native-chat/use-structured-agent-session.ts:52`) and its sub-hooks, which stay. A pure projection folds `journalItems` into v1-shaped turns.

**Phone.** `mobile/src/session` already projects journal items through `src/shared/structured-agent-session-projection.ts` (`itemBlocks`, about `:82-148`). Unknown kinds return `null` there (`:139-144`). New kinds get rows in the shared projection plus mobile row components.

Libraries added to the root `package.json` (versions from v1's `packages/ui/package.json` and `plugins/quirky.session/package.json`): `streamdown ^2.8.0`, `@streamdown/code ^2.0.1`, `@streamdown/math ^1.0.4`, `remark-gemoji ^8.0.0`, `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/lang-markdown`, `@lezer/highlight`. `shiki` (4.5.0), `dompurify`, `katex` and `mermaid` are already in the root `package.json`; keep the repo's versions. Monaco stays for the editor; the composer uses CodeMirror, as in v1.

## Data models

Every shape below that more than one task builds against lives in the file named. Shapes are `SCHEMA:` sketches. The implementer writes the zod schema beside the type.

### New journal item kinds

Back-link: [Conceptual model](logic.md#conceptual-model), [How data flows](logic.md#how-data-flows).

Types go in `src/shared/agent-session-journal-v1-items.ts` (new), are added to the `AgentJournalItemBody` union in `src/shared/agent-session-journal-types.ts`, and get zod arms in `KnownItemBody` (`src/shared/agent-session-journal-schemas.ts:223`).

SCHEMA:

```
plan        { kind: 'plan'; version: number; status: 'waiting'|'revised'|'approved'|'not-answered';
              text: string; filePath?: string; approvalItemId?: string;
              reason?: 'feedback'|'stopped'|'mode-switch'|'restarted'; empty?: boolean; unchanged?: boolean }
turn-changes{ kind: 'turn-changes'; turnId: string; source: 'git-tree'|'edit-tools';
              fromTree?: string; toTree?: string;            // present iff source === 'git-tree'
              files: { path: string; status: 'added'|'modified'|'deleted'|'renamed';
                       added?: number; removed?: number; oldPath?: string }[] }
mode        { kind: 'mode'; mode: 'ask'|'accept-edits'|'auto'|'full-access'|'plan'; previous?: same union }
fork        { kind: 'fork'; fromSessionId: string; fromItemId?: string; fromTitle?: string }
visual      { kind: 'visual'; viewId: string; version: number; title?: string;
              placement: 'inline'|'pane'; spec: AgentJournalBoundedPayload; closed?: boolean }
test-result { kind: 'test-result'; callId: string; command: string;
              state: 'running'|'passed'|'failed'; passed?: number; failed?: number; skipped?: number;
              tail?: string }                                  // tail ≤ 8 lines, ≤ 800 chars
```

Invariants:

- Each kind keeps one item per identity and updates it by revision: `plan` per `version`, `turn-changes` per `turnId`, `visual` per `viewId`, `test-result` per `callId`. The newest revision wins, as v1's "the UI keeps the last" rule did.
- `plan.version` counts from 1 per session and never repeats.
- `mode` permission values reuse `AgentChatPermissionMode` (`src/shared/agent-chat-permission-mode.ts`).
- `visual.spec` is the bounded JSON view spec (see [quirky view](#quirky-view)). Clients that need the whole spec when `shortened` is set read it with `agentSession.item`.
- `turn-changes` is written only when at least one file changed.

### Client and host capabilities

Back-link: [How data flows](logic.md#how-data-flows), [Phone and mixed versions](logic.md#phone-and-mixed-versions).

CONFIG: `AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY = 'agent-session.v1-chat-items.v1'` (client declares it can draw the six kinds) and `AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY = 'agent-session.v1-chat-methods.v1'` (host serves the new methods). Both are defined in `src/shared/agent-session-runtime-capabilities.ts`, next to `AGENT_SESSION_TURN_ITEM_CAPABILITY` (`:112`).

- The client capability is declared in `remoteRuntimeClientCapabilities()` (`src/shared/remote-runtime-client-capabilities.ts`, the shared list every remote transport sends, where the turn-item capability already is), `src/main/ipc/desktop-renderer-runtime-capabilities.ts`, `src/renderer/src/web/web-runtime-client-capabilities.ts` and `mobile/src/transport/mobile-runtime-client-capabilities.ts`. Missing the remote list would downgrade every new item for remote workspaces.
- The host capability joins `AGENT_SESSION_RUNTIME_CAPABILITIES` (same file, the array after `:137`). Clients read it from the host's advertised runtime capabilities, the way they gate rewind on `AGENT_SESSION_REWIND_RUNTIME_CAPABILITY`. When an older host lacks it, the desktop hides Fork, queue drag-reorder and diff expansion, and `quirky view` exits non-zero with "This Quirky host doesn't support quirky view yet."
- A new file `src/main/runtime/rpc/methods/structured-agent-session-v1-items-capability.ts` mirrors the turn-item file: `projectV1ItemHistory(ctx, page)` and `projectV1ItemEvent(ctx, event)`. For a negotiated client without the capability, it rewrites each of the six kinds to `{ kind: 'status', text: 'Update the app to see this.', tone: 'muted' }`, keeping `itemId`, `revision` and `sequence`. In-process callers (`ctx.clientKind === undefined`) get canonical bodies.
- `agentSession.item` gets the same projection.

### RPC additions

Back-link: [Behavior and scenarios](logic.md#behavior-and-scenarios).

Params are zod schemas in `src/shared/rpc-contract/structured-agent-session-params.ts`. Mutations (`queuedMessageMove`, `fork`, `view.open|update|patch|close`) take `envelope: MutationEnvelope` like `QueuedMessageActionParams` (`:208`), so the session id is `envelope.sessionId`; the flat `sessionId` below is shorthand for that. Reads (`turnDiff`, `view.get`) take the same session addressing as `agentSession.item`. Each method is registered with `defineMethod({ name, permission: 'workspace', params, handler })` and routed through `requireSessionHost(ctx, sessionId)`, as in `structured-agent-session-queued-methods.ts`. After adding methods, run `pnpm run generate:rpc-params-catalog` (regenerates `src/shared/rpc-contract/rpc-params-catalog.generated.ts`) and add each method to `src/main/runtime/rpc/methods/structured-agent-session-gate-classification.test-fixture.ts`.

SCHEMA:

```
agentSession.queuedMessageMove   { sessionId; queuedId; toIndex: number; expectedRevision?: number }
                                 → { ok: true } | { ok: false; reason: 'not-found'|'stale'|'sending' }
agentSession.fork                { sessionId; fromItemId?: string; title?: string }
                                 → { ok: true; sessionId: string } | { ok: false; reason: 'unsupported'|'busy'|'failed' }
agentSession.turnDiff            { sessionId; turnId; path: string }
                                 → { ok: true; patch: string; truncated: boolean } | { ok: false; reason: 'gone'|'not-git'|'failed' }
agentSession.view.open           { sessionId; spec: ViewSpec; title?; placement? } → { viewId; version }
agentSession.view.update         { sessionId; viewId; spec: ViewSpec } → { version }
agentSession.view.patch          { sessionId; viewId; patch: ViewPatch } → { version }
agentSession.view.close          { sessionId; viewId } → { ok: true }
agentSession.view.get            { sessionId; viewId } → { spec; version; closed }
```

- `queuedMessageMove` reorders through `src/main/native-chat/agent-session-journal/queued-message-positions.ts`. It sits beside the other queue methods in `src/main/runtime/rpc/methods/structured-agent-session-queued-methods.ts`.
- `fork` creates a new session record with the same agent, workspace and options, copies the conversation through the adapter's optional `copyConversation`, and writes a `fork` item as the new session's first item. Adapters without `copyConversation` return `unsupported`, and the header hides Fork for them.
- `turnDiff` reads `git diff <fromTree> <toTree> -- <path>` for `source: 'git-tree'`, capped at 512 KiB.
- `view.*` resolve the caller's session from `QUIRKY_AGENT_SESSION_ID` through `src/main/runtime/rpc/orchestration-session-caller.ts`, which already refuses a claim across a host boundary.
- Error behavior of `view.*`, all as RPC errors with a code the CLI prints:
  - `invalid-spec` (with the `validateViewSpec` errors) on `open`, `update` and a `patch` whose result fails validation; nothing is written.
  - `not-found` for an unknown `viewId` on `update`, `patch`, `close` and `get`.
  - `closed` on `update` and `patch` of a closed view; `close` of a closed view succeeds; `get` of a closed view returns it with `closed: true`.
  - `session-refused` when the caller's session claim is refused (no id, other host, or session ended).
- Postconditions: `open` writes a new `visual` item at version 1; `update` and `patch` write a new revision of the same item with `version + 1`; `close` sets `closed: true`. `version` only increases.
- `queuedMessageMove`: `toIndex` is clamped to the queue length; a message already dispatching returns `sending`; a revision mismatch returns `stale` and moves nothing.
- `fork`: precondition is no running turn in the source session (`busy` otherwise); on `failed` no session record is left behind.
- `turnDiff`: `gone` when the turn has no `turn-changes` item or the trees are no longer in the object store.

### View spec

Back-link: [Subagents and visuals](logic.md#subagents-and-visuals).

`ViewSpec`, `ViewPatch` and the limits live in `src/shared/view-spec/view-spec-types.ts` (new); `validateViewSpec` and `applyViewPatch(spec, patch): ViewSpec` in `src/shared/view-spec/view-spec-validation.ts` (new). Port them from v1's `plugins/quirky.view/src/core/catalog.ts`, `plugins/quirky.view/src/core/views.ts` and `plugins/quirky.view/cli-spec.ts`. Kinds: `diagram` (Mermaid), `image` (worktree-relative path), `html` (≤ 128 KiB), `live-preview` (localhost URL), `timeline`, charts, tables, `markdown`, and controls. Limits: 500 nodes, 256 KiB. Both the CLI and the host validate with the same function: `validateViewSpec(input: unknown): { ok: true; spec: ViewSpec } | { ok: false; errors: string[] }`.

## Code references by area

### Engine producers

Back-link: [Changes card](logic.md#changes-card), [Plan mode](logic.md#plan-mode), [Restart, rewind and compact](logic.md#restart-rewind-and-compact).

**Turn snapshot.** Create `src/main/git/turn-tree-snapshot.ts`.

CONTRACT:

```
snapshotWorkspaceTree(cwd: string): Promise<{ tree: string } | { notGit: true } | { failed: string }>
listTreeChanges(cwd: string, from: string, to: string): Promise<TurnChangesFile[]>
```

`TurnChangesFile` is the `files[]` element of the `turn-changes` schema, exported from `src/shared/agent-session-journal-v1-items.ts`. `snapshotWorkspaceTree` never throws: a git failure is `{ failed }`, a directory outside any repo is `{ notGit: true }`.

- `snapshotWorkspaceTree` uses a temporary index (`GIT_INDEX_FILE` in a `mkdtemp` dir): `read-tree HEAD` when HEAD exists, then `add -A`, then `write-tree`. It never touches the real index, HEAD or refs, and it works on a detached checkout or before the first commit. This is v1's `packages/git/src/diffs.ts:394-414`.
- `listTreeChanges` runs `git diff --raw --numstat -z -M <from> <to> --`.
- Run git through the existing runner in `src/main/git/runner.ts`.
- Hooks: take "before" on the `decideTurnOpen` commit path and "after" on `decideTurnEnd` and `decideSessionEnd`. Store the before tree in host memory keyed by `turnId`. A turn whose before snapshot is missing, for example across a restart, writes no `turn-changes`.
- The workspace path comes from `resolveAgentSessionLaunchDirectory` (`src/main/runtime/agent-session-launch-directory.ts`). `record.location.workspaceKind === 'folder'` plus `notGit` means use `source: 'edit-tools'`: collect the paths of completed `tool-call` items in the turn whose tool is a file edit (Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, Codex `diff` items and `apply_patch`, the ACP and pi edit tools), plus `diff` item paths.
- Snapshots run on the host that runs the agent, so remote workspaces work unchanged.

**Test results.** Derive on `tool-call` completion, host side, because the client sees only a 16 KiB head of the output (`src/main/native-chat/agent-session-wire/agent-session-item-wire-form.ts`). Port v1's `TEST_COMMAND` regex, `parseTestCounts` and `tailOf` from `plugins/quirky.structured/items.ts:19-66` into `src/main/native-chat/agent-session-timeline/test-result-derivation.ts`. Apply them to shell tools: Claude `Bash`, Codex shell commands (`codex-structured-item-translation.ts`), and the ACP and pi shell tools. Write `test-result` with the same `callId`.

**Plan versions.** Claude only. When the assembler writes an approval whose subject is `{ kind: 'plan' }` (`claudePermissionSubject` in `src/main/claude/claude-permission-presentation.ts:54`), it writes a `plan` item `status: 'waiting'` with the next version, `approvalItemId` set, `text` from the subject, and `unchanged` when the text equals the previous version's. On resolution it updates that plan item:

- allow means `approved`
- deny ("keep planning") means `revised`
- cancel means `not-answered`, with `reason: 'stopped'`
- turn end means `not-answered`, with `reason: 'stopped'`
- restart means `not-answered`, with `reason: 'restarted'`

The approval item stays, and it's still how the answer is sent (`agentSession.respondToApproval`). Clients that understand `plan` hide the matching approval card and answer from the plan panel.

**Mode markers.** Write a `mode` item when `agentSession.setOption` changes `permissionMode` (`structured-agent-session-prompt-response.ts`), when Claude enters plan mode, and when an approved plan leaves it. Skip a write when the mode equals the last one written.

**Fork.** See [RPC additions](#rpc-additions).

**Queue reorder.** See [RPC additions](#rpc-additions).

**Thread goal removal.** Delete the `threadGoal` capability, the `agentSession.threadGoal` method (`structured-agent-session-thread-goal.ts`), the adapter `changeThreadGoal` paths (`src/main/claude/claude-thread-goal.ts`, `src/main/codex/codex-structured-thread-goal.ts`, `codex-goal-journal-rows.ts`, `codex-structured-journal-goals.ts`), and `journal-thread-goal-source.ts`. Keep the `threadGoal?` field readable on `status` bodies (`src/shared/agent-session-journal-thread-goal-schema.ts`), because old journals carry it. The projection ignores it.

### quirky view

Back-link: [Subagents and visuals](logic.md#subagents-and-visuals).

- CLI: add `view` to `src/cli/specs/` (new `view.ts`, aggregated in `src/cli/specs/index.ts`), with handlers in `src/cli/handlers/view.ts` and a `HandlerGroup` in `src/cli/handler-group-manifest.ts`. Subcommands: `open`, `update`, `patch`, `get`, `close`, from v1's `plugins/quirky.view/cli.ts`. `--spec @file` reads JSON, `--html <file>` wraps a file as an `html` spec, and `--mermaid <file>` wraps a diagram.
- The CLI validates with `validateViewSpec`, reads `QUIRKY_AGENT_SESSION_ID` via `readInjectedAgentSessionId` (`src/shared/agent-session-caller-env.ts:13`), and calls `agentSession.view.*` through `RuntimeClient` (`src/cli/runtime/client.ts`). It must not import `src/main/runtime/**`, which isn't in the CLI graph.
- Without a session id it exits non-zero with "quirky view runs inside a Quirky chat".
- Host methods go in `src/main/runtime/rpc/methods/structured-agent-session-view.ts`. They write the `visual` item through the assembler's item path, as a `status` or `message` item is written outside a provider event.
- The existing `::quirky-visual{file=…}` directive and `agentSession.readVisual` stay as they are. They're a separate, older path.

### Renderer view

Back-link: [Behavior and scenarios](logic.md#behavior-and-scenarios), [Screens](logic.md#screens).

`src/renderer/src/components/chat/`:

- `markdown/`: a port of v1's `packages/ui/src/markdown/` (21 files, about 2.4k lines). Its entry is `ChatMarkdown` (v1 `QuirkyMarkdown`). File and link clicks go to the existing editor-open and external-open actions, which today are used by `NativeChatMarkdown`.
- `chat-turns.ts`: the projection. CONTRACT: `projectChatTurns(items: AgentJournalRenderItem[], opts: { sessionAgent: string }): ChatTurn[]`. Port the grouping from v1's `chat/turns.ts` (`groupChatTurns`, `toBlocks`, `foldMarkers`, `FOLD_AT = 4`). It maps Orca kinds:
  - `message` with role user opens a turn
  - assistant `message` text blocks become prose
  - `tool-call` items become activity, merged by `callId`
  - `diff` becomes a file change
  - `subagent` blocks become agents
  - `background-task` blocks go to the background tasks panel
  - `approval` and `question` become inline asks, except plan approvals answered from the panel
  - `turn` becomes the turn end
  - the six new kinds become their cards and markers

  A `turn` whose `agentTurnVerdict(turn)` (`src/shared/agent-turn-outcome.ts`) is `'interruption'` renders the interrupted row. It must be pure, with no React, so it is unit-testable.

  SCHEMA (exported from `chat/chat-turns.ts`):

  ```
  ChatTurn  { key: string; at: number; user: AgentJournalRenderItem | null; blocks: ChatBlock[];
              end: { state: 'done'|'stopped'|'failed'|'interrupted'; durationMs?: number } | null }
  ChatBlock = { type: 'prose'; itemId; text; streaming: boolean }
            | { type: 'activity'; calls: AgentJournalRenderItem[] }
            | { type: 'file-change'; item } | { type: 'test-result'; item } | { type: 'ask'; item }
            | { type: 'changes'; item } | { type: 'plan'; item } | { type: 'visual'; item }
            | { type: 'agents'; agentIds: string[] } | { type: 'mode'; item } | { type: 'fork'; item }
            | { type: 'status'; item } | { type: 'error'; item }
  ```

- `ChatView.tsx`: the root, mounted for `mode="structured"`. It wraps `useStructuredAgentSession`, renders the header, the turn list, the plan and visual panels, the agent dock, the queue and the composer, and re-hosts find (`use-native-chat-find.ts`, `use-native-chat-find-matches.ts`, `NativeChatFindBar.tsx`), rewind (`use-native-chat-rewind.ts`, `NativeChatRewindAction.tsx`), and the background tasks panel (`NativeChatBackgroundTasksStatus.tsx`). Move these files into `chat/` and rename them, rather than re-implementing them.
- Components ported from v1 `plugins/quirky.session/src/window/chat/`:
  - turn rendering: `Turn`, `Prose`, `Activity`, `ErrorRow`, `elapsed`
  - cards: `cards/Card`, `FileChange`, `TestResults`, `Steps`, `AgentsCard`
  - a Changes card, ported from v1 `plugins/quirky.git/src/view/TurnChanges.tsx`, with expandable diffs via `agentSession.turnDiff`
  - plan: `PlanChip`, `PlanPanel`, `plan.ts`
  - visual: `VisualChip`, `VisualPanel`, and view rendering from v1 `plugins/quirky.view/src/render/` (`ViewCard`, `visuals`, `HtmlFrame`, `LivePreview`)
  - agents: `AgentDock`, `agents.ts` (`deriveAgents`, `dockSummary`)
  - header: `ChatHeader`
- Composer, `chat/composer/`: port v1's `Composer.tsx`, `editor/*` (CodeMirror: keymap, markdown, pills, theme, transfer, triggers), `SuggestionList`, `Mentions`, `ImageChip`, `QueuedList`, `SettingsChip` and `controls.tsx`, plus `composerDraft.ts` on top of the existing draft store (`native-chat-composer-draft-store.ts`, moved into `chat/composer/`). Attachments, paste and drag and drop reuse `use-native-chat-composer-attachments.ts`, `use-native-chat-file-drops.ts`, `native-chat-attachment-upload.ts` and `NativeChatPaneFileDropSurface.tsx`, moved into `chat/composer/`. IME uses `useImeEnterGestureOwnership` (`@/lib/ime-composition-keyboard-event`) on the CodeMirror content element, and Enter never sends while composing.
  - Composer props CONTRACT: `{ mode: 'chat' | 'terminal'; onSubmit(text, attachments): void; queue?: QueuedController; settings?: OptionSurface; draftScopeKey: string }`. `mode: 'terminal'` hides queue, settings and plan controls and sends through `sendNativeChatMessage` (`native-chat-runtime-send.ts:88`), keeping its PTY queue and quarantine checks.
- Changes card line comments: the owner picked the Changes card "with line comments". A comment on a diff line is kept per session and turn in the draft store; the card's "Send N comments to agent" action composes one message of `path:line` plus comment per note and sends it through the controller's `send`. Port the UI from v1 `plugins/quirky.git/src/view/TurnChanges.tsx` and `src/notes/` (`DiffPane` notes binding, `SendMenu`), dropping v1's worktree-notes storage.
- Plan mode is offered only when the session's `AgentSessionCapabilities` (`src/shared/agent-session-capabilities.ts`) has a new `planMode: true` flag, set in `claude-structured-agent-definition.ts` only ([SC-6](logic.md#plan-mode)).
- Resume of chats from before the switch ([SC-19](logic.md#existing-chats)) needs no new code: their journals load through the kept hooks and the existing `agentSession.restartResume` path.
- Header cache timer: Claude only. Shown when the latest `turn`'s `contextUsage` has `cacheReadInputTokens + cacheCreationInputTokens > 0`. It counts down from `completedAt + 300 s` and hides at zero. Other agents show no timer.
- Styling: STYLEGUIDE tokens and `src/renderer/src/components/ui/` primitives only. v1's `--ui-*` variables map to this app's tokens. Text 14px for reading, 12px for labels, radius 10px.

### Mount, menus and deletion

Back-link: [In scope and out of scope](logic.md#in-scope-and-out-of-scope).

- `src/renderer/src/components/native-chat/NativeChatView.tsx:16`: the structured branch renders `chat/ChatView`. The bridge branch and the `NativeChatBridgeView` component (defined in `NativeChatView.tsx`, props in `native-chat-view-types.ts`) are removed, `TerminalPaneNativeChatPortal.tsx` is deleted, and `use-terminal-pane-chat-state.ts` no longer offers chat view mode for terminal tabs.
- Tab menu (`tab-bar/SortableTabContextMenu.tsx:193-200`, `terminal-pane/TerminalContextMenu.tsx:256-270`, `TerminalPaneResumeInChatButton.tsx`): "Continue in Chat UI" on an agent terminal opens a structured chat that resumes the same conversation, through the existing `runCliChatResume`. "Continue with Terminal Agent" on a chat tab uses `NativeChatCliForkMenuItems.tsx`. The bridge `toggleViewMode` path is removed.
- New chat (`tab-bar/QuickLaunchButton.tsx`, `use-new-tab-agent-menu-rows.ts`, `src/renderer/src/lib/new-tab-agent-menu-rows.ts`): list chat rows for every agent with a structured definition. A row whose agent isn't detected becomes a `chat-unavailable` row with the install hint. An agent with no structured definition gets no chat row.
- Terminal dock (`terminal-pane/fork-terminal-dock/TerminalDockComposer.tsx`): render `chat/composer` with `mode: 'terminal'`.

Delete:

- Renderer `native-chat/` files that nothing imports once `ChatView` is mounted. This includes `fork-agent-composer/`, `fork-native-chat-relay/`, the bridge files, `NativeChatComposer*`, the message list and row components, the thread-goal files, and `NativeChatMessageRail.tsx`. Keep the `use-structured-agent-session*` hooks, the `structured-*` data files, and every module imported from outside `native-chat/` (listed below).
- Delete tests of deleted modules in the same task.

Importers outside `native-chat/` that must keep resolving, each repointed or kept:

- `app-shell/AppBackgroundServices.tsx`
- `WorkspacePaneOverlayLayers.tsx`
- `settings/AppearanceChatSection.tsx`
- `settings/ChatPermissionSetting.tsx`
- `tab-bar/cli-chat-resume-feedback.ts`
- `tab-bar/tab-agent-types-by-tab-id.ts`
- `tab-bar/tab-bar-item-surface.tsx`
- `terminal-pane/TerminalContextMenu.tsx`
- `terminal-pane/TerminalPaneOverlayLayer.tsx`
- `terminal-pane/TerminalPaneRuntimePortals.tsx`
- `terminal-pane/native-chat-covered-pane.ts`
- `terminal-pane/use-covered-terminal-focus-handoff.ts`
- `terminal-pane/use-terminal-pane-chat-state.ts`
- `terminal-pane/use-terminal-pane-projection.ts`
- `fork-terminal-dock/*`
- `i18n/fork-localization-catalogs.ts`
- `runtime/sync-runtime-graph/mobile-session-*.ts`
- `tests/tools/omp-transcript-rendered/fixture.tsx`

### Phone

Back-link: [Phone and mixed versions](logic.md#phone-and-mixed-versions).

- `src/shared/structured-agent-session-projection.ts` `itemBlocks`: project the six kinds to system text blocks:
  - `plan`: "Plan v<N>: <status>", plus the plan text
  - `turn-changes`: "<N> files changed", plus the file names
  - `visual`: "Visual: <title>. Open on desktop."
  - `mode`: "Switched to <mode>"
  - `fork`: "Forked from <title>"
  - `test-result`: "<passed> passed, <failed> failed"

  The desktop `ChatView` doesn't use this path for them.

- `mobile/src/transport/mobile-runtime-client-capabilities.ts`: declare `AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY`.
- Old phone apps are covered by the RPC-boundary projection, with no mobile change.

## DO-NOT-CHANGE fences

- **`src/shared/agent-session-journal-open-union.ts` and the open-union rule in `agent-session-journal-schemas.ts`.** Older hosts open journals with the new kinds only because unknown item kinds are admitted.
- **`src/shared/agent-session-journal-body-admission.ts`.** It decides when a chat is a "newer Quirky's chat". Changing it can lock users out of their history.
- **Journal row schema version (`AGENT_SESSION_JOURNAL_SCHEMA_VERSION`, `journalRowSchemaVersion`).** The new kinds don't need a bump, and a bump makes older hosts refuse every new journal.
- **`src/main/native-chat/transcript-line-decoders*.ts`, `transcript-*` readers, and `src/main/ipc/native-chat.ts` / `src/main/runtime/rpc/methods/native-chat.ts`.** These are imported by legacy history import (`src/main/native-chat/agent-session-journal/journal-legacy-import.ts:33`), `src/main/native-chat/agent-session-journal/journal-pi-active-branch.ts:6`, ai-vault, orchestration worker transcript reads and Claude rewind, and `nativeChat.*` serves shipped phone apps.
- **`agentSession.*` existing params and results.** Mixed versions must keep working. Add fields and methods; never rename or remove one.
- **`src/main/runtime/rpc/methods/structured-agent-session-turn-item-capability.ts`.** It's a separate downgrade with its own lifetime.
- **`mobile/rpc-foundation/goldens/**`.** Re-record goldens with `pnpm --dir mobile run rpc:record`, never by hand.

## Always / Ask / Never

**Always:**

- Add every new kind to the shared projection, the desktop projection, and the capability downgrade together.
- Run git for snapshots on the agent's host, through `src/main/git/runner.ts`.
- Keep `chat/` free of `@/components/native-chat/` imports, except the kept hooks and data files.
- Use STYLEGUIDE tokens and `components/ui` primitives.
- Run checks per AGENTS.md: scoped `pnpm typecheck:node|web|cli`, one at a time, and tests through `pnpm test:sandbox`.

**Ask (Tier 2):**

- Any change that would bump `RUNTIME_PROTOCOL_VERSION` or the journal row version.
- Removing a renderer module that a non-renderer caller still needs.

**Never:**

- Paste v1 code that calls `UiPluginContext`, `context.call` or `@quirky/ui`.
- Write to the user's real git index or refs.
- Run the full test suite or `pnpm typecheck` locally.
- Add Windows or Linux branches.

## Cross-cutting

Back-link: [Key decisions and why](logic.md#key-decisions-and-why).

- **Security.** HTML visuals render in v1's sandbox: `iframe sandbox="allow-scripts"`, `referrerPolicy="no-referrer"`, `srcDoc` with the `FRAME_CSP` meta first (`default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`). This is v1's `plugins/quirky.view/src/render/HtmlFrame.tsx`. Mermaid goes through v1's `mermaid-safety.ts` guard. Markdown sanitizes with `rehype-sanitize`/DOMPurify as v1 did. `image` paths resolve inside the workspace only.
- **Migration.** None. Old journals have no new kinds, and their turns show no Changes card ([SC-9](logic.md#changes-card)).
- **Rollback.** Reverting the merge restores the old view. Journals written by the new build still open on the old build, because the new item kinds are ignored there.
- **Observability.** Log snapshot failures (`failed`) once per turn at warn level, with the session id. Never log file contents.

## Testing strategy

Back-link: [Behavior and scenarios](logic.md#behavior-and-scenarios), [Screens](logic.md#screens).

Tests run through `pnpm test:sandbox --shards=1 -- <files>`. Keep tests to behavior that would break unnoticed (see `docs/reference/test-antipatterns.md`).

- `src/shared/agent-session-journal-v1-items.test.ts`: each kind parses; the closed-set snapshot in `journal-closed-sets.test.ts` is updated.
- `src/main/runtime/rpc/methods/structured-agent-session-v1-items-capability.test.ts`: a client without the capability gets status rows, a client with it gets canonical bodies, and in-process callers get canonical bodies ([SC-18](logic.md#phone-and-mixed-versions)).
- `src/main/git/turn-tree-snapshot.test.ts`, on a temp repo: branch, detached HEAD, no commits yet, non-git dir; the real index unchanged ([SC-7](logic.md#changes-card), [SC-8](logic.md#changes-card)).
- `test-result-derivation.test.ts`: pytest, vitest, jest, go and cargo summaries; a non-test command yields nothing.
- Plan version lifecycle, in the assembler's tests: waiting, revised, approved, and not-answered on stop ([SC-5](logic.md#plan-mode)).
- `queuedMessageMove`: reorder and stale revision.
- `src/renderer/src/components/chat/chat-turns.test.ts`: the [SC-2](logic.md#a-normal-turn) turn shape, call merge by `callId`, plan approval hidden when a `plan` item exists, interrupted row ([SC-12](logic.md#restart-rewind-and-compact)).
- Composer: IME composition never sends on Enter. This closes TEST-5 from the logic spec's reliability checks.
- Terminal-dock composer sends respect the input quarantine on every PTY-swap path (BUG-1), and refocus returns to the docked composer (DEFER-1).
- `src/cli/handlers/view.test.ts`: refuses without a session id, and validates the spec before calling.
- Mobile: `mobile/src/session/MobileNativeChatView.rows.test.ts` gains rows for the six kinds.
- Screens: one CDP screenshot per mock state in [Screens](logic.md#screens), taken with the `$electron` skill against a hidden window (`QUIRKY_BACKGROUND_LAUNCH=1`), compared by eye against `mock/mock.html`.

## Non-goals

- Mobile chat redesign beyond the six rows.
- v1's `steps` card for Codex plans. Codex plan documents keep rendering as today's `plan-document` status notice.
- A cache timer for agents other than Claude.
- Retiring `::quirky-visual` and `agentSession.readVisual`.

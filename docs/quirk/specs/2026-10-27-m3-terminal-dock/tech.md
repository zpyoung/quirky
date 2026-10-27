# Terminal dock technical specification

Status: Codex combined review completed; confirmed findings amended and autonomous approval recorded in item D17/D18. Complexity gate: public protocol, daemon, terminal host and new plugins cross subsystem boundaries; LOOP.md requires both specs.

Behavior source: [logic.md](logic.md). Repository-root anchors below are relative to `/Users/zpyoung/orca/workspaces/quirky/build-lane-9/`; component worktrees use the identical relative paths.

## Architecture

Implements [conceptual model](logic.md#conceptual-model), [data flow](logic.md#data-flow) and [key decisions](logic.md#key-decisions--rationale).

Create built-in `plugins/quirky.terminal-dock/` with `main.ts`, `cli.ts`, `package.json`, `quirky-plugin.json`, `src/types.ts`, `src/service.ts`, `src/store.ts`, `src/send.ts`, `src/providers/`, `src/pickers.ts`, `src/attachments.ts`, `src/window/` and `src/ui.tsx`. Only public `@quirky/protocol` types and PluginContext/UiPluginContext methods cross plugin boundaries. No import from another plugin's source.

The terminal plugin embeds `view:quirky.terminal-dock/composer` in its own pane, analogously to StructuredHost. It owns available pixel geometry and xterm fits; dock code owns editing and feature policy. The daemon dock plugin owns canonical records and queues. Extend the public PluginPty API with an additive acknowledged write, keeping existing void writes unchanged.

## Code references

Implements [scriptable actions](logic.md#sc-23-scriptable-actions-and-inspectable-state) and [send protocol](logic.md#sc-18-serialized-prompt-protocol).

Existing anchors:

- `packages/protocol/src/plugins.ts` PluginContext at lines 49-80 and PluginPty at 83-131; add `writeAccepted` beside `write`.
- `packages/protocol/src/pty.ts` PtyRequest/PtyResults: add a control-request acknowledged write alongside existing request/result definitions.
- `packages/daemon/src/plugins/pty-api.ts` createPtyApi, write at 118-124: new request-based method fans out onInput once after success.
- `packages/daemon/src/pty-client.ts` request at 118-142; sendData at 195-206 stays one-way.
- `packages/pty-host/src/server.ts` dispatch at 172-214; `packages/pty-host/src/session.ts` SessionManager.write at 190-193 and process-write callback at 544-555; `packages/pty-host/src/barrier.ts` ShellReadyBarrier input/drain. A receipt must wait through the ready barrier and reject dropped or partial writes.
- `packages/daemon/test/fixtures/fake-pty-host.ts` new request support must preserve legacy input behavior; `packages/daemon/test/pty-api-subscriptions.test.ts` has the fanout fixture.
- `plugins/quirky.terminal/src/window/workspace/PaneLayer.tsx` StructuredHost at 70-88, pane rendering at 293-340; new terminal-owned DockHost wraps the terminal and contributed composer.
- `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx` TerminalPaneProps/TerminalPaneHandle and resize lifecycle; add a documented terminal-host focus suppression/available-height contract where necessary, without moving xterm state into dock code.
- `plugins/quirky.terminal/src/window/workspace/controller.ts` WorkspaceController, refocus, pane menu and report. Prevent background reconciliation from stealing composer focus; add a generic optional dock state report in the terminal view.
- `plugins/quirky.terminal/src/layout/service.ts` public `workspace` and `paneOf`; `paneOf({pane})` returns workspace/tab/pane IDs. Resolve a pane binding by public methods, not by a private tree import.
- `packages/protocol/src/ui.ts` UiPluginContext.mountView at 238-242 and command routing provide the only cross-plugin window integration.
- `packages/protocol/src/model.ts` Session at 193-222 supplies agent, providerSession, cwd and status. `plugins/quirky.agent-status/src/capture.ts` documents provider metadata; status public APIs expose richer row details. The new bridge must consume public calls/events, not import those files.
- `plugins/quirky.notifications/main.ts`, `plugins/quirky.notifications/cli.ts`, `plugins/quirky.notifications/package.json` exemplify startup service registration, CLI output and React dependencies. `plugins/quirky.terminal/test/e2e/support.ts` and `plugins/quirky.terminal/test/e2e-ui/features-support.ts` exemplify isolated real-process and headless window harnesses. `packages/ui/test/fixtures/headless-window.ts` is the window harness.
- `package.json` commands: build, test (remote suite), typecheck. `packages/ui/build.ts` discovers each new plugin's src/ui.tsx and builds dist/ui.js; `apps/desktop/scripts/bundle-plugins.ts` packages the declared built UI module.

## Contracts & interfaces

### Acknowledged terminal input

Implements [serialized send](logic.md#sc-18-serialized-prompt-protocol), [cancellation](logic.md#sc-21-stop-and-queued-cancellation).

CONTRACT: `PluginPty.writeAccepted(sessionId: string, data: string | Uint8Array): Promise<void>`.

Resolve only after all bytes are accepted by the live child PTY write boundary, including writes held by the shell-ready barrier. Reject disconnected, missing, exited, disposed, dropped, failed or partial writes. Errors carry public fields `code: 'PTY_WRITE_REJECTED'|'PTY_WRITE_UNCERTAIN'` and `acceptedBytes: number|null`: REJECTED means definitely zero bytes, UNCERTAIN means some bytes or an unknown count may have landed. Host failures preserve known partial counts; request timeout/connection loss after dispatch maps to UNCERTAIN/null; disconnected-before-dispatch, missing/exited session and dropped-before-delivery map to REJECTED/0. Do not resend partially accepted input. Success does not establish agent consumption. Existing void write, binary behavior and listeners remain unchanged; successful new writes fan out onInput once, rejected new writes do not. Declare the error shape beside PluginPty and preserve it across the host response and daemon adapter. Receipt callers stop later phases on either error and use certainty, not guesswork, for recovery warnings.

### Canonical dock service

Implements [lifecycle](logic.md#sc-01-enable-and-auto-open), [persistence](logic.md#sc-22-reconnect-restart-and-revision-conflicts), [inspection](logic.md#sc-23-scriptable-actions-and-inspectable-state).

Register startup plugin with dependencies `quirky.terminal`, `quirky.session`, `quirky.agents`, `quirky.agent-status`; CLI alias `dock`; stable view `view:quirky.terminal-dock/composer`; settings `enabled` (false) and `autoOpen` (true). A settings view may provide conditional indented Experimental controls if the generic settings renderer cannot express them. Contribute that view/command in this plugin, not hard-coded kernel settings.

The service resolves `{pane}` through terminal/paneOf then terminal/workspace and the leaf session. An optional `{session}` selector resolves through paneOf. If both are given, they must agree. Reject shell, structured and unsupported recognized-agent identities for opening. Retain last recognized agent only while requested dock remains open; a transient loss is not confirmed exit. Settings and session/terminal events reconcile state through a serialized mutation path. Per-terminal send queues are distinct from the short record-mutation queue, so cancellation never waits behind the operation it cancels.

Public methods and request shapes (all object parameters, unknown keys refused by schemas):

SCHEMA:
- `get`: `{pane?: string, session?: string}`; exactly one selector unless both are matching binding hints from an embedded host. Returns DockState.
- `list`: `{}` -> `{panes: DockState[]}`.
- `set`: `{pane: string, revision?: number, docked?: boolean, gutterRows?: number, passthrough?: boolean, draft?: string, attachments?: string[]}` -> DockState. Every client replacement of draft or attachments, including empty text/arrays, requires the current revision; service-owned changes are serialized. A missing or stale revision refuses the replacement and returns current state in the conflict error. Preference-only changes may omit revision. Toggle with no explicit docked is a separate command that reads current state. Manual close sets userUndocked; explicit reopen clears it.
- `report`: `{pane: string, mounted: boolean, focused?: boolean, transport?: 'connected'|'connecting'|'reconnecting'|'disconnected'|'offline'}` -> DockState. Transient, not persisted; associate with calling window/connection and release on disconnect. Multiple windows do not let one unmount clear another's mounted pin. Passthrough is meaningful only for the active mounted host.
- `history`: `{pane: string, direction?: 'previous'|'next'}` -> `{entries: string[], state: DockState}`. With direction, update the draft using per-pane browse cursor, preserving the pre-browse draft.
- `pick`: `{pane: string, kind: 'slash'|'file', query?: string}` -> `{items: PickerItem[], truncated: boolean}`.
- `attach`: `{pane: string, path?: string, name?: string, mime?: string, base64?: string}` -> DockState; either an actual path or uploaded name/base64, never both.
- `removeAttachment`: `{pane: string, attachment: string}` -> DockState.
- `send`: `{pane: string, id?: string, revision?: number, text?: string}` -> SendResult. Clients may supply a unique operation ID before awaiting the response; duplicate IDs are refused, never interpreted as a resend. UI/CLI generate one and CLI also exposes `--id`. Without one, the daemon generates and publishes an ID through queuedSends before execution. If text is omitted, atomically snapshot canonical draft/attachment IDs and require the current revision. Explicit text sends never erase a newer draft. The final response settles after completion/cancellation, while queued IDs remain inspectable for selective cancellation.
- `cancel`: `{pane: string, send?: string, interrupt?: boolean}` -> DockState. Cancels one identified operation; without ID current plus pending pane sends are cancelled. `interrupt` requests the documented stop/raw Escape path.
- `interaction`: `{pane: string, request: string, action: 'answer'|'collapse'|'expand'|'dismiss', answers?: string[][]}` -> DockState. IDs and answer values revalidate against the current pending provider request before any write.
- `options`: `{pane: string, kind?: 'model'|'effort'|'permission', value?: string}` -> DockState. Read with neither kind/value; mutation requires both and uses the same per-terminal queue.
- `driver`: `{pane: string, owner?: string, ttlMs?: number}` -> DockState. Explicit foreign driver lease with bounded expiry, release via missing owner; never set by local passthrough.

Every method is schema-declared with a matching CLI command under `quirky dock` (generic JSON flags for nested answers acceptable). Use established CLI output/error conventions. Window commands `toggle`, `passthrough`, `focus`, `resize`, `draft`, `send`, `cancel`, `history`, `interaction`, `options` carry a pane argument or resolve the active terminal pane through the terminal view report. Commands are real daemon-routed UI contributions, not unregistered DOM shortcuts. Missing view/window is explicit. Commands for actions already exposed as methods delegate to those methods, not duplicate policy. Add default Mod+Shift+K and Mod+Shift+P bindings with a pane context that includes both terminal and dock focus; capture handling in the terminal host must avoid double dispatch.

Palette cutover for reviewed shortcut conflict F1: complete the contribution-migration transition explicitly anticipated by m0-ui-api D30, preserving m0-core D24's shell renderer. Add public `UiPluginContext.setPalette(open?: boolean): void` (omitted means toggle) backed by new schema-declared `ui.palette.set({open?: boolean})` and daemon-owned optional `UiLayout.palette?: boolean` (absent means closed). Its mutation is atomic and broadcasts through existing layout events; ui.state reports it. Create built-in `quirky.palette` with `command:quirky.palette/toggle` and unconditional Mod+Shift+P binding; its handler uses the same public capability available to third parties. The shell App reads layout.palette and closes through the same method; no private renderer import enters the plugin. Remove the hard-coded palette interception, RESERVED_CHORDS export and obsolete shadowing/warning branches/tests across protocol, daemon UI model/distros, CLI inspection and window host. No hidden fallback remains after disabling/replacing the contribution. Normal host precedence chooses the dock's matching conditional binding before the unconditional palette binding, from terminal and composer focus; elsewhere only palette runs. Terminal-first conditions explicitly mention terminalFocus as required by current host policy. This is a cutover to overridable contribution semantics, not a reserved-chord bypass.

Existing palette anchors: `packages/ui/src/App.tsx` palette local state at 36-55; `packages/ui/src/components/useShortcuts.ts` hard-coded interception at 15-26; `packages/ui/src/plugins/host.ts` handleKey at 287-305; `packages/daemon/src/plugins/ui-model.ts` reserved resolution at 170-197; `packages/protocol/src/ui.ts` RESERVED_CHORDS at 254-255. New daemon method integrates in `packages/daemon/src/plugins/layout.ts`, method registry/schema and public RPC types. All existing UI context doubles add setPalette consistently; remove incidental wording/default tests instead of re-pinning them. New `plugins/quirky.palette/test/palette.test.ts` and `packages/ui/test/palette-contribution.test.ts` exercise daemon API/routed command, conditional chord precedence, disabled/overridden binding, close and nonterminal focus.


### Shared dock types

Implements [data flow](logic.md#data-flow) and [inspection](logic.md#sc-23-scriptable-actions-and-inspectable-state). Create these public-to-this-plugin types in `src/types.ts`. The UI and backend import the same types; terminal host uses the declared serialized shape without private imports.

SCHEMA:
- `DockAttachment`: `{id: string, name: string, path: string, mime: string, image: boolean}`.
- `DockQuestion`: `{id: string, kind: 'question'|'permission', title: string, questions: {prompt: string, choices: {label: string, value: string}[], multiple: boolean}[], collapsed: boolean, dismissed: boolean}`.
- `DockOptions`: `{model: string|null, effort: string|null, permission: string|null, choices: {model: string[], effort: string[], permission: string[]}, context: {used: number, limit: number}|null, notice: string|null}`. Unknown stays null, never inferred from a selection sent without evidence.
- `DockState`: `{pane: string, session: string, tab: string, revision: number, enabled: boolean, supported: boolean, agent: string|null, docked: boolean, userUndocked: boolean, gutterRows: number, mounted: boolean, passthrough: boolean, draft: string, attachments: DockAttachment[], disabledReason: string|null, activeSend: {id: string, phase: string}|null, queuedSends: {id: string, phase: string}[], question: DockQuestion|null, options: DockOptions, notice: string|null}`. Optional extra report fields may be added, but core fields keep these names/types. queuedSends includes operations waiting behind activeSend and is published before their execution begins.
- `PickerItem`: `{id: string, label: string, insert: string, kind: 'command'|'skill'|'file', detail?: string}`.
- `SendResult`: `{id: string, outcome: 'observed-cleared'|'unobservable'|'may-not-have-sent'|'refused'|'cancelled', accepted: boolean, reason?: string}`. `accepted` says whether any prompt body bytes may have been written, not agent consumption.

### Provider, picker and attachment module seams

Implements [SC-10](logic.md#sc-10-slash-commands-and-skills), [SC-11](logic.md#sc-11-file-mentions), [SC-12](logic.md#sc-12-attach-paste-drop-and-remove), [SC-14..16](logic.md#sc-14-session-option-controls-and-context-usage), [SC-19](logic.md#sc-19-delivery-evidence-and-codex-false-warning-defect).

CONTRACT:
- `createProviderBridge(context: PluginContext): ProviderBridge` from `src/providers/index.ts`.
- `ProviderBridge.read(session: Session): Promise<{question: DockQuestion|null, options: DockOptions, prompts: string[]}>`.
- `ProviderBridge.answer(session: Session, question: DockQuestion, answers: string[][], signal: AbortSignal): Promise<{confirmed: boolean, notice: string}>`.
- `ProviderBridge.setOption(session: Session, kind: 'model'|'effort'|'permission', value: string, signal: AbortSignal): Promise<{confirmed: boolean, notice: string}>`.
- `ProviderBridge.observed(session: Session, text: string, since: number): Promise<boolean>` — only positive evidence tied to this prompt/turn; a generic later status timestamp or arbitrary nonempty output is insufficient.
- `ProviderBridge.dispose(): void` releases watchers/timers, if any.
- `pickItems(context: PluginContext, session: Session, kind: 'slash'|'file', query: string): Promise<{items: PickerItem[], truncated: boolean}>` from `src/pickers.ts`.
- `acquireAttachment(context: PluginContext, input: {path?: string, name?: string, mime?: string, base64?: string}): Promise<DockAttachment>` from `src/attachments.ts`.

Adapters use only public APIs and read-only provider files. Validate transcript paths as regular readable files, bound incremental reads, retain stable request identity, and invalidate resolved/replaced requests. Actual sources are specified below; no new undefined interaction transport is required. A status heuristic alone cannot create answerable choices. Never route provider questions through quirky.ask/create. Answers use evidenced selector/free-text protocols, pace sequential steps, revalidate live request before writes, serialize with normal sends and stop on AbortSignal. Permission choices use the actual provider accept/deny protocol, never an arbitrary answer string.
 
Provider source contract: read the existing public `quirky.agent-status/get({session})` result as the following consumed projection (other fields ignored): `{sessionId: string, agent: string, state: 'working'|'waiting'|'blocked'|'done', question?: string, toolName?: string, toolInput?: string, heldPermission?: {toolUseId: string|null, toolName: string, input: string, childId: string|null}, lead: {providerSession: string|null, ended: boolean}, stateStartedAt: number, evidenceAt: number, turnStartedAt: number|null, source: string, restoredUnconfirmed?: boolean, model?: string, prompt: string}` or null. `question` is actual JSON from the normalized hook, not detail text. Only a live non-restored waiting/blocked row with the real question/permission payload can authorize a hook card. Permission uses heldPermission when present, otherwise a permission-shaped question envelope; a generic waiting/toolName row cannot invent approval. A request ID is the actual tool/request ID in payload when present, namespaced by agent/provider session; otherwise hash the canonical payload with provider session, turnStartedAt and stateStartedAt. Re-read before answers. A resolved row/changed request/ended lead invalidates the old ID. Keep resolved local IDs to avoid an unresolved old transcript resurrecting a just-answered hook card.

Source selection per provider: Claude/OpenClaude prefer hook transcriptPath, otherwise resolve the session-ID-matched JSONL under the agent's Claude projects root; decode user/assistant message.content tool_use/tool_result and message.model/row effort. Codex resolves hook transcriptPath or ID-matched rollout JSONL under CODEX_HOME/sessions; decode response_item function_call and matching function_call_output plus event_msg and turn_context model/reasoning effort. Grok uses ID-matched chat_history.jsonl under its sessions root and backend_tool_call/tool_call/tool_result records. OMP uses hook session_file or ID-matched JSONL under its configured sessions root and type:message/message.role toolCall/toolResult blocks. OpenCode/OpenCode2 use read-only SQLite discovered under their configured XDG data/session database roots, matching provider session ID in v1 session/message/part or v2 session_v2/session_message; tool part state.input with no terminal output/error remains pending, completed/error parts resolve it. Zcode uses its persistent ~/.zcode/cli/db/db.sqlite OpenCode-v1 format, never its deleted transient hook transcript, and ignores semantics.transcriptVisibility:hidden messages. All families can prefer a newer actual hook question from the existing public get projection; transcript records retain call/result IDs so only the newest unresolved question is returned.

Read-only design anchors in `/Users/zpyoung/PycharmProjects/orca/`: `src/main/native-chat/session-file-resolver.ts`, `transcript-line-decoders-claude.ts`, `transcript-line-decoders-codex.ts`, `transcript-line-decoders-grok.ts`, `transcript-line-decoders-omp.ts`, `transcript-opencode-sqlite-query.ts`, `transcript-opencode2-sqlite.ts`, `transcript-opencode-database.ts`; `src/shared/native-chat-ask.ts` and `native-chat-agent-support.ts`; renderer `src/renderer/src/components/native-chat/use-native-chat-interactive-send.ts`. These are format/navigation evidence, not runtime dependencies. Claude/OpenClaude/Codex/OpenCode-family questions use their actual numbered/arrow/tab selector protocol with 1,000 ms between question groups; Grok/OMP use formatted question-label/answer text through normal terminal sending. Permission accepts `1` in Claude/OpenClaude/Codex/Grok/OMP and Enter in OpenCode/OpenCode2/Zcode, denies Escape; OpenCode interruption uses paced double Escape. Revalidate and inspect the real pending source; these keys cannot authorize a stale or nonexistent request.

Read actual provider formats, including upstream retained-session readers as design evidence if needed; do not import upstream code or depend on a second running app. Provider absence/no active question is valid; malformed/unreadable source produces explicit reason rather than a fabricated card. A real question must be supported for each transcript-supported agent family named in the feature doc. Session options are agent-specific, sourced from reported data and provider catalogs, with unsupported controls labelled. Claude session-only effort/model navigation must inspect the screen before any default-saving confirmation, use the documented `s` action, and refuse if not observable. Never send `/effort <value>` or persist globals.

Picker roots are agent-appropriate local skill/command directories and workspace files, plus declared applicable commands where their invocation genuinely maps to an agent command. Read only; cap results and traversal; prevent symlink escape and special-file blocking. Uploads use plugin data directory, generated unique basename and strict base64/size checks (10 MiB per attachment, 20 attachments per pane); supplied path must be an existing regular file. Preserve original display name but never use it as a filesystem path. Do not delete caller-owned files on chip removal.

### Send engine and record lifecycle

Implements [SC-17..22](logic.md#sc-17-send-availability-and-foreign-driver).

`src/send.ts` performs cancellable clear/body/delayed-Enter/observation; `src/service.ts` owns per-session serialization and atomic snapshot/recovery. Every awaited phase rechecks cancellation, feature enabled, live session and actual driver ownership. Feature-off stops scheduled writes; bytes accepted before cancellation remain possibly delivered. Do not hold the record lock across timed waits. Controls and answer operations share the same terminal queue. Queue cancellation settles waiters even if another operation is active. Explicit deadlines prevent an unreadable transcript or unresponsive provider lookup blocking all state methods.

Use the feature-doc exact clear constants, paste normalization, image settle, Enter delay and observation schedule. Replace all literal Escape bytes in user text before wrapping so a draft cannot break out of paste. Only positive matching evidence can override a recognizer miss. Recovery prepends the failed snapshot exactly once, preserving newer text and attachment IDs, and never retries automatically. History records accepted prompt attempts once and seeds from real prompt history; do not mark a mere rejected empty/pre-write request as sent.

Record migrations use PluginContext.openStore. Persist preferences, draft, attachment metadata, agent latch, history and recovery-only send snapshots. Each enqueue transaction durably records `{id, sequence, text, attachments, mayHaveWritten}` before clearing its draft; keep the recovery record until success or a transaction that restores its text exactly once. Do not persist runnable operations, timers, mounted connections or leases. After crash/restart, recover snapshots in original enqueue order ahead of newer draft, conservatively mark uncertain ones with check-terminal notice, then remove recovery records atomically; never replay input or old Enter. If disabled, defer recovery writes until enablement. Independently validate corrupt entries and reject prototype keys/invalid rows.

The 200,000-character budget covers current draft plus all queued/in-flight recoverable text plus two separator characters per restoration boundary. Enqueue/edit must check this combined budget and refuse an overflow with invalid-params and reason `recoverable-text-limit`, preserving prior state. Unsynchronized UI edits remain visible/copyable but cannot send until synchronized. The 20-attachment budget similarly covers current and queued/in-flight chips, so restoration never truncates either. History retains its independent feature-doc caps. Prune using current public terminal layout/session identity; moved pane IDs survive. No state/cleanup writes while disabled. Delete only unreferenced upload files under plugin storage, never caller-owned paths.

### Window composer and terminal host

Implements [SC-01..17](logic.md#sc-01-enable-and-auto-open) and [SC-23](logic.md#sc-23-scriptable-actions-and-inspectable-state).

Embedded composer input is `{pane: string, session: string}`. Host and composer subscribe to `quirky.terminal-dock/changed` carrying `{pane: string, state: DockState}`. Backend never emits prompt contents in logs; subscribed state is authenticated like every session API. The host calls get on mount and updates; state errors make the host unavailable, not an invented plain-shell dock.

Terminal `DockHost` owns row drag and available-height hysteresis, renders terminal above a separately mounted view and reports mounting/transport/focus. A focused pane may request composer focus through `command:quirky.terminal-dock/focus`; host must never query the composer plugin's private DOM. Composer registers its own pane-indexed focus handles. Terminal handle focus suppression while dock owns focus is an explicit prop/public-host behavior, not a global querySelector. Keep selection and paste ownership correct; an embedded input must not trigger terminal key dispatch. Controller refocus honors the dock owner without moving background focus. Unmount/disposal removes capture listeners and fit observers. Commands/settings/report state work even in floating workspace panes.

Composer uses current shared DockState and revision-aware mutations, reconciles acknowledgements without overwriting newer local keystrokes, flushes draft before send/history, and preserves a recoverable local draft if a request fails. IME composition Enter must never send. Picker navigation and Escape precedence, Up/Down history, file input/paste/drop, attachment chips, multiline emphasis overlay, send/stop controls, session controls/context ring and pending question cards implement logic scenarios. All errors are visible without raw unsafe HTML. No microphone/quarantine UI. Use existing theme variables and plugin styles in `packages/ui/src/styles.css`; new classes are dock-prefixed.

## DO-NOT-CHANGE fences

Implements [non-goals](logic.md#scope--non-goals).

- `docs/loop/LOOP.md`, `scripts/build-loop/`, `docs/loop/queue.json`, `docs/loop/DECISIONS.md`: protected loop machinery; only queue.ts operates shared state.
- All feature source files under `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/` and upstream Orca: read-only requirements/design evidence.
- Existing PluginPty.write and PTY_DATA wire semantics: existing fast terminal typing consumers must not start waiting on new control RPCs.
- Existing terminal workspace layout schema and pane ID generation: retain identity through rehomes; dock state is plugin-owned, not an incompatible pane-tree migration.
- User global agent settings, including real HOME and temporary HOME settings: no dock runtime control may persist defaults.

## Always / Ask / Never

Implements [locked decisions](logic.md#decisions-locked).

Always use public plugin API, actual acknowledged writes, daemon revisions and per-terminal serialized operations. Resolve unknowns from repository/source formats and record autonomous recommended decisions. Use fresh temporary HOME/QUIRKY_HOME for every process test; stop everything started. All workers skip build/lint/tests/formatters while peers mutate; orchestrator runs checks after the wave.

Ask no person in this unattended loop. A genuine locked feasibility conflict blocks the item through LOOP.md rather than inventing an exception. API gaps alone are not blockers.

Never import another plugin's internals, infer question choices, treat accepted input as confirmation, auto-resend uncertain input, write global defaults, add native chat/dictation/quarantine/telemetry, change protected loop files, push, or touch main.

## Cross-cutting

Implements [error preservation](logic.md#sc-20-failure-uncertainty-and-concurrent-typing) and [revision conflicts](logic.md#sc-22-reconnect-restart-and-revision-conflicts).

Authenticated local API keeps existing trust model. Treat filenames, transcripts, terminal output and skill contents as untrusted data; no shell command interpolation or HTML injection. Filesystem reads are bounded and exclude FIFOs/devices; upload names cannot choose paths; use source mtime/offset plus request IDs to reject stale question answers. Plugin disposal cancels timers and providers and removes subscriptions. Disabling the plugin leaves the terminal fully usable and removes its composer contribution. No separate telemetry subsystem.

## Testing strategy

Implements every [behavior scenario](logic.md#behavior--scenarios), not source-text/default/wiring tests.

Owned new tests:

- Kernel receipt: `packages/pty-host/test/write-accepted.test.ts`, `packages/daemon/test/pty-api-write-accepted.test.ts` — live/missing/exited/barrier/partial write and exactly-once accepted-input fanout.
- Backend new files: `plugins/quirky.terminal-dock/test/service.test.ts`, `plugins/quirky.terminal-dock/test/send.test.ts`, `plugins/quirky.terminal-dock/test/e2e.test.ts`, `plugins/quirky.terminal-dock/test/cli.test.ts` — public API and real isolated daemon/PTY flows, including stale empty clear, selective queued cancellation, zero/uncertain write failure, crash without renderer and combined-budget lossless recovery. CLI handler tests alone are not flow proof.
- Provider/picker/attachments new files: `plugins/quirky.terminal-dock/test/providers.test.ts`, `plugins/quirky.terminal-dock/test/pickers.test.ts`, `plugins/quirky.terminal-dock/test/attachments.test.ts` — actual provider-shaped fixtures and fake TUIs consuming input; pending/resolved/stale requests, session-only option success/safe refusal, traversal/path/upload limits and source-specific invocation.
- Composer: `plugins/quirky.terminal-dock/test/window.test.tsx` — headless UI for editor/IME/picker/history/chip/question/notice transitions against public calls; never assert stylesheet source.
- Host new files: `plugins/quirky.terminal/test/e2e-ui/dock.test.ts` and `plugins/quirky.terminal/test/window/dock-geometry.test.ts` — real host/controller with public API, split focus, conditional menu/shortcuts, mount hysteresis/rows/cleanup. Actual pixel fit is also exercised in the browser.

Acceptance commands are these exact owned files for component checks. Whole branch gate: `bun run test`, `bun test scripts`, `bun run typecheck`, `bun run build`. Full suite runs only through remote `bun run test`. Smoke: built daemon with fresh temporary home and fake supported TUIs that record received bytes, invoke dock methods via CLI/API, then using-apps-like-a-user web/unattended against daemonUrl for SC-01..17 and SC-19/20/23. Observe actual UI screenshots/report; stop daemon and delete temporary home. Native-only file dialog/focus behavior, if any, is handed to docs/loop/native format rather than claiming the web pass covered OS surfaces.

## Non-goals

See [logic scope](logic.md#scope--non-goals). No additional technical exclusions. Missing capability must be implemented through the public seam, not silently replaced by an unavailable placeholder.

## Review disposition

Combined Codex review over the original specs returned NEEDS_FIXES: seven substantive findings F1..F7 and 34 reference-resolution reports, one suppressed finding, no limitations/questions. F1 is addressed by the palette contribution cutover above; F2/F3/F4/F5/F6/F7 by revisioned clears, early-known queued IDs, concrete existing status/provider-source contracts, write-error certainty, recovery-only durable snapshots and combined recovery budgets. Reference reports for new artifacts, contribution IDs, package names and illustrative paths are not defects: the architecture explicitly creates those files, and scenario paths are examples. Review artifacts are outside the repository in `/tmp/quirky-dock-lane9.HXFO4d/spec-review/`.

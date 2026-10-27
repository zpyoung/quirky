# Terminal dock technical specification

Status: Draft for combined Codex review. Complexity gate: public protocol, daemon, terminal host and a new plugin cross subsystem boundaries; LOOP.md requires both specs.

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
- `plugins/quirky.notifications/main.ts`, `cli.ts`, `package.json` exemplify startup service registration, CLI output and React dependencies. `plugins/quirky.terminal/test/e2e/support.ts` and `test/e2e-ui/features-support.ts` exemplify isolated real-process and headless window harnesses. `packages/ui/test/fixtures/headless-window.ts` is the window harness.
- `package.json` commands: build, test (remote suite), typecheck. `apps/desktop/scripts/bundle-plugins.ts` discovers built-in UI entrypoints; follow its current discovery convention for the new `src/ui.tsx`.

## Contracts & interfaces

### Acknowledged terminal input

Implements [serialized send](logic.md#sc-18-serialized-prompt-protocol), [cancellation](logic.md#sc-21-stop-and-queued-cancellation).

CONTRACT: `PluginPty.writeAccepted(sessionId: string, data: string | Uint8Array): Promise<void>`.

Resolve only after all bytes are accepted by the live child PTY write boundary, including writes held by the shell-ready barrier. Reject disconnected, missing, exited, disposed, dropped, failed or partial writes. No automatic resend of a partially accepted write. A bounded transport request timeout may reject with an uncertain acceptance, never fabricate success. Success does not establish agent consumption. Existing `write`, binary frame behavior and its listeners remain unchanged; new writes call the shared onInput listeners once only after success. Add request/result protocol support to the real host and test fake. Receipt callers must handle rejection before scheduling later input phases.

### Canonical dock service

Implements [lifecycle](logic.md#sc-01-enable-and-auto-open), [persistence](logic.md#sc-22-reconnect-restart-and-revision-conflicts), [inspection](logic.md#sc-23-scriptable-actions-and-inspectable-state).

Register startup plugin with dependencies `quirky.terminal`, `quirky.session`, `quirky.agents`, `quirky.agent-status`; CLI alias `dock`; stable view `view:quirky.terminal-dock/composer`; settings `enabled` (false) and `autoOpen` (true). A settings view may provide conditional indented Experimental controls if the generic settings renderer cannot express them. Contribute that view/command in this plugin, not hard-coded kernel settings.

The service resolves `{pane}` through terminal/paneOf then terminal/workspace and the leaf session. An optional `{session}` selector resolves through paneOf. If both are given, they must agree. Reject shell, structured and unsupported recognized-agent identities for opening. Retain last recognized agent only while requested dock remains open; a transient loss is not confirmed exit. Settings and session/terminal events reconcile state through a serialized mutation path. Per-terminal send queues are distinct from the short record-mutation queue, so cancellation never waits behind the operation it cancels.

Public methods and request shapes (all object parameters, unknown keys refused by schemas):

SCHEMA:
- `get`: `{pane?: string, session?: string}`; exactly one selector unless both are matching binding hints from an embedded host. Returns DockState.
- `list`: `{}` -> `{panes: DockState[]}`.
- `set`: `{pane: string, revision?: number, docked?: boolean, gutterRows?: number, passthrough?: boolean, draft?: string, attachments?: string[]}` -> DockState. Nonempty draft changes require the current revision from clients; service-owned changes are serialized. Toggle with no explicit docked is a separate command that reads current state rather than guessing. A manual close sets userUndocked; explicit reopen clears it.
- `report`: `{pane: string, mounted: boolean, focused?: boolean, transport?: 'connected'|'connecting'|'reconnecting'|'disconnected'|'offline'}` -> DockState. Transient, not persisted; associate with calling window/connection and release on disconnect. Multiple windows do not let one unmount clear another's mounted pin. Passthrough is meaningful only for the active mounted host.
- `history`: `{pane: string, direction?: 'previous'|'next'}` -> `{entries: string[], state: DockState}`. With direction, update the draft using per-pane browse cursor, preserving the pre-browse draft.
- `pick`: `{pane: string, kind: 'slash'|'file', query?: string}` -> `{items: PickerItem[], truncated: boolean}`.
- `attach`: `{pane: string, path?: string, name?: string, mime?: string, base64?: string}` -> DockState; either an actual path or uploaded name/base64, never both.
- `removeAttachment`: `{pane: string, attachment: string}` -> DockState.
- `send`: `{pane: string, revision?: number, text?: string}` -> SendResult. If text omitted, snapshot canonical draft and attachment IDs atomically; the revision must match. Explicit text sends do not erase a newer canonical draft.
- `cancel`: `{pane: string, send?: string, interrupt?: boolean}` -> DockState. Cancels one identified operation; without ID current plus pending pane sends are cancelled. `interrupt` requests the documented stop/raw Escape path.
- `interaction`: `{pane: string, request: string, action: 'answer'|'collapse'|'expand'|'dismiss', answers?: string[][]}` -> DockState. IDs and answer values revalidate against the current pending provider request before any write.
- `options`: `{pane: string, kind?: 'model'|'effort'|'permission', value?: string}` -> DockState. Read with neither kind/value; mutation requires both and uses the same per-terminal queue.
- `driver`: `{pane: string, owner?: string, ttlMs?: number}` -> DockState. Explicit foreign driver lease with bounded expiry, release via missing owner; never set by local passthrough.

Every method is schema-declared with a matching CLI command under `quirky dock` (generic JSON flags for nested answers acceptable). Use established CLI output/error conventions. Window commands `toggle`, `passthrough`, `focus`, `resize`, `draft`, `send`, `cancel`, `history`, `interaction`, `options` carry a pane argument or resolve the active terminal pane through the terminal view report. Commands are real daemon-routed UI contributions, not unregistered DOM shortcuts. Missing view/window is explicit. Commands for actions already exposed as methods delegate to those methods, not duplicate policy. Add default Mod+Shift+K and Mod+Shift+P bindings with a pane context that includes both terminal and dock focus; capture handling in the terminal host must avoid double dispatch.

### Shared dock types

Implements [data flow](logic.md#data-flow) and [inspection](logic.md#sc-23-scriptable-actions-and-inspectable-state). Create these public-to-this-plugin types in `src/types.ts`. The UI and backend import the same types; terminal host uses the declared serialized shape without private imports.

SCHEMA:
- `DockAttachment`: `{id: string, name: string, path: string, mime: string, image: boolean}`.
- `DockQuestion`: `{id: string, kind: 'question'|'permission', title: string, questions: {prompt: string, choices: {label: string, value: string}[], multiple: boolean}[], collapsed: boolean, dismissed: boolean}`.
- `DockOptions`: `{model: string|null, effort: string|null, permission: string|null, choices: {model: string[], effort: string[], permission: string[]}, context: {used: number, limit: number}|null, notice: string|null}`. Unknown stays null, never inferred from a selection sent without evidence.
- `DockState`: `{pane: string, session: string, tab: string, revision: number, enabled: boolean, supported: boolean, agent: string|null, docked: boolean, userUndocked: boolean, gutterRows: number, mounted: boolean, passthrough: boolean, draft: string, attachments: DockAttachment[], disabledReason: string|null, activeSend: {id: string, phase: string}|null, question: DockQuestion|null, options: DockOptions, notice: string|null}`. Optional extra report fields may be added, but core fields keep these names/types.
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

These adapters use only public APIs and read-only provider files. Validate transcript paths as regular readable files, bound incremental reads, retain stable request identity, and invalidate answered/resolved/replaced requests. For providers with no retained transcript path, use real request/resolution hook payloads preserved through an additive public agent-status interaction contract or documented provider storage discovery. A status heuristic alone must not create answerable choices. Do not fake a question by routing it through quirky.ask/create. Answer TUIs by their evidenced selector/free-text protocol, pacing sequential question steps; validate live request before sending, serialize with normal sends, stop on AbortSignal. Permission choices must be the actual provider choices; never guess approval from an arbitrary string.

Read actual provider formats, including upstream retained-session readers as design evidence if needed; do not import upstream code or depend on a second running app. Provider absence/no active question is valid; malformed/unreadable source produces explicit reason rather than a fabricated card. A real question must be supported for each transcript-supported agent family named in the feature doc. Session options are agent-specific, sourced from reported data and provider catalogs, with unsupported controls labelled. Claude session-only effort/model navigation must inspect the screen before any default-saving confirmation, use the documented `s` action, and refuse if not observable. Never send `/effort <value>` or persist globals.

Picker roots are agent-appropriate local skill/command directories and workspace files, plus declared applicable commands where their invocation genuinely maps to an agent command. Read only; cap results and traversal; prevent symlink escape and special-file blocking. Uploads use plugin data directory, generated unique basename and strict base64/size checks (10 MiB per attachment, 20 attachments per pane); supplied path must be an existing regular file. Preserve original display name but never use it as a filesystem path. Do not delete caller-owned files on chip removal.

### Send engine and record lifecycle

Implements [SC-17..22](logic.md#sc-17-send-availability-and-foreign-driver).

`src/send.ts` performs cancellable clear/body/delayed-Enter/observation; `src/service.ts` owns per-session serialization and atomic snapshot/recovery. Every awaited phase rechecks cancellation, feature enabled, live session and actual driver ownership. Feature-off stops scheduled writes; bytes accepted before cancellation remain possibly delivered. Do not hold the record lock across timed waits. Controls and answer operations share the same terminal queue. Queue cancellation settles waiters even if another operation is active. Explicit deadlines prevent an unreadable transcript or unresponsive provider lookup blocking all state methods.

Use the feature-doc exact clear constants, paste normalization, image settle, Enter delay and observation schedule. Replace all literal Escape bytes in user text before wrapping so a draft cannot break out of paste. Only positive matching evidence can override a recognizer miss. Recovery prepends the failed snapshot exactly once, preserving newer text and attachment IDs, and never retries automatically. History records accepted prompt attempts once and seeds from real prompt history; do not mark a mere rejected empty/pre-write request as sent.

Record migrations use PluginContext.openStore. Persist preferences, draft, attachment metadata, agent latch and history; never persist active sends, mounted connections or stale leases across daemon restart. Independently validate corrupt entries; use Maps or own-key guards; reject prototype keys and invalid rows. Bound draft to 200,000 characters and uploaded data to declared limits. Prune via current public terminal layout/session identity; a moved pane retains its ID. No state/cleanup writes when disabled. Uploaded files no longer referenced may be reclaimed inside the plugin directory after safe pruning; never follow a persisted attachment path outside plugin storage for deletion.

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
- Backend: `plugins/quirky.terminal-dock/test/service.test.ts`, `send.test.ts`, `e2e.test.ts`, `cli.test.ts` — use public API and real isolated daemon/PTY fixture for each scenario's scriptable behavior, concurrency, cancellation, bounds, corrupt state/restart, safe effort and defect evidence. CLI handler tests alone are not flow proof.
- Provider/picker/attachments: `plugins/quirky.terminal-dock/test/providers.test.ts`, `pickers.test.ts`, `attachments.test.ts` — actual provider-shaped fixtures and fake TUIs that consume input; pending/resolved/stale requests, option safe-failure/success, traversal/path/upload limits and source-specific invocations.
- Composer: `plugins/quirky.terminal-dock/test/window.test.tsx` — headless UI for editor/IME/picker/history/chip/question/notice transitions against public calls; never assert stylesheet source.
- Host: `plugins/quirky.terminal/test/e2e-ui/dock.test.ts` and `test/window/dock-geometry.test.ts` — real host/controller with public API, split focus, conditional menu/shortcuts, mount hysteresis/rows/cleanup. Actual pixel fit is also exercised in the browser.

Acceptance commands are these exact owned files for component checks. Whole branch gate: `bun run test`, `bun test scripts`, `bun run typecheck`, `bun run build`. Full suite runs only through remote `bun run test`. Smoke: built daemon with fresh temporary home and fake supported TUIs that record received bytes, invoke dock methods via CLI/API, then using-apps-like-a-user web/unattended against daemonUrl for SC-01..17 and SC-19/20/23. Observe actual UI screenshots/report; stop daemon and delete temporary home. Native-only file dialog/focus behavior, if any, is handed to docs/loop/native format rather than claiming the web pass covered OS surfaces.

## Non-goals

See [logic scope](logic.md#scope--non-goals). No additional technical exclusions. Missing capability must be implemented through the public seam, not silently replaced by an unavailable placeholder.

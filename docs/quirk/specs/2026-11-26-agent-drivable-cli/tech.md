# Tech spec: agent-drivable Quirky CLI and API

**Status:** Reviewed (2026-11-26)  
**Logic spec:** [logic.md](./logic.md)

All paths are relative to the repo root. `M` = `src/main/runtime/rpc/methods`, `C` = `src/shared/rpc-contract`.

## Architecture

Back-links: [Conceptual model](./logic.md#conceptual-model), [Data flow](./logic.md#data-flow).

The work splits into eight units. Each owns its files and talks to the others only through the shared contracts pinned in [Data models](#data-models--schemas).

| Unit                                           | Owns                                                                                                                                       | Depends on |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| U1 Public contract                             | `src/shared/public-rpc/**`: the method classification and public metadata, error contract, caller hint, and event shapes                   | none       |
| U2 Server contract enforcement                 | dispatcher prologue: the confirm gate, approval gate, caller attribution, `PublicRpcError` passthrough, the capability constant            | U1         |
| U3 Generated CLI and discovery                 | `src/cli/public-cli/**`: the generated commands, `schema`, `rpc`, exit codes, `QUIRKY_OUTPUT`, the error printer                           | U1         |
| U4 Streaming over the unix socket and `events` | multi-reply unix transport, CLI streaming client, public event bus and replay buffer, `events.subscribe`, `quirky events`, `--wait` helper | U1         |
| U5 App actions and UI state                    | action catalog, `ui.listActions`, `ui.runAction`, `ui.state`, the main↔renderer bridge, handler-map factoring                              | U1, U2     |
| U6 Chat family                                 | hand-written `quirky chat ...` over `agentSession.*`                                                                                       | U1, U3, U4 |
| U7 Admin and tab families                      | settings, notifications, plugins, file and tab public metadata, with hand-written overrides where needed                                   | U1, U3     |
| U8 Approvals, activity trail, markers (UI)     | approval policy setting and its Settings UI, activity trail store, event topic and renderer rows, caller markers                           | U1, U2     |

Technologies: zod `~4.6.7` (use the built-in `z.toJSONSchema`), vitest, Electron IPC request/reply, and the existing NDJSON envelope.

## Code references

### Existing anchors (read before changing)

- Method definition: `src/main/runtime/rpc/core.ts` has `RpcTypedMethod`, `defineMethod`, `defineStreamingMethod`, `RpcContext`, `RpcRequest` and `InvalidArgumentError`. The registry is `ALL_RPC_METHODS` in `M/index.ts`.
- Permissions are in `src/main/runtime/rpc/rpc-method-permission.ts`. Caller scope is in `rpc-caller-scope.ts` (`denyRpcMethodForCaller`) and caller identity in `rpc-caller-identity.ts`.
- Admission: `src/main/runtime/rpc/rpc-request-admission-prologue.ts` (`admitRpcRequest`) and `dispatcher-request-parsing.ts` (`parseRpcRequestParams`).
- Errors: `src/main/runtime/rpc/dispatcher-error-response.ts` (`mapDispatcherError`) and `rpc/errors.ts` (`mapRuntimeError`, `RUNTIME_PASSTHROUGH_CODES` near L66, `errorResponse` near L48).
- Envelope: `src/shared/runtime-rpc-envelope.ts` (`RuntimeRpcEnvelopeSchema`, `isKeepaliveFrame`).
- Unix transport, server side: `src/main/runtime/rpc/unix-socket-transport.ts` (`dispatchMessage` near L181 is single-reply via `replied`) and `src/main/runtime/runtime-rpc/runtime-rpc-request-admission.ts` (`parseAndAuth` near L123).
- Unix transport, client side: `src/cli/runtime/transport.ts` (`sendRequest`, one terminal frame). The client is `src/cli/runtime/client.ts` (`RuntimeClient.call` near L89, `resolveMethodTimeoutMs` near L196).
- Streaming reference: `src/main/runtime/rpc/dispatcher-streaming-feature-emitter.ts`. The subscription pattern (`ready` frame, `registerSubscriptionCleanup`, `*.unsubscribe`) is in `M/notifications.ts` and `M/client-events.ts`.
- CLI core:
  - `src/cli/command-spec.ts` (`CommandSpec`)
  - `src/cli/specs/index.ts` (`COMMAND_SPECS`)
  - `src/cli/handler-group-manifest.ts` (`HANDLER_GROUPS`)
  - `src/cli/dispatch.ts` (`HandlerContext`, `CommandHandler`)
  - `src/cli/index.ts` (`main`, `json` at L107, `process.exitCode = 1` at L204)
  - `src/cli/format.ts` (`printResult` at L69)
  - `src/cli/cli-error.ts` (`reportCliError` at L119)
  - `src/cli/runtime/types.ts` (`RuntimeClientError`, `RuntimeRpcFailureError`)
  - `src/cli/agent-context.ts`
  - `src/shared/cli-argument-boundary.ts` (`CLI_GLOBAL_FLAGS`, `CLI_BOOLEAN_FLAGS` already contains `yes`)
- Capabilities: the `src/shared/protocol-version.ts` `RUNTIME_CAPABILITIES` spread from the per-area `src/shared/*-runtime-capabilities.ts`. `NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES` is near L142.
- Agent env: `src/shared/agent-session-caller-env.ts` (`QUIRKY_AGENT_SESSION_ID`). Other env vars are `QUIRKY_TERMINAL_HANDLE`, `QUIRKY_PANE_KEY`, `QUIRKY_TAB_ID` and `QUIRKY_WORKTREE_ID`.
- Event tap points:
  - `runtime.onClientEvent` (`src/main/runtime/runtime-client-event-bus.ts`, events in `src/shared/runtime-client-events.ts`)
  - `runtime.onNotificationDispatched` (bound in `src/main/runtime/runtime-service-command-surface.ts`, consumed at `M/notifications.ts:24`; the controller method is `onDispatched`)
  - `runtime.onWorktreeLifecycle`
  - the agent-session status and turn-completion sources behind `M/structured-agent-session-status-stream.ts` and `M/structured-agent-session-turn-completion-stream.ts`
  - `store.onSettingsChanged` (`src/main/ipc/settings.ts` near L86)
- Renderer actions:
  - `src/shared/keybindings/types.ts` (`KeybindingDefinition` at L151, `KeybindingActionId`)
  - `src/shared/keybindings/definitions.ts` (`DEFINITIONS_BY_ID`)
  - `src/renderer/src/app-shell/app-command-handlers.ts` (`createAppCommandHandlers` at L117; it covers about 19 ids)
  - `src/renderer/src/app-shell/use-global-keybindings.ts` (inline handlers, plus `registerAppCommandDispatcher` at L87)
  - `src/renderer/src/lib/app-command-dispatch.ts` (`AppCommandSource`, `dispatchAppCommand`)
- Main↔renderer request/reply template: `src/main/runtime/browser/browser-tab-renderer-create.ts`. The preload is `src/preload/api/ui-bridge-state-and-menu-commands.ts` near L150-176, the renderer bridge is `src/renderer/src/hooks/ipc-events/browser-request-ipc-bridge.ts`, and the web stub is `src/renderer/src/web/preload-api/web-ui-api.ts` near L233.
- Window and headless: `getAvailableAuthoritativeWindow()` (`src/main/runtime/quirky-runtime-resolve-waiter.ts` near L33, returns null when headless) and `HEADLESS_RUNTIME_WINDOW_ID` (`src/shared/runtime-session-contracts.ts:28`).
- Ask, for approvals: `src/main/fork-ask-question-tool/ask-registry.ts` and `ask-services.ts`. Schemas are in `src/shared/fork-ask-question-tool/ask-question-schema.ts`, and the renderer card is `src/renderer/src/components/fork-ask-question-tool/AskCard.tsx`.
- Activity UI lives in `src/renderer/src/components/activity/`.
- Chat RPCs:
  - `M/structured-agent-session.ts` (create, send, cancel, close, rewind, conversationCommand, history, subscribe, subscribeStatus)
  - `M/structured-agent-session-prompt-response.ts` (`respondToApproval`, `respondToQuestion`, `setOption`)
  - `M/structured-agent-session-current-requests.ts`
  - `M/structured-agent-session-options-read.ts`
  - params in `C/structured-agent-session-params.ts`, `MutationEnvelope`
- Admin RPCs:
  - Settings: `M/client-ui.ts`, i.e. `settings.get` (L93), `settings.update` (L99, `C/client-settings-params.ts` `SettingsUpdate`), and `settings.mutateNativeChatSessionOptions`.
  - Notifications: `M/notifications.ts`.
  - Plugins: `M/plugins.ts`.
  - Files: `M/files.ts` and `M/files-mutation-methods.ts`.
  - Tabs: `M/session-tabs.ts`, `session-tab-close-methods.ts`, `session-tab-mutation-methods.ts` (`activate`, `move`, `setTabProps.isPinned`) and `session-tab-markdown-methods.ts`.
- Params catalog: `C/rpc-params-catalog.generated.ts` (`RPC_PARAMS_BY_METHOD`, `RPC_METHODS_WITHOUT_SHARED_PARAMS`). It is generated by `config/scripts/generate-rpc-params-catalog.mjs`.

### Files to create

- `src/shared/public-rpc/public-method-spec.ts` (U1). It also holds `ApprovalCategory`, `DestructiveSpec` and `StableErrorCode` re-exports, the single home every unit imports.
- `src/shared/public-rpc/ui-state.ts` (U1, `UiStateSnapshot`)
- `src/shared/public-rpc/method-classification.ts` (U1)
- `src/shared/public-rpc/public-methods/*.ts`, one per area (U1 creates `index.ts`; U6 and U7 add area files)
- `src/shared/public-rpc/error-contract.ts` (U1)
- `src/shared/public-rpc/caller-hint.ts` (U1)
- `src/shared/public-rpc/public-events.ts` (U1)
- `src/shared/public-cli-runtime-capabilities.ts` (U1)
- `src/shared/keybindings/action-catalog.ts` (U5)
- `src/main/runtime/rpc/public-contract-gate.ts` (U2)
- `src/main/runtime/rpc/public-rpc-error.ts` (U2)
- `src/main/runtime/rpc/destructive-previewers.ts` (U2 creates the registry, and each unit registers its own previewers)
- `src/main/runtime/public-events/public-event-bus.ts` (U4)
- `src/main/runtime/public-events/public-event-sources.ts` (U4)
- `M/public-events.ts` (U4)
- `M/ui-actions.ts` (U5)
- `src/main/runtime/ui-bridge/ui-renderer-request.ts` (U5)
- `src/renderer/src/hooks/ipc-events/ui-action-ipc-bridge.ts` (U5)
- `src/cli/public-cli/generated-commands.ts` (U3)
- `src/cli/public-cli/schema-command.ts` (U3)
- `src/cli/public-cli/rpc-command.ts` (U3)
- `src/cli/public-cli/exit-codes.ts` (U3)
- `src/cli/public-cli/output-mode.ts` (U3)
- `src/cli/public-cli/wait-for-event.ts` (U4, shared `--wait` helper used by U5, U6 and U7 handlers)
- `src/cli/handlers/ui-actions.ts` and `src/cli/specs/ui-actions.ts` (U5: `ui state`, `action list`, `action run`, `layout get`)
- `src/cli/handlers/admin.ts` and `src/cli/specs/admin.ts` (U7: hand-written overrides listed in the surface map)
- `src/cli/runtime/streaming-transport.ts` (U4)
- `src/cli/handlers/events.ts` (U4)
- `src/cli/handlers/chat.ts` and `src/cli/specs/chat.ts` (U6)
- `src/main/runtime/activity-trail/activity-trail-store.ts` (U8)
- `src/main/runtime/approvals/approval-gate.ts` (U8)

## Contracts & interfaces

### U1: Method classification (the coverage source)

Back-link: [Key decisions & rationale](./logic.md#key-decisions--rationale).

CONTRACT:

```
type MethodClass =
  | { kind: 'public'; spec: PublicMethodSpec }
  | { kind: 'internal'; reason: string }                 // desktop/mobile/plumbing only
  | { kind: 'legacy-cli'; family: string }               // already wrapped by a hand-written family (terminal, browser, orchestration, ...)
  | { kind: 'unstable'; destructive?: DestructiveSpec }  // reachable only via `quirky rpc`
METHOD_CLASSIFICATION: Readonly<Record<string, MethodClass>>   // exact method names
NAMESPACE_DEFAULTS: Readonly<Record<string, MethodClass>>      // e.g. 'browser.' -> legacy-cli
classifyMethod(name: string): MethodClass | undefined          // exact first, then longest namespace prefix
```

- **Invariant:** every name in `ALL_RPC_METHODS`, across both layout-owner build variants, is classified. A coverage test in `src/main/runtime/rpc/public-method-coverage.test.ts` fails and names each unclassified method.
- **Invariant:** every name in `METHOD_CLASSIFICATION` exists in `ALL_RPC_METHODS`, so stale entries fail.
- **Invariant:** `src/shared/public-rpc/**` imports no `src/main` module and no `electron`, because `config/scripts/check-runtime-electron-ratchet.mjs` guards the CLI entry.

### U1: PublicMethodSpec

Back-link: [Conceptual model](./logic.md#conceptual-model).

CONTRACT:

```
type PublicMethodSpec = {
  method: string                    // RPC name, e.g. 'settings.get'
  cliPath: string[]                 // e.g. ['settings','get']
  summary: string                   // one line, shown by `quirky schema`
  stability: 'stable' | 'unstable'
  effect: 'read' | 'mutate'         // mutate => attributed + activity trail + event
  params: ZodType | null            // the SAME schema object the RPC method uses (import from C/)
  result: ZodType                   // runtime-validated in tests only, not in production dispatch
  positionals?: string[]            // param keys mapped to positionals, in order; the rest become --kebab-flags
  destructive?: DestructiveSpec
  approvalCategory?: ApprovalCategory
  errors: StableErrorCode[]
  streaming?: true
}
type DestructiveSpec = { category: ApprovalCategory }
type ApprovalCategory = 'workspace-delete' | 'file-overwrite-delete' | 'chat-discard-rewind' | 'permission-answers' | 'security-settings'
```

- Precondition: `params` is the exact zod object the server method parses. Never redeclare it, because `public-method-coverage.test.ts` asserts identity against `RPC_PARAMS_BY_METHOD`.
- `cliPath` collisions with `COMMAND_SPECS` are allowed. The hand-written command wins (see U3).

### U1: Error contract

Back-link: [Result and error contract](./logic.md#result-and-error-contract).

CONTRACT:

```
type StableErrorCode = 'internal' | 'invalid_argument' | 'not_found' | 'needs_confirmation' | 'conflict' | 'unavailable' | 'timeout' | 'unauthorized'
EXIT_CODE: Record<StableErrorCode, 1|2|3|4|5|6>   // internal 1, invalid_argument 2, not_found 3, needs_confirmation 4, conflict 5, unavailable/timeout/unauthorized 6
normalizeErrorCode(code: string): { code: StableErrorCode; reason: string }
  // legacy -> stable, e.g. selector_not_found -> not_found/selector_not_found, method_not_found -> unavailable/capability_missing,
  // runtime_unavailable -> unavailable/runtime_unavailable, confirmation_required -> needs_confirmation/confirmation_required;
  // unknown codes -> internal/<original code>
type NextStep = { command: string; why: string }
```

- Success exits 0.
- **Invariant:** `next` is non-empty whenever the stable code is `not_found`, `needs_confirmation`, `conflict` or `unavailable`. The CLI synthesizes a generic `next` when the server sent none, for example `quirky schema <command>` or `quirky status`.

### U2: Server gate

Back-links: [Data flow](./logic.md#data-flow), [Safety and what the user sees](./logic.md#safety-and-what-the-user-sees).

CONTRACT:

```
class PublicRpcError extends Error { code: StableErrorCode; reason: string; next: NextStep[]; data?: Record<string, unknown> }
// mapRuntimeError passes it through as error:{code, message, data:{reason, next, ...data}}
RpcRequest gains optional: confirm?: boolean; publicContract?: 1; caller?: CallerHint
RpcContext gains: publicCaller: AttributedCaller
registerDestructivePreviewer(method: string, fn: (params, ctx) => Promise<string[]>): void
```

Admission order, inserted in `admitRpcRequest` after param parsing:

1. Build `publicCaller` from transport scope plus `request.caller`.
2. If `request.publicContract === 1` and the classification has `destructive`, and `confirm !== true`: run the previewer and throw `PublicRpcError('needs_confirmation', 'preview', next=[{command: <same command> + ' --yes'}], data:{effects})`.
3. If `approvalCategory`, or `destructive` with confirm, resolves to `ask` in the approval policy: block on the approval gate (U8). A decline gives `needs_confirmation/declined`. A wait past `APPROVAL_TIMEOUT_MS` (default 600000) gives `needs_confirmation/timed_out`.
4. Dispatch. If `effect === 'mutate'`, record activity and publish the matching event.

- **Invariant:** a request without `publicContract` behaves exactly as today. Legacy CLI families never send it, so `quirky worktree rm` keeps its current behavior.
- Mixed versions: unknown request fields are optional and new, so they're safe under remote-wire-compatibility Rule 1. Confirm that the server request schema accepts them, and widen it if it's strict.

### U3: Generated CLI

Back-links: [Command surface (first version)](./logic.md#command-surface-first-version), [Result and error contract](./logic.md#result-and-error-contract).

CONTRACT:

```
buildGeneratedCommands(publicSpecs, handWrittenPaths): { specs: CommandSpec[]; handlers: Record<string, CommandHandler> }
  // skips any cliPath already in COMMAND_SPECS; flags = kebab-case of top-level param keys; nested objects via --params-json
resolveOutputMode(flags, env): 'json' | 'text'       // --json OR env QUIRKY_OUTPUT === 'json'
exitCodeFor(error): number                             // via normalizeErrorCode + EXIT_CODE
```

- `quirky schema` prints one line per public command plus each hand-written command: `<path>  <summary>`.
- `quirky schema <path...>` prints `{command, method?, params: JSONSchema, result: JSONSchema, stability, destructive, approvalCategory, errors}`, using `z.toJSONSchema`.
- `quirky rpc list` prints every method with its class and stability.
- `quirky rpc <method> --params '<json>' [--yes]` sends `publicContract: 1`, and `confirm` when `--yes` is passed.
- JSON results are terse by default. A spec may name terse fields. `--full` returns the whole result.
- `src/cli/index.ts` sets `process.exitCode = exitCodeFor(err)` instead of 1. `reportCliError` emits `error.data.reason` and `error.data.next` in JSON mode, and prints `Next: <command>  (<why>)` lines in text mode.
- **Invariant:** local usage errors exit 2 before any client is constructed. Keep the lazy `client` getter in `index.ts`.

### U4: Streaming and events

Back-links: [Data flow](./logic.md#data-flow), SC-1, SC-6.

CONTRACT:

```
// server: unix-socket-transport dispatches streaming methods via dispatcher.dispatchStreaming with a multi-reply writer
// client:
sendStreamingRequest(method, params, onFrame: (result: unknown) => void, signal): Promise<void>
RuntimeClient.stream(method, params, onFrame, opts): Promise<void>    // local socket or remote WS
// server event bus:
PublicEventBus.publish(e: Omit<PublicEvent,'seq'|'at'>): void
PublicEventBus.since(after: number | undefined, topics: PublicTopic[]): PublicEvent[] | { gap: { from: number; oldest: number } }
// RPC: 'events.subscribe' (streaming) params { topics?: PublicTopic[]; after?: number } ; 'events.unsubscribe' { subscriptionId }
```

- **Buffer bound:** last 5000 events or 10 minutes, whichever is smaller. `events.gap` is the first frame when `after < oldest`.
- `--wait` helper (`src/cli/public-cli/wait-for-event.ts`): open the stream and read the current cursor from the `ready` frame, run the call, then return on the first matching settle event. This order prevents a lost-event race.
- Keepalive frames continue during streams. The client's per-request timeout is disabled for streams and replaced by `--timeout` when given.

### U5: App actions and UI state

Back-links: SC-2, SC-4, SC-5.

CONTRACT:

```
ACTION_CATALOG: Record<KeybindingActionId, { description: string; dispatch: 'rpc' | 'ui-only'; uiOnlyReason?: string; destructive?: DestructiveSpec; takesWorkspace?: boolean }>
AppCommandSource += 'rpc'
dispatchAppCommandWithResult(id, 'rpc', { worktreeId? }): { claimed: boolean; reason?: string }   // new export; existing dispatchAppCommand keeps its boolean return for plugin callers
RPC 'ui.listActions' params { available?: boolean; workspace?: string } -> { actions: {id, description, available, reason?, destructive}[] }
RPC 'ui.runAction'   params { actionId: string; workspace?: string } -> { claimed: true }   // PublicRpcError unavailable/not_applicable|no_ui
RPC 'ui.state'       params null -> UiStateSnapshot
IPC  'ui:requestAction' / 'ui:actionReply'   { requestId, actionId, worktreeId?, probeOnly? } -> { requestId, claimed, reason? }
IPC  'ui:requestState'  / 'ui:stateReply'    { requestId } -> { requestId, state: UiStateSnapshot }
```

- `ui.state`, `ui.listActions` and `ui.runAction` are new exact names beside existing `ui.get`/`ui.set`/`ui.setCollapsed`. Classify them exactly, and never through a `ui.` namespace default.
- The logic spec's `'cli'` dispatch source is spelled `'rpc'` here because remote and mobile callers reach it too. This is the same intent.
- No window (`getAvailableAuthoritativeWindow()` returns null) gives `unavailable/no_ui`. A renderer that doesn't reply within 10 s gives `timeout/renderer_timeout`.
- Coverage invariant: every `KeybindingActionId` is in `ACTION_CATALOG`. Every `dispatch: 'rpc'` id resolves to a handler in the `createAppCommandHandlers` map, which the test asserts. Factor every store-level handler from `use-global-keybindings.ts` into the map: tabs, views, sidebars, worktree history, floating terminal, zoom. Mark only component-local ones `ui-only`, meaning those that need DOM focus inside a specific editor, terminal or browser instance, each with a reason naming the typed command that covers it.
- `workspace.delete` over RPC takes an explicit `worktreeId` and never the hovered workspace. It is destructive with category `workspace-delete`. Its previewer lists the uncommitted file count for git worktrees, or "removes folder workspace from Quirky; files stay on disk" for folder workspaces.
- Renderer reports focus changes over IPC `ui:focusChanged`, debounced to 250 ms, and these become `ui` topic events.

### U6: Chat family

Back-link: SC-1.

- **Handlers:** `chat list` (from the `agentSession.subscribeStatus` snapshot frame, then close), `create`, `resume` (`resumeFrom`), `send`, `cancel`, `rewind`, `history`, `options get|set`, and `respond <session> <request> --allow|--deny|--answer <text>|--option <id>`.
- `respond` maps to `respondToApproval` or `respondToQuestion`. It resolves `itemId`/`expectedRevision` from `agentSession.currentRequests`.
- The CLI builds `MutationEnvelope`: `clientOperationId` is a UUID, `payloadFingerprint` is the sha256 of the canonical JSON params, and `expectedRuntimeFence` comes from the latest snapshot or `null`.
- Remote CLI adds `agent-session.structured.v1` to `NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES`.
- Approval categories: `rewind` and `conversationCommand clear` are `chat-discard-rewind` (destructive). `respond` is `permission-answers` (approval only, no preview).
- `send --wait` returns on the `chat` topic events `turn.finished`, `turn.failed` or `turn.needs-input` for that session, with the final assistant message (`lastAssistantMessage` from status).

### U7: Admin and tab families

Back-link: [Command surface (first version)](./logic.md#command-surface-first-version).

- Public specs:
  - `settings.get`
  - `settings.update`, with approval category `security-settings` when any of `agentDefaultEnv`, `agentDefaultArgs`, `nativeChatPermissionMode` or `agentStatusHooksEnabled` is present
  - `notifications.getMissedSince` as `notifications list`
  - `plugins.list`, `plugins.setEnabled`, `plugins.invokeCommand` (`plugins run`)
  - `files.readDir|read|write|searchPaths|search|delete`, where `write` to an existing path and `delete` are destructive with category `file-overwrite-delete`
  - `session.tabs.listAll|activate|close|move|setTabProps`
- `settings set <key> <value>` is a hand-written override that builds the `SettingsUpdate` object from one key.
- Tab family: see the [Open decision](#open-decision-tab-family) below.

### U8: Approvals, activity, markers

Back-link: [Safety and what the user sees](./logic.md#safety-and-what-the-user-sees).

CONTRACT:

```
settings key agentApprovalPolicy: Record<ApprovalCategory, 'agent' | 'ask'>   // default all 'agent'
approvalGate.require(category, caller, summary, effects): Promise<'approved'> // throws PublicRpcError needs_confirmation declined|timed_out
ActivityTrailStore.record({ caller: AttributedCaller, method, summary, workspaceId?, at }): void   // ring of 1000, in memory
```

- Approval prompts register through the ask registry as a `confirm` question, so they render in the existing `AskCard`.
- Renderer:
  - Settings → Agents → Approvals rows, using existing settings primitives.
  - Activity rows in `src/renderer/src/components/activity/`, grouped by caller and filterable by workspace.
  - A caller marker on tabs an agent opened or focused, for 4 s. A changed-setting dot until the setting is viewed.
  - Follow `docs/STYLEGUIDE.md` and existing tokens. No new colors.

## Data models / schemas

SCHEMA: `src/shared/public-rpc/caller-hint.ts`

```
CallerHint = { role?: 'brain'; agentSessionId?: string; worktreeId?: string; terminalHandle?: string }   // read by CLI from env QUIRKY_CALLER_ROLE, QUIRKY_AGENT_SESSION_ID, QUIRKY_WORKTREE_ID, QUIRKY_TERMINAL_HANDLE
AttributedCaller = { kind: 'brain' | 'agent-session' | 'terminal' | 'remote' | 'mobile' | 'script'; label: string; worktreeId?: string; agentSessionId?: string; deviceId?: string }
```

SCHEMA: `src/shared/public-rpc/public-events.ts`

```
PublicTopic = 'chat' | 'ui' | 'notifications' | 'workspace' | 'activity'
PublicEvent = { seq: number; at: number; topic: PublicTopic; type: string; caller?: AttributedCaller; data: Record<string, unknown> }
chat types:          turn.started | turn.finished | turn.failed | turn.needs-input        data { sessionId, turnId?, requestId?, worktreeId? }
ui types:            focus.changed | tab.opened | tab.closed | view.changed             data { worktreeId?, tabId?, tabType?, view? }
notifications types: notification.raised                                                data { id, title, worktreeId? }
workspace types:     worktree.created | worktree.removed | terminal.exited | terminal.idle | settings.changed   data { worktreeId?, terminalHandle?, keys? }
activity types:      activity.recorded                                                  data { method, summary, worktreeId? }
gap frame:           { type: 'events.gap', from: number, oldest: number }
ready frame:         { type: 'ready', subscriptionId: string, cursor: number }
```

SCHEMA: `UiStateSnapshot` (in `src/shared/public-rpc/ui-state.ts`)

```
{ worktreeId: string | null; view: string; tab: { id: string; type: 'terminal'|'browser'|'editor'|'markdown'|'chat'|'other'; title: string } | null;
  paneId: string | null; panels: { leftSidebar: boolean; rightSidebar: { open: boolean; tab: string | null }; floatingTerminal: boolean };
  editorFile: string | null }
```

CONFIG:

```
QUIRKY_OUTPUT=json            # constant exported from src/shared/agent-session-caller-env.ts; SET in src/main/runtime/structured-session-child-env.ts (beside QUIRKY_AGENT_SESSION_ID at ~L128) and in agent-launch terminal env in src/main/providers/local-pty-launch-helpers.ts (only when the PTY is an agent launch, not a plain shell). Owner: U3
QUIRKY_CALLER_ROLE=brain      # read by the CLI only; no brain launcher exists yet, so nothing sets it in this run (attribution falls back to agent-session/terminal/script)
PUBLIC_CLI_RUNTIME_CAPABILITY = 'public-cli.v1'   # in src/shared/public-cli-runtime-capabilities.ts, spread into RUNTIME_CAPABILITIES
```

## Command surface map

Back-link: [Command surface (first version)](./logic.md#command-surface-first-version).

Every logic-spec command maps to a generated command (G, built by U3 from a public spec) or a hand-written command (H, with an owning unit and file). G commands get their public spec from the unit named.

| Command                                          | Kind               | Backing RPC                                                                                                                                                                                                                                 | Owner                                     |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `schema [path]`                                  | H                  | none (local)                                                                                                                                                                                                                                | U3 `src/cli/public-cli/schema-command.ts` |
| `rpc list`, `rpc <method>`                       | H                  | any                                                                                                                                                                                                                                         | U3 `src/cli/public-cli/rpc-command.ts`    |
| `ui state`                                       | H                  | `ui.state`                                                                                                                                                                                                                                  | U5 `src/cli/handlers/ui-actions.ts`       |
| `action list [--available] [--workspace]`        | H                  | `ui.listActions`                                                                                                                                                                                                                            | U5                                        |
| `action run <id> [--workspace] [--yes] [--wait]` | H                  | `ui.runAction`; `--wait` returns on the next `ui` event caused by the action, or after 2 s with the current `ui state`                                                                                                                      | U5                                        |
| `layout get`                                     | H                  | first frame of the `layout.subscribe` stream (via U4 `RuntimeClient.stream`), then unsubscribe                                                                                                                                              | U5                                        |
| `layout apply`                                   | G                  | `layout.apply`; builds without `QUIRKY_LAYOUT_OWNER_IS_MAIN` return `unavailable/capability_missing`                                                                                                                                        | U5 spec                                   |
| `tab list/focus/close/move/pin`                  | H (see Tab family) | `session.tabs.listAll/activate/close/move/setTabProps`                                                                                                                                                                                      | U7                                        |
| `chat ...`                                       | H                  | `agentSession.*` (see U6)                                                                                                                                                                                                                   | U6 `src/cli/handlers/chat.ts`             |
| `settings get [key]`                             | G                  | `settings.get` (client-side key filter)                                                                                                                                                                                                     | U7 spec                                   |
| `settings set <key> <value>`                     | H                  | `settings.update`                                                                                                                                                                                                                           | U7 `src/cli/handlers/admin.ts`            |
| `settings list`                                  | H                  | `settings.get`, printed as key/value lines                                                                                                                                                                                                  | U7                                        |
| `notifications list`                             | G                  | `notifications.getMissedSince` with `lastSeenSeq: 0`                                                                                                                                                                                        | U7 spec                                   |
| `notifications dismiss <id>`                     | H                  | marks read via the runtime's existing dismiss path if one exists; else `unavailable/capability_missing`. The implementer checks `M/notifications.ts`, and if no dismiss RPC exists, adds `notifications.dismiss` (public, mutate) beside it | U7                                        |
| `plugins list`                                   | G                  | `plugins.list`                                                                                                                                                                                                                              | U7 spec                                   |
| `plugins enable                                  | disable <key>`     | H                                                                                                                                                                                                                                           | `plugins.setEnabled {enabled: true        | false}` | U7                                                                                                            |
| `plugins run <key> <command>`                    | G                  | `plugins.invokeCommand`                                                                                                                                                                                                                     | U7 spec                                   |
| `file list                                       | read               | write                                                                                                                                                                                                                                       | search`                                   | G       | `files.readDir`, `files.read`, `files.write`, `files.search` (`file search --paths` uses `files.searchPaths`) | U7 spec; the existing `file open/diff/open-changed` stay legacy |
| `events [--topic] [--after] [--until <type>]`    | H                  | `events.subscribe`; `--until` exits 0 on the first event whose `type` matches                                                                                                                                                               | U4 `src/cli/handlers/events.ts`           |

## Tab family (resolved)

Back-link: [Status & amendments](./logic.md#status--amendments).

U7 extends the existing browser `tab` handlers in `src/cli/handlers/browser-tab.ts` and the specs in `src/cli/specs/browser-basic.ts:175-255` with an optional `--type <all|terminal|editor|markdown|chat|browser>`.

- When `--type` is absent or `browser`, the existing code path runs unchanged, byte for byte.
- Any other value routes to `session.tabs.listAll`, `close` or `activate`.
- New verbs: `tab focus <id>` (`session.tabs.activate`), `tab move <id> --to-group <g> [--index n]` (`session.tabs.move`), `tab pin|unpin <id>` (`session.tabs.setTabProps {isPinned}`). These default to `--type all`.

## DO-NOT-CHANGE fences

- **`src/shared/runtime-rpc-envelope.ts` stays `.strip()`, and success and failure keep their field names,** because old clients parse it and remote-wire-compatibility Rule 1 depends on it.
- **The legacy CLI families' handlers and specs** (terminal, browser, orchestration, worktree, automations, ledger, and the others under `src/cli/handlers/*`) are out of scope. They change only through `index.ts` exit-code mapping and `reportCliError`. Their behavior is relied on by bundled skills and mixed-version scripts.
- **`denyRpcMethodForCaller` and the mobile allowlist** (`runtime-rpc-mobile-method-*.ts`) get no new entries. Mobile exposure is a deferred decision, and adding a method there widens phone access.
- **`agentSession.*` handlers and their `MutationEnvelope` semantics** are not modified. The CLI is a client of them, and they back desktop and mobile chat.
- **`C/rpc-params-catalog.generated.ts`** is never hand-edited. Regenerate it with `node config/scripts/generate-rpc-params-catalog.mjs` if params change.

## Always / Ask / Never

- **Always:** import param schemas from `C/` and never redeclare them. Keep `src/shared/public-rpc/**` Electron-free. Every new error a public method throws is a `PublicRpcError` with a reason. macOS only. Folder workspaces must work wherever a worktree selector is accepted.
- **Ask:** before widening any DO-NOT-CHANGE region, adding a method to the mobile allowlist, or changing an existing command's default behavior.
- **Never:** gate requests that lack `publicContract`. Run the full test suite or `pnpm typecheck` locally. Add Windows or Linux branches.

## Cross-cutting

Back-links: [Key decisions & rationale](./logic.md#key-decisions--rationale), [Scope & non-goals](./logic.md#scope--non-goals).

- **Security:** access stays owner-scoped over the socket. `confirm` and `publicContract` are honored for every caller kind, including remote WS, because the gate is server-side. The caller hint is advisory attribution only, never authorization.
- **Observability:** every public mutation emits an `activity.recorded` event and an activity row.
- **Compat:** a new CLI on an old runtime gets `method_not_found`, which normalizes to `unavailable/capability_missing` with `next: [{command:'quirky status', why:'runtime predates public-cli.v1; update it'}]`. An old CLI on a new runtime is unaffected, because it sends no new fields.
- **Rollback:** everything is additive. Reverting the CLI leaves the server methods unused.

## Testing strategy

Run one file at a time locally (`QUIRKY_ALLOW_LOCAL_TESTS=1 pnpm exec vitest run --config config/vitest.config.ts <file>`), after `pnpm run build:packages`. The PR runs everything else.

- **U1:** `src/main/runtime/rpc/public-method-coverage.test.ts` checks that every method is classified, there are no stale entries, public params are identical to the catalog, and every public spec's `result` parses a recorded sample from the handler test fixtures where they exist.
- **U2:** `src/main/runtime/rpc/public-contract-gate.test.ts` checks the preview without confirm, confirm, `ask` approve, decline and timeout, and that a non-`publicContract` request is untouched.
- **U3:** `src/cli/public-cli/generated-commands.test.ts` (positional and flag mapping, hand-written precedence), `src/cli/public-cli/exit-codes.test.ts` (the table and legacy normalization), and `schema-command.test.ts`.
- **U4:** `src/main/runtime/public-events/public-event-bus.test.ts` (seq, topics, gap, bound), `src/cli/runtime/streaming-transport.test.ts` (multi-frame, keepalive, abort), and the unix transport streaming test next to `unix-socket-transport`.
- **U5:** `src/main/runtime/rpc/methods/ui-actions.test.ts` (no_ui, not_applicable, timeout, destructive preview), `src/renderer/src/lib/app-command-dispatch.test.ts` (the `rpc` source and reason), and `src/shared/keybindings/action-catalog.test.ts` (coverage).
- **U6:** `src/cli/handlers/chat.test.ts` (envelope construction, respond mapping, send --wait settle).
- **U7:** extend `src/cli/handler-group-manifest.test.ts` for the new groups.
- **U8:** `src/main/runtime/approvals/approval-gate.test.ts` and `src/main/runtime/activity-trail/activity-trail-store.test.ts`. The renderer UI change needs the plugin `ui-scoreboard.json` update where CI's typecheck requires it.
- **Scripted agent scenario (success criterion):** `tests/e2e/agent-drives-quirky.spec.ts` runs the CLI-only flow from logic.md Scope. It runs on CI, not locally.

## Non-goals

- Mobile allowlist changes, MCP, scoped tokens, a durable event log, typed git and PR commands.
- Migrating legacy families onto generated metadata.
- Result-schema validation in production dispatch. It happens in tests only, to avoid runtime cost and false failures on additive fields.

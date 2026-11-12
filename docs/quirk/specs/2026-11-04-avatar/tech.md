# Avatar: tech spec

**Status:** Draft for build (SDD run `avatar`, 2026-11-04)  
**Logic spec:** [logic.md](logic.md) (Approved). Behavior, rationale and scenarios live there; this file says where code goes and what must hold.

All paths are relative to the repo root. `SC-n`, `R-n`, `C-*` and `A-*` refer to headings and rows in [logic.md](logic.md).

## Architecture

The avatar has three layers. Host additions come first because every later part depends on them.

1. **Host additions** (packages and first-party plugins). Each is generic, names no avatar concept, and has its own tests.
   - **H1 Tool gate channel**: a blocking request/response path from an agent hook to one daemon-side plugin provider. It adds a new `/gate/` HTTP route next to `/hook/`, a new daemon contribution kind `tool-gate`, and a new shim `$QUIRKY_HOME/bin/quirky-gate`. Backs SC-10, SC-12, SC-32 and A-host-channel.
   - **H2 Keep-awake and power state**: `context.hostPower.keepAwake(reason)` and `context.hostPower.powerState()` on top of IOKit power assertions. Backs SC-9 and A-keep-awake.
   - **H3 Window-bar items**: a new UI contribution kind `window-bar-item`, rendered by `packages/ui/src/shell/WindowBar.tsx`. Backs C-pill and R-44.
   - **H4 Worktree surfaces**: `quirky.worktree` loads avatar status alongside `heimdallStatus`, adds an `ActivityMark` ring and `Avatar · ` name prefix, and uses `useAvatarHandoff` to discover the loaded hand-off command for row menus and the multi-selection bulk bar. Backs R-46 and SC-5.
   - **H5 Structured runners**: `quirky.structured` gains `toolPolicy: 'deny-all'`, per-turn context usage reporting, and pi and omp rpc runners. Backs C-brain, R-36 and R-38.
2. **Plugin `plugins/quirky.avatar`**: the gate, store, journal, outbox, brain, supervisor, shipping, CLI and UI. Backs C-plugin.
3. **Gate hooks per agent**, installed by the avatar: a Claude launch-hook, a Codex `hooks.json` entry, and a pi/omp extension file. Each calls `quirky-gate`, or for pi/omp, the `/gate/` route directly.

**Request path.** The worker's hook runs `quirky-gate <agent>` (pi/omp use an in-process `fetch`).
- If no supervision marker exists for that session, the shim exits with a passthrough answer at once. Unsupervised sessions never block and never depend on the daemon.
- If a marker exists, the shim POSTs to `/gate/<agent>`. The daemon calls the single `tool-gate` provider (`quirky.avatar`) with a deadline.
- The provider runs `decide()` (pure: floor core, switches, level, fixed rules) and, only if nothing decided, the brain's judgment.
- The shim prints the per-agent encoding of the decision. When the daemon is unreachable or the request times out, it prints a deny with a retry reason (SC-12).

**Event path.** The avatar subscribes to:
- `quirky.agent-status/settled` and `quirky.agent-status/changed`
- `quirky.ask/resolved`
- `quirky.structured/message` and `quirky.structured/settled` (the brain)
- `quirky.hosting` refresh events

It also runs a watchdog job. Each event is appended to the journal first, then delivered to the brain in journal order (R-38).

**Technologies.** Bun and TypeScript, the plugin API in `packages/protocol/src/plugins.ts`, the SQLite plugin store (`context.openStore`), React UI through `@quirky/ui`, and bun:ffi IOKit for power.

## Code references

### Host: H1 tool gate channel
- `packages/protocol/src/rpc.ts:294`: add `GATE_PATH_PREFIX = '/gate/'` beside `HOOK_PATH_PREFIX`, reusing `HOOK_TOKEN_HEADER`.
- `packages/protocol/src/plugins.ts`: add the `ToolGateRequest`, `ToolGateDecision` and `ToolGateProvider` types (pinned under H1 tool gate in Contracts).
- `packages/daemon/src/plugins/kinds.ts:16` `ALLOWED_FIELDS`: add `'tool-gate': ['description', 'agents']`. Rejecting a second plugin that declares `tool-gate` is done where contributions are registered across plugins (`packages/daemon/src/plugins/registry.ts`).
- `packages/daemon/src/server.ts:51` (`handleHook`): add a sibling `handleGate` on the same token check, routed for paths starting with `GATE_PATH_PREFIX`.
  - It parses JSON into `ToolGateRequest` and calls `core.requestToolGate(request)`.
  - It returns the `ToolGateDecision` as JSON with HTTP 200.
  - It answers `{"decision":"unavailable","reason":…,"encoded":null}` when no provider is active.
  - A malformed body gives 400, and the shim treats 400 as deny.
- `packages/daemon/src/service.ts:86` (next to `deliverToPlugins`): add `requestToolGate(request)`.
  - It finds the one active provider of a `tool-gate` contribution through the plugin host, and races it against `request.deadlineMs`.
  - A timeout or a provider error resolves to `unavailable`.
  - It never throws to the HTTP layer.
- `packages/daemon/src/launch.ts:179` (`QUIRKY_HOOK_SCRIPT`, written at `:481`): add `QUIRKY_GATE_SCRIPT`, written to `$QUIRKY_HOME/bin/quirky-gate` next to it, the same way. **Do not modify `QUIRKY_HOOK_SCRIPT`** (see the fences).

### Host: H2 keep-awake and power state
- `packages/daemon/src/native-host-power.ts`: add `IOPMAssertionCreateWithName` and `IOPMAssertionRelease` (assertion type `PreventUserIdleSystemSleep`) and a power-source read (`IOPSCopyPowerSourcesInfo`) through bun:ffi.
- `packages/daemon/src/host-power-contracts.ts` and `host-power.ts` (`HostPowerService`): ref-counted `keepAwake`, plus `powerState`.
- `packages/protocol/src/plugins.ts:113` (`PluginHostPower`): add the members shown in Contracts.

### Host: H3 window-bar items
- `packages/protocol/src/ui.ts:6` `UI_KINDS` and `:9` `CODE_BACKED_KINDS`: add `'window-bar-item'`.
- `packages/daemon/src/plugins/ui-kinds.ts:20` `ALLOWED_FIELDS`: add `'window-bar-item': ['title', 'description', 'order']`, and add it to `TITLE_REQUIRED`.
- `packages/protocol/src/ui.ts:182` (`UiModel`): add `windowBarItems?: UiSlotEntry[]`. It is optional, so existing model fixtures stay valid.
- `packages/daemon/src/plugins/ui-model.ts:414`: build `windowBarItems` from `slot('window-bar-item').sort(byOrder)`.
- `packages/ui/src/plugins/PluginSlot.tsx:19` and `packages/ui/src/plugins/host.ts:166`: include `windowBarItems` in slot lookup.
- `packages/ui/src/shell/WindowBar.tsx`: render every `window-bar-item` through the existing `PluginSlot` mechanism used by `packages/ui/src/shell/StatusBar.tsx:243`, after the new-tab buttons, ordered by `order`.

### Host: H4 worktree surfaces (`plugins/quirky.worktree`)
- `src/useTree.ts`: loads `avatarStatus: AvatarWorktreeStatus | null` alongside `heimdallStatus` through `quirky.avatar/sidebarStatus`. Refreshes on mount, `quirky.avatar/changed`, `plugin.changed` and reconnect; only the latest load applies. A failed method or absent entry gives `null`.
- `src/Tree.tsx`: validates avatar status before adding the name prefix and the existing `ActivityMark`'s `ring` and `title`. The ring is `accent`, or `needs-you` when avatar attention is pending; the mark's state and accessible label remain unchanged.
- `src/useAvatarHandoff.ts`: discovers the prefixed or bare `quirky.avatar/handoff` command through `ui.contributions`, refreshing on plugin changes and reconnect. Returns a callback that executes it with `{ worktreeIds }`, or `null` when unavailable; execution failures show a toast.
- `src/Menu.tsx` and `src/Tree.tsx`: show `Hand off to Avatar…` last in the first menu group only while the callback is available, then pass the row id to it.
- `src/WorktreesSection.tsx`: shares `useAvatarHandoff` with the tree and adds `Hand off…` after `Sleep` in the bulk bar. It hands off selected, shown worktrees without clearing selection.

### Host: H5 structured runners (`plugins/quirky.structured`)
- `runner.ts:43` (`StructuredRunner`): `StructuredStartOptions` gains `toolPolicy?: 'default' | 'deny-all'`. Runners report usage per turn (see Contracts).
- `claude-runner.ts:195`: when `deny-all`, `canUseTool` denies every tool and no MCP servers are passed.
- `codex-runner.ts:7`: when `deny-all`, use approval policy and sandbox values under which every command or patch request is declined by the runner.
- New `pi-runner.ts`: pi and omp in rpc mode (`pi --mode rpc` / `omp --mode rpc`, JSON lines on stdio). It follows the `StructuredRunner` interface and honors `deny-all` by registering no tools, or by blocking `tool_call` when the CLI can't drop them.
- `main.ts`, `quirky-plugin.json`: `create.agent` accepts `'pi' | 'omp'`, and `create.options.toolPolicy` is added to the method schema.

### Plugin `plugins/quirky.avatar` (new)

| Path | Holds |
|---|---|
| `quirky-plugin.json` | id `quirky.avatar`, `apiVersion` `1.2.0`, `activation: startup`, `main`, `ui: dist/ui.js`, `cli: cli.ts`. Dependencies are `quirky.worktree`, `quirky.session`, `quirky.agent-status`, `quirky.agents`, `quirky.ask`, `quirky.checks`, `quirky.git`, `quirky.hosting`, `quirky.structured`, `quirky.heimdall` and `quirky.notifications`. Contributions are listed below. |
| `package.json` | `@quirky/plugin-avatar`, same shape as `plugins/quirky.ask/package.json`. |
| `main.ts` | Thin wiring, like `plugins/quirky.heimdall/main.ts`: provides methods, the `tool-gate`, the launch-hook, jobs and subscriptions. |
| `store-migrations.ts` | SQLite migrations for the tables in Data models. |
| `cli.ts` | `quirky avatar handoff\|status\|report\|log\|take-back [--all]` (R-8). |
| `src/contracts.ts` | Every shared type in Data models. **Created first; other units import from here only.** |
| `src/store.ts` | Typed access over the store; the journal is append-only. |
| `src/gate/classify.ts` | Pure: `classifyCall(call, ctx) → ActionClass[]`. |
| `src/gate/decide.ts` | Pure: `decide(input) → RuleDecision` (floor core → switches → level → fixed rules → `judgment`). |
| `src/gate/service.ts` | The `tool-gate` provider: supervision lookup, Shadow, approvals, late answers, brain judgment with deadline, receipts, journal. |
| `src/hooks/install.ts` | Claude: the `launch-hook` returns `LaunchPatch.jsonArgs['--settings']` with `PreToolUse` and `PermissionRequest` entries (matcher `*`, command `quirky-gate claude`, timeout `judgment-timeout-seconds + 15`, `onFailure: "block"`). It merges with agent-status's `--settings` the same way `plugins/quirky.agent-status/main.ts:16` does. Codex: `PreToolUse` and `PermissionRequest` entries in `$CODEX_HOME/hooks.json`, falling back to `~/.codex/hooks.json`, installed on activation. pi/omp: the extension file `quirky-avatar-gate.ts` written into the same `extensions/` dirs `piFamilyInstaller` uses (`plugins/quirky.agent-status/src/install/other-installers.ts:44`). Plus supervision markers. |
| `src/hooks/encode.ts` | Pure: `encodeDecision(agent, event, decision) → string` for stdout or the extension return. |
| `src/hooks/pi-extension.ts` | Generated source of the pi/omp gate extension, like `plugins/quirky.agent-status/src/install/sources/pi.ts`. |
| `src/gatecheck.ts` | The gate check (R-9, R-41). |
| `src/mandate.ts` | Validation and normalization of mandates and hand-off input shared by the sheet, CLI and methods. |
| `src/handoff.ts` | Hand-off, eligibility (R-4), take-back (R-49), briefing (R-11), snapshot rule (R-6). |
| `src/brain/session.ts` | Brain lifecycle: create with `toolPolicy: 'deny-all'`, rotation (R-38), restart (R-37). |
| `src/brain/prompt.ts` | Pure: rebuild prompt (R-39), judgment prompt (R-18), event prompt. |
| `src/brain/actions.ts` | Pure: parse and validate `BrainAction[]` from brain output; reject anything else. |
| `src/brain/dispatch.ts` | Executes validated actions through public methods only, with level and Shadow enforced. |
| `src/supervisor/events.ts` | Subscriptions, event to journal, wake queue, watchdog job. |
| `src/supervisor/stuck.ts` | Pure stuck-signal detection (R-26). |
| `src/supervisor/ladder.ts` | Nudge, restart, restart, park (R-27). |
| `src/supervisor/stepin.ts` | Interrupt and redirect through the terminal, never over unsent user text (R-43, R-47). |
| `src/supervisor/records.ts` | Session-record versus receipts check (R-40), Codex hosted tools (R-42), hook-config file watch (R-41). It tails the session file from `providerSession.transcriptPath` (`quirky.session/show`) every 15 s. Claude JSONL `tool_use` blocks, Codex JSONL `function_call` and `web_search_call` / `image_generation_call`, and pi/omp JSONL `toolCall` entries are each matched to receipts by fingerprint within ±60 s. Reuse `parseProviderTranscriptLine` in `plugins/quirky.agent-status/src/transcript.ts` where it already covers the format. |
| `src/shipping/donewhen.ts` | Runs done when via `quirky.checks/run` (R-25). |
| `src/shipping/review.ts` | Cross-family reviewer (R-29), finding intake and judgment records (R-30). |
| `src/shipping/mergebar.ts` | Pure merge bar (R-31, R-32) and shared-goal order (R-33). |
| `src/shipping/outbox.ts` | Outbox record-then-run, crash recovery against GitHub (R-34). |
| `src/sanitize.ts` | Pure: strip hidden markup from review, PR and CI text (R-24). |
| `src/keepawake.ts` | Holds or releases `hostPower.keepAwake` from worktree states (R-12). |
| `src/notify.ts` | Pure "everything waits on you" rule plus a single `context.notify` (R-35). |
| `src/report.ts` | Pure report model: needs-you, stories, summary (R-45). |
| `src/ui.tsx` | UI activation: window-bar pill, panel, view, sheet overlay, settings section, commands. |
| `src/ui/*.tsx` | `Pill`, `Panel`, `Sheet`, `AvatarView` (Live, Report, Log), `DecisionTrace`, `SettingsSection`. |
| `test/` | See the Testing strategy section. |

Manifest contributions:
- `method`: listed in Contracts.
- `event`: `changed`.
- `tool-gate`: `gate`.
- `launch-hook`: `gate-hooks`, for `claude`, `codex`, `pi` and `omp`.
- `job`: `watchdog`, `records`.
- `cli-command`: `avatar`.
- `window-bar-item`: `pill`.
- `panel`: `panel`, with `defaultSlot: left-bottom`.
- `view`: `avatar`.
- `overlay`: `sheet`.
- `command`: `handoff` and `open-report`.
- `setting`: listed in Data models.
- `settings-section`: `avatar`.
- Register `quirky.avatar` in `scripts/ui-lint-plugins.json`.

## Contracts and interfaces

### H1 tool gate (host)

`CONTRACT:` (in `packages/protocol/src/plugins.ts`)
```ts
type ToolGateRequest = { agent: string; sessionId: string; event: string; deadlineMs: number; payload: unknown }
type ToolGateDecision = { decision: 'allow' | 'deny' | 'passthrough' | 'unavailable'; reason: string; encoded: string | null; exitCode?: number }
type ToolGateProvider = (request: ToolGateRequest, signal: AbortSignal) => Promise<ToolGateDecision>
// context.provide('tool-gate:<pluginId>/<name>', provider)
```
- `deadlineMs` is set by the shim or extension. It is `(judgment-timeout-seconds + 5) * 1000` for Claude and Codex. For omp it is 25000, under omp's 30-second `tool_call` budget, and the avatar's judgment deadline for omp is 20 s.
- `encoded` is the exact stdout text the agent must see. `exitCode` defaults to 0.
- Wire format (as built):
  - The POST body is the raw agent payload. `session`, `event` and `deadline` (ms) go in the query string.
  - When `event` is absent, the daemon falls back to the payload's `hook_event_name`.
  - `deadline` defaults to 30000 and is capped at 10 minutes.
  - If the `tool-gate` declaration lists `agents` and the request's agent isn't in it, the daemon answers `unavailable` without calling the provider.
- The shim's deadline comes from `quirky-gate <agent> [deadline-ms]`, then `$QUIRKY_GATE_DEADLINE_MS`, then 30000. The avatar's hook installer passes it as the second argument.
- `Core.requestToolGate` gets its provider through `core.setToolGateProvider(...)`, which is wired in `packages/daemon/src/plugins/runtime.ts`.
- The daemon passes `payload` through untouched. The provider interprets it.
- The manifest parser rejects a second plugin declaring `tool-gate`. At runtime, at most one provider is active, and the first registered wins.
- `requestToolGate` resolves to `{decision:'unavailable', reason}` when there is no provider, the provider throws, or `deadlineMs` elapses. In that last case it also aborts `signal`. It never resolves to `allow` on any failure path.
- `quirky-gate <agent>` (shell) behaves as follows:
  - It reads stdin and `$QUIRKY_SESSION_ID`.
  - With no marker at `$QUIRKY_HOME/plugin-data/quirky.avatar/supervised/$QUIRKY_SESSION_ID`, it prints the agent's passthrough answer and exits 0.
  - Otherwise it POSTs to `/gate/<agent>?session=…` with `curl -m <deadline+5>`.
  - It prints the encoded decision the daemon returns. The daemon returns the final agent-specific stdout string in `encoded`, so the shell never builds JSON.
  - On any curl failure it prints the agent's **deny** encoding with the reason `"Quirky's avatar gate is unavailable; try again shortly."` and exits with the agent's blocking code: exit 2 for Claude and Codex, with the reason on stderr where the agent requires it.

### H2 power (host)

`CONTRACT:`
```ts
type PluginHostPower = { /* existing */ keepAwake(reason: string): () => void; powerState(): { onBattery: boolean; externalDisplay: boolean | null } }
```
- `keepAwake` is ref-counted per plugin activation. The disposer is idempotent, and revoking a plugin releases its holds.
- `powerState` returns `{onBattery:false, externalDisplay:null}` where unsupported.

### H5 structured runner (host)

`CONTRACT:`
```ts
type StructuredStartOptions = { /* existing */ toolPolicy?: 'default' | 'deny-all' }
// structured message `data.usage?: { contextTokens: number; contextWindow: number | null }` on every assistant turn end
```
- With `deny-all`, no tool runs, and any tool request is answered "denied" without an ask.

### Avatar methods (`quirky.avatar/<name>`)

| Method | Params, then result | Notes |
|---|---|---|
| `eligibility` | `{}`, then `SheetRow[]` | Every local worktree, grouped. `reason` is set when it can't be selected (R-4). |
| `handoff` | `{items: HandoffInput[]}`, then `{results: {worktreeId, ok, error?}[]}` | Validates each item independently, and one failing item doesn't block the others (R-3). Re-handing off an already handed-off worktree updates its mandate (R-4). |
| `takeBack` | `{worktreeIds: string[]} \| {all: true}`, then `{results}` | R-49. |
| `status` | `{}`, then `{handoffs: WorktreeSummary[], needsYouCount}` | Feeds the pill and panel. |
| `sidebarStatus` | `{}`, then `Record<worktreeId, AvatarWorktreeStatus>` | Feeds H4. |
| `report` | `{}`, then `ReportModel` | R-45. |
| `log` | `{worktreeId?, limit?, before?}`, then `JournalEntry[]` | |
| `resolveNeed` | `{needId, action: NeedAction, text?}`, then `{ok}` | One-click answers. Accepted actions are listed under `NeedAction` in Data models. |
| `mandate` | `{worktreeId}`, then `Mandate \| null` | Prefill after take-back (R-49). |
| `settings` / `setSettings` | — | Settings → Avatar. |

- `handoff`:
  - Pre: each item's `worktreeId` is an eligible `SheetRow`, or one already handed off. `goal` and `doneWhen` are non-empty. `level` is a `Level`.
  - Post: the mandate is stored, the marker is written for the live session if one exists, state is `checking`, and the gate check is started without awaiting. A missing session starts the row's agent through `supervisor.startSession` with the mandate as its prompt.
  - Errors are per item and never thrown: `not-eligible: <reason>`, `invalid: <field>`.
- `takeBack`:
  - Pre: none, and unknown or not-handed-off ids are ignored.
  - Post:
    - markers are removed
    - in-flight gate requests are resolved with passthrough
    - `recorded` outbox rows are cancelled
    - open needs are closed with resolution `handed-back` and listed in `handedBackWith`
    - `handoffs.active = 0`
    - the mandate is kept
    - keep-awake is re-evaluated
  - Agents are never stopped.
- Every mutating method writes a journal entry in the same store transaction as its state change.
- Methods called from the brain dispatcher go through the same functions. **The brain has no extra authority.**

### In-process services (`src/contracts.ts`, `src/app.ts`)

`main.ts` builds one `AvatarApp`. It registers every manifest method by delegating to `app.services.*`, then calls each module's `register(app)`. Each module replaces its own stub service in `app.services`.
- The stubs live in `src/app.ts`.
- Every stub method resolves to an `unavailable` or empty result, and never throws.
- This is what lets modules be built and tested on their own against fakes of the others.

`CONTRACT:`
```ts
type AvatarBusEvent = { type: 'journal'; entry: JournalEntry } | { type: 'needs-changed' } | { type: 'state-changed'; worktreeId: string; state: WorktreeState } | { type: 'handoffs-changed' }
type AvatarApp = { context: PluginContext; store: AvatarStore; settings(): AvatarSettings; services: AvatarServices; journal(worktreeId: string | null, kind: JournalKind, data: Record<string, unknown>): JournalEntry; needs: NeedsQueue; on(listener: (e: AvatarBusEvent) => void): () => void; emit(e: AvatarBusEvent): void; now(): number }
type NeedsQueue = { add(item: Omit<NeedsYouItem, 'id' | 'createdAt' | 'resolvedAt' | 'resolution'>): NeedsYouItem; list(opts?: { worktreeId?: string; open?: boolean }): NeedsYouItem[]; close(id: string, resolution: string): void }
type GateService = { decideCall(call: ToolCall, deadlineMs: number, signal: AbortSignal): Promise<{ outcome: GateOutcome; reason: string; encoded: string }>; writeMarker(sessionId: string, worktreeId: string, level: Level): void; removeMarker(sessionId: string): void; gateCheck(worktreeId: string): Promise<{ ok: boolean; reason: string }>; approveOnce(needId: string): void; resolveInFlight(worktreeId: string, outcome: 'passthrough'): void; noteObservedCall(sessionId: string, fingerprint: string, at: number): void; hasReceipt(sessionId: string, fingerprint: string, aroundMs: number, windowMs: number): boolean }
type HandoffService = { handoff(items: HandoffInput[]): Promise<{ worktreeId: string; ok: boolean; error?: string }[]>; takeBack(sel: { worktreeIds: string[] } | { all: true }): Promise<{ worktreeId: string; ok: boolean; handedBackWith: string[] }[]>; eligibility(): Promise<SheetRow[]>; mandate(worktreeId: string): Mandate | null; active(): { worktreeId: string; sessionId: string | null; state: WorktreeState; mandate: Mandate }[]; setState(worktreeId: string, state: WorktreeState, note: string): void; resolveNeed(needId: string, action: NeedAction, text?: string): Promise<{ ok: boolean; error?: string }> }
type BrainService = { judge(call: ToolCall, mandate: Mandate, deadlineMs: number): Promise<{ decision: 'allow' | 'deny' | 'held'; reliedOn: string; reason: string } | 'timeout' | 'unavailable'>; wake(): void; ready(): boolean }
type SupervisorService = { send(worktreeId: string, text: string): Promise<{ sent: boolean; reason?: string }>; stepIn(worktreeId: string, text: string): Promise<{ sent: boolean; reason?: string }>; startSession(worktreeId: string, note: string): Promise<{ sessionId: string | null; error?: string }>; restartWorker(worktreeId: string, note: string): Promise<{ sessionId: string | null; error?: string }>; park(worktreeId: string, story: string): void; recordDenial(worktreeId: string, countsAsDenial: boolean): void }
type ShippingService = { runDoneWhen(worktreeId: string): Promise<{ pass: boolean; output: string }>; startReview(worktreeId: string): Promise<{ started: boolean; reason?: string }>; judgeFinding(worktreeId: string, findingId: string, valid: boolean, reason: string): Promise<void>; openPr(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; merge(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; mergeMainIn(worktreeId: string): Promise<{ ok: boolean; reason?: string }>; reconcileOutbox(): Promise<void>; cancelOutbox(worktreeId: string): number }
type ReportService = { report(): ReportModel; status(): { handoffs: { worktreeId: string; name: string; state: WorktreeState; level: Level }[]; needsYouCount: number }; sidebarStatus(): Record<string, AvatarWorktreeStatus> }
type AvatarServices = { gate: GateService; handoff: HandoffService; brain: BrainService; supervisor: SupervisorService; shipping: ShippingService; report: ReportService }
type AvatarSettings = { defaultLevel: Level; switches: Switches; houseRules: string[]; allowCommands: string[]; denyCommands: string[]; deployCommands: string[]; brainAgent: AgentKind; brainModel: string | null; judgmentTimeoutSeconds: number }
```
- `src/fingerprint.ts` (the seam) exports `callFingerprint(agent: string, worktreeId: string, toolName: string, toolInput: unknown): string`, which is sha256 hex over the canonical JSON with object keys sorted. Gate receipts and `records.ts` both use it, and nothing else computes fingerprints.
- `app.journal` appends a row and emits `{type:'journal'}`. `app.needs.add` and `close` emit `needs-changed`. `HandoffService.setState` emits `state-changed`.
- Each module exports `register(app: AvatarApp): void | (() => void)`, at these paths:

  | Module | Path | Owns |
  |---|---|---|
  | Gate | `src/gate/service.ts` | `gate` |
  | Handoff | `src/handoff.ts` | `handoff` |
  | Brain | `src/brain/session.ts` | `brain` |
  | Supervisor | `src/supervisor/events.ts` | `supervisor` |
  | Shipping | `src/shipping/index.ts` | `shipping` |
  | Report | `src/report.ts` | `report` |
  | Keep-awake | `src/keepawake.ts` | bus listener |
  | Notify | `src/notify.ts` | bus listener |

- UI composition: `src/ui.tsx` (the seam) mounts `src/ui/Pill.tsx`, `Panel.tsx`, `AvatarView.tsx`, `Sheet.tsx` and `SettingsSection.tsx`, each a default-exported React component taking `{context: UiPluginContext, input?: unknown}`. Feature tasks replace the stub components.

### Gate decision path (`src/gate/decide.ts`)
- `decide()` is pure and total. Given the same `DecideInput` it returns the same `RuleDecision`.
- It evaluates steps in the fixed order `floor-core`, `floor-switch`, `level`, `fixed-rules`. The first step that returns non-`pass` wins. If all four pass, it returns `{outcome:'judgment'}` (R-14).
- Outcomes:

  | Step | Possible outcomes |
  |---|---|
  | `floor-core` | `held` |
  | `floor-switch` | `held` |
  | `level` | `deny`, never `held` (SC-10) |
  | `fixed-rules` | `allow` or `deny` |

- The trace lists every step evaluated, with its result (SC-11 log entry).
- Floor core holds any write, delete or move whose path resolves outside every handed-off worktree. It also holds any read or write of a credential path or credential command (`~/.ssh`, `~/.aws`, `~/.config/gh`, keychain `security`, `.env*` outside the worktree, `gh auth`).
- Switches:

  | Switch | What it covers |
  |---|---|
  | `messaging` | Comments or replies to humans: `gh pr comment`, review replies, Slack or mail CLIs. |
  | `historyRewrite` | `push --force*`, `push --delete`, `push :branch`, rebase of a pushed branch. |
  | `deploys` | Deploy and migrate commands from the house-rule pattern list. |

- Level gates by action class:

  | Level | Action classes allowed |
  |---|---|
  | `local` | No network-outward action. |
  | `own-branch` | Adds a push to the worktree's own branch and a draft PR. |
  | `full` | Adds PR ready, merge, and pushes to the default branch only through merge. |

- Fixed rules:
  - Allow: reads, edits inside the worktree, and tests and builds. The default command patterns come from the house-rule settings, extendable.
  - Deny: download piped into a shell (`curl|wget … | (ba|z)?sh`), skipping git hooks (`--no-verify`, `core.hooksPath`), and edits to agent hook or permission files (`.claude/settings*.json`, `.codex/**`, `~/.pi/**/extensions/**`, `~/.omp/**/extensions/**`, `hooks.json`).
- Guidelines can't change any of this. Only `Mandate.level` and `Mandate.switches` from the sheet or CLI feed `decide()` (R-24).

### Gate service (`src/gate/service.ts`)

Each request runs these steps in order:
1. Resolve the supervised worktree from `sessionId`. Unsupervised gives passthrough.
2. Record a receipt keyed by `callFingerprint = sha256(agent, worktreeId, toolName, canonicalJSON(toolInput))`.
3. An unused allow-once approval for the same fingerprint gives allow, and marks the approval used (R-21).
4. A remembered late brain answer for the same fingerprint gives that answer (R-19).
5. Run `decide()`.
6. If the outcome is `judgment`, ask the brain with a deadline of `deadlineMs - 5000`. On timeout, record `{fingerprint, pending:true}` and answer deny with reason `retry` and `countsAsDenial:false`.
7. In Shadow, whatever the path, return passthrough and journal `wouldHave` (R-20).
8. A `held` outcome creates a needs-you item with `allow-once` and `deny`.

On a take-back while a request is in flight, the provider resolves it with passthrough.

`CONTRACT:` pure inputs (`src/contracts.ts`):
```ts
type ClassifyContext = { worktreePath: string; handedOffPaths: string[]; defaultBranch: string; ownBranch: string; home: string; allowCommands: string[]; denyCommands: string[]; deployCommands: string[] }
type DecideInput = { call: ToolCall; classes: ActionClass[]; mandate: Mandate; switches: Switches; level: Level; ctx: ClassifyContext }
```
- `classifyCall(call, ctx)` returns a non-empty `ActionClass[]`, with `['other']` when nothing matches.
- A Bash command is split on `&&`, `||`, `;` and `|`, and every part is classified, so the classes of a compound command are the union.
- File tools (`Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, Codex `apply_patch`, pi `read`/`edit`/`write`) classify by resolved path against `ctx`.
- `decide(input)` never throws.

### Gate check (`src/gatecheck.ts`, R-9, R-41, SC-6)
- **Marker first.** At hand-off the marker is written before the check, so every call is gated from the first moment and the worktree's state is `checking`. A failed check removes the marker.
- **Static step** (synchronous, per agent). A failure here fails the check at once.

  | Agent | The check passes when |
  |---|---|
  | Claude | The session's launch record (`quirky.session/show` launch args) contains the avatar's `--settings` with a `PreToolUse` command running `quirky-gate`, and `claude --version` is at least `2.1.295` (`onFailure: block`, A-claude-hook). |
  | Codex | The avatar's entries for `PreToolUse` and `PermissionRequest` are present in `$CODEX_HOME/hooks.json`. |
  | pi and omp | The avatar's extension file is present in the agent's `extensions/` dir, and its mtime is older than the session's start. |

  An agent started before the hook was installed fails here with the reason `"started before the avatar's hook was installed"`.
- **Dynamic step.** The first tool call the worker makes after hand-off must produce a receipt from that `sessionId`.
  - `records.ts` reports tool calls it sees in the session record. If one has no receipt within 10 s, the check fails with the reason `"tool calls are not reaching the gate"`. That covers untrusted Codex hooks and hooks disabled by repo settings.
  - Until that first call, the state stays `checking`, but the worker runs, since every call is gated anyway.
- **On pass:** the state moves to `briefing`.
- **On fail:**
  - Remove the marker.
  - Set state `gate-failed`.
  - Add a need `gate-failed` with the action `restart-to-handoff`. That action calls `supervisor.restartWorker`, which relaunches through the avatar's launch-hook, then re-runs the check.
  - No other worktree is touched.
- **R-41 re-check.** `records.ts` watches the worktree's `.claude/settings.json` and `.claude/settings.local.json`, plus `$CODEX_HOME/hooks.json`, `.codex/` and `<agent dir>/extensions/` for pi/omp. Any change re-runs both steps. Only a failure stops the worker, through `stepIn`, and moves it to `gate-failed`.
- **Codex coexistence.** The avatar's `hooks.json` entries are identified by a command containing `quirky-gate`. Install and remove touch only those entries and leave every other entry byte-for-byte unchanged. `plugins/quirky.agent-status`'s `codexInstaller` (`src/install/claude-json.ts:158`) is not modified. A test asserts that its install and remove leave `quirky-gate` entries intact.
- **Claude older than 2.1.295.** The sheet row for that worktree is ineligible, with the reason `"Claude is too old to fail closed; update Claude"`.

### Brain (`src/brain/*`)
- The brain is one `quirky.structured` session, created with `toolPolicy: 'deny-all'`, `lifetime: 'plugin'`, and the agent and model from settings.
- Each wake sends one event prompt. The brain must answer with exactly one fenced JSON block holding `BrainAction[]`. Anything unparseable is journaled and retried once with the parse error; a second failure parks that event as a `brain-error` need.
- Judgment prompts contain only the mandate, the house rules and the call (`toolName`, `toolInput`, `cwd`). **They never contain worker transcript text** (R-18).
- Rotation:
  - Rotation happens after the event in progress is fully dispatched, when `usage.contextTokens >= limit`, where `limit = min(300000, floor(0.8 * contextWindow))`.
  - The avatar stops the session, creates a new one from `prompt.rebuild()`, and journals `rotation {fromTokens}`.
  - Undelivered events stay in the journal queue in seq order and go to the new session first (R-38).
- On session death, judgment requests resolve as `unavailable` until the new session is ready (R-37).

### Brain action dispatch rules (`src/brain/dispatch.ts`)
- **Level and Shadow.** Every action is checked against the worktree's level before it runs. At Shadow, every action except `noop`, `judge`, `askUser` and `proposeMandateEdit` is journaled as `wouldHave` and not executed (R-20).
- **`askUser`** (R-10) creates one `quirky.ask/create` per worktree batch, with `worktree` set and no timeout, and adds a `question` need.
  - `blocks` is a free-text description of the held work. It is sent to the worker as "don't start: <blocks> until answered", and briefing proceeds with the rest.
  - When the ask resolves, the answer reaches the brain as an event.
- **`judgeFinding`** (R-30):
  - **Valid:** sends the finding to the worker.
  - **Invalid from a bot:** enqueues an outbox `thread-reply` with the reason, then calls `quirky.hosting/resolveThread`.
  - **Invalid from a human:** only allowed when `switches.messaging` is on. Otherwise it adds a `merge-blocked` need and the thread stays unresolved (SC-21).
  - **Valid but repeating:** a valid finding sent 3 times without the worker fixing it calls `supervisor.recordDenial` as a stuck signal.
- **`setMergeOrder`** (an extra `BrainAction`: `{type:'setMergeOrder'; sharedGoalId: string; order: string[]}`) stores `SharedGoal.mergeOrder` (R-5, R-33).
  - `mergebar.ts` refuses to merge a shared-goal worktree whose predecessors in `mergeOrder` aren't merged.
  - When the brain hasn't set an order, the default is the sheet's row order.
- **Carrying a change between worktrees** is a `send` to the other worker that names the source branch and commit.
- **`mergeMainIn` conflicts** (BS-samerepo): the outbox result is `{conflict: true, files}`. The worktree goes back to its worker with the conflicted files, and a second conflict on the same files adds a `merge-blocked` need.
- **Flaky checks** (R-31): a required check failing on a SHA where it passed before, or whose failure output matches no file in the diff, gets one `quirky.hosting/rerunChecks {failedOnly:true}`. A second failure goes back to the worker.

### Outbox (`src/shipping/outbox.ts`)
- `enqueue(kind, worktreeId, payload)` inserts a row `{state:'recorded', idempotencyKey}` before any call. `idempotencyKey` is `sha256(kind, worktreeId, headSha, target)`.
- `run(id)` sets `running`, makes the call, then sets `done` or `failed` with the result.
- On activation, every `recorded` or `running` row is reconciled first:
  - `push`: compare the remote branch SHA via `quirky.git/status` or a fetch.
  - `pr`: `quirky.hosting/forBranch {fresh:true}`.
  - `merge`: `quirky.hosting/review` state `merged`.
- Reconciliation marks each row `done` or back to `recorded` without repeating it (R-34).
- Merge calls always pass `expectedHead` equal to the reviewed and checked SHA (R-31).
- Take-back cancels rows in state `recorded` (R-49).

## Data models

All types live in `plugins/quirky.avatar/src/contracts.ts`.

`SCHEMA:`
```ts
type Level = 'shadow' | 'local' | 'own-branch' | 'full'
type SwitchId = 'messaging' | 'historyRewrite' | 'deploys'
type Switches = Record<SwitchId, boolean>
type AgentKind = 'claude' | 'codex' | 'pi' | 'omp'
type Mandate = { worktreeId: string; goal: string; doneWhen: string; doneWhenKind: 'command' | 'prose'; guidelines: string[]; level: Level; switches: Switches; agent: string | null; sharedGoalId: string | null; notes: string; allowSplit: boolean; updatedAt: number }
type SharedGoal = { id: string; goal: string; worktreeIds: string[]; mergeOrder: string[] }
type HandoffInput = Omit<Mandate, 'worktreeId' | 'updatedAt' | 'sharedGoalId'> & { worktreeId: string; sharedGoal?: { id?: string; goal: string } }
type WorktreeState = 'checking' | 'gate-failed' | 'briefing' | 'working' | 'waiting-on-you' | 'checking-done' | 'in-review' | 'merge-ready' | 'merged' | 'pr-ready' | 'committed' | 'parked' | 'done'
type SheetRow = { worktreeId: string; name: string; projectId: string; projectName: string; groupId: string | null; groupName: string | null; agent: string | null; running: boolean; handedOff: boolean; eligible: boolean; reason: string | null; ungatedNote: string | null }
type ToolCall = { agent: AgentKind; sessionId: string; worktreeId: string; cwd: string; toolName: string; toolInput: unknown; event: 'PreToolUse' | 'PermissionRequest' | 'tool_call' }
type ActionClass = 'read' | 'edit-inside' | 'edit-outside' | 'credential' | 'test' | 'build' | 'push-own' | 'push-default' | 'push-force' | 'remote-delete' | 'pr-draft' | 'pr-ready' | 'merge' | 'message-people' | 'deploy' | 'pipe-to-shell' | 'skip-hooks' | 'agent-config' | 'network-read' | 'other'
type StepId = 'floor-core' | 'floor-switch' | 'level' | 'fixed-rules' | 'judgment'
type RuleDecision = { outcome: 'allow' | 'deny' | 'held' | 'judgment'; step: StepId | null; reason: string; reliedOn: string; trace: { step: StepId; result: 'pass' | 'allow' | 'deny' | 'held'; note: string }[] }
type GateOutcome = 'allow' | 'deny' | 'held' | 'retry' | 'passthrough'
type JournalEntry = { seq: number; at: number; worktreeId: string | null; kind: JournalKind; data: Record<string, unknown> }
type JournalKind = 'handoff' | 'take-back' | 'gate' | 'event' | 'brain-action' | 'brain-error' | 'rotation' | 'ask' | 'guess' | 'stuck' | 'ladder' | 'done-check' | 'finding' | 'outbox' | 'skipped-call' | 'sleep' | 'mandate-proposal' | 'notify'
type NeedKind = 'held-call' | 'question' | 'guess' | 'mandate-edit' | 'parked' | 'gate-failed' | 'brain-error' | 'merge-blocked'
type NeedAction = 'allow-once' | 'deny' | 'confirm' | 'redo' | 'review-accept' | 'review-reject' | 'answer' | 'restart' | 'take-back' | 'restart-to-handoff'
type NeedsYouItem = { id: string; worktreeId: string; kind: NeedKind; title: string; detail: Record<string, unknown>; actions: NeedAction[]; createdAt: number; resolvedAt: number | null; resolution: string | null }
type Approval = { id: string; worktreeId: string; fingerprint: string; usedAt: number | null }
type Guess = { id: string; worktreeId: string; question: string; choice: string; confirmedAt: number | null; redoneAt: number | null; commitsSince: string[] }
type OutboxRow = { id: string; worktreeId: string; kind: 'push' | 'pr' | 'pr-ready' | 'merge' | 'merge-main-in' | 'thread-reply'; payload: Record<string, unknown>; idempotencyKey: string; state: 'recorded' | 'running' | 'done' | 'failed' | 'cancelled'; result: Record<string, unknown> | null }
type BrainAction =
  | { type: 'judge'; requestId: string; decision: 'allow' | 'deny' | 'held'; reliedOn: string; reason: string }
  | { type: 'send'; worktreeId: string; text: string }
  | { type: 'answerAsk'; askId: string; answers: Record<string, unknown> }
  | { type: 'askUser'; worktreeId: string; questions: unknown[]; blocks: string }
  | { type: 'guess'; worktreeId: string; question: string; choice: string; reversible: boolean }
  | { type: 'proposeMandateEdit'; worktreeId: string; patch: Partial<Pick<Mandate, 'goal' | 'doneWhen' | 'guidelines' | 'notes'>>; why: string }
  | { type: 'judgeFinding'; worktreeId: string; findingId: string; valid: boolean; reason: string }
  | { type: 'stepIn'; worktreeId: string; text: string }
  | { type: 'startSession' | 'restartWorker'; worktreeId: string; note: string }
  | { type: 'runDoneWhen' | 'startReview' | 'openPr' | 'merge' | 'mergeMainIn'; worktreeId: string }
  | { type: 'park'; worktreeId: string; story: string }
  | { type: 'splitWorktree'; worktreeId: string; branch: string; goal: string }
  | { type: 'setMergeOrder'; sharedGoalId: string; order: string[] }
  | { type: 'noop'; reason: string }
type AvatarWorktreeStatus = { state: WorktreeState; level: Level; needsYou: number }
type ReportModel = { needsYou: NeedsYouItem[]; stories: { worktreeId: string; name: string; switchesOn: SwitchId[]; story: string; handedBackWith: string[] }[]; summary: { decisions: number; allowed: number; denied: number; held: number; guesses: number; sleeps: { at: number; durationMs: number }[]; keptAwake: boolean }; topSkippedCalls: JournalEntry[] }
```

A `proposeMandateEdit` patch can never include `level` or `switches`, and the action parser rejects them (R-23, R-24).

`SCHEMA:` store tables in `store-migrations.ts`:

| Table | Key | Notes |
|---|---|---|
| `mandates` | `worktree_id` | Kept after take-back. |
| `handoffs` | `worktree_id` | `state`, `session_id`, `active`, `handed_off_at`, `taken_back_at` |
| `shared_goals` | `id` | |
| `journal` | `seq INTEGER PRIMARY KEY AUTOINCREMENT` | `delivered_to_brain INTEGER` marks the wake queue. |
| `receipts` | `id` | `fingerprint`, `session_id`, `tool_name`, `at`, `outcome`, `step`. Indexed by `(session_id, at)`. |
| `approvals` | `id` | |
| `late_answers` | `fingerprint` | |
| `needs_you` | `id` | |
| `guesses` | `id` | |
| `outbox` | `id` | `UNIQUE(idempotency_key)` |
| `findings` | `id` | `source` is `reviewer`, `bot` or `skill`. Also `valid`, `reason`, `thread_id`, `commit_sha`. |
| `stuck` | `worktree_id` | `rung` 0–3, counters. |
| `brain_sessions` | `id` | `session_id`, `started_at`, `ended_at`, `end_tokens` |

`CONFIG:` settings (`quirky.avatar/<id>`):

| Setting | Type | Default |
|---|---|---|
| `default-level` | enum | `full` |
| `switch-messaging`, `switch-history-rewrite`, `switch-deploys` | boolean | `false` |
| `house-rules` | string, newline-separated | (empty) |
| `allow-commands` | string | (empty) |
| `deny-commands` | string | (empty) |
| `deploy-commands` | string | (empty) |
| `brain-agent` | enum `claude\|codex\|pi\|omp` | `claude` |
| `brain-model` | string | (empty) |
| `judgment-timeout-seconds` | number | `55` |

Fixed constants that are not settings:
- Stuck thresholds: 15 minutes, 3, 3 and 20.
- The 300k rotation limit.

These are fixed by the logic spec.

`CONFIG:` the supervision marker is the file `<home>/plugin-data/quirky.avatar/supervised/<sessionId>`, mode 0600, containing `{worktreeId, level}`.
- It is written at hand-off once the gate check passes, and on every supervised session the avatar starts.
- It is removed at take-back, at park (the session becomes passthrough), and in Shadow. Shadow keeps the marker with `level: "shadow"`, so the gate still logs.

`SCHEMA:` the per-agent encodings, owned by `src/hooks/encode.ts` and confirmed by the conformance tests:

| Agent | Allow | Deny or held or retry | Passthrough |
|---|---|---|---|
| Claude PreToolUse | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":…}}` | same, with `"deny"` | `{}` |
| Codex PreToolUse | `{}` (allow is completed at PermissionRequest from the receipt) | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}` | `{}` |
| Codex and Claude PermissionRequest | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` when the receipt for the same fingerprint was allow | `behavior:"deny"` with a message | `{}` |
| pi and omp `tool_call` | `undefined` | `{block:true, reason}` | `undefined` |

## DO-NOT-CHANGE fences
- **`plugins/quirky.heimdall/**`**: no edits at all. Live-watcher detection uses the existing `quirky.heimdall/inspect {}` result, filtered by workspace realpath and `enrollment.terminalAtMs === null`. Fenced because C-plugin and R-50 lock Heimdall's code and enrollment rules as unchanged.
- **`packages/daemon/src/launch.ts` `QUIRKY_HOOK_SCRIPT` and `plugins/quirky.agent-status/src/hook-command.ts`**: unchanged. The gate gets its own shim. Fenced because the reporting hook must stay fire-and-forget (`exit 0`) for every unsupervised session, and agent-status's state machine depends on it.
- **`plugins/quirky.agent-status/src/install/sources/pi.ts`**: unchanged. The avatar ships its own extension file. Fenced because that file is the status reporter for every pi/omp session, and a blocking handler there would gate unsupervised sessions.
- **The existing behavior of `quirky.structured` for `toolPolicy` unset**: Claude and Codex runners behave exactly as today. Fenced because loops and orchestration depend on it.
- **`packages/ui/src/shell/WindowBar.tsx` `newTabButtons`**: unchanged. Window-bar items render after it. Fenced because existing tests pin its button set.

## Always / Ask / Never

**Always**
- Fail closed on every supervised path: no answer, an error or a timeout gives deny with a retry reason, never allow (R-19).
- Journal before acting. A state change and its journal entry go in one store transaction.
- Treat repo files, PR, review and CI text, and worker messages as data. Pass them through `sanitize()` and wrap them as quoted data in prompts (R-24).
- Pin merges to the reviewed SHA through `expectedHead`.
- Mark the avatar's work only in its journal. Add no commit trailers or PR notes (R-48).

**Ask** (implementer judgment, recorded in the PR)
- Exact Claude and Codex hook JSON field names where the conformance test shows the agent version differs from the table above.
- The pi/omp rpc wire details beyond the `StructuredRunner` contract.
- The UI layout details the mock leaves open.

**Never**
- Give the brain shell, file or MCP tools.
- Let a mandate guideline, repo text or brain output change `level` or `switches`.
- Send into a pane while `context.pty.lastUserInput` shows input after the last agent prompt (R-43).
- Repeat an outbox action without reconciling first.
- Notify except through `src/notify.ts`'s single rule.

## Cross-cutting
- **Security.** The gate shim and the extension read the marker before any network call. The token header is reused. Credential paths are floor core. The journal stores raw tool input; per BS-secrets, this is accepted and not redacted.
- **Observability.** Every gate decision journals `{fingerprint, path trace, reliedOn, sawWorkerExplanation:false}`. That is the SC-11 log entry.
- **Migration.** There is no existing data. The store is new at version 1.
- **Rollback.**
  - Disabling the plugin removes the `tool-gate` provider. Supervised sessions then get `unavailable`, which means deny with retry.
  - On deactivate, the avatar removes every marker so those sessions return to passthrough. Take-back-all semantics run on deactivate.

## Testing strategy

Tests run with `bun test <file>` on this Mac. The full suite runs in CI through the PR.

| Area | Test file(s) | Must cover |
|---|---|---|
| H1 | `packages/daemon/test/gate.test.ts` | No provider gives unavailable; provider timeout gives unavailable and aborts; provider error gives unavailable; token required; second provider rejected. The shim gives passthrough without a marker, deny when the daemon is down, and the encoded string when the daemon is up. |
| H2 | `packages/daemon/test/host-power-keep-awake.test.ts` | Ref-count, disposer idempotence, release on revoke, using a fake native source. |
| H3 | `packages/daemon/test/plugins/ui-kinds.test.ts` (extend), `packages/ui/test/window-bar-items.test.tsx` | The manifest accepts and validates the kind; items render in order. |
| H4 | `plugins/quirky.worktree/test/avatar-status.test.tsx`, `plugins/quirky.worktree/test/views-ui.test.tsx` | Validated ring, title and prefix without changing activity or attention counts; absent, malformed, failed and stale status loads; command discovery and refresh; conditional row and bulk actions, command ids, errors and preserved selection. |
| H5 | `plugins/quirky.structured/test/tool-policy.test.ts`, `test/pi-runner.test.ts` | `deny-all` refuses tools on fake runners; usage reported; the pi/omp runner against a scripted fake rpc process. |
| decide | `plugins/quirky.avatar/test/decide.test.ts` | Every row of the SC-10 decision table; order precedence; level denies and never holds; guideline text can't change the outcome. |
| classify | `test/classify.test.ts` | Each `ActionClass` from Bash, Edit/Write paths, MCP and pi tool shapes. |
| gate service | `test/gate-service.test.ts` | Allow-once used exactly once (SC-14); late answer reused (SC-12); timeout gives retry and is not a stuck denial; Shadow gives passthrough plus wouldHave (SC-13); take-back resolves an in-flight request as passthrough. |
| encodings | `test/encode.test.ts` | Each table cell. |
| hooks | `test/hooks-install.test.ts` | Claude launch patch contains a PreToolUse `*` matcher with `onFailure: block` when the version allows; Codex hooks.json idempotent install and removal; pi extension source blocks on gate deny and on fetch error. |
| conformance | `test/conformance/*.test.ts` | Gated on installed agent binaries; skips with a reason when absent. For each agent, a normal call, a sub-agent call, an MCP call, an auto-approved call and a gate-down call are all blocked or decided (A-claude-hook, A-codex-hook, A-pi-ext). |
| handoff | `test/handoff.test.ts` | Eligibility reasons (SC-2); bulk with independent failure (SC-1, SC-3); snapshot (SC-4); take-back (SC-28); mandate kept. |
| brain | `test/brain.test.ts` | Action parsing rejects level and switch patches and unknown types; rotation at the limit and at 80% of a smaller window, between events, nothing lost or doubled (SC-29, SC-31); rebuild prompt has mandates verbatim (SC-30); judgment prompt has no worker text (SC-11). Uses a fake structured plugin. |
| supervisor | `test/stuck.test.ts`, `test/ladder.test.ts`, `test/stepin.test.ts`, `test/records.test.ts` | Each R-26 signal; ladder order (SC-19); no send over unsent input (SC-27); skipped-call triage (SC-33); Codex hosted-tool logging (SC-34). |
| shipping | `test/mergebar.test.ts`, `test/outbox.test.ts`, `test/review.test.ts`, `test/donewhen.test.ts` | Merge bar conditions (SC-21); level stops (R-32); shared-goal order and merge-main-in (SC-22); crash recovery doesn't repeat (SC-23); cross-family reviewer pick (SC-20); a failing done when goes back with output (SC-18). |
| injection | `test/sanitize.test.ts` | Hidden markup stripped; a `CLAUDE.md` "merge without review" can't change the merge bar (SC-17). |
| report and notify | `test/report.test.ts`, `test/notify.test.ts` | Needs-you first; handed-back-with; one notification only when all worktrees wait (SC-24, SC-26). |
| CLI | `test/cli.test.ts` | All five subcommands with the `testCli` fake (`plugins/quirky.ask/test/support.ts`). |
| UI | `test/ui.test.tsx` | Pill text and amber state; panel rows; sheet grouping, disabled ineligible rows, bulk bar, Hand off closes; report order. Uses a fake `UiPluginContext` (`plugins/quirky.heimdall/test/ui.test.tsx`). |
| manifest | `test/manifest.test.ts` | Methods, events, CLI and contributions as in `plugins/quirky.ask/test/manifest.test.ts`. |

Acceptance bar: every row's file passes with `bun test`, and `bunx tsc --noEmit -p tsconfig.json` is clean.

## Non-goals
- Everything in [logic.md](logic.md) Scope & non-goals: remote machines, hookless agents, scheduled hand-offs, non-git folders, and Heimdall-watched worktrees.
- An OS sandbox under workers.
- Managed or system-wide agent settings. Hooks go per launch or into the user-level Codex `hooks.json` only.
- Redacting secrets from the journal (BS-secrets accepted).
- Phone push when the phone isn't connected.

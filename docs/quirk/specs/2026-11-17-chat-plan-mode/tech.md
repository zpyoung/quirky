# Claude plan mode in native chat: tech spec

**Status:** Draft. Logic spec: [logic.md](logic.md) (approved).

**Rebase note (2026-11-18), per logic.md's 2026-11-18 amendment.** Main now has a `PermissionModes` type with `labels` and `dangerous` (`packages/protocol/src/chat.ts`), a `ModeTable` per agent in `QS/capabilities.ts` (Claude: `default, acceptEdits, plan, auto, dontAsk, bypassPermissions`), `quirky.structured/settings` for the live mode, `openingModes` and terminal presets in `QS/main.ts` `create`, a drill-in settings popover (`CHAT/SettingsChip.tsx`), and `ChatView` walking `resumedFrom` to show earlier sessions. Where this document conflicts with main, these rules win:
- Keep main's mode tables, labels, `dangerous`, terminal presets, settings RPC and popover structure. Remove every `planMode` flag main added (create param, configure param, `StructuredStartOptions.planMode`, runner settings, the Plan switch). Plan is a row in main's Permissions list.
- The mode set is main's Claude list, not `['default','acceptEdits','auto','plan']`. `PermissionModeName` in the `mode` item widens to `string` (or main's Claude mode union) so `dontAsk` and `bypassPermissions` are representable. `approvedMode` stays `'auto' | 'acceptEdits' | 'default'`.
- `modeReasons` and the four-row rule become: rows come from main's `permissionModes.modes` with main's labels. Auto is disabled when `autoAvailable` is false. On agents whose `permissionModes` is ok but which lack plan (Codex, omp), show their own modes and no Plan row. Plan's reason shows where the Plan row would be for agents with `planMode` not ok and no modes (pi).
- Shift+Tab skips modes listed in `dangerous`, plus disabled modes.
- The UI's current mode is the newest `mode` item. With no `mode` item, use main's `quirky.structured/settings` result.
- `planVersions` runs over the combined messages `ChatView` already loads across `resumedFrom`. The last item per version wins, so the copied `not-answered` item on the new session overrides the old `waiting` one.

All paths are relative to the repo root. `QS` = `plugins/quirky.structured`, `CHAT` = `plugins/quirky.session/src/window/chat`.

## Architecture

Plan mode spans three units, joined by two new chat items in the session journal.

- **Protocol** (`packages/protocol/src/chat.ts`): adds a `plan` item and a `mode` item to `ChatItem`. Both are journaled like every other item, so the UI gets them through the existing `quirky.structured/messages` load and `quirky.structured/message` events, and resume can read them back from the old session's journal.
- **Daemon** (`QS/claude-runner.ts`, `QS/main.ts`, `QS/runner.ts`, `QS/capabilities.ts`, `QS/plan.ts` new): the Claude runner turns `ExitPlanMode` into plan items backed by a silent ask, answers it with allow plus a `setMode` update or a deny with feedback, and journals a `mode` item whenever Claude's mode changes. `main.ts` threads the mode through create, configure, send and resume.
- **UI** (`CHAT/*`): derives the plan versions and the current mode from the message stream in `ChatView`, renders the plan panel (or a sheet drawer when narrow), the header chip and transcript rows, and replaces the Plan switch with one Mode list plus Shift+Tab.

Key library facts (Claude Agent SDK 0.3.284, pinned at `QS/package.json:8`):

- `PermissionMode` includes `'auto'`. `Query.setPermissionMode(mode)` exists.
- `canUseTool` may return `{behavior:'allow', updatedInput, updatedPermissions:[{type:'setMode', mode, destination:'session'}]}`, which approves and switches mode in one reply. `{behavior:'deny', message}` sends `message` to Claude.
- `SDKSystemMessage` (`subtype:'init'`) carries `permissionMode`. `SDKStatusMessage` (`subtype:'status'`) carries optional `permissionMode`. These are the only places Claude reports its mode.
- `ExitPlanModeInput` is typed as `{allowedPrompts?; [k:string]: unknown}`. At runtime the CLI injects `plan` (string) and `planFilePath` (string) into the input. Treat both as untrusted `unknown`.
- `Query.initializationResult()` returns `models: ModelInfo[]`, and `ModelInfo.supportsAutoMode?: boolean` says whether Auto is available for a model.

## Code references

| File | Symbol | Change |
|---|---|---|
| `packages/protocol/src/chat.ts:11-33` | `ChatItem` | add `plan` and `mode` variants (Schemas) |
| `QS/capabilities.ts:13` | Claude `permissionModes.modes` | becomes `['default','acceptEdits','auto','plan']` |
| `QS/runner.ts:52,55,61,64-81` | `StructuredLaunchOptions`, `StructuredStartOptions`, `StructuredSettings`, `StructuredRunner` | add `permissionMode`, `planVersion`, `lastPlanText` to start options; drop `planMode` from settings; add optional `planFeedback` and `autoAvailable` |
| `QS/runner.ts:36` | `StructuredContext.createAsk` options | add `silent?: boolean` |
| `QS/claude-runner.ts:26-32` | `ClaudeQuery` | add optional `initializationResult?()` |
| `QS/claude-runner.ts:82-97` | `Running` | replace `settings.permissionMode` + `planMode` with `mode`; add `autoAvailable`, `planVersion`, `lastPlanText`, `pendingPlan` |
| `QS/claude-runner.ts:228-247` | `launch()` | seed and pass `permissionMode` from start options instead of hardcoded `'default'` |
| `QS/claude-runner.ts:286-306` | `applySettings()` | single mode; resolves a pending plan as not answered before switching |
| `QS/claude-runner.ts:343-383` | `canUseTool()` | new `ExitPlanMode` and `EnterPlanMode` branches |
| `QS/claude-runner.ts:437-495` | `journal()` | read `permissionMode` from `system/init` and `system/status` |
| `QS/plan.ts` (new) | `planText`, `planSpec`, `planDecision` | plan file reading, the plan ask spec, and outcome mapping |
| `QS/main.ts:545-627` | `createAsk` | honour `silent` (skip the `ask` item) |
| `QS/main.ts:905-916` (allowed keys) and `create` handler | `create` | accept top-level `permissionMode`; `options` and `quirky.agents/resolveLaunch` untouched |
| `QS/main.ts:1030-1206` | `resume` | restore mode, plan version counter and pending plan from the old journal |
| `QS/main.ts:1222-1311` | `admitAndSend` (called by `send`, `:1315`) | route to `runner.planFeedback` while a plan waits |
| `QS/main.ts:1430-1473` | `configure` RPC | drop `planMode`; validate `permissionMode` against capabilities and auto availability |
| `QS/items.ts:279-352` | `claudeEntriesUnchecked` | drop `ExitPlanMode`/`EnterPlanMode` tool_use activity rows and `system: status` rows that only carry a mode |
| `CHAT/plan.ts` (new) | `planVersions`, `currentMode` | pure derivation from `StructuredMessage[]` |
| `CHAT/PlanPanel.tsx` (new) | `PlanPanel` | panel body, exits, feedback box, notices |
| `CHAT/PlanChip.tsx` (new) | `PlanChip` | header chip |
| `CHAT/ChatView.tsx:133,219,235-263` | `ChatView` | derive plan/mode, mount chip, panel aside or sheet, pass mode to Composer |
| `CHAT/turns.ts:18,63-100,132-173` | `Block`, `groupTurns`, `toBlocks` | global per-version map in `groupTurns` (like `calls`); `toBlocks` emits the `plan` block |
| `CHAT/Turn.tsx:52` | `BlockView` | add `plan` row case |
| `CHAT/controls.tsx:13-15,121-182` | `Picks`, `TurnSettings`, `useTurnSettings`, `modeLabel` | drop `plan`; add `modeReasons`; labels for `default`→Ask, `auto`→Auto, `plan`→Plan |
| `CHAT/SettingsChip.tsx:128-192` | Mode list, Plan switch, `ModeBadges` | Plan becomes a Mode row; switch removed; one badge for non-default mode |
| `CHAT/Composer.tsx:105-300,516` | `Composer`, `pick`, `runCommand` | follow reported mode; `/plan` toggle with previous mode; Shift+Tab |
| `CHAT/commands.ts:10` | `/plan` | description "Switch to or from Plan mode" |
| `CHAT/editor/keymap.ts:27-89`, `CHAT/editor/types.ts:7-24` | keymap, `ComposerEditorProps` | `Shift-Tab` → `onCycleMode` |
| `CHAT/createChat.ts:8` | `createChat` | send `permissionMode` instead of `options.mode`/`options.plan` |
| `plugins/quirky.session/src/drafts.ts:11,35-41` | `Draft.picks`, `isDraft` | accept 3-key picks and legacy 4-key picks |
| `CHAT/composerDraft.ts:12` | `EMPTY_DRAFT` | 3-key picks |

## Contracts and interfaces

### Plan items (journal)

Back-link: [The model](logic.md#the-model), [How a plan moves through the chat](logic.md#how-a-plan-moves-through-the-chat).

Every status change of a version appends a new `plan` item with the same `version`. **The last `plan` item for a version is its current state** (same rule as `callId` dedupe in `CHAT/turns.ts:90-100`). **Every status-change item is a full copy of the version** (`text`, `filePath`, `empty`, `unchanged` repeated), so the latest item alone is enough to render it.

- A version is created `waiting` when Claude calls `ExitPlanMode`.
- `waiting` → `approved` (an approve exit), or `not-answered` (feedback, stop, manual mode switch, restart, empty plan answered with feedback).
- `not-answered` with `reason: 'feedback'` → `revised` when the next version arrives. Any version still `waiting` or `not-answered` when a newer one arrives becomes `revised`.
- At most one version is `waiting` per session at any time.

### Mode items (journal)

The runner appends a `mode` item whenever the mode it believes Claude is in changes: after a successful `setPermissionMode`, after an approve exit, on `EnterPlanMode`, and when `system/init` or `system/status` reports a `permissionMode` different from the last appended one. **Every `mode` item carries the current `autoAvailable`**, and the runner appends an extra `mode` item (same mode) whenever `autoAvailable` changes (after `initializationResult` or `setModel`). Duplicate reports of the mode it already holds are dropped. The UI's current mode and auto availability are the newest `mode` item; before any `mode` item exists the UI assumes `default` and auto unavailable. Back-link: [The model](logic.md#the-model), [Scenarios](logic.md#scenarios) SC-5, SC-20.

Order of items on an approve exit: plan `approved`, then `mode`.

### Runner: ExitPlanMode

CONTRACT:
```
canUseTool('ExitPlanMode', input, options) -> PermissionResult
```

1. Resolve text with `planText(input, lastPlanText, plansDir)`: read `input.planFilePath` only when it is a string whose realpath is a regular file under 1 MiB inside `plansDir` (the realpath of `~/.claude/plans`); otherwise ignore it and set no `filePath`. Fall back to `input.plan` when the file is unusable, or when the file text equals `lastPlanText` but `input.plan` is a non-empty string that differs. Empty (after trim) on both → `empty: true`. `filePath` on the item is the checked realpath, or absent. Back-link: SC-18, SC-19, SC-23.
2. Mark any earlier `waiting`/`not-answered` version `revised`. Increment `planVersion`. Compute `unchanged` (text equals `lastPlanText`). Set `lastPlanText`.
3. `context.createAsk(planSpec(), sessionId, { silent: true, onAsk })`. This takes the approval path (`quirky.ask/create`, no `nativeQuestion`), which has no fixed timeout, so a plan waits until answered. The ask still exists in the ask plugin and can surface on other ask surfaces (for example mobile) with the three options; that is acceptable, and an answer from there resolves the plan the same way. In `onAsk(askId)`, append the `waiting` plan item carrying `askId`, `text`, `filePath`, `empty`, `unchanged`. Store `pendingPlan = { version, askId, feedback: deferred }`.
4. Race the ask envelope against `pendingPlan.feedback` (resolved by `planFeedback` or a manual mode switch). On a feedback win, `context.cancelAsk(askId)`.
5. Map with `planDecision(envelope)` (fail closed: anything but an answered approve is not an approval):
   - `approve-auto`: target = `autoAvailable ? 'auto' : 'acceptEdits'`. Return allow with `updatedInput: input` and `updatedPermissions: [{type:'setMode', mode: target, destination:'session'}]`. Append plan `approved` with `approvedMode: target`, then `mode` item. Set `run.pendingApprovalTarget = target` (cleared at the next `result`). Back-link: SC-7.
   - `approve-review`: the same with target `'default'`. Back-link: SC-8.
   - `keep` (answered with optional reason text) or a feedback race win: deny with `message` = the text, or `'Keep planning.'` when empty. Append plan `not-answered`, `reason: 'feedback'`. Back-link: SC-9, SC-10.
   - `answered` or `partial` without a `decision` value, `declined`, `timed_out`, `unavailable`, a null envelope (ask cancelled by stop, interrupt or exit), or a thrown `createAsk`: deny with `message: 'The user stopped before answering. The plan was not approved; stay in plan mode.'`. Append plan `not-answered`, `reason: 'stopped'`. Back-link: SC-14.
   - Mode switch race win: deny with `message: 'The user switched to <Label> mode. The plan was not approved.'`. Append plan `not-answered`, `reason: 'mode-switch'`. Back-link: SC-15.
   - `empty: true` and the answer is an approve exit: treat as `keep` with message `'The plan was empty. Present the plan again.'`. The UI never offers approve for an empty plan; this is defence in depth. Back-link: SC-19.
6. Clear `pendingPlan` in a `finally`.

### Runner: EnterPlanMode

`canUseTool('EnterPlanMode', ...)` returns allow without creating an ask, and appends a `mode` item `plan`. Back-link: SC-5.

### Runner: planFeedback

CONTRACT:
```
StructuredRunner.planFeedback?(sessionId: string, text: string): boolean
```
Returns `true` and resolves the pending plan's feedback race with `text` when a plan is `waiting`; returns `false` otherwise (caller sends normally). Never throws for an unknown session (returns `false`).

### Runner: mode

- `launch()` passes `options.permissionMode ?? 'default'` as the SDK `permissionMode` and seeds `run.mode` with it, then appends a `mode` item. It seeds `run.planVersion` from `options.planVersion ?? 0` and `run.lastPlanText` from `options.lastPlanText ?? null`, so versions keep counting across resume.
- After the first `system/init`, call `query.initializationResult?.()` (best effort, errors ignored) and set `run.autoAvailable` from the current model's `supportsAutoMode` (`model` match by `value`; `undefined` → `false`). Re-evaluate after `setModel`.
- `configure(sessionId, { permissionMode })`:
  - If a plan is `waiting`, resolve it via the mode-switch race first (step 5 above) and await the plan item before switching.
  - Then `setPermissionMode(mode)`, set `run.mode`, append `mode` item.
  - Return `StructuredSettings` with the new `permissionMode`.
- `journal()` on `system/init` or `system/status` with a string `permissionMode` different from `run.mode`: set `run.mode`, append `mode` item. When `run.pendingApprovalTarget === 'auto'` and the reported mode is not `auto` (Auto refused): call `setPermissionMode('acceptEdits')`, set `autoAvailable = false`, append a corrected plan `approved` item with `approvedMode: 'acceptEdits'`, a `mode` item `acceptEdits`, and a `status` item `Auto mode isn't available. Using Accept edits.`, in that order; clear `pendingApprovalTarget`. Back-link: SC-20.

### Daemon (`main.ts`)

Back-link: [How a plan moves through the chat](logic.md#how-a-plan-moves-through-the-chat), [Scenarios](logic.md#scenarios).

- `createAsk` with `silent: true` does everything it does today except append the `ask` item. The askId is still tracked in `pendingAsks`, so `interrupt` and `stop` cancel it.
- `create` accepts top-level `permissionMode?: string`. It must be one of the agent's `permissionModes.modes` (`invalid-params` otherwise, and refused for agents without permission modes). Passed to `runner.start` as `StructuredStartOptions.permissionMode`. Not stored in `launchSettings`; `options` and `quirky.agents/resolveLaunch` are not used for mode. `auto` at create isn't checked against model support (no session yet); a refusal shows up through the reported mode like any other. Back-link: SC-4.
- `configure` accepts `session, model, effort, permissionMode`. `planMode` is removed (`invalid-params` if sent). `permissionMode: 'auto'` is refused with conflict `auto mode is not available` when the runner reports auto unavailable (expose `runner.autoAvailable?(sessionId): boolean`).
- `admitAndSend`: the feedback intercept sits after `requireStructured`, the recipient checks, the `stopping` checks and the `requireIdle`/`expectedAfterSeq` guards (guarded sends keep rejecting while a plan waits, because status is `waiting`), and before `reserveSendReceipt` (`:1280`) and the `when === 'idle'` queue branch (`:1293`). If `runner.planFeedback?.(sessionId, text)` returns `true`: reserve and complete the send receipt exactly as a normal send would when a receipt key was supplied, append the user's `user` item to the journal, and return `{ ok: true }` without calling `runner.send` or queueing. Images on a feedback send are refused with `invalid-params` `images can't be sent as plan feedback`, checked before `planFeedback` is called. Back-link: SC-10.
- `resume`: read the old session's journal (tail) for the last `mode` item and the last `plan` item per version.
  - Pass the last mode as `permissionMode`, the highest version as `planVersion`, and the newest version's `text` as `lastPlanText` to `runner.start` (new optional `StructuredStartOptions` fields). Back-link: SC-16, SC-17.
  - If the newest version's last item is `waiting`, append to the new session a copy of that item with `status: 'not-answered'`, `reason: 'restarted'`, no `askId`. Back-link: SC-16.

### UI

Back-link: [Screens](logic.md#screens), [Decisions Locked](logic.md#decisions-locked), [Scenarios](logic.md#scenarios).

- `planVersions(messages): PlanVersion[]`: one entry per version, last item wins, ordered by version. `currentMode(messages): ModeItem | null`: last `mode` item. `previousMode(messages): PermissionModeName`: the mode of the newest `mode` item before the newest run of `plan` mode items, or `default`.
- `ChatView` computes both with `useMemo` over `stored`, passes `mode` and `autoAvailable` to `Composer` (new props `reportedMode`, `autoAvailable`), and renders:
  - `PlanChip` in the header when any version exists. Text by newest version: `waiting` → "Plan · v{n} waiting"; `not-answered` + `reason: 'feedback'` → "Plan · waiting for Claude"; `not-answered` otherwise → "Plan · not answered"; `approved`/`revised` → "Plan". Click toggles the panel.
  - `PlanPanel` in an `aside` sibling after the scroller when the body is wide enough, otherwise inside `Dialog variant="sheet" scrollBody`. Width rule: a `ResizeObserver` on the `body` element; sheet when its inline size is below `calc(720 * var(--ui-length-unit)) + calc(320 * var(--ui-length-unit))` resolved in pixels at runtime (read `--ui-length-unit` via `getComputedStyle`). The existing views aside keeps working; when both exist, the plan aside sits after it.
  - Panel open state: "last seen version" is seeded from the first load of messages. On load the panel opens only if the newest version is `waiting`. After load it opens whenever a version above "last seen" arrives live. The user can close it; the chip reopens it. Back-link: SC-21.
  - The sheet makes the rest of the window inert while open; that's accepted, and the user closes it (Esc, close button, chip) to type. Back-link: SC-22.
- `PlanPanel` props: `{ context, version: PlanVersion, isNewest: boolean, onClose }`. Exits and the restarted action render only when `isNewest`. Shows the version marker (`v{n} · {status}` plus `revised`/`unchanged` when set, `approved · {mode label}` when approved), the plan through `Prose`, `Open plan file` when `filePath` is set, and:
  - `waiting` and not empty: three `Button`s. Approve, auto mode (`variant="primary"`), Approve, review edits, Keep planning. Keep planning swaps the buttons for a `TextArea` labelled "What should Claude change?" with Send to Claude and Cancel.
  - `waiting` and empty: the text "Claude sent an empty plan" and only Keep planning.
  - `not-answered` + `reason: 'restarted'`: `NoticeLine` "Quirky restarted before you answered. Claude is no longer waiting on this plan." with one action, Ask Claude to present it again, which calls `quirky.structured/send` with text `Please present the plan again.`.
  - `approved`, `revised`, other `not-answered`: no actions.
- Exits call `quirky.ask/answer` with `{ askId, answers: { decision: { value, label, source:'option' }, reason?: { value, source:'input' } }, skipped: [] }`, where `value` is `approve-auto`, `approve-review` or `keep`. Buttons disable while the call is in flight. Back-link: SC-7, SC-8, SC-9.
- Open plan file calls `quirky.terminal/openExternal` with `{ target: filePath }` (an absolute path; `file://` URLs are rejected by `checkExternalTarget` in `plugins/quirky.terminal/src/open-external.ts`), after `context.confirm` like `Prose` links. Shown only when `filePath` is present, which the runner sets only for a checked path inside the plans directory.
- Transcript: `groupTurns` keeps a global `plans: Map<version, entry>` like its `calls` map (`turns.ts:90-100`). The first item of a version creates the entry at that position; later items for the version replace the entry's item in place, even across turns. `toBlocks` emits one `plan` block per entry, rendering its latest state: "Plan ready (v{n}) · view in panel", "Plan approved (v{n}) · {mode label}", "Plan v{n} · revised", "Plan v{n} · not answered". Clicking opens the panel on that version (read-only when not newest). Back-link: SC-6, SC-13.
- Composer:
  - `Picks` becomes `{ model, effort, mode }`. `picks.mode` follows `reportedMode` whenever it changes.
  - The Mode list always shows four rows, Ask, Accept edits, Auto, Plan (`default`, `acceptEdits`, `auto`, `plan`). `TurnSettings.modeReasons: Record<PermissionModeName, string | undefined>` gives each row's disabled reason: for Claude, `auto` gets "Auto mode isn't available for this model" when `autoAvailable` is false (in the New chat composer, with no session, Auto is enabled); for agents whose `permissionModes` is `ok: false`, `plan` gets `capabilities.planMode.reason` and the other three get `permissionModes.reason`. Picking an enabled row calls `configure { permissionMode }`. On those agents Shift+Tab and `/plan` do nothing and show the Plan reason. `AgentCapabilities.planMode` stays as a capability; only the runner/RPC/picks flag goes. Back-link: SC-1, SC-24.
  - `ModeBadges` shows one badge when mode ≠ `default`: Plan uses `tone="accent"`, others `tone="needs-you"`; its ✕ calls `configure { permissionMode: 'default' }`.
  - `/plan`: from non-plan, switch to `plan`; from plan, switch to `previousMode(messages)` (passed from `ChatView` as a prop). Back-link: SC-3.
  - Shift+Tab (`onCycleMode`): next enabled mode in list order, wrapping. In `CHAT/editor/keymap.ts` the check runs before `handle`'s early `return false` for `tab` + `shiftKey` (`:41`), calls `onCycleMode` when provided and not `disabled`, and consumes the event (`preventDefault`, return `true`). Back-link: SC-2.
  - A send while a plan waits goes through `quirky.structured/send` unchanged; the daemon turns it into feedback.
- `createChat` sends `permissionMode: picks.mode` when set and not `default`; no `options.mode`/`options.plan`.

## Data models / schemas

Pinned in `packages/protocol/src/chat.ts` (T0 owns this file; T1 and T2 build against it).

SCHEMA:
```
ChatItem |=
  { kind: 'plan'
    version: number                 // 1-based, per session
    status: 'waiting' | 'revised' | 'approved' | 'not-answered'
    text: string                    // plan markdown; '' when empty
    filePath?: string
    askId?: string                  // only while waiting
    empty?: boolean
    unchanged?: boolean             // text equals the previous version's
    approvedMode?: 'auto' | 'acceptEdits' | 'default'
    reason?: 'feedback' | 'stopped' | 'mode-switch' | 'restarted' }
  { kind: 'mode'
    mode: 'default' | 'acceptEdits' | 'auto' | 'plan'
    autoAvailable?: boolean }
```

Exported helper types from the same file: `PlanStatus`, `PlanItem = Extract<ChatItem, {kind:'plan'}>`, `ModeItem = Extract<ChatItem, {kind:'mode'}>`, `PermissionModeName = ModeItem['mode']`.

SCHEMA (plan ask spec, `QS/plan.ts`):
```
questions:
  - id: 'decision', type: select, required: true
    options: approve-auto "Approve, auto mode" | approve-review "Approve, review edits" | keep "Keep planning"
  - id: 'reason', type: text, required: false
```

SCHEMA (`CHAT/plan.ts`):
```
PlanVersion = PlanItem & { firstSeq: number; lastSeq: number }
```

SCHEMA (drafts, `plugins/quirky.session/src/drafts.ts`):
```
Draft.picks = { model: string|null; effort: string|null; mode: string|null }
legacy accepted on read: + plan: boolean   // plan:true maps to mode:'plan'
```

## DO-NOT-CHANGE fences

- `QS/native-questions.ts` `approvalSpec`/`approvalOutcome`: the generic approval card for every other tool, and Codex approvals, depend on them. Plan uses its own spec in `QS/plan.ts`.
- `plugins/quirky.ask/**`: the ask card and ask service. Plan asks are silent, so no ask-card change is needed.
- `QS/codex-runner.ts`, `QS/pi-runner.ts`: Codex, pi and omp keep Plan disabled (SC-24) and must not change behaviour.
- `CHAT/Prose.tsx` `renderMarkdown`: shared sanitised renderer; reuse, don't fork.
- `plugins/quirky.session/ui-scoreboard.json` quoted `site`/`element` strings for `view:quirky.session/structured`: the scoreboard ratchet quote-checks them, so edits to `ChatView` must keep those quoted lines verbatim (or update the quotes in the same task).

## Always / Ask / Never

**Always**
- Fail closed: only an answered approve exit with a non-empty plan returns `behavior: 'allow'` for `ExitPlanMode`.
- Journal every plan status change and mode change as an item; the UI derives state only from items.
- Use design tokens and shared `@quirky/ui` components (`Button`, `Badge`, `TextArea`, `NoticeLine`, `Dialog`); inline style objects only (`ui/no-plugin-css`, `ui/no-raw-pixel`, `ui/no-raw-color`).
- Keep approval click-only: no key handler in the panel or composer chooses an exit (SC-12).

**Ask** (implementer decides, records the choice in the PR)
- Exact panel width within the 320–440 unit range shown in the mock.
- Whether `planVersions` lives in `CHAT/plan.ts` or alongside `turns.ts`.

**Never**
- Approve or switch out of Plan from a keypress, a stop, a restart, or a timeout.
- Keep `planMode` as a separate flag anywhere (runner, RPC, picks).
- Read `ExitPlanMode` input fields as typed; they are `unknown` and must be checked.
- Change Codex, pi or omp capabilities.

## Cross-cutting

Back-link: [Decisions Locked](logic.md#decisions-locked).

- **Security:** plan text is model output rendered through the sanitised `Prose` renderer. `planFilePath` is model-controlled, so the runner reads and exposes it only when its realpath is a regular file under 1 MiB inside the realpath of `~/.claude/plans`; anything else is ignored and the text comes from `input.plan`. `filePath` is opened only after `context.confirm`.
- **Migration:** stored drafts with the legacy 4-key picks keep loading (`plan: true` → `mode: 'plan'`). Sessions journaled before this change have no `mode` items; resume then starts in `default`, as today.
- **Rollback:** reverting restores the generic approval card. Journaled `plan`/`mode` items in old sessions become unknown kinds; `toBlocks` already drops unknown kinds through its `default: break` (`turns.ts:173`), so keep that default.

## Testing strategy

Run each file on its own: `bun test <file>` (one file per process). Full suite runs on the draft PR with the `full-suite` label.

| File | Covers |
|---|---|
| `QS/test/plan.test.ts` (new) | `planText` file/fallback/stale/empty rules, and a path outside the plans dir (or a symlink escaping it) ignored with no `filePath`; `planDecision` mapping incl. fail-closed statuses (`partial` without decision, `declined`, `timed_out`, `unavailable`, null) |
| `QS/test/claude-runner.test.ts` | ExitPlanMode: waiting item with askId, approve-auto with/without auto (setMode in `updatedPermissions`), approve-review, keep with reason, feedback race via `planFeedback`, stop → not-answered, mode-switch → not-answered then `setPermissionMode`, revised on next version, empty plan never allowed; EnterPlanMode allowed with mode item; mode items from init/status; Auto refused → status + acceptEdits; launch honours `permissionMode`. Update the `configure` tests that encode two flags (`:115-146`) |
| `QS/test/capabilities.test.ts` | Claude modes include `auto`; Codex/pi/omp unchanged |
| `QS/test/plan-mode.test.ts` (new, `chat-harness.ts`) | `create` with `permissionMode`; `configure` rejects `planMode` and unavailable `auto`; send while plan waits (both `when: 'idle'` and `'now'`) → feedback, user item journaled, not queued; `requireIdle` send still rejected while waiting; silent ask has no `ask` item |
| `plugins/quirky.session/test/resume.test.ts` | resume restores mode from the old journal; waiting plan comes back `not-answered` + `restarted`; the next plan after resume is numbered above the old versions |
| `plugins/quirky.session/test/chat-view.test.ts` | `planVersions`/`currentMode`; one `plan` block per version; chip text per state; panel opens on new version; exits call `quirky.ask/answer` with the right values; empty plan shows only Keep planning; restarted notice action sends the re-present text |
| `plugins/quirky.session/test/composer.test.ts` | Mode list with Plan row, no switch; auto disabled with reason; `/plan` toggle and return to previous mode; badge per non-default mode; picks follow `reportedMode` (rewrite `:542-636`) |
| `plugins/quirky.session/test/composer-editor.test.ts` | Shift+Tab calls `onCycleMode` and is consumed; Enter/1/2/3 never call anything plan-related |
| `plugins/quirky.session/test/drafts.test.ts` | 3-key picks accepted; legacy 4-key picks accepted and mapped |
| `plugins/quirky.session/test/structured-view-layout.test.ts` | narrow body renders the plan in the sheet; wide renders the aside |

Acceptance bar: the Screens table in [logic.md](logic.md#screens) matches the mock at `mock/mock.html`; `bun run ui:lint` and `bunx tsc --noEmit -p tsconfig.json` pass.

## Non-goals

- No change to the ask plugin or ask card.
- No Codex/pi/omp plan mode, no plan editing, no clear-context exit, no line diffs between versions (see [Deferred Ideas](logic.md#deferred-ideas)).
- No editor-plugin integration for Open plan file; it uses the OS default app via `openExternal`.

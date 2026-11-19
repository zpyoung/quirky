# Native chat header: tech spec

**Status:** Draft for execution. Logic spec: [logic.md](logic.md) (approved 2026-11-19). Mock: [mock/mock.html](mock/mock.html).

Paths are relative to the repo root `/Users/zpyoung/quirky/workspaces/quirky/chat-header`. `S/` = `plugins/quirky.structured/`, `Q/` = `plugins/quirky.session/`, `I/` = `plugins/quirky.session-info/`, `UI/` = `packages/ui/src/design-system/`, `P/` = `packages/protocol/src/`.

## Architecture

Four subsystems change ([logic: How the numbers reach the header](logic.md#how-the-numbers-reach-the-header)):

- **Protocol** (`P/chat.ts`, `P/model.ts`). Shared types: the usage summary, the fork capability, the `Session` fields for a custom title and a fork link.
- **quirky.structured** (daemon plugin). The runners keep the per-category token numbers they already parse. Claude also tracks cache tiers per main-thread API call. `S/main.ts` folds them into a per-session usage summary, which is persisted in a new table next to `structured_messages` (`S/journal.ts`). It's served by a new `quirky.structured/usage` method and announced by a new `usageChanged` event. A new `quirky.structured/fork` method uses a new optional runner method `fork`. Resume copies a custom title.
- **quirky.session** (daemon + window UI). Daemon: a new `quirky.session/setTitle` method, a `title_custom` column, and a `forked` flag accepted by `register`. Window: a new `ChatHeader` component replaces the header markup in `Q/src/window/chat/ChatView.tsx`. `SessionTabs` gets a usage tooltip. A shared elapsed hook is used by both the header and the composer.
- **quirky.session-info** (daemon + panel). `get` serves structured sessions: identity plus usage read from `quirky.structured/usage`. `command:quirky.session-info/open` accepts `{session}`, and the panel shows that session until terminal focus moves.
- **@quirky/ui**. `Menu` gains separators, note lines and item descriptions. `Tabs` items gain an optional `tooltip`. A visually-hidden utility class is added for the header's live region.

## Code references

| Unit | Anchor | Change |
|---|---|---|
| Turn usage type | `S/runner.ts:61` `TurnUsage` | keep as is; add the per-call report described below |
| Runner contract | `S/runner.ts:~84-117` `StructuredRunner`, `S/runner.ts:22-48` `StructuredContext`, `S/runner.ts:66-77` `StructuredStartOptions` | add `StructuredContext.reportUsage`, optional `StructuredRunner.fork` |
| Claude usage | `S/claude-runner.ts:34-51` `resultUsage`; `:896-983` `journal`; `:951` assistant branch; `:957-960` result branch | report per-category totals and per-call cache tiers |
| Claude resume / init | `S/claude-runner.ts:340` pre-persist of provider id; `:408` `resume:`; `:909-923` init id check | fork path must not pre-persist the source id |
| Codex usage | `S/codex-runner.ts:142-171` `turnContextUsage` / `tokenCounts`; `:730-753` `thread/tokenUsage/updated`; `:532,:618` `turnUsageBaseline`; `:882-897` `finishCompletedTurn` | report per-category totals; no cache tiers |
| Codex resume | `S/codex-runner.ts:320-337` `thread/resume` | add `fork` via `thread/fork` |
| pi/omp usage | `S/pi-runner.ts:92-96` `contextTokensOf`; `:649-653` `message_end`; `:507-526` `closeTurn` | report per-category totals; no cache tiers |
| pi/omp resume | `S/pi-runner.ts:217-237`; `S/pi-rpc.ts:~56-66` `piLaunchArgs` | add `fork` if achievable (see Contracts) |
| Capabilities | `S/capabilities.ts:~38-94` `CAPABILITIES`, `capabilitiesFor`; `P/chat.ts:71-81` `AgentCapabilities` | add `fork: Capability` |
| Structured context | `S/main.ts:686-715` `structuredContext`; `:303-318` `appendMessage`; `:459-496` `setStatus` | add `reportUsage` |
| Resume | `S/main.ts:1133-1311` resume handler; `:743-751` `nextTitle`; `:83` `AGENT_TITLES`; `:1172-1180` owner key | copy custom title; share code with fork |
| Method registration | `S/main.ts:1900-1919` `context.provide`; `S/quirky-plugin.json` `contributes.method` / `event` | add `usage`, `fork`, event `usageChanged` |
| Journal store | `S/journal.ts:48-57`, `journalMigrations(home)` | add migration step 5: usage summary table |
| Session store | `Q/src/records.ts:200` `sessionMigrations`, `:405` `update` fields; `:373` insert | add column `title_custom`; add `forked`; `update` accepts `title`, `titleCustom` |
| Session service | `Q/src/sessions.ts:313` `SessionService`; `:912-924` `setName` (pattern); `:1573` `publish`; `:~990-1075` `register`; `:757-771` structured resume branch | add `setTitle`; `register` accepts `titleCustom`, `forked` |
| Session methods | `Q/main.ts:28-55`; `Q/quirky-plugin.json:748` (`setName` entry pattern) | add `setTitle` entry + handler |
| Chat view | `Q/src/window/chat/ChatView.tsx:79-97` header styles, `:514-541` header markup, `:224` `working` | replace with `<ChatHeader>` |
| Composer elapsed | `Q/src/window/chat/Composer.tsx:64-75` `useElapsed`, `:150`, `:586` | move to shared hook taking a start time |
| Tabs | `Q/src/window/SessionTabs.tsx:55-62` `tabLabel`; `UI/contracts.ts:34` `TabItem` | tooltip with usage for structured tabs |
| Status presentation | `Q/src/window/StatusDot.tsx` `sessionStatusPresentation`, `StatusDot` | reuse `UiStatus` values |
| Menu | `UI/navigation.tsx:125` `Menu`; `UI/contracts.ts:43-44` `MenuItem`, `MenuProps` | add separator, note, description |
| Session info | `I/src/service.ts:226-228,297,490,678`; `I/src/types.ts` `Usage`; `I/src/ui.tsx:9-12`; `I/src/window/SessionInfoPanel.tsx:364,420` | structured branch; `open {session}` |
| Scoreboard | `Q/ui-scoreboard.json` surface `view:quirky.session/structured`; `I/ui-scoreboard.json` | declare every new handler and conditional render |

## Contracts & interfaces

### Usage summary ([logic: SC-3 to SC-13](logic.md#tokens))

`CONTRACT:` `StructuredContext.reportUsage(sessionId: string, report: UsageReport): void`. Runners call it, and they never write the summary themselves.

- **Precondition:** a `UsageReport` holds token counts this session has spent since the previous report (deltas, never cumulative), plus optional cache info.
- **Postcondition:** `S/main.ts` adds the deltas to the session's stored `UsageSummary`, updates `cache` when the report carries it, persists it in the same tick, and emits `quirky.structured/usageChanged {sessionId, summary}`.
- **Invariant:** a session's summary counts only its own spend. Spend before a resume or a fork belongs to the predecessor's summary.

Each runner turns provider numbers into deltas:

- **Claude.**
  - **Token deltas:** read them from the turn's `result` message (`modelUsage`, falling back to `usage`). The research says a resumed or forked result includes the predecessor's spend, so keep a per-run baseline: the previous result's totals, and for the first result after a resume or fork, the predecessor's last result totals read from the journal. Report `current − baseline`, clamped at zero per category. Verify against the installed `@anthropic-ai/claude-agent-sdk` types and add a fake-query test for the resumed-result case.
  - **Cache:** report it on every main-thread `assistant` message (skip messages with `parent_tool_use_id`).
  - **Call start:** the time the runner sent the request that produced the message. For the first call of a turn, that's when the user message was written to the query. For later calls, it's when the previous tool-result (`user`) SDK message was observed. Take tiers from `message.usage.cache_creation.ephemeral_5m_input_tokens` (typed by the peer `@anthropic-ai/sdk` beta types, so a narrow cast is acceptable) / `ephemeral_1h_input_tokens`, and reads from `cache_read_input_tokens`.
- **Codex.** Deltas come from `thread/tokenUsage/updated` `last`, or `total − turnUsageBaseline`, as the runner already computes. Map `cachedInputTokens` to cache read, `outputTokens + reasoningOutputTokens` to output, and `inputTokens − cachedInputTokens` to input. Cache write is 0. No cache info is reported, so no timer shows ([SC-12](logic.md#cache-timer)).
- **pi/omp.** Deltas come from each assistant `message_end` frame's `usage {input, output, cacheRead, cacheWrite}`. These are per-call numbers, so they need no baseline. No cache info is reported (no TTL in the frame).

`CONTRACT:` cache tier update, applied in `S/main.ts` when a report carries `cache`:

- A tier that the call **wrote** (its ephemeral count > 0) gets `anchorAt = callStartedAt`.
- A call that **read** (`cacheRead > 0`) refreshes every tier whose anchor is still warm at `callStartedAt` (warm means `callStartedAt < anchorAt + ttl`), because a hit refreshes the entries it read and the API doesn't say which tier was hit. This is a deliberate approximation, not measured behavior.
- A tier never written in this session stays absent.

`PSEUDOCODE (justified, ≤3 lines):` the screen state, because the two-tier hand-off is easy to misread in prose.
`live = tiers with now < anchorAt + ttl, sorted by expiry; none → "Cache cold" if any tier exists, else hidden`
`next = live[0]; 5m tier → "Cache m:ss" (amber when ≤60s left); 1h tier → "Cache Nm" (ceil minutes, never amber)`

`CONTRACT:` `quirky.structured/usage { session: string } → UsageResult`. It's read-only.

- An unknown session gives `invalid-params`. A structured session with no reports gives `own: null, conversation: null, cache: null`.
- `conversation` is the sum of `own` over the session and its `resumedFrom` predecessors. The walk stops after including a session whose `forked` is true, so a fork's total starts at zero ([SC-5, SC-6](logic.md#tokens)). Missing predecessors count as zero.

`CONTRACT:` event `quirky.structured/usageChanged { sessionId: string; summary: UsageSummary }`. It's emitted only by `reportUsage`, and consumers re-query `usage` for `conversation`.

### Fork ([logic: SC-17, SC-22, SC-23](logic.md#fork))

`CONTRACT:` `StructuredRunner.fork?(source: { providerSession: SessionProviderSession; cwd: string; launchOptions }): Promise<SessionProviderSession>`.

- **Postcondition:** a new provider conversation exists that holds the source's history, and the source is unchanged.
- **Errors:** throws with a message suitable for the error row.
- **Per agent:**
  - **Claude:** the SDK's standalone `forkSession(sourceId, options)` (`sdk.d.ts:831` in `@anthropic-ai/claude-agent-sdk@0.3.284`) returns `{ sessionId }`. Check `SessionMutationOptions` and pass the source's directory option so the session file is found.
  - **Codex:** `thread/fork { threadId }` returns `thread.id`. No code in this repo uses it yet, so confirm the method against the installed `codex app-server` protocol before building. If it's missing, set the capability to unsupported with the reason.
  - **pi/omp:** only if a fork can be made without moving the source's live process to the new session. Otherwise leave `fork` undefined and set the capability to `{ ok: false, reason }`.

`CONTRACT:` `AgentCapabilities.fork: Capability`. It's `ok: true` exactly for agents whose runner implements `fork`.

`CONTRACT:` `quirky.structured/fork { session: string } → Session` (the new session).

- **Errors:**
  - `conflict`, `data.reason: 'turn-running'`, when the source status is `working` or `waiting`.
  - `conflict`, `data.reason: 'fork-unsupported'`, when the capability is not ok.
  - `conflict` with the runner's message when `fork` throws.
  - `invalid-params` when the source isn't structured or has no provider session.
- **Postcondition:**
  - `quirky.session/register` created a record with `resumedFrom: source.id`, `forked: true`, title `"<source title> (fork)"`, `titleCustom: source.titleCustom`, and the source's `launchSettings`.
  - The runner started on the new provider session exactly like resume, with no prompt.
  - The source's owner key is untouched (the new provider id has its own key).
- **UI:** it calls this method, then `context.openView(WORKTREE_VIEW_ID, { worktree, session: new.id })` (`Q/src/window/model.ts:4`, pattern `Composer.tsx:311-318`).

`quirky.session/resume` keeps refusing `fork` for structured sessions (`Q/src/sessions.ts:759`). The header calls `quirky.structured/fork` directly.

### Title ([logic: SC-18 to SC-21](logic.md#rename))

`CONTRACT:` `quirky.session/setTitle { session: string; title: string } → Session`.

- **Preconditions:** `title` is trimmed and 1-200 characters, otherwise `invalid-params` (the UI never sends empty, per SC-19).
- **Postcondition:** the record's `title` and `titleCustom = true` are persisted, and `quirky.session/changed` is published.
- **Rules:** no uniqueness check and no `titleFor` numbering. Setting the same title is a no-op that returns the session.

`CONTRACT:` resume and wake ([SC-21](logic.md#rename)). `quirky.structured/resume` passes `title: old.title, titleCustom: true` to `register` when `old.titleCustom` is true. Otherwise it keeps `nextTitle` as today. Fork follows the fork contract above.

## Data models / schemas

`SCHEMA:` in `P/chat.ts`, exported from `@quirky/protocol`:

| Type | Fields |
|---|---|
| `UsageTotals` | `input: number; output: number; cacheRead: number; cacheWrite: number; total: number` (total = sum of the four) |
| `CacheTier` | `ttlMs: 300000 \| 3600000; anchorAt: number` (epoch ms, start of the call that wrote or refreshed it) |
| `CacheState` | `tiers: CacheTier[]` (0-2 entries, at most one per ttl) |
| `UsageSummary` | `sessionId: string; own: UsageTotals; turns: number; cache: CacheState \| null; updatedAt: number` |
| `UsageResult` | `own: UsageTotals \| null; conversation: UsageTotals \| null; cache: CacheState \| null` |
| `UsageReport` | `tokens?: Omit<UsageTotals,'total'>; turnEnded?: boolean; cache?: { callStartedAt: number; wrote5m: number; wrote1h: number; read: number }` |
| `AgentCapabilities` | add `fork: Capability` |

`SCHEMA:` in `P/model.ts` `Session`: add `titleCustom?: boolean` and `forked?: boolean` (absent means false). Mirror them in every `Session` result schema in `Q/quirky-plugin.json` (optional properties, not in `required`).

`SCHEMA:` table `structured_usage` (migration 5 in `S/journal.ts`): `session_id TEXT PRIMARY KEY, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, turns INTEGER, cache TEXT (JSON CacheState or NULL), updated_at INTEGER`.

`SCHEMA:` `MenuItem` in `UI/contracts.ts` becomes `MenuEntry = MenuItem | { kind: 'separator'; id: string } | { kind: 'note'; id: string; label: string }`. `MenuItem` gains `description?: string`, rendered under the label and used for disabled reasons. `MenuProps.items: readonly MenuEntry[]`. Existing callers that pass plain items stay valid. Arrow keys skip separators and notes.

`SCHEMA:` `TabItem` gains `tooltip?: string`, rendered as the tab button's `title`.

## DO-NOT-CHANGE fences

- **`Q/src/sessions.ts:757-771` structured resume branch.** It still refuses `fork`, because the existing test `Q/test/resume.test.ts:395-409` and the CLI rely on that, and fork has its own method.
- **`S/main.ts:1172-1180` owner-key rule.** The one-owner-per-provider-conversation guard protects against two live runners on one conversation. A fork gets a new provider id, so it never needs an exception.
- **The journal's existing migrations 1-4 in `S/journal.ts` and `Q/src/records.ts:200`.** They are append-only, because installed databases have already run them. Add new steps only.
- **`TurnUsage` / `data.contextUsage` on result messages.** `plugins/quirky.avatar/src/brain/session.ts:391-396` and `plugins/quirky.terminal-dock` read it.
- **`MenuItem`'s existing fields and behavior** (`checked` → `menuitemcheckbox`, close on action, focus return). Five plugins use `Menu` (`git grep -l "<Menu " -- '*.tsx'`).

## Always / Ask / Never

- **Always:**
  - Use `@quirky/ui` components and `var(--ui-*)` tokens. Status colors are `--ui-working`, `--ui-needs-you`, `--ui-failing`, `--ui-accent` and `--ui-muted` via `StatusDot`'s `UiStatus`.
  - Declare every new handler and conditional render in the plugin's `ui-scoreboard.json`.
  - Keep the header a normal flex row above the scroller, never absolutely positioned over it.
  - Announce status-label, amber and cold changes once through one mounted, visually hidden `aria-live="polite"` region.
- **Ask** (stop and surface): any change to a locked decision in [logic.md](logic.md#decisions-locked); pi or omp fork turns out to require moving the live process (set the capability to unsupported and report it, don't work around it).
- **Never:**
  - plugin CSS files or `<style>`
  - raw px or colors
  - running the full suite locally (AGENTS.md)
  - writing the summary from UI code
  - auto-changing a title outside `setTitle`, resume and fork

## Status mapping

The mock's palette isn't the product's ([logic: Screens](logic.md#screens)), so SC-2's dot hues map onto `UiStatus`:

| SC-2 state | `UiStatus` | Label |
|---|---|---|
| Working | `working` | `Working · <elapsed>` |
| Waiting on you | `needs-you` | `Waiting on you` |
| Done | `done` | `Done` |
| Ready (no finished turn) | `idle` | `Ready` |
| Ended | `idle` | `Ended` |
| Stopped unexpectedly | `failing` | `Stopped unexpectedly` |
| Reconnecting… | `needs-you` | `Reconnecting…` |

**Crashed vs ended:** an `exited` session is crashed when the newest journal `error` item (`ChatItem` kind `error`, `P/chat.ts:32`) comes after the newest user message. Otherwise it's ended.

**Elapsed** starts at the newest user message's `at` while `working`. The shared hook `useElapsed(startedAt: number | null)` returns `"12s"` / `"1m 05s"`. The composer switches to it with the same start, so the header and composer agree.

**Ready:** see Header behavior contracts below.

## Header behavior contracts

These pin the parts of [logic: Scenarios](logic.md#scenarios) that the tests alone would otherwise define. All of them live in `Q/src/window/chat/ChatHeader.tsx`, which `ChatView` renders in place of its current `<header>`.

- **Offline ([SC-15](logic.md#ended-crashed-offline)).** Track `context.onConnection` (`P/ui.ts:390`): `'reconnecting'` sets offline, and `'connected'` clears it and re-queries `quirky.structured/usage`. While offline, the status shows Reconnecting…, the figures render dimmed with their timers frozen at the last value, and the Rename and Fork menu items are disabled with the description "Reconnecting…".
- **Fork failure ([SC-23](logic.md#fork)).** An `InlineError` renders directly below the header row. Its message is "Could not fork: <reason>", and its action is `{ label: 'Retry', onAction }`, which re-calls `quirky.structured/fork`. It's removed when a fork succeeds or the chat changes.
- **Rename ([SC-18 to SC-20](logic.md#rename)).**
  - Clicking the title or choosing Rename swaps the title for a `TextField` (`hideLabel`, label "Chat title") with its text selected.
  - Enter and blur save the trimmed value through `quirky.session/setTitle`. An unchanged value closes without a call, and an empty value restores the old title without a call. Esc restores the old title.
  - A failed save keeps the field open with the typed text and passes the error to `TextField`'s `error` prop. Enter retries.
- **Narrow ([SC-25](logic.md#layout)).**
  - A `ResizeObserver` on the header row measures the space left after the title's minimum (about 120 length units), the plan chip and ⋯.
  - Items drop in this order: tokens, cache timer, status label and time. The dot never drops.
  - The ⋯ menu then starts with one `note` entry naming the dropped figures in header order (for example "184k tokens · Cache 3:42"), followed by a `separator`.
- **After exit ([SC-14](logic.md#ended-crashed-offline)).** Tokens and the cache timer keep rendering from the stored summary, and the timer keeps counting down.
- **Ready.** Ready means the conversation's usage has `turns === 0` (or there is no summary) and the session hasn't exited. That avoids depending on how much history has loaded.

## Cross-cutting

- **Migration.** One additive table in the structured store and one additive column in the session store. Old sessions have no summary, so they show no figures until their next turn ([SC-4](logic.md#tokens) behavior).
- **Rollback.** Both schema changes are additive. Older builds ignore them.
- **Accessibility.**
  - The title button has an accessible name `Rename chat: <title>`.
  - The menu trigger has `aria-label="More actions"`.
  - The token figure's `title` holds the breakdown.
  - The cache figure's `title` holds the per-tier time left.
- **Performance.** The cache and elapsed displays tick once per second from one interval in `ChatHeader`, and nothing re-renders the transcript.
- **Tooltips.** These are native `title` attributes. `Popover` takes focus and has no hover mode ([logic: Screens open questions](logic.md#screens)).
- **Inline edit.** It's built on `TextField` with `hideLabel`, label "Chat title". No shared inline-edit component is added.

## Testing strategy

One test file per `bun test` process (AGENTS.md, memory: test process isolation). Files and what they must cover:

- `S/test/usage-summary.test.ts` (new):
  - per-runner delta mapping (Claude fake query, Codex fixture, pi fake transport)
  - Claude resumed-result baseline (SC-5)
  - fork starting at zero (SC-6)
  - tier update rules: write, read refresh, 5m-only, 1h-only (SC-7 to SC-11)
  - persistence across a reboot of the harness
  - the `usage` result and the `usageChanged` event
- `S/test/fork.test.ts` (new):
  - fork for each agent with `fork` capability
  - `turn-running` and `fork-unsupported` conflicts
  - new record fields (`forked`, title suffix, `resumedFrom`)
  - source untouched
- `S/test/capabilities.test.ts`: the `fork` field for all four agents.
- `S/test/structured.test.ts`: resume copies a custom title and regenerates a non-custom one.
- `Q/test/sessions.test.ts`: `setTitle` validation, persistence, the `changed` event, no-op, and `titleCustom` round-trip through `records`.
- `Q/test/chat-header.test.ts` (new, happy-dom with `Q/test/ui-fake.ts`):
  - every [Screens](logic.md#screens) row for the chat, problems, menu and rename screens
  - narrow drop order, driven by a stubbed `ResizeObserver` width
  - live-region announcements
- `Q/test/chat-view.test.ts` and `Q/test/composer.test.ts`: updated for the moved Show all events control and the shared elapsed hook.
- `packages/ui/test/design-system.test.tsx`: `Menu` separators, notes, descriptions, and keyboard skipping; `Tabs` tooltip.
- `I/test/api.test.ts` and `I/test/ui.test.tsx`: the structured session `get` and `open {session}`.

**Acceptance bar:**

- Each task's own files pass.
- `bunx tsc --noEmit -p tsconfig.json`, `bun run ui:lint` and `bun run ui:scoreboard:check` pass.
- The PR's full-suite run shows no new failures.
- A manual check against a real Claude session confirms the countdown matches the reported tiers (logic: Success).

## Non-goals

- Terminal-session headers and terminal tab titles (`plugins/quirky.terminal` `customTitle` is separate and untouched).
- Automatic titles.
- Dollar cost, plan window, context ring.
- Exact OpenAI cache timing.
- A shared inline-edit component, a hover-card component.
- Changing `quirky.session/resume`'s structured fork refusal.

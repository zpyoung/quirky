# Automation parity implementation contracts

Status: ready for combined specification review. Behavior: [logic.md](logic.md).

## Architecture

Implements [scope](logic.md#scope) and [conceptual model](logic.md#conceptual-model) in three disjoint vertical slices. Existing Bun/SQLite loop storage owns compact summaries; the React worktree sidebar consumes public RPC and reports the actual projection; AutomationsPage owns transient menu dismissal. No kernel/protocol schema or migration change.

## Code references

Implements [S1–S5](logic.md#behavior--scenarios). Paths below are relative to repository root `/Users/zpyoung/orca/workspaces/quirky/build-roadmap`; implementer worktrees contain the same paths.

- `plugins/quirky.automations/src/list/AutomationsPage.tsx`: openMenuKey state near426, reportState761, refreshAll792, keyboard effect1055, native/external menus1120–1158. Existing list-ui.test.ts renders this exact component.
- `plugins/quirky.loops/src/types.ts`: LoopState, LoopSnapshot and LoopServiceContract. Add LoopSummary without altering LoopSnapshot.
- `plugins/quirky.loops/src/store.ts`: LoopStore.listLoops currently hydrates history and queue data. Add an independent summary query, never call listLoops/getLoop to construct summaries.
- `plugins/quirky.loops/src/service.ts`: LoopService.list near413. Add summaries with existing start/requireActive ownership behavior.
- `plugins/quirky.loops/main.ts`: handlers list near295; register summaries strict empty params.
- `plugins/quirky.loops/quirky-plugin.json` and `cli.ts`: declare read-only summaries method and expose `quirky loop summaries` through the plugin's existing CLI dispatch/formatting convention.
- `plugins/quirky.worktree/src/WorktreesSection.tsx`: shared sidebar subscriptions and buildReport invocation. Mount exactly one new loop-projection hook here, not per card.
- `plugins/quirky.worktree/src/Tree.tsx`: WorktreeCard status slot69, Tree props and card invocations. Carry the selected loop projection down without replacing existing session/orchestration inputs.
- `plugins/quirky.worktree/src/report.ts`: WorkspaceReport, ReportInput and buildReport include the same selected projection shown by the card.
- `plugins/quirky.worktree/src/useOrchestrationRows.ts`: reference for optional-plugin availability, disconnect/reconnect, generation fencing and cleanup; reuse conventions, not the worker-specific paging abstraction.
- `plugins/quirky.loops/src/ui.tsx`: loopTabIsBound near83–119 is the existing strict hosted-view identity convention.
- `plugins/quirky.terminal/src/layout/types.ts`: public RPC result has workspace.root with group/split nodes and group.tabs; hosted tabs have kind/viewId/key/input/closeMethod/closeParams. Do not import this other plugin's private types in production.
- `plugins/quirky.terminal/src/layout/service.ts`: workspace({workspace, ensure?}) near508 returns the existing/empty layout; omit ensure so it never creates a default terminal. It may materialize an empty stored layout; no shell/provider launch/focus is permitted.

## Contracts & interfaces

Implements [S3–S5](logic.md#behavior--scenarios).

CONTRACT: `LoopSummary` is a public TypeScript shape with `id: string`, `worktreeId: string`, `state: 'running' | 'needs-you' | 'paused'`, `pauseReason: PauseReason | null`, `iterationsCompleted: number`, `maxIterations: number | null`, `updatedAt: number`.

CONTRACT: `LoopStore.listSummaries(): LoopSummary[]`; `LoopService.summaries(): Promise<LoopSummary[]>`; LoopServiceContract declares summaries. `quirky.loops/summaries` accepts exactly an empty object and returns the summary array. `quirky loop summaries --json` returns equivalent rows through the normal plugin envelope; text output identifies workspace, loop, state/reason and count/cap.

- Summary SQL selects only id, worktree_id, state, pause_reason, iterations_completed, updated_at, and the cap via JSON extraction from config_json. Filter running/needs-you/paused in SQL. Sort updated_at descending then id ascending. Do not read config bodies, loop_iterations or loop_queue_state.
- Service awaits startup/recovery before reading. Newer read-only stores can read summaries. No new persistence or write is added.
- Existing list/get/iterations/create and edit semantics are unchanged.
- One sidebar hook loads plugin availability, compact rows and attachment evidence. Use public `plugin.list`, `quirky.loops/summaries`, and `quirky.terminal/workspace` only. Cache one layout result per distinct live worktree per refresh; no per-loop/per-card layout calls. Omit ensure.
- A matching hosted view requires tab.kind=view, viewId=`view:quirky.loops/loop`, key=loop.id, input.loopId=loop.id, closeMethod=`quirky.loops/viewCloseGuard`, closeParams.loopId=loop.id, and closeContext=true. Traverse split/group layout nodes. Successful no-match means detached. Missing/failed/unparseable workspace data means unknown attachment, never detached.
- Apply summary freshness first: disconnected or failed summary reads force every cached unfinished loop to unverifiable, including needs-you. Only with fresh summary evidence derive an individual presentation in this order: needs-you; paused with pauseReason unverifiable; unknown attachment evidence as unverifiable; detached when no matching hosted view; running; paused with its reason. For selection across loops rank needs-you0, unverifiable1, running2, paused3, detached4; tie newest updatedAt then smallest id. Thus fresh needs-you outranks unknown attachment, but stale needs-you does not outrank the global freshness override. A detached loop retains its durable state in the report; a paused detached loop has detached presentation unless explicitly unverifiable.
- No limit cap: `Loop N · state`. Finite cap: `Loop N/MAX · state`. For paused presentation append `: <pauseReason>` when non-null. All labels use completed iteration counts, not guessed active attempt numbers.
- Report selection as `loop: {id, state, pauseReason, presentation, iterationsCompleted, maxIterations, label}` on each workspace row when a candidate exists. Keep legacy session status/display fields intact. Top-level `loops: {status: 'loading' | 'available' | 'unavailable' | 'disabled', error: string | null}` records shared summary availability. Existing unread=true distinguishes the unread bell's drawing override. Consumers identify the glyph through role/title/accessible label, not incidental CSS class names.
- UnreadBell retains drawing precedence. Otherwise a selected loop uses a small repeat glyph with accessible role img, title and aria-label equal to label. Ended/no loops restore StatusDot. The JSON loop field describes available loop evidence even while unread overrides the icon.
- On loop changed, terminal layout, plugin availability change or reconnection, refresh shared data. Coalesce bursts; fence older requests and disposed contexts. A plugin disable clears rows immediately after its confirmed availability check and invalidates in-flight reads. On disconnect/read failure preserve known unfinished identities but mark their presentation unverifiable. A successful empty snapshot clears them. Never invent a loop for a workspace not in the catalog.

Implements [S1–S2](logic.md#behavior--scenarios).

- Escape closes an open native or external row action menu first, consumes default/bubbling as necessary to prevent detail/list navigation, and restores focus to that menu's own trigger. No command is executed. Opening a different row continues to replace the previous menu.
- Escape inside a confirmation retains its existing confirmation semantics and cannot fall through to a hidden row menu. List refresh clears the open menu before awaiting data.
- An ordinary key or Escape with no row menu retains existing editable-field/detail navigation behavior. Do not add broad global keyboard interception unrelated to row menus.
- Include `openMenuKey` in the actual rendered page report so API inspection can distinguish open versus dismissed state. No new persistent navigation field is required; this is transient presentation state.

## Data models / schemas

Implements [S5](logic.md#behavior--scenarios). Manifest summaries result is an array with strict object items matching LoopSummary. The kernel accepts only a scalar string `type` and no nullable/union keyword: `pauseReason` and `maxIterations` therefore use description-only scalar schemas documenting string-or-null and integer-or-null; service construction and the consumer validate those values. Other fields carry their normal supported types; every field is required and additional properties are forbidden. Params are type object, additionalProperties false, properties empty. No kernel schema expansion, aliases, legacy fields or history-shaped fallback. Worktree production consumer validates the public compact shape and public layout contract, never casts arbitrary records to a full private snapshot. Existing snapshot events may invalidate the projection but must not be stored wholesale in the sidebar.

## DO-NOT-CHANGE fences

Implements [decisions locked](logic.md#decisions-locked).

- Loop driver/decision/evidence policy, ownership, protected-path/checkpoint safety, approval boundaries, restart behavior and structured session lifecycle: already have consumer regressions and are not necessary for a read-only summary.
- Automations scheduler/dispatch/store and owner preconditions: dismissal cannot alter execution or deletion rules.
- Worktree normal status.ts and StatusDot behavior, unread priority, orchestration rows, filters and menu actions: do not replace unrelated glyph semantics.
- Protocol model and persisted migrations: this projection adds no durable entity, and no provenance scaffolding belongs in these fixes.
- Existing native handoffs and other queue records: preserve owners; only queue.ts changes the queue/index.

## Always / Ask / Never

Implements [scope](logic.md#scope).

- Always preserve public plugin isolation, explicit CLI/API equivalence, actual JSON UI state, generations, subscriptions and teardown. Tests use fresh homes and stop owned children.
- Ask locally via recorded autonomous decision, never a person. A conflict with locked architecture blocks the relevant flow instead of silently changing it.
- Never fetch iteration output into the sidebar; never infer remote ownership; never create a default shell or focus a workspace to inspect attachment; never mark a failed read empty; never weaken tests to accept the reported defect.

## Cross-cutting

Implements [S4](logic.md#behavior--scenarios). Summaries disclose no prompt/output/cwd/notes content. No write, migration or rollback work. Optional plugin removal revokes the projection; stale asynchronous completions cannot resurrect it. Browser claims are web-only; native OS menu/banner/focus remain in existing pending files. Linux/Windows event/process/keyboard behavior remains unverified and is recorded as platform-deferred, not silently asserted.

## Testing strategy

Implements [verification](logic.md#verification).

- Menu owner files: add focused rendered regression in `plugins/quirky.automations/test/menu-ui.test.ts` (new, reuse existing list-ui registration/mount conventions) or extend list-ui if substantially simpler. Native and OpenClaw Escape, focus, refresh and no side effects are consumer assertions. Existing actual daemon list-api tests remain; real built-web goal proves actual menu interaction.
- Summary owner: `plugins/quirky.loops/test/summaries.test.ts` (new) uses the real loop rig/API/CLI with controlled native adapter. Assert unfinished states, workspace identity, count/cap, ended exclusion, no history payload and strict params. Store-level boundary may instrument disallowed history reads as an invariant only alongside real behavioral API coverage.
- Sidebar owner: `plugins/quirky.worktree/test/loop-status.test.tsx` (new) for multi-loop priority/workspace isolation/detached vs failed-layout/unread/end/recovery/stale response/unmount. Use current UI fixtures and actual report callback. Add `plugins/quirky.worktree/test/loop-status-api.test.ts` (new) for real daemon+window loop lifecycle/UI report and public projection. No protocol text/wiring-only assertions.
- Literal focused commands: `bun test plugins/quirky.automations/test/menu-ui.test.ts`; `bun test plugins/quirky.loops/test/summaries.test.ts`; `bun test plugins/quirky.worktree/test/loop-status.test.tsx`; `bun test plugins/quirky.worktree/test/loop-status-api.test.ts`. If existing file chosen instead, update this spec and command before dispatch.
- Stage tests first; orchestrator runs red proof before production edits, since implementers must skip midflight checks. Then implement three disjoint components against committed contracts, audit scope/HEAD and run focused checks once after all return. No successor implementation wave; no unnecessary checkpoint review.
- Build `bun run build`; actual isolated daemon/native scripted provider and visible web/yours/unattended goals cover S1–S3 menu dismissal and loop indicator lifecycle. S4's fault/disconnect/stale-response behavior is exercised through rendered/headless-window regression scenarios; no app-visible control is invented to drop the transport. Tool-limited results retain exact reports and do not become passes. Stop owned daemon/PTY/provider children and remove temporary homes.
- Final gates: `bun scripts/suite.ts plugins/quirky.automations plugins/quirky.loops plugins/quirky.worktree plugins/quirky.terminal plugins/quirky.sidebar-extras plugins/quirky.ledger packages/ui`; `bun test scripts`; `bun run typecheck`. Full repo suite is canonical land's responsibility.

## Non-goals

See [non-goals](logic.md#non-goals) and [deferred ideas](logic.md#deferred-ideas). No empty provenance/mobile/remote API scaffold is added. A single follow-up records those real missing contracts; existing remote automation, prior loop-visible review and native owners remain authoritative.

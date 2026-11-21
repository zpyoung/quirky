# Subagents in native chat: tech spec

**Status:** Draft (complexity gate fired: crosses the quirky.structured runners, the protocol package, the quirky.session chat UI and the visual panel).

**Logic spec:** [logic.md](logic.md). The signed-off mock is `mock/mock.html` (v2), and the inventory is `mock/screens.md`.

All paths are relative to the repo root. These abbreviations are used throughout:

| Abbreviation | Path |
|---|---|
| `P/` | `plugins/quirky.structured/` |
| `S/` | `plugins/quirky.session/src/window/chat/` |
| `PR` | `packages/protocol/src/` |
| `$SDK` | `@anthropic-ai/claude-agent-sdk` 0.3.284, pinned at `P/package.json:8`. Its types are in the bun cache: `~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.3.284@@@1/sdk.d.ts` and `sdk-tools.d.ts` |

## Architecture

There are six units. Each sits in one plugin or package, and they meet only at the contracts pinned below.

| Unit | Home | Owns |
|---|---|---|
| **Protocol** | `PR/chat.ts` | the `agent` tag on every chat item, the `agent` item, the `from` field on `ask`, `AgentCapabilities.subagents` and `stopAgent`, and `UsageResult.subagentTokens` |
| **Claude adapter** | `P/claude-runner.ts`, `P/items.ts` (Claude section) | spawn detection, tagging every entry, task events, per-agent streaming, per-agent stop, attributed approvals, keeping background agents open, and SDK summaries |
| **Codex adapter** | `P/codex-runner.ts`, `P/items.ts` (Codex section) | keeping child-thread events, mapping a child thread to an agent, child approvals, child interrupt, child usage, and collab items driving agent state |
| **pi/omp adapter** | `P/pi-runner.ts`, `P/pi-rpc.ts`, `P/items.ts` (pi section) | omp subagent subscription, omp lifecycle, progress and events, `cancel_subagent`, and pi's `subagent` tool shown as an agent without steps |
| **Structured core** | `P/main.ts`, `P/runner.ts`, `P/quirky-plugin.json` | the `stopAgent` method, the `agent-summaries` setting, cut-off recovery on activate, and the usage split |
| **Chat UI** | `S/agents.ts` (new), `S/turns.ts`, `S/Turn.tsx`, `S/AgentDock.tsx` (new), `S/AgentsCard.tsx` (new), `S/VisualPanel.tsx`, `S/ChatView.tsx`, `S/ChatHeader.tsx`, `plugins/quirky.session/ui-scoreboard.json` | hiding tagged items from the main turn, markers and folding, the dock, the Agents card, the header label and token split, and the ask "Open" link |

Data flow (see [Data flow](logic.md#data-flow)):
1. A runner sees a spawn. It journals an `agent` item whose `id` is the agent key, tagged with the parent's key. A top-level agent has no tag.
2. The runner tags every entry produced inside that agent with its key (`agent` on the item), and journals an updated `agent` item on every state change.
3. The UI groups the journal. Tagged items leave the main turn. `agent` items become markers in their parent's transcript. `S/agents.ts` derives the agent tree, which feeds the dock, the Agents card and the header.

## Code references

### Protocol
- `PR/chat.ts:11-47`: the `ChatItem` union. `:4`: `CallState`. `:75`: `AgentCapabilities`. `:104`: `UsageResult`.
- `packages/protocol/src/model.ts:573`: `StructuredMessage`. **Do not add fields here.** The tag lives on the item, so it is stored in the existing `item` JSON column (`P/journal.ts:194` write, `:240` read) with no migration.

### Claude adapter
- `P/claude-runner.ts`:
  - `:430-448`: `query()` options. Add `forwardSubagentText` and `agentProgressSummaries` here.
  - `:~55-70`: `ClaudeQuery` narrow type. Add `stopTask`.
  - `:~200-260`: `Running` state.
  - `:896`: `pump()`.
  - `:987`: `trackTurn`.
  - `:1003`: `openTurn`.
  - `:1011`: `journal()`. Streaming is at `:1015-1020`, keyed by the literal `'assistant'` at `:1017`. The `result` close is at `:1071-1075`. `claudeEntries` is called at `:1078`.
  - `:971`: `reportCacheUsage`, which skips subagents. Keep that.
  - `:954`: `reportResultUsage`.
  - `:590`: `interrupt`. `:609`: `stop`.
  - `:629`: `canUseTool`, which ignores the third `options` argument today.
- `P/items.ts`:
  - `:4`: `ItemEntry`.
  - `:31`: `summarizeInput`.
  - `:77`: `CallTracker`, with `settle` at `:130`.
  - `:165`: `closingEntries`.
  - `:180`: `ProseStream`. `push(key, …)` and `reset(key?)` already take a key.
  - `:233`: `claudeToolItem`.
  - `:284` and `:308`: `claudeEntries` and `claudeEntriesUnchecked`. The system default branch is at `:~370`, where `task_*` messages become status lines today.
  - `:295`: `agentKeyOf`, which already returns `parent_tool_use_id ?? ''`.
- `$SDK/sdk.d.ts`:
  - `:5970`: `SDKTaskStartedMessage`, with `task_id`, `tool_use_id?`, `description`, `subagent_type?`, `is_backgrounded?`, `spawn_depth?` and `prompt?`.
  - `:5945`: `SDKTaskProgressMessage`, with `usage.total_tokens`, `last_tool_name?` and `summary?`.
  - `:5915`: `SDKTaskNotificationMessage`, with `status` (`completed`, `failed` or `stopped`), `summary` and `usage?`.
  - `:6006`: `SDKTaskUpdatedMessage`.
  - `:3694`: `SDKBackgroundTasksChangedMessage`, which replaces the whole set.
  - `:1862`: `forwardSubagentText`.
  - `:2062`: `agentProgressSummaries`.
  - `:3205`: `Query.stopTask(taskId)`.
  - `:213` / `:275-279`: `CanUseTool` options `toolUseID` and `agentID?`.
  - `:3603`: `parent_tool_use_id` on assistant and user messages.
- `$SDK/sdk-tools.d.ts`:
  - `:750`: `AgentInput`, with `description`, `prompt`, `subagent_type?`, `model?`, `run_in_background?` and `name?`.
  - `:100-156`: `AgentOutput`, whose `status` is `completed`, `async_launched` or `remote_launched`.
- Tests:
  - `P/test/fakes/fake-query.ts`: `FakeQuery`. Add a `stopTask` recorder.
  - `P/test/claude-runner.test.ts`: `makeContext` is at `:30-66`, and the `canUseTool` describe is at `:567`, called with `{signal, toolUseID}`.
  - `P/test/items.test.ts`: the Skill interleaving block at `:118-172` is the pattern for subagent messages.

### Codex adapter
- `P/codex-runner.ts`:
  - `:329`: `thread/resume`. `:347`: `thread/start`.
  - `:34-49`: `DENY_ALL_SERVER_ARGS`, a fence (see below).
  - `:751`: `handleNotification`. `:754`: `foreignThread`. `:755-767`: the deny-all refusal, a fence. `:768`: `if (foreignThread) return`, which is the drop to replace for the default policy.
  - `:774-811`: `thread/tokenUsage/updated`.
  - `:~820`, `:832`, `:862`, `:880`: `turn/started`, `turn/completed`, `item/started` and `item/completed`.
  - `:1065+`: `handleServerRequest`. `:1138-1141`: declines any approval whose thread or turn is not the parent's. `:1143-1149`: builds the prompt.
  - `:~445-470`: `interrupt`, which sends `turn/interrupt {threadId, turnId}`.
- `P/items.ts:464` / `:473`: `codexEntries` and `codexEntriesUnchecked`. `:560`: the default branch, where collab items become a status line today.
- Protocol shapes, generated by `codex app-server generate-ts --experimental` on codex-cli 0.158.0:
  - `Thread.parentThreadId` (set only for sub-agents), `agentNickname` and `agentRole`.
  - `collabAgentToolCall {tool, status, senderThreadId, receiverThreadIds, prompt, model, agentsStates}`.
  - `subAgentActivity {kind: started|interacted|interrupted|completed, agentThreadId, agentPath}`.
  - `CollabAgentStatus`: `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown` or `notFound`.
  - Child notifications carry the child's `threadId`.
  - `codex features list` shows `multi_agent stable true`, so sub-agents are on by default.
- Tests:
  - `P/test/fakes/codex-app-server.ts`: `turnScript.notifications` and `serverRequests`, and `threadNotifications` (`:167-188`).
  - `P/test/codex-runner.test.ts:361-425`: the existing scripted-notification pattern.
  - `P/test/tool-policy.test.ts:~594-632`: the deny-all second-agent cases, which must keep passing.

### pi/omp adapter
- `P/pi-runner.ts`:
  - `:625`: `onFrame`. `:635`: `handleFrame`, whose `default: return` drops unknown frames.
  - `:494`: `beginTurn`.
  - `:402`: `interrupt`. `:417`: `stop`.
  - `:753`: `onUiRequest`.
  - `:612`: `refuseTool`, the deny-all path.
- `P/pi-rpc.ts:56`: `piLaunchArgs`.
- `P/items.ts:668` / `:677`: `piEntries` and `piEntriesUnchecked`. `:620`: `piToolItem`.
- omp wire types, read from omp 18.13.3 source under `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/`:
  - `wire/commands.ts:149`: `set_subagent_subscription {level: off|progress|events}`, default `off`.
  - `cancel_subagent {subagentId}`.
  - `wire/frames.ts:60-95`: the `subagent_lifecycle`, `subagent_progress` and `subagent_event` frames.
  - The parent `task` tool call's `toolCallId` equals the lifecycle frame's `parentToolCallId`.
- pi 1.5.2 has no subagent frames. Its example extension's `subagent` tool arrives as an ordinary `tool_execution_start` and `tool_execution_end`.
- Tests:
  - `P/test/fakes/pi-transport.ts`: `FakePiTransport.emit` and `replies`.
  - `P/test/pi-runner.test.ts`: parameterized over `['pi','omp']`. Tool calls are at `:191`, approvals at `:238`, and stop at `:505-541`.

### Structured core
- `P/runner.ts:104`: `StructuredRunner`. `:41-47`: `createAsk` and `cancelAsk`. `:~55`: `reportUsage`.
- `P/main.ts`:
  - `:237`: `activate`.
  - `:619`: `createAsk`, whose journaled item is at `:~661-675`.
  - `:780`: `reportUsage`.
  - `:1878`: the `usage` method, registered at `:2220`.
- `P/native-questions.ts:81`: `approvalSpec`.
- `P/quirky-plugin.json:540`: the `default-visual-level` setting, which is the pattern for a new `contributes.setting` entry. The method declarations sit beside the existing `usage` method.

### Chat UI
- `S/turns.ts`:
  - `:19-32`: `Block`. `:37`: `Turn`.
  - `:75`: `groupTurns`. `:84`: `groupChatTurns`.
  - `:90`: `groupOne`. The filter hook goes after the user-item branch, at `:112-117`.
  - `:184`: `toBlocks`. The activity fold is at `:197-203`.
  - `:250`: `categoryOf`. `:282`: `summarizeActivity`.
- `S/Turn.tsx`:
  - `:115`: `BlockView`, an exhaustive switch. The `ask` case is at `:142-152`.
  - `:187`: `TurnView`.
  - `:51`: `planRow`, the model for the marker row style.
- `S/Activity.tsx`: the model for the folded line.
- `S/cards/Card.tsx`: `CallDot` (`:82`), `Chevron` (`:144`) and `CommandLine` (`:153`).
- `S/ChatView.tsx`:
  - `:191-199`: `turns` and `history`.
  - `:212-221`: panel state.
  - `:227`: `openVisual` and `focusRequest`.
  - `:316-330`: subscriptions.
  - `:~578`: `onOpenPlan`.
  - `:~590`: `VisualPanel`.
  - `:~620`: `Composer`. The dock goes directly above it.
- `S/VisualPanel.tsx`:
  - `:46`: `PLAN`, the special card key to mirror for `AGENTS`.
  - `:230`: props.
  - `:338-358`: the focus effects.
  - `:400-410`: the rail and fresh badge.
  - `:412`: `planCard`.
  - `:431`: `nothing`.
  - `:451-481`: the header and tab strip.
- `S/ChatHeader.tsx`:
  - `:104`: `useUsage`.
  - `:238-253`: the status derivation.
  - `:60`: `tokenBreakdown`.
  - `:~203-217`: `fit`.
  - `:~330`: the ⋯ menu items.
- `S/chatLayout.ts:35-84`: how a window reads, follows and writes a global setting, and exposes it as a checked menu entry.
- `plugins/quirky.ask/src/AskCard.tsx:146-147`: renders `spec.title`, which is shown in the Questions panel and the embedded card.
- Tests:
  - `plugins/quirky.session/test/chat-view.test.ts`: `mountChat` is at `:399`. The grouping suites start at `:179`, and the panel suite at `:1979`.
  - `plugins/quirky.session/test/chat-header.test.ts`: `mount` is at `:92`.
  - `plugins/quirky.session/test/ui-fake.ts`.

## Contracts & interfaces

### Protocol (see [Conceptual model](logic.md#conceptual-model))

SCHEMA: (`PR/chat.ts`)
```
type AgentKey = string                     // Claude: the Agent tool_use id; Codex: child threadId; omp: subagent id; pi: the subagent tool call id
type AgentState = 'working' | 'needs-you' | 'done' | 'failed' | 'stopped'
type ChatItem = (…existing members…) & { agent?: AgentKey }   // the agent that produced this item; absent = main agent
agent item: { kind: 'agent'; id: AgentKey; name: string; task: string; model?: string;
  background?: boolean; state: AgentState; cutOff?: boolean; refused?: string;
  startedAt: number; endedAt?: number; tokens?: number; summary?: string;
  report?: string; error?: string; steps: 'full' | 'none'; nativeId?: string }
ask item gains: from?: AgentKey               // the agent that asked; the ask still renders in the main turn
AgentCapabilities gains: subagents?: 'full' | 'states' | 'none'; stopAgent?: boolean
UsageResult gains: subagentTokens: number      // already included in conversation.total
```

- **Invariant:** an `agent` item's own `agent` tag is its parent's key, because the spawn happens in the parent's stream. Top-level agents carry no tag.
- **Invariant:** the latest `agent` item for an `id` wins, the same rule as `callId`. Each one is a full snapshot, never a patch.
- `quiet` is never journaled. The UI derives it (see `S/agents.ts`).
- `nativeId` is the provider's handle for stop: the Claude `task_id`, the Codex child thread id, or the omp subagent id.

### Runner contract (all adapters)

CONTRACT: (`P/runner.ts`)
```
StructuredRunner.stopAgent?(sessionId: string, agent: AgentKey): Promise<void>
```

The `stopAgent` contract:
- It stops that agent and every live descendant, and journals each one as `state: 'stopped'`.
- It never ends the turn.
- An unknown or finished agent is a no-op.
- It is absent when `capabilities.stopAgent` is false.

Every adapter must:
1. Journal an `agent` item at spawn, at each state change, and when it ends. A spawn refused by the agent is journaled with `state: 'failed'` and `refused: <message>`, and gets no later entries.
2. Tag every entry produced inside an agent, including prose, activity, cards and steps.
3. Never let an agent's events open, settle or end the parent turn. At the parent turn's end, calls that belong to a live agent stay open.
4. Key streaming prose per agent: the stream key is the agent key, and `''` for main.
5. Route an event whose parent cannot be resolved to the synthetic agent `id: 'unattributed'`, named "Unattributed" with `steps: 'full'`. It is journaled once on first use. ✗ Never drop the event, and ✗ never leave it untagged.
6. On run end (stop, process exit or failure), journal every live agent of that run as `state: 'stopped', cutOff: true`.
7. Label a subagent's approval or question:
   - `spec.title = "<agent name> asks"`;
   - the ask item carries `from`;
   - the agent goes to `needs-you` while the ask is pending, then back to `working`.

### Claude adapter (see [SC-1](logic.md#watching-agents-work)…[SC-15](logic.md#lifecycle))

**Spawn.** An `assistant` `tool_use` named `Agent` or `Task` becomes an `agent` item:
- `id` is the tool_use id, and `name` is `subagent_type ?? name ?? 'agent'`.
- `task` is `description`, `model` is `input.model`, and `background` is `run_in_background`.
- It is tagged with `agentKeyOf(msg) || undefined`.
- It is not an `activity` item, and not tracked in `CallTracker`.

**Tagging.** Every entry from a message whose `parent_tool_use_id` is a string is tagged with that id.

**Task events.**
- `task_started` records `task_id → tool_use_id`, sets `nativeId`, and sets `background` from `is_backgrounded`.
- `task_progress` updates `tokens` from `usage.total_tokens`. When the summaries setting is `ai`, it also updates `summary`.
- `task_notification` ends the agent:
  - `completed` → `done`, with `report = summary`;
  - `failed` → `failed`, with `error`;
  - `stopped` → `stopped`.
- These messages ✗ no longer become `system: task_*` status lines.

**Agent tool result.**
- `status: completed` ends the agent as `done`, with `report` taken from the first text content and `tokens = totalTokens`.
- `async_launched` keeps it `working`, with `background: true`.
- `is_error` → `failed`.

**Query options.**
- `forwardSubagentText: true` is always set.
- `agentProgressSummaries` is true only when `agent-summaries` is `ai`, read at session start and on `setting.changed`. If the SDK can't change it live, the next session picks it up. Record that in the PR.

**Other behaviour.**
- **Stop:** `query.stopTask(nativeId)` for the agent and each live descendant.
- **Approvals:** `canUseTool`'s `options.agentID` maps to the agent through `task_id`. When it can't be mapped, use `options.toolUseID`'s owner if known, otherwise main.
- **Streaming:** `run.stream.push(agentKeyOf(msg), …)`. A subagent assistant message resets only its own key.
- **Turn:** the parent `result` settles only calls not owned by a live agent.
- **Usage:** see `subagentTokens` below.

### Codex adapter (see [SC-17](logic.md#across-agents))

**Child threads.**
- In the default policy, a notification whose `threadId` is a known child is handled, not dropped.
- The deny-all branch at `:755-767` is unchanged.
- `thread/started` with `thread.parentThreadId` creates an `agent` item:
  - `id` and `nativeId` are the child thread id.
  - `name` is `agentNickname ?? agentRole ?? 'agent'`.
  - `task` is the `prompt` of the spawning `collabAgentToolCall`, when it is seen.
  - It is tagged with the parent thread's agent key, or untagged when the parent is the main thread.
- A notification from an unknown foreign thread before its `thread/started` goes to `unattributed`.

**Items.**
- Child `item/*` events go through `codexEntries` and are tagged with the child's key.
- `collabAgentToolCall` and `subAgentActivity` drive agent state and ✗ no longer become status lines:
  - `agentsStates` `running` → `working`;
  - `completed` → `done`;
  - `errored` → `failed`;
  - `interrupted` or `shutdown` → `stopped`;
  - `subAgentActivity` `completed` / `interrupted` → the same.

**Other behaviour.**
- **Per-child state:** track `activeTurnId` per child from that child's `turn/started` and `turn/completed`.
- **Approvals:** accept an approval whose `threadId` is a known child and whose `turnId` is that child's active turn. Label it per the runner contract.
- **Stop:** `turn/interrupt {threadId: child, turnId: child active turn}` for the agent and its descendants.
- **Usage:** a child's `thread/tokenUsage/updated` adds its delta to the agent's `tokens`, and to the session through `reportUsage`. Keep a per-child baseline.
- **Summary:** never AI-written. The UI shows the latest tool call.

### pi/omp adapter (see [SC-17](logic.md#across-agents))

**omp.**
- **Subscription:** after start, outside deny-all, send `set_subagent_subscription {level:'events'}`.
- **Spawn:** the parent `task` tool call is not an activity item. Each `subagent_lifecycle started` creates an agent:
  - `id` and `nativeId` are `payload.id`.
  - `name` is `payload.agent`, and `task` is `description`.
  - `background` is `detached`.
  - It is tagged with the agent owning `parentToolCallId`, or untagged for main.
- **Progress:** `subagent_progress` updates `tokens` from `progress.tokens`. When the summaries setting is `ai`, `summary = progress.lastIntent`.
- **Events:** each `subagent_event` goes through `piEntries` and is tagged with `payload.id`.
- **End:** `completed` → `done`, `failed` → `failed`, `aborted` → `stopped`.
- **Stop:** `cancel_subagent {subagentId}`.
- **Turn:** a detached agent stays live after `agent_end`.

**pi.**
- A tool call named `subagent` becomes an agent with `steps: 'none'`:
  - `id` is the toolCallId.
  - `name` is `args.agent ?? 'subagent'`, and `task` is `args.task ?? summarizeInput(args)`.
- `tool_execution_end` ends it as `done` or `failed`, with `report` set to the result text.
- `capabilities.stopAgent` is false, with the reason "pi can't stop one subagent".
- `capabilities.subagents`: pi → `'states'`, omp → `'full'`.

### Structured core

**Method.**
- `quirky.structured/stopAgent {session: string, agent: string} → {}`.
- It calls `runner.stopAgent`.
- It rejects with a user-facing message when the runner lacks it or the session isn't running.
- Declare it in `P/quirky-plugin.json`.

**Setting.**
- `setting:quirky.structured/agent-summaries` is an enum `ai | latest-tool`, with default `ai`.
- Title: "Agent status summaries".
- Description: "AI-written where the agent offers it, or the latest tool call."

**Cut-off recovery.**
- In `activate`, or the first time a session's messages are served after activation, whichever already exists:
  - for each session with no live run, journal any agent whose latest entry is live as `stopped, cutOff: true`;
  - this happens before those messages are returned.
- Idempotent.

**Usage.**
- The `usage` method returns `subagentTokens`, which is the sum of the latest `tokens` across the session chain's agent items.
- **Invariant:** `conversation.total ≥ subagentTokens`, and both figures count each token once.
- Claude: verify against a captured stream whether `result.modelUsage` already includes subagent tokens.
  - If it does, report nothing extra.
  - If it doesn't, report each agent's final token delta through `reportUsage`.
  - Record the finding in the PR.

### Chat UI (see [Screens](logic.md#screens))

CONTRACT: (`S/agents.ts`, pure)
```
type AgentView = { id, parent?: AgentKey, name, task, model?, background, state: AgentState | 'quiet',
  cutOff, refused?, startedAt, endedAt?, tokens?, line: string, report?, error?, steps,
  depth: number, children: AgentKey[], spawnSeq: number, endSeq?: number, items: StructuredMessage[] }
deriveAgents(messages: StructuredMessage[], now: number): Map<AgentKey, AgentView>
dockSummary(agents): { running: number; nested: number; needsYou: number; quiet: number; failed: number } | null
runningOrder(agents, ids): AgentKey[]           // needs-you, then quiet, then working; ties by spawnSeq
```

- **`line`:** `summary` when present, otherwise the latest tagged tool call's `summary` or `command`, otherwise `task`.
- **`quiet`:**
  - an agent in state `working`, with no tagged item and no `agent` entry in the last 120 s;
  - and no tagged call still `running`.
- **`items`:** the agent's own tagged messages, so `groupTurns(items)` draws its transcript.
- **`dockSummary`:** returns null when nothing is live. `running` counts top-level live agents, and `nested` counts live agents of depth ≥ 1.

`S/turns.ts`:
- `groupOne` drops every item whose `agent` tag is set from the main turn, except `agent` items, which have their own rule.
- An untagged `agent` item becomes a `spawn` marker entry the first time its `id` appears.
- Its first terminal entry becomes a `return` marker, appended to the turn that holds its spawn marker, even when it arrives after that turn ended.
- An `ask` with `from` stays in the main turn.

New `Block` kinds:
- `{kind:'agent-marker', seq, agent: AgentKey, phase: 'spawn'|'return'}`;
- `{kind:'agent-fold', seq, agents: AgentKey[], phase}`, which `toBlocks` emits for 4 or more consecutive markers with the same phase.

The same grouping runs on an agent's own items, so nested markers appear in the parent's transcript.

`S/Turn.tsx`, `BlockView`:
- It renders both marker kinds through a new marker row, styled like `planRow`.
- The `ask` case adds an "Open <name>" control when `from` is set.
- It takes a `agents: Map<AgentKey, AgentView>` and an `onOpenAgent(agent: AgentKey | null)` prop through `TurnView`.

`S/AgentDock.tsx`:
- Renders `dockSummary`, or nothing.
- It is placed in `ChatView` directly above `Composer`, using `chatFrame(layout)`.
- A click calls `onOpenAgent(null)`, which selects `runningOrder(...)[0]`.

`S/AgentsCard.tsx`:
- **List:**
  - a Running group in `runningOrder`, with descendants indented under each row;
  - then Done, collapsed past 3 agents.
  - Hovering a running row shows Stop.
- **Selected transcript:**
  - header, folded prompt, and `groupTurns(agent.items)` rendered with `BlockView`;
  - a live `line` while running;
  - for `steps: 'none'`, the note "This agent doesn't report its subagents' steps".
- **Stop:** calls `quirky.structured/stopAgent`, and is disabled with the reason when `capabilities.stopAgent` is false.

`S/VisualPanel.tsx`:
- A second special key, `AGENTS`, beside `PLAN`.
- An `agents` prop: `{views, selected, nonce} | null`, null until the first agent.
- Tab text: `Agents N`. A focus request expands a collapsed panel, like the plan effect at `:338-343`.
- `nothing` accounts for agents.
- The header title stays "Visuals".

`S/ChatView.tsx`:
- Derives `agents = deriveAgents(history, now)`, with `now` ticking every 1 s while any agent is live.
- Passes it to `TurnView`, `AgentDock`, `VisualPanel` and `ChatHeader`.
- `onOpenAgent` sets the agents focus request.

`S/ChatHeader.tsx`:
- When the status is not `working` or `waiting` and live agents > 0, append ` · N agent(s) running` to the label.
- `tokenBreakdown` adds `Main` and `Subagents` lines when `subagentTokens > 0`.
- Widen `fit`'s label estimate accordingly.
- The ⋯ menu gets a checked "Agent status summaries" pair (AI-written / Latest tool call), using the `chatLayout.ts` setting pattern against the `quirky.structured` setting id.

## Data models

All shared shapes are pinned in `PR/chat.ts` (above). There is no new storage, and no SQL migration.

Test fixtures:
- Claude message fixtures stay inline in `P/test/items.test.ts` and `P/test/claude-runner.test.ts`, following the captured 0.3.284 shapes.
- Codex child-thread fixtures go in `P/test/fakes/codex-app-server.ts`, as a new `childThreads` option. It emits `thread/started` with `parentThreadId`, then child notifications.

## DO-NOT-CHANGE fences

- **Codex deny-all:** `P/codex-runner.ts:34-49` (`DENY_ALL_SERVER_ARGS`), `:755-767` (deny-all foreign-thread refusal) and `:1026` (`refuseSecondAgent`). Deny-all sessions must still refuse any second agent; `P/test/tool-policy.test.ts` asserts it.
- **pi deny-all:** `P/pi-runner.ts:612` (`refuseTool`), and no subagent subscription in deny-all. The same guarantee applies.
- **Claude deny-all:** `tools: []` and `denyEveryTool`, because deny-all sessions run no subagents.
- **Claude cache timer:** `P/claude-runner.ts:971-980` (`reportCacheUsage` skips subagents). The cache timer tracks the main conversation's prompt cache only.
- **Activity folding:** `S/turns.ts:197-203` and `summarizeActivity`. Main-turn tool rows must look exactly as they do today.
- **The journal schema:** `P/journal.ts` migrations. The tag rides in the existing `item` JSON.

## Always / Ask / Never

**Always**
- Tag at the adapter, never in the UI.
- Write every `agent` item as a full snapshot.
- Key streams per agent.
- Keep deny-all behaviour byte-identical.
- Use `var(--ui-*)` tokens, and add each new UI surface's states and actions to `plugins/quirky.session/ui-scoreboard.json`.

**Ask** (surface in the PR description; don't block)
- Whether `result.modelUsage` already includes subagent tokens (see Usage).
- Whether `agentProgressSummaries` can change on a live query.
- Whether omp 19.x changed the wire shapes from 18.13.3.
- Whether a Codex child approval arrives on the parent connection.

**Never**
- Show a tagged item in the main turn.
- Drop an event because its agent is unknown.
- Let an agent's completion end the turn or set the chat Ready.
- Add a second store for agent data.
- Add a model call path for summaries.

## Cross-cutting

- **Security:** child approvals now reach the user. Before, Codex auto-declined them. Accept them only for known child threads and their active turn.
- **Rollback:** reverting the adapters returns subagent output to flat items. Old journals without tags render exactly as today, and tagged journals render tagged items as hidden. Stating this in the PR is enough.
- **Observability:** an adapter journals an `unattributed` agent rather than throwing.

## Testing strategy

Run files one at a time with `bun test <file>`. The full suite runs on the draft PR (AGENTS.md).

| File | Must cover |
|---|---|
| `P/test/items.test.ts` | Claude: an Agent tool_use becomes an agent item; subagent entries are tagged; task_* messages produce agent snapshots and no status lines |
| `P/test/claude-runner.test.ts` | per-agent streaming keys; a background agent survives the parent `result`; `stopAgent` calls `stopTask` for the agent and its descendants; `canUseTool` with `agentID` labels the ask and flips the state; run end journals `cutOff`; the summaries setting toggles `agentProgressSummaries` |
| `P/test/codex-runner.test.ts` | child `thread/started` creates an agent; child items are tagged; child approval is accepted and labeled; `stopAgent` interrupts the child thread; child usage feeds tokens; an unknown foreign thread goes to unattributed |
| `P/test/tool-policy.test.ts` | unchanged and passing |
| `P/test/pi-runner.test.ts` | omp subscription sent outside deny-all only; lifecycle, progress and events produce tagged items; `cancel_subagent`; pi's `subagent` tool becomes a `steps: 'none'` agent |
| `plugins/quirky.session/test/agents.test.ts` (new) | `deriveAgents` states, the quiet rule, `line`, depth, `dockSummary`, `runningOrder` |
| `plugins/quirky.session/test/chat-view.test.ts` | the main turn hides tagged items; spawn and return markers, including a return after turn end; folding at 4 or more; dock text and click; Agents card list, sort, Done collapse and nested indent; Stop calls `stopAgent`; the ask "Open" link; the steps-none note |
| `plugins/quirky.session/test/chat-header.test.ts` | "Ready · N agents running"; the token tooltip split; the summaries menu entry |

The acceptance bar:
- Every scenario SC-1 to SC-17 has a test.
- Every Screens row matches the mock.
- `bunx tsc --noEmit -p tsconfig.json`, `bun run ui:lint` and `bun run ui:scoreboard:check` are green.

## Non-goals

- A Quirky-side summarizer model.
- Messaging an agent.
- Agent tabs.
- Budgets.
- Mobile.
- PTY sessions.
- Changing the main turn's activity rendering.
- Changing `quirky.ask` beyond the spec title it already renders.

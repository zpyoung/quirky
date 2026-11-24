import type { AgentKey, CallState, ChatItem, StructuredRole, UsageTotals } from '@quirky/protocol'
import { UNATTRIBUTED, type AgentRegistry } from './agents'

/** One journal entry a normalizer derives from an agent event: the legacy role, text and raw data plus the typed item. */
export type ItemEntry = { role: StructuredRole; text: string; data: unknown; item: ChatItem }

/** The item kinds that carry a call lifecycle. */
export type CallItem = Extract<ChatItem, { kind: 'activity' | 'file-change' | 'tests' }>

type ToolEntry = { name: string; input: Record<string, unknown> }

const SUMMARY_LIMIT = 160
const CALL_TEXT_LIMIT = 2000
const DETAIL_LIMIT = 4000
const TAIL_LINES = 8
const TAIL_LIMIT = 800
const STREAM_INTERVAL_MS = 250

const TEST_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun|make)\s+(?:run\s+)?test(?::[\w-]+)?|bun\s+test|pytest|jest|vitest|go\s+test|cargo\s+test)(?=$|[\s;&|)])/

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Collapses whitespace and truncates to one display line. */
export function oneLine(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** The most telling field of a tool's input as one line, for activity summaries. */
export function summarizeInput(input: Record<string, unknown> | undefined, limit = SUMMARY_LIMIT): string {
  if (!input) return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value) return oneLine(value, limit)
  }
  return oneLine(JSON.stringify(input) ?? '', limit)
}

/** True when a shell command runs a test suite. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

const lineCount = (text: unknown): number => {
  if (typeof text !== 'string' || text === '') return 0
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length
}

/** Pass, fail and skip counts printed by common test runners; the last mention of each wins. */
export function parseTestCounts(output: string): { passed?: number; failed?: number; skipped?: number } {
  const last = (pattern: RegExp): number | undefined => {
    let found: number | undefined
    for (const match of output.matchAll(pattern)) found = Number(match[1])
    return found
  }
  const counts: { passed?: number; failed?: number; skipped?: number } = {}
  const passed = last(/(\d+)\s+(?:passed|pass)\b/gi)
  const failed = last(/(\d+)\s+(?:failed|fail|failures?)\b/gi)
  const skipped = last(/(\d+)\s+(?:skipped|skip|ignored|pending)\b/gi)
  if (passed !== undefined) counts.passed = passed
  if (failed !== undefined) counts.failed = failed
  if (skipped !== undefined) counts.skipped = skipped
  return counts
}

const tailOf = (output: string): string | undefined => {
  const trimmed = output.trimEnd()
  if (!trimmed) return undefined
  const tail = trimmed.split('\n').slice(-TAIL_LINES).join('\n')
  return tail.length > TAIL_LIMIT ? tail.slice(-TAIL_LIMIT) : tail
}

const capped = (text: string): string => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text)

/** Tracks the calls that have started and not finished, so a stop or failure can close them. */
export class CallTracker {
  private readonly open = new Map<string, CallItem>()
  private readonly tools = new Map<string, ToolEntry>()
  private readonly closed = new Set<string>()
  private readonly skills = new Map<string, CallItem>()

  get size(): number {
    return this.open.size
  }

  /** Remembers the input of a started call, for pairing with its result. */
  remember(callId: string, name: string, input: Record<string, unknown>): void {
    this.tools.set(callId, { name, input })
  }

  /** Whether the call already has a final state, so a late result for it must be dropped. */
  isClosed(callId: string): boolean {
    return this.closed.has(callId)
  }

  recall(callId: string): ToolEntry | undefined {
    return this.tools.get(callId)
  }

  /** Remembers a finished Skill call of the agent `agentKey`, so the skill content injected after it can fold into its row. */
  rememberSkill(agentKey: string, item: CallItem): void {
    this.skills.set(agentKey, item)
  }

  /** Takes the finished Skill call of the agent `agentKey` still waiting for its content, if any. */
  takeSkill(agentKey: string): CallItem | undefined {
    const item = this.skills.get(agentKey)
    this.skills.delete(agentKey)
    return item
  }

  /** Records an item: a running call stays open, anything else closes it. */
  track(item: ChatItem): void {
    if (item.kind !== 'activity' && item.kind !== 'file-change' && item.kind !== 'tests') return
    if (item.state === 'running') {
      this.closed.delete(item.callId)
      this.open.set(item.callId, item)
    } else {
      this.closed.add(item.callId)
      this.open.delete(item.callId)
      this.tools.delete(item.callId)
    }
  }

  /**
   * Closes every open call in `state` and returns the closing items. A call whose `agent` tag satisfies
   * `keep` stays open, so a parent turn's end leaves a live subagent's calls running.
   */
  settle(state: Exclude<CallState, 'running'>, keep?: (agent: AgentKey | undefined) => boolean): CallItem[] {
    const closing: CallItem[] = []
    for (const [callId, item] of this.open) {
      if (keep?.(item.agent)) continue
      closing.push({ ...item, state } as CallItem)
      this.open.delete(callId)
      this.closed.add(callId)
      this.tools.delete(callId)
    }
    if (keep === undefined) this.tools.clear()
    this.skills.clear()
    return closing
  }
}

/** A user message item. */
export function userItem(text: string, images?: string[], queuedId?: string): ChatItem {
  return {
    kind: 'user',
    text,
    ...(images && images.length > 0 ? { images } : {}),
    ...(queuedId === undefined ? {} : { queuedId })
  }
}

/** The turn-end item for a finished, stopped or failed turn. */
export function turnEndItem(state: 'done' | 'stopped' | 'failed', durationMs?: number): ChatItem {
  return { kind: 'turn-end', state, ...(durationMs === undefined ? {} : { durationMs }) }
}

/** An error row for an agent process that exited, failed to start or broke the protocol. */
export function errorItem(reason: 'exited' | 'spawn' | 'protocol', stderrTail: string[], resumable: boolean): ChatItem {
  return { kind: 'error', reason, stderrTail, resumable }
}

export const statusItem = (text: string): ChatItem => ({ kind: 'status', text })

/** The last lines of a process's stderr or an error message, trimmed to a short tail. */
export function stderrLines(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-TAIL_LINES)
}

/** Entries that close every call still running, in the order the calls were opened. */
export function closingEntries(tracker: CallTracker, state: Exclude<CallState, 'running'>, keep?: (agent: AgentKey | undefined) => boolean): ItemEntry[] {
  return tracker.settle(state, keep).map((item) => ({ role: 'tool', text: callText(item), data: { closed: state }, item }))
}

function callText(item: CallItem): string {
  if (item.kind === 'activity') return `${item.tool}: ${item.summary}`.trim()
  if (item.kind === 'file-change') return `${item.path}`
  return item.command
}

/**
 * Throttles streaming text into prose items: `push` returns the accumulated text as a streaming
 * item once a key has been streaming for a full interval and then at most once per interval, so a
 * short message never flickers; `reset` forgets a key once its final item is journaled.
 */
export class ProseStream {
  private readonly text = new Map<string, string>()
  private readonly emitted = new Map<string, number>()

  push(key: string, delta: string, now: number): ChatItem | null {
    const text = (this.text.get(key) ?? '') + delta
    this.text.set(key, text)
    const previous = this.emitted.get(key)
    if (previous === undefined) {
      this.emitted.set(key, now)
      return null
    }
    if (now - previous < STREAM_INTERVAL_MS) return null
    this.emitted.set(key, now)
    return { kind: 'prose', text, streaming: true }
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.text.clear()
      this.emitted.clear()
    } else {
      this.text.delete(key)
      this.emitted.delete(key)
    }
  }
}

function fileChangeCounts(name: string, input: Record<string, unknown>): { added?: number; removed?: number } {
  if (name === 'Edit') return { added: lineCount(input.new_string), removed: lineCount(input.old_string) }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const edit of input.edits) {
      const fields = record(edit)
      if (!fields) continue
      added += lineCount(fields.new_string)
      removed += lineCount(fields.old_string)
    }
    return { added, removed }
  }
  if (name === 'Write') return { added: lineCount(input.content) }
  return {}
}

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function claudeStepState(status: unknown): 'pending' | 'active' | 'done' {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'active'
  return 'pending'
}

function claudeToolItem(callId: string, name: string, input: Record<string, unknown>, state: CallState, output?: string): ChatItem {
  if (CLAUDE_EDIT_TOOLS.has(name)) {
    const path = input.file_path ?? input.notebook_path
    if (typeof path === 'string') return { kind: 'file-change', callId, path, ...fileChangeCounts(name, input), state }
  }
  const command = typeof input.command === 'string' ? input.command : ''
  if (name === 'Bash' && command && isTestCommand(command)) {
    return {
      kind: 'tests',
      callId,
      command: oneLine(command, CALL_TEXT_LIMIT),
      ...(output === undefined ? {} : parseTestCounts(output)),
      state,
      ...(output === undefined || tailOf(output) === undefined ? {} : { tail: tailOf(output) })
    }
  }
  return {
    kind: 'activity',
    callId,
    tool: name,
    summary: summarizeInput(input, CALL_TEXT_LIMIT),
    state,
    ...(output ? { detail: capped(output) } : {})
  }
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function resultSummary(msg: any): string {
  const summary =
    typeof msg.result === 'string' && msg.result
      ? msg.result
      : [msg.subtype, ...(Array.isArray(msg.errors) ? msg.errors : [])].filter(Boolean).join(': ') || 'finished'
  const details: string[] = []
  if (typeof msg.total_cost_usd === 'number') details.push(`$${msg.total_cost_usd.toFixed(4)}`)
  if (typeof msg.duration_ms === 'number') details.push(`${(msg.duration_ms / 1000).toFixed(1)}s`)
  return details.length ? `${summary}\n(${details.join(', ')})` : summary
}

/**
 * The subagents of one Claude run: the shared registry plus the ids the SDK uses for the same agent in
 * different messages. `summaries` is the `agent-summaries` setting read when the session started.
 */
export class ClaudeAgents {
  /** task_id of a `local_agent` task to the id of the spawn that started it. */
  private readonly tasks = new Map<string, AgentKey>()
  /** AgentOutput.agentId to spawn id. */
  private readonly agentIds = new Map<string, AgentKey>()
  private readonly started = new Set<AgentKey>()

  constructor(
    readonly registry: AgentRegistry,
    readonly summaries: 'ai' | 'latest-tool' = 'ai'
  ) {}

  /** Records that the task `taskId` is the spawn `spawnId`, and that the spawn has really started. */
  noteTask(taskId: string, spawnId: AgentKey): void {
    this.tasks.set(taskId, spawnId)
    this.started.add(spawnId)
  }

  noteAgentId(agentId: string, spawnId: AgentKey): void {
    this.agentIds.set(agentId, spawnId)
  }

  hasStarted(spawnId: AgentKey): boolean {
    return this.started.has(spawnId)
  }

  /** The agent a task id, an AgentOutput agentId or a spawn id belongs to, or undefined when none is known. */
  ownerOf(id: string | undefined): AgentKey | undefined {
    if (id === undefined || id === '') return undefined
    return this.tasks.get(id) ?? this.agentIds.get(id) ?? (this.registry.has(id) ? id : undefined)
  }
}

const withAgent = (item: ChatItem, agent: AgentKey | undefined): ChatItem => (agent === undefined ? item : { ...item, agent })

/**
 * Normalizes one Claude Agent SDK message into journal entries; a tool call opens one running
 * entry and closes with a second sharing its `callId`. Never throws: anything unrecognized
 * becomes a `status` item.
 *
 * With `agents`, an `Agent` or `Task` tool call becomes an `agent` item, task events update it, and
 * every entry produced inside a subagent is tagged with that agent (an unknown one with `unattributed`,
 * whose spawn entry comes first). Without it the message is normalized as for a run with no subagents.
 */
export function claudeEntries(msg: any, calls: CallTracker, agents?: ClaudeAgents): ItemEntry[] {
  try {
    const resolved = agents ? agents.registry.resolve(agentKeyOf(msg)) : { agent: undefined, entries: [] as ItemEntry[] }
    const produced = claudeEntriesUnchecked(msg, calls, agents, resolved.agent)
    const tagged = produced.map((entry) => (resolved.agent === undefined || entry.item.kind === 'agent' ? entry : { ...entry, item: withAgent(entry.item, resolved.agent) }))
    return [...resolved.entries, ...tagged]
  } catch {
    return [{ role: 'system', text: String(msg?.type ?? 'event'), data: msg, item: statusItem(String(msg?.type ?? 'event')) }]
  }
}

/** Plan-mode tools reach the transcript as `plan` and `mode` items, never as tool activity. */
const PLAN_MODE_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode'])
/** The agent a Claude message belongs to: the main agent, or the subagent spawned by its parent tool call. */
const agentKeyOf = (msg: any): string => (typeof msg?.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : '')

/**
 * Content the CLI adds to the conversation itself (`isSynthetic`), never something the user typed.
 * After a Skill call it is the skill's SKILL.md, shown as that call's output; otherwise a status item.
 */
function syntheticEntry(msg: any, calls: CallTracker): ItemEntry {
  const text = blockText(msg.message?.content)
  const skill = calls.takeSkill(agentKeyOf(msg))
  if (skill?.kind === 'activity') return { role: 'tool', text, data: msg, item: { ...skill, detail: capped(text) } }
  return { role: 'system', text, data: msg, item: statusItem('Claude added context') }
}

function claudeEntriesUnchecked(msg: any, calls: CallTracker, agents: ClaudeAgents | undefined, agent: AgentKey | undefined): ItemEntry[] {
  switch (msg?.type) {
    case 'assistant': {
      calls.takeSkill(agentKeyOf(msg))
      const content: any[] = Array.isArray(msg.message?.content) ? msg.message.content : []
      const toolUses = content.filter((block) => block?.type === 'tool_use')
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      const entries: ItemEntry[] = []
      if (text || toolUses.length === 0) entries.push({ role: 'assistant', text, data: msg, item: { kind: 'prose', text } })
      for (const block of toolUses) {
        const input = record(block.input) ?? {}
        const callId = String(block.id ?? '')
        const name = String(block.name ?? 'tool')
        const text = `${name}: ${summarizeInput(input)}`
        if (PLAN_MODE_TOOLS.has(name)) {
          calls.remember(callId, name, input)
          continue
        }
        if (agents && AGENT_TOOLS.has(name)) {
          const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
          entries.push(
            agents.registry.spawn({
              id: callId,
              ...(agent === undefined ? {} : { parent: agent }),
              name: text(input.subagent_type) ?? text(input.name) ?? 'agent',
              task: text(input.description) ?? '',
              ...(text(input.prompt) === undefined ? {} : { prompt: text(input.prompt) }),
              ...(text(input.model) === undefined ? {} : { model: text(input.model) }),
              ...(typeof input.run_in_background === 'boolean' ? { background: input.run_in_background } : {}),
              steps: 'full'
            })
          )
          continue
        }
        if (name === 'TodoWrite') {
          const todos = Array.isArray(input.todos) ? input.todos : []
          const steps = todos.flatMap((todo) => {
            const fields = record(todo)
            return fields && typeof fields.content === 'string'
              ? [{ text: fields.content, state: claudeStepState(fields.status) }]
              : []
          })
          calls.remember(callId, name, input)
          entries.push({ role: 'tool', text, data: block, item: { kind: 'steps', callId, steps } })
          continue
        }
        calls.remember(callId, name, input)
        const item = withAgent(claudeToolItem(callId, name, input, 'running'), agent)
        calls.track(item)
        entries.push({ role: 'tool', text, data: block, item })
      }
      return entries
    }
    case 'user': {
      const content = msg.message?.content
      if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) {
        const isSpawn = (block: any) => agents !== undefined && block?.type === 'tool_result' && agents.registry.has(String(block.tool_use_id ?? '')) && String(block.tool_use_id) !== UNATTRIBUTED
        const spawnResults = agents ? content.filter(isSpawn).flatMap((block: any) => agentResultEntries(agents, block, msg.tool_use_result)) : []
        const callResults = content
          .filter((block: any) => !isSpawn(block))
          .filter(
            (block: any) =>
              block?.type === 'tool_result' &&
              !calls.isClosed(String(block.tool_use_id ?? '')) &&
              !PLAN_MODE_TOOLS.has(calls.recall(String(block.tool_use_id ?? ''))?.name ?? '')
          )
          .map((block: any): ItemEntry => {
            const callId = String(block.tool_use_id ?? '')
            const output = blockText(block.content)
            const known = calls.recall(callId)
            const state: CallState = block.is_error === true ? 'failed' : 'done'
            if (known?.name === 'TodoWrite') {
              calls.track({ kind: 'activity', callId, tool: 'TodoWrite', summary: '', state })
              return { role: 'tool', text: output, data: msg, item: statusItem(`TodoWrite ${state}`) }
            }
            const item = withAgent(claudeToolItem(callId, known?.name ?? 'tool', known?.input ?? {}, state, output), agent)
            calls.track(item)
            if (known?.name === 'Skill' && state === 'done' && item.kind === 'activity') calls.rememberSkill(agentKeyOf(msg), item)
            return { role: 'tool', text: output, data: msg, item }
          })
        return [...spawnResults, ...callResults]
      }
      if (msg.isSynthetic === true) return [syntheticEntry(msg, calls)]
      const text = blockText(content)
      if (text.startsWith('[Request interrupted by user')) return []
      return [{ role: 'user', text, data: msg, item: userItem(text) }]
    }
    case 'system': {
      if (agents) {
        const taskEntries = claudeTaskEntries(msg, agents)
        if (taskEntries !== null) return taskEntries
      }
      if (msg.subtype === 'status' && typeof msg.permissionMode === 'string' && msg.status == null && msg.compact_result == null) return []
      const text = msg.subtype === 'init' ? `session started${msg.model ? ` (${msg.model})` : ''}` : `system: ${msg.subtype ?? 'event'}`
      return [{ role: 'system', text, data: msg, item: statusItem(text) }]
    }
    case 'result': {
      const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error'))
      const duration = typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined
      return [{ role: 'result', text: resultSummary(msg), data: msg, item: turnEndItem(failed ? 'failed' : 'done', duration) }]
    }
    case 'rate_limit_event':
      return [{ role: 'system', text: 'Claude rate limit event', data: msg, item: statusItem('Claude rate limit event') }]
    case 'stream_event':
      return []
    default: {
      const text = String(msg?.type ?? 'event')
      return [{ role: 'system', text, data: msg, item: statusItem(text) }]
    }
  }
}

const AGENT_TOOLS = new Set(['Agent', 'Task'])

const firstText = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const part of content) if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') return part.text
  return undefined
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** What the result of an `Agent` tool call says about the agent it spawned. */
function agentResultEntries(agents: ClaudeAgents, block: any, structured: unknown): ItemEntry[] {
  const id = String(block.tool_use_id)
  const { registry } = agents
  const output = blockText(block.content)
  const result = record(structured)
  const status = result?.status
  const agentId = nonEmpty(result?.agentId)
  if (agentId !== undefined) agents.noteAgentId(agentId, id)
  const entry = (item: ItemEntry | null): ItemEntry[] => (item === null ? [] : [item])
  if (block.is_error === true) {
    return agents.hasStarted(id) ? entry(registry.end(id, 'failed', { error: output })) : entry(registry.end(id, 'failed', { refused: output }))
  }
  if (status === 'async_launched') return entry(registry.update(id, { background: true }))
  if (status === 'completed' || (result === null && registry.get(id)?.background !== true)) {
    const report = firstText(result?.content) ?? output
    const tokens = typeof result?.totalTokens === 'number' ? result.totalTokens : undefined
    return entry(registry.end(id, 'done', { report, ...(tokens === undefined ? {} : { tokens }) }))
  }
  return []
}

/**
 * Journal entries for a `system` task message about a subagent, or null when the message is not about
 * one so the caller keeps its ordinary status line.
 */
function claudeTaskEntries(msg: any, agents: ClaudeAgents): ItemEntry[] | null {
  const subtype = msg.subtype
  if (subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_notification' && subtype !== 'task_updated') return null
  const { registry } = agents
  const taskId = nonEmpty(msg.task_id)
  const toolUseId = nonEmpty(msg.tool_use_id)
  const known = (taskId === undefined ? undefined : agents.ownerOf(taskId)) ?? (toolUseId !== undefined && registry.has(toolUseId) ? toolUseId : undefined)
  const entries: ItemEntry[] = []
  let id = known
  if (subtype === 'task_started') {
    if (id === undefined && msg.task_type !== 'local_agent') return null
    if (id === undefined) {
      id = toolUseId ?? taskId ?? 'agent'
      entries.push(
        registry.spawn({
          id,
          name: nonEmpty(msg.subagent_type) ?? 'agent',
          task: nonEmpty(msg.description) ?? '',
          ...(nonEmpty(msg.prompt) === undefined ? {} : { prompt: msg.prompt }),
          steps: 'full'
        })
      )
    }
    if (taskId !== undefined) agents.noteTask(taskId, id)
    const current = registry.get(id)
    const update = registry.update(id, {
      ...(taskId === undefined ? {} : { nativeId: taskId }),
      ...(typeof msg.is_backgrounded === 'boolean' ? { background: msg.is_backgrounded } : {}),
      ...(current?.prompt === undefined && nonEmpty(msg.prompt) !== undefined ? { prompt: msg.prompt } : {})
    })
    if (update) entries.push(update)
    return entries
  }
  if (id === undefined) return null
  if (subtype === 'task_progress') {
    const total = record(msg.usage)?.total_tokens
    const summary = agents.summaries === 'ai' ? nonEmpty(msg.summary) : undefined
    const update = registry.update(id, { ...(typeof total === 'number' ? { tokens: total } : {}), ...(summary === undefined ? {} : { summary }) })
    return update ? [update] : []
  }
  if (subtype === 'task_updated') {
    const background = record(msg.patch)?.is_backgrounded
    const update = typeof background === 'boolean' ? registry.update(id, { background }) : null
    return update ? [update] : []
  }
  const tokens = record(msg.usage)?.total_tokens
  const extra = typeof tokens === 'number' ? { tokens } : {}
  const summary = typeof msg.summary === 'string' ? msg.summary : ''
  const ended =
    msg.status === 'failed'
      ? registry.end(id, 'failed', { ...extra, error: summary })
      : msg.status === 'stopped'
        ? registry.end(id, 'stopped', extra)
        : registry.end(id, 'done', { ...extra, report: summary })
  return ended ? [ended] : []
}

/** The text delta carried by a Claude partial-message event, or null for any other event. */
export function claudeTextDelta(msg: any): string | null {
  if (msg?.type !== 'stream_event') return null
  const event = msg.event
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return null
  return typeof event.delta.text === 'string' ? event.delta.text : null
}

type CodexPhase = 'started' | 'completed'

function codexKind(change: Record<string, unknown>): string {
  const kind = change.kind
  if (typeof kind === 'string') return kind
  const fields = record(kind)
  return typeof fields?.type === 'string' ? fields.type : 'update'
}

function diffCounts(change: Record<string, unknown>): { added: number; removed: number } {
  const diff = typeof change.diff === 'string' ? change.diff : ''
  const kind = codexKind(change)
  if (kind === 'add') return { added: lineCount(diff), removed: 0 }
  if (kind === 'delete') return { added: 0, removed: lineCount(diff) }
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

function codexCallState(item: Record<string, unknown>, phase: CodexPhase): CallState {
  if (phase === 'started') return 'running'
  const status = item.status
  if (status === 'inProgress') return 'running'
  if (status === 'failed' || status === 'declined') return 'failed'
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'done'
}

function codexSteps(raw: unknown): { text: string; state: 'pending' | 'active' | 'done' }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const fields = record(entry)
    if (!fields) return []
    const text = typeof fields.step === 'string' ? fields.step : typeof fields.text === 'string' ? fields.text : null
    if (text === null) return []
    const status = fields.status
    const state = fields.completed === true || status === 'completed' ? 'done' : status === 'inProgress' || status === 'in_progress' ? 'active' : 'pending'
    return [{ text, state } as const]
  })
}

/** Steps from a Codex plan update, which lists `{step, status}` entries. */
export function codexPlanEntry(callId: string, plan: unknown): ItemEntry {
  const steps = codexSteps(plan)
  return { role: 'tool', text: `Codex plan (${steps.length} steps)`, data: { plan }, item: { kind: 'steps', callId, steps } }
}

/**
 * Normalizes one Codex app-server thread item into journal entries, once when it starts and once
 * when it completes. `output` is streamed command output when the item carries none. Never
 * throws: anything unrecognized becomes a `status` item. Agent messages are the runner's to
 * journal because their text arrives in deltas.
 */
export function codexEntries(item: Record<string, unknown>, phase: CodexPhase, calls: CallTracker, output?: string): ItemEntry[] {
  try {
    return codexEntriesUnchecked(item, phase, calls, output)
  } catch {
    const text = `Codex ${String(item.type ?? 'event')}`
    return [{ role: 'tool', text, data: item, item: statusItem(text) }]
  }
}

function codexEntriesUnchecked(item: Record<string, unknown>, phase: CodexPhase, calls: CallTracker, output?: string): ItemEntry[] {
  const type = item.type
  const id = typeof item.id === 'string' ? item.id : ''
  const state = codexCallState(item, phase)
  if (typeof type !== 'string') return [{ role: 'tool', text: 'Codex event', data: item, item: statusItem('Codex event') }]
  switch (type) {
    case 'agentMessage':
    case 'reasoning':
      return []
    case 'userMessage':
      return phase === 'completed' ? [{ role: 'tool', text: `Codex ${type}`, data: item, item: statusItem(`Codex ${type}`) }] : []
    case 'commandExecution': {
      const command = typeof item.command === 'string' ? item.command : 'Codex command'
      const text = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : (output ?? '')
      const entry: ChatItem = isTestCommand(command)
        ? {
            kind: 'tests',
            callId: id,
            command: oneLine(command, CALL_TEXT_LIMIT),
            ...(phase === 'completed' ? parseTestCounts(text) : {}),
            state,
            ...(phase === 'completed' && tailOf(text) !== undefined ? { tail: tailOf(text) } : {})
          }
        : {
            kind: 'activity',
            callId: id,
            tool: 'Command',
            summary: oneLine(command, CALL_TEXT_LIMIT),
            state,
            ...(phase === 'completed' && text ? { detail: capped(text) } : {})
          }
      calls.track(entry)
      return [{ role: 'tool', text: [command, phase === 'completed' ? text : ''].filter(Boolean).join('\n') || type, data: item, item: entry }]
    }
    case 'fileChange': {
      const changes = (Array.isArray(item.changes) ? item.changes : []).flatMap((change) => {
        const fields = record(change)
        return fields && typeof fields.path === 'string' ? [fields] : []
      })
      if (changes.length === 0) {
        const entry: ChatItem = { kind: 'activity', callId: id, tool: 'File change', summary: '', state }
        calls.track(entry)
        return [{ role: 'tool', text: 'Codex file change', data: item, item: entry }]
      }
      return changes.map((change, index): ItemEntry => {
        const path = change.path as string
        const entry: ChatItem = {
          kind: 'file-change',
          callId: changes.length === 1 ? id : `${id}:${index}`,
          path,
          ...diffCounts(change),
          state
        }
        calls.track(entry)
        return { role: 'tool', text: `Codex file changes:\n${path}`, data: item, item: entry }
      })
    }
    case 'plan':
    case 'todoList':
    case 'todo_list': {
      if (phase === 'started') return []
      let steps = codexSteps(item.steps ?? item.items ?? item.plan)
      if (steps.length === 0 && typeof item.text === 'string') {
        steps = item.text
          .split('\n')
          .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, '').trim())
          .filter(Boolean)
          .map((text) => ({ text, state: 'pending' as const }))
      }
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: { kind: 'steps', callId: id, steps } }]
    }
    case 'mcpToolCall': {
      const tool = [item.server, item.tool].filter((part) => typeof part === 'string' && part).join('/') || 'mcp'
      const entry: ChatItem = { kind: 'activity', callId: id, tool, summary: summarizeInput(record(item.arguments) ?? undefined, CALL_TEXT_LIMIT), state }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
    case 'webSearch': {
      const entry: ChatItem = { kind: 'activity', callId: id, tool: 'Web search', summary: oneLine(typeof item.query === 'string' ? item.query : '', CALL_TEXT_LIMIT), state: phase === 'started' ? 'running' : 'done' }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
    case 'imageView': {
      const entry: ChatItem = { kind: 'activity', callId: id || type, tool: type, summary: '', state: phase === 'started' ? 'running' : state }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
    default:
      return phase === 'completed' ? [{ role: 'tool', text: `Codex ${type}`, data: item, item: statusItem(`Codex ${type}`) }] : []
  }
}

const PI_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'patch'])
const PI_TODO_TOOLS = new Set(['todo', 'todo_write', 'todowrite'])

function firstString(fields: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function piEditPath(args: Record<string, unknown>): string | undefined {
  const direct = firstString(args, ['path', 'file_path', 'filePath', 'file'])
  if (direct) return direct
  const patch = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : ''
  const bracketed = /^\[([^\]#\n]+)(?:#[^\]\n]*)?\]/m.exec(patch)
  if (bracketed) return bracketed[1]
  return /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch)?.[1]?.trim()
}

function piEditCounts(args: Record<string, unknown>): { added?: number; removed?: number } {
  const edits = Array.isArray(args.edits) ? args.edits : [args]
  let added = 0
  let removed = 0
  let found = false
  for (const edit of edits) {
    const fields = record(edit)
    if (!fields) continue
    const next = firstString(fields, ['newText', 'new_string', 'newString', 'content'])
    const previous = firstString(fields, ['oldText', 'old_string', 'oldString'])
    if (next === undefined && previous === undefined) continue
    found = true
    added += lineCount(next)
    removed += lineCount(previous)
  }
  return found ? { added, removed } : {}
}

function diffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

function resultText(result: Record<string, unknown> | null): string {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
}

function piStepState(status: unknown): 'pending' | 'active' | 'done' {
  if (status === 'completed' || status === 'done' || status === 'abandoned') return 'done'
  if (status === 'in_progress' || status === 'active') return 'active'
  return 'pending'
}

function piSteps(raw: unknown): { text: string; state: 'pending' | 'active' | 'done' }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const fields = record(entry)
    if (!fields) return []
    if (Array.isArray(fields.tasks)) return piSteps(fields.tasks)
    const text = firstString(fields, ['content', 'text', 'title', 'step'])
    return text === undefined ? [] : [{ text, state: fields.completed === true ? ('done' as const) : piStepState(fields.status) }]
  })
}

function piToolItem(callId: string, name: string, args: Record<string, unknown>, state: CallState, output?: string, details?: Record<string, unknown> | null): ChatItem {
  const lower = name.toLowerCase()
  if (PI_EDIT_TOOLS.has(lower)) {
    const path = piEditPath(args)
    if (path) {
      const diff = details?.diff
      const counts = state !== 'running' && typeof diff === 'string' ? diffLineCounts(diff) : piEditCounts(args)
      return { kind: 'file-change', callId, path, ...counts, state }
    }
  }
  const command = typeof args.command === 'string' ? args.command : ''
  if (lower === 'bash' && command && isTestCommand(command)) {
    return {
      kind: 'tests',
      callId,
      command: oneLine(command, CALL_TEXT_LIMIT),
      ...(output === undefined ? {} : parseTestCounts(output)),
      state,
      ...(output === undefined || tailOf(output) === undefined ? {} : { tail: tailOf(output) })
    }
  }
  return { kind: 'activity', callId, tool: name, summary: summarizeInput(args, CALL_TEXT_LIMIT), state, ...(output ? { detail: capped(output) } : {}) }
}

/**
 * Normalizes a pi or omp `tool_execution_start` or `tool_execution_end` event into journal
 * entries sharing the call's `callId`. The todo tool journals a `steps` item once it finishes.
 * Never throws: anything unrecognized becomes a `status` item.
 */
export function piEntries(event: Record<string, unknown>, calls: CallTracker): ItemEntry[] {
  try {
    return piEntriesUnchecked(event, calls)
  } catch {
    const text = String(event.toolName ?? event.type ?? 'event')
    return [{ role: 'tool', text, data: event, item: statusItem(text) }]
  }
}

function piEntriesUnchecked(event: Record<string, unknown>, calls: CallTracker): ItemEntry[] {
  const callId = String(event.toolCallId ?? '')
  const name = String(event.toolName ?? 'tool')
  const args = record(event.args) ?? {}
  const todo = PI_TODO_TOOLS.has(name.toLowerCase())
  if (event.type === 'tool_execution_start') {
    calls.remember(callId, name, args)
    if (todo) return []
    const item = piToolItem(callId, name, args, 'running')
    calls.track(item)
    return [{ role: 'tool', text: `${name}: ${summarizeInput(args)}`.trim(), data: event, item }]
  }
  const result = record(event.result)
  const output = resultText(result)
  const state: CallState = event.isError === true ? 'failed' : 'done'
  const input = calls.recall(callId)?.input ?? args
  const details = record(result?.details)
  if (todo) {
    calls.track({ kind: 'activity', callId, tool: name, summary: '', state })
    const steps = state === 'done' ? piSteps(details?.phases ?? details?.todos ?? input.phases ?? input.todos) : []
    if (steps.length > 0) return [{ role: 'tool', text: `${name} (${steps.length} steps)`, data: event, item: { kind: 'steps', callId, steps } }]
    return [{ role: 'tool', text: output, data: event, item: statusItem(`${name} ${state}`) }]
  }
  const item = piToolItem(callId, name, input, state, output, details)
  calls.track(item)
  return [{ role: 'tool', text: output || `${name}: ${summarizeInput(input)}`.trim(), data: event, item }]
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The token totals a Claude `result` message carries: `modelUsage` summed across models, falling back to
 * the top-level `usage`. The SDK reports them cumulatively for the whole conversation, resumed history
 * included. Null when the message has neither.
 */
export function claudeResultTotals(msg: any): Omit<UsageTotals, 'total'> | null {
  const sum = (entries: any[], keys: [string, string, string, string]): Omit<UsageTotals, 'total'> => {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const entry of entries) {
      totals.input += nonNegative(entry?.[keys[0]])
      totals.output += nonNegative(entry?.[keys[1]])
      totals.cacheRead += nonNegative(entry?.[keys[2]])
      totals.cacheWrite += nonNegative(entry?.[keys[3]])
    }
    return totals
  }
  const byModel = typeof msg?.modelUsage === 'object' && msg.modelUsage !== null ? Object.values<any>(msg.modelUsage) : []
  if (byModel.length > 0) return sum(byModel, ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'])
  if (typeof msg?.usage === 'object' && msg.usage !== null) {
    return sum([msg.usage], ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
  }
  return null
}

import type { CallState, ChatItem, StructuredRole } from '@quirky/protocol'

/** One journal entry a normalizer derives from an agent event: the legacy role, text and raw data plus the typed item. */
export type ItemEntry = { role: StructuredRole; text: string; data: unknown; item: ChatItem }

/** The item kinds that carry a call lifecycle. */
export type CallItem = Extract<ChatItem, { kind: 'activity' | 'file-change' | 'tests' }>

type ToolEntry = { name: string; input: Record<string, unknown> }

const SUMMARY_LIMIT = 160
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
export function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value) return oneLine(value)
  }
  return oneLine(JSON.stringify(input) ?? '')
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

  get size(): number {
    return this.open.size
  }

  /** Remembers the input of a started call, for pairing with its result. */
  remember(callId: string, name: string, input: Record<string, unknown>): void {
    this.tools.set(callId, { name, input })
  }

  recall(callId: string): ToolEntry | undefined {
    return this.tools.get(callId)
  }

  /** Records an item: a running call stays open, anything else closes it. */
  track(item: ChatItem): void {
    if (item.kind !== 'activity' && item.kind !== 'file-change' && item.kind !== 'tests') return
    if (item.state === 'running') this.open.set(item.callId, item)
    else {
      this.open.delete(item.callId)
      this.tools.delete(item.callId)
    }
  }

  /** Closes every open call in `state` and returns the closing items. */
  settle(state: Exclude<CallState, 'running'>): CallItem[] {
    const closing = [...this.open.values()].map((item) => ({ ...item, state }) as CallItem)
    this.open.clear()
    this.tools.clear()
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
export function closingEntries(tracker: CallTracker, state: Exclude<CallState, 'running'>): ItemEntry[] {
  return tracker.settle(state).map((item) => ({ role: 'tool', text: callText(item), data: { closed: state }, item }))
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
      command: oneLine(command, 400),
      ...(output === undefined ? {} : parseTestCounts(output)),
      state,
      ...(output === undefined || tailOf(output) === undefined ? {} : { tail: tailOf(output) })
    }
  }
  return {
    kind: 'activity',
    callId,
    tool: name,
    summary: summarizeInput(input),
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
 * Normalizes one Claude Agent SDK message into journal entries; a tool call opens one running
 * entry and closes with a second sharing its `callId`. Never throws: anything unrecognized
 * becomes a `status` item.
 */
export function claudeEntries(msg: any, calls: CallTracker): ItemEntry[] {
  try {
    return claudeEntriesUnchecked(msg, calls)
  } catch {
    return [{ role: 'system', text: String(msg?.type ?? 'event'), data: msg, item: statusItem(String(msg?.type ?? 'event')) }]
  }
}

function claudeEntriesUnchecked(msg: any, calls: CallTracker): ItemEntry[] {
  switch (msg?.type) {
    case 'assistant': {
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
        const item = claudeToolItem(callId, name, input, 'running')
        calls.track(item)
        entries.push({ role: 'tool', text, data: block, item })
      }
      return entries
    }
    case 'user': {
      const content = msg.message?.content
      if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) {
        return content
          .filter((block: any) => block?.type === 'tool_result')
          .map((block: any): ItemEntry => {
            const callId = String(block.tool_use_id ?? '')
            const output = blockText(block.content)
            const known = calls.recall(callId)
            const state: CallState = block.is_error === true ? 'failed' : 'done'
            if (known?.name === 'TodoWrite') {
              calls.track({ kind: 'activity', callId, tool: 'TodoWrite', summary: '', state })
              return { role: 'tool', text: output, data: msg, item: statusItem(`TodoWrite ${state}`) }
            }
            const item = claudeToolItem(callId, known?.name ?? 'tool', known?.input ?? {}, state, output)
            calls.track(item)
            return { role: 'tool', text: output, data: msg, item }
          })
      }
      const text = blockText(content)
      return [{ role: 'user', text, data: msg, item: userItem(text) }]
    }
    case 'system': {
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
            command: oneLine(command, 400),
            ...(phase === 'completed' ? parseTestCounts(text) : {}),
            state,
            ...(phase === 'completed' && tailOf(text) !== undefined ? { tail: tailOf(text) } : {})
          }
        : {
            kind: 'activity',
            callId: id,
            tool: 'Command',
            summary: oneLine(command),
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
      const entry: ChatItem = { kind: 'activity', callId: id, tool, summary: summarizeInput(record(item.arguments) ?? undefined), state }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
    case 'webSearch': {
      const entry: ChatItem = { kind: 'activity', callId: id, tool: 'Web search', summary: oneLine(typeof item.query === 'string' ? item.query : ''), state: phase === 'started' ? 'running' : 'done' }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
    default: {
      const entry: ChatItem = { kind: 'activity', callId: id || type, tool: type, summary: '', state: phase === 'started' ? 'running' : state }
      calls.track(entry)
      return [{ role: 'tool', text: `Codex ${type}`, data: item, item: entry }]
    }
  }
}

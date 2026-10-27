import { captureProviderSession } from '../capture'
import type { ChildOp, Inventory, Normalized, Normalizer, NormalizerCache } from '../types'
import {
  addChild,
  isAskUserQuestionTool,
  memoryIn,
  promptOf,
  questionJson,
  readString,
  rememberMessage,
  rememberModel,
  rememberTool,
  resetTurn,
  toolInputSummary,
  turnFields,
  type TurnMemory
} from './text'

const EXIT_REASONS = new Set(['prompt_input_exit', 'logout', 'other', 'bypass_permissions_disabled'])
const BOUNDARY_SOURCES = new Set(['startup', 'resume', 'clear'])

const TERMINAL_TASK_STATUSES = new Set([
  'idle',
  'done',
  'success',
  'succeeded',
  'complete',
  'completed',
  'finished',
  'failed',
  'error',
  'terminated',
  'exited',
  'aborted',
  'expired',
  'skipped',
  'crashed',
  'killed',
  'cancelled',
  'canceled',
  'timed_out'
])
const AGENT_TASK_TYPES = new Set(['local_agent', 'local_subagent', 'subagent'])

type ClaudeMemory = TurnMemory & {
  /** Live subagent ids, kept to map a teammate's name to its child ids. */
  children: Set<string>
  /** The lead is waiting on an AskUserQuestion; its tool use ID tells a sibling tool's completion from the answer. */
  question: { toolUseId?: string } | null
  /** The child whose question or permission request holds the row. */
  childWait: string | null
}

const newMemory = (): ClaudeMemory => ({ prompt: '', children: new Set(), question: null, childWait: null })

/**
 * Claude's `background_tasks` as an inventory: subagent tasks are agent children, any other
 * non-terminal task is a shell, terminal ones are listed as stopped. Teammate entries are left out
 * because they report running while idle. `complete` is false when an entry could not be listed.
 * Returns undefined when the payload has no `background_tasks` array (older Claude builds).
 */
function readInventory(payload: Record<string, unknown>): Inventory | undefined {
  const raw = payload['background_tasks']
  if (!Array.isArray(raw)) return undefined
  const tasks: Inventory['tasks'] = []
  let complete = true
  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      complete = false
      tasks.push({ id: `shell-${index}`, kind: 'shell', running: true })
      return
    }
    const task = item as Record<string, unknown>
    const type = typeof task.type === 'string' ? task.type.trim().toLowerCase() : ''
    const status = typeof task.status === 'string' ? task.status.trim().toLowerCase() : ''
    const running = !TERMINAL_TASK_STATUSES.has(status)
    const id = typeof task.id === 'string' ? task.id.trim() : ''
    if (type === '') complete = false
    if (type === 'teammate') return
    if (AGENT_TASK_TYPES.has(type)) {
      if (id === '') complete = false
      else tasks.push({ id, kind: 'agent', running })
      return
    }
    if (id === '') {
      complete = false
      if (running) tasks.push({ id: `shell-${index}`, kind: 'shell', running: true })
      return
    }
    tasks.push({ id, kind: 'shell', running })
  })
  return { tasks, complete }
}

function teammateChildren(children: Set<string>, name: string): string[] {
  const prefix = `a${name}-`
  return [...children].filter((id) => id.startsWith(prefix) && !id.slice(prefix.length).includes('-'))
}

/** SubagentStart, SubagentStop, a child's StopFailure and TeammateIdle: child ops with no state of their own. */
function lifecycle(source: string, eventName: string, payload: Record<string, unknown>, mem: ClaudeMemory): Normalized | null {
  const childOps: ChildOp[] = []
  let released = false
  if (eventName === 'TeammateIdle') {
    const name = readString(payload, 'teammate_name')
    if (!name) return null
    for (const id of teammateChildren(mem.children, name)) {
      childOps.push({ op: 'state', id, state: 'done' })
      if (mem.childWait === id) released = true
    }
    if (childOps.length === 0) return null
  } else {
    const id = readString(payload, 'agent_id')
    if (!id) return null
    if (eventName === 'SubagentStart') {
      addChild(mem.children, id)
      childOps.push({ op: 'start', id, kind: 'agent' })
    } else {
      mem.children.delete(id)
      childOps.push({ op: 'stop', id })
      released = mem.childWait === id
    }
  }
  // the released child's question sat in the row's fields; the lead's own fields replace it
  if (released) mem.childWait = null
  return {
    eventName,
    state: null,
    newTurn: false,
    fields: released ? turnFields(mem) : {},
    childOps,
    providerSession: captureProviderSession(source, payload) ?? undefined
  }
}

function claudeFamily(source: string, payload: Record<string, unknown>, eventName: string, cache: NormalizerCache): Normalized | null {
  const mem = memoryIn(cache, source, newMemory)
  const agentId = readString(payload, 'agent_id')

  if (eventName === 'SubagentStart' || eventName === 'SubagentStop' || eventName === 'TeammateIdle') {
    return lifecycle(source, eventName, payload, mem)
  }
  if (eventName === 'StopFailure' && agentId) return lifecycle(source, eventName, payload, mem)

  const providerSession = captureProviderSession(source, payload) ?? undefined

  if (eventName === 'SessionEnd') {
    const reason = readString(payload, 'reason')
    if (agentId || !reason || !EXIT_REASONS.has(reason)) return null
    return { eventName, state: null, newTurn: false, fields: {}, endsProcess: true, providerSession }
  }

  if (eventName === 'SessionStart') {
    const from = readString(payload, 'source')
    if (agentId || !from || !BOUNDARY_SOURCES.has(from)) return null
    mem.children.clear()
    mem.question = null
    mem.childWait = null
    resetTurn(mem)
    mem.model = undefined
    rememberModel(mem, payload)
    return {
      eventName,
      state: 'done',
      newTurn: true,
      sessionBoundary: true,
      fields: turnFields(mem),
      providerSession,
      movesLead: from !== 'startup',
      cacheReset: true,
      cronsActive: false
    }
  }

  const toolName = readString(payload, 'tool_name')
  const asksQuestion = isAskUserQuestionTool(toolName) && (eventName === 'PreToolUse' || eventName === 'PermissionRequest')
  const isToolEvent =
    eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure' || eventName === 'PermissionRequest'
  const state =
    eventName === 'UserPromptSubmit' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
      ? 'working'
      : eventName === 'PreToolUse'
        ? asksQuestion
          ? 'waiting'
          : 'working'
        : eventName === 'PermissionRequest'
          ? 'waiting'
          : eventName === 'Stop' || eventName === 'StopFailure' || (eventName === 'PostCompact' && payload.trigger === 'manual')
            ? 'done'
            : null
  if (state === null) return null

  const toolUseId = isToolEvent ? (readString(payload, 'tool_use_id') ?? readString(payload, 'toolUseId')) : undefined
  const question = asksQuestion ? questionJson(toolName, payload.tool_input) : undefined
  const permissionRequest = eventName === 'PermissionRequest' ? true : undefined

  if (agentId) {
    if (state === 'waiting') {
      mem.childWait = agentId
      addChild(mem.children, agentId)
      return {
        eventName,
        state,
        newTurn: false,
        agentId,
        fields: { toolName, toolInput: toolInputSummary(payload.tool_input), toolUseId, question },
        childOps: [{ op: 'state', id: agentId, state: 'waiting' }],
        providerSession,
        permissionRequest
      }
    }
    if (!isToolEvent) return null
    addChild(mem.children, agentId)
    // the child's approval was granted: its tool event replaces the pending card with the lead's own fields
    const resumed = mem.childWait === agentId
    if (resumed) mem.childWait = null
    return {
      eventName,
      state,
      newTurn: false,
      agentId,
      fields: resumed ? turnFields(mem) : {},
      childOps: [{ op: 'state', id: agentId, state: 'working' }],
      providerSession
    }
  }

  const siblingCompletion = (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') && toolUseId !== undefined
  if (siblingCompletion && mem.question?.toolUseId !== undefined && mem.question.toolUseId !== toolUseId) return null

  const newTurn = eventName === 'UserPromptSubmit'
  if (newTurn) {
    resetTurn(mem)
    mem.prompt = promptOf(payload)
    mem.childWait = null
  }
  mem.question = asksQuestion ? { toolUseId } : null
  rememberModel(mem, payload)
  if (eventName === 'PostToolUseFailure') {
    mem.toolName = undefined
    mem.toolInput = undefined
  } else if (isToolEvent) {
    rememberTool(mem, toolName, payload.tool_input)
  }
  if (eventName === 'Stop') rememberMessage(mem, readString(payload, 'last_assistant_message'))

  const isTurnEnd = eventName === 'Stop' || eventName === 'StopFailure'
  const interrupted = eventName === 'Stop' && payload.is_interrupt === true
  const inventory = readInventory(payload)
  const crons = payload['session_crons']
  // current Claude may omit an empty cron list while still sending background_tasks
  const cronsActive = Array.isArray(crons) ? crons.length > 0 : isTurnEnd && inventory ? false : undefined

  return {
    eventName,
    state,
    newTurn,
    sessionBoundary: eventName === 'PostCompact' ? true : undefined,
    outcome: interrupted ? 'cancellation' : eventName === 'StopFailure' ? 'failure' : eventName === 'Stop' ? 'success' : undefined,
    interrupted: interrupted ? true : undefined,
    fields: { ...turnFields(mem), toolUseId, question },
    inventory,
    cronsActive,
    providerSession,
    permissionRequest
  }
}

/**
 * Claude hook events as status: turn and tool events for the lead, child ops for subagents
 * (events carrying `agent_id` come from a child and leave the lead's fields alone), the full
 * `background_tasks` inventory, and the SessionEnd reasons that prove the process ended.
 * Returns null for events that say nothing about status.
 */
export const normalizeClaude: Normalizer = (payload, eventName, cache) => claudeFamily('claude', payload, eventName, cache)

/** Qwen Code speaks Claude's hook protocol; only the owning source differs. */
export const normalizeQwenCode: Normalizer = (payload, eventName, cache) => claudeFamily('qwen-code', payload, eventName, cache)

/** OpenClaude speaks Claude's hook protocol; only the owning source differs. */
export const normalizeOpenClaude: Normalizer = (payload, eventName, cache) => claudeFamily('openclaude', payload, eventName, cache)

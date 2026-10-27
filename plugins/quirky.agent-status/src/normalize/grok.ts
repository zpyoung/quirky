import type { AgentState, Inventory, Normalizer, Outcome } from '../types'
import {
  cacheResetResult,
  isAskUserQuestionTool,
  isRecord,
  questionJson,
  readFirstString,
  readPrompt,
  readString,
  result,
  snakeCase,
  summarizeToolInput,
} from './shared'

const TURN = 'grok:turn'
const LAST = 'grok:last'
const PROMPT_ID_MAX = 512

type Turn = { promptId?: string; sessionId?: string }
type Last = { state: AgentState; outcome?: Outcome }

const TURN_ENDS = new Set(['stop', 'stop_failure', 'stop_cancelled'])

function identity(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = readFirstString(payload, keys)
  return value && value.length <= PROMPT_ID_MAX ? value : undefined
}

function mentionsPermission(message: string | undefined): boolean {
  const lower = message?.toLowerCase() ?? ''
  return [
    'permission',
    'approval',
    'approve',
    'allow',
    'confirm',
    'needs your',
    'requires your',
    'feedback',
    'clarify',
    'question',
  ].some((word) => lower.includes(word))
}

/** Grok sends this before every tool even when permissions are bypassed; PreToolUse already covers progress. */
function isRoutinePermissionPrompt(type: string, message: string | undefined, level: string | undefined): boolean {
  return (
    type === 'permission_prompt' &&
    message?.trim().toLowerCase() === 'tool permission requested' &&
    (!level || level.trim().toLowerCase() === 'info')
  )
}

/**
 * A turn end belongs to the turn it names. One for an older prompt than the current turn
 * arrives late and must not settle the row; with no turn recorded, or no id on the event, it applies.
 */
function turnEndApplies(payload: Record<string, unknown>, turn: Turn | undefined): boolean {
  const promptId = identity(payload, ['promptId', 'prompt_id'])
  if (!promptId || !turn) return true
  if (!turn.promptId) return false
  const sessionId = identity(payload, ['sessionId', 'session_id'])
  return turn.promptId === promptId && (!turn.sessionId || !sessionId || turn.sessionId === sessionId)
}

/**
 * What a turn end leaves running. Grok lists only in-flight tasks: a `subagent` is agent work,
 * a `shell` is command work, and monitors are left out because they can run forever and would
 * hold the row open. A still-active stop hook reads like a watched shell.
 */
function backgroundInventory(payload: Record<string, unknown>): Inventory {
  const list = payload.backgroundTasks ?? payload.background_tasks
  const tasks: Inventory['tasks'] = []
  if (Array.isArray(list)) {
    list.forEach((task, index) => {
      if (!isRecord(task) || (task.type !== 'subagent' && task.type !== 'shell')) return
      const id = readFirstString(task, ['id', 'taskId', 'task_id']) ?? `${task.type}:${index}`
      tasks.push({ id, kind: task.type === 'subagent' ? 'agent' : 'shell', running: true })
    })
  }
  const stopHookActive = payload.stopHookActive ?? payload.stop_hook_active
  if (tasks.length === 0 && stopHookActive === true) tasks.push({ id: 'stop-hook', kind: 'shell', running: true })
  return { tasks, complete: true }
}

/** Grok (event names snake-cased): see the feature doc's mapping; child sessions never settle the parent. */
export const normalizeGrok: Normalizer = (payload, rawEventName, cache) => {
  const eventName = snakeCase(rawEventName)
  if (readFirstString(payload, ['subagentType', 'subagent_type'])) return null
  if (eventName === 'session_start') {
    cache.delete(TURN)
    cache.delete(LAST)
    return cacheResetResult(eventName)
  }
  if (eventName === 'user_prompt_submit') {
    const promptId = identity(payload, ['promptId', 'prompt_id'])
    const sessionId = identity(payload, ['sessionId', 'session_id'])
    cache.set(TURN, { ...(promptId ? { promptId } : {}), ...(sessionId ? { sessionId } : {}) } satisfies Turn)
  }

  const isTurnEnd = TURN_ENDS.has(eventName)
  if (isTurnEnd && !turnEndApplies(payload, cache.get(TURN) as Turn | undefined)) return null

  const toolName = readFirstString(payload, ['toolName', 'tool_name', 'name'])
  const asks = eventName === 'pre_tool_use' && isAskUserQuestionTool(toolName)
  const notificationType = snakeCase(readFirstString(payload, ['notificationType', 'notification_type', 'type']) ?? '')
  const message = readString(payload, 'message')
  const isNotification = eventName === 'notification'
  const isIdlePrompt = isNotification && notificationType === 'idle_prompt'

  let state: AgentState | null = null
  if (asks) state = 'waiting'
  else if (['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'post_tool_use_failure'].includes(eventName)) state = 'working'
  else if (isTurnEnd || eventName === 'session_end' || isIdlePrompt) state = 'done'
  else if (
    isNotification &&
    notificationType !== 'task_complete' &&
    !isRoutinePermissionPrompt(notificationType, message, readString(payload, 'level')) &&
    mentionsPermission(message)
  ) {
    state = 'waiting'
  }
  if (!state) return null

  const reason = readString(payload, 'reason')
  const sessionBoundary = eventName === 'session_end' || (eventName === 'stop' && (reason === 'shutdown' || reason === 'channel_closed'))
  const verdict: Outcome | undefined =
    eventName === 'stop_cancelled' ? 'cancellation' : eventName === 'stop_failure' ? 'failure' : undefined
  // an idle prompt or session end restates the turn that already finished, so its verdict stands
  const previous = cache.get(LAST) as Last | undefined
  const outcome = verdict ?? (!isTurnEnd && state === 'done' && previous?.state === 'done' ? previous.outcome : undefined)
  cache.set(LAST, { state, outcome } satisfies Last)

  const isToolEvent = eventName === 'pre_tool_use' || eventName === 'post_tool_use' || eventName === 'post_tool_use_failure'
  const input = payload.toolInput ?? payload.tool_input ?? payload.input ?? payload.arguments
  return result(eventName, state, {
    newTurn: eventName === 'user_prompt_submit',
    sessionBoundary: sessionBoundary ? true : undefined,
    outcome,
    interrupted: outcome === 'cancellation' ? true : undefined,
    // only a turn end reports what it left running; a boundary settles the row whatever the list says
    inventory: sessionBoundary ? { tasks: [], complete: true } : isTurnEnd ? backgroundInventory(payload) : undefined,
    fields: {
      prompt: eventName === 'user_prompt_submit' ? stripUserQuery(readPrompt(payload)) : undefined,
      toolName: isToolEvent ? toolName : undefined,
      toolInput: isToolEvent ? summarizeToolInput(input) : undefined,
      question: asks ? questionJson(input) : undefined,
      lastAssistantMessage: state === 'done' ? readFirstString(payload, ['lastAssistantMessage', 'last_assistant_message']) : undefined,
    },
  })
}

/** Grok wraps the submitted prompt in a `<user_query>` envelope; the row should hold the plain text. */
function stripUserQuery(prompt: string | undefined): string | undefined {
  if (!prompt?.startsWith('<user_query>')) return prompt
  const inner = prompt.slice('<user_query>'.length)
  return (inner.endsWith('</user_query>') ? inner.slice(0, -'</user_query>'.length) : inner).trim()
}

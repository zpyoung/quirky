import type { AgentState, Normalizer, NormalizerCache } from '../types'
import {
  claudeToolFields,
  isAskUserQuestionTool,
  isCompactContinuation,
  readFirstString,
  readPrompt,
  readString,
  result,
  summarizeToolInput,
  userPrompt,
} from './shared'

const CHILDREN = 'muse:children'
const PENDING = 'muse:pendingApproval'

type Pending = { toolName?: string; toolInput?: string }

function children(cache: NormalizerCache): Set<string> {
  let set = cache.get(CHILDREN) as Set<string> | undefined
  if (!set) {
    set = new Set()
    cache.set(CHILDREN, set)
  }
  return set
}

/**
 * Muse: Claude-compatible events. Its PermissionRequest only names the tool; the
 * `permission_prompt` Notification is what proves a human is asked, so the tool is remembered
 * for it. Events from child sessions never speak for the lead.
 */
export const normalizeMuse: Normalizer = (payload, eventName, cache) => {
  if (eventName === 'UserPromptSubmit' && isCompactContinuation(readPrompt(payload))) return null

  if (eventName === 'SubagentStart') {
    const childId = readFirstString(payload, ['child_session_id', 'session_id'])
    if (childId) children(cache).add(childId)
    return null
  }
  // a child's turn id equals its session id, which also catches one whose SubagentStart predates us
  const sessionId = readString(payload, 'session_id')
  if (sessionId && (children(cache).has(sessionId) || readString(payload, 'turn_id') === sessionId)) return null

  let state: AgentState
  let tool = claudeToolFields(payload, { post: eventName === 'PostToolUse' })
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      state = 'working'
      cache.delete(PENDING)
      break
    case 'PreToolUse':
      state = isAskUserQuestionTool(readString(payload, 'tool_name')) ? 'waiting' : 'working'
      break
    case 'PermissionRequest':
      cache.set(PENDING, { toolName: readString(payload, 'tool_name'), toolInput: summarizeToolInput(payload.tool_input) } satisfies Pending)
      return null
    case 'Notification': {
      if (payload.notification_type !== 'permission_prompt') return null
      state = 'waiting'
      const pending = cache.get(PENDING) as Pending | undefined
      tool = { toolName: pending?.toolName, toolInput: pending?.toolInput }
      break
    }
    case 'Stop':
    case 'StopFailure':
      state = 'done'
      cache.delete(PENDING)
      break
    default:
      return null
  }

  const isToolEvent = ['PreToolUse', 'PostToolUse', 'Notification'].includes(eventName)
  return result(eventName, state, {
    newTurn: eventName === 'UserPromptSubmit',
    outcome: eventName === 'StopFailure' ? 'failure' : undefined,
    interrupted: eventName === 'Stop' && payload.is_interrupt === true ? true : undefined,
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? userPrompt(payload) : undefined,
      ...(isToolEvent ? tool : {}),
      lastAssistantMessage: state === 'done' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}

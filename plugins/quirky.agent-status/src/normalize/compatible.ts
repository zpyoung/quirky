import { captureProviderSession } from '../capture'
import type { AgentState, Normalized, Normalizer } from '../types'
import {
  isAskUserQuestionTool,
  memoryIn,
  promptOf,
  questionJson,
  readString,
  rememberMessage,
  rememberModel,
  rememberTool,
  resetTurn,
  turnFields,
  type TurnMemory
} from './text'

type Source = 'qoder' | 'codebuddy'

const BOUNDARY_SOURCES = new Set(['startup', 'resume', 'clear', 'new'])

function stateOf(eventName: string, payload: Record<string, unknown>, toolName: string | undefined): AgentState | null {
  switch (eventName) {
    case 'SessionStart':
      // a compaction restarts the session mid-turn
      return BOUNDARY_SOURCES.has(String(payload.source)) ? 'done' : null
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'PreToolUse':
      return isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
    case 'PermissionRequest':
      return 'waiting'
    case 'Stop':
    case 'StopFailure':
    case 'SessionEnd':
      return 'done'
    case 'PostCompact':
      return payload.trigger === 'manual' ? 'done' : null
    case 'Notification':
      if (payload.notification_type === 'permission_prompt' || payload.notification_type === 'elicitation_dialog') return 'waiting'
      return payload.notification_type === 'idle_prompt' ? 'done' : null
    default:
      return null
  }
}

function compatible(source: Source, payload: Record<string, unknown>, eventName: string, mem: TurnMemory): Normalized | null {
  // CodeBuddy sends SessionStart after UserPromptSubmit, so it can't mark a turn boundary
  if (source === 'codebuddy' && eventName === 'SessionStart') return null

  let toolName = readString(payload, 'tool_name')
  const state = source === 'codebuddy' && eventName === 'PreToolUse' ? 'working' : stateOf(eventName, payload, toolName)
  if (state === null) return null

  if (
    source === 'codebuddy' &&
    eventName === 'Notification' &&
    payload.notification_type === 'permission_prompt' &&
    payload.message === 'needs your permission to use AskUserQuestion'
  ) {
    toolName = 'AskUserQuestion'
  }

  const boundary = eventName === 'SessionStart' || eventName === 'PostCompact'
  const newTurn = eventName === 'UserPromptSubmit' || (source !== 'codebuddy' && eventName === 'SessionStart')
  if (newTurn) {
    resetTurn(mem)
    if (eventName === 'UserPromptSubmit') mem.prompt = promptOf(payload)
  }
  if (eventName === 'SessionStart') mem.model = undefined
  rememberModel(mem, payload)
  if (eventName === 'PostToolUseFailure') {
    mem.toolName = undefined
    mem.toolInput = undefined
  } else if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest') {
    rememberTool(mem, toolName, payload.tool_input)
  } else if (eventName === 'Notification' && toolName) {
    mem.toolName = toolName
    mem.toolInput = undefined
  }
  if (eventName === 'Stop') rememberMessage(mem, readString(payload, 'last_assistant_message'))

  const asksQuestion = state === 'waiting' && (eventName === 'PreToolUse' || eventName === 'PermissionRequest')
  const interrupted = eventName === 'Stop' && payload.is_interrupt === true
  const turnEnd = state === 'done' && !boundary
  const from = readString(payload, 'source')
  return {
    eventName,
    state,
    newTurn,
    sessionBoundary: boundary ? true : undefined,
    outcome: interrupted ? 'cancellation' : eventName === 'StopFailure' ? 'failure' : turnEnd ? 'success' : undefined,
    interrupted: interrupted ? true : undefined,
    fields: { ...turnFields(mem), question: asksQuestion ? questionJson(toolName, payload.tool_input) : undefined },
    providerSession: captureProviderSession(source, payload) ?? undefined,
    movesLead: eventName === 'SessionStart' ? from !== 'startup' : undefined,
    permissionRequest: eventName === 'PermissionRequest' ? true : undefined,
    cacheReset: eventName === 'SessionStart' ? true : undefined
  }
}

const normalizerFor = (source: Source): Normalizer => (payload, eventName, cache) =>
  compatible(source, payload, eventName, memoryIn(cache, source, (): TurnMemory => ({ prompt: '' })))

/** Qoder's and Qoder CN's Claude-compatible lifecycle events as status; the two share every rule. */
export const normalizeQoder: Normalizer = normalizerFor('qoder')

/** CodeBuddy's events as status: PreToolUse never waits, and its SessionStart is ignored. */
export const normalizeCodebuddy: Normalizer = normalizerFor('codebuddy')

import type { AgentState, Normalizer } from '../types'
import {
  cacheResetResult,
  isAskUserTool,
  isRecord,
  questionJson,
  readFirstString,
  readPrompt,
  readString,
  result,
  summarizeToolInput,
} from './shared'

function riskLevel(payload: Record<string, unknown>): string | undefined {
  const direct = readFirstString(payload, ['riskLevel', 'risk_level'])
  if (direct) return direct
  for (const key of ['tool_input', 'input', 'arguments']) {
    const nested = payload[key]
    const risk = isRecord(nested) ? readFirstString(nested, ['riskLevel', 'risk_level']) : undefined
    if (risk) return risk
  }
  return undefined
}

/** 'confirm' is left out: it matches benign text like "task confirmed". */
function mentionsPermission(message: string | undefined): boolean {
  const lower = message?.toLowerCase() ?? ''
  return lower.includes('permission') || lower.includes('approve') || lower.includes('approval')
}

function mentionsIdle(message: string | undefined): boolean {
  const lower = message?.toLowerCase() ?? ''
  return lower.includes('waiting for your input') || lower.includes('waiting for input')
}

/**
 * Droid: AskUser and high-risk approvals arrive as PreToolUse (no Notification for them), and a
 * user interrupt sends no Stop, only an idle Notification.
 */
export const normalizeDroid: Normalizer = (payload, eventName) => {
  if (eventName === 'SessionStart') return cacheResetResult(eventName)

  const toolName = readFirstString(payload, ['tool_name', 'name'])
  const input = payload.tool_input ?? payload.input ?? payload.arguments
  const message = readString(payload, 'message')
  let state: AgentState | null = null
  let asks = false
  if (eventName === 'PreToolUse' && (isAskUserTool(toolName) || riskLevel(payload)?.trim().toLowerCase() === 'high')) {
    state = 'waiting'
    asks = isAskUserTool(toolName)
  } else if (eventName === 'UserPromptSubmit' || eventName === 'PreToolUse' || eventName === 'PostToolUse') state = 'working'
  else if (eventName === 'Stop') state = 'done'
  else if (eventName === 'PermissionRequest') state = 'waiting'
  else if (eventName === 'Notification' && mentionsPermission(message)) state = 'waiting'
  else if (eventName === 'Notification' && mentionsIdle(message)) state = 'done'
  if (!state) return null

  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest'
  return result(eventName, state, {
    newTurn: eventName === 'UserPromptSubmit',
    fields: {
      prompt: eventName === 'UserPromptSubmit' ? readPrompt(payload) : undefined,
      toolName: isToolEvent ? toolName : undefined,
      toolInput: isToolEvent ? summarizeToolInput(input) : undefined,
      question: asks ? questionJson(input) : undefined,
      lastAssistantMessage: eventName === 'Stop' ? readString(payload, 'last_assistant_message') : undefined,
    },
  })
}

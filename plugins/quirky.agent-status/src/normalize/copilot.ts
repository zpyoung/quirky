import type { AgentState, Normalizer } from '../types'
import {
  firstDefined,
  isAskUserTool,
  isRecord,
  questionJson,
  readFirstString,
  readPrompt,
  result,
  summarizeToolInput,
} from './shared'

const EVENT_NAMES: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  userPromptSubmitted: 'UserPromptSubmit',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
  agentStop: 'Stop',
  stop: 'Stop',
  errorOccurred: 'ErrorOccurred',
  permissionRequest: 'PermissionRequest',
  notification: 'Notification',
}

/** Copilot's camelCase hook names mapped onto the Claude-style names the rest of the mapping uses. */
export function normalizeCopilotEventName(eventName: string): string {
  return EVENT_NAMES[eventName] ?? eventName
}

function toolCall(payload: Record<string, unknown>): { name?: string; args?: unknown } {
  const first = Array.isArray(payload.toolCalls) ? payload.toolCalls[0] : undefined
  if (!isRecord(first)) return {}
  return { name: readFirstString(first, ['name', 'toolName', 'tool_name']), args: first.args ?? first.arguments }
}

/**
 * Copilot: its PermissionRequest fires before allow/ask/deny, so it stays working; the real
 * blocked signals are the `ask_user` tool and permission or elicitation notifications.
 */
export const normalizeCopilot: Normalizer = (payload, rawEventName) => {
  const eventName = normalizeCopilotEventName(rawEventName)
  const call = toolCall(payload)
  const toolName = readFirstString(payload, ['tool_name', 'toolName', 'name']) ?? call.name
  const input = firstDefined(payload, ['tool_input', 'toolInput', 'toolArgs', 'input', 'arguments']) ?? call.args
  const notificationType = readFirstString(payload, ['notification_type', 'notificationType'])
  const blockingNotification =
    eventName === 'Notification' && (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog')
  const asks = (eventName === 'PreToolUse' || eventName === 'PermissionRequest') && isAskUserTool(toolName)

  let state: AgentState | null = null
  if (['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure'].includes(eventName)) state = 'working'
  else if (blockingNotification || asks) state = 'blocked'
  else if (eventName === 'PreToolUse' || eventName === 'PermissionRequest') state = 'working'
  else if (eventName === 'Stop' || eventName === 'SessionEnd') state = 'done'
  else if (eventName === 'ErrorOccurred') state = payload.recoverable === true ? 'working' : 'done'
  if (!state) return null

  const isToolEvent = eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest'
  return result(eventName, state, {
    newTurn: eventName === 'SessionStart' || eventName === 'UserPromptSubmit',
    fields: {
      prompt: eventName === 'Notification' ? undefined : readPrompt(payload),
      toolName: isToolEvent ? toolName : undefined,
      toolInput: isToolEvent ? summarizeToolInput(input) : undefined,
      question: asks ? questionJson(input) : undefined,
      lastAssistantMessage:
        eventName === 'Stop'
          ? readFirstString(payload, ['last_assistant_message', 'lastAssistantMessage', 'message'])
          : blockingNotification
            ? readFirstString(payload, ['message', 'body', 'text', 'title'])
            : undefined,
    },
  })
}

import { captureProviderSession } from '../capture'
import type { AgentState, ChildOp, Normalizer } from '../types'
import {
  addChild,
  firstString,
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

type CodexMemory = TurnMemory & {
  children: Set<string>
  /** The lead's last reported state; a compaction SessionStart only starts a turn when none is running. */
  leadState: AgentState | null
}

const newMemory = (): CodexMemory => ({ prompt: '', children: new Set(), leadState: null })

const TOOL_NAME_KEYS = ['tool_name', 'name']

function toolInputOf(payload: Record<string, unknown>): unknown {
  return payload.tool_input ?? payload.input ?? payload.arguments
}

/**
 * Codex hook events and the turn-end notify call as status. Subagent events (`agent_id`) become
 * child ops; a PermissionRequest in a turn whose approvals are auto-reviewed stays working because
 * Codex's reviewer resolves it within seconds. Rollout files are never read.
 */
export const normalizeCodex: Normalizer = (payload, eventName, cache) => {
  const mem = memoryIn(cache, 'codex', newMemory)

  // the notify argument carries `type` instead of a hook event name
  if (payload.type === 'agent-turn-complete') {
    const threadId = readString(payload, 'thread-id')
    const message = readString(payload, 'last-assistant-message')
    rememberMessage(mem, message)
    mem.leadState = 'done'
    return {
      eventName: 'agent-turn-complete',
      state: 'done',
      newTurn: false,
      outcome: 'success',
      fields: turnFields(mem),
      providerSession: (threadId && captureProviderSession('codex', { session_id: threadId })) || undefined
    }
  }

  const agentId = readString(payload, 'agent_id')

  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    if (!agentId) return null
    const childOps: ChildOp[] =
      eventName === 'SubagentStart' ? [{ op: 'start', id: agentId, kind: 'agent' }] : [{ op: 'stop', id: agentId }]
    if (eventName === 'SubagentStart') addChild(mem.children, agentId)
    else mem.children.delete(agentId)
    return { eventName, state: null, newTurn: false, fields: {}, childOps }
  }

  const toolName = firstString(payload, TOOL_NAME_KEYS)
  const asksQuestion = eventName === 'PreToolUse' && isAskUserQuestionTool(toolName)
  const autoReviewed = payload.approvals_reviewer === 'auto_review'
  const state =
    eventName === 'SessionStart' || eventName === 'UserPromptSubmit' || eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'PreToolUse'
        ? asksQuestion
          ? 'waiting'
          : 'working'
        : eventName === 'PermissionRequest'
          ? autoReviewed
            ? 'working'
            : 'waiting'
          : eventName === 'Stop' || eventName === 'Interrupt'
            ? 'done'
            : null
  if (state === null) return null

  if (agentId) {
    // a child's activity is child evidence; its own approval wait is the only thing that moves the row
    addChild(mem.children, agentId)
    return {
      eventName,
      state,
      newTurn: false,
      agentId,
      fields:
        state === 'waiting'
          ? { toolName, toolInput: toolInputSummary(toolInputOf(payload)), question: questionJson(toolName, toolInputOf(payload)) }
          : {},
      childOps: [{ op: 'state', id: agentId, state: state === 'waiting' ? 'waiting' : 'working' }],
      permissionRequest: eventName === 'PermissionRequest' && state === 'waiting' ? true : undefined
    }
  }

  const compaction = eventName === 'SessionStart' && payload.source === 'compact'
  const newTurn = eventName === 'UserPromptSubmit' || (eventName === 'SessionStart' && (!compaction || mem.leadState !== 'working'))
  const freshSession = eventName === 'SessionStart' && newTurn
  if (freshSession) {
    mem.children.clear()
    mem.model = undefined
  }
  if (newTurn) {
    resetTurn(mem)
    mem.prompt = eventName === 'UserPromptSubmit' ? promptOf(payload) : ''
  }
  rememberModel(mem, payload)
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PermissionRequest') {
    rememberTool(mem, toolName, toolInputOf(payload))
  }
  const childOps: ChildOp[] = []
  if (eventName === 'Stop') {
    rememberMessage(mem, readString(payload, 'last_assistant_message'))
    // Codex can omit child Stop hooks, so a lead Stop retires the children it knew of
    for (const id of mem.children) childOps.push({ op: 'stop', id })
    mem.children.clear()
  }
  mem.leadState = state

  const interrupted = eventName === 'Interrupt'
  return {
    eventName,
    state,
    newTurn,
    outcome: interrupted ? 'cancellation' : eventName === 'Stop' ? 'success' : undefined,
    interrupted: interrupted ? true : undefined,
    fields: { ...turnFields(mem), question: asksQuestion ? questionJson(toolName, toolInputOf(payload)) : undefined },
    childOps: childOps.length > 0 ? childOps : undefined,
    providerSession: captureProviderSession('codex', payload) ?? undefined,
    permissionRequest: eventName === 'PermissionRequest' && state === 'waiting' ? true : undefined,
    movesLead: eventName === 'SessionStart' && (payload.source === 'resume' || payload.source === 'clear') ? true : undefined,
    cacheReset: freshSession ? true : undefined
  }
}

import type { AgentState, Normalizer } from '../types'
import {
  cacheResetResult,
  isAskUserQuestionTool,
  questionJson,
  readPrompt,
  readString,
  result,
  summarizeToolInput,
} from './shared'

type Kind = 'pi' | 'omp' | 'prime-agent'

const OMP_APPROVAL = 'pi:ompApproval'
const TOOL_EVENTS = new Set(['tool_call', 'tool_execution_start', 'tool_execution_end'])
const WORKING_EVENTS = new Set(['before_agent_start', 'agent_start', 'tool_call', 'tool_execution_start', 'tool_execution_end', 'message_end'])
const OMP_APPROVAL_RELEASES = new Set(['tool_approval_resolved', 'before_agent_start', 'agent_start'])

function asksUser(kind: Kind, toolName: string | undefined, eventName: string): boolean {
  const isAsk = kind === 'omp' ? toolName === 'ask' : kind === 'pi' && isAskUserQuestionTool(toolName)
  return isAsk && (eventName === 'tool_call' || eventName === 'tool_execution_start')
}

function normalizePiFamily(kind: Kind, payload: Record<string, unknown>, eventName: string, cache: Map<string, unknown>) {
  if (kind !== 'omp' && eventName === 'session_start') {
    cache.delete(OMP_APPROVAL)
    // a custom modal can switch sessions before its promise resolves, so an open prompt still counts
    if (kind !== 'pi' || payload.ui_prompt_active !== true) return cacheResetResult(eventName)
  }

  const model = readString(payload, 'model')
  if (eventName === 'model_select' || eventName === 'subagents_update') {
    if (eventName === 'model_select' && !model) return null
    return result(eventName, null, { fields: { model } })
  }

  const toolName = readString(payload, 'tool_name')
  const asks = asksUser(kind, toolName, eventName)
  const approvalRequested = kind === 'omp' && eventName === 'tool_approval_requested'
  let state: AgentState | null = null
  if (asks || approvalRequested) state = 'blocked'
  else if ((kind === 'omp' && eventName === 'tool_approval_resolved') || WORKING_EVENTS.has(eventName)) state = 'working'
  else if (eventName === 'agent_end') state = 'done'

  if (kind === 'pi' && (eventName === 'ui_prompt_start' || payload.ui_prompt_active === true)) state = 'waiting'
  else if (kind === 'pi' && eventName === 'ui_prompt_end') state = payload.is_idle === true ? 'done' : 'working'
  if (!state) return null

  // omp posts tool_execution_start while its Approve/Deny select still holds the human, so only
  // the resolution or a new turn ends an approval wait; an `ask` is its own wait and not held
  if (kind === 'omp') {
    if (OMP_APPROVAL_RELEASES.has(eventName) || state === 'done') cache.delete(OMP_APPROVAL)
    if (approvalRequested) cache.set(OMP_APPROVAL, toolName !== 'ask')
    else if (state === 'working' && cache.get(OMP_APPROVAL) === true) return null
  }

  const isToolEvent = TOOL_EVENTS.has(eventName)
  const assistantText = eventName === 'message_end' && payload.role === 'assistant' ? readString(payload, 'text') : undefined
  return result(eventName, state, {
    newTurn: eventName === 'before_agent_start',
    sessionBoundary: eventName === 'agent_end' && payload.session_boundary === true ? true : undefined,
    fields: {
      prompt: readPrompt(payload),
      model,
      toolName: isToolEvent || approvalRequested ? toolName : undefined,
      toolInput: approvalRequested ? readString(payload, 'reason') : isToolEvent ? summarizeToolInput(payload.tool_input) : undefined,
      question: asks ? questionJson(payload.tool_input) : undefined,
      lastAssistantMessage: assistantText,
    },
  })
}

/** Pi: an ask tool is blocked, a `ui_prompt` modal is waiting, and `model_select` rides without a state. */
export const normalizePi: Normalizer = (payload, eventName, cache) => normalizePiFamily('pi', payload, eventName, cache)

/** Oh My Pi: its `ask` tool and its tool approvals are blocked, and an approval holds through the tool's own start events. */
export const normalizeOmp: Normalizer = (payload, eventName, cache) => normalizePiFamily('omp', payload, eventName, cache)

export const normalizePrimeAgent: Normalizer = (payload, eventName, cache) =>
  normalizePiFamily('prime-agent', payload, eventName, cache)

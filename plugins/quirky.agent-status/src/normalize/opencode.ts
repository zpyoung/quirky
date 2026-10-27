import type { AgentState, Normalized, Normalizer, Outcome } from '../types'
import { isRecord, questionJson, readFirstString, readString, result } from './shared'

type Family = 'opencode' | 'opencode2' | 'mimo-code'

const STATES: Record<string, AgentState> = {
  SessionBusy: 'working',
  MessagePart: 'working',
  SessionIdle: 'done',
  PermissionRequest: 'waiting',
  AskUserQuestion: 'waiting',
}

/** What a permission request asks for: the command, path or url in its metadata, else its patterns. */
function permissionInput(payload: Record<string, unknown>): string | undefined {
  const fromMetadata = isRecord(payload.metadata)
    ? readFirstString(payload.metadata, ['command', 'filepath', 'file_path', 'path', 'url'])
    : undefined
  if (fromMetadata) return fromMetadata
  const patterns = Array.isArray(payload.patterns)
    ? payload.patterns.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return patterns.length > 0 ? patterns.join(', ') : undefined
}

/** The payload minus the hook envelope: what OpenCode's question.asked carried. */
function questionPayload(payload: Record<string, unknown>): unknown {
  if (Object.hasOwn(payload, 'tool_input')) return payload.tool_input
  const { hook_event_name: _name, hookEventName: _camel, ...rest } = payload
  return rest
}

function rootOutcome(payload: Record<string, unknown>): Outcome | undefined {
  const errorName = payload.root_turn_error_name
  if (payload.root_state !== 'done' || typeof errorName !== 'string' || errorName.length === 0) return undefined
  return errorName === 'MessageAbortedError' ? 'cancellation' : 'failure'
}

function normalizeFamily(family: Family, payload: Record<string, unknown>, eventName: string): Normalized | null {
  const hasBoundary = family !== 'mimo-code'
  const isSessionStart = hasBoundary && eventName === 'SessionStart'
  const state = isSessionStart ? 'done' : STATES[eventName]
  if (!state) return null

  const text = readString(payload, 'text')
  const userPart = eventName === 'MessagePart' && payload.role === 'user' && text !== undefined
  const assistantPart = eventName === 'MessagePart' && payload.role === 'assistant'
  const outcome = hasBoundary && state === 'done' ? rootOutcome(payload) : undefined

  return result(eventName, state, {
    newTurn: isSessionStart || userPart,
    sessionBoundary: isSessionStart ? true : undefined,
    outcome,
    interrupted: outcome === 'cancellation' ? true : undefined,
    fields: {
      prompt: userPart ? text : undefined,
      lastAssistantMessage: assistantPart ? text : undefined,
      toolName: eventName === 'PermissionRequest' ? readString(payload, 'permission') : undefined,
      toolInput: eventName === 'PermissionRequest' ? permissionInput(payload) : undefined,
      question: eventName === 'AskUserQuestion' ? questionJson(questionPayload(payload)) : undefined,
    },
  })
}

/** OpenCode: SessionStart is a boundary, and `root_state` / `root_turn_error_name` carry the root agent's verdict. */
export const normalizeOpencode: Normalizer = (payload, eventName) => normalizeFamily('opencode', payload, eventName)

export const normalizeOpencode2: Normalizer = (payload, eventName) => normalizeFamily('opencode2', payload, eventName)

/** Mimo Code shares OpenCode's events but has no SessionStart boundary and no root verdict. */
export const normalizeMimoCode: Normalizer = (payload, eventName) => normalizeFamily('mimo-code', payload, eventName)

import type { SessionStatus } from '@quirky/protocol'
import type { AgentDisplayState, AgentRow, AgentState, AgentStatusSummary } from './types'

/** What the window says for each display state; the glyphs live with the window. */
export const LABELS: Record<AgentDisplayState, string> = {
  working: 'Working',
  monitoring: 'Monitoring background tasks',
  waiting: 'Waiting for input',
  permission: 'Needs attention',
  blocked: 'Blocked',
  failed: 'Failed',
  interrupted: 'Interrupted',
  done: 'Done',
  unverifiable: 'No recent update',
  idle: 'Idle',
  unconfirmed: "Couldn't confirm",
}

/** A live row with no evidence for this long stops being trusted; its state is left alone. */
export const STALE_AFTER_MS = 1_800_000

export type CoarseStatus = Extract<SessionStatus, 'running' | 'working' | 'waiting' | 'done'>

/** Maximum lengths of the row's text fields. */
export const CAPS = {
  prompt: 200,
  toolName: 60,
  toolInput: 160,
  lastAssistantMessage: 8000,
  question: 16000,
  model: 120,
  detail: 200,
} as const

function dropLoneHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : dropLoneHighSurrogate(text.slice(0, max))
}

/** Trims, folds every line break run to one space and truncates without splitting a surrogate pair. */
export function capLine(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  // the scan is bounded first so a pasted wall of text can't cost a full regex pass
  const bounded = text.slice(0, max * 8 + 64)
  return truncate(bounded.replace(/[\r\n\u2028\u2029]+/g, ' ').trim(), max).trimEnd()
}

/** Like `capLine` but keeps line breaks, folding runs of blank lines to one blank line. */
export function capText(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const folded = text.replace(/\r\n|[\r\u2028\u2029]/g, '\n').replace(/\n{3,}/g, '\n\n')
  return truncate(folded.trim(), max)
}

/** Truncates only: for JSON the reader parses, where trimming or folding would corrupt the text. */
export function capRaw(text: unknown, max: number): string {
  return typeof text === 'string' ? truncate(text, max) : ''
}

const isJsonObjectText = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed.startsWith('{') && trimmed.endsWith('}')
}

// the field that names what a tool is doing, most telling first
const TOOL_INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One readable line for a tool's input, which may arrive as JSON object text; '' when none can be read. */
function summarizeToolInput(input: string | undefined): string {
  if (!input) return ''
  if (!input.trimStart().startsWith('{')) return capLine(input, CAPS.toolInput)
  const parsed = parseJson(input)
  if (typeof parsed !== 'object' || parsed === null) return ''
  const fields = parsed as Record<string, unknown>
  const key = TOOL_INPUT_KEYS.find((name) => typeof fields[name] === 'string' && fields[name]) ?? Object.keys(fields).find((name) => typeof fields[name] === 'string' && fields[name])
  return key ? capLine(fields[key], CAPS.toolInput) : ''
}

/** The question an agent asked, from the JSON of its ask input or from plain text. */
function questionText(question: string | undefined): string {
  if (!question) return ''
  const trimmed = question.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return capLine(trimmed, CAPS.detail)
  const parsed = parseJson(trimmed)
  const asked = Array.isArray(parsed) ? parsed : (parsed as { questions?: unknown } | undefined)?.questions
  const first = Array.isArray(asked) ? asked[0] : parsed
  if (typeof first === 'string') return capLine(first, CAPS.detail)
  if (typeof first === 'object' && first !== null) {
    const fields = first as Record<string, unknown>
    for (const key of ['question', 'header', 'prompt', 'text', 'message']) {
      if (typeof fields[key] === 'string' && fields[key]) return capLine(fields[key], CAPS.detail)
    }
  }
  return ''
}

function toolText(row: AgentRow): string {
  const held = row.heldPermission
  const name = row.toolName ?? (row.state === 'waiting' ? held?.toolName : undefined)
  if (!name) return ''
  const summary = summarizeToolInput(row.toolInput ?? (row.state === 'waiting' ? held?.input : undefined))
  return summary ? `${name}: ${summary}` : name
}

/**
 * One readable line saying what a row is doing or waiting on, e.g. `Bash: npm test`, the question
 * asked, or the turn's prompt; '' when there is nothing to say. Never the text of a JSON object.
 */
export function readableDetail(row: AgentRow): string {
  const asking = row.state === 'waiting' || row.state === 'blocked'
  const candidates =
    row.state === 'done'
      ? [capLine(row.lastAssistantMessage, CAPS.detail), capLine(row.programStatus?.msg, CAPS.detail)]
      : [asking ? questionText(row.question) : '', toolText(row), capLine(row.programStatus?.msg, CAPS.detail)]
  candidates.push(capLine(row.prompt, CAPS.detail))
  return candidates.find((text) => text !== '' && !isJsonObjectText(text)) ?? ''
}

export type DisplayResult = { display: AgentDisplayState; label: string; detail: string }

const result = (display: AgentDisplayState, detail: string): DisplayResult => ({ display, label: LABELS[display], detail })

const minutesSince = (at: number, now: number) => Math.floor(Math.max(0, now - at) / 60_000)

/**
 * What the window draws for a row. Silence decays the display, never the state; a done row never
 * decays. A title-sourced row waiting on the user is `permission`; a program-status block of kind
 * permission or question is state `waiting` and so displays `waiting`.
 */
export function displayOf(row: AgentRow, now: number, sessionRunning: boolean): DisplayResult {
  const live = row.state !== 'done'
  if (live && row.restoredUnconfirmed) return result('unconfirmed', row.detail || readableDetail(row))
  if (live && now - row.evidenceAt > STALE_AFTER_MS) {
    return result(sessionRunning ? 'unverifiable' : 'idle', `No update in ${minutesSince(row.evidenceAt, now)}m`)
  }
  const detail = row.detail && !isJsonObjectText(row.detail) ? row.detail : readableDetail(row)
  switch (row.state) {
    case 'working':
      return result(row.workingMode === 'monitoring' ? 'monitoring' : 'working', detail)
    case 'waiting':
      return result(row.source === 'title' ? 'permission' : 'waiting', detail)
    case 'blocked':
      return result('blocked', detail)
    case 'done':
      if (row.outcome === 'failure') return result('failed', detail)
      if (row.interrupted || row.outcome === 'cancellation') return result('interrupted', detail)
      return result('done', detail)
  }
}

/**
 * The window's display for a stored summary, which can't be re-derived from a row. The summary was
 * computed when the row last changed, so a live one that has since gone quiet decays here.
 */
export function windowDisplay(summary: AgentStatusSummary, now: number, sessionRunning: boolean): DisplayResult {
  if (summary.state !== 'done' && !summary.restoredUnconfirmed && now - summary.evidenceAt > STALE_AFTER_MS) {
    return result(sessionRunning ? 'unverifiable' : 'idle', `No update in ${minutesSince(summary.evidenceAt, now)}m`)
  }
  return { display: summary.display, label: summary.label, detail: summary.detail }
}

function coarseOfState(state: AgentState | undefined): CoarseStatus {
  if (state === 'done') return 'done'
  if (state === 'waiting' || state === 'blocked') return 'waiting'
  return 'working'
}

/**
 * The session's coarse status for a display state, or `running` when there is no row. A decayed or
 * unconfirmed display keeps its row's underlying state's value, so pass the state with it.
 */
export function coarseStatus(display: AgentDisplayState | null, state?: AgentState): CoarseStatus {
  switch (display) {
    case null:
      return 'running'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'blocked':
    case 'permission':
      return 'waiting'
    case 'done':
    case 'failed':
    case 'interrupted':
      return 'done'
    case 'unverifiable':
    case 'idle':
    case 'unconfirmed':
      return coarseOfState(state)
  }
}

/** The summary a row carries on `Session.agentStatus` and returns from `list`. */
export function summaryOf(row: AgentRow, now: number, sessionRunning: boolean): AgentStatusSummary {
  const { display, label, detail } = displayOf(row, now, sessionRunning)
  return {
    state: row.state,
    display,
    label,
    detail,
    progress: row.programStatus?.progress ?? null,
    stateStartedAt: row.stateStartedAt,
    evidenceAt: row.evidenceAt,
    restoredUnconfirmed: row.restoredUnconfirmed === true,
  }
}

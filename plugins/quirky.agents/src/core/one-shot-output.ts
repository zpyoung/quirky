import type { OneShotSpec } from './types'

const OPENCODE_INVALID_EVENTS = 'OpenCode returned invalid JSON events.'

/** Removes CSI and OSC escape sequences (colors, cursor moves, titles, hyperlinks). */
export function stripAnsi(value: string): string {
  if (!value.includes('\u001b')) return value
  const esc = '\u001b'
  const bel = '\u0007'
  return value.replace(new RegExp(`${esc}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${bel}${esc}\\r\\n]*(?:${bel}|${esc}\\\\))`, 'g'), '')
}

type OpenCodeEvent = {
  type: string
  part?: { id?: string; text?: string }
  error?: { name?: string; message?: string; data?: { message?: string } }
}

export type Decoded = { ok: true; text: string } | { ok: false; error: string; reported: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'

function isOpenCodeEvent(value: unknown): value is OpenCodeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  const { part, error } = value
  if (part !== undefined && !(isRecord(part) && optionalText(part.id) && optionalText(part.text))) return false
  if (error === undefined) return true
  if (!isRecord(error) || !optionalText(error.name) || !optionalText(error.message)) return false
  return error.data === undefined || (isRecord(error.data) && optionalText(error.data.message))
}

/**
 * Reads OpenCode's `--format json` event stream: the `text` parts joined with newlines, restarting
 * at each `step_start`. An `error` event fails the run with the event's message (`reported`);
 * output that isn't an event stream fails with a fixed sentence of its own.
 */
export function parseOpenCodeOutput(stdout: string): Decoded {
  const parts = new Map<string, string>()
  let anonymous = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, error: OPENCODE_INVALID_EVENTS, reported: false }
    }
    if (!isOpenCodeEvent(value)) return { ok: false, error: OPENCODE_INVALID_EVENTS, reported: false }
    if (value.type === 'step_start') parts.clear()
    if (value.type === 'error') {
      const { error } = value
      return { ok: false, error: error?.data?.message ?? error?.message ?? error?.name ?? 'OpenCode reported an error.', reported: true }
    }
    if (value.type === 'text' && value.part?.text !== undefined) parts.set(value.part.id ?? `anonymous-${anonymous++}`, value.part.text)
  }
  return { ok: true, text: [...parts.values()].join('\n') }
}

/** The text an agent's stdout carries, decoded the way its `oneShot.output` says. */
export function decodeOutput(output: OneShotSpec['output'], stdout: string): Decoded {
  return output === 'opencode-json' ? parseOpenCodeOutput(stdout) : { ok: true, text: stdout }
}

const SCAN_WINDOW = 8192
const HEAD_LINE_COUNT = 2
const HEAD_BUDGET = 100
const TAIL_BUDGET = 130
const SINGLE_BUDGET = 240

function truncate(value: string, budget: number): string {
  return value.length > budget ? `${value.slice(0, budget).trimEnd()}…` : value
}

function lines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line.length > 0)
}

function twoEnds(head: string[], tail: string | null): string {
  const headPart = truncate(head.join(' '), HEAD_BUDGET)
  if (tail === null || head.includes(tail)) return headPart
  return `${headPart} … ${truncate(tail, TAIL_BUDGET)}`
}

/**
 * A short excerpt of a failed run's output: the first lines and the last line of stderr, or of
 * stdout when stderr is blank. Agent CLIs share no error format, so nothing is interpreted;
 * callers sanitize the excerpt before showing it.
 */
export function excerptFailureOutput(stdout: string, stderr: string): string | null {
  const source = /\S/.test(stderr) ? stderr : stdout
  if (!/\S/.test(source)) return null
  if (source.length <= SCAN_WINDOW) {
    const all = lines(source)
    if (all.length === 0) return null
    if (all.length <= HEAD_LINE_COUNT + 1) return truncate(all.join(' '), SINGLE_BUDGET)
    return twoEnds(all.slice(0, HEAD_LINE_COUNT), all.at(-1) ?? null)
  }
  const head = lines(source.slice(0, SCAN_WINDOW)).slice(0, HEAD_LINE_COUNT)
  const tail = lines(source.slice(source.length - SCAN_WINDOW)).at(-1) ?? null
  if (head.length === 0) return tail ? truncate(tail, SINGLE_BUDGET) : null
  return twoEnds(head, tail)
}

/** Flattens an excerpt to one line, drops control and bidi characters, redacts filesystem paths and caps it at 240 characters. */
export function sanitizeFailureDetail(detail: string | null): string | null {
  const trimmed = detail
    ?.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!trimmed) return null
  const redacted = trimmed
    .replace(/\\\\[^\s"'`<>\\]+\\(?:[^\s"'`<>\\]+(?:\s+[^\s"'`<>\\]+)*(?=\\)\\)*[^\s"'`<>\\]+/g, '[path]')
    .replace(/[A-Za-z]:(?:\\+|\/)(?:[^\s"'`<>\\/|:*?]+(?:\s+[^\s"'`<>\\/|:*?]+)*(?=[\\/])(?:\\+|\/))*[^\s"'`<>\\/|:*?]+/g, '[path]')
    // a lone /login style remedy survives; only multi-segment paths are redacted
    .replace(/(^|[\s"'`(=:,])\/(?:[^\s"'`<>/]+(?:\s+[^\s"'`<>/]+)*(?=\/)\/)+[^\s"'`<>/]+/g, '$1[path]')
  return redacted.length > 240 ? `${redacted.slice(0, 240).trimEnd()}...` : redacted
}

/**
 * The message for a run that exited non-zero (`code` null means a signal ended it). An OpenCode
 * `error` event names the cause better than stderr does, so it wins for that agent.
 */
export function failureMessage(label: string, input: { code: number | null; stdout: string; stderr: string; output: OneShotSpec['output'] }): string {
  const decoded = input.output === 'opencode-json' ? parseOpenCodeOutput(input.stdout) : null
  const source = decoded && !decoded.ok && decoded.reported ? decoded.error : input.stderr
  const detail = sanitizeFailureDetail(excerptFailureOutput(input.stdout, source))
  if (input.code === null) return detail ? `${label} was stopped before it finished: ${detail}` : `${label} was stopped before it finished.`
  return detail ? `${label} failed: ${detail}` : `${label} failed with exit code ${input.code}.`
}

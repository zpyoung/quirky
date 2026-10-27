import type { AgentEntry } from './types'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const SUBMIT_SETTLE_MS = 500
const INGEST_BYTES_PER_MS = 4096

/**
 * The bytes that deliver `text` to an agent's input as one bracketed paste. Line endings become CR
 * as a terminal's own paste does, and every ESC is replaced so pasted text can never close the
 * frame early and run the rest as keystrokes.
 */
export function encodeBracketedPaste(text: string): string {
  const body = text.replace(/\r?\n/g, '\r').replaceAll('\x1b', '␛')
  return `${PASTE_START}${body}${PASTE_END}`
}

/**
 * How long to wait between a paste and its Enter so the agent has attached the paste before Enter
 * counts: a fixed settle, a floor for the paste to be ingested, and the agent's per-line settle.
 */
export function submitDelayMs(text: string, entry: Pick<AgentEntry, 'lineSettleMs'>): number {
  const ingestMs = Math.ceil(Buffer.byteLength(text, 'utf8') / INGEST_BYTES_PER_MS)
  const lineCount = text.split(/\r\n|\r|\n/).length
  return SUBMIT_SETTLE_MS + ingestMs + (entry.lineSettleMs ?? 0) * lineCount
}

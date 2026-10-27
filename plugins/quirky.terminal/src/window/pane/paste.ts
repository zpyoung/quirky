export const BRACKETED_START = '\x1b[200~'
export const BRACKETED_END = '\x1b[201~'
export const PASTE_DIRECT_BYTES = 64 * 1024
export const PASTE_CHUNK_BYTES = 16 * 1024
export const PASTE_MAX_BYTES = 16 * 1024 * 1024
export const PASTE_TIMEOUT_MS = 30_000

// a pasted ESC could close the bracket early and run the rest as typed input
const INERT_ESCAPE = '␛'

export type PastePlan =
  | { kind: 'refused' }
  /** `closer` ends a bracketed paste that was cut short; null when no bracket is open. */
  | { kind: 'write'; chunks: string[]; closer: string | null }

function utf8Length(text: string): number {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) total += 1
    else if (unit < 0x800) total += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      total += 4
      index += 1
    } else total += 3
  }
  return total
}

/** The slices of `text` of at most `maxBytes` UTF-8 bytes each, never splitting a character. */
function chunkByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const unit = text.charCodeAt(index)
    const pair = unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
    const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3
    if (bytes + size > maxBytes) {
      chunks.push(text.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += size
    index += pair ? 2 : 1
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks
}

/**
 * Turns pasted text into the writes that deliver it: newlines become carriage returns, text of
 * up to 64 KiB is one write, larger text goes in 16 KiB chunks, and bracketed-paste markers
 * wrap it only when the running program enabled that mode. Text over 16 MiB is refused.
 */
export function planPaste(text: string, bracketed: boolean): PastePlan {
  if (text.length > PASTE_MAX_BYTES) return { kind: 'refused' }
  if (text.length * 3 > PASTE_MAX_BYTES && utf8Length(text) > PASTE_MAX_BYTES) return { kind: 'refused' }
  if (text.length === 0) return { kind: 'write', chunks: [], closer: null }

  let payload = text.replace(/\r\n|\n|\r/g, '\r')
  if (bracketed) payload = payload.replaceAll('\x1b', INERT_ESCAPE)
  if (utf8Length(payload) <= PASTE_DIRECT_BYTES) {
    return { kind: 'write', chunks: [bracketed ? `${BRACKETED_START}${payload}${BRACKETED_END}` : payload], closer: null }
  }
  const body = chunkByBytes(payload, PASTE_CHUNK_BYTES)
  return bracketed
    ? { kind: 'write', chunks: [BRACKETED_START, ...body, BRACKETED_END], closer: BRACKETED_END }
    : { kind: 'write', chunks: body, closer: null }
}

export type PasteOutcome = 'done' | 'timeout' | 'failed'

/**
 * Sends `chunks` one at a time, waiting for each write to finish, and gives up after
 * `timeoutMs` overall. A cut-short paste still sends `closer` so the program doesn't stay in
 * bracketed-paste mode.
 */
export async function runPaste(
  chunks: readonly string[],
  send: (data: string) => Promise<unknown>,
  options: { timeoutMs?: number; now?: () => number; closer: string | null }
): Promise<PasteOutcome> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? PASTE_TIMEOUT_MS)
  let outcome: PasteOutcome = 'done'
  for (const chunk of chunks) {
    const remaining = deadline - now()
    if (remaining <= 0) {
      outcome = 'timeout'
      break
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      send(chunk).then(
        () => 'ok' as const,
        () => 'failed' as const
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining)
      })
    ])
    clearTimeout(timer)
    if (result !== 'ok') {
      outcome = result
      break
    }
  }
  if (outcome !== 'done' && options.closer) {
    await send(options.closer).catch(() => {})
  }
  return outcome
}

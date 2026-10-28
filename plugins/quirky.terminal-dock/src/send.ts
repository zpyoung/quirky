import type { PluginContext, Session } from '@quirky/protocol'
import type { ProviderBridge } from './providers'
import type { DockAttachment, SendResult } from './types'

const BRACKETED_PASTE_OPEN = '\u001b[200~'
const BRACKETED_PASTE_CLOSE = '\u001b[201~'
const VISIBLE_ESCAPE = '␛'
const CLEAR_CHUNK_BYTES = 31
const CLEAR_GAP_MS = 16
const VERIFIED_AGENTS: Record<string, true> = { claude: true, 'claude-agent-teams': true, openclaude: true, codex: true }

export type SendEngineInput = {
  context: PluginContext
  session: Session
  text: string
  attachments: DockAttachment[]
  bridge: ProviderBridge
  signal: AbortSignal
  ensure(): void | Promise<void>
  phase(value: string): void
  bodyMayHaveBeenWritten(): void | Promise<void>
  beforeSubmit?(signal: AbortSignal): Promise<void>
}

function abortError(): Error {
  const error = new Error('send cancelled')
  error.name = 'AbortError'
  return error
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const done = () => {
    signal.removeEventListener('abort', cancelled)
    resolve()
  }
  const cancelled = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancelled)
    reject(abortError())
  }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', cancelled, { once: true })
  if (signal.aborted) cancelled()
  return promise
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorFields(error: unknown): { code?: string; acceptedBytes?: number | null } {
  if (typeof error !== 'object' || error === null) return {}
  const fields = error as { code?: unknown; acceptedBytes?: unknown }
  return {
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(fields.acceptedBytes === null || typeof fields.acceptedBytes === 'number' ? { acceptedBytes: fields.acceptedBytes } : {})
  }
}

function isUncertainWrite(error: unknown): boolean {
  const fields = errorFields(error)
  return fields.code === 'PTY_WRITE_UNCERTAIN' || (fields.acceptedBytes !== undefined && fields.acceptedBytes !== null && fields.acceptedBytes > 0)
}

function inputClearBytes(lineCount: number): Uint8Array {
  const count = Math.min(40, lineCount + 8) * 2 - 1
  const bytes = new Uint8Array(count * 2)
  for (let index = 0; index < count; index++) {
    bytes[index * 2] = 0x15
    bytes[index * 2 + 1] = 0x0b
  }
  return bytes
}

async function writeChunks(input: SendEngineInput, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += CLEAR_CHUNK_BYTES) {
    checkAbort(input.signal)
    await input.ensure()
    checkAbort(input.signal)
    const end = Math.min(offset + CLEAR_CHUNK_BYTES, bytes.length)
    await input.context.pty.writeAccepted(input.session.id, bytes.subarray(offset, end))
    checkAbort(input.signal)
    await input.ensure()
    checkAbort(input.signal)
    if (end < bytes.length) await cancellableDelay(CLEAR_GAP_MS, input.signal)
  }
}

async function writeBody(
  input: SendEngineInput,
  data: string,
  body: boolean,
  markMayHaveBeenWritten: () => Promise<void>,
  markAccepted: () => void
): Promise<void> {
  checkAbort(input.signal)
  await input.ensure()
  checkAbort(input.signal)
  if (body) {
    await markMayHaveBeenWritten()
    await input.ensure()
    checkAbort(input.signal)
  }
  try {
    await input.context.pty.writeAccepted(input.session.id, data)
  } catch (error) {
    if (body && isUncertainWrite(error)) markAccepted()
    throw error
  }
  if (body) markAccepted()
  await input.ensure()
  checkAbort(input.signal)
}

function promptForTui(text: string, attachments: DockAttachment[]): { sendText: string; evidenceText: string } {
  const safeText = text.replaceAll('\u001b', VISIBLE_ESCAPE)
  const mentions = attachments
    .filter((item) => !item.image)
    .map((item) => `@${JSON.stringify(item.path.replaceAll('\u001b', VISIBLE_ESCAPE))}`)
  const prompt = [...mentions, safeText].filter((part) => part.length > 0).join('\n')
  return { sendText: prompt, evidenceText: prompt }
}

async function readInputStillVisible(input: SendEngineInput, submittedText: string): Promise<boolean> {
  try {
    const screen = await input.context.pty.read(input.session.id, 80)
    const content = screen.lines.join('\n')
    const normalizedText = submittedText.replace(/\r\n|\r/g, '\n')
    return normalizedText.length > 0 && content.includes(normalizedText)
  } catch {
    return true
  }
}

async function observedWithin(input: SendEngineInput, text: string, since: number): Promise<boolean> {
  const { promise: timeout, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => resolve(false), 1_500)
  try {
    return await Promise.race([input.bridge.observed(input.session, text, since), timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Performs one PTY prompt submission. It never retries, and transport acceptance is not consumption evidence. */
export async function executePrompt(input: SendEngineInput, id: string): Promise<SendResult> {
  let bodyAccepted = false
  const markMayHaveBeenWritten = async () => input.bodyMayHaveBeenWritten()
  const markAccepted = () => {
    bodyAccepted = true
  }
  const verified = Object.hasOwn(VERIFIED_AGENTS, input.session.agent)
  try {
    checkAbort(input.signal)
    await input.ensure()
    checkAbort(input.signal)
    if (input.text.length === 0 && input.attachments.length === 0) {
      return { id, outcome: 'refused', accepted: false, reason: 'Send requires text or an attachment' }
    }

    input.phase('clearing')
    const lines = Math.max(1, input.text.split(/\r\n|\r|\n/).length)
    await writeChunks(input, inputClearBytes(lines))
    if (verified) {
      input.phase('checking-input')
      await cancellableDelay(140, input.signal)
      await input.ensure()
      checkAbort(input.signal)
      const uncleared = await readInputStillVisible(input, input.text)
      await input.ensure()
      checkAbort(input.signal)
      if (uncleared) await writeChunks(input, inputClearBytes(40))
    }

    const since = Date.now()
    for (const attachment of input.attachments) {
      if (!attachment.image) continue
      input.phase('pasting-image')
      await input.ensure()
      checkAbort(input.signal)
      const safePath = attachment.path.replaceAll('\u001b', VISIBLE_ESCAPE)
      await writeBody(input, `${BRACKETED_PASTE_OPEN}${safePath}${BRACKETED_PASTE_CLOSE}`, true, markMayHaveBeenWritten, markAccepted)
      input.phase('settling-image')
      await cancellableDelay(300, input.signal)
      await input.ensure()
      checkAbort(input.signal)
    }

    const prompt = promptForTui(input.text, input.attachments)
    if (prompt.sendText.length > 0) {
      input.phase('body')
      const normalizedLines = prompt.sendText.replace(/\r\n|\r|\n/g, '\n')
      if (normalizedLines.includes('\n')) {
        const normalized = normalizedLines.replaceAll('\n', '\r')
        await writeBody(input, `${BRACKETED_PASTE_OPEN}${normalized}${BRACKETED_PASTE_CLOSE}`, true, markMayHaveBeenWritten, markAccepted)
      } else {
        await writeBody(input, normalizedLines, true, markMayHaveBeenWritten, markAccepted)
      }
    }

    input.phase('submitting')
    await cancellableDelay(500, input.signal)
    if (input.beforeSubmit) await input.beforeSubmit(input.signal)
    await input.ensure()
    checkAbort(input.signal)
    await writeBody(input, '\r', false, markMayHaveBeenWritten, markAccepted)

    if (!verified) return { id, outcome: 'unobservable', accepted: bodyAccepted }

    input.phase('observing')
    for (let attempt = 0; attempt < 4; attempt++) {
      await input.ensure()
      checkAbort(input.signal)
      const observed = await observedWithin(input, prompt.evidenceText, since)
      await input.ensure()
      checkAbort(input.signal)
      if (observed) return { id, outcome: 'observed-cleared', accepted: bodyAccepted }
      if (attempt < 3) await cancellableDelay(900, input.signal)
    }
    return {
      id,
      outcome: 'may-not-have-sent',
      accepted: bodyAccepted,
      reason: 'Send may not have completed. Check the terminal before retrying.'
    }
  } catch (error) {
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return {
        id,
        outcome: 'cancelled',
        accepted: bodyAccepted,
        ...(bodyAccepted ? { reason: 'Send may not have completed. Check the terminal before retrying.' } : {})
      }
    }
    const uncertain = isUncertainWrite(error)
    const accepted = bodyAccepted || uncertain
    return {
      id,
      outcome: accepted ? 'may-not-have-sent' : 'refused',
      accepted,
      reason: accepted ? 'Send may not have completed. Check the terminal before retrying.' : errorMessage(error)
    }
  }
}

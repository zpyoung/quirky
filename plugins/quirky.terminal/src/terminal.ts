import {
  base64ToBytes,
  type ClientStream,
  type PluginCaller,
  type PluginContext,
  type PluginEvent,
  type Session
} from '@quirky/protocol'

const DEFAULT_ENTER_DELAY_MS = 300
const DEFAULT_READ_LINES = 50

type Attachment = { connectionId: number; stream: ClientStream; sessionId: string }

/** Output that arrived while a subscribe request was in flight, kept until its response says where the replay ends. */
type Tap = { chunks: Uint8Array[]; total: number }

const encoder = new TextEncoder()
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** The paste-then-Enter delay; tests shorten it through the environment. */
function enterDelayMs(): number {
  const override = Number(process.env.QUIRKY_TEST_ENTER_DELAY_MS)
  return process.env.QUIRKY_TEST_ENTER_DELAY_MS !== undefined && Number.isFinite(override) ? override : DEFAULT_ENTER_DELAY_MS
}

/**
 * Terminal I/O for PTY sessions: input, screen reads and the output streams of attached clients.
 *
 * Each attached session is subscribed on the PTY host once per attach and unsubscribed after the
 * last stream goes. `received` tracks the PTY host's byte offset as this service has seen it, so
 * a new stream gets exactly the bytes after its replay and a reconnect replays exactly the gap.
 */
export class TerminalService {
  private readonly bySession = new Map<string, Set<Attachment>>()
  private readonly byConnection = new Map<number, Map<number, Attachment>>()
  private readonly received = new Map<string, number>()
  private readonly taps = new Map<string, Tap>()
  private readonly holds = new Map<string, Uint8Array[]>()
  private readonly attaching = new Map<string, number>()
  private readonly attachQueue = new Map<string, Promise<unknown>>()
  private readonly forgotten = new Set<string>()

  constructor(private readonly context: PluginContext) {}

  attach = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const session = await this.requireTerminal(params.session as string)
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    if (!connection) throw this.context.error('invalid-params', 'quirky.terminal/attach needs a client connection')
    const stream = connection.openStream()
    const attachment: Attachment = { connectionId: connection.id, stream, sessionId: session.id }
    let open = true
    stream.onClose(() => {
      open = false
      this.drop(attachment)
    })
    try {
      return await this.enqueue(session.id, () =>
        this.subscribe(attachment, params.cols as number, params.rows as number, () => open)
      )
    } catch (error) {
      stream.close()
      throw error
    }
  }

  detach = (params: Record<string, unknown>, caller: PluginCaller): { ok: true } => {
    const connection = caller.role === 'plugin' ? undefined : caller.connection
    const streamId = params.streamId as number
    const attachment = connection && this.byConnection.get(connection.id)?.get(streamId)
    if (!attachment) throw this.context.error('not-found', `no such stream: ${streamId}`)
    attachment.stream.close()
    return { ok: true }
  }

  write = async (params: Record<string, unknown>): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(params.session as string)
    this.input(session.id, encoder.encode(params.data as string))
    return { ok: true }
  }

  resize = async (params: Record<string, unknown>): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(params.session as string)
    await this.context.pty.resize(session.id, params.cols as number, params.rows as number)
    return { ok: true }
  }

  /** Types `text` into a shell; pastes it into an agent, and presses Enter after a pause when asked. */
  send = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ ok: true }> => {
    const session = await this.requireTerminal(this.sessionOf(params, caller))
    const text = params.text as string
    const enter = params.enter === true
    if (session.agent === 'shell') {
      this.input(session.id, encoder.encode(enter ? `${text}\r` : text))
      return { ok: true }
    }
    this.input(session.id, encoder.encode(`\x1b[200~${text}\x1b[201~`))
    if (enter) {
      await new Promise((resolve) => setTimeout(resolve, enterDelayMs()))
      this.input(session.id, encoder.encode('\r'))
    }
    return { ok: true }
  }

  read = async (params: Record<string, unknown>, caller: PluginCaller) => {
    const session = await this.requireTerminal(this.sessionOf(params, caller))
    return this.context.pty.read(session.id, (params.lines as number | undefined) ?? DEFAULT_READ_LINES)
  }

  onData = (sessionId: string, bytes: Uint8Array): void => {
    const tap = this.taps.get(sessionId)
    if (tap) {
      tap.chunks.push(bytes.slice())
      tap.total += bytes.length
    }
    const hold = this.holds.get(sessionId)
    if (hold) {
      hold.push(bytes.slice())
      return
    }
    const known = this.received.get(sessionId)
    if (known !== undefined) this.received.set(sessionId, known + bytes.length)
    for (const attachment of this.bySession.get(sessionId) ?? []) attachment.stream.send(bytes)
  }

  /** Closes the streams of a session that was closed; the PTY host has already forgotten it. */
  onEvent = (event: { type: string }): void => {
    if (event.type !== 'quirky.session/removed') return
    const { sessionId } = (event as PluginEvent).data as { sessionId: string }
    const attachments = this.bySession.get(sessionId)
    if (!attachments || attachments.size === 0) return
    this.forgotten.add(sessionId)
    for (const attachment of [...attachments]) attachment.stream.close()
  }

  /** Re-subscribes every streamed session and sends its streams the output produced while the host was unreachable. */
  onReconnect = async (): Promise<void> => {
    for (const [sessionId, attachments] of [...this.bySession]) {
      if (attachments.size === 0) continue
      const had = this.received.get(sessionId) ?? 0
      const hold: Uint8Array[] = []
      this.holds.set(sessionId, hold)
      try {
        const { replay, offset } = await this.context.pty.subscribe(sessionId)
        const missed = offset - had
        if (missed > 0) {
          const bytes = base64ToBytes(replay)
          // a gap longer than the host's replay buffer cannot be recovered
          if (missed <= bytes.length) this.sendAll(attachments, bytes.subarray(bytes.length - missed))
        }
        for (const chunk of hold) this.sendAll(attachments, chunk)
        this.received.set(sessionId, offset + hold.reduce((sum, chunk) => sum + chunk.length, 0))
      } catch (error) {
        this.context.log(`could not resume terminal output of ${sessionId}: ${messageOf(error)}`)
      } finally {
        if (this.holds.get(sessionId) === hold) this.holds.delete(sessionId)
      }
    }
  }

  /** Ends every stream and drops the host subscriptions. */
  shutdown(): void {
    for (const attachments of [...this.bySession.values()]) {
      for (const attachment of [...attachments]) attachment.stream.close()
    }
  }

  private sendAll(attachments: Iterable<Attachment>, bytes: Uint8Array): void {
    for (const attachment of attachments) attachment.stream.send(bytes)
  }

  private sessionOf(params: Record<string, unknown>, caller: PluginCaller): string {
    const explicit = params.session as string | undefined
    const session = explicit ?? (caller.role === 'plugin' ? undefined : caller.sessionId)
    if (!session) throw this.context.error('invalid-params', 'no session; pass session or call from inside a session')
    return session
  }

  private async requireTerminal(sessionId: string): Promise<Session> {
    const session = (await this.context.call('quirky.session/get', { session: sessionId })) as Session
    if (session.kind !== 'terminal') throw this.context.error('invalid-params', `session ${sessionId} has no terminal`)
    return session
  }

  private input(sessionId: string, bytes: Uint8Array): void {
    this.context.pty.write(sessionId, bytes)
  }

  /** Attaches to the same session run one after another, so each subscribe response is matched with the output that follows it. */
  private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.attachQueue.get(sessionId) ?? Promise.resolve()).then(work)
    const settled = run.catch(() => {})
    this.attachQueue.set(sessionId, settled)
    void settled.then(() => {
      if (this.attachQueue.get(sessionId) === settled) this.attachQueue.delete(sessionId)
    })
    return run
  }

  private async subscribe(attachment: Attachment, cols: number, rows: number, isOpen: () => boolean) {
    const { sessionId, stream } = attachment
    this.attaching.set(sessionId, (this.attaching.get(sessionId) ?? 0) + 1)
    try {
      await this.context.pty.resize(sessionId, cols, rows).catch(() => {})
      const start = this.received.get(sessionId)
      const tap: Tap = { chunks: [], total: 0 }
      this.taps.set(sessionId, tap)
      let result: { replay: string; offset: number }
      try {
        result = await this.context.pty.subscribe(sessionId)
      } finally {
        this.taps.delete(sessionId)
      }
      // output after the response is everything the tap holds when this is the first subscription,
      // else what the running offset has gained beyond the replay's end
      const end = start === undefined ? result.offset + tap.total : Math.max(start + tap.total, result.offset)
      const after = end - result.offset
      this.received.set(sessionId, end)
      if (isOpen()) {
        const set = this.bySession.get(sessionId) ?? new Set()
        set.add(attachment)
        this.bySession.set(sessionId, set)
        const streams = this.byConnection.get(attachment.connectionId) ?? new Map()
        streams.set(stream.streamId, attachment)
        this.byConnection.set(attachment.connectionId, streams)
        if (after > 0) {
          const all = concat(tap.chunks)
          stream.send(all.subarray(all.length - after))
        }
      }
      return { streamId: stream.streamId, replay: result.replay, offset: result.offset }
    } catch (error) {
      throw new Error(messageOf(error))
    } finally {
      const left = (this.attaching.get(sessionId) ?? 1) - 1
      if (left > 0) this.attaching.set(sessionId, left)
      else this.attaching.delete(sessionId)
      if (!isOpen()) this.drop(attachment)
      else this.releaseIfIdle(sessionId)
    }
  }

  private drop(attachment: Attachment): void {
    this.bySession.get(attachment.sessionId)?.delete(attachment)
    const streams = this.byConnection.get(attachment.connectionId)
    streams?.delete(attachment.stream.streamId)
    if (streams?.size === 0) this.byConnection.delete(attachment.connectionId)
    this.releaseIfIdle(attachment.sessionId)
  }

  private releaseIfIdle(sessionId: string): void {
    if ((this.bySession.get(sessionId)?.size ?? 0) > 0) return
    if ((this.attaching.get(sessionId) ?? 0) > 0) return
    this.bySession.delete(sessionId)
    this.received.delete(sessionId)
    if (this.forgotten.delete(sessionId)) return
    this.context.pty.unsubscribe(sessionId).catch(() => {})
  }
}

import type { PiExit, PiFrame, PiTransport, PiTransportFactory, PiTransportHandlers, PiTransportSpec } from '../../pi-rpc'

type Reply = { success: boolean; data?: unknown; error?: string }

/**
 * A pi or omp child the test drives by hand: it records every frame the runner writes,
 * answers commands with a scripted response, and lets the test push events or end the process.
 */
export class FakePiTransport implements PiTransport {
  readonly written: PiFrame[] = []
  readonly replies = new Map<string, (frame: PiFrame) => Reply>()
  /** Commands the fake never answers, to hold a request open. */
  readonly silent = new Set<string>()
  closed = false
  stderrTail: string[] = []

  constructor(
    readonly spec: PiTransportSpec,
    private readonly handlers: PiTransportHandlers
  ) {
    this.replies.set('get_state', () => ({
      success: true,
      data: { sessionId: 'pi-sess-1', sessionFile: '/fake/pi-sess-1.jsonl', isStreaming: false }
    }))
  }

  write(frame: PiFrame): void {
    if (this.closed) throw new Error('transport is closed')
    this.written.push(frame)
    if (typeof frame.id !== 'string' || frame.type === 'extension_ui_response' || this.silent.has(String(frame.type))) return
    const reply = this.replies.get(String(frame.type))?.(frame) ?? { success: true }
    const response: PiFrame = { id: frame.id, type: 'response', command: frame.type, success: reply.success }
    if (reply.data !== undefined) response.data = reply.data
    if (reply.error !== undefined) response.error = reply.error
    queueMicrotask(() => {
      if (!this.closed) this.handlers.frame(response)
    })
  }

  async close(): Promise<void> {
    this.closed = true
  }

  emit(...frames: PiFrame[]): void {
    for (const frame of frames) this.handlers.frame(frame)
  }

  exit(code: number | null, stderr: string[] = []): void {
    this.stderrTail = stderr
    const exit: PiExit = { code, signal: null, stderrTail: stderr }
    this.handlers.exit(exit)
  }

  /** The frames written so far with the given `type`. */
  commands(type: string): PiFrame[] {
    return this.written.filter((frame) => frame.type === type)
  }
}

/** A transport factory that records every child the runner starts. */
export function fakePiTransports(options: { silent?: string[] } = {}): { factory: PiTransportFactory; started: FakePiTransport[]; last(): FakePiTransport } {
  const started: FakePiTransport[] = []
  return {
    started,
    factory: (spec, handlers) => {
      const transport = new FakePiTransport(spec, handlers)
      for (const command of options.silent ?? []) transport.silent.add(command)
      started.push(transport)
      return transport
    },
    last: () => {
      const transport = started.at(-1)
      if (!transport) throw new Error('no pi child was started')
      return transport
    }
  }
}

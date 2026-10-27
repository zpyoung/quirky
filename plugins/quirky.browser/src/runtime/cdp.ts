import { validateValue, type Schema } from '@quirky/protocol'

const MAX_FRAME_BYTES = 50 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90_000

export type CdpEvent = { method: string; sessionId?: string; params: Record<string, unknown> }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type EventListener = (event: CdpEvent) => void

const MESSAGE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    method: { type: 'string' },
    sessionId: { type: 'string' },
    result: {},
    params: { type: 'object', additionalProperties: true },
    error: {
      type: 'object',
      properties: { code: { type: 'integer' }, message: { type: 'string' }, data: {} },
      required: ['code', 'message'],
      additionalProperties: true
    }
  },
  additionalProperties: true
}

export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  private closed = false

  private constructor(private readonly socket: WebSocket, private readonly onClosed?: (reason: string) => void) {
    socket.addEventListener('message', (event) => { void this.receive(event.data) })
    socket.addEventListener('error', () => this.failAll('CDP websocket transport failed'))
    socket.addEventListener('close', () => this.failAll('CDP websocket closed'))
  }

  static async connect(url: string, onClosed?: (reason: string) => void, timeoutMs = 5_000): Promise<CdpConnection> {
    const socket = new WebSocket(url)
    const opened = Promise.withResolvers<void>()
    const timer = setTimeout(() => opened.reject(new Error('CDP websocket connection timed out')), timeoutMs)
    socket.addEventListener('open', () => opened.resolve(), { once: true })
    socket.addEventListener('error', () => opened.reject(new Error('CDP websocket connection failed')), { once: true })
    try {
      await opened.promise
      return new CdpConnection(socket, onClosed)
    } catch (error) {
      socket.close()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  subscribe(method: string, listener: EventListener): () => void {
    let listeners = this.listeners.get(method)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(method, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.listeners.delete(method)
    }
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP websocket is not connected')
    const id = this.nextId++
    const result = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      result.reject(new Error(`CDP command ${method} timed out`))
    }, timeoutMs)
    this.pending.set(id, { resolve: result.resolve, reject: result.reject, timer })
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    const encoded = JSON.stringify(message)
    if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
      clearTimeout(timer)
      this.pending.delete(id)
      throw new Error('CDP command exceeds the 50 MiB frame limit')
    }
    try {
      this.socket.send(encoded)
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      throw error instanceof Error ? error : new Error(String(error))
    }
    return await result.promise
  }

  close(): void {
    this.socket.close()
    if (this.closed) return
    this.closed = true
    this.failAll('CDP websocket closed')
  }

  private async receive(input: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void> {
    let text: string
    if (typeof input === 'string') text = input
    else if (input instanceof Blob) text = await input.text()
    else if (input instanceof ArrayBuffer) text = new TextDecoder().decode(input)
    else text = new TextDecoder().decode(input)
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      this.failAll('CDP response exceeded the 50 MiB frame limit')
      return
    }
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch {
      this.failAll('CDP response contained malformed JSON')
      return
    }
    if (validateValue(MESSAGE_SCHEMA, value, 'CDP message')) {
      this.failAll('CDP response had a malformed envelope')
      return
    }
    const message = value as { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const event: CdpEvent = {
      method: message.method,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      params: message.params ?? {}
    }
    for (const listener of this.listeners.get(event.method) ?? []) listener(event)
  }

  private failAll(reason: string): void {
    if (!this.closed) {
      this.closed = true
      this.onClosed?.(reason)
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }
}

import {
  encodePtyData,
  encodePtyJson,
  parsePtyVersionRejection,
  PTY_PROTOCOL_MIN_VERSION,
  PTY_PROTOCOL_VERSION,
  PtyFrameDecoder,
  type PtyRequest,
  type PtyResponse,
  type PtyResults
} from '@quirky/protocol'
import { socketPath as resolveSocketPath } from '@quirky/protocol/node'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SocketWriter } from './writer'

type Pending = { resolve(value: unknown): void; reject(error: Error): void }
type RequestParams<K extends PtyRequest['type']> = Omit<Extract<PtyRequest, { type: K }>, 'id' | 'type'>

/** A minimal client for the PTY host socket, used to probe for a running host and by tests. */
export class PtyClient {
  closed = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly dataListeners = new Set<(sessionId: string, bytes: Uint8Array) => void>()
  private readonly eventListeners = new Set<(event: { type: string }) => void>()

  private constructor(
    private readonly socket: Bun.Socket<undefined>,
    private readonly writer: SocketWriter
  ) {}

  static async connect(socketPath: string): Promise<PtyClient> {
    const decoder = new PtyFrameDecoder()
    let client: PtyClient | undefined
    const socket = await Bun.connect<undefined>({
      unix: socketPath,
      socket: {
        data(_socket, chunk) {
          client?.receive(decoder, chunk)
        },
        drain() {
          client?.writer.drain()
        },
        close() {
          client?.markClosed()
        },
        error() {
          client?.markClosed()
        }
      }
    })
    client = new PtyClient(socket, new SocketWriter(socket))
    return client
  }

  hello(token: string): Promise<PtyResults['hello']> {
    return this.request('hello', {
      token,
      version: PTY_PROTOCOL_VERSION,
      minVersion: PTY_PROTOCOL_MIN_VERSION,
      sessionLagged: true
    })
  }

  request<K extends PtyRequest['type']>(type: K, params: RequestParams<K>): Promise<PtyResults[K]> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.writer.send(encodePtyJson({ id, type, ...params }))
    })
  }

  sendInput(sessionId: string, bytes: Uint8Array): void {
    if (!this.closed) this.writer.send(encodePtyData(sessionId, bytes))
  }

  onData(listener: (sessionId: string, bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onEvent(listener: (event: { type: string }) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  close(): void {
    this.socket.end()
    this.markClosed()
  }

  private receive(decoder: PtyFrameDecoder, chunk: Uint8Array): void {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind === 'data') {
        for (const listener of this.dataListeners) listener(frame.sessionId, frame.bytes)
        continue
      }
      const message = frame.message as PtyResponse | { type: string }
      if ('id' in message) {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new Error(message.error))
      } else {
        for (const listener of this.eventListeners) listener(message)
      }
    }
  }

  private markClosed(): void {
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('connection closed'))
    this.pending.clear()
  }
}

/**
 * `answers` means hello succeeds or is rejected for its version. `silent` means a connection is
 * accepted or pending without either answer, including a rejected token. `absent` means no socket
 * file or a refused connection.
 */
export async function probeHost(home: string, timeoutMs = 2000): Promise<'answers' | 'silent' | 'absent'> {
  const socketPath = resolveSocketPath(home, 'pty.sock')
  if (!existsSync(socketPath)) return 'absent'

  let token = ''
  try {
    token = readFileSync(join(home, 'pty.token'), 'utf8')
  } catch {}

  let client: PtyClient | undefined
  let finished = false
  const attempt = (async (): Promise<'answers' | 'silent' | 'absent'> => {
    try {
      client = await PtyClient.connect(socketPath)
    } catch (error) {
      return isConnectionRefused(error) ? 'absent' : 'silent'
    }

    if (finished) {
      client.close()
      return 'silent'
    }

    try {
      await client.hello(token)
      return 'answers'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return parsePtyVersionRejection(message) ? 'answers' : 'silent'
    }
  })()

  const { promise: timeout, resolve: timedOut } = Promise.withResolvers<'silent'>()
  const timer = setTimeout(() => timedOut('silent'), timeoutMs)
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    clearTimeout(timer)
    finished = true
    client?.close()
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = error.code
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTSOCK'
}

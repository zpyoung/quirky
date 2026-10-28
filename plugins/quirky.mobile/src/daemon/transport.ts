import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { candidatePorts, isLoopbackHost } from './network'

export const DEFAULT_MOBILE_PORT = 6768
export const MAX_MOBILE_WEBSOCKETS = 128
export const MAX_MOBILE_TCP_CONNECTIONS = 256
export const MAX_MOBILE_INBOUND_FRAME_BYTES = 1024 * 1024
export const MAX_MOBILE_OUTBOUND_BUFFERED_BYTES = 32 * 1024 * 1024
export const MAX_MOBILE_OUTBOUND_QUEUED_BYTES = 128 * 1024 * 1024
export const MAX_MOBILE_OUTBOUND_QUEUED_FRAMES = 16_384
export const MAX_MOBILE_OUTBOUND_SOURCES = 256
export const MOBILE_PING_INTERVAL_MS = 15_000
export const MOBILE_PONG_REAP_MS = 60_000

export type MobilePeer = {
  readonly id: number
  readonly socket: WebSocket
  sendText(text: string): boolean
  sendBinary(bytes: Uint8Array): boolean
  close(code?: number, reason?: string): void
  terminate(): void
}

export type MobileTransportOptions = {
  dataDir: string
  hasPairedHistory: boolean
  portValue?: string
  hostValue?: string
  preferredPort?: number
  onConnection(peer: MobilePeer): void
}

type QueueItem = { data: string | Uint8Array; binary: boolean; bytes: number; accounted: boolean; buffered: boolean }
type PeerState = { peer: MobilePeer; queue: QueueItem[]; closed: boolean; lastPongAt: number }
type Binding = { server: Server; sockets: WebSocketServer }

function writeFallback(path: string, port: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ port }), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    const directoryFd = openSync(dirname(path), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function readFallback(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'port' in raw && Number.isInteger(raw.port) && typeof raw.port === 'number' && raw.port > 0 && raw.port <= 65535) return raw.port
  } catch {}
  return undefined
}

function listen(server: Server, host: string, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onError = (error: Error) => {
    server.off('listening', onListening)
    reject(error)
  }
  const onListening = () => {
    server.off('error', onError)
    resolve()
  }
  server.once('error', onError)
  server.once('listening', onListening)
  server.listen({ host, port, exclusive: true })
  return promise
}

function rejectUpgrade(socket: Duplex, status: 404 | 503): void {
  if (socket.destroyed) return
  const label = status === 404 ? 'Not Found' : 'Service Unavailable'
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export class MobileTransport {
  private readonly fallbackPath: string
  private readonly explicitPort: boolean
  private readonly pinnedPort: boolean
  private readonly pinnedHost: boolean
  private readonly preferredPort: number
  private preferredHost: string
  private readonly states = new Map<WebSocket, PeerState>()
  private readonly queuedSources = new Set<number>()
  private binding: Binding | null = null
  private portValue: number | null = null
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private nextPeerId = 0
  private queuedBytes = 0
  private queuedFrames = 0
  private bufferedBytes = 0
  private stopped = false
  private rebinding: Promise<boolean> | null = null

  constructor(private readonly options: MobileTransportOptions) {
    this.fallbackPath = join(options.dataDir, 'mobile-ws-fallback-port.json')
    this.explicitPort = options.portValue !== undefined
    const parsedPort = options.portValue === undefined ? options.preferredPort ?? DEFAULT_MOBILE_PORT : Number(options.portValue)
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) throw new Error('Invalid QUIRKY_MOBILE_PORT')
    this.preferredPort = parsedPort
    this.pinnedPort = this.explicitPort && parsedPort > 0
    const hostValue = options.hostValue?.trim()
    this.pinnedHost = hostValue !== undefined && hostValue.length > 0
    if (this.pinnedHost && !isValidBindHost(hostValue!)) throw new Error('Invalid QUIRKY_MOBILE_HOST')
    this.preferredHost = this.pinnedHost ? hostValue! : options.hasPairedHistory ? '0.0.0.0' : '127.0.0.1'
  }

  get available(): boolean {
    return this.binding !== null && this.portValue !== null
  }

  get host(): string | null {
    return this.binding ? this.preferredHost : null
  }

  get port(): number | null {
    return this.available ? this.portValue : null
  }

  async start(): Promise<boolean> {
    if (this.binding || this.stopped) return this.available
    const saved = this.explicitPort ? undefined : readFallback(this.fallbackPath)
    const ports = candidatePorts(this.preferredPort, saved, this.pinnedPort)
    for (const port of ports) {
      try {
        await this.bind(this.preferredHost, port)
        const boundPort = this.boundPort()
        if (!boundPort) throw new Error('Mobile listener did not report a port')
        this.portValue = boundPort
        if (!this.explicitPort && boundPort !== this.preferredPort) writeFallback(this.fallbackPath, boundPort)
        this.startHeartbeat()
        return true
      } catch (error) {
        await this.closeBinding()
        if ((error as { code?: string }).code !== 'EADDRINUSE' || this.pinnedPort || port === 0) break
      }
    }
    return false
  }

  async ensureNetworkExposure(): Promise<boolean> {
    if (!this.available) return false
    if (this.preferredHost === '0.0.0.0' || this.preferredHost === '::') return true
    if (!isLoopbackHost(this.preferredHost)) return true
    if (this.pinnedHost) return false
    if (this.rebinding) return this.rebinding
    this.rebinding = this.rebind('0.0.0.0').finally(() => { this.rebinding = null })
    return this.rebinding
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const state of this.states.values()) this.closePeer(state, 1001, 'Mobile plugin deactivated', true)
    await this.closeBinding()
    this.portValue = null
    this.queuedBytes = 0
    this.queuedFrames = 0
    this.bufferedBytes = 0
    this.queuedSources.clear()
  }

  private async rebind(host: string): Promise<boolean> {
    const previousHost = this.preferredHost
    const port = this.portValue
    if (port === null) return false
    await this.closeBinding()
    try {
      await this.bind(host, port)
      this.replaceHost(host)
      const exposedPort = this.boundPort()
      if (exposedPort === null) throw new Error('Mobile listener did not report a port after widening')
      this.portValue = exposedPort
      return true
    } catch {
      await this.closeBinding()
      try {
        await this.bind(previousHost, port)
        this.replaceHost(previousHost)
        const restoredPort = this.boundPort()
        if (restoredPort === null) throw new Error('Mobile listener did not report its restored loopback port')
        this.portValue = restoredPort
      } catch {
        await this.closeBinding()
        this.portValue = null
      }
      return false
    }
  }

  private replaceHost(host: string): void {
    this.preferredHost = host
  }

  private async bind(host: string, port: number): Promise<void> {
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('Not found')
    })
    server.maxConnections = MAX_MOBILE_TCP_CONNECTIONS
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MOBILE_INBOUND_FRAME_BYTES, perMessageDeflate: false })
    server.on('upgrade', (request, socket, head) => {
      let pathname: string
      try { pathname = new URL(request.url ?? '/', 'http://mobile.invalid').pathname } catch { rejectUpgrade(socket, 404); return }
      if (request.method !== 'GET' || pathname !== '/rpc') {
        rejectUpgrade(socket, 404)
        return
      }
      if (sockets.clients.size >= MAX_MOBILE_WEBSOCKETS) {
        rejectUpgrade(socket, 503)
        return
      }
      sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit('connection', websocket, request))
    })
    sockets.on('connection', (socket) => this.attach(socket))
    try {
      await listen(server, host, port)
      this.binding = { server, sockets }
    } catch (error) {
      sockets.close()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      throw error
    }
  }

  private attach(socket: WebSocket): void {
    const id = ++this.nextPeerId
    const state: PeerState = { peer: undefined as unknown as MobilePeer, queue: [], closed: false, lastPongAt: Date.now() }
    const peer: MobilePeer = {
      id,
      socket,
      sendText: (text) => this.enqueue(state, text, false),
      sendBinary: (bytes) => this.enqueue(state, bytes, true),
      close: (code = 1000, reason = '') => this.closePeer(state, code, reason, false),
      terminate: () => this.closePeer(state, 1001, 'Connection closed', true)
    }
    state.peer = peer
    this.states.set(socket, state)
    socket.on('pong', () => { state.lastPongAt = Date.now() })
    socket.on('close', () => this.releasePeer(state))
    socket.on('error', () => this.releasePeer(state))
    socket.on('message', (data: WebSocket.RawData) => {
      const bytes = Array.isArray(data) ? data.reduce((size, part) => size + part.byteLength, 0) : data.byteLength
      if (bytes > MAX_MOBILE_INBOUND_FRAME_BYTES) this.closePeer(state, 1009, 'Inbound frame too large', false)
    })
    try {
      this.options.onConnection(peer)
    } catch {
      this.closePeer(state, 1011, 'Mobile transport unavailable', true)
    }
  }

  private enqueue(state: PeerState, data: string | Uint8Array, binary: boolean): boolean {
    if (state.closed || state.peer.socket.readyState !== WebSocket.OPEN) return false
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    const sourceIsNew = state.queue.length === 0
    if (this.queuedBytes + bytes > MAX_MOBILE_OUTBOUND_QUEUED_BYTES || this.queuedFrames + 1 > MAX_MOBILE_OUTBOUND_QUEUED_FRAMES ||
      (sourceIsNew && this.queuedSources.size >= MAX_MOBILE_OUTBOUND_SOURCES)) {
      this.closePeer(state, 1013, 'Outbound reply buffer overflow', false)
      return false
    }
    const item: QueueItem = { data, binary, bytes, accounted: true, buffered: false }
    state.queue.push(item)
    this.queuedBytes += bytes
    this.queuedFrames++
    if (sourceIsNew) this.queuedSources.add(state.peer.id)
    this.flush(state)
    return true
  }

  private flush(state: PeerState): void {
    const item = state.queue[0]
    if (!item || state.closed || state.peer.socket.readyState !== WebSocket.OPEN) return
    if (item.buffered) return
    if (this.bufferedBytes + item.bytes > MAX_MOBILE_OUTBOUND_BUFFERED_BYTES) {
      this.closePeer(state, 1013, 'Outbound reply buffer overflow', false)
      return
    }
    item.buffered = true
    this.bufferedBytes += item.bytes
    try {
      state.peer.socket.send(item.data, { binary: item.binary }, (error) => {
        this.releaseBuffered(item)
        this.releaseItem(item)
        if (state.queue[0] === item) state.queue.shift()
        if (state.queue.length === 0) this.queuedSources.delete(state.peer.id)
        if (error) this.closePeer(state, 1013, 'Outbound reply buffer overflow', false)
        else this.flush(state)
      })
    } catch {
      this.releaseBuffered(item)
      this.releaseItem(item)
      this.closePeer(state, 1013, 'Outbound reply buffer overflow', false)
    }
  }

  private releaseItem(item: QueueItem): void {
    if (!item.accounted) return
    item.accounted = false
    this.queuedBytes = Math.max(0, this.queuedBytes - item.bytes)
    this.queuedFrames = Math.max(0, this.queuedFrames - 1)
  }
  private releaseBuffered(item: QueueItem): void {
    if (!item.buffered) return
    item.buffered = false
    this.bufferedBytes = Math.max(0, this.bufferedBytes - item.bytes)
  }

  private closePeer(state: PeerState, code: number, reason: string, terminate: boolean): void {
    if (state.closed) return
    state.closed = true
    this.releaseQueue(state)
    try {
      if (terminate) state.peer.socket.terminate()
      else if (state.peer.socket.readyState === WebSocket.OPEN) state.peer.socket.close(code, reason.slice(0, 120))
    } catch {
      try { state.peer.socket.terminate() } catch {}
    }
    this.states.delete(state.peer.socket)
  }

  private releaseQueue(state: PeerState): void {
    for (const item of state.queue) {
      this.releaseBuffered(item)
      this.releaseItem(item)
    }
    state.queue.length = 0
    this.queuedSources.delete(state.peer.id)
  }

  private releasePeer(state: PeerState): void {
    if (!state.closed) {
      state.closed = true
      this.releaseQueue(state)
    }
    this.states.delete(state.peer.socket)
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      for (const state of this.states.values()) {
        if (state.closed) continue
        if (now - state.lastPongAt >= MOBILE_PONG_REAP_MS) {
          this.closePeer(state, 1001, 'Ping timeout', true)
          continue
        }
        try { state.peer.socket.ping() } catch { this.closePeer(state, 1001, 'Ping failed', true) }
      }
    }, MOBILE_PING_INTERVAL_MS)
    this.heartbeat.unref?.()
  }

  private boundPort(): number | null {
    const address = this.binding?.server.address()
    return address && typeof address !== 'string' ? address.port : null
  }

  private async closeBinding(): Promise<void> {
    const binding = this.binding
    if (!binding) return
    this.binding = null
    for (const state of [...this.states.values()]) this.closePeer(state, 1001, 'Mobile listener changed', true)
    try { binding.sockets.close() } catch {}
    await new Promise<void>((resolve) => {
      try {
        if (!binding.server.listening) {
          resolve()
          return
        }
        binding.server.close(() => resolve())
        binding.server.closeAllConnections()
      } catch { resolve() }
    })
  }
}

function isValidBindHost(host: string): boolean {
  return host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1' || host === '127.0.0.1' || /^[0-9a-f:.]+$/i.test(host)
}

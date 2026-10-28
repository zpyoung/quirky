import nacl from 'tweetnacl'
import type { MobileCallOptions, MobileConnectionState, MobileRpc } from './types'
import {
  createMobileE2EEV2Hello,
  decodeBase64,
  deriveMobileE2EEV2KeySchedule,
  encodeBase64,
  encodeMobileE2EEV2Transcript,
  framePayloadKind,
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame,
  validateMobileE2EEV2Handshake,
  type MobileE2EEV2Hello,
  type MobileE2EEV2KeySchedule,
  MAX_MOBILE_BINARY_BYTES,
  MAX_MOBILE_TEXT_BYTES,
  MOBILE_E2EE_V2_FRAME_OVERHEAD_BYTES
} from './crypto'

export type MobileSocket = {
  readyState: number
  binaryType?: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type MobileWebSocketConstructor = new (url: string) => MobileSocket
export type MobileRpcErrorKind = 'connection' | 'timeout' | 'auth-failed' | 'protocol' | 'closed' | 'remote' | 'params'
export class MobileRpcError extends Error {
  constructor(readonly kind: MobileRpcErrorKind, message: string, readonly code?: unknown, readonly data?: unknown) {
    super(message)
    this.name = 'MobileRpcError'
  }
}
export type MobileRpcClientOptions = {
  endpoint: string
  publicKeyB64: string
  token: string
  WebSocket?: MobileWebSocketConstructor
  randomBytes?: (length: number) => Uint8Array | Promise<Uint8Array>
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  signal?: AbortSignal
  onState?: (state: MobileConnectionState) => void
}
type MobileRpcClientOptionsWithoutToken = Omit<MobileRpcClientOptions, 'token'>

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
type PendingCall = { resolve(value: unknown): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> }
type E2EEAuth = { type: 'e2ee_auth'; v: 2; transcriptHashB64: string; deviceToken: string }
const DEFAULT_CONNECT_TIMEOUT_MS = 12_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// The daemon caps each inbound WebSocket frame at 1 MiB, including base64 and E2EE overhead.
const MAX_MOBILE_REQUEST_FRAME_BYTES = 1024 * 1024
const MAX_MOBILE_REQUEST_TEXT_BYTES = Math.floor(MAX_MOBILE_REQUEST_FRAME_BYTES / 4) * 3 - MOBILE_E2EE_V2_FRAME_OVERHEAD_BYTES
const FORBIDDEN_PARAM_KEYS: Record<string, true> = {
  deviceId: true, role: true, token: true, deviceToken: true, credential: true, credentials: true,
  caller: true, connection: true, client: true, clientId: true, scope: true
}
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function checkJsonTree(value: unknown, depth = 0): void {
  if (depth > 8) throw new MobileRpcError('params', 'RPC parameters are too deeply nested')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) throw new MobileRpcError('params', 'RPC parameter string is too large')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MobileRpcError('params', 'RPC numbers must be finite')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 2048) throw new MobileRpcError('params', 'RPC parameter array is too large')
    for (const item of value) checkJsonTree(item, depth + 1)
    return
  }
  if (!isPlainRecord(value) || Object.keys(value).length > 256) throw new MobileRpcError('params', 'RPC parameters must be plain JSON objects')
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(FORBIDDEN_PARAM_KEYS, key) && depth === 0) throw new MobileRpcError('params', 'RPC parameters cannot supply caller or credential identity')
    if (key.length > 256) throw new MobileRpcError('params', 'RPC parameter name is too large')
    checkJsonTree(item, depth + 1)
  }
}

function bytesFromMessage(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

function randomSource(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) throw new MobileRpcError('connection', 'Secure random generation is unavailable')
  return cryptoApi.getRandomValues(new Uint8Array(length))
}

export async function createMobileRpc(options: MobileRpcClientOptions): Promise<MobileRpc> {
  if (options.signal?.aborted) throw new MobileRpcError('closed', 'Pairing was cancelled')
  const { token, ...clientOptions } = options
  const Client = options.WebSocket ?? (globalThis.WebSocket as unknown as MobileWebSocketConstructor | undefined)
  if (!Client) throw new MobileRpcError('connection', 'WebSocket transport is unavailable')
  if (!/^[0-9a-f]{48}$/.test(token)) throw new MobileRpcError('auth-failed', 'Stored pairing credential is invalid')
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const getRandomBytes = options.randomBytes ?? randomSource
  const clientSecret = await getRandomBytes(32)
  let clientNonce: Uint8Array | undefined
  let clientKeys: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined
  try {
    if (clientSecret.length !== 32) throw new MobileRpcError('connection', 'Secure random generation returned invalid data')
    clientNonce = await getRandomBytes(32)
    if (clientNonce.length !== 32) throw new MobileRpcError('connection', 'Secure random generation returned invalid data')
    if (options.signal?.aborted) throw new MobileRpcError('closed', 'Pairing was cancelled')
    clientKeys = naclBoxKeyPair(clientSecret)
    const hello = createMobileE2EEV2Hello(clientKeys.publicKey, clientNonce)
    const client = new MobileRpcClient(clientOptions, token, Client, requestTimeoutMs)
    try {
      await client.connect(hello, clientKeys.secretKey, connectTimeoutMs, handshakeTimeoutMs)
      return client
    } catch (error) {
      client.close()
      throw error
    }
  } finally {
    clientSecret.fill(0)
    clientNonce?.fill(0)
    clientKeys?.secretKey.fill(0)
  }
}

function naclBoxKeyPair(secretKey: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair.fromSecretKey(secretKey)
}

class MobileRpcClient implements MobileRpc {
  private socket: MobileSocket | null = null
  private schedule: MobileE2EEV2KeySchedule | null = null
  private outboundCounter = 0n
  private inboundCounter = 0n
  private nextId = 1
  private currentState: MobileConnectionState = { phase: 'connecting', attempts: 0, message: 'Connecting securely' }
  private authenticated = false
  private pairingProofAccepted = false
  private stopped = false
  private terminalError: MobileRpcError | null = null
  private closeRequested = false
  private readonly pending = new Map<number, PendingCall>()
  private readonly eventHandlers = new Set<(event: { event: string; data: unknown }) => void>()
  private readonly streamHandlers = new Map<number, Set<(bytes: Uint8Array) => void>>()
  private readonly stateHandlers = new Set<(state: MobileConnectionState) => void>()
  private readonly aborted: Deferred<never> = deferred<never>()
  private messageQueue: Promise<void> = Promise.resolve()
  private pairingProof: Deferred<void> | null = null
  private readyGate: Deferred<void> | null = null
  private signalAbort: (() => void) | null = null
  private livenessTimer: ReturnType<typeof setTimeout> | undefined
  private lastActivityAt = Date.now()
  private helloForValidation: MobileE2EEV2Hello | null = null
  private clientSecretForValidation: Uint8Array | null = null

  constructor(
    private readonly options: MobileRpcClientOptionsWithoutToken,
    private credentialToken: string,
    private readonly WebSocket: MobileWebSocketConstructor,
    private readonly requestTimeoutMs: number
  ) {}

  get state(): MobileConnectionState {
    return this.currentState
  }

  async connect(
    hello: MobileE2EEV2Hello,
    clientSecret: Uint8Array,
    connectTimeoutMs: number,
    handshakeTimeoutMs: number
  ): Promise<void> {
    if (this.options.signal?.aborted) throw new MobileRpcError('closed', 'Pairing was cancelled')
    this.helloForValidation = hello
    this.clientSecretForValidation = clientSecret
    const endpoint = new URL('/rpc', this.options.endpoint)
    const socket = new this.WebSocket(endpoint.toString())
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    const opened = deferred<void>()
    const readyGate = this.readyGate = deferred<void>()
    const pairingProof = this.pairingProof = deferred<void>()
    const handshake = Promise.all([readyGate.promise, pairingProof.promise])
    const timeoutError = new MobileRpcError('timeout', 'Desktop connection timed out')
    const openTimer = setTimeout(() => opened.reject(timeoutError), connectTimeoutMs)
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    socket.onopen = () => {
      clearTimeout(openTimer)
      opened.resolve()
    }
    socket.onerror = () => {
      const error = new MobileRpcError('connection', 'Desktop connection failed')
      opened.reject(error)
      readyGate.reject(error)
      pairingProof.reject(error)
    }
    socket.onclose = (event) => this.handleSocketClose(event.code ?? 1006)
    socket.onmessage = (event) => {
      this.messageQueue = this.messageQueue.then(() => this.processMessage(event.data)).catch((error: unknown) => {
        const failure = error instanceof MobileRpcError ? error : new MobileRpcError('protocol', 'Encrypted desktop message is invalid')
        this.fail(failure, failure.kind === 'connection' ? 'unreachable' : 'auth-failed')
      })
    }
    if (this.options.signal) {
      this.signalAbort = () => {
        const error = new MobileRpcError('closed', 'Pairing was cancelled')
        opened.reject(error)
        readyGate.reject(error)
        pairingProof.reject(error)
        this.fail(error, 'disconnected')
      }
      if (this.options.signal.aborted) this.signalAbort()
      else this.options.signal.addEventListener('abort', this.signalAbort, { once: true })
    }
    try {
      await Promise.race([opened.promise, handshake, this.aborted.promise])
      if (this.stopped) throw new MobileRpcError('closed', 'Connection closed')
      handshakeTimer = setTimeout(() => {
        const error = new MobileRpcError('timeout', 'Encrypted pairing handshake timed out')
        readyGate.reject(error)
        pairingProof.reject(error)
      }, handshakeTimeoutMs)
      socket.send(JSON.stringify(hello))
      await Promise.race([handshake, this.aborted.promise])
      if (this.stopped) throw this.terminalError ?? new MobileRpcError('closed', 'Connection closed during authentication')
      this.authenticated = true
      this.setState({ phase: 'connected', attempts: 0, connectedAt: Date.now(), message: 'Encrypted direct connection' })
      this.touchActivity()
    } catch (error) {
      this.fail(error instanceof MobileRpcError ? error : new MobileRpcError('connection', 'Desktop connection failed'), 'unreachable')
      throw error
    } finally {
      clearTimeout(openTimer)
      if (handshakeTimer !== undefined) {
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
      if (this.options.signal && this.signalAbort) this.options.signal.removeEventListener('abort', this.signalAbort)
      this.signalAbort = null
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, callOptions: MobileCallOptions = {}): Promise<T> {
    if (!this.authenticated || this.stopped || !this.socket || this.socket.readyState !== 1) return Promise.reject(new MobileRpcError('closed', 'Desktop is not connected'))
    if (typeof method !== 'string' || method.length === 0 || method.length > 160 || !/^[A-Za-z0-9_.$/-]+$/.test(method)) return Promise.reject(new MobileRpcError('params', 'RPC method name is invalid'))
    if (!isPlainRecord(params)) return Promise.reject(new MobileRpcError('params', 'RPC parameters must be a plain object'))
    try { checkJsonTree(params) } catch (error) { return Promise.reject(error) }
    if (callOptions.requestId !== undefined && (typeof callOptions.requestId !== 'string' || callOptions.requestId.length > 128)) return Promise.reject(new MobileRpcError('params', 'RPC requestId is invalid'))
    const timeoutMs = callOptions.timeoutMs ?? this.requestTimeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) return Promise.reject(new MobileRpcError('params', 'RPC timeout is invalid'))
    const id = this.allocateId()
    const envelope = { jsonrpc: '2.0', id, method, params, ...(callOptions.requestId !== undefined ? { requestId: callOptions.requestId } : {}) }
    const text = JSON.stringify(envelope)
    if (text.includes(this.credentialToken)) return Promise.reject(new MobileRpcError('params', 'RPC payload cannot contain pairing credential material'))
    const payload = encoder.encode(text)
    if (payload.length > MAX_MOBILE_REQUEST_TEXT_BYTES) {
      payload.fill(0)
      return Promise.reject(new MobileRpcError('params', 'RPC request exceeds the direct transport frame limit'))
    }
    const response = deferred<unknown>()
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return
      response.reject(new MobileRpcError('timeout', `RPC request timed out: ${method}`))
    }, timeoutMs)
    this.pending.set(id, { resolve: response.resolve, reject: response.reject, timer })
    try {
      this.sendEncryptedPayload(payload)
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      response.reject(error)
    }
    return response.promise as Promise<T>
  }

  onEvent(handler: (event: { event: string; data: unknown }) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onStream(streamId: number, handler: (bytes: Uint8Array) => void): () => void {
    if (!Number.isSafeInteger(streamId) || streamId < 0) throw new Error('streamId must be a nonnegative safe integer')
    let handlers = this.streamHandlers.get(streamId)
    if (!handlers) this.streamHandlers.set(streamId, handlers = new Set())
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
      if (handlers!.size === 0) this.streamHandlers.delete(streamId)
    }
  }

  onState(handler: (state: MobileConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    try { handler(this.currentState) } catch { /* State observers do not own the transport. */ }
    return () => this.stateHandlers.delete(handler)
  }

  close(): void {
    if (this.stopped) return
    this.closeRequested = true
    this.finish(new MobileRpcError('closed', 'Connection closed'), 'disconnected')
    this.socket?.close(1000, 'Phone disconnected')
  }

  private allocateId(): number {
    while (this.pending.has(this.nextId) || !Number.isSafeInteger(this.nextId)) this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1
    return this.nextId++
  }

  private async processMessage(data: unknown): Promise<void> {
    if (this.stopped) return
    if (typeof data === 'string') {
      if (!this.schedule) {
        this.acceptReady(data)
        return
      }
      if (data.length > Math.ceil((MAX_MOBILE_TEXT_BYTES + 82) / 3) * 4) throw new MobileRpcError('protocol', 'Encrypted text frame is too large')
      const frame = decodeBase64(data)
      if (frame.length > MAX_MOBILE_TEXT_BYTES + 82) throw new MobileRpcError('protocol', 'Encrypted text frame is too large')
      const kind = framePayloadKind(frame)
      if (kind !== 'text') throw new MobileRpcError('protocol', 'Unexpected encrypted text frame kind')
      const plaintext = openMobileE2EEV2Frame({
        frame, key: this.schedule.desktopToMobileKey, sessionId: this.schedule.sessionId,
        direction: 'desktop-to-mobile', payloadKind: 'text', expectedCounter: this.inboundCounter
      })
      if (!plaintext) throw new MobileRpcError('protocol', 'Encrypted text frame authentication failed')
      this.inboundCounter++
      this.touchActivity()
      try { this.acceptText(decoder.decode(plaintext)) } finally { plaintext.fill(0) }
      return
    }
    const binaryData = typeof Blob !== 'undefined' && data instanceof Blob ? await data.arrayBuffer() : data
    const frame = bytesFromMessage(binaryData)
    if (!frame || !this.schedule || frame.length > MAX_MOBILE_BINARY_BYTES + 82 || framePayloadKind(frame) !== 'binary') throw new MobileRpcError('protocol', 'Unexpected encrypted binary frame')
    if (!this.pairingProofAccepted) throw new MobileRpcError('protocol', 'Desktop sent binary data before authenticated proof')
    const plaintext = openMobileE2EEV2Frame({
      frame, key: this.schedule.desktopToMobileKey, sessionId: this.schedule.sessionId,
      direction: 'desktop-to-mobile', payloadKind: 'binary', expectedCounter: this.inboundCounter
    })
    if (!plaintext) throw new MobileRpcError('protocol', 'Encrypted binary frame authentication failed')
    this.inboundCounter++
    this.touchActivity()
    this.acceptBinary(plaintext)
  }

  private acceptReady(text: string): void {
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch { throw new MobileRpcError('auth-failed', 'Desktop sent an invalid encrypted handshake') }
    const hello = this.helloForValidation
    const secret = this.clientSecretForValidation
    if (!hello || !secret) throw new MobileRpcError('protocol', 'Pairing state was lost')
    const handshake = validateMobileE2EEV2Handshake(hello, value, { transport: 'direct' }, this.options.publicKeyB64)
    if (!handshake) throw new MobileRpcError('auth-failed', 'Desktop identity or protocol did not match the paired key')
    const rawPoint = nacl.scalarMult(secret, handshake.desktopPublicKey)
    if (rawPoint.every((byte) => byte === 0)) {
      rawPoint.fill(0)
      throw new MobileRpcError('auth-failed', 'Desktop presented an invalid public key')
    }
    const sharedSecret = nacl.box.before(handshake.desktopPublicKey, secret)
    if (sharedSecret.length !== 32 || sharedSecret.every((byte) => byte === 0)) {
      rawPoint.fill(0)
      sharedSecret.fill(0)
      throw new MobileRpcError('auth-failed', 'Desktop presented an invalid public key')
    }
    let schedule: MobileE2EEV2KeySchedule
    try {
      schedule = deriveMobileE2EEV2KeySchedule({
        sharedSecret,
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      })
    } finally {
      rawPoint.fill(0)
      sharedSecret.fill(0)
    }
    this.schedule = schedule
    secret.fill(0)
    this.clientSecretForValidation = null
    this.helloForValidation = null
    const auth: E2EEAuth = { type: 'e2ee_auth', v: 2, transcriptHashB64: encodeBase64(schedule.transcriptHash), deviceToken: this.credentialToken }
    this.sendEncryptedText(JSON.stringify(auth))
    this.readyGate?.resolve()
  }

  private acceptText(text: string): void {
    let value: unknown
    try { value = JSON.parse(text) as unknown } catch { throw new MobileRpcError('protocol', 'Desktop sent invalid encrypted JSON') }
    if (!isRecord(value)) throw new MobileRpcError('protocol', 'Desktop sent an invalid encrypted message')
    if (value.type === 'e2ee_authenticated') {
      if (this.pairingProofAccepted) throw new MobileRpcError('protocol', 'Desktop sent a duplicate authenticated proof')
      const schedule = this.schedule
      const proof = this.pairingProof
      if (!schedule || !proof) throw new MobileRpcError('protocol', 'Authenticated proof arrived outside pairing')
      if (!exactKeys(value, ['type', 'v', 'transcriptHashB64']) || value.v !== 2 ||
        typeof value.transcriptHashB64 !== 'string' || value.transcriptHashB64 !== encodeBase64(schedule.transcriptHash)) {
        throw new MobileRpcError('auth-failed', 'Desktop authenticated proof did not match the encrypted session')
      }
      this.pairingProofAccepted = true
      proof.resolve()
      return
    }
    if (value.type === 'e2ee_error') {
      if (this.pairingProofAccepted) throw new MobileRpcError('protocol', 'Desktop sent a late authentication error')
      if (!exactKeys(value, ['type', 'error']) || !isRecord(value.error) ||
        !exactKeys(value.error, ['code']) || typeof value.error.code !== 'string') {
        throw new MobileRpcError('protocol', 'Desktop sent an invalid encrypted authentication error')
      }
      if (value.error.code === 'registry_unavailable') {
        throw new MobileRpcError('connection', 'Desktop device registry is temporarily unavailable', value.error.code)
      }
      if (value.error.code === 'unauthorized' || value.error.code === 'bad_proof') {
        throw new MobileRpcError('auth-failed', 'Desktop rejected the pairing credential', value.error.code)
      }
      throw new MobileRpcError('protocol', 'Desktop sent an unknown encrypted authentication error')
    }
    if (!this.pairingProofAccepted) throw new MobileRpcError('protocol', 'Desktop sent an RPC message before authenticated proof')
    if (value.jsonrpc !== '2.0') throw new MobileRpcError('protocol', 'Desktop sent an invalid JSON-RPC message')
    if (Object.hasOwn(value, 'method')) {
      if (!exactKeys(value, ['jsonrpc', 'method', 'params']) || value.method !== 'event' ||
        !isRecord(value.params) || typeof value.params.type !== 'string' || value.params.type.length === 0) {
        throw new MobileRpcError('protocol', 'Desktop sent an invalid JSON-RPC notification')
      }
      const event = { event: value.params.type, data: value.params }
      for (const handler of this.eventHandlers) {
        try { handler(event) } catch { /* Consumer callbacks do not own the transport. */ }
      }
      return
    }
    if (!Number.isSafeInteger(value.id)) throw new MobileRpcError('protocol', 'Desktop sent an invalid JSON-RPC response id')
    const success = exactKeys(value, ['jsonrpc', 'id', 'result'])
    const failure = exactKeys(value, ['jsonrpc', 'id', 'error'])
    if (!success && !failure) throw new MobileRpcError('protocol', 'Desktop sent an invalid JSON-RPC response')
    let remoteError: Record<string, unknown> | undefined
    if (failure) {
      const candidate = value.error
      if (!isRecord(candidate) ||
        !(exactKeys(candidate, ['code', 'message']) || exactKeys(candidate, ['code', 'message', 'data'])) ||
        !Number.isSafeInteger(candidate.code) || typeof candidate.message !== 'string') {
        throw new MobileRpcError('protocol', 'Desktop sent an invalid JSON-RPC error')
      }
      remoteError = candidate
    }
    const pending = this.pending.get(value.id as number)
    if (!pending) return
    this.pending.delete(value.id as number)
    clearTimeout(pending.timer)
    if (remoteError) {
      const message = remoteError.message as string
      const data = remoteError.data
      const safeData = data !== undefined && JSON.stringify(data).includes(this.credentialToken) ? undefined : data
      pending.reject(new MobileRpcError('remote', message.includes(this.credentialToken) ? 'Desktop RPC failed' : message, remoteError.code, safeData))
    } else {
      pending.resolve(value.result)
    }
  }

  private acceptBinary(frame: Uint8Array): void {
    if (frame.length < 5 || frame[0] !== 1) throw new MobileRpcError('protocol', 'Desktop sent an unknown binary stream frame')
    const streamId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
    const handlers = this.streamHandlers.get(streamId)
    if (!handlers?.size) return
    const data = frame.subarray(5)
    for (const handler of handlers) {
      try { handler(data) } catch { /* Consumer callbacks do not own the transport. */ }
    }
  }

  private sendEncryptedText(text: string): void {
    this.sendEncryptedPayload(encoder.encode(text))
  }

  private sendEncryptedPayload(payload: Uint8Array): void {
    try {
      const schedule = this.schedule
      const socket = this.socket
      if (!schedule || !socket || socket.readyState !== 1) throw new MobileRpcError('closed', 'Desktop is not connected')
      if (payload.length > MAX_MOBILE_TEXT_BYTES) throw new MobileRpcError('params', 'Encrypted text frame is too large')
      const frame = sealMobileE2EEV2Frame({
        payload, key: schedule.mobileToDesktopKey, sessionId: schedule.sessionId,
        direction: 'mobile-to-desktop', payloadKind: 'text', counter: this.outboundCounter
      })
      this.outboundCounter++
      let encryptedText: string
      try { encryptedText = encodeBase64(frame) } finally { frame.fill(0) }
      try {
        socket.send(encryptedText)
      } catch {
        const error = new MobileRpcError('connection', 'Encrypted request could not be sent')
        this.fail(error, 'unreachable')
        throw error
      }
      this.touchActivity()
    } finally {
      payload.fill(0)
    }
  }

  private touchActivity(): void {
    this.lastActivityAt = Date.now()
    this.scheduleLiveness()
  }

  private scheduleLiveness(): void {
    if (!this.authenticated || this.stopped) return
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer)
    const idleMs = Math.max(0, 20_000 - (Date.now() - this.lastActivityAt))
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = undefined
      void this.call('status.get', {}, { timeoutMs: 8_000 }).catch(() => {
        if (!this.stopped) this.fail(new MobileRpcError('timeout', 'Desktop did not respond to a liveness probe'), 'unreachable')
      })
    }, idleMs)
  }
  private setState(state: MobileConnectionState): void {
    this.currentState = state
    this.options.onState?.(state)
    for (const handler of this.stateHandlers) {
      try { handler(state) } catch { /* State observers do not own the transport. */ }
    }
  }

  private handleSocketClose(code: number): void {
    if (this.stopped) return
    const state = this.closeRequested ? 'disconnected' : code === 4001 ? 'auth-failed' : 'unreachable'
    const message = this.closeRequested ? 'Disconnected' : code === 4001 ? 'Pairing invalid; pair this desktop again' : 'Desktop connection was interrupted'
    this.finish(new MobileRpcError(state === 'auth-failed' ? 'auth-failed' : 'closed', message, code), state)
  }

  private fail(error: MobileRpcError, phase: MobileConnectionState['phase']): void {
    this.finish(error, phase)
    this.socket?.close(phase === 'auth-failed' ? 4001 : 1000, phase === 'auth-failed' ? 'Unauthorized' : 'Phone disconnected')
  }

  private finish(error: MobileRpcError, phase: MobileConnectionState['phase']): void {
    if (this.stopped) return
    this.stopped = true
    this.terminalError = error
    this.credentialToken = ''
    if (this.livenessTimer !== undefined) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = undefined
    }
    this.aborted.reject(error)
    this.readyGate?.reject(error)
    this.pairingProof?.reject(error)
    this.schedule?.mobileToDesktopKey.fill(0)
    this.schedule?.desktopToMobileKey.fill(0)
    this.schedule?.sessionId.fill(0)
    this.schedule = null
    this.authenticated = false
    this.setState({ phase, attempts: this.currentState.attempts, message: error.message })
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.eventHandlers.clear()
    this.streamHandlers.clear()
    this.stateHandlers.clear()
    this.socket && (this.socket.onopen = this.socket.onmessage = this.socket.onerror = this.socket.onclose = null)
    if (this.options.signal && this.signalAbort) this.options.signal.removeEventListener('abort', this.signalAbort)
    this.signalAbort = null
  }
}

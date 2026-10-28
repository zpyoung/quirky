import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import WebSocket from 'ws'

type Context = {
  protocol: 'orca-mobile-e2ee'
  initiator: 'mobile'
  responder: 'desktop'
  transport: 'direct'
}

type Hello = {
  type: 'e2ee_hello'
  v: 2
  clientPublicKeyB64: string
  clientNonceB64: string
  capabilities: { framing: [2]; payloadKinds: ['text', 'binary'] }
  context: Context
}

type Ready = {
  type: 'e2ee_ready'
  v: 2
  desktopPublicKeyB64: string
  clientNonceB64: string
  desktopNonceB64: string
  selection: { framing: 2; payloadKinds: ['text', 'binary'] }
  context: Context
}

type SessionSchedule = {
  mobileToDesktop: Uint8Array
  desktopToMobile: Uint8Array
  sessionId: Uint8Array
  transcriptHashB64: string
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }

const deferred = <T>(): Deferred<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function unb64(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== 44 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === length && bytes.toString('base64') === value ? new Uint8Array(bytes) : null
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function encodeField(name: string, value: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const lengths = new Uint8Array(8)
  new DataView(lengths.buffer).setUint32(0, nameBytes.length)
  new DataView(lengths.buffer).setUint32(4, value.length)
  const result = new Uint8Array(8 + nameBytes.length + value.length)
  result.set(lengths.subarray(0, 4), 0)
  result.set(nameBytes, 4)
  result.set(lengths.subarray(4, 8), 4 + nameBytes.length)
  result.set(value, 8 + nameBytes.length)
  return result
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function list(values: readonly string[] | readonly number[]): Uint8Array {
  const parts = [uint32(values.length)]
  for (const value of values) {
    if (typeof value === 'number') parts.push(uint32(value))
    else parts.push(uint32(new TextEncoder().encode(value).length), new TextEncoder().encode(value))
  }
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

function transcript(hello: Hello, ready: Ready, clientPublicKey: Uint8Array, desktopPublicKey: Uint8Array, clientNonce: Uint8Array, desktopNonce: Uint8Array): Uint8Array {
  const fields: [string, Uint8Array][] = [
    ['domain', new TextEncoder().encode('orca-mobile-e2ee/v2/transcript')],
    ['mobile-to-desktop.type', new TextEncoder().encode(hello.type)],
    ['mobile-to-desktop.version', uint32(hello.v)],
    ['mobile-to-desktop.client-public-key', clientPublicKey],
    ['mobile-to-desktop.client-nonce', clientNonce],
    ['mobile-to-desktop.capabilities.framing', list(hello.capabilities.framing)],
    ['mobile-to-desktop.capabilities.payload-kinds', list(hello.capabilities.payloadKinds)],
    ['mobile-to-desktop.context.protocol', new TextEncoder().encode(hello.context.protocol)],
    ['mobile-to-desktop.context.initiator', new TextEncoder().encode(hello.context.initiator)],
    ['mobile-to-desktop.context.responder', new TextEncoder().encode(hello.context.responder)],
    ['mobile-to-desktop.context.transport', new TextEncoder().encode(hello.context.transport)],
    ['mobile-to-desktop.context.relay-host-id', new TextEncoder().encode('')],
    ['desktop-to-mobile.type', new TextEncoder().encode(ready.type)],
    ['desktop-to-mobile.version', uint32(ready.v)],
    ['desktop-to-mobile.desktop-public-key', desktopPublicKey],
    ['desktop-to-mobile.client-nonce-echo', clientNonce],
    ['desktop-to-mobile.desktop-nonce', desktopNonce],
    ['desktop-to-mobile.selection.framing', uint32(ready.selection.framing)],
    ['desktop-to-mobile.selection.payload-kinds', list(ready.selection.payloadKinds)],
    ['desktop-to-mobile.context.protocol', new TextEncoder().encode(ready.context.protocol)],
    ['desktop-to-mobile.context.initiator', new TextEncoder().encode(ready.context.initiator)],
    ['desktop-to-mobile.context.responder', new TextEncoder().encode(ready.context.responder)],
    ['desktop-to-mobile.context.transport', new TextEncoder().encode(ready.context.transport)],
    ['desktop-to-mobile.context.relay-host-id', new TextEncoder().encode('')]
  ]
  const encoded = fields.map(([name, value]) => encodeField(name, value))
  const result = new Uint8Array(encoded.reduce((sum, field) => sum + field.length, 0))
  let offset = 0
  for (const field of encoded) { result.set(field, offset); offset += field.length }
  return result
}

function nonce(sessionId: Uint8Array, direction: 0 | 1, kind: 0 | 1, counter: bigint): Uint8Array {
  const value = new Uint8Array(24)
  value.set(sessionId.subarray(0, 12))
  value[12] = 2
  value[13] = direction
  value[14] = kind
  new DataView(value.buffer).setBigUint64(16, counter)
  return value
}

function header(sessionId: Uint8Array, direction: 0 | 1, kind: 0 | 1, counter: bigint): Uint8Array {
  const value = new Uint8Array(42)
  value.set(sessionId)
  value[32] = direction
  value[33] = kind
  new DataView(value.buffer).setBigUint64(34, counter)
  return value
}

function seal(payload: Uint8Array, key: Uint8Array, sessionId: Uint8Array, direction: 0 | 1, kind: 0 | 1, counter: bigint): Uint8Array {
  const iv = nonce(sessionId, direction, kind, counter)
  const plaintext = new Uint8Array(42 + payload.length)
  plaintext.set(header(sessionId, direction, kind, counter))
  plaintext.set(payload, 42)
  const ciphertext = nacl.secretbox(plaintext, iv, key)
  const frame = new Uint8Array(iv.length + ciphertext.length)
  frame.set(iv)
  frame.set(ciphertext, iv.length)
  return frame
}

function open(frame: Uint8Array, key: Uint8Array, sessionId: Uint8Array, direction: 0 | 1, kind: 0 | 1, counter: bigint): Uint8Array | null {
  if (frame.length < 24 + nacl.secretbox.overheadLength + 42) return null
  const iv = nonce(sessionId, direction, kind, counter)
  if (!equal(frame.subarray(0, 24), iv)) return null
  const decrypted = nacl.secretbox.open(frame.subarray(24), iv, key)
  if (!decrypted || decrypted.length < 42 || !equal(decrypted.subarray(0, 42), header(sessionId, direction, kind, counter))) return null
  return decrypted.slice(42)
}

/** Independent direct mobile peer for live WebSocket and framing tests. */
export class MobileTestClient {
  readonly hello: Hello
  readonly socket: WebSocket
  readonly authenticated: Promise<void>
  readonly readyForAuthentication: Promise<void>
  readonly binaryFrames: Uint8Array[] = []
  private readonly ready = deferred<void>()
  private readonly handshakeReady = deferred<void>()
  private readonly keyPair = nacl.box.keyPair()
  private schedule?: SessionSchedule
  private inboundCounter = 0n
  private outboundCounter = 0n
  private nextId = 1
  private readonly pending = new Map<number, Deferred<unknown>>()

  private constructor(url: string, pinnedPublicKeyB64: string, token: string, autoAuthenticate: boolean) {
    const clientNonce = new Uint8Array(randomBytes(32))
    this.hello = {
      type: 'e2ee_hello', v: 2,
      clientPublicKeyB64: b64(this.keyPair.publicKey),
      clientNonceB64: b64(clientNonce),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
    }
    this.socket = new WebSocket(new URL('/rpc', url).toString(), { maxPayload: 16 * 1024 * 1024 })
    this.authenticated = this.ready.promise
    void this.authenticated.catch(() => {})
    this.readyForAuthentication = this.handshakeReady.promise
    void this.readyForAuthentication.catch(() => {})
    this.socket.on('open', () => this.socket.send(JSON.stringify(this.hello)))
    this.socket.on('message', (data, isBinary) => {
      let frame: Uint8Array
      if (Buffer.isBuffer(data)) frame = new Uint8Array(data)
      else if (data instanceof ArrayBuffer) frame = new Uint8Array(data)
      else frame = new Uint8Array(Buffer.concat(data))
      if (isBinary) {
        const plaintext = this.openBinary(frame)
        if (plaintext) this.binaryFrames.push(plaintext)
        return
      }
      const raw = Buffer.from(frame).toString('utf8')
      if (!this.schedule) {
        let ready: unknown
        try { ready = JSON.parse(raw) as unknown } catch {
          const error = new Error('invalid ready JSON')
          this.ready.reject(error)
          this.handshakeReady.reject(error)
          return
        }
        const schedule = this.acceptReady(ready, pinnedPublicKeyB64)
        if (!schedule) {
          const error = new Error('invalid E2EE ready')
          this.ready.reject(error)
          this.handshakeReady.reject(error)
          return
        }
        this.schedule = schedule
        this.handshakeReady.resolve()
        if (autoAuthenticate) this.sendText(JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64: schedule.transcriptHashB64, deviceToken: token }))
        return
      }
      const plaintext = this.openText(raw)
      if (plaintext === null) return
      let parsed: unknown
      try { parsed = JSON.parse(plaintext) as unknown } catch { return }
      if (!isRecord(parsed)) return
      if (parsed.type === 'e2ee_authenticated') {
        if (parsed.v === 2 && parsed.transcriptHashB64 === this.schedule.transcriptHashB64) this.ready.resolve()
        else this.ready.reject(new Error('invalid authenticated transcript'))
        return
      }
      if (parsed.type === 'e2ee_error') {
        const detail = isRecord(parsed.error) ? parsed.error.code : 'unknown'
        this.ready.reject(new Error(`authentication failed: ${String(detail)}`))
        return
      }
      if (typeof parsed.id === 'number') {
        const pending = this.pending.get(parsed.id)
        if (!pending) return
        this.pending.delete(parsed.id)
        if (isRecord(parsed.error)) pending.reject(Object.assign(new Error(String(parsed.error.message)), { code: parsed.error.code }))
        else pending.resolve(parsed.result)
      }
    })
    this.socket.on('error', (error) => {
      this.ready.reject(error)
      this.handshakeReady.reject(error)
    })
    this.socket.on('close', (code, reason) => {
      const error = new Error(`mobile socket closed ${code}: ${reason.toString()}`)
      this.ready.reject(error)
      this.handshakeReady.reject(error)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  static connect(url: string, pinnedPublicKeyB64: string, token: string): MobileTestClient {
    return new MobileTestClient(url, pinnedPublicKeyB64, token, true)
  }

  static connectWithoutAuthentication(url: string, pinnedPublicKeyB64: string): MobileTestClient {
    return new MobileTestClient(url, pinnedPublicKeyB64, '', false)
  }

  async call(method: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<unknown> {
    await this.authenticated
    const id = this.nextId++
    const response = deferred<unknown>()
    this.pending.set(id, response)
    this.sendText(JSON.stringify({ jsonrpc: '2.0', id, method, params, ...extra }))
    return response.promise
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.socket.once('close', resolve)
    this.socket.close()
    return promise
  }
  sendPlaintext(text: string): void {
    this.socket.send(text)
  }
  sendAuthenticationFrames(token: string, count: number): void {
    if (!this.schedule) throw new Error('not ready')
    const authentication = JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64: this.schedule.transcriptHashB64, deviceToken: token })
    for (let index = 0; index < count; index++) this.sendText(authentication)
  }


  sendCorruptTextFrame(text = 'corrupt frame'): void {
    if (!this.schedule) throw new Error('not ready')
    const frame = seal(new TextEncoder().encode(text), this.schedule.mobileToDesktop, this.schedule.sessionId, 0, 0, this.outboundCounter)
    frame[frame.length - 1] ^= 1
    this.socket.send(b64(frame))
  }

  sendBinary(bytes: Uint8Array): void {
    if (!this.schedule) throw new Error('not ready')
    const frame = seal(bytes, this.schedule.mobileToDesktop, this.schedule.sessionId, 0, 1, this.outboundCounter++)
    this.socket.send(frame, { binary: true })
  }


  private acceptReady(value: unknown, pinnedPublicKeyB64: string): SessionSchedule | null {
    if (!exact(value, ['type', 'v', 'desktopPublicKeyB64', 'clientNonceB64', 'desktopNonceB64', 'selection', 'context'])) return null
    const ready = value as Ready
    const hello = this.hello
    if (ready.type !== 'e2ee_ready' || ready.v !== 2 || ready.clientNonceB64 !== hello.clientNonceB64) return null
    if (!exact(ready.selection, ['framing', 'payloadKinds']) || ready.selection.framing !== 2 || JSON.stringify(ready.selection.payloadKinds) !== '["text","binary"]') return null
    if (!exact(ready.context, ['protocol', 'initiator', 'responder', 'transport']) || JSON.stringify(ready.context) !== JSON.stringify(hello.context)) return null
    const pinned = unb64(pinnedPublicKeyB64, 32)
    const desktopPublicKey = unb64(ready.desktopPublicKeyB64, 32)
    const clientNonce = unb64(hello.clientNonceB64, 32)
    const desktopNonce = unb64(ready.desktopNonceB64, 32)
    if (!pinned || !desktopPublicKey || !clientNonce || !desktopNonce || !equal(pinned, desktopPublicKey)) return null
    const rawSecret = nacl.scalarMult(this.keyPair.secretKey, desktopPublicKey)
    if (rawSecret.every((byte) => byte === 0)) return null
    const sharedSecret = nacl.box.before(desktopPublicKey, this.keyPair.secretKey)
    const transcriptBytes = transcript(hello, ready, this.keyPair.publicKey, desktopPublicKey, clientNonce, desktopNonce)
    const hash = new Uint8Array(createHash('sha256').update(transcriptBytes).digest())
    const salt = createHash('sha256').update(Buffer.concat([Buffer.from('orca-mobile-e2ee/v2/salt\0'), clientNonce, desktopNonce])).digest()
    const info = Buffer.concat([Buffer.from('orca-mobile-e2ee/v2/session\0'), hash])
    const keyBytes = new Uint8Array(hkdfSync('sha256', sharedSecret, salt, info, 96))
    return {
      mobileToDesktop: keyBytes.slice(0, 32),
      desktopToMobile: keyBytes.slice(32, 64),
      sessionId: keyBytes.slice(64, 96),
      transcriptHashB64: b64(hash)
    }
  }

  private sendText(text: string): void {
    if (!this.schedule) throw new Error('not ready')
    const frame = seal(new TextEncoder().encode(text), this.schedule.mobileToDesktop, this.schedule.sessionId, 0, 0, this.outboundCounter++)
    this.socket.send(b64(frame))
  }

  private openText(frameB64: string): string | null {
    if (!this.schedule || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frameB64)) return null
    const frame = Buffer.from(frameB64, 'base64')
    if (b64(frame) !== frameB64) return null
    const value = open(frame, this.schedule.desktopToMobile, this.schedule.sessionId, 1, 0, this.inboundCounter)
    if (!value) return null
    this.inboundCounter++
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  }

  private openBinary(frame: Uint8Array): Uint8Array | null {
    if (!this.schedule) return null
    const value = open(frame, this.schedule.desktopToMobile, this.schedule.sessionId, 1, 1, this.inboundCounter)
    if (!value) return null
    this.inboundCounter++
    return value
  }
}

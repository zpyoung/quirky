import nacl from 'tweetnacl'
import type { MobileSocket, MobileWebSocketConstructor } from '@quirky/protocol/paired-client'
import { DesktopMobileE2EEV2Session } from '../../../plugins/quirky.mobile/src/crypto/e2ee-v2'

export type TestPeerSocket = MobileSocket & {
  readonly url: string
  emitEvent(data: unknown): void
  sealEncryptedText(text: string): string
  emitEncryptedText(text: string): void
  emitEncryptedTextFrame(frame: string): void
  emitTerminal(streamId: number, bytes: Uint8Array): void
}

export type TestPeer = {
  WebSocket: MobileWebSocketConstructor
  sockets: TestPeerSocket[]
  requests: { method: string; params: Record<string, unknown>; requestId?: string }[]
  authenticatedTokens: string[]
  encryptedTextFrames: string[]
  publicKeyB64: string
  serverSecretKey: Uint8Array
}
const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const DEVICE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'
export const DEVICE_ID = '00000000-0000-4000-8000-000000000001'

export function makeTestPeer(options: {
  holdReady?: boolean
  holdAuthentication?: boolean
  authenticationFrames?: (response: Record<string, unknown>) => readonly Record<string, unknown>[]
  onRequest?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>
  expectedToken?: string
  identitySeed?: number
  preAuthenticationBinary?: boolean
} = {}): TestPeer {
  const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(options.identitySeed ?? 37))
  const sockets: TestSocket[] = []
  const requests: { method: string; params: Record<string, unknown>; requestId?: string }[] = []
  const authenticatedTokens: string[] = []
  const encryptedTextFrames: string[] = []

  class TestSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readonly url: string
    readyState = TestSocket.CONNECTING
    binaryType: string = 'arraybuffer'
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: ((event: { code?: number; reason?: string }) => void) | null = null
    session: DesktopMobileE2EEV2Session | null = null
    private serverSecretKey = desktop.secretKey

    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== TestSocket.CONNECTING) return
        this.readyState = TestSocket.OPEN
        this.onopen?.({})
      })
    }

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (this.readyState !== TestSocket.OPEN) throw new Error('socket is not open')
      if (typeof data !== 'string') throw new Error('test daemon accepts only encrypted text inputs')
      if (!this.session) {
        let hello: unknown
        try { hello = JSON.parse(data) as unknown } catch { this.fail(); return }
        this.session = DesktopMobileE2EEV2Session.create({
          hello,
          serverSecretKey: this.serverSecretKey,
          expectedContext: { transport: 'direct' },
          randomBytes: (length) => new Uint8Array(length).fill(71)
        })
        if (!this.session) { this.fail(); return }
        if (!options.holdReady) this.deliverText(JSON.stringify(this.session.ready))
        if (!options.holdReady && options.preAuthenticationBinary) this.emitTerminal(43, new Uint8Array([65, 66, 67]))
        return
      }
      const plaintext = this.session.openText(data)
      if (plaintext === null) { this.fail(); return }
      let envelope: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(plaintext)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.fail(); return }
        envelope = parsed as Record<string, unknown>
      } catch { this.fail(); return }
      if (envelope.type === 'e2ee_auth') {
        const token = typeof envelope.deviceToken === 'string' ? envelope.deviceToken : ''
        authenticatedTokens.push(token)
        if (options.holdAuthentication) return
        const accepted = options.expectedToken === undefined || options.expectedToken === token
        const response = accepted
          ? { type: 'e2ee_authenticated', v: 2, transcriptHashB64: this.session.transcriptHashB64 }
          : { type: 'e2ee_error', error: { code: 'unauthorized' } }
        const frames = options.authenticationFrames?.(response) ?? [response]
        for (const frame of frames) {
          const encrypted = this.session.sealText(JSON.stringify(frame))
          encryptedTextFrames.push(encrypted)
          this.deliverText(encrypted)
        }
        return
      }
      if (typeof envelope.id !== 'number' || typeof envelope.method !== 'string') return
      const method = envelope.method
      const params = envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
        ? envelope.params as Record<string, unknown>
        : {}
      requests.push({ method, params, ...(typeof envelope.requestId === 'string' ? { requestId: envelope.requestId } : {}) })
      const defaultResult = method === 'quirky.mobile/info'
        ? { machineName: 'test-desktop', platform: 'linux', deviceScope: 'mobile' }
        : method === 'quirky.mobile/preferences'
          ? { autoRestoreFitMs: null }
          : method === 'quirky.mobile/updatePreferences'
            ? { autoRestoreFitMs: params.autoRestoreFitMs }
            : method === 'quirky.repo/list'
              ? []
              : method === 'status.get'
                ? { state: 'ready' }
                : { ok: true }
      Promise.resolve(options.onRequest?.(method, params) ?? defaultResult).then((result) => {
        if (this.session && this.readyState === TestSocket.OPEN) {
          this.deliverText(this.session.sealText(JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result })))
        }
      }, () => {
        if (this.session && this.readyState === TestSocket.OPEN) {
          this.deliverText(this.session.sealText(JSON.stringify({ jsonrpc: '2.0', id: envelope.id, error: { code: -32000, message: 'test failure' } })))
        }
      })
    }

    emitEvent(data: unknown): void {
      if (!this.session || this.readyState !== TestSocket.OPEN) throw new Error('test peer is not authenticated')
      this.deliverText(this.session.sealText(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: data })))
    }
    sealEncryptedText(text: string): string {
      if (!this.session || this.readyState !== TestSocket.OPEN) throw new Error('test peer is not authenticated')
      const frame = this.session.sealText(text)
      encryptedTextFrames.push(frame)
      return frame
    }
    emitEncryptedText(text: string): void {
      this.emitEncryptedTextFrame(this.sealEncryptedText(text))
    }
    emitEncryptedTextFrame(frame: string): void {
      if (!this.session || this.readyState !== TestSocket.OPEN) throw new Error('test peer is not authenticated')
      this.deliverText(frame)
    }


    emitTerminal(streamId: number, bytes: Uint8Array): void {
      if (!this.session || this.readyState !== TestSocket.OPEN) throw new Error('test peer is not authenticated')
      const frame = new Uint8Array(5 + bytes.length)
      frame[0] = 1
      new DataView(frame.buffer).setUint32(1, streamId)
      frame.set(bytes, 5)
      this.deliverBinary(this.session.sealBinary(frame))
    }

    close(code = 1000, reason = ''): void {
      if (this.readyState === TestSocket.CLOSED) return
      this.readyState = TestSocket.CLOSED
      this.session?.dispose()
      this.session = null
      queueMicrotask(() => this.onclose?.({ code, reason }))
    }

    private deliverText(data: string): void {
      queueMicrotask(() => {
        if (this.readyState === TestSocket.OPEN) this.onmessage?.({ data })
      })
    }

    private deliverBinary(bytes: Uint8Array): void {
      const copy = bytes.slice()
      queueMicrotask(() => {
        if (this.readyState === TestSocket.OPEN) this.onmessage?.({ data: copy.buffer })
      })
    }

    private fail(): void {
      this.close(4001, 'test protocol failure')
    }
  }

  return {
    WebSocket: TestSocket,
    sockets,
    requests,
    authenticatedTokens,
    encryptedTextFrames,
    publicKeyB64: encodeBase64(desktop.publicKey),
    serverSecretKey: desktop.secretKey
  }
}

export function pairingInput(options: { token?: string; endpoint?: string; extra?: Record<string, unknown> } = {}): string {
  const offer = {
    v: 2,
    endpoint: options.endpoint ?? 'ws://desktop.local:6768',
    deviceToken: options.token ?? DEVICE_TOKEN,
    publicKeyB64: makeTestPeer().publicKeyB64,
    pairedDeviceId: DEVICE_ID,
    scope: 'mobile',
    ...options.extra
  }
  const code = btoa(JSON.stringify(offer)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return code
}

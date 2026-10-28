/**
 * Cryptographic transcript and framing semantics follow upstream pure helpers:
 * `/Users/zpyoung/PycharmProjects/orca/src/shared/mobile-e2ee-v2-contract.ts`,
 * `mobile-e2ee-v2-framing.ts`, `mobile-e2ee-v2-node-key-schedule.ts`, and
 * `paired-e2ee-v2-client-session.ts`. Quirky keeps the shared protocol domains but
 * accepts direct transport only and checks the raw X25519 point before `box.before`.
 */
import { createHash, hkdfSync } from 'node:crypto'
import nacl from 'tweetnacl'

export const MOBILE_E2EE_V2_PROTOCOL = 'orca-mobile-e2ee' as const
export const MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript'
export const MOBILE_E2EE_V2_FRAME_OVERHEAD_BYTES = 82
export const MAX_MOBILE_TEXT_BYTES = 4 * 1024 * 1024
export const MAX_MOBILE_BINARY_BYTES = 8 * 1024 * 1024

export type MobileE2EEDirection = 'mobile-to-desktop' | 'desktop-to-mobile'
export type MobileE2EEPayloadKind = 'text' | 'binary'
export type MobileE2EETransport = 'direct' | 'relay'
export type MobileE2EEV2Context = {
  protocol: typeof MOBILE_E2EE_V2_PROTOCOL
  initiator: 'mobile'
  responder: 'desktop'
  transport: MobileE2EETransport
  relayHostId?: string
}
export type MobileE2EEV2Hello = {
  type: 'e2ee_hello'
  v: 2
  clientPublicKeyB64: string
  clientNonceB64: string
  capabilities: { framing: [2]; payloadKinds: ['text', 'binary'] }
  context: MobileE2EEV2Context
}
export type MobileE2EEV2Ready = {
  type: 'e2ee_ready'
  v: 2
  desktopPublicKeyB64: string
  clientNonceB64: string
  desktopNonceB64: string
  selection: { framing: 2; payloadKinds: ['text', 'binary'] }
  context: MobileE2EEV2Context
}
export type MobileE2EEV2Handshake = {
  hello: MobileE2EEV2Hello
  ready: MobileE2EEV2Ready
  clientPublicKey: Uint8Array
  desktopPublicKey: Uint8Array
  clientNonce: Uint8Array
  desktopNonce: Uint8Array
}
export type MobileE2EEV2KeySchedule = {
  mobileToDesktopKey: Uint8Array
  desktopToMobileKey: Uint8Array
  sessionId: Uint8Array
  transcriptHash: Uint8Array
}

const NONCE_LENGTH = 24
const SESSION_ID_LENGTH = 32
const HEADER_LENGTH = 42
const FRAME_VERSION = 2
const MAX_COUNTER = (1n << 64n) - 1n
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const encoder = new TextEncoder()

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const candidate = record(value)
  if (!candidate || Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) return null
  return candidate
}

function decodeCanonicalBase64(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== 44 || !BASE64_32.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length || bytes.toString('base64') !== value) return null
  return new Uint8Array(bytes)
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function parseContext(value: unknown): MobileE2EEV2Context | null {
  const candidate = record(value)
  if (!candidate) return null
  const expectedKeys = candidate.transport === 'relay' ? ['protocol', 'initiator', 'responder', 'transport', 'relayHostId'] : ['protocol', 'initiator', 'responder', 'transport']
  if (!exactRecord(candidate, expectedKeys)) return null
  if (candidate.protocol !== MOBILE_E2EE_V2_PROTOCOL || candidate.initiator !== 'mobile' || candidate.responder !== 'desktop') return null
  if (candidate.transport !== 'direct' && candidate.transport !== 'relay') return null
  if (candidate.transport === 'relay' && (typeof candidate.relayHostId !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(candidate.relayHostId))) return null
  return candidate as MobileE2EEV2Context
}

function sameContext(left: MobileE2EEV2Context, right: MobileE2EEV2Context): boolean {
  return left.protocol === right.protocol && left.initiator === right.initiator && left.responder === right.responder &&
    left.transport === right.transport && left.relayHostId === right.relayHostId
}

function hasCapabilities(value: unknown): boolean {
  const capabilities = exactRecord(value, ['framing', 'payloadKinds'])
  if (!capabilities || !Array.isArray(capabilities.framing) || !Array.isArray(capabilities.payloadKinds)) return false
  return capabilities.framing.length === 1 && capabilities.framing[0] === 2 &&
    capabilities.payloadKinds.length === 2 && capabilities.payloadKinds[0] === 'text' && capabilities.payloadKinds[1] === 'binary'
}

function hasSelection(value: unknown): boolean {
  const selection = exactRecord(value, ['framing', 'payloadKinds'])
  if (!selection || selection.framing !== 2 || !Array.isArray(selection.payloadKinds)) return false
  return selection.payloadKinds.length === 2 && selection.payloadKinds[0] === 'text' && selection.payloadKinds[1] === 'binary'
}

export function validateMobileE2EEV2Handshake(
  helloValue: unknown,
  readyValue: unknown,
  expectedContext?: { transport: MobileE2EETransport; relayHostId?: string }
): MobileE2EEV2Handshake | null {
  const hello = exactRecord(helloValue, ['type', 'v', 'clientPublicKeyB64', 'clientNonceB64', 'capabilities', 'context'])
  const ready = exactRecord(readyValue, ['type', 'v', 'desktopPublicKeyB64', 'clientNonceB64', 'desktopNonceB64', 'selection', 'context'])
  if (!hello || !ready || hello.type !== 'e2ee_hello' || hello.v !== 2 || ready.type !== 'e2ee_ready' || ready.v !== 2) return null
  if (!hasCapabilities(hello.capabilities) || !hasSelection(ready.selection)) return null
  const helloContext = parseContext(hello.context)
  const readyContext = parseContext(ready.context)
  if (!helloContext || !readyContext || !sameContext(helloContext, readyContext)) return null
  if (expectedContext && (helloContext.transport !== expectedContext.transport || helloContext.relayHostId !== expectedContext.relayHostId)) return null
  if (ready.clientNonceB64 !== hello.clientNonceB64) return null
  const clientPublicKey = decodeCanonicalBase64(hello.clientPublicKeyB64, 32)
  const desktopPublicKey = decodeCanonicalBase64(ready.desktopPublicKeyB64, 32)
  const clientNonce = decodeCanonicalBase64(hello.clientNonceB64, 32)
  const desktopNonce = decodeCanonicalBase64(ready.desktopNonceB64, 32)
  if (!clientPublicKey || !desktopPublicKey || !clientNonce || !desktopNonce) return null
  return {
    hello: helloValue as MobileE2EEV2Hello,
    ready: readyValue as MobileE2EEV2Ready,
    clientPublicKey,
    desktopPublicKey,
    clientNonce,
    desktopNonce
  }
}

/** Uses the audited upstream Quirky/Orca v2 field names, order, and length prefixes. */
export function encodeMobileE2EEV2Transcript(handshake: MobileE2EEV2Handshake): Uint8Array {
  const { hello, ready } = handshake
  const fields: [string, Uint8Array][] = [
    ['domain', encoder.encode(MOBILE_E2EE_V2_TRANSCRIPT_DOMAIN)],
    ['mobile-to-desktop.type', encoder.encode(hello.type)],
    ['mobile-to-desktop.version', uint32(hello.v)],
    ['mobile-to-desktop.client-public-key', handshake.clientPublicKey],
    ['mobile-to-desktop.client-nonce', handshake.clientNonce],
    ['mobile-to-desktop.capabilities.framing', encodeNumberList(hello.capabilities.framing)],
    ['mobile-to-desktop.capabilities.payload-kinds', encodeStringList(hello.capabilities.payloadKinds)],
    ['mobile-to-desktop.context.protocol', encoder.encode(hello.context.protocol)],
    ['mobile-to-desktop.context.initiator', encoder.encode(hello.context.initiator)],
    ['mobile-to-desktop.context.responder', encoder.encode(hello.context.responder)],
    ['mobile-to-desktop.context.transport', encoder.encode(hello.context.transport)],
    ['mobile-to-desktop.context.relay-host-id', encoder.encode(hello.context.relayHostId ?? '')],
    ['desktop-to-mobile.type', encoder.encode(ready.type)],
    ['desktop-to-mobile.version', uint32(ready.v)],
    ['desktop-to-mobile.desktop-public-key', handshake.desktopPublicKey],
    ['desktop-to-mobile.client-nonce-echo', handshake.clientNonce],
    ['desktop-to-mobile.desktop-nonce', handshake.desktopNonce],
    ['desktop-to-mobile.selection.framing', uint32(ready.selection.framing)],
    ['desktop-to-mobile.selection.payload-kinds', encodeStringList(ready.selection.payloadKinds)],
    ['desktop-to-mobile.context.protocol', encoder.encode(ready.context.protocol)],
    ['desktop-to-mobile.context.initiator', encoder.encode(ready.context.initiator)],
    ['desktop-to-mobile.context.responder', encoder.encode(ready.context.responder)],
    ['desktop-to-mobile.context.transport', encoder.encode(ready.context.transport)],
    ['desktop-to-mobile.context.relay-host-id', encoder.encode(ready.context.relayHostId ?? '')]
  ]
  return concatBytes(fields.map(([name, value]) => encodeField(name, value)))
}

export function deriveMobileE2EEV2KeySchedule(args: {
  sharedSecret: Uint8Array
  transcript: Uint8Array
  clientNonce: Uint8Array
  desktopNonce: Uint8Array
}): MobileE2EEV2KeySchedule {
  if (args.sharedSecret.length !== 32 || args.clientNonce.length !== 32 || args.desktopNonce.length !== 32) throw new Error('invalid mobile E2EE key schedule input length')
  const transcriptHash = sha256(args.transcript)
  const salt = sha256(concatBytes([encoder.encode('orca-mobile-e2ee/v2/salt\0'), args.clientNonce, args.desktopNonce]))
  const info = concatBytes([encoder.encode('orca-mobile-e2ee/v2/session\0'), transcriptHash])
  const expanded = new Uint8Array(hkdfSync('sha256', args.sharedSecret, salt, info, 96))
  return {
    mobileToDesktopKey: expanded.slice(0, 32),
    desktopToMobileKey: expanded.slice(32, 64),
    sessionId: expanded.slice(64, 96),
    transcriptHash
  }
}

export function sealMobileE2EEV2Frame(args: {
  payload: Uint8Array
  key: Uint8Array
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  counter: bigint
}): Uint8Array {
  validateFrameInputs(args.key, args.sessionId, args.counter)
  const nonce = encodeNonce(args)
  const plaintext = concatBytes([encodeHeader(args), args.payload])
  return concatBytes([nonce, nacl.secretbox(plaintext, nonce, args.key)])
}

export function openMobileE2EEV2Frame(args: {
  frame: Uint8Array
  key: Uint8Array
  sessionId: Uint8Array
  direction: MobileE2EEDirection
  payloadKind: MobileE2EEPayloadKind
  expectedCounter: bigint
}): Uint8Array | null {
  validateFrameInputs(args.key, args.sessionId, args.expectedCounter)
  if (args.frame.length < NONCE_LENGTH + nacl.secretbox.overheadLength + HEADER_LENGTH) return null
  const expected = { sessionId: args.sessionId, direction: args.direction, payloadKind: args.payloadKind, counter: args.expectedCounter }
  const nonce = encodeNonce(expected)
  if (!equalBytes(args.frame.subarray(0, NONCE_LENGTH), nonce)) return null
  const plaintext = nacl.secretbox.open(args.frame.subarray(NONCE_LENGTH), nonce, args.key)
  if (!plaintext || !equalBytes(plaintext.subarray(0, HEADER_LENGTH), encodeHeader(expected))) return null
  return plaintext.slice(HEADER_LENGTH)
}

export class DesktopMobileE2EEV2Session {
  private inboundCounter = 0n
  private outboundCounter = 0n

  private constructor(
    readonly ready: MobileE2EEV2Ready,
    readonly transcriptHashB64: string,
    private readonly mobileToDesktopKey: Uint8Array,
    private readonly desktopToMobileKey: Uint8Array,
    private readonly sessionId: Uint8Array
  ) {}

  static create(args: {
    hello: unknown
    serverSecretKey: Uint8Array
    expectedContext?: { transport: MobileE2EETransport; relayHostId?: string }
    randomBytes?: (length: number) => Uint8Array
  }): DesktopMobileE2EEV2Session | null {
    if (args.serverSecretKey.length !== nacl.box.secretKeyLength) return null
    const helloRecord = exactRecord(args.hello, ['type', 'v', 'clientPublicKeyB64', 'clientNonceB64', 'capabilities', 'context'])
    if (!helloRecord || helloRecord.type !== 'e2ee_hello' || helloRecord.v !== 2) return null
    const clientContext = parseContext(helloRecord.context)
    if (!clientContext || !hasCapabilities(helloRecord.capabilities)) return null
    const expectedContext = args.expectedContext ?? { transport: 'direct' as const }
    if (clientContext.transport !== expectedContext.transport || clientContext.relayHostId !== expectedContext.relayHostId) return null
    const clientPublicKey = decodeCanonicalBase64(helloRecord.clientPublicKeyB64, 32)
    const clientNonce = decodeCanonicalBase64(helloRecord.clientNonceB64, 32)
    if (!clientPublicKey || !clientNonce) return null
    const serverKeys = nacl.box.keyPair.fromSecretKey(args.serverSecretKey)
    let rawSharedPoint: Uint8Array
    try {
      rawSharedPoint = nacl.scalarMult(args.serverSecretKey, clientPublicKey)
    } catch {
      return null
    }
    if (rawSharedPoint.every((byte) => byte === 0)) return null
    const random = args.randomBytes ?? ((length: number) => nacl.randomBytes(length))
    const desktopNonce = random(32)
    if (desktopNonce.length !== 32) return null
    const context = clientContext
    const ready: MobileE2EEV2Ready = {
      type: 'e2ee_ready',
      v: 2,
      desktopPublicKeyB64: encodeBase64(serverKeys.publicKey),
      clientNonceB64: helloRecord.clientNonceB64 as string,
      desktopNonceB64: encodeBase64(desktopNonce),
      selection: { framing: 2, payloadKinds: ['text', 'binary'] },
      context
    }
    const handshake = validateMobileE2EEV2Handshake(args.hello, ready, expectedContext)
    if (!handshake) return null
    // Check the raw Curve25519 point before box.before, which otherwise HSalsa20-transforms it.
    const sharedSecret = nacl.box.before(handshake.clientPublicKey, args.serverSecretKey)
    if (sharedSecret.length !== 32 || sharedSecret.every((byte) => byte === 0)) return null
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    return new DesktopMobileE2EEV2Session(ready, encodeBase64(schedule.transcriptHash), schedule.mobileToDesktopKey, schedule.desktopToMobileKey, schedule.sessionId)
  }

  openText(frameB64: string): string | null {
    if (frameB64.length > Math.ceil((1024 * 1024 + MOBILE_E2EE_V2_FRAME_OVERHEAD_BYTES) / 3) * 4 || !BASE64.test(frameB64)) return null
    const frame = Buffer.from(frameB64, 'base64')
    if (frame.toString('base64') !== frameB64) return null
    const plaintext = this.open(frame, 'text')
    if (!plaintext) return null
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    } catch {
      return null
    }
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    return this.open(frame, 'binary')
  }
  dispose(): void {
    this.mobileToDesktopKey.fill(0)
    this.desktopToMobileKey.fill(0)
    this.sessionId.fill(0)
  }

  sealText(plaintext: string): string {
    const bytes = encoder.encode(plaintext)
    if (bytes.length > MAX_MOBILE_TEXT_BYTES) throw new Error('mobile text frame too large')
    return encodeBase64(this.seal(bytes, 'text'))
  }

  sealBinary(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_MOBILE_BINARY_BYTES) throw new Error('mobile binary frame too large')
    return this.seal(plaintext, 'binary')
  }

  private open(frame: Uint8Array, payloadKind: MobileE2EEPayloadKind): Uint8Array | null {
    const plaintext = openMobileE2EEV2Frame({
      frame,
      key: this.mobileToDesktopKey,
      sessionId: this.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind,
      expectedCounter: this.inboundCounter
    })
    if (plaintext) this.inboundCounter++
    return plaintext
  }

  private seal(plaintext: Uint8Array, payloadKind: MobileE2EEPayloadKind): Uint8Array {
    const frame = sealMobileE2EEV2Frame({
      payload: plaintext,
      key: this.desktopToMobileKey,
      sessionId: this.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind,
      counter: this.outboundCounter
    })
    this.outboundCounter++
    return frame
  }
}

function encodeHeader(args: { sessionId: Uint8Array; direction: MobileE2EEDirection; payloadKind: MobileE2EEPayloadKind; counter: bigint }): Uint8Array {
  const header = new Uint8Array(HEADER_LENGTH)
  header.set(args.sessionId)
  header[32] = args.direction === 'mobile-to-desktop' ? 0 : 1
  header[33] = args.payloadKind === 'text' ? 0 : 1
  writeUint64(header, 34, args.counter)
  return header
}

function encodeNonce(args: { sessionId: Uint8Array; direction: MobileE2EEDirection; payloadKind: MobileE2EEPayloadKind; counter: bigint }): Uint8Array {
  const nonce = new Uint8Array(NONCE_LENGTH)
  nonce.set(args.sessionId.subarray(0, 12))
  nonce[12] = FRAME_VERSION
  nonce[13] = args.direction === 'mobile-to-desktop' ? 0 : 1
  nonce[14] = args.payloadKind === 'text' ? 0 : 1
  writeUint64(nonce, 16, args.counter)
  return nonce
}

function validateFrameInputs(key: Uint8Array, sessionId: Uint8Array, counter: bigint): void {
  if (key.length !== 32 || sessionId.length !== SESSION_ID_LENGTH || counter < 0n || counter > MAX_COUNTER) throw new Error('invalid mobile E2EE frame input')
}

function writeUint64(target: Uint8Array, offset: number, value: bigint): void {
  let remaining = value
  for (let index = 7; index >= 0; index--) {
    target[offset + index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function encodeNumberList(values: readonly number[]): Uint8Array {
  return concatBytes([uint32(values.length), ...values.map(uint32)])
}

function encodeStringList(values: readonly string[]): Uint8Array {
  const pieces = [uint32(values.length)]
  for (const value of values) {
    const bytes = encoder.encode(value)
    pieces.push(uint32(bytes.length), bytes)
  }
  return concatBytes(pieces)
}

function encodeField(name: string, value: Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name)
  return concatBytes([uint32(nameBytes.length), nameBytes, uint32(value.length), value])
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256.js'
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
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = new Int16Array(128).fill(-1)
for (let index = 0; index < BASE64_ALPHABET.length; index++) BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(index)] = index
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const BASE64_32_RE = /^[A-Za-z0-9+/]{43}=$/
const encoder = new TextEncoder()

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const candidate = record(value)
  if (!candidate || Object.keys(candidate).length !== keys.length || keys.some((key) => !Object.hasOwn(candidate, key))) return null
  return candidate
}

export function encodeBase64(bytes: Uint8Array): string {
  let output = ''
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!
    const hasB = offset + 1 < bytes.length
    const hasC = offset + 2 < bytes.length
    const b = hasB ? bytes[offset + 1]! : 0
    const c = hasC ? bytes[offset + 2]! : 0
    output += BASE64_ALPHABET[a >>> 2]
    output += BASE64_ALPHABET[((a & 3) << 4) | (b >>> 4)]
    output += hasB ? BASE64_ALPHABET[((b & 15) << 2) | (c >>> 6)] : '='
    output += hasC ? BASE64_ALPHABET[c & 63] : '='
  }
  return output
}

export function decodeBase64(value: string, expectedLength?: number): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) throw new Error('invalid base64')
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const output = new Uint8Array((value.length / 4) * 3 - padding)
  let cursor = 0
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_LOOKUP[value.charCodeAt(offset)]!
    const b = BASE64_LOOKUP[value.charCodeAt(offset + 1)]!
    const c = value[offset + 2] === '=' ? 0 : BASE64_LOOKUP[value.charCodeAt(offset + 2)]!
    const d = value[offset + 3] === '=' ? 0 : BASE64_LOOKUP[value.charCodeAt(offset + 3)]!
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('invalid base64')
    if (cursor < output.length) output[cursor++] = (a << 2) | (b >>> 4)
    if (cursor < output.length) output[cursor++] = ((b & 15) << 4) | (c >>> 2)
    if (cursor < output.length) output[cursor++] = ((c & 3) << 6) | d
  }
  if ((expectedLength !== undefined && output.length !== expectedLength) || encodeBase64(output) !== value) throw new Error('invalid canonical base64')
  return output
}

export function decodeBase64Url(value: string, maxBytes = 8 * 1024): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid pairing code')
  const standard = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const bytes = decodeBase64(standard)
  if (bytes.length > maxBytes) throw new Error('invalid pairing code')
  const canonical = encodeBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  if (canonical !== value) throw new Error('invalid pairing code')
  return bytes
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(nobleSha256(bytes))
}

function decodeCanonical32(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !BASE64_32_RE.test(value)) return null
  try { return decodeBase64(value, 32) } catch { return null }
}

function parseContext(value: unknown): MobileE2EEV2Context | null {
  const candidate = record(value)
  if (!candidate) return null
  const keys = candidate.transport === 'relay'
    ? ['protocol', 'initiator', 'responder', 'transport', 'relayHostId']
    : ['protocol', 'initiator', 'responder', 'transport']
  if (!exactRecord(candidate, keys)) return null
  if (candidate.protocol !== MOBILE_E2EE_V2_PROTOCOL || candidate.initiator !== 'mobile' || candidate.responder !== 'desktop') return null
  if (candidate.transport !== 'direct' && candidate.transport !== 'relay') return null
  if (candidate.transport === 'relay' && (typeof candidate.relayHostId !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(candidate.relayHostId))) return null
  return candidate as MobileE2EEV2Context
}

function sameContext(left: MobileE2EEV2Context, right: MobileE2EEV2Context): boolean {
  return left.protocol === right.protocol && left.initiator === right.initiator && left.responder === right.responder &&
    left.transport === right.transport && left.relayHostId === right.relayHostId
}

function validCapabilities(value: unknown): boolean {
  const capabilities = exactRecord(value, ['framing', 'payloadKinds'])
  return !!capabilities && Array.isArray(capabilities.framing) && Array.isArray(capabilities.payloadKinds) &&
    capabilities.framing.length === 1 && capabilities.framing[0] === 2 &&
    capabilities.payloadKinds.length === 2 && capabilities.payloadKinds[0] === 'text' && capabilities.payloadKinds[1] === 'binary'
}

function validSelection(value: unknown): boolean {
  const selection = exactRecord(value, ['framing', 'payloadKinds'])
  return !!selection && selection.framing === 2 && Array.isArray(selection.payloadKinds) &&
    selection.payloadKinds.length === 2 && selection.payloadKinds[0] === 'text' && selection.payloadKinds[1] === 'binary'
}

export function createMobileE2EEV2Hello(clientPublicKey: Uint8Array, clientNonce: Uint8Array): MobileE2EEV2Hello {
  if (clientPublicKey.length !== 32 || clientNonce.length !== 32) throw new Error('invalid mobile E2EE hello input')
  return {
    type: 'e2ee_hello',
    v: 2,
    clientPublicKeyB64: encodeBase64(clientPublicKey),
    clientNonceB64: encodeBase64(clientNonce),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: { protocol: MOBILE_E2EE_V2_PROTOCOL, initiator: 'mobile', responder: 'desktop', transport: 'direct' }
  }
}

export function validateMobileE2EEV2Handshake(
  helloValue: unknown,
  readyValue: unknown,
  expectedContext: { transport: MobileE2EETransport; relayHostId?: string } = { transport: 'direct' },
  pinnedPublicKeyB64?: string
): MobileE2EEV2Handshake | null {
  const hello = exactRecord(helloValue, ['type', 'v', 'clientPublicKeyB64', 'clientNonceB64', 'capabilities', 'context'])
  const ready = exactRecord(readyValue, ['type', 'v', 'desktopPublicKeyB64', 'clientNonceB64', 'desktopNonceB64', 'selection', 'context'])
  if (!hello || !ready || hello.type !== 'e2ee_hello' || hello.v !== 2 || ready.type !== 'e2ee_ready' || ready.v !== 2) return null
  if (!validCapabilities(hello.capabilities) || !validSelection(ready.selection)) return null
  const helloContext = parseContext(hello.context)
  const readyContext = parseContext(ready.context)
  if (!helloContext || !readyContext || !sameContext(helloContext, readyContext)) return null
  if (helloContext.transport !== expectedContext.transport || helloContext.relayHostId !== expectedContext.relayHostId) return null
  if (ready.clientNonceB64 !== hello.clientNonceB64) return null
  if (pinnedPublicKeyB64 !== undefined && ready.desktopPublicKeyB64 !== pinnedPublicKeyB64) return null
  const clientPublicKey = decodeCanonical32(hello.clientPublicKeyB64)
  const desktopPublicKey = decodeCanonical32(ready.desktopPublicKeyB64)
  const clientNonce = decodeCanonical32(hello.clientNonceB64)
  const desktopNonce = decodeCanonical32(ready.desktopNonceB64)
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
  const expanded = new Uint8Array(hkdf(nobleSha256, args.sharedSecret, salt, info, 96))
  const mobileToDesktopKey = expanded.slice(0, 32)
  const desktopToMobileKey = expanded.slice(32, 64)
  const sessionId = expanded.slice(64, 96)
  expanded.fill(0)
  return { mobileToDesktopKey, desktopToMobileKey, sessionId, transcriptHash }
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
  const header = encodeHeader(args)
  let plaintext: Uint8Array
  try { plaintext = concatBytes([header, args.payload]) } finally { header.fill(0) }
  let ciphertext: Uint8Array | null = null
  try {
    ciphertext = nacl.secretbox(plaintext, nonce, args.key)
    return concatBytes([nonce, ciphertext])
  } finally {
    plaintext.fill(0)
    ciphertext?.fill(0)
  }
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
  if (!plaintext) return null
  const expectedHeader = encodeHeader(expected)
  let validHeader: boolean
  try { validHeader = equalBytes(plaintext.subarray(0, HEADER_LENGTH), expectedHeader) } finally { expectedHeader.fill(0) }
  if (!validHeader) {
    plaintext.fill(0)
    return null
  }
  const payload = plaintext.slice(HEADER_LENGTH)
  plaintext.fill(0)
  return payload
}

export function framePayloadKind(frame: Uint8Array): MobileE2EEPayloadKind | null {
  if (frame.length < NONCE_LENGTH + nacl.secretbox.overheadLength + HEADER_LENGTH || frame[12] !== FRAME_VERSION) return null
  return frame[14] === 0 ? 'text' : frame[14] === 1 ? 'binary' : null
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
  const parts = [uint32(values.length)]
  for (const value of values) {
    const bytes = encoder.encode(value)
    parts.push(uint32(bytes.length), bytes)
  }
  return concatBytes(parts)
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

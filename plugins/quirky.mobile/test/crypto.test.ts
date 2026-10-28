import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { MobileE2EEV2Context, MobileE2EEV2Hello, MobileE2EEV2Ready } from '../src/crypto/e2ee-v2'
import {
  DesktopMobileE2EEV2Session,
  deriveMobileE2EEV2KeySchedule,
  encodeMobileE2EEV2Transcript,
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame,
  validateMobileE2EEV2Handshake
} from '../src/crypto/e2ee-v2'

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const directContext: MobileE2EEV2Context = { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }

function makeHello(publicKey: Uint8Array, nonce: Uint8Array): MobileE2EEV2Hello {
  return {
    type: 'e2ee_hello', v: 2,
    clientPublicKeyB64: encode(publicKey), clientNonceB64: encode(nonce),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: directContext
  }
}

function upstreamTranscriptFixture(): { hello: MobileE2EEV2Hello; ready: MobileE2EEV2Ready } {
  const repeat = (n: number) => encode(new Uint8Array(32).fill(n))
  const context: MobileE2EEV2Context = { ...directContext, transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' }
  return {
    hello: {
      type: 'e2ee_hello', v: 2, clientPublicKeyB64: repeat(1), clientNonceB64: repeat(2),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] }, context
    },
    ready: {
      type: 'e2ee_ready', v: 2, desktopPublicKeyB64: repeat(3), clientNonceB64: repeat(2), desktopNonceB64: repeat(4),
      selection: { framing: 2, payloadKinds: ['text', 'binary'] }, context
    }
  }
}

describe('mobile E2EE v2', () => {
  test('accepts the exact direct hello and rejects unknown or noncanonical fields', () => {
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
    const mobile = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2))
    const hello = makeHello(mobile.publicKey, new Uint8Array(32).fill(3))
    const session = DesktopMobileE2EEV2Session.create({ hello, serverSecretKey: desktop.secretKey, randomBytes: () => new Uint8Array(32).fill(4) })
    expect(session).not.toBeNull()
    expect(session?.ready.context).toEqual(directContext)
    expect(validateMobileE2EEV2Handshake(hello, { ...session!.ready, extra: true }, { transport: 'direct' })).toBeNull()
    expect(validateMobileE2EEV2Handshake(hello, { ...session!.ready, clientNonceB64: encode(new Uint8Array(32).fill(9)) }, { transport: 'direct' })).toBeNull()
    expect(DesktopMobileE2EEV2Session.create({ hello: { ...hello, unexpected: true }, serverSecretKey: desktop.secretKey })).toBeNull()
    expect(DesktopMobileE2EEV2Session.create({ hello: { ...hello, clientNonceB64: hello.clientNonceB64.replace(/=$/, '') }, serverSecretKey: desktop.secretKey })).toBeNull()
    expect(DesktopMobileE2EEV2Session.create({ hello: { ...hello, context: { ...directContext, transport: 'relay' } }, serverSecretKey: desktop.secretKey })).toBeNull()
  })

  test('rejects an all-zero low-order peer before deriving the NaCl precomputed key', () => {
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1))
    const hello = makeHello(new Uint8Array(32), new Uint8Array(32).fill(3))
    expect(DesktopMobileE2EEV2Session.create({ hello, serverSecretKey: desktop.secretKey })).toBeNull()
  })

  test('locks the upstream length-prefixed transcript vector', () => {
    const { hello, ready } = upstreamTranscriptFixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready, { transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' })
    expect(handshake).not.toBeNull()
    const bytes = encodeMobileE2EEV2Transcript(handshake!)
    expect(bytes).toHaveLength(1347)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('ca6385f8bbf64a223fdd59587bfb67e2373891ce9e6d85ab41df8b7a20a168e3')
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: new Uint8Array(32).fill(5),
      transcript: bytes,
      clientNonce: new Uint8Array(32).fill(2),
      desktopNonce: new Uint8Array(32).fill(4)
    })
    expect(Buffer.from(schedule.mobileToDesktopKey).toString('hex')).toBe('df17ff534df77fd3a30999f4e6200c8fcedefbb15d369301ca62c3cdfea9559a')
    expect(Buffer.from(schedule.desktopToMobileKey).toString('hex')).toBe('71365fcf8212a6d63caf909ee28de3c8f689682ef298a374136055e0ab1cde4a')
    expect(Buffer.from(schedule.sessionId).toString('hex')).toBe('339ae1f2bdff63481857d2813c2f19dd1f5aa4824705d5e5daeb25dae7b9196e')
  })

  test('uses fixed 82-byte framing overhead and rejects replay, gaps, reflection, kind and session changes', () => {
    const key = new Uint8Array(32).fill(7)
    const sessionId = new Uint8Array(32).fill(8)
    const payload = new TextEncoder().encode('e2ee-auth')
    const frame = sealMobileE2EEV2Frame({ payload, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', counter: 0n })
    expect(frame).toHaveLength(payload.length + 82)
    expect(Buffer.from(frame.subarray(0, 24)).toString('hex')).toBe('080808080808080808080808020000000000000000000000')
    const open = (overrides: Partial<Parameters<typeof openMobileE2EEV2Frame>[0]> = {}) => openMobileE2EEV2Frame({ frame, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', expectedCounter: 0n, ...overrides })
    expect(open()).toEqual(payload)
    expect(open({ expectedCounter: 1n })).toBeNull()
    expect(open({ direction: 'desktop-to-mobile' })).toBeNull()
    expect(open({ payloadKind: 'binary' })).toBeNull()
    expect(open({ sessionId: new Uint8Array(32).fill(9) })).toBeNull()
    expect(open({ frame: frame.subarray(0, 81) })).toBeNull()
  })

  test('advances counters only after valid authenticated frames across payload kinds', () => {
    const key = new Uint8Array(32).fill(7)
    const sessionId = new Uint8Array(32).fill(8)
    const first = sealMobileE2EEV2Frame({ payload: new Uint8Array([1]), key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', counter: 0n })
    const second = sealMobileE2EEV2Frame({ payload: new Uint8Array([2]), key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'binary', counter: 1n })
    expect(openMobileE2EEV2Frame({ frame: first, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', expectedCounter: 1n })).toBeNull()
    expect(openMobileE2EEV2Frame({ frame: first, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'text', expectedCounter: 0n })).toEqual(new Uint8Array([1]))
    expect(openMobileE2EEV2Frame({ frame: second, key, sessionId, direction: 'mobile-to-desktop', payloadKind: 'binary', expectedCounter: 1n })).toEqual(new Uint8Array([2]))
  })
})

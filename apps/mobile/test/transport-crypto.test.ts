import { describe, expect, test } from 'bun:test'
import nacl from 'tweetnacl'
import { DesktopMobileE2EEV2Session } from '../../../plugins/quirky.mobile/src/crypto/e2ee-v2'
import {
  decodeBase64,
  deriveMobileE2EEV2KeySchedule,
  encodeMobileE2EEV2Transcript,
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame,
  validateMobileE2EEV2Handshake
} from '../src/transport/crypto'

const b64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe('portable mobile E2EE v2', () => {
  test('authenticates a strict direct transcript and interoperates with daemon frames', () => {
    const mobile = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(19))
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(37))
    const clientNonce = new Uint8Array(32).fill(53)
    const hello = {
      type: 'e2ee_hello', v: 2,
      clientPublicKeyB64: b64(mobile.publicKey),
      clientNonceB64: b64(clientNonce),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
    }
    const server = DesktopMobileE2EEV2Session.create({
      hello,
      serverSecretKey: desktop.secretKey,
      randomBytes: (length) => new Uint8Array(length).fill(71)
    })
    expect(server).not.toBeNull()
    const handshake = validateMobileE2EEV2Handshake(hello, server!.ready, { transport: 'direct' })
    expect(handshake).not.toBeNull()
    const sharedSecret = nacl.box.before(handshake!.desktopPublicKey, mobile.secretKey)
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake!),
      clientNonce: handshake!.clientNonce,
      desktopNonce: handshake!.desktopNonce
    })

    const outgoing = sealMobileE2EEV2Frame({
      payload: new TextEncoder().encode('mobile request'),
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind: 'text',
      counter: 0n
    })
    expect(outgoing).toHaveLength(new TextEncoder().encode('mobile request').length + 82)
    expect(server!.openText(b64(outgoing))).toBe('mobile request')

    const response = server!.sealText('desktop reply')
    const opened = openMobileE2EEV2Frame({
      frame: decodeBase64(response),
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind: 'text',
      expectedCounter: 0n
    })
    expect(new TextDecoder('utf-8', { fatal: true }).decode(opened!)).toBe('desktop reply')
    server!.dispose()
  })

  test('rejects relay, legacy, extra fields, pin changes and replayed or cross-kind frames', () => {
    const mobile = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(19))
    const desktop = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(37))
    const clientNonce = new Uint8Array(32).fill(53)
    const hello = {
      type: 'e2ee_hello', v: 2,
      clientPublicKeyB64: b64(mobile.publicKey), clientNonceB64: b64(clientNonce),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'direct' }
    }
    const server = DesktopMobileE2EEV2Session.create({ hello, serverSecretKey: desktop.secretKey, randomBytes: (length) => new Uint8Array(length).fill(71) })!
    expect(validateMobileE2EEV2Handshake({ ...hello, extra: true }, server.ready, { transport: 'direct' })).toBeNull()
    expect(validateMobileE2EEV2Handshake(hello, { ...server.ready, desktopPublicKeyB64: b64(new Uint8Array(32).fill(1)) }, { transport: 'direct' }, b64(desktop.publicKey))).toBeNull()
    expect(validateMobileE2EEV2Handshake({ ...hello, context: { ...hello.context, transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' } }, server.ready, { transport: 'direct' })).toBeNull()
    expect(validateMobileE2EEV2Handshake({ type: 'e2ee_ready', v: 1 }, server.ready, { transport: 'direct' })).toBeNull()

    const frame = sealMobileE2EEV2Frame({
      payload: new Uint8Array([1, 2, 3]), key: new Uint8Array(32).fill(9), sessionId: new Uint8Array(32).fill(11),
      direction: 'mobile-to-desktop', payloadKind: 'binary', counter: 0n
    })
    const base = { frame, key: new Uint8Array(32).fill(9), sessionId: new Uint8Array(32).fill(11), direction: 'mobile-to-desktop' as const, payloadKind: 'binary' as const, expectedCounter: 0n }
    expect(openMobileE2EEV2Frame(base)).toEqual(new Uint8Array([1, 2, 3]))
    expect(openMobileE2EEV2Frame({ ...base, expectedCounter: 1n })).toBeNull()
    expect(openMobileE2EEV2Frame({ ...base, payloadKind: 'text' })).toBeNull()
    expect(openMobileE2EEV2Frame({ ...base, direction: 'desktop-to-mobile' })).toBeNull()
    expect(openMobileE2EEV2Frame({ ...base, sessionId: new Uint8Array(32).fill(12) })).toBeNull()
    server.dispose()
  })
})

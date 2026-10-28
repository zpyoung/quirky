import { describe, expect, test } from 'bun:test'
import type { MobileConnectionState, MobileRpc } from '../src/contracts'
import { createMobileRpc } from '../src/transport/client'
import { DEVICE_TOKEN, makeTestPeer, type TestPeer } from './transport-peer'

const randomBytes = (() => {
  let next = 1
  return (length: number) => new Uint8Array(length).fill(next++ & 0xff)
})()

function openPeer(
  peer: TestPeer,
  handshakeTimeoutMs = 500,
  onState?: (state: MobileConnectionState) => void
): Promise<MobileRpc> {
  return createMobileRpc({
    endpoint: 'ws://desktop.local:6768',
    publicKeyB64: peer.publicKeyB64,
    token: DEVICE_TOKEN,
    WebSocket: peer.WebSocket,
    randomBytes,
    connectTimeoutMs: 500,
    handshakeTimeoutMs,
    requestTimeoutMs: 500,
    onState
  })
}

async function connectedPeer(onRequest?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): Promise<{ peer: TestPeer; rpc: MobileRpc }> {
  const peer = makeTestPeer({ onRequest })
  const rpc = await openPeer(peer)
  return { peer, rpc }
}

function waitForAuthFailure(rpc: MobileRpc): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const observe = (state: MobileConnectionState) => {
    if (state.phase === 'auth-failed') resolve()
  }
  observe(rpc.state)
  rpc.onState(observe)
  return promise
}

describe('MobileRpc direct encrypted transport', () => {
  test('uses /rpc, sends typed JSON-RPC with requestId, maps event and terminal stream frames', async () => {
    const { peer, rpc } = await connectedPeer()
    expect(new URL(peer.sockets[0]!.url).pathname).toBe('/rpc')
    const result = await rpc.call<{ state: string }>('status.get', {}, { requestId: 'phone-check' })
    expect(result).toEqual({ state: 'ready' })
    expect(peer.requests[0]).toEqual({ method: 'status.get', params: {}, requestId: 'phone-check' })

    const events: { event: string; data: unknown }[] = []
    const eventSeen = new Promise<void>((resolve) => rpc.onEvent((event) => { events.push(event); resolve() }))
    peer.sockets[0]!.emitEvent({ type: 'quirky.ask/created', askId: 'ask_1' })
    await eventSeen
    expect(events).toEqual([{ event: 'quirky.ask/created', data: { type: 'quirky.ask/created', askId: 'ask_1' } }])

    const streams: Uint8Array[] = []
    const streamSeen = new Promise<void>((resolve) => rpc.onStream(43, (bytes) => { streams.push(bytes); resolve() }))
    peer.sockets[0]!.emitTerminal(43, new Uint8Array([65, 66, 67]))
    await streamSeen
    expect(streams).toEqual([new Uint8Array([65, 66, 67])])
    rpc.close()
  })

  test('bounds JSON parameters without duplicating the daemon method policy', async () => {
    const { peer, rpc } = await connectedPeer()
    await expect(rpc.call('quirky.repo/list', { deviceToken: DEVICE_TOKEN })).rejects.toThrow('identity')
    expect(await rpc.call('quirky.repo/list', {})).toEqual([])
    await expect(rpc.call('quirky.repo/list', { note: DEVICE_TOKEN })).rejects.toThrow('credential material')
    expect(peer.requests).toHaveLength(1)
    rpc.close()
  })

  test('rejects pending calls when the authenticated socket closes and does not replay them', async () => {
    let release!: (value: unknown) => void
    const { peer, rpc } = await connectedPeer(() => new Promise((resolve) => { release = resolve }))
    const pending = rpc.call('status.get', {})
    await Promise.resolve()
    peer.sockets[0]!.close(1001, 'network lost')
    await expect(pending).rejects.toThrow()
    expect(peer.requests).toHaveLength(1)
    release?.({ ok: true })
  })

  test('fails closed on a mismatched pinned public key', async () => {
    const peer = makeTestPeer()
    const wrongKey = makeTestPeer({ identitySeed: 38 }).publicKeyB64
    await expect(createMobileRpc({
      endpoint: 'ws://desktop.local:6768', publicKeyB64: wrongKey, token: DEVICE_TOKEN,
      WebSocket: peer.WebSocket, randomBytes, connectTimeoutMs: 500, handshakeTimeoutMs: 500, requestTimeoutMs: 500
    })).rejects.toThrow()
    expect(peer.authenticatedTokens).toHaveLength(0)
  })

  test('rejects malformed JSON-RPC responses and publishes the terminal connection state', async () => {
    const { peer, rpc } = await connectedPeer(() => new Promise(() => {}))
    const phases: string[] = []
    const unsubscribe = rpc.onState((state) => phases.push(state.phase))
    const pending = rpc.call('status.get', {})
    await Promise.resolve()
    peer.sockets[0]!.emitEncryptedText('{"jsonrpc":"2.0","id":1,"result":{"state":"ready"},"extra":true}')

    await expect(pending).rejects.toMatchObject({ kind: 'protocol' })
    expect(phases[0]).toBe('connected')
    expect(phases.at(-1)).toBe('auth-failed')
    unsubscribe()
  })

  test('redacts pairing credentials from remote RPC error messages', async () => {
    const { promise: unresolvedRequest } = Promise.withResolvers<unknown>()
    const { peer, rpc } = await connectedPeer(() => unresolvedRequest)
    const pending = rpc.call('status.get', {})
    await Promise.resolve()
    peer.sockets[0]!.emitEncryptedText(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: `Desktop error ${DEVICE_TOKEN}` }
    }))

    await expect(pending).rejects.toMatchObject({ kind: 'remote', message: 'Desktop RPC failed' })
    rpc.close()
  })

  test('times out an individual request without replaying it or closing the channel', async () => {
    const { promise: unresolvedRequest } = Promise.withResolvers<unknown>()
    const { peer, rpc } = await connectedPeer(() => unresolvedRequest)
    await expect(rpc.call('status.get', {}, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(peer.requests).toHaveLength(1)
    expect(rpc.state.phase).toBe('connected')
    rpc.close()
  })

  test('rejects a direct request that exceeds the daemon websocket frame bound', async () => {
    const { peer, rpc } = await connectedPeer()
    const params = { records: new Array(13).fill('x'.repeat(64 * 1024)) }
    await expect(rpc.call('quirky.repo/list', params)).rejects.toMatchObject({ kind: 'params' })
    expect(peer.requests).toHaveLength(0)
    expect(rpc.state.phase).toBe('connected')
    rpc.close()
  })

  test('rejects an authenticated proof with a bad hash, wrong version, or extra key', async () => {
    const invalidProofs = [
      (proof: Record<string, unknown>) => ({ ...proof, transcriptHashB64: 'A'.repeat(44) }),
      (proof: Record<string, unknown>) => ({ ...proof, v: 3 }),
      (proof: Record<string, unknown>) => ({ ...proof, extra: true })
    ]

    for (const invalidProof of invalidProofs) {
      const peer = makeTestPeer({ authenticationFrames: (proof) => [invalidProof(proof)] })
      await expect(openPeer(peer)).rejects.toMatchObject({ kind: 'auth-failed' })
      expect(peer.authenticatedTokens).toEqual([DEVICE_TOKEN])
    }
  })

  test('processes a queued RPC notification only after accepting the authenticated proof', async () => {
    const peer = makeTestPeer({
      authenticationFrames: (proof) => [
        proof,
        { jsonrpc: '2.0', method: 'event', params: { type: 'quirky.ask/created', askId: 'queued' } }
      ]
    })
    const rpc = await openPeer(peer)
    expect(rpc.state.phase).toBe('connected')
    await expect(rpc.call('status.get', {})).resolves.toEqual({ state: 'ready' })
    rpc.close()
  })

  test('does not connect when the daemon omits its authenticated proof', async () => {
    const peer = makeTestPeer({ holdAuthentication: true })
    await expect(openPeer(peer, 250)).rejects.toMatchObject({ kind: 'timeout' })
    expect(peer.authenticatedTokens).toEqual([DEVICE_TOKEN])
  })

  test('rejects an RPC message queued before the authenticated proof', async () => {
    const peer = makeTestPeer({
      authenticationFrames: (proof) => [
        { jsonrpc: '2.0', id: 1, result: { forged: true } },
        proof
      ]
    })
    await expect(openPeer(peer)).rejects.toMatchObject({ kind: 'protocol' })
  })

  test('rejects a duplicate authenticated proof', async () => {
    let proof: Record<string, unknown> | undefined
    const peer = makeTestPeer({
      authenticationFrames: (response) => {
        proof = response
        return [response]
      }
    })
    const rpc = await openPeer(peer)
    expect(proof).toBeDefined()
    const failed = waitForAuthFailure(rpc)
    peer.sockets[0]!.emitEncryptedText(JSON.stringify(proof!))
    await failed
    expect(rpc.state.phase).toBe('auth-failed')
  })

  test('classifies daemon auth errors without treating registry unavailability as invalid pairing', async () => {
    const unauthorized = makeTestPeer({ expectedToken: 'ffffffffffffffffffffffffffffffffffffffffffffffff' })
    await expect(openPeer(unauthorized)).rejects.toMatchObject({ kind: 'auth-failed' })

    const phases: MobileConnectionState['phase'][] = []
    const registryUnavailable = makeTestPeer({
      authenticationFrames: () => [{ type: 'e2ee_error', error: { code: 'registry_unavailable' } }]
    })
    await expect(openPeer(registryUnavailable, 500, (state) => phases.push(state.phase))).rejects.toMatchObject({
      kind: 'connection',
      code: 'registry_unavailable'
    })
    expect(phases.at(-1)).toBe('unreachable')
  })


  test('rejects encrypted binary stream data before authenticated proof', async () => {
    const peer = makeTestPeer({ preAuthenticationBinary: true })
    await expect(openPeer(peer)).rejects.toMatchObject({ kind: 'protocol' })
  })
  test('fails closed on a replayed authenticated frame', async () => {
    const { peer, rpc } = await connectedPeer()
    const failed = waitForAuthFailure(rpc)
    const proofFrame = peer.encryptedTextFrames[0]
    expect(proofFrame).toBeDefined()
    peer.sockets[0]!.emitEncryptedTextFrame(proofFrame!)
    await failed
    expect(rpc.state.phase).toBe('auth-failed')
  })

  test('fails closed on a gap in the encrypted desktop counter', async () => {
    const { peer, rpc } = await connectedPeer()
    const failed = waitForAuthFailure(rpc)
    peer.sockets[0]!.sealEncryptedText('discarded counter')
    const gapFrame = peer.sockets[0]!.sealEncryptedText('counter gap')
    peer.sockets[0]!.emitEncryptedTextFrame(gapFrame)
    await failed
    expect(rpc.state.phase).toBe('auth-failed')
  })
})

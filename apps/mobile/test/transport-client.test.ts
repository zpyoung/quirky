import { describe, expect, test } from 'bun:test'
import { createMobileRpc } from '../src/transport/client'
import { DEVICE_TOKEN, makeTestPeer } from './transport-peer'

const randomBytes = (() => {
  let next = 1
  return (length: number) => new Uint8Array(length).fill(next++ & 0xff)
})()

async function connectedPeer(onRequest?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>) {
  const peer = makeTestPeer({ onRequest })
  const rpc = await createMobileRpc({
    endpoint: 'ws://desktop.local:6768',
    publicKeyB64: peer.publicKeyB64,
    token: DEVICE_TOKEN,
    WebSocket: peer.WebSocket,
    randomBytes,
    connectTimeoutMs: 500,
    handshakeTimeoutMs: 500,
    requestTimeoutMs: 500
  })
  return { peer, rpc }
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
})

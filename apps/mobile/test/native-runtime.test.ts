import { describe, expect, test } from 'bun:test'
import { normalizeEditedEndpoint, previewMobileOffer } from '../src/native/pairing'
import { createMobileRuntime } from '../src/native/runtime'
import { DEVICE_TOKEN, makeTestPeer, pairingInput } from './transport-peer'

const native = {
  clipboardRead: async () => '', clipboardWrite: async () => {}, openExternal: async () => {}, haptic: async () => {},
  notificationPermission: async () => 'unavailable' as const, openSystemSettings: async () => {}
}

class MemoryStorage {
  values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
}

class MemorySecrets {
  values = new Map<string, string>()
  async read(hostId: string) { const token = this.values.get(hostId); return token ? { kind: 'available' as const, token } : { kind: 'missing' as const } }
  async write(hostId: string, token: string) { this.values.set(hostId, token) }
  async remove(hostId: string) { this.values.delete(hostId) }
}

function randomBytes() {
  let next = 1
  return (length: number) => new Uint8Array(length).fill(next++ & 0xff)
}

describe('native pairing runtime', () => {
  test('parses only canonical v2 mobile offers from a bare code or confirmed quirky link', () => {
    const bare = pairingInput()
    expect(previewMobileOffer(bare).endpoint).toBe('ws://desktop.local:6768')
    expect(previewMobileOffer(`quirky://pair?code=${bare}`).pairedDeviceId).toBe('00000000-0000-4000-8000-000000000001')
    expect(() => previewMobileOffer(`https://relay.example/pair?code=${bare}`)).toThrow()
    expect(() => previewMobileOffer(pairingInput({ endpoint: 'https://relay.example' }))).toThrow()
    expect(() => previewMobileOffer(pairingInput({ extra: { legacy: true } }))).toThrow()
    expect(() => previewMobileOffer(pairingInput({ token: 'not-a-device-token' }))).toThrow()
  })

  test('validates direct address edits and preserves the configured port for a bare host', () => {
    expect(normalizeEditedEndpoint('100.64.0.1', 'wss://desktop.local:6768')).toBe('wss://100.64.0.1:6768')
    expect(normalizeEditedEndpoint('wss://desktop.example:7443', 'ws://desktop.local:6768')).toBe('wss://desktop.example:7443')
    expect(() => normalizeEditedEndpoint('https://desktop.example', 'ws://desktop.local:6768')).toThrow()
    expect(() => normalizeEditedEndpoint('desktop.example/path', 'ws://desktop.local:6768')).toThrow()
  })
  test('rejects malformed offers before opening a websocket', async () => {
    const peer = makeTestPeer()
    const runtime = createMobileRuntime({ storage: new MemoryStorage(), secrets: new MemorySecrets(), native, WebSocket: peer.WebSocket, randomBytes: randomBytes() })
    await expect(runtime.pair(pairingInput({ extra: { connection: 'relay' } }))).rejects.toThrow()
    expect(peer.sockets).toHaveLength(0)
    runtime.dispose()
  })

  test('pairs through authenticated info, stores rotated credentials separately, and deduplicates pinned identity', async () => {
    const peer = makeTestPeer()
    const storage = new MemoryStorage()
    const secrets = new MemorySecrets()
    const runtime = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes: randomBytes() })
    const logs: { at: number; stage: string; message: string }[] = []
    const first = await runtime.pair(pairingInput(), (entry) => logs.push(entry))
    expect(first).toMatchObject({ machineName: 'test-desktop', platform: 'linux', endpoint: 'ws://desktop.local:6768' })
    expect(secrets.values.get(first.id)).toBe(DEVICE_TOKEN)
    expect([...storage.values.values()].join('\n')).not.toContain(DEVICE_TOKEN)
    expect(JSON.stringify(logs)).not.toContain(DEVICE_TOKEN)

    await runtime.editHost(first.id, { personalName: 'Work machine' })
    const rotated = 'abcdef0123456789abcdef0123456789abcdef0123456789'
    const second = await runtime.pair(pairingInput({ token: rotated }))
    expect(second.id).toBe(first.id)
    expect(second.personalName).toBe('Work machine')
    expect(await runtime.hosts()).toHaveLength(1)
    expect(secrets.values.get(first.id)).toBe(rotated)
    runtime.dispose()
  })

  test('does not publish a host when encrypted pairing does not finish', async () => {
    const peer = makeTestPeer({ holdReady: true })
    const runtime = createMobileRuntime({
      storage: new MemoryStorage(), secrets: new MemorySecrets(), native,
      WebSocket: peer.WebSocket, randomBytes: randomBytes(), pairingTimeoutMs: 20, connectTimeoutMs: 10, handshakeTimeoutMs: 10
    })
    const logs: { at: number; stage: string; message: string }[] = []
    await expect(runtime.pair(pairingInput(), (entry) => logs.push(entry))).rejects.toThrow()
    expect(logs.at(-1)?.stage.endsWith('-failed')).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(DEVICE_TOKEN)
    expect(await runtime.hosts()).toEqual([])
    expect(peer.authenticatedTokens).toHaveLength(0)
    runtime.dispose()
  })
  test('closes owned sockets and retries when foreground returns on a fresh channel', async () => {
    const peer = makeTestPeer()
    const runtime = createMobileRuntime({
      storage: new MemoryStorage(), secrets: new MemorySecrets(), native,
      WebSocket: peer.WebSocket, randomBytes: randomBytes()
    })
    runtime.setForeground(true)
    const host = await runtime.pair(pairingInput())
    expect(runtime.connectionState(host.id).phase).toBe('connected')
    runtime.setForeground(false)
    expect(runtime.connectionState(host.id).phase).toBe('disconnected')
    expect(peer.sockets[0]!.readyState).toBe(3)
    await expect(runtime.getRpc(host.id)).rejects.toThrow(/background/i)
    expect(peer.sockets).toHaveLength(1)

    let unsubscribe = () => {}
    const { promise: resumed, resolve: resume } = Promise.withResolvers<void>()
    unsubscribe = runtime.subscribe(() => {
      if (peer.sockets.length === 2 && runtime.connectionState(host.id).phase === 'connected') {
        unsubscribe()
        resume()
      }
    })
    runtime.setForeground(true)
    await resumed
    expect(peer.sockets).toHaveLength(2)

    let unsubscribeRetry = () => {}
    const { promise: retryScheduled, resolve: retry } = Promise.withResolvers<void>()
    unsubscribeRetry = runtime.subscribe(() => {
      if (runtime.connectionState(host.id).phase === 'reconnecting') {
        unsubscribeRetry()
        retry()
      }
    })
    peer.sockets[1]!.close(1001, 'network lost')
    await retryScheduled
    runtime.setForeground(false)
    expect(runtime.connectionState(host.id).phase).toBe('disconnected')
    expect(peer.sockets).toHaveLength(2)

    let unsubscribeAgain = () => {}
    const { promise: resumedAgain, resolve: resumeAgain } = Promise.withResolvers<void>()
    unsubscribeAgain = runtime.subscribe(() => {
      if (peer.sockets.length === 3 && runtime.connectionState(host.id).phase === 'connected') {
        unsubscribeAgain()
        resumeAgain()
      }
    })
    runtime.setForeground(true)
    await resumedAgain
    expect(peer.sockets).toHaveLength(3)
    runtime.dispose()
  })

  test('cancels an unconfirmed in-flight pairing without saving a host or credential', async () => {
    const peer = makeTestPeer({ holdReady: true })
    const storage = new MemoryStorage()
    const secrets = new MemorySecrets()
    const runtime = createMobileRuntime({
      storage, secrets, native, WebSocket: peer.WebSocket, randomBytes: randomBytes(),
      pairingTimeoutMs: 500, connectTimeoutMs: 500, handshakeTimeoutMs: 500
    })
    const pairing = runtime.pair(pairingInput())
    await Promise.resolve()
    runtime.cancelPairing()

    await expect(pairing).rejects.toThrow(/cancel/i)
    expect(await runtime.hosts()).toEqual([])
    expect(secrets.values.size).toBe(0)
    expect(peer.authenticatedTokens).toHaveLength(0)
    runtime.dispose()
  })
})

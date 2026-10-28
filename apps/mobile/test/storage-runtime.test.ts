import { describe, expect, test } from 'bun:test'
import { createMobileRuntime, type MobileRuntimeDependencies } from '../src/native/runtime'
import { DEVICE_TOKEN, makeTestPeer, pairingInput } from './transport-peer'
import type { MobileHost } from '../src/contracts'

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
class LockingSecrets {
  values = new Map<string, string>()
  locked = false
  async read(hostId: string) {
    if (this.locked) return { kind: 'unavailable' as const }
    const token = this.values.get(hostId)
    return token ? { kind: 'available' as const, token } : { kind: 'missing' as const }
  }
  async write(hostId: string, token: string) { if (this.locked) throw new Error('secure store unavailable'); this.values.set(hostId, token) }
  async remove(hostId: string) { if (this.locked) throw new Error('secure store unavailable'); this.values.delete(hostId) }
}
const randomBytes = (() => { let next = 1; return (length: number) => new Uint8Array(length).fill(next++ & 0xff) })()

describe('native secure storage lifecycle', () => {
  test('keeps credentials out of host metadata and preserves a durable retry record when deletion is locked', async () => {
    const peer = makeTestPeer()
    const storage = new MemoryStorage()
    const secrets = new LockingSecrets()
    const runtime = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    const host = await runtime.pair(pairingInput())
    const serialized = [...storage.values.values()].join('\n')
    expect(serialized).not.toContain(DEVICE_TOKEN)
    expect(serialized).not.toContain('deviceToken')

    secrets.locked = true
    expect(await runtime.removeHost(host.id)).toEqual({ cleanupPending: true })
    expect(await runtime.hosts()).toHaveLength(0)
    expect(await runtime.pendingCredentialCleanup()).toEqual([host.id])
    expect((await runtime.connectionState(host.id)).phase).toBe('credential-unavailable')
    expect(await runtime.retryCredentialCleanup()).toEqual([host.id])

    secrets.locked = false
    expect(await runtime.retryCredentialCleanup()).toEqual([])
    expect(await runtime.hosts()).toEqual([])
    expect(secrets.values.has(host.id)).toBe(false)
    runtime.dispose()
  })
  test('distinguishes a locked secure store from a missing pairing credential', async () => {
    const peer = makeTestPeer()
    const storage = new MemoryStorage()
    const secrets = new LockingSecrets()
    const runtime = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    const host = await runtime.pair(pairingInput())
    runtime.disconnect(host.id)

    secrets.locked = true
    runtime.setForeground(true)
    await expect(runtime.reconnect(host.id)).rejects.toThrow('Secure storage')
    expect(runtime.connectionState(host.id).phase).toBe('credential-unavailable')

    secrets.locked = false
    secrets.values.delete(host.id)
    await expect(runtime.reconnect(host.id)).rejects.toThrow('missing')
    expect(runtime.connectionState(host.id).phase).toBe('credential-missing')
    runtime.dispose()
  })


  test('stores only supported native preferences and retains defaults after restart', async () => {
    const peer = makeTestPeer()
    const storage = new MemoryStorage()
    const secrets = new LockingSecrets()
    const runtime = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    expect(await runtime.preferences()).toMatchObject({ sessionView: 'terminal', onboardingCompleted: false, notificationChoice: 'unset', terminalTextScale: 1 })
    await runtime.updatePreferences({ terminalTextScale: 1.5, autocomplete: false, terminalLinkMode: 'phone' })
    runtime.dispose()
    const restored = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    expect(await restored.preferences()).toMatchObject({ terminalTextScale: 1.5, autocomplete: false, terminalLinkMode: 'phone' })
    restored.dispose()
  })

  test('restores the direct-v2 latch and secure credential across a runtime restart', async () => {
    const peer = makeTestPeer()
    const storage = new MemoryStorage()
    const secrets = new LockingSecrets()
    const first = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    const host = await first.pair(pairingInput())
    first.dispose()

    const restored = createMobileRuntime({ storage, secrets, native, WebSocket: peer.WebSocket, randomBytes })
    expect(await restored.hosts()).toEqual([host])
    expect(JSON.stringify([...storage.values.values()])).toContain('"v2Latched":true')
    expect(JSON.stringify([...storage.values.values()])).not.toContain(DEVICE_TOKEN)
    restored.setForeground(true)
    await expect(restored.reconnect(host.id)).resolves.toMatchObject({ state: { phase: 'connected' } })
    expect(peer.authenticatedTokens).toEqual([DEVICE_TOKEN, DEVICE_TOKEN])
    restored.dispose()
  })

  test('evicts the least-recently-connected host and retires its socket and credential', async () => {
    const peers = Array.from({ length: 7 }, (_, index) => makeTestPeer({ identitySeed: 37 + index }))
    const peersByPort = new Map(peers.map((peer, index) => [String(6768 + index), peer]))
    const WebSocket = function (this: unknown, url: string) {
      const peer = peersByPort.get(new URL(url).port)
      if (!peer) throw new Error('unexpected test endpoint')
      return new peer.WebSocket(url)
    } as unknown as NonNullable<MobileRuntimeDependencies['WebSocket']>
    const storage = new MemoryStorage()
    const secrets = new LockingSecrets()
    let timestamp = 1
    const runtime = createMobileRuntime({ storage, secrets, native, WebSocket, randomBytes, now: () => timestamp++ })
    const paired: MobileHost[] = []
    for (let index = 0; index < peers.length; index++) {
      paired.push(await runtime.pair(pairingInput({
        endpoint: `ws://desktop.local:${6768 + index}`,
        token: String(index + 1).padStart(48, '0'),
        extra: { publicKeyB64: peers[index]!.publicKeyB64 }
      })))
    }

    const expected = paired.slice(1).map((host) => host.id).sort()
    expect((await runtime.hosts()).map((host) => host.id).sort()).toEqual(expected)
    expect(peers[0]!.sockets[0]?.readyState).toBe(3)
    expect(secrets.values.has(paired[0]!.id)).toBe(false)
    expect(await runtime.pendingCredentialCleanup()).toEqual([])
    runtime.dispose()
  })
})

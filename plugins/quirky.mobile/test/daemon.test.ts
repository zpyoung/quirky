import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MobileTestClient } from './support/client'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { RpcErrorCode } from '@quirky/protocol'
import { makeBuiltinDir } from '../../quirky.session/test/support'

let harness: Harness | undefined
let mobile: MobileTestClient | undefined
let savedPort: string | undefined
let savedHost: string | undefined
let savedEnvironment = false

async function boot(home?: string): Promise<Harness> {
  if (!savedEnvironment) {
    savedPort = process.env.QUIRKY_MOBILE_PORT
    savedHost = process.env.QUIRKY_MOBILE_HOST
    savedEnvironment = true
  }
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
  const isolatedHome = home ?? makeTempHome()
  return await startHarness({
    home: isolatedHome,
    builtinPluginsDir: makeBuiltinDir(isolatedHome, {
      real: ['quirky.mobile', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.ask', 'quirky.agent-status', 'quirky.worktree', 'quirky.repo', 'quirky.structured'],
      fakes: []
    })
  })
}

async function cleanupHarness(value: Harness): Promise<void> {
  for (const client of value.clients) await client.close()
  await value.daemon.stop()
  await value.pty.stop()
}
function socketCloseCode(client: MobileTestClient): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>()
  client.socket.once('close', resolve)
  return promise
}

afterEach(async () => {
  if (mobile) await mobile.close()
  mobile = undefined
  if (harness) await harness.cleanup()
  harness = undefined
  if (savedEnvironment) {
    if (savedPort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = savedPort
    if (savedHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
    else process.env.QUIRKY_MOBILE_HOST = savedHost
  }
  savedPort = undefined
  savedHost = undefined
  savedEnvironment = false
})

describe('mobile daemon integration', () => {
  test('pairs over a separate listener, isolates HTTP, survives restart, and revokes immediately', async () => {
    harness = await boot()
    const home = harness.home
    const api = await harness.connect('cli')
    const initial = await api.callAny('quirky.mobile/state', {}) as {
      listener: { available: boolean; host: string | null; port: number | null }
      devices: unknown[]
    }
    expect(initial.listener).toMatchObject({ available: true, host: '127.0.0.1' })
    expect(initial.listener.port).toBeGreaterThan(0)
    expect(initial.devices).toEqual([])
    const cliState = await runCli(['mobile', 'state', '--json'], { home })
    expect(cliState.code).toBe(0)
    expect(JSON.parse(cliState.stdout)).toMatchObject({ listener: { available: true, host: '127.0.0.1' } })
    const invalidEndpoint = await api.callAny('quirky.mobile/pair', { address: '0.0.0.0' }) as { available: boolean; reason?: string }
    expect(invalidEndpoint).toMatchObject({ available: false, reason: 'invalid_advertised_endpoint' })

    const first = await api.callAny('quirky.mobile/pair', { address: '192.0.2.17' }) as {
      available: true; pairingUrl: string; endpoint: string; deviceId: string; qrDataUrl: string | null; qrError?: string
    }
    const repeated = await api.callAny('quirky.mobile/pair', { address: '192.0.2.17' }) as typeof first
    expect(repeated.deviceId).toBe(first.deviceId)
    expect(repeated.pairingUrl).toBe(first.pairingUrl)
    const rotated = await api.callAny('quirky.mobile/pair', { address: '192.0.2.17', rotate: true }) as typeof first
    expect(rotated.pairingUrl).not.toBe(first.pairingUrl)
    expect(rotated.endpoint).toMatch(/^ws:\/\/192\.0\.2\.17:/)
    expect(rotated.qrDataUrl === null ? rotated.qrError : rotated.qrDataUrl.startsWith('data:image/')).toBeTruthy()

    const currentState = await api.callAny('quirky.mobile/state', {}) as { listener: { host: string; port: number }; devices: unknown[] }
    expect(currentState.devices).toEqual([])
    expect(currentState.listener.host).toBe('0.0.0.0')
    expect(JSON.stringify(currentState)).not.toContain('deviceToken')
    expect(JSON.stringify(currentState)).not.toContain(rotated.pairingUrl.split('code=')[1])
    const listenerBase = `http://127.0.0.1:${currentState.listener.port}`
    for (const path of ['/', '/health', '/assets/app.js', '/hook/test', '/ui']) {
      const response = await fetch(`${listenerBase}${path}`)
      expect(response.status).toBe(404)
    }

    const staleCode = new URL(first.pairingUrl).searchParams.get('code')!
    const staleOffer = JSON.parse(Buffer.from(staleCode, 'base64url').toString('utf8')) as { publicKeyB64: string; deviceToken: string }
    const stalePeer = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, staleOffer.publicKeyB64, staleOffer.deviceToken)
    await expect(stalePeer.authenticated).rejects.toThrow()
    await stalePeer.close()
    const offerCode = new URL(rotated.pairingUrl).searchParams.get('code')!
    const offer = JSON.parse(Buffer.from(offerCode, 'base64url').toString('utf8')) as {
      v: number; endpoint: string; deviceToken: string; publicKeyB64: string; pairedDeviceId: string; scope: string
    }
    expect(offer).toMatchObject({ v: 2, endpoint: rotated.endpoint, pairedDeviceId: rotated.deviceId, scope: 'mobile' })
    const burstPeer = MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64)
    await burstPeer.readyForAuthentication
    burstPeer.sendAuthenticationFrames(offer.deviceToken, 2)
    await burstPeer.authenticated
    const admittedStatus = await burstPeer.call('status.get', {}) as { clients: { role: string }[] }
    expect(admittedStatus.clients.filter((client) => client.role === 'mobile')).toHaveLength(1)
    await burstPeer.close()
    await waitForAsync(async () => {
      const current = await api.callAny('status.get', {}) as { clients: { role: string }[] }
      return current.clients.some((client) => client.role === 'mobile') ? undefined : true
    }, 5000)
    mobile = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await mobile.authenticated
    await api.callAny('quirky.mobile/configure', { machineName: 'Encrypted desktop' })
    await expect(mobile.call('quirky.mobile/info', {})).resolves.toEqual({ machineName: 'Encrypted desktop', platform: process.platform, deviceScope: 'mobile' })
    await expect(mobile.call('quirky.session/list', {})).resolves.toEqual([])
    await expect(mobile.call('daemon.stop', {})).rejects.toMatchObject({ code: -32001 })
    await mobile.call('status.get', {}, { requestId: 'cached-mobile-status' })
    await expect(mobile.call('status.get', {}, { requestId: 'cached-mobile-status', deviceToken: 'not-the-paired-token' })).rejects.toMatchObject({ code: -32001 })
    await expect(mobile.call('client.hello', { role: 'mobile', protocolVersion: 2 })).rejects.toMatchObject({ code: -32001 })
    const plaintextPeer = MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64)
    await plaintextPeer.readyForAuthentication
    const plaintextClose = socketCloseCode(plaintextPeer)
    plaintextPeer.sendPlaintext(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status.get', params: {} }))
    expect(await plaintextClose).toBe(4001)
    await plaintextPeer.close()

    const corruptPeer = MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64)
    await corruptPeer.readyForAuthentication
    const corruptClose = socketCloseCode(corruptPeer)
    corruptPeer.sendCorruptTextFrame()
    expect(await corruptClose).toBe(4001)
    await corruptPeer.close()
    expect(harness.notifications.filter((notification) => notification.title === 'A device tried to connect but is not paired')).toHaveLength(1)

    // Use the real socket timer to verify the ten-second pre-auth deadline and close code.
    const timedPeer = MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64)
    await timedPeer.readyForAuthentication
    expect(await socketCloseCode(timedPeer)).toBe(4002)
    await timedPeer.close()
    const damagedPeer = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await damagedPeer.authenticated
    const decryptClose = socketCloseCode(damagedPeer)
    for (let attempt = 0; attempt < 5; attempt++) damagedPeer.sendCorruptTextFrame()
    expect(await decryptClose).toBe(4003)
    await damagedPeer.close()
    const binaryRpcPeer = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await binaryRpcPeer.authenticated
    const binaryRpcClose = socketCloseCode(binaryRpcPeer)
    binaryRpcPeer.sendBinary(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'daemon.stop', params: {} })))
    expect(await binaryRpcClose).toBe(1003)
    await binaryRpcPeer.close()
    await expect(api.callAny('status.get', {})).resolves.toMatchObject({ daemonVersion: expect.any(String) })

    const oversizedPeer = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await oversizedPeer.authenticated
    const oversizedClose = socketCloseCode(oversizedPeer)
    oversizedPeer.sendBinary(new Uint8Array(1024 * 1024))
    expect(await oversizedClose).toBe(1009)
    await oversizedPeer.close()

    const session = await api.callAny('quirky.session/create', { worktree: 'floating', agent: 'shell' }) as { id: string }
    await waitFor(() => harness?.pty.sessions.has(session.id), 5000)
    const waitParams = { session: session.id, until: ['exited'], timeoutMs: 5000 }
    const waitingPeer = mobile
    const pendingWaits = Array.from({ length: 16 }, () => waitingPeer.call('quirky.agent-status/wait', waitParams))
    await expect(mobile.call('quirky.agent-status/wait', waitParams)).rejects.toMatchObject({ code: -32002 })
    await expect(mobile.call('status.get', {}, { params: undefined })).rejects.toMatchObject({ code: -32002 })
    expect(await Promise.all(pendingWaits)).toHaveLength(16)
    const attached = await mobile.call('quirky.terminal/attach', { session: session.id, cols: 70, rows: 20 }) as { streamId: number }
    await mobile.call('quirky.terminal/claim', { session: session.id, cols: 70, rows: 20 })
    const mobileTerminals = await mobile.call('quirky.terminal/mobileState', { session: session.id }) as { terminals: { session: string }[] }
    expect(mobileTerminals.terminals.map(({ session: terminal }) => terminal)).toContain(session.id)
    const secondSocket = MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    try {
      await secondSocket.authenticated
      await secondSocket.call('quirky.terminal/attach', { session: session.id, cols: 70, rows: 20 })
      const ownerState = await mobile.call('quirky.terminal/mobileState', { session: session.id }) as { terminals: { controlledByCaller: boolean }[] }
      const secondState = await secondSocket.call('quirky.terminal/mobileState', { session: session.id }) as { terminals: { controlledByCaller: boolean }[] }
      expect(ownerState.terminals[0]?.controlledByCaller).toBe(true)
      expect(secondState.terminals[0]?.controlledByCaller).toBe(false)
      await mobile.call('quirky.terminal/write', { session: session.id, data: 'owner socket input' })
      await expect(secondSocket.call('quirky.terminal/write', { session: session.id, data: 'same-token second socket input' }))
        .rejects.toMatchObject({ code: RpcErrorCode.Conflict })
      await expect(secondSocket.call('quirky.terminal/clear', { session: session.id }))
        .rejects.toMatchObject({ code: RpcErrorCode.Conflict })
      await expect(secondSocket.call('quirky.terminal/displayMode', { session: session.id, mode: 'desktop' }))
        .rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    } finally {
      await secondSocket.close()
    }
    const marker = 'mobile-encrypted-terminal-output'
    harness.pty.emit(session.id, marker)
    await waitFor(() => mobile!.binaryFrames.some((frame) => Buffer.from(frame).includes(Buffer.from(marker))), 5000)
    await mobile.call('quirky.terminal/detach', { streamId: attached.streamId })
    await api.callAny('quirky.mobile/pair', { address: '192.0.2.17', rotate: true })
    const pairedAfterRotate = await api.callAny('quirky.mobile/devices', {}) as { deviceId: string }[]
    expect(pairedAfterRotate.map(({ deviceId }) => deviceId)).toContain(rotated.deviceId)



    await mobile.close()
    mobile = undefined
    await cleanupHarness(harness)
    harness = await boot(home)
    const restartedApi = await harness.connect('cli')
    const restartedState = await restartedApi.callAny('quirky.mobile/state', {}) as {
      listener: { host: string; port: number }
      devices: { deviceId: string; lastSeenAt: number }[]
    }
    expect(restartedState.listener.host).toBe('0.0.0.0')
    expect(restartedState.devices).toContainEqual(expect.objectContaining({ deviceId: rotated.deviceId, lastSeenAt: expect.any(Number) }))

    mobile = MobileTestClient.connect(`ws://127.0.0.1:${restartedState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await mobile.authenticated
    const close = socketCloseCode(mobile)
    const revoked = await restartedApi.callAny('quirky.mobile/revoke', { deviceId: rotated.deviceId }) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
    expect(await close).toBe(4001)
    const reconnect = MobileTestClient.connect(`ws://127.0.0.1:${restartedState.listener.port}`, offer.publicKeyB64, offer.deviceToken)
    await expect(reconnect.authenticated).rejects.toThrow()
    await reconnect.close()
    mobile = undefined
  }, 60_000)

  test('ordinary answer IDs do not masquerade as caller identity', async () => {
    harness = await boot()
    const api = await harness.connect('cli')
    const pairing = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string; endpoint: string }
    const offer = JSON.parse(Buffer.from(new URL(pairing.pairingUrl).searchParams.get('code')!, 'base64url').toString()) as { publicKeyB64: string; deviceToken: string }
    const connected = MobileTestClient.connect(pairing.endpoint, offer.publicKeyB64, offer.deviceToken)
    mobile = connected
    await connected.authenticated
    const { askId } = await api.callAny('quirky.ask/create', { spec: { questions: [{ id: 'role', type: 'text', question: 'Which role?' }] } }) as { askId: string }
    const answer = { askId, answers: { role: { value: 'developer', source: 'input' } } }
    await expect(connected.call('quirky.ask/answer', { ...answer, role: 'ui' })).rejects.toMatchObject({ code: -32001 })
    await connected.call('quirky.ask/answer', answer)
    await expect(api.callAny('quirky.ask/wait', { askId, timeoutMs: 0 })).resolves.toMatchObject({
      status: 'answered', answers: { role: { value: 'developer', source: 'input' } }
    })
  })

  test('returns a request-scoped reply_too_large error and keeps the sealed session usable', async () => {
    const home = makeTempHome('quirky-mobile-reply-')
    const producer = join(home, 'plugins', 'acme.large-reply')
    mkdirSync(producer, { recursive: true })
    writeFileSync(join(producer, 'quirky-plugin.json'), JSON.stringify({
      id: 'acme.large-reply', name: 'Large reply producer', version: '0.1.0', main: 'main.ts',
      overrides: [{
        id: 'method:quirky.terminal/history', readOnly: true,
        params: { type: 'object', properties: { session: { type: 'string' }, lines: { type: 'integer' } }, required: ['session'], additionalProperties: false }
      }]
    }))
    writeFileSync(join(producer, 'main.ts'), `
      export function activate(context) {
        context.provide('method:quirky.terminal/history', () => ({ lines: ['x'.repeat(4 * 1024 * 1024 + 100)], cursor: null }))
      }
    `)
    harness = await boot(home)
    const api = await harness.connect('cli')
    const result = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string; endpoint: string }
    const offer = JSON.parse(Buffer.from(new URL(result.pairingUrl).searchParams.get('code')!, 'base64url').toString()) as { publicKeyB64: string; deviceToken: string }
    mobile = MobileTestClient.connect(result.endpoint, offer.publicKeyB64, offer.deviceToken)
    await mobile.authenticated
    await expect(mobile.call('quirky.terminal/history', { session: 'large-reply', lines: 1 })).rejects.toMatchObject({ code: -32005 })
    await expect(mobile.call('status.get')).resolves.toMatchObject({ daemonVersion: expect.any(String) })
  })

  test('fails pairing closed when the persistent identity is corrupt', async () => {
    const home = makeTempHome('quirky-mobile-key-')
    const dataDir = join(home, 'plugin-data', 'quirky.mobile')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'e2ee-keypair.json'), '{broken', { mode: 0o600 })
    writeFileSync(join(dataDir, 'devices.json'), '[]', { mode: 0o600 })
    harness = await boot(home)
    const api = await harness.connect('cli')
    const result = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { available: boolean; reason?: string }
    expect(result).toMatchObject({ available: false, reason: 'e2ee_key_unavailable' })
    expect(readdirSync(dataDir).some((name) => name.includes('e2ee-keypair.json.corrupt'))).toBe(true)
    expect(await api.callAny('quirky.mobile/devices', {})).toEqual([])
  })

  test('fails pairing closed and quarantines a corrupt device registry', async () => {
    const home = makeTempHome('quirky-mobile-registry-')
    const dataDir = join(home, 'plugin-data', 'quirky.mobile')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'devices.json'), '{broken', { mode: 0o600 })
    harness = await boot(home)
    const api = await harness.connect('cli')
    const result = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { available: boolean; reason?: string }
    expect(result).toMatchObject({ available: false, reason: 'device_registry_unavailable' })
    expect(readdirSync(dataDir).some((name) => name.includes('devices.json.corrupt'))).toBe(true)
  })
})

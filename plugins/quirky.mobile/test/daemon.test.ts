import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MobileTestClient } from './support/client'
import { startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { RpcErrorCode, type ApiDescription, type MobilePairingOffer, type MobilePairingResult, type OwnerCliPairOffer } from '@quirky/protocol'
import { MobileStore } from '../src/daemon/storage'
import { OwnerGrantStore } from '../src/daemon/owner-store'
import type { MobilePairingResetResult } from '../src/daemon/service'
import { Store } from '../../../packages/daemon/src/store'
import { makeBuiltinDir } from '../../quirky.session/test/support'

const ENV_KEYS = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'QUIRKY_MOBILE_PORT', 'QUIRKY_MOBILE_HOST'] as const
const ownedRoots: string[] = []
const mobileClients = new Set<MobileTestClient>()
let harness: Harness | undefined
let mobile: MobileTestClient | undefined
let savedEnvironment: Map<string, string | undefined> | undefined

function isolatedHome(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  ownedRoots.push(root)
  const quirkyHome = join(root, 'quirky-home')
  const worktrees = join(root, 'worktrees')
  for (const path of [quirkyHome, join(root, 'user-home'), join(root, 'xdg-config'), worktrees]) {
    mkdirSync(path, { recursive: true })
  }
  const store = new Store(join(quirkyHome, 'quirky.db'))
  try {
    store.setSettingValue('setting:quirky.agent-status/hooks', false)
    store.setSettingValue('setting:quirky.worktree/worktreesRoot', realpathSync(worktrees))
  } finally {
    store.close()
  }
  return quirkyHome
}

function trackMobileClient(client: MobileTestClient): MobileTestClient {
  mobileClients.add(client)
  return client
}

async function boot(home?: string, log?: (message: string) => void): Promise<Harness> {
  savedEnvironment ??= new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const isolated = home ?? isolatedHome('quirky-mobile-')
  const root = dirname(isolated)
  const userHome = join(root, 'user-home')
  process.env.HOME = userHome
  process.env.CODEX_HOME = join(userHome, '.codex')
  process.env.CLAUDE_CONFIG_DIR = join(userHome, '.claude')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg-config')
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
  return await startHarness({
    home: isolated,
    builtinPluginsDir: makeBuiltinDir(isolated, {
      real: ['quirky.mobile', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.ask', 'quirky.agent-status', 'quirky.worktree', 'quirky.repo', 'quirky.structured', 'quirky.cli'],
      fakes: []
    }),
    ...(log ? { log } : {})
  })
}

async function cleanupHarness(value: Harness): Promise<void> {
  const errors: unknown[] = []
  for (const client of value.clients) {
    try { await client.close() } catch (error) { errors.push(error) }
  }
  try { await value.daemon.stop() } catch (error) { errors.push(error) }
  try { value.pty.stop() } catch (error) { errors.push(error) }
  if (errors.length > 0) throw new AggregateError(errors, 'Mobile daemon restart cleanup failed')
}
function socketCloseCode(client: MobileTestClient): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>()
  client.socket.once('close', resolve)
  return promise
}

afterEach(async () => {
  const errors: unknown[] = []
  for (const client of mobileClients) {
    try { await client.close() } catch (error) { errors.push(error) }
  }
  mobileClients.clear()
  mobile = undefined
  if (harness) {
    try { await harness.cleanup() } catch (error) { errors.push(error) }
  }
  harness = undefined
  if (savedEnvironment) {
    for (const [key, value] of savedEnvironment) {
      try {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      } catch (error) {
        errors.push(error)
      }
    }
  }
  savedEnvironment = undefined
  for (const root of ownedRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Mobile daemon test cleanup failed')
})

const RESET_GUIDANCE = 'Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.'

function seedPairing(dataDir: string): { publicKeyB64: string; token: string; deviceId: string } {
  const store = new MobileStore(dataDir)
  try {
    const pending = store.getOrCreatePending(false)
    expect(store.authenticate(pending.token, 100).status).toBe('paired')
    return { publicKeyB64: store.publicKeyB64!, token: pending.token, deviceId: pending.deviceId }
  } finally {
    store.dispose()
  }
}

function phoneOffer(pairing: MobilePairingResult): MobilePairingOffer {
  expect(pairing.available).toBe(true)
  if (!pairing.available) throw new Error(pairing.reason)
  return JSON.parse(Buffer.from(new URL(pairing.pairingUrl).searchParams.get('code')!, 'base64url').toString())
}

async function rpcFailure(promise: Promise<unknown>): Promise<Error & { code: number }> {
  let failure: unknown
  try { await promise } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  return failure as Error & { code: number }
}

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
    const stalePeer = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, staleOffer.publicKeyB64, staleOffer.deviceToken))
    await expect(stalePeer.authenticated).rejects.toThrow()
    await stalePeer.close()
    const offerCode = new URL(rotated.pairingUrl).searchParams.get('code')!
    const offer = JSON.parse(Buffer.from(offerCode, 'base64url').toString('utf8')) as {
      v: number; endpoint: string; deviceToken: string; publicKeyB64: string; pairedDeviceId: string; scope: string
    }
    expect(offer).toMatchObject({ v: 2, endpoint: rotated.endpoint, pairedDeviceId: rotated.deviceId, scope: 'mobile' })
    const burstPeer = trackMobileClient(MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64))
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
    mobile = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await mobile.authenticated
    await api.callAny('quirky.mobile/configure', { machineName: 'Encrypted desktop' })
    await expect(mobile.call('quirky.mobile/info', {})).resolves.toEqual({ machineName: 'Encrypted desktop', platform: process.platform, deviceScope: 'mobile' })
    await expect(mobile.call('quirky.session/list', {})).resolves.toEqual([])
    await expect(mobile.call('daemon.stop', {})).rejects.toMatchObject({ code: -32001 })
    await mobile.call('status.get', {}, { requestId: 'cached-mobile-status' })
    await expect(mobile.call('status.get', {}, { requestId: 'cached-mobile-status', deviceToken: 'not-the-paired-token' })).rejects.toMatchObject({ code: -32001 })
    await expect(mobile.call('status.get', {}, { scope: 'cli' })).rejects.toMatchObject({ code: -32001 })
    await expect(mobile.call('client.hello', { role: 'mobile', protocolVersion: 2 })).rejects.toMatchObject({ code: -32001 })
    const plaintextPeer = trackMobileClient(MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64))
    await plaintextPeer.readyForAuthentication
    const plaintextClose = socketCloseCode(plaintextPeer)
    plaintextPeer.sendPlaintext(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status.get', params: {} }))
    expect(await plaintextClose).toBe(4001)
    await plaintextPeer.close()

    const corruptPeer = trackMobileClient(MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64))
    await corruptPeer.readyForAuthentication
    const corruptClose = socketCloseCode(corruptPeer)
    corruptPeer.sendCorruptTextFrame()
    expect(await corruptClose).toBe(4001)
    await corruptPeer.close()
    expect(harness.notifications.filter((notification) => notification.title === 'A device tried to connect but is not paired')).toHaveLength(1)

    // Use the real socket timer to verify the ten-second pre-auth deadline and close code.
    const timedPeer = trackMobileClient(MobileTestClient.connectWithoutAuthentication(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64))
    await timedPeer.readyForAuthentication
    expect(await socketCloseCode(timedPeer)).toBe(4002)
    await timedPeer.close()
    const damagedPeer = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await damagedPeer.authenticated
    const decryptClose = socketCloseCode(damagedPeer)
    for (let attempt = 0; attempt < 5; attempt++) damagedPeer.sendCorruptTextFrame()
    expect(await decryptClose).toBe(4003)
    await damagedPeer.close()
    const binaryRpcPeer = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await binaryRpcPeer.authenticated
    const binaryRpcClose = socketCloseCode(binaryRpcPeer)
    binaryRpcPeer.sendBinary(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'daemon.stop', params: {} })))
    expect(await binaryRpcClose).toBe(1003)
    await binaryRpcPeer.close()
    await expect(api.callAny('status.get', {})).resolves.toMatchObject({ daemonVersion: expect.any(String) })

    const oversizedPeer = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
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
    const secondSocket = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${currentState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
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

    mobile = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${restartedState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await mobile.authenticated
    const close = socketCloseCode(mobile)
    const revoked = await restartedApi.callAny('quirky.mobile/revoke', { deviceId: rotated.deviceId }) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
    expect(await close).toBe(4001)
    const reconnect = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${restartedState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await expect(reconnect.authenticated).rejects.toThrow()
    await reconnect.close()
    mobile = undefined
  }, 60_000)

  test('ordinary answer IDs do not masquerade as caller identity', async () => {
    harness = await boot()
    const api = await harness.connect('cli')
    const pairing = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string; endpoint: string }
    const offer = JSON.parse(Buffer.from(new URL(pairing.pairingUrl).searchParams.get('code')!, 'base64url').toString()) as { publicKeyB64: string; deviceToken: string }
    const connected = trackMobileClient(MobileTestClient.connect(pairing.endpoint, offer.publicKeyB64, offer.deviceToken))
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
    const home = isolatedHome('quirky-mobile-reply-')
    const producer = join(home, 'plugins', 'acme.large-reply')
    mkdirSync(producer, { recursive: true })
    writeFileSync(join(producer, 'quirky-plugin.json'), JSON.stringify({
      id: 'acme.large-reply', name: 'Large reply producer', apiVersion: '1.0.0', version: '0.1.0', main: 'main.ts',
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
    mobile = trackMobileClient(MobileTestClient.connect(result.endpoint, offer.publicKeyB64, offer.deviceToken))
    await mobile.authenticated
    await expect(mobile.call('quirky.terminal/history', { session: 'large-reply', lines: 1 })).rejects.toMatchObject({ code: -32005 })
    await expect(mobile.call('status.get')).resolves.toMatchObject({ daemonVersion: expect.any(String) })
  })

  test('fails pairing closed when the persistent identity is corrupt', async () => {
    const home = isolatedHome('quirky-mobile-key-')
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
    const home = isolatedHome('quirky-mobile-registry-')
    const dataDir = join(home, 'plugin-data', 'quirky.mobile')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'devices.json'), '{broken', { mode: 0o600 })
    harness = await boot(home)
    const api = await harness.connect('cli')
    const result = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { available: boolean; reason?: string; guidance?: string }
    expect(result).toMatchObject({ available: false, reason: 'device_registry_unavailable' })
    expect(result.guidance).not.toContain('reset-pairing')
    expect(readdirSync(dataDir).some((name) => name.includes('devices.json.corrupt'))).toBe(true)
  })
  test('owner-cli grants authorize full encrypted callers without widening mobile credentials', async () => {
    harness = await boot()
    const api = await harness.connect('cli')
    const paired = await api.callAny('quirky.mobile/ownerPair', {
      name: 'Owner terminal',
      confirm: true,
      address: '127.0.0.1'
    }) as {
      available: true
      endpoint: string
      offer: string
      grant: { grantId: string; name: string; scope: 'owner-cli' }
    }
    const ownerOffer = JSON.parse(Buffer.from(paired.offer, 'base64url').toString('utf8')) as {
      v: number; endpoint: string; deviceToken: string; publicKeyB64: string; pairedDeviceId: string; scope: string
    }
    expect(ownerOffer).toMatchObject({ v: 2, scope: 'owner-cli', endpoint: paired.endpoint, pairedDeviceId: paired.grant.grantId })
    expect(JSON.stringify(paired.grant)).not.toContain(ownerOffer.deviceToken)

    mobile = trackMobileClient(MobileTestClient.connect(paired.endpoint, ownerOffer.publicKeyB64, ownerOffer.deviceToken))
    await mobile.authenticated
    const description = await mobile.call('api.describe', {}) as { methods: { name: string }[] }
    expect(description.methods.some(({ name }) => name === 'quirky.mobile/ownerPair')).toBe(true)
    expect(await mobile.call('quirky.mobile/ownerGrants', {})).toMatchObject([
      { grantId: paired.grant.grantId, name: 'Owner terminal', scope: 'owner-cli' }
    ])
    const rolesBeforeHello = (await mobile.call('status.get', {}) as { clients: { role: string }[] }).clients.map(({ role }) => role)
    await expect(mobile.call('client.hello', {
      role: 'ui',
      protocolVersion: 2,
      desktopClientId: '123e4567-e89b-42d3-a456-426614174000'
    })).rejects.toMatchObject({ code: RpcErrorCode.Unauthorized })
    const rolesAfterHello = (await mobile.call('status.get', {}) as { clients: { role: string }[] }).clients.map(({ role }) => role)
    expect(rolesAfterHello).toEqual(rolesBeforeHello)
    await expect(mobile.call('status.get', { ownerGrantId: paired.grant.grantId })).rejects.toMatchObject({ code: -32001 })
    await expect(mobile.call('status.get', {}, { ownerGrantId: paired.grant.grantId })).rejects.toMatchObject({ code: -32001 })

    const phonePair = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { available: true; pairingUrl: string }
    const phoneCode = new URL(phonePair.pairingUrl).searchParams.get('code')!
    const phoneOffer = JSON.parse(Buffer.from(phoneCode, 'base64url').toString('utf8')) as {
      endpoint: string; publicKeyB64: string; deviceToken: string; scope: string
    }
    expect(phoneOffer.scope).toBe('mobile')
    const phone = trackMobileClient(MobileTestClient.connect(phoneOffer.endpoint, phoneOffer.publicKeyB64, phoneOffer.deviceToken))
    try {
      await phone.authenticated
      await expect(phone.call('quirky.mobile/ownerGrants', {})).rejects.toMatchObject({ code: -32001 })
      await expect(phone.call('status.get', {}, { role: 'cli', ownerGrantId: paired.grant.grantId }))
        .rejects.toMatchObject({ code: -32001 })
      await expect(phone.call('quirky.mobile/ownerPair', { name: 'Spoofed', confirm: true, role: 'cli' }))
        .rejects.toMatchObject({ code: -32001 })
    } finally {
      await phone.close()
    }

    const closed = socketCloseCode(mobile)
    await api.callAny('quirky.mobile/ownerRevoke', { grantId: paired.grant.grantId, confirm: true })
    expect(await closed).toBe(4001)
    const revokedReconnect = trackMobileClient(MobileTestClient.connect(paired.endpoint, ownerOffer.publicKeyB64, ownerOffer.deviceToken))
    await expect(revokedReconnect.authenticated).rejects.toThrow()
    await revokedReconnect.close()
  })

  test('owner-cli grants persist across restart and a corrupt registry is set aside', async () => {
    const home = isolatedHome('quirky-owner-grant-')
    harness = await boot(home)
    const api = await harness.connect('cli')
    const paired = await api.callAny('quirky.mobile/ownerPair', {
      name: 'Persistent owner',
      confirm: true,
      address: '127.0.0.1'
    }) as { endpoint: string; offer: string; grant: { grantId: string } }
    const offer = JSON.parse(Buffer.from(paired.offer, 'base64url').toString('utf8')) as {
      publicKeyB64: string; deviceToken: string
    }

    const active = trackMobileClient(MobileTestClient.connect(paired.endpoint, offer.publicKeyB64, offer.deviceToken))
    await active.authenticated
    await active.close()
    await cleanupHarness(harness)
    harness = await boot(home)
    const restartedApi = await harness.connect('cli')
    const restartedState = await restartedApi.callAny('quirky.mobile/state', {}) as { listener: { port: number } }
    const restartedEndpoint = `ws://127.0.0.1:${restartedState.listener.port}`
    const afterRestart = trackMobileClient(MobileTestClient.connect(restartedEndpoint, offer.publicKeyB64, offer.deviceToken))
    await afterRestart.authenticated
    await expect(afterRestart.call('quirky.mobile/ownerGrants', {})).resolves.toMatchObject([
      { grantId: paired.grant.grantId }
    ])
    await afterRestart.close()

    writeFileSync(join(home, 'plugin-data', 'quirky.mobile', 'owner-grants.json'), '{broken', { mode: 0o600 })
    await cleanupHarness(harness)
    harness = await boot(home)
    const corruptedApi = await harness.connect('cli')
    const grants = await corruptedApi.callAny('quirky.mobile/ownerGrants', {})
    expect(grants).toEqual([])
    const quarantined = readdirSync(join(home, 'plugin-data', 'quirky.mobile'))
      .filter((name) => /^owner-grants\.json\.corrupt-\d+-[0-9a-f]{8}$/.test(name))
    expect(quarantined).toHaveLength(1)
    const corruptedState = await corruptedApi.callAny('quirky.mobile/state', {}) as { listener: { port: number } }
    const deniedAfterCorruption = trackMobileClient(MobileTestClient.connect(`ws://127.0.0.1:${corruptedState.listener.port}`, offer.publicKeyB64, offer.deviceToken))
    await expect(deniedAfterCorruption.authenticated).rejects.toThrow()
    await deniedAfterCorruption.close()
  })
  test('generated owner grant commands require explicit confirmation and keep list output secret-free', async () => {
    harness = await boot()
    const home = harness.home
    const unconfirmed = await runCli(['mobile', 'owner-pair', '--name', 'No confirmation', '--address', '127.0.0.1', '--json'], { home })
    expect(unconfirmed.code).toBe(2)
    const paired = await runCli(['mobile', 'owner-pair', '--name', 'CLI owner', '--address', '127.0.0.1', '--confirm', '--json'], { home })
    expect(paired.code).toBe(0)
    const result = JSON.parse(paired.stdout) as {
      offer: string
      grant: { grantId: string; name: string; scope: string }
    }
    expect(result.grant).toMatchObject({ name: 'CLI owner', scope: 'owner-cli' })
    const offer = JSON.parse(Buffer.from(result.offer, 'base64url').toString('utf8')) as { deviceToken: string }
    const grants = await runCli(['mobile', 'owner-grants', '--json'], { home })
    expect(grants.code).toBe(0)
    expect(grants.stdout).not.toContain(result.offer)
    expect(grants.stdout).not.toContain(offer.deviceToken)
    expect(JSON.parse(grants.stdout)).toMatchObject([{ grantId: result.grant.grantId, scope: 'owner-cli' }])
    const revoked = await runCli(['mobile', 'owner-revoke', result.grant.grantId, '--confirm', '--json'], { home })
    expect(revoked.code).toBe(0)
    expect(JSON.parse(revoked.stdout)).toEqual({ revoked: true })
  })

  test('reset-pairing restores pairing after only the device registry was set aside', async () => {
    const home = isolatedHome('quirky-mobile-reset-registry-')
    const dataDir = join(home, 'plugin-data', 'quirky.mobile')
    const seeded = seedPairing(dataDir)
    const identityBytes = readFileSync(join(dataDir, 'e2ee-keypair.json'))
    writeFileSync(join(dataDir, 'devices.json'), '{broken', { mode: 0o600 })
    const logs: string[] = []
    harness = await boot(home, (line) => logs.push(line))
    const api = await harness.connect('cli')
    const unavailable = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' })
    expect(unavailable).toMatchObject({ available: false, reason: 'device_registry_unavailable', guidance: RESET_GUIDANCE })
    const registryPath = join(dataDir, 'devices.json')
    expect((await rpcFailure(api.callAny('quirky.mobile/resetPairing', { confirm: true }))).code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(existsSync(registryPath)).toBe(false)
    expect((await rpcFailure(api.callAny('quirky.mobile/resetPairing', { confirm: false, yes: true }))).code).toBe(RpcErrorCode.InvalidParams)

    const pairedOwner = await api.callAny('quirky.mobile/ownerPair', {
      name: 'Remote owner', confirm: true, address: '127.0.0.1'
    }) as { endpoint: string; offer: string }
    const ownerOffer = JSON.parse(Buffer.from(pairedOwner.offer, 'base64url').toString()) as OwnerCliPairOffer
    const owner = trackMobileClient(MobileTestClient.connect(pairedOwner.endpoint, ownerOffer.publicKeyB64, ownerOffer.deviceToken))
    await owner.authenticated
    const pendingAsks = (await api.callAny('quirky.ask/list', { pendingOnly: true }) as unknown[]).length
    for (const params of [{ confirm: true }, { confirm: true, yes: true }]) {
      expect((await rpcFailure(owner.call('quirky.mobile/resetPairing', params))).code).toBe(RpcErrorCode.Unauthorized)
      expect((await api.callAny('quirky.ask/list', { pendingOnly: true }) as unknown[]).length).toBe(pendingAsks)
    }
    expect(existsSync(registryPath)).toBe(false)
    expect(await owner.call('status.get')).toMatchObject({ daemonVersion: expect.any(String) })

    expect((await runCli(['mobile', 'reset-pairing', '--json'], { home })).code).toBe(2)
    expect((await runCli(['mobile', 'reset-pairing', 'extra', '--confirm', '--json'], { home })).code).toBe(2)
    const reset = await runCli(['--yes', 'mobile', 'reset-pairing', '--confirm', '--json'], { home })
    expect(reset.code).toBe(0)
    const quarantined = readdirSync(dataDir).filter((name) => /^devices\.json\.corrupt-\d+-[0-9a-f]{8}$/.test(name))
    expect(quarantined).toHaveLength(1)
    expect(JSON.parse(reset.stdout)).toEqual({
      identityCreated: false, unpairedDevices: 0, ownerGrantsRevoked: 0, ownerGrantsRemaining: 1,
      previousRegistry: null, quarantined, unsynced: []
    })
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual([])
    expect(readFileSync(join(dataDir, 'e2ee-keypair.json'))).toEqual(identityBytes)
    expect(readFileSync(join(dataDir, quarantined[0]!), 'utf8')).toBe('{broken')
    expect(logs).toContain('quirky.mobile: mobile: pairing reset; identity created false, 0 paired devices and 0 owner CLI grants must pair again')
    expect(owner.socket.readyState).toBe(1)
    expect(await owner.call('status.get')).toMatchObject({ daemonVersion: expect.any(String) })
    const duplicate = await rpcFailure(api.callAny('quirky.mobile/resetPairing', { confirm: true, yes: true }))
    expect(duplicate.code).toBe(RpcErrorCode.Conflict)
    expect(duplicate.message).toStartWith('pairing_available:')

    const offer = phoneOffer(await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as MobilePairingResult)
    expect(offer.publicKeyB64).toBe(seeded.publicKeyB64)
    const phone = trackMobileClient(MobileTestClient.connect(offer.endpoint, offer.publicKeyB64, offer.deviceToken))
    await phone.authenticated
    expect((await rpcFailure(phone.call('quirky.mobile/resetPairing', { confirm: true }))).code).toBe(RpcErrorCode.Unauthorized)
    const pairedApi = await phone.call('quirky.mobile/api') as ApiDescription
    expect(pairedApi.methods.some(({ name }) => name === 'quirky.mobile/resetPairing')).toBe(false)
    const localApi = await api.callAny('api.describe', {}) as ApiDescription
    expect(localApi.methods.find(({ name }) => name === 'quirky.mobile/resetPairing')).toMatchObject({ destructive: true })
    await phone.close()
    await owner.close()
    await cleanupHarness(harness)
    harness = await boot(home)
    const restartedApi = await harness.connect('cli')
    expect(await restartedApi.callAny('quirky.mobile/devices', {})).toContainEqual(expect.objectContaining({ deviceId: offer.pairedDeviceId }))
  }, 60_000)

  test('reset-pairing creates a new identity after only the identity was set aside and revokes owner grants', async () => {
    const home = isolatedHome('quirky-mobile-reset-identity-')
    const dataDir = join(home, 'plugin-data', 'quirky.mobile')
    const seeded = seedPairing(dataDir)
    const registryBytes = readFileSync(join(dataDir, 'devices.json'))
    const oldOwner = new OwnerGrantStore(dataDir).create('Old owner', 'ws://127.0.0.1:1')
    writeFileSync(join(dataDir, 'e2ee-keypair.json'), '{broken', { mode: 0o600 })
    harness = await boot(home)
    const api = await harness.connect('cli')
    expect(await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' })).toMatchObject({
      available: false, reason: 'e2ee_key_unavailable', guidance: RESET_GUIDANCE
    })
    const reset = await api.callAny('quirky.mobile/resetPairing', { confirm: true, yes: true }) as MobilePairingResetResult
    expect(reset).toEqual({
      identityCreated: true, unpairedDevices: 1, ownerGrantsRevoked: 1, ownerGrantsRemaining: 0,
      previousRegistry: expect.stringMatching(/^devices\.json\.reset-\d+-[0-9a-f]{8}$/),
      quarantined: [expect.stringMatching(/^e2ee-keypair\.json\.corrupt-\d+-[0-9a-f]{8}$/)], unsynced: []
    })
    expect(await api.callAny('quirky.mobile/ownerGrants', {})).toEqual([])
    expect(await api.callAny('quirky.mobile/devices', {})).toEqual([])
    expect(readFileSync(join(dataDir, reset.previousRegistry!))).toEqual(registryBytes)
    expect(registryBytes.toString()).toContain(seeded.deviceId)
    const identity = JSON.parse(readFileSync(join(dataDir, 'e2ee-keypair.json'), 'utf8')) as { publicKeyB64: string }
    expect(identity.publicKeyB64).not.toBe(seeded.publicKeyB64)
    const offer = phoneOffer(await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as MobilePairingResult)
    expect(offer.publicKeyB64).toBe(identity.publicKeyB64)
    const phone = trackMobileClient(MobileTestClient.connect(offer.endpoint, offer.publicKeyB64, offer.deviceToken))
    await phone.authenticated
    for (const token of [seeded.token, oldOwner.token]) {
      const stale = trackMobileClient(MobileTestClient.connect(offer.endpoint, offer.publicKeyB64, token))
      let failure: unknown
      try { await stale.authenticated } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      await stale.close()
    }
  }, 60_000)

  test('reset-pairing closes phone connections the old registry authorized', async () => {
    harness = await boot()
    const api = await harness.connect('cli')
    const offer = phoneOffer(await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as MobilePairingResult)
    const phone = trackMobileClient(MobileTestClient.connect(offer.endpoint, offer.publicKeyB64, offer.deviceToken))
    await phone.authenticated
    const pairedOwner = await api.callAny('quirky.mobile/ownerPair', {
      name: 'Retained owner', confirm: true, address: '127.0.0.1'
    }) as { endpoint: string; offer: string }
    const ownerOffer = JSON.parse(Buffer.from(pairedOwner.offer, 'base64url').toString()) as OwnerCliPairOffer
    const owner = trackMobileClient(MobileTestClient.connect(pairedOwner.endpoint, ownerOffer.publicKeyB64, ownerOffer.deviceToken))
    await owner.authenticated
    const session = await api.callAny('quirky.session/create', { worktree: 'floating', agent: 'shell' }) as { id: string }
    await waitFor(() => harness?.pty.sessions.has(session.id), 5000)
    await phone.call('quirky.terminal/attach', { session: session.id, cols: 70, rows: 20 })
    harness.pty.emit(session.id, 'reset-marker-1')
    await waitFor(() => phone.binaryFrames.some((frame) => Buffer.from(frame).includes(Buffer.from('reset-marker-1'))), 5000)
    const dataDir = join(harness.home, 'plugin-data', 'quirky.mobile')
    writeFileSync(join(dataDir, 'devices.json.corrupt-1-0a1b2c3d'), '{broken', { mode: 0o600 })
    const registryPath = join(dataDir, 'devices.json')
    rmSync(registryPath)
    mkdirSync(registryPath)
    expect(await api.callAny('quirky.mobile/pair', { address: '127.0.0.1', rotate: true })).toMatchObject({
      available: false, reason: 'device_registry_unavailable'
    })
    harness.pty.emit(session.id, 'reset-marker-2')
    await waitFor(() => phone.binaryFrames.some((frame) => Buffer.from(frame).includes(Buffer.from('reset-marker-2'))), 5000)
    rmSync(registryPath, { recursive: true })
    const closed = socketCloseCode(phone)
    expect(await api.callAny('quirky.mobile/resetPairing', { confirm: true, yes: true })).toMatchObject({
      identityCreated: false, unpairedDevices: 0
    })
    expect(await closed).toBe(4001)
    await waitForAsync(async () => {
      const status = await api.callAny('status.get', {}) as { clients: { role: string }[] }
      return status.clients.some(({ role }) => role === 'mobile') ? undefined : true
    }, 5000)
    harness.pty.emit(session.id, 'reset-marker-3')
    await api.callAny('status.get', {})
    expect(phone.binaryFrames.some((frame) => Buffer.from(frame).includes(Buffer.from('reset-marker-3')))).toBe(false)
    expect(owner.socket.readyState).toBe(1)
    expect(await owner.call('status.get')).toMatchObject({ daemonVersion: expect.any(String) })
    const stale = trackMobileClient(MobileTestClient.connect(offer.endpoint, offer.publicKeyB64, offer.deviceToken))
    let failure: unknown
    try { await stale.authenticated } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    await stale.close()
  }, 60_000)
})

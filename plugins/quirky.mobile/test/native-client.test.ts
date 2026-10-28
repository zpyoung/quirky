import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { createMobileRpc, type MobileRpc } from '@quirky/protocol/paired-client'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

let harness: Harness | undefined
let rpc: MobileRpc | undefined
let home: string | undefined
let savedMobilePort: string | undefined
let savedMobileHost: string | undefined
let savedEnvironment = false

function configureMobileListener(): void {
  if (!savedEnvironment) {
    savedMobilePort = process.env.QUIRKY_MOBILE_PORT
    savedMobileHost = process.env.QUIRKY_MOBILE_HOST
    savedEnvironment = true
  }
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
}

afterEach(async () => {
  const cleanupErrors: unknown[] = []
  if (rpc) {
    try { rpc.close() } catch (error) { cleanupErrors.push(error) }
    rpc = undefined
  }
  if (harness) {
    try { await harness.cleanup() } catch (error) { cleanupErrors.push(error) }
    harness = undefined
  }
  if (home) {
    try { rmSync(home, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    home = undefined
  }
  if (savedEnvironment) {
    if (savedMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = savedMobilePort
    if (savedMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
    else process.env.QUIRKY_MOBILE_HOST = savedMobileHost
  }
  savedMobilePort = undefined
  savedMobileHost = undefined
  savedEnvironment = false
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Native mobile daemon test cleanup failed')
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
})

test('native MobileRpc authenticates to the actual daemon and calls mobile info and status', async () => {
  configureMobileListener()
  const isolatedHome = makeHomeWithoutAutoHooks('quirky-native-mobile-')
  home = isolatedHome
  // startHarness uses its fake PTY host; this verifies daemon transport interoperability, not physical execution.
  harness = await startHarness({ home: isolatedHome, builtinPluginsDir: builtinsDir() })
  const api = await harness.connect('cli')
  const listener = await api.callAny('quirky.mobile/state', {}) as {
    listener: { available: boolean; port: number }
  }
  expect(listener.listener).toMatchObject({ available: true })
  expect(listener.listener.port).toBeGreaterThan(0)

  const pairing = await api.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as {
    available: boolean; pairingUrl: string; endpoint: string
  }
  expect(pairing.available).toBe(true)
  const code = new URL(pairing.pairingUrl).searchParams.get('code')
  expect(code).not.toBeNull()
  const offer = JSON.parse(Buffer.from(code!, 'base64url').toString('utf8')) as {
    v: number; endpoint: string; deviceToken: string; publicKeyB64: string; pairedDeviceId: string; scope: string
  }
  expect(offer).toMatchObject({ v: 2, endpoint: pairing.endpoint, scope: 'mobile' })

  await api.callAny('quirky.mobile/configure', { machineName: 'Native RPC test desktop' })
  const mobileRpc = await createMobileRpc({
    endpoint: offer.endpoint,
    publicKeyB64: offer.publicKeyB64,
    token: offer.deviceToken,
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
  rpc = mobileRpc

  const info = await mobileRpc.call('quirky.mobile/info', {}) as {
    machineName: string; platform: string; deviceScope: string
  }
  expect(info).toEqual({ machineName: 'Native RPC test desktop', platform: process.platform, deviceScope: 'mobile' })

  const status = await mobileRpc.call('status.get', {}) as { clients: { role: string }[] }
  expect(status.clients.filter((client) => client.role === 'mobile')).toHaveLength(1)
  mobileRpc.close()
  rpc = undefined
})

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { OwnerGrantStore, setOwnerGrantWriteHooksForTests } from '../src/daemon/owner-store'
import { MobileService, registerMobileMethods } from '../src/daemon/service'
import { MobileStore, setPairingResetHooksForTests } from '../src/daemon/storage'

const LOCAL: PluginCaller = { role: 'cli' }
const OWNER_GRANTS_UNAVAILABLE_MESSAGE = 'owner_grants_unavailable: owner-grants.json is unavailable, so its grants can\'t be revoked before a new encryption identity is created; nothing was reset. Fix or move owner-grants.json, restart Quirky, then run reset-pairing again'
const OWNER_WRITE_FAILURE_MESSAGE = 'write_failed: owner-grants.json could not be written; no mobile file was changed. Restart Quirky, then run reset-pairing again'
const RESET_GUIDANCE = 'Mobile pairing data was damaged and set aside. Run quirky mobile reset-pairing --confirm to start over; every paired device must pair again.'
const MOBILE_UNAVAILABLE_GUIDANCE = 'Mobile pairing is unavailable. Check the listener, network, and device registry, then try again.'
const RESETTABLE_REGISTRY_MESSAGE = `Mobile device registry unavailable. ${RESET_GUIDANCE}`

type MethodHandler = (params: Record<string, unknown>, caller: PluginCaller) => unknown
type TestError = Error & { kind?: string }
type ResetResult = {
  identityCreated: boolean
  unpairedDevices: number
  ownerGrantsRevoked: number
  ownerGrantsRemaining: number | null
  previousRegistry: string | null
  quarantined: string[]
  unsynced: string[]
}
type OwnerRegistry = { version: number; grants: unknown[] }
type Harness = {
  call(method: string, params?: Record<string, unknown>, caller?: PluginCaller): Promise<unknown>
  service: MobileService
  logs: string[]
  emits: [string, unknown][]
}

const roots: string[] = []
const services: MobileService[] = []

afterEach(async () => {
  setPairingResetHooksForTests(null)
  setOwnerGrantWriteHooksForTests(null)
  for (const service of services.splice(0)) await service.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-mobile-reset-service-'))
  roots.push(root)
  return join(root, 'plugin-data', 'quirky.mobile')
}

function serviceHarness(dataDir: string): Harness {
  const handlers = new Map<string, MethodHandler>()
  const logs: string[] = []
  const emits: [string, unknown][] = []
  const context = {
    pluginId: 'quirky.mobile',
    dir: dataDir,
    dataDir,
    home: dirname(dataDir),
    workerEntrypoint: () => { throw new Error('unused') },
    log: (line: string) => logs.push(line),
    provide: (id: string, implementation: unknown) => handlers.set(id, implementation as MethodHandler),
    emit: (event: string, payload: unknown) => { emits.push([event, payload]); return true },
    subscribe: () => () => {},
    call: async () => undefined,
    createFileResource: async () => { throw new Error('unused') },
    openStore: () => { throw new Error('unused') },
    getSetting: () => undefined,
    storedSettingValue: () => undefined,
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind }),
    pty: {},
    notify: () => {},
    launch: {},
    clients: { accept: () => { throw new Error('unused') } }
  } as unknown as PluginContext
  const service = new MobileService(context, { hostValue: '127.0.0.1', portValue: '0' })
  registerMobileMethods(context, service)
  services.push(service)
  return {
    call: async (method, params = {}, caller = LOCAL) => {
      const handler = handlers.get(`method:quirky.mobile/${method}`)
      if (!handler) throw new Error(`missing mobile API method ${method}`)
      return await handler(params, caller)
    },
    service,
    logs,
    emits
  }
}

function seedMobile(dataDir: string): { registryBytes: Buffer<ArrayBuffer> } {
  const store = new MobileStore(dataDir)
  const pending = store.getOrCreatePending(false)
  const authenticated = store.authenticate(pending.token, 100)
  if (authenticated.status !== 'paired') throw new Error('failed to seed a paired mobile device')
  const registryBytes = readFileSync(registryPath(dataDir))
  store.dispose()
  return { registryBytes }
}

function addOwnerGrant(dataDir: string): void {
  new OwnerGrantStore(dataDir).create('Old owner', 'ws://127.0.0.1:1')
}

function corruptAndQuarantine(dataDir: string, filename: string): void {
  writeFileSync(join(dataDir, filename), '{broken', { mode: 0o600 })
  new MobileStore(dataDir).dispose()
}

function registryPath(dataDir: string): string {
  return join(dataDir, 'devices.json')
}

function identityPath(dataDir: string): string {
  return join(dataDir, 'e2ee-keypair.json')
}

function ownerPath(dataDir: string): string {
  return join(dataDir, 'owner-grants.json')
}

function ownerRegistry(dataDir: string): OwnerRegistry {
  return JSON.parse(readFileSync(ownerPath(dataDir), 'utf8')) as OwnerRegistry
}

function directoryEntries(dataDir: string): string[] {
  return readdirSync(dataDir).sort()
}

async function captureFailure(promise: Promise<unknown>): Promise<TestError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as TestError
  }
  throw new Error('Expected operation to reject')
}

function identityResetSetup(dataDir: string): { registryBytes: Buffer<ArrayBuffer>; ownerBytes: Buffer<ArrayBuffer> } {
  const { registryBytes } = seedMobile(dataDir)
  addOwnerGrant(dataDir)
  const ownerBytes = readFileSync(ownerPath(dataDir))
  corruptAndQuarantine(dataDir, 'e2ee-keypair.json')
  return { registryBytes, ownerBytes }
}

test('resetPairing is limited to local owners', async () => {
  const dataDir = makeDataDir()
  seedMobile(dataDir)
  const harness = serviceHarness(dataDir)

  const localCallers: PluginCaller[] = [
    { role: 'cli' },
    { role: 'ui', desktopClientId: '00000000-0000-4000-8000-000000000001' }
  ]
  for (const caller of localCallers) {
    const error = await captureFailure(harness.call('resetPairing', { confirm: true }, caller))
    expect(error.kind).toBe('conflict')
    expect(error.message.startsWith('pairing_available:')).toBe(true)
  }

  const remoteCallers: PluginCaller[] = [
    { role: 'cli', ownerGrantId: '00000000-0000-4000-8000-000000000002' },
    { role: 'mobile', deviceId: '00000000-0000-4000-8000-000000000003' },
    { role: 'plugin', pluginId: 'acme.x' }
  ]
  for (const caller of remoteCallers) {
    const before = directoryEntries(dataDir)
    const error = await captureFailure(harness.call('resetPairing', { confirm: true }, caller))
    expect(error.message).toBe('Mobile pairing reset requires a local owner client')
    expect(directoryEntries(dataDir)).toEqual(before)
  }
})

test('resetPairing accepts only confirm true with no extra fields', async () => {
  const dataDir = makeDataDir()
  seedMobile(dataDir)
  const harness = serviceHarness(dataDir)

  for (const params of [{}, { confirm: false }, { confirm: 'yes' }, { confirm: true, extra: 1 }]) {
    const error = await captureFailure(harness.call('resetPairing', params, LOCAL))
    expect(error.kind).toBe('invalid-params')
    expect(error.message).toBe('resetPairing requires confirm: true')
  }
})

test('identity recovery requires an available owner registry and can be retried after restart', async () => {
  const dataDir = makeDataDir()
  const { registryBytes, ownerBytes } = identityResetSetup(dataDir)
  rmSync(ownerPath(dataDir))
  mkdirSync(ownerPath(dataDir))

  const harness = serviceHarness(dataDir)
  const error = await captureFailure(harness.call('resetPairing', { confirm: true }, LOCAL))
  expect(error.kind).toBe('conflict')
  expect(error.message).toBe(OWNER_GRANTS_UNAVAILABLE_MESSAGE)
  expect(existsSync(identityPath(dataDir))).toBe(false)
  expect(readFileSync(registryPath(dataDir))).toEqual(registryBytes)

  await harness.service.stop()
  rmSync(ownerPath(dataDir), { recursive: true, force: true })
  writeFileSync(ownerPath(dataDir), ownerBytes, { mode: 0o600 })
  const restarted = serviceHarness(dataDir)
  const result = await restarted.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.identityCreated).toBe(true)
  expect(result.ownerGrantsRevoked).toBe(1)
  expect(result.ownerGrantsRemaining).toBe(0)
})

test('registry recovery succeeds when the owner registry is unavailable', async () => {
  const dataDir = makeDataDir()
  seedMobile(dataDir)
  corruptAndQuarantine(dataDir, 'devices.json')
  mkdirSync(ownerPath(dataDir))
  const harness = serviceHarness(dataDir)
  const ownerDirectoryEntries = directoryEntries(ownerPath(dataDir))

  const result = await harness.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.identityCreated).toBe(false)
  expect(result.ownerGrantsRevoked).toBe(0)
  expect(result.ownerGrantsRemaining).toBeNull()
  expect(statSync(ownerPath(dataDir)).isDirectory()).toBe(true)
  expect(directoryEntries(ownerPath(dataDir))).toEqual(ownerDirectoryEntries)
})

test('an owner grant write failure before rename requires restart before retry', async () => {
  const dataDir = makeDataDir()
  const { registryBytes } = identityResetSetup(dataDir)
  const harness = serviceHarness(dataDir)
  setOwnerGrantWriteHooksForTests({ beforeRename: () => { throw new Error('injected') } })

  const error = await captureFailure(harness.call('resetPairing', { confirm: true }, LOCAL))
  setOwnerGrantWriteHooksForTests(null)
  expect(error.kind).toBe('conflict')
  expect(error.message).toBe(OWNER_WRITE_FAILURE_MESSAGE)
  expect(existsSync(identityPath(dataDir))).toBe(false)
  expect(readFileSync(registryPath(dataDir))).toEqual(registryBytes)
  expect(directoryEntries(dataDir).some((name) => name.startsWith('devices.json.reset-'))).toBe(false)
  expect(ownerRegistry(dataDir).grants).toHaveLength(1)

  const sameServiceError = await captureFailure(harness.call('resetPairing', { confirm: true }, LOCAL))
  expect(sameServiceError.kind).toBe('conflict')
  expect(sameServiceError.message).toBe(OWNER_GRANTS_UNAVAILABLE_MESSAGE)

  await harness.service.stop()
  const restarted = serviceHarness(dataDir)
  const result = await restarted.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.identityCreated).toBe(true)
  expect(result.ownerGrantsRevoked).toBe(1)
})

test('an owner grant write failure after rename is recovered by restarting', async () => {
  const dataDir = makeDataDir()
  identityResetSetup(dataDir)
  const harness = serviceHarness(dataDir)
  setOwnerGrantWriteHooksForTests({ afterRename: () => { throw new Error('injected') } })

  const error = await captureFailure(harness.call('resetPairing', { confirm: true }, LOCAL))
  setOwnerGrantWriteHooksForTests(null)
  expect(error.kind).toBe('conflict')
  expect(error.message).toBe(OWNER_WRITE_FAILURE_MESSAGE)
  expect(existsSync(identityPath(dataDir))).toBe(false)
  expect(ownerRegistry(dataDir).grants).toEqual([])

  await harness.service.stop()
  const restarted = serviceHarness(dataDir)
  const result = await restarted.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.identityCreated).toBe(true)
  expect(result.ownerGrantsRevoked).toBe(0)
  expect(result.ownerGrantsRemaining).toBe(0)
})

test('an identity write failure rejects and can be retried on the same service', async () => {
  const dataDir = makeDataDir()
  identityResetSetup(dataDir)
  const harness = serviceHarness(dataDir)
  setPairingResetHooksForTests({
    at: (point) => {
      if (point === 'identity:tempWritten') throw new Error('injected')
    }
  })

  const error = await captureFailure(harness.call('resetPairing', { confirm: true }, LOCAL))
  setPairingResetHooksForTests(null)
  expect(error.kind).toBe('conflict')
  expect(error.message).toBe('write_failed: e2ee-keypair.json could not be written (injected); the device registry was reset, so run reset-pairing again')
  expect(Object.hasOwn(error, 'ownerGrantsRevoked')).toBe(false)
  expect(ownerRegistry(dataDir).grants).toEqual([])
  expect(JSON.parse(readFileSync(registryPath(dataDir), 'utf8'))).toEqual([])
  expect(existsSync(identityPath(dataDir))).toBe(false)

  const result = await harness.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.identityCreated).toBe(true)
  expect(result.unpairedDevices).toBe(0)
  expect(result.ownerGrantsRevoked).toBe(0)
  expect(result.previousRegistry).toBeNull()
})

test('a successful reset logs its outcome and emits changed once', async () => {
  const dataDir = makeDataDir()
  seedMobile(dataDir)
  corruptAndQuarantine(dataDir, 'devices.json')
  const harness = serviceHarness(dataDir)

  await harness.call('resetPairing', { confirm: true }, LOCAL)
  expect(harness.logs).toEqual([
    'mobile: pairing reset; identity created false, 0 paired devices and 0 owner CLI grants must pair again'
  ])
  expect(harness.emits).toEqual([['changed', {}]])
})

test('a directory-sync failure is reported in the result and log without failing the reset', async () => {
  const dataDir = makeDataDir()
  seedMobile(dataDir)
  corruptAndQuarantine(dataDir, 'devices.json')
  const harness = serviceHarness(dataDir)
  setPairingResetHooksForTests({
    at: (point) => {
      if (point === 'registry:renamed') throw new Error('injected')
    }
  })

  const result = await harness.call('resetPairing', { confirm: true }, LOCAL) as ResetResult
  expect(result.unsynced).toEqual(['devices.json'])
  expect(harness.logs).toEqual([
    'mobile: pairing reset; identity created false, 0 paired devices and 0 owner CLI grants must pair again',
    'mobile: pairing reset wrote devices.json but could not sync the directory; the change is visible but may not survive a crash'
  ])
  expect(harness.emits).toEqual([['changed', {}]])
})

test('pairing guidance distinguishes recoverable and non-recoverable registry loss', async () => {
  const resettableDataDir = makeDataDir()
  seedMobile(resettableDataDir)
  corruptAndQuarantine(resettableDataDir, 'devices.json')
  const resettable = serviceHarness(resettableDataDir)
  await resettable.service.start()
  try {
    const pairing = await resettable.call('pair', { address: '127.0.0.1' }) as { available: false; reason: string; guidance: string }
    expect(pairing).toEqual({ available: false, reason: 'device_registry_unavailable', guidance: RESET_GUIDANCE })
    for (const method of ['state', 'devices']) {
      const error = await captureFailure(resettable.call(method, {}, LOCAL))
      expect(error.kind).toBe('conflict')
      expect(error.message).toBe(RESETTABLE_REGISTRY_MESSAGE)
    }
  } finally {
    await resettable.service.stop()
  }

  const refusedDataDir = makeDataDir()
  seedMobile(refusedDataDir)
  rmSync(registryPath(refusedDataDir))
  const refused = serviceHarness(refusedDataDir)
  await refused.service.start()
  try {
    const resetError = await captureFailure(refused.call('resetPairing', { confirm: true }, LOCAL))
    expect(resetError.kind).toBe('conflict')
    expect(resetError.message).toBe('not_quarantined: devices.json is missing and no devices.json.corrupt- file exists; nothing was reset')

    const pairing = await refused.call('pair', { address: '127.0.0.1' }) as { available: false; reason: string; guidance: string }
    expect(pairing).toEqual({ available: false, reason: 'device_registry_unavailable', guidance: MOBILE_UNAVAILABLE_GUIDANCE })
    for (const method of ['state', 'devices']) {
      const error = await captureFailure(refused.call(method, {}, LOCAL))
      expect(error.kind).toBe('conflict')
      expect(error.message).toBe('Mobile device registry unavailable')
    }
  } finally {
    await refused.service.stop()
  }
})

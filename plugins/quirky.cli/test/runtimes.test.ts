import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { createPairedDaemonLink } from '../../../packages/cli/src/paired-link'
import { savedRuntimeStorePath } from '@quirky/protocol/node'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'

const harnesses: Harness[] = []
let oldMobilePort: string | undefined
let oldMobileHost: string | undefined
let oldMobileEnvironment = false

beforeEach(() => {
  oldMobilePort = process.env.QUIRKY_MOBILE_PORT
  oldMobileHost = process.env.QUIRKY_MOBILE_HOST
  oldMobileEnvironment = true
  process.env.QUIRKY_MOBILE_PORT = '0'
  delete process.env.QUIRKY_MOBILE_HOST
})

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  removeTempDirs()
  if (oldMobileEnvironment) {
    if (oldMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
    else process.env.QUIRKY_MOBILE_PORT = oldMobilePort
    if (oldMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
    else process.env.QUIRKY_MOBILE_HOST = oldMobileHost
  }
  oldMobilePort = undefined
  oldMobileHost = undefined
  oldMobileEnvironment = false
})

async function start() {
  const home = makeTempHome('quirky-cli-runtimes-home-')
  const builtins = makeTempDir('quirky-cli-runtimes-builtins-')
  symlinkSync(resolve(import.meta.dir, '..'), join(builtins, 'quirky.cli'))
  symlinkSync(resolve(import.meta.dir, '../../quirky.mobile'), join(builtins, 'quirky.mobile'))
  const harness = await startHarness({ home, builtinPluginsDir: builtins })
  harnesses.push(harness)
  return { home, caller: await harness.connect('cli') }
}

test('saved paired runtime APIs retain private offers but never return credentials from add, list, show, or status', async () => {
  const { home, caller } = await start()
  const pairing = await caller.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as {
    available: boolean
    pairingUrl: string
  }
  expect(pairing.available).toBe(true)
  const code = new URL(pairing.pairingUrl).searchParams.get('code')
  expect(code).not.toBeNull()
  const offer = JSON.parse(Buffer.from(code!, 'base64url').toString('utf8')) as { deviceToken: string }

  const added = await caller.callAny('quirky.cli/runtimeAdd', { name: 'Build desktop', pairingCode: pairing.pairingUrl }) as {
    id: string; name: string; pairedDeviceId: string
  }
  expect(added).toMatchObject({ name: 'Build desktop' })
  expect(added).not.toHaveProperty('pairingCode')
  const listed = await caller.callAny('quirky.cli/runtimeList', {}) as { runtimes: unknown[] }
  const shown = await caller.callAny('quirky.cli/runtimeShow', { selector: added.id })
  const status = await caller.callAny('quirky.cli/runtimeStatus', {})
  for (const safeView of [listed, shown, status]) {
    expect(JSON.stringify(safeView)).not.toContain(pairing.pairingUrl)
    expect(JSON.stringify(safeView)).not.toContain(code!)
    expect(JSON.stringify(safeView)).not.toContain(offer.deviceToken)
    expect(JSON.stringify(safeView)).not.toContain('publicKeyB64')
  }

  const file = savedRuntimeStorePath(home)
  expect((statSync(file).mode & 0o777)).toBe(0o600)
  const stored = readFileSync(file, 'utf8')
  expect(stored).toContain(pairing.pairingUrl)
  expect(stored).toContain(offer.deviceToken)

  await caller.callAny('quirky.cli/runtimeRemove', { selector: added.id, yes: true })
  expect(await caller.callAny('quirky.cli/runtimeList', {})).toEqual({ runtimes: [] })
  expect(readFileSync(file, 'utf8')).not.toContain(offer.deviceToken)
})

test('a malformed pairing offer is rejected before any saved runtime is written', async () => {
  const { home, caller } = await start()
  await expect(caller.callAny('quirky.cli/runtimeAdd', { name: 'broken', pairingCode: 'not-a-pairing-offer' })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  expect(await caller.callAny('quirky.cli/runtimeList', {})).toEqual({ runtimes: [] })
  expect(() => statSync(savedRuntimeStorePath(home))).toThrow()
})

test('owner targets call only the selected remote daemon through saved and one-off encrypted links', async () => {
  const local = await start()
  const remote = await start()
  const paired = await remote.caller.callAny('quirky.mobile/ownerPair', {
    name: 'Remote owner',
    confirm: true,
    address: '127.0.0.1'
  }) as { offer: string; grant: { grantId: string }; endpoint: string }
  const added = await local.caller.callAny('quirky.cli/runtimeAdd', {
    name: 'Owner target',
    pairingCode: paired.offer
  }) as { id: string; endpoint: string; pairedDeviceId: string; grantId: string; scope: string }
  expect(added).toMatchObject({
    scope: 'owner-cli',
    grantId: paired.grant.grantId,
    endpoint: paired.endpoint,
    pairedDeviceId: paired.grant.grantId
  })
  expect(JSON.stringify(added)).not.toContain(paired.offer)
  expect(JSON.stringify(await local.caller.callAny('quirky.cli/runtimeList', {}))).not.toContain(paired.offer)

  const localState = await local.caller.callAny('quirky.mobile/state', {}) as { machineName: string }
  const remoteState = await remote.caller.callAny('quirky.mobile/state', {}) as { machineName: string }
  const routed = await local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: added.id,
    method: 'quirky.mobile/state',
    params: {}
  }) as { runtime: { id: string; grantId: string; endpoint: string }; result: { machineName: string } }
  expect(routed.runtime).toMatchObject({ id: added.id, grantId: paired.grant.grantId, endpoint: paired.endpoint })
  expect(routed.result).toEqual(remoteState)
  expect(await local.caller.callAny('quirky.mobile/state', {})).toEqual(localState)

  const savedLink = createPairedDaemonLink(local.home, { kind: 'saved', selector: added.id }, {})
  try {
    const fullApi = await savedLink.callAny('api.describe', {}) as { methods: { name: string }[] }
    expect(fullApi.methods.some(({ name }) => name === 'quirky.mobile/ownerPair')).toBe(true)
    await savedLink.callAny('quirky.mobile/configure', { machineName: 'Changed through saved owner' }, { requestId: 'owner-saved-route' })
  } finally {
    savedLink.close()
  }
  expect(await remote.caller.callAny('quirky.mobile/state', {})).toMatchObject({ machineName: 'Changed through saved owner' })
  expect(await local.caller.callAny('quirky.mobile/state', {})).toEqual(localState)

  const oneOff = createPairedDaemonLink(local.home, { kind: 'pairing', pairingCode: paired.offer }, {})
  try {
    await oneOff.callAny('quirky.mobile/configure', { machineName: 'Changed through one-off owner' }, { requestId: 'owner-one-off-route' })
  } finally {
    oneOff.close()
  }
  expect(await remote.caller.callAny('quirky.mobile/state', {})).toMatchObject({ machineName: 'Changed through one-off owner' })
  expect(await local.caller.callAny('quirky.mobile/state', {})).toEqual(localState)

  const command = await runCli([
    'runtime', 'call', '--target', added.id, '--method', 'quirky.mobile/configure',
    '--arguments', JSON.stringify({ machineName: 'Changed through local owner routing command' }), '--json'
  ], { home: local.home })
  expect(command.code).toBe(0)
  expect(await remote.caller.callAny('quirky.mobile/state', {})).toMatchObject({ machineName: 'Changed through local owner routing command' })
  expect(await local.caller.callAny('quirky.mobile/state', {})).toEqual(localState)

  const phonePair = await remote.caller.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as {
    pairingUrl: string
  }
  const phoneAdded = await local.caller.callAny('quirky.cli/runtimeAdd', {
    name: 'Phone target',
    pairingCode: phonePair.pairingUrl
  }) as { id: string; scope: string }
  expect(phoneAdded.scope).toBe('mobile')
  await expect(local.caller.callAny('quirky.cli/runtimeCall', {
    runtime: phoneAdded.id,
    method: 'quirky.mobile/state',
    params: {}
  })).rejects.toThrow(/owner/i)
})

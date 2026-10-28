import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

  const added = await caller.callAny('quirky.cli/runtime.add', { name: 'Build desktop', pairingCode: pairing.pairingUrl }) as {
    id: string; name: string; pairedDeviceId: string
  }
  expect(added).toMatchObject({ name: 'Build desktop' })
  expect(added).not.toHaveProperty('pairingCode')
  const listed = await caller.callAny('quirky.cli/runtime.list', {}) as { runtimes: unknown[] }
  const shown = await caller.callAny('quirky.cli/runtime.show', { selector: added.id })
  const status = await caller.callAny('quirky.cli/runtime.status', {})
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

  await caller.callAny('quirky.cli/runtime.remove', { selector: added.id, yes: true })
  expect(await caller.callAny('quirky.cli/runtime.list', {})).toEqual({ runtimes: [] })
  expect(readFileSync(file, 'utf8')).not.toContain(offer.deviceToken)
})

test('a malformed pairing offer is rejected before any saved runtime is written', async () => {
  const { home, caller } = await start()
  await expect(caller.callAny('quirky.cli/runtime.add', { name: 'broken', pairingCode: 'not-a-pairing-offer' })).rejects.toThrow(/Pairing/)
  expect(await caller.callAny('quirky.cli/runtime.list', {})).toEqual({ runtimes: [] })
  expect(() => statSync(savedRuntimeStorePath(home))).toThrow()
})

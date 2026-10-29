import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

const harnesses: Harness[] = []
const tempHomes: string[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true })
  removeTempDirs()
})

async function stop(harness: Harness): Promise<void> {
  await harness.cleanup()
  const index = harnesses.indexOf(harness)
  if (index !== -1) harnesses.splice(index, 1)
}

test('activation disposers release only their host lease when one shared plugin module is stopped', async () => {
  const pluginRoot = makeTempDir('quirky-activation-disposer-plugins-')
  const leaseRoot = makeTempDir('quirky-activation-disposer-leases-')
  const pluginId = 'acme.shared-lease'
  writePlugin(pluginRoot, {
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    main: 'main.ts',
    contributes: {
      method: [{
        id: 'status',
        readOnly: true,
        params: { type: 'object', properties: {}, additionalProperties: false },
        result: {
          type: 'object',
          properties: { active: { type: 'boolean' } },
          required: ['active'],
          additionalProperties: false
        }
      }]
    }
  }, {
    'main.ts': `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const leaseRoot = ${JSON.stringify(leaseRoot)}
type ActivationContext = {
  home: string
  provide(id: string, implementation: unknown): void
}
export function activate(context: ActivationContext) {
  const lease = join(leaseRoot, basename(context.home) + '.lease')
  const released = join(leaseRoot, basename(context.home) + '.released')
  mkdirSync(leaseRoot, { recursive: true })
  writeFileSync(lease, context.home)
  context.provide('method:${pluginId}/status', () => ({ active: existsSync(lease) }))
  return () => {
    appendFileSync(released, 'x')
    rmSync(lease, { force: true })
  }
}
`
  })
  const firstHome = makeTempHome('quirky-activation-disposer-first-')
  const secondHome = makeTempHome('quirky-activation-disposer-second-')
  tempHomes.push(firstHome, secondHome)

  const first = await startHarness({ home: firstHome, builtinPluginsDir: pluginRoot })
  harnesses.push(first)
  const second = await startHarness({ home: secondHome, builtinPluginsDir: pluginRoot })
  harnesses.push(second)
  const firstClient = await first.connect('cli')
  const secondClient = await second.connect('cli')
  const firstLease = join(leaseRoot, `${basename(first.home)}.lease`)
  const secondLease = join(leaseRoot, `${basename(second.home)}.lease`)
  const firstReleased = join(leaseRoot, `${basename(first.home)}.released`)
  const secondReleased = join(leaseRoot, `${basename(second.home)}.released`)

  expect(relative(first.home, firstLease).startsWith('..')).toBe(true)
  expect(relative(second.home, secondLease).startsWith('..')).toBe(true)
  expect(await firstClient.callAny(`${pluginId}/status`, {})).toEqual({ active: true })
  expect(await secondClient.callAny(`${pluginId}/status`, {})).toEqual({ active: true })
  expect(existsSync(firstLease)).toBe(true)
  expect(existsSync(secondLease)).toBe(true)
  expect(existsSync(firstReleased)).toBe(false)
  expect(existsSync(secondReleased)).toBe(false)

  await stop(first)
  expect(existsSync(firstLease)).toBe(false)
  expect(readFileSync(firstReleased, 'utf8')).toBe('x')
  expect(existsSync(secondReleased)).toBe(false)
  expect(existsSync(secondLease)).toBe(true)
  expect(await secondClient.callAny(`${pluginId}/status`, {})).toEqual({ active: true })

  await stop(second)
  expect(existsSync(secondLease)).toBe(false)
  expect(readFileSync(secondReleased, 'utf8')).toBe('x')
})

test('a disposer returned after activation timeout releases its revoked attempt resource', async () => {
  const pluginRoot = makeTempDir('quirky-late-disposer-plugins-')
  const leaseRoot = makeTempDir('quirky-late-disposer-leases-')
  const pluginId = 'acme.late-lease'
  const gate = join(leaseRoot, 'release-activation')
  writePlugin(pluginRoot, {
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    main: 'main.ts',
    contributes: {
      method: [{
        id: 'status',
        readOnly: true,
        params: { type: 'object', properties: {}, additionalProperties: false },
        result: {
          type: 'object',
          properties: { active: { type: 'boolean' } },
          required: ['active'],
          additionalProperties: false
        }
      }]
    }
  }, {
    'main.ts': `
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const leaseRoot = ${JSON.stringify(leaseRoot)}
const gate = ${JSON.stringify(gate)}
type ActivationContext = {
  home: string
  provide(id: string, implementation: unknown): void
}
export async function activate(context: ActivationContext) {
  const lease = join(leaseRoot, basename(context.home) + '.lease')
  mkdirSync(leaseRoot, { recursive: true })
  writeFileSync(lease, context.home)
  context.provide('method:${pluginId}/status', () => ({ active: existsSync(lease) }))
  if (!existsSync(gate)) {
    const gateOpened = Promise.withResolvers<void>()
    const watcher = watch(leaseRoot, () => {
      if (existsSync(gate)) gateOpened.resolve()
    })
    if (existsSync(gate)) gateOpened.resolve()
    try {
      await gateOpened.promise
    } finally {
      watcher.close()
    }
  }
  return () => rmSync(lease, { force: true })
}
`
  })
  const home = makeTempHome('quirky-late-disposer-home-')
  tempHomes.push(home)
  // Deliberately exercise the real activation timeout and a disposer returned by the pending activation.
  const harness = await startHarness({
    home,
    builtinPluginsDir: pluginRoot,
    pluginActivationTimeoutMs: 1000
  })
  harnesses.push(harness)
  const client = await harness.connect('cli')
  const lease = join(leaseRoot, `${basename(home)}.lease`)
  const activation = client.callAny(`${pluginId}/status`, {})

  try {
    await waitFor(() => existsSync(lease))
    await expect(activation).rejects.toThrow(/timed out/i)
    expect(existsSync(lease)).toBe(true)
  } finally {
    writeFileSync(gate, '')
    await activation.catch(() => undefined)
    await waitFor(() => !existsSync(lease))
  }
})

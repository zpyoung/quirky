import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { ApiDescription, PluginEvent, PluginInfo, QuirkyEvent } from '@quirky/protocol'
import { VaultRig } from './support/harness'

const rigs: VaultRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0).reverse()) await rig.cleanup()
})

async function start(): Promise<VaultRig> {
  const rig = await VaultRig.start({ includeEveryAgentFixture: false })
  rigs.push(rig)
  return rig
}

function writeRateFixture(rig: VaultRig): void {
  const projectRoot = join(rig.sourceHome, '.claude', 'projects', 'project')
  mkdirSync(projectRoot, { recursive: true })
  const base = Date.now()
  const cwd = '/tmp/vault-event-rate'
  for (let index = 0; index < 120; index++) {
    const sessionId = `rate-${String(index).padStart(4, '0')}`
    const at = base + index * 1_000
    const transcript = [
      {
        type: 'user',
        sessionId,
        timestamp: new Date(at).toISOString(),
        cwd,
        message: { role: 'user', content: `rate fixture ${sessionId}` }
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: new Date(at + 500).toISOString(),
        cwd,
        message: { role: 'assistant', content: `completed ${sessionId}` }
      }
    ].map(record => JSON.stringify(record)).join('\n')
    writeFileSync(join(projectRoot, `${sessionId}.jsonl`), `${transcript}\n`)
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isFinalSearchStatus(event: QuirkyEvent): boolean {
  if (event.type !== 'quirky.vault/searchStatus') return false
  const status = recordOf(event.data)
  return status?.enabled === true && status.filesIndexed === 120 && status.filesDue === 0
}

function waitForFinalSearchStatus(rig: VaultRig, timeoutMs: number): Promise<void> {
  if (rig.events.some(isFinalSearchStatus)) return Promise.resolve()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let unsubscribe = () => {}
  const timeout = setTimeout(() => {
    unsubscribe()
    reject(new Error(`search index did not publish its final status within ${timeoutMs} ms`))
  }, timeoutMs)
  unsubscribe = rig.client.onEvent(event => {
    if (!isFinalSearchStatus(event)) return
    clearTimeout(timeout)
    unsubscribe()
    resolve()
  })
  return promise
}

test('a vault index pass sends its first and final status with bounded intermediate updates', async () => {
  const rig = await start()
  writeRateFixture(rig)

  const inventory = await rig.call<{ total: number }>('list', {
    host: 'local', agents: ['claude'], unlimited: true
  })
  expect(inventory.total).toBe(120)

  const startedAt = performance.now()
  await rig.client.callAny('setting.set', {
    id: 'setting:quirky.vault/search-enabled', value: true
  })
  await waitForFinalSearchStatus(rig, 45_000)
  await Bun.sleep(600)

  const elapsed = performance.now() - startedAt
  const limit = 3 + Math.floor(elapsed / 250)
  const statusEvents = rig.events.filter((event): event is PluginEvent => event.type === 'quirky.vault/searchStatus')
  const statuses = statusEvents.map(event => {
    const status = recordOf(event.data)
    if (!status) throw new Error('searchStatus event did not carry a status object')
    return status
  })
  console.info('quirky.vault/searchStatus burst', {
    events: statuses.length,
    elapsedMs: Number(elapsed.toFixed(1)),
    limit
  })

  expect(statuses[0]).toMatchObject({ enabled: true, filesIndexed: 0 })
  expect(statuses.at(-1)).toMatchObject({
    enabled: true,
    filesIndexed: 120,
    filesDue: 0,
    messagesIndexed: 240
  })
  expect(statuses.length).toBeLessThanOrEqual(limit)

  const indexedCounts = statuses.map(status => {
    if (typeof status.filesIndexed !== 'number') throw new Error('searchStatus filesIndexed was not numeric')
    return status.filesIndexed
  })
  for (let index = 1; index < indexedCounts.length; index++) {
    expect(indexedCounts[index]).toBeGreaterThanOrEqual(indexedCounts[index - 1])
  }
}, 60_000)

test('a vault list keeps public scan progress within the coalescing rate bound', async () => {
  const rig = await start()
  writeRateFixture(rig)
  rig.events.length = 0

  const startedAt = performance.now()
  const inventory = await rig.call<{ total: number }>('list', {
    host: 'local', agents: ['claude'], unlimited: true
  })
  // Drain two public 250 ms coalescing windows so the latest progress payload is delivered.
  await Bun.sleep(600)

  const elapsedMs = performance.now() - startedAt
  const limit = 3 + Math.floor(elapsedMs / 250)
  const progressEvents = rig.events.filter((event): event is PluginEvent => event.type === 'quirky.vault/scanProgress')
  const progress = progressEvents.map(event => {
    const value = recordOf(event.data)
    if (!value) throw new Error('scanProgress event did not carry a progress object')
    return value
  })
  console.info('quirky.vault/scanProgress list scan', {
    events: progress.length,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    limit
  })

  expect(inventory.total).toBe(120)
  expect(progress[0]).toEqual({ phase: 'discovering', scannedFiles: 0, parsedFiles: 0 })
  expect(progress.at(-1)).toEqual({ phase: 'complete', scannedFiles: 120, parsedFiles: 120 })
  expect(progress.length).toBeLessThanOrEqual(limit)
}, 60_000)

test('the vault catalog coalesces searchStatus and scanProgress and requires API 1.3.0', async () => {
  const rig = await start()
  const description = await rig.client.callAny('api.describe', {}) as ApiDescription
  const vaultEvents = description.events.filter(event => event.plugin === 'quirky.vault')
  const expectedNames = [
    'quirky.vault/searchStatus',
    'quirky.vault/scanProgress',
    'quirky.vault/searchTipChanged',
    'quirky.vault/viewChanged'
  ].sort()
  expect(vaultEvents.map(event => event.name).sort()).toEqual(expectedNames)

  const coalescedNames = vaultEvents.filter(event => event.coalesce !== undefined).map(event => event.name).sort()
  expect(coalescedNames).toEqual(['quirky.vault/scanProgress', 'quirky.vault/searchStatus'].sort())

  const searchStatus = vaultEvents.find(event => event.name === 'quirky.vault/searchStatus')!
  const scanProgress = vaultEvents.find(event => event.name === 'quirky.vault/scanProgress')!
  expect(searchStatus.coalesce).toEqual([])
  expect(searchStatus).not.toHaveProperty('worktree')
  expect(scanProgress.coalesce).toEqual([])
  expect(scanProgress).not.toHaveProperty('worktree')

  for (const name of expectedNames.filter(name => name !== 'quirky.vault/searchStatus' && name !== 'quirky.vault/scanProgress')) {
    const event = vaultEvents.find(candidate => candidate.name === name)!
    expect(event).not.toHaveProperty('coalesce')
    expect(event).not.toHaveProperty('worktree')
  }

  const plugins = await rig.client.callAny('plugin.list', {}) as PluginInfo[]
  expect(plugins.find(plugin => plugin.id === 'quirky.vault')?.apiVersion).toBe('1.3.0')
}, 30_000)

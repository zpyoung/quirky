import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pluginApiCompatibilityError, type PluginEvent, type QuirkyEvent } from '@quirky/protocol'
import { PluginEvents } from '../../src/plugins/events'
import { PluginHost } from '../../src/plugins/host'
import { builtinsDir } from '../helpers'
import { makeTempDir, removeTempDirs } from './fixtures'

const adopters = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.automations', 'quirky.mobile', 'quirky.vault']
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  removeTempDirs()
})

function setup() {
  const installedDir = join(makeTempDir(), 'installed')
  mkdirSync(installedDir)
  const logs: string[] = []
  const host = new PluginHost({
    builtinDir: builtinsDir(),
    installedDir,
    store: { listDisabledIds: () => [], setDisabledId: () => {} },
    emit: () => {},
    log: (message) => logs.push(message),
  })
  host.load()
  const broadcasts: PluginEvent[] = []
  const received: PluginEvent[] = []
  const record = (target: PluginEvent[], event: QuirkyEvent) => {
    if (!('data' in event)) throw new Error('expected a plugin event')
    target.push(event)
  }
  const events = new PluginEvents(host, (event) => {
    record(broadcasts, event)
    events.deliver(event)
  }, (message) => logs.push(message))
  events.subscribe('quirky.notifications', (event) => record(received, event))
  cleanups.push(() => {
    for (const id of [...adopters, 'quirky.notifications']) events.removeAll(id)
  })
  const emit = (type: string, data: Record<string, unknown>) => {
    const [plugin, event] = type.split('/')
    expect(events.emit(plugin!, event!, data)).toBe(true)
  }
  return { host, events, broadcasts, received, logs, emit }
}

function field(event: PluginEvent, key: string) {
  if (typeof event.data !== 'object' || event.data === null || !(key in event.data)) {
    throw new Error(`expected event data field ${key}`)
  }
  return Reflect.get(event.data, key)
}

// real windows verify the built-in declarations against the production coalescer clock.
async function assertIdle(rig: { broadcasts: PluginEvent[]; received: PluginEvent[]; logs: string[] }) {
  expect(rig.received).toEqual(rig.broadcasts)
  const delivered = rig.broadcasts.length
  await Bun.sleep(300)
  expect(rig.broadcasts).toHaveLength(delivered)
  expect(rig.received).toEqual(rig.broadcasts)
  expect(rig.logs).toEqual([])
}

const globals: Array<{ type: string; data: (n: number) => Record<string, unknown> }> = [
  { type: 'quirky.repo/changed', data: (n) => ({ repoId: `repo-${n}`, groupId: `group-${n}` }) },
  { type: 'quirky.worktree/optionsChanged', data: (n) => ({ options: { hideArchived: n % 2 === 0 }, revision: n }) },
  { type: 'quirky.worktree/statusDefinitionsChanged', data: (n) => ({ statuses: [{ id: `status-${n}`, label: `Status ${n}` }] }) },
  { type: 'quirky.worktree/tagsChanged', data: () => ({}) },
  { type: 'quirky.worktree/viewsChanged', data: () => ({}) },
  { type: 'quirky.worktree/projectMetadataChanged', data: (n) => ({ repoId: `repo-${n}` }) },
  { type: 'quirky.agents/changed', data: (n) => ({ revision: n }) },
  { type: 'quirky.automations/uiChanged', data: (n) => ({ revision: n }) },
  { type: 'quirky.mobile/changed', data: () => ({}) },
]

describe('remaining built-in coalescing adopters', () => {
  test('global refreshes retain only first/latest across changing payload identities', async () => {
    const rig = setup()
    for (const stream of globals) {
      for (let n = 1; n <= 50; n++) rig.emit(stream.type, stream.data(n))
    }
    expect(rig.broadcasts).toHaveLength(globals.length)
    for (const stream of globals) {
      expect(rig.broadcasts.filter((event) => event.type === stream.type).map((event) => event.data)).toEqual([stream.data(1)])
    }
    await Bun.sleep(600)
    expect(rig.broadcasts).toHaveLength(globals.length * 2)
    for (const stream of globals) {
      expect(rig.broadcasts.filter((event) => event.type === stream.type).map((event) => event.data)).toEqual([stream.data(1), stream.data(50)])
    }
    await assertIdle(rig)
  })

  test('adopting manifests require a coalescing-capable API without activating plugins', () => {
    const { host } = setup()
    for (const id of adopters) {
      const plugin = host.list().find((entry) => entry.id === id)!
      expect(plugin).toBeDefined()
      expect(plugin.state).not.toBe('invalid')
      expect(plugin.state).not.toBe('active')
      expect(pluginApiCompatibilityError(plugin.apiVersion, '1.2.0')).not.toBeNull()
      expect(pluginApiCompatibilityError(plugin.apiVersion)).toBeNull()
    }
    const declarations = host.contributions({ kind: 'event', pluginId: 'quirky.agents' })
    expect(declarations.find((event) => event.id === 'event:quirky.agents/modelSnapshot')?.data.coalesce).toBeUndefined()
    const worktreeChanged = host.contributions({ kind: 'event', pluginId: 'quirky.worktree' })
      .find((event) => event.id === 'event:quirky.worktree/changed')
    expect(worktreeChanged?.data.coalesce).toEqual(['repoId', 'unread', 'removed', 'unreadSource'])
    expect(worktreeChanged?.data.worktree).toBe('worktreeId')
  })

  test('automation revisions coalesce independently for both automation IDs', async () => {
    const rig = setup()
    for (let revision = 1; revision <= 50; revision++) {
      for (const automationId of ['a', 'b']) rig.emit('quirky.automations/changed', { automationId, revision })
    }
    expect(rig.broadcasts).toHaveLength(2)
    await Bun.sleep(600)
    expect(rig.broadcasts).toHaveLength(4)
    for (const automationId of ['a', 'b']) {
      expect(rig.broadcasts.filter((event) => field(event, 'automationId') === automationId).map((event) => event.data)).toEqual([
        { automationId, revision: 1 }, { automationId, revision: 50 },
      ])
    }
    await assertIdle(rig)
  })

  test('worktree tags preserve plain, unread, removal and notification-source keys', async () => {
    const rig = setup()
    const shapes = [{}, { unread: true }, { unread: false }, { unread: false, unreadSource: 'notifications' }, { removed: true }]
    const expected: Array<Record<string, unknown>> = []
    for (const worktreeId of ['a', 'b']) {
      for (const shape of shapes) {
        for (let revision = 1; revision <= 50; revision++) {
          const data = { repoId: 'r', worktreeId, ...shape, revision }
          rig.emit('quirky.worktree/changed', data)
          if (revision === 1 || revision === 50) expected.push(data)
        }
      }
    }
    expect(rig.broadcasts).toHaveLength(10)
    await Bun.sleep(600)
    expect(rig.broadcasts).toHaveLength(20)
    const delivered = rig.broadcasts.map((event) => event.data)
    for (const data of expected) expect(delivered).toContainEqual(data)
    for (const event of rig.broadcasts) expect(event.worktreeId).toBe(field(event, 'worktreeId'))
    await assertIdle(rig)
  })

  test('untargeted worktree changes retain repository identity and remain untagged', async () => {
    const rig = setup()
    for (let revision = 1; revision <= 50; revision++) {
      for (const repoId of ['r1', 'r2']) rig.emit('quirky.worktree/changed', { repoId, revision })
    }
    expect(rig.broadcasts).toHaveLength(2)
    await Bun.sleep(600)
    expect(rig.broadcasts).toHaveLength(4)
    for (const repoId of ['r1', 'r2']) {
      expect(rig.broadcasts.filter((event) => field(event, 'repoId') === repoId).map((event) => event.data)).toEqual([
        { repoId, revision: 1 }, { repoId, revision: 50 },
      ])
    }
    for (const event of rig.broadcasts) expect(event).not.toHaveProperty('worktreeId')
    await assertIdle(rig)
  })

  test('vault progress retains discovering and the final complete snapshot', async () => {
    const rig = setup()
    const first = { phase: 'discovering', scannedFiles: 0, parsedFiles: 0 }
    const final = { phase: 'complete', scannedFiles: 120, parsedFiles: 120 }
    rig.emit('quirky.vault/scanProgress', first)
    for (let n = 1; n <= 120; n++) rig.emit('quirky.vault/scanProgress', { phase: 'reading', scannedFiles: n, parsedFiles: n })
    rig.emit('quirky.vault/scanProgress', final)
    expect(rig.broadcasts.map((event) => event.data)).toEqual([first])
    await Bun.sleep(600)
    expect(rig.broadcasts.map((event) => event.data)).toEqual([first, final])
    await assertIdle(rig)
  })
})

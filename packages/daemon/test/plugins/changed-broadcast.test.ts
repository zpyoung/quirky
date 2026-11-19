import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { startHarness, makeTempHome, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './fixtures'
import { createPluginChangedBroadcast } from '../../src/plugins/changed-broadcast'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
  removeTempDirs()
})

test('concurrent lazy activations coalesce broadcasts and retain a trailing settled state', async () => {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const id of ['acme.a', 'acme.b', 'acme.c', 'acme.d']) {
    writeModulePlugin(join(home, 'plugins'), marker, { id })
  }
  harness = await startHarness({ home })
  const { client, events } = await harness.connectWithEvents()
  const arrivals: number[] = []
  client.onEvent((event) => { if (event.type === 'plugin.changed') arrivals.push(performance.now()) })
  // real transports and plugin imports cannot advance with a fake clock
  await Bun.sleep(300)
  events.length = 0
  arrivals.length = 0
  await Promise.all(['acme.a', 'acme.b', 'acme.c', 'acme.d'].map((pluginId) => client.call('plugin.activate', { pluginId })))
  const settledAt = performance.now()
  await Bun.sleep(600)
  expect(events.filter((event) => event.type === 'plugin.changed').length).toBeLessThan(8)
  expect(arrivals.some((time) => time > settledAt)).toBe(true)
  const plugins = await client.call('plugin.list', {})
  expect(plugins.filter((plugin) => plugin.id.startsWith('acme.')).map((plugin) => plugin.state)).toEqual(['active', 'active', 'active', 'active'])
})

function controlledBroadcast() {
  let now = 0
  let nextId = 0
  const scheduled = new Map<number, { at: number; fn: () => void }>()
  const sends: number[] = []
  const broadcast = createPluginChangedBroadcast({
    send: () => sends.push(now),
    intervalMs: 250,
    setTimer: (fn, ms) => {
      const id = ++nextId
      scheduled.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (id) => { scheduled.delete(id as number) }
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, entry] of scheduled) {
      if (entry.at > now) continue
      scheduled.delete(id)
      entry.fn()
    }
  }
  return { broadcast, sends, advance, scheduled }
}

test('a burst sends only its leading and trailing state', () => {
  const t = controlledBroadcast()
  for (let n = 0; n < 5; n++) t.broadcast.signal()
  expect(t.sends).toEqual([0])
  t.advance(250)
  expect(t.sends).toEqual([0, 250])
  t.advance(250)
  expect(t.sends).toEqual([0, 250])
  t.broadcast.signal()
  expect(t.sends).toEqual([0, 250, 500])
  t.advance(250)
  expect(t.sends).toEqual([0, 250, 500])
})

test('dispose flushes pending state and leaves later signals synchronous', () => {
  const t = controlledBroadcast()
  t.broadcast.signal()
  t.broadcast.signal()
  t.broadcast.dispose()
  expect(t.sends).toEqual([0, 0])
  expect(t.scheduled.size).toBe(0)
  t.advance(250)
  t.broadcast.signal()
  t.broadcast.signal()
  expect(t.sends).toEqual([0, 0, 250, 250])
})

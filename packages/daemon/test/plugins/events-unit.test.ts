import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyEvent } from '@quirky/protocol'
import { PluginEvents } from '../../src/plugins/events'
import { PluginHost } from '../../src/plugins/host'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

afterEach(removeTempDirs)

const REFRESHED = 'event:acme.tools/refreshed'

function setup() {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const disabled = new Set<string>()
  const logs: string[] = []
  const broadcasts: QuirkyEvent[] = []
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      }
    },
    emit: () => {},
    log: () => {}
  })
  const plugin = (manifest: { id: string } & Record<string, unknown>) => writeModulePlugin(installedDir, marker, manifest)
  const events = new PluginEvents(host, (event) => broadcasts.push(event), (message) => logs.push(message))
  return { host, events, plugin, broadcasts, logs, lines: () => readMarker(marker) }
}

function withTools() {
  const t = setup()
  t.plugin({
    id: 'acme.tools',
    contributes: { event: [{ id: 'refreshed' }], method: [{ id: 'refresh' }] }
  })
  t.host.load()
  return t
}

const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve))
const flush = async () => {
  await nextImmediate()
  await nextImmediate()
}

describe('PluginEvents.emit', () => {
  test('a short name broadcasts the exact event and returns true', () => {
    const t = withTools()
    expect(t.events.emit('acme.tools', 'refreshed', { n: 1 })).toBe(true)
    expect(t.broadcasts).toEqual([{ type: 'acme.tools/refreshed', data: { n: 1 } }])
  })

  test('missing data broadcasts null', () => {
    const t = withTools()
    expect(t.events.emit('acme.tools', 'refreshed', undefined)).toBe(true)
    expect(t.broadcasts).toEqual([{ type: 'acme.tools/refreshed', data: null }])
  })

  test('the plugin own event by full ID works', () => {
    const t = withTools()
    expect(t.events.emit('acme.tools', REFRESHED, 5)).toBe(true)
    expect(t.broadcasts).toEqual([{ type: 'acme.tools/refreshed', data: 5 }])
  })

  test('an undeclared short name throws', () => {
    const t = withTools()
    expect(() => t.events.emit('acme.tools', 'other', 1)).toThrow(new Error(`acme.tools does not declare event:acme.tools/other`))
    expect(t.broadcasts).toEqual([])
  })

  test('an undeclared full ID throws, including another plugin event', () => {
    const t = withTools()
    t.plugin({ id: 'acme.other', contributes: { event: [{ id: 'ping' }] } })
    t.host.load()
    expect(() => t.events.emit('acme.tools', 'event:acme.other/ping', 1)).toThrow(
      new Error('acme.tools does not declare event:acme.other/ping')
    )
    expect(() => t.events.emit('acme.tools', 'event:acme.tools/nope', 1)).toThrow(
      new Error('acme.tools does not declare event:acme.tools/nope')
    )
  })

  test('a full ID of another kind throws', () => {
    const t = withTools()
    expect(() => t.events.emit('acme.tools', 'method:acme.tools/refresh', 1)).toThrow(
      new Error('method:acme.tools/refresh is not an event')
    )
  })

  test('a disabled event returns false and broadcasts nothing', async () => {
    const t = withTools()
    await t.host.setEnabled(REFRESHED, false)
    expect(t.events.emit('acme.tools', 'refreshed', 1)).toBe(false)
    expect(t.broadcasts).toEqual([])
  })

  test('an overridden event is emitted only by the overriding plugin', () => {
    const t = withTools()
    t.plugin({ id: 'acme.better', overrides: [{ id: REFRESHED }] })
    t.host.load()
    expect(t.events.emit('acme.better', REFRESHED, 1)).toBe(true)
    expect(t.broadcasts).toEqual([{ type: 'acme.tools/refreshed', data: 1 }])
    expect(t.events.emit('acme.tools', 'refreshed', 2)).toBe(false)
    expect(t.broadcasts).toHaveLength(1)
  })

  test('an overriding plugin cannot emit the same event by short name', () => {
    const t = withTools()
    t.plugin({ id: 'acme.better', overrides: [{ id: REFRESHED }] })
    t.host.load()
    expect(() => t.events.emit('acme.better', 'refreshed', 1)).toThrow(
      new Error('acme.better does not declare event:acme.better/refreshed')
    )
  })

  test('emitting never activates a plugin', () => {
    const t = withTools()
    t.events.emit('acme.tools', 'refreshed', 1)
    expect(t.lines()).toEqual([])
  })

  test('an error from broadcast reaches the emitter', () => {
    const t = withTools()
    const events = new PluginEvents(
      t.host,
      () => {
        throw new TypeError('not serializable')
      },
      () => {}
    )
    expect(() => events.emit('acme.tools', 'refreshed', 1)).toThrow('not serializable')
  })
})

describe('PluginEvents listeners', () => {
  const event: QuirkyEvent = { type: 'repo.changed' }

  test('listeners run after queued microtasks, in registration order', async () => {
    const t = setup()
    const calls: string[] = []
    t.events.subscribe('acme.a', () => calls.push('a1'))
    t.events.subscribe('acme.b', () => calls.push('b'))
    t.events.subscribe('acme.a', () => calls.push('a2'))
    t.events.deliver(event)
    expect(calls).toEqual([])
    await Promise.resolve()
    expect(calls).toEqual([])
    await nextImmediate()
    expect(calls).toEqual(['a1', 'b', 'a2'])
  })

  test('a listener receives the event', async () => {
    const t = setup()
    const seen: QuirkyEvent[] = []
    t.events.subscribe('acme.a', (e) => seen.push(e))
    t.events.deliver(event)
    await flush()
    expect(seen).toEqual([event])
  })

  test('a throwing and a rejecting listener are logged and do not stop the others', async () => {
    const t = setup()
    const calls: string[] = []
    t.events.subscribe('acme.a', () => {
      throw new Error('sync boom')
    })
    t.events.subscribe('acme.b', async () => {
      throw new Error('async boom')
    })
    t.events.subscribe('acme.c', () => {
      throw 'plain'
    })
    t.events.subscribe('acme.d', () => calls.push('d'))
    t.events.deliver(event)
    await flush()
    expect(calls).toEqual(['d'])
    expect(t.logs.sort()).toEqual([
      'acme.a: listener failed: sync boom',
      'acme.b: listener failed: async boom',
      'acme.c: listener failed: plain'
    ])
  })

  test('unsubscribe stops delivery', async () => {
    const t = setup()
    const calls: string[] = []
    const off = t.events.subscribe('acme.a', () => calls.push('a'))
    t.events.subscribe('acme.b', () => calls.push('b'))
    off()
    off()
    t.events.deliver(event)
    await flush()
    expect(calls).toEqual(['b'])
  })

  test('removeAll drops every listener of one plugin', async () => {
    const t = setup()
    const calls: string[] = []
    t.events.subscribe('acme.a', () => calls.push('a1'))
    t.events.subscribe('acme.b', () => calls.push('b'))
    t.events.subscribe('acme.a', () => calls.push('a2'))
    t.events.removeAll('acme.a')
    t.events.deliver(event)
    await flush()
    expect(calls).toEqual(['b'])
  })

  test('a listener removed after deliver but before it runs is skipped', async () => {
    const t = setup()
    const calls: string[] = []
    t.events.subscribe('acme.a', () => calls.push('a'))
    t.events.deliver(event)
    t.events.removeAll('acme.a')
    await flush()
    expect(calls).toEqual([])
  })
})

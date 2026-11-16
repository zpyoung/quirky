import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginEvent, QuirkyEvent } from '@quirky/protocol'
import { PluginEvents } from '../../src/plugins/events'
import { PluginHost } from '../../src/plugins/host'
import { isKeyPath, readKeyPath } from '../../src/plugins/coalesce'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './fixtures'

afterEach(removeTempDirs)

const COALESCE_MS = 40
const changed = (n: number): PluginEvent => ({ type: 'acme.tools/changed', data: { n } })
const row = (sessionId: string, n: number): PluginEvent => ({
  type: 'acme.tools/row',
  data: { sessionId, n },
})
const refreshed: PluginEvent = { type: 'acme.tools/refreshed', data: {} }
const waitWindows = (windows = 3) => Bun.sleep(COALESCE_MS * windows)

function isPluginEvent(event: QuirkyEvent): event is PluginEvent {
  return 'data' in event
}

function recordPluginEvent(events: PluginEvent[], event: QuirkyEvent): void {
  if (!isPluginEvent(event)) throw new Error('expected a plugin event')
  events.push(event)
}

function numberFromPluginEvent(event: PluginEvent): number {
  const data = event.data
  if (typeof data !== 'object' || data === null || !('n' in data) || typeof data.n !== 'number') {
    throw new Error('expected numeric plugin event data')
  }
  return data.n
}

type FixtureOptions = {
  coalesceMs?: number
  now?: () => number
  plugins?: Array<{ id: string } & Record<string, unknown>>
}

function setup(options: FixtureOptions = {}) {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const disabled = new Set<string>()
  const logs: string[] = []
  const broadcasts: PluginEvent[] = []
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      },
    },
    emit: () => {},
    log: () => {},
  })
  const plugin = (manifest: { id: string } & Record<string, unknown>) => writeModulePlugin(installedDir, marker, manifest)
  plugin({
    id: 'acme.tools',
    contributes: {
      event: [
        { id: 'refreshed' },
        { id: 'changed', coalesce: [] },
        { id: 'row', coalesce: ['sessionId'] },
        { id: 'tree', worktree: 'worktreeId' },
        { id: 'status', coalesce: ['session.id'], worktree: 'session.worktreeId' },
      ],
    },
  })
  for (const extra of options.plugins ?? []) plugin(extra)
  host.load()
  const eventOptions = {
    coalesceMs: options.coalesceMs ?? COALESCE_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  const createEvents = (send: (event: QuirkyEvent) => void = (event) => recordPluginEvent(broadcasts, event)) =>
    new PluginEvents(host, send, (message) => logs.push(message), eventOptions)
  return { host, events: createEvents(), createEvents, broadcasts, logs }
}

describe('plugin coalescing key paths', () => {
  test('accepts one to four identifier segments', () => {
    for (const path of ['a', '_a', 'a.b', 'a.b.c.d', 'sessionId', 'session.id_2']) {
      expect(isKeyPath(path)).toBe(true)
    }
  })

  test('rejects malformed key paths', () => {
    for (const path of [null, 5, {}, '', 'a..b', '1a', 'a.b.c.d.e', 'a b', '.a', 'a.']) {
      expect(isKeyPath(path)).toBe(false)
    }
  })

  test('reads only own properties through plain objects', () => {
    const data = { session: { id: 's1', worktreeId: 'wt_1' } }
    const nullPrototype: unknown = Object.assign(Object.create(null), { session: { id: 's2' } })
    const inheritedRoot: unknown = Object.create({ session: { id: 'inherited' } })
    const inheritedSession: unknown = Object.create({ id: 'inherited' })
    expect(readKeyPath(data, 'session.id')).toBe('s1')
    expect(readKeyPath(data, 'session.worktreeId')).toBe('wt_1')
    expect(readKeyPath(nullPrototype, 'session.id')).toBe('s2')
    expect(readKeyPath({ session: null }, 'session.id')).toBeUndefined()
    expect(readKeyPath({ session: ['s1'] }, 'session.0')).toBeUndefined()
    expect(readKeyPath(inheritedRoot, 'session.id')).toBeUndefined()
    expect(readKeyPath({ session: inheritedSession }, 'session.id')).toBeUndefined()
    expect(readKeyPath(null, 'session.id')).toBeUndefined()
    expect(readKeyPath(5, 'session.id')).toBeUndefined()
  })
})

describe('PluginEvents coalescing and worktree tags', () => {
  test('events without metadata keep the exact immediate stream', () => {
    const t = setup()
    for (let n = 1; n <= 5; n++) expect(t.events.emit('acme.tools', 'refreshed', { n })).toBe(true)
    expect(t.broadcasts).toEqual(
      [1, 2, 3, 4, 5].map((n) => ({ type: 'acme.tools/refreshed', data: { n } }))
    )
  })

  test('sends the first emit immediately and keeps only the latest burst event', async () => {
    const t = setup()
    expect(t.events.emit('acme.tools', 'changed', { n: 1 })).toBe(true)
    expect(t.broadcasts).toEqual([changed(1)])
    for (let n = 2; n <= 50; n++) expect(t.events.emit('acme.tools', 'changed', { n })).toBe(true)
    expect(t.broadcasts).toEqual([changed(1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(50)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(50)])
  })

  test('sends an emit immediately after an idle window', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    await waitWindows()
    expect(t.events.emit('acme.tools', 'changed', { n: 2 })).toBe(true)
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
  })

  test('sends a steady emitter at most once per fixed window', async () => {
    const t = setup()
    let n = 0
    const started = Date.now()
    while (Date.now() - started < COALESCE_MS * 10) {
      t.events.emit('acme.tools', 'changed', { n: ++n })
      await Bun.sleep(5)
    }
    const elapsed = Date.now() - started
    await waitWindows()
    const values = t.broadcasts.map(numberFromPluginEvent)
    expect(values.length).toBeGreaterThanOrEqual(3)
    expect(values.length).toBeLessThanOrEqual(2 + elapsed / COALESCE_MS)
    expect(values.every((value, index) => index === 0 || value > values[index - 1]!)).toBe(true)
    expect(values.at(-1)).toBe(n)
  })

  test('keeps independently keyed events in separate windows', async () => {
    const t = setup()
    for (let n = 1; n <= 10; n++) {
      t.events.emit('acme.tools', 'row', { sessionId: 'a', n })
      t.events.emit('acme.tools', 'row', { sessionId: 'b', n })
    }
    expect(t.broadcasts.map((event) => event.data)).toEqual([
      { sessionId: 'a', n: 1 },
      { sessionId: 'b', n: 1 },
    ])
    await waitWindows()
    expect(t.broadcasts.map((event) => event.data)).toEqual([
      { sessionId: 'a', n: 1 },
      { sessionId: 'b', n: 1 },
      { sessionId: 'a', n: 10 },
      { sessionId: 'b', n: 10 },
    ])
  })

  test('uses one null key for absent values while distinguishing present values', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'row', {})
    t.events.emit('acme.tools', 'row', { sessionId: null })
    t.events.emit('acme.tools', 'row', null)
    t.events.emit('acme.tools', 'row', 5)
    t.events.emit('acme.tools', 'row', { sessionId: 'a' })
    expect(t.broadcasts.map((event) => event.data)).toEqual([{}, { sessionId: 'a' }])
    await waitWindows()
    expect(t.broadcasts.map((event) => event.data)).toEqual([{}, { sessionId: 'a' }, 5])
  })

  test('sends held events before plain events and keeps their windows armed', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([changed(1), changed(2), refreshed])

    t.events.emit('acme.tools', 'changed', { n: 3 })
    expect(t.broadcasts).toEqual([changed(1), changed(2), refreshed])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2), refreshed, changed(3)])
  })

  test('sends held events oldest first, with replacements taking their newer place', () => {
    const t = setup()
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    t.events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
    t.events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 3 })
    t.events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([
      row('a', 1),
      row('b', 1),
      row('b', 2),
      row('a', 3),
      refreshed,
    ])
  })

  test('an emit of an idle key does not release another held event', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    expect(t.broadcasts).toEqual([changed(1), row('a', 1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), row('a', 1), changed(2)])
  })

  test("another plugin's emits do not release held events", async () => {
    const t = setup({
      plugins: [{ id: 'acme.other', contributes: { event: [{ id: 'ping' }] } }],
    })
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.other', 'ping', {})
    expect(t.broadcasts).toEqual([changed(1), { type: 'acme.other/ping', data: {} }])
    await waitWindows()
    expect(t.broadcasts).toEqual([
      changed(1),
      { type: 'acme.other/ping', data: {} },
      changed(2),
    ])
  })

  test('an emit that sends nothing does not release held events', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    await t.host.setEnabled('event:acme.tools/refreshed', false)
    expect(t.events.emit('acme.tools', 'refreshed', {})).toBe(false)
    expect(t.broadcasts).toEqual([changed(1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
  })

  test('logs and drops a held event that cannot be sent before a plain event', () => {
    const t = setup()
    const events = t.createEvents((event) => {
      if (isPluginEvent(event) && event.type === 'acme.tools/changed' && numberFromPluginEvent(event) === 2) {
        throw new Error('boom')
      }
      recordPluginEvent(t.broadcasts, event)
    })
    events.emit('acme.tools', 'changed', { n: 1 })
    events.emit('acme.tools', 'changed', { n: 2 })
    expect(events.emit('acme.tools', 'refreshed', {})).toBe(true)
    expect(t.broadcasts).toEqual([changed(1), refreshed])
    expect(t.logs).toEqual(['acme.tools: could not send acme.tools/changed: boom'])
  })

  test('a plain event still throws after held events have been sent', async () => {
    const t = setup()
    const events = t.createEvents((event) => {
      if (isPluginEvent(event) && event.type === 'acme.tools/refreshed') throw new Error('boom')
      recordPluginEvent(t.broadcasts, event)
    })
    events.emit('acme.tools', 'changed', { n: 1 })
    events.emit('acme.tools', 'changed', { n: 2 })
    expect(() => events.emit('acme.tools', 'refreshed', {})).toThrow('boom')
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
    expect(t.logs).toEqual([])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
  })

  test("an unloaded plugin's held events stay dropped", () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.removeAll('acme.tools')
    t.events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([changed(1), refreshed])
  })

  test('a reentrant plain event takes its place while held events are sent', async () => {
    const t = setup()
    let events!: PluginEvents
    let reentered = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (
        !reentered &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'a' &&
        'n' in event.data &&
        event.data.n === 2
      ) {
        reentered = true
        events.emit('acme.tools', 'tree', { worktreeId: 'w' })
      }
    })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    events.emit('acme.tools', 'refreshed', {})
    const tree: PluginEvent = {
      type: 'acme.tools/tree',
      data: { worktreeId: 'w' },
      worktreeId: 'w',
    }
    expect(t.broadcasts).toEqual([
      row('a', 1),
      row('b', 1),
      row('a', 2),
      row('b', 2),
      tree,
      refreshed,
    ])
    await waitWindows()
    expect(t.broadcasts).toEqual([
      row('a', 1),
      row('b', 1),
      row('a', 2),
      row('b', 2),
      tree,
      refreshed,
    ])
  })

  test('a coalesced event emitted while held events are sent stays held', async () => {
    const t = setup()
    let events!: PluginEvents
    let reentered = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (
        !reentered &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/changed' &&
        numberFromPluginEvent(event) === 2
      ) {
        reentered = true
        events.emit('acme.tools', 'changed', { n: 3 })
      }
    })
    events.emit('acme.tools', 'changed', { n: 1 })
    events.emit('acme.tools', 'changed', { n: 2 })
    events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([changed(1), changed(2), refreshed])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2), refreshed, changed(3)])
  })

  test('an unload while held events are sent stops the remaining sends', async () => {
    const t = setup()
    let events!: PluginEvents
    let unloaded = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (
        !unloaded &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'a' &&
        'n' in event.data &&
        event.data.n === 2
      ) {
        unloaded = true
        events.removeAll('acme.tools')
      }
    })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([row('a', 1), row('b', 1), row('a', 2), refreshed])
    await waitWindows()
    expect(t.broadcasts).toEqual([row('a', 1), row('b', 1), row('a', 2), refreshed])
  })

  test('a plain event releases at most one held event per key', () => {
    const t = setup()
    for (let n = 1; n <= 6; n++) {
      t.events.emit('acme.tools', 'changed', { n })
      if (n % 2 === 0) t.events.emit('acme.tools', 'refreshed', {})
    }
    expect(t.broadcasts).toEqual([
      changed(1),
      changed(2),
      refreshed,
      changed(4),
      refreshed,
      changed(6),
      refreshed,
    ])
  })

  test('an immediate emit sends now and replaces its held event', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    expect(t.events.emit('acme.tools', 'changed', { n: 3 }, { immediate: true })).toBe(true)
    expect(t.broadcasts).toEqual([changed(1), changed(3)])
    t.events.emit('acme.tools', 'changed', { n: 4 })
    expect(t.broadcasts).toEqual([changed(1), changed(3)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(3), changed(4)])
  })

  test("an immediate emit sends the plugin's other held events first", async () => {
    const t = setup()
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    t.events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
    t.events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 3 }, { immediate: true })
    expect(t.broadcasts).toEqual([row('a', 1), row('b', 1), row('b', 2), row('a', 3)])
    await waitWindows()
    expect(t.broadcasts).toEqual([row('a', 1), row('b', 1), row('b', 2), row('a', 3)])
  })

  test('repeated immediate emits of one key all arrive', async () => {
    const t = setup()
    for (let n = 1; n <= 6; n++) {
      t.events.emit('acme.tools', 'row', { sessionId: 'a', n }, { immediate: true })
    }
    expect(t.broadcasts).toEqual([1, 2, 3, 4, 5, 6].map((n) => row('a', n)))
    await waitWindows()
    expect(t.broadcasts).toEqual([1, 2, 3, 4, 5, 6].map((n) => row('a', n)))
  })

  test('an immediate emit of an idle key arms its window', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 }, { immediate: true })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    expect(t.broadcasts).toEqual([changed(1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
  })

  test('an immediate emit does not depend on another event', async () => {
    const t = setup({
      plugins: [{ id: 'acme.override', overrides: [{ id: 'event:acme.tools/tree' }] }],
    })
    await t.host.setEnabled('event:acme.tools/refreshed', false)
    expect(t.events.emit('acme.tools', 'refreshed', {})).toBe(false)
    expect(t.events.emit('acme.tools', 'tree', { worktreeId: 'w' })).toBe(false)
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.tools', 'changed', { n: 3 }, { immediate: true })
    t.events.emit('acme.tools', 'changed', { n: 4 }, { immediate: true })
    expect(t.broadcasts).toEqual([changed(1), changed(3), changed(4)])
  })

  test('a disabled event sends nothing and releases nothing, even when immediate', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 })
    t.events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
    await t.host.setEnabled('event:acme.tools/changed', false)
    expect(t.events.emit('acme.tools', 'changed', { n: 1 }, { immediate: true })).toBe(false)
    expect(t.broadcasts).toEqual([row('a', 1)])
  })

  test('only immediate true counts, and a plain event ignores the option', async () => {
    const t = setup()
    const invalidImmediate = { immediate: 'yes' } as unknown as { immediate?: boolean }
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 }, { immediate: false })
    t.events.emit('acme.tools', 'changed', { n: 3 }, invalidImmediate)
    expect(t.broadcasts).toEqual([changed(1)])
    t.events.emit('acme.tools', 'refreshed', {}, { immediate: true })
    expect(t.broadcasts).toEqual([changed(1), changed(3), refreshed])
  })

  test('an immediate send failure throws after held events have gone out', async () => {
    const t = setup()
    const events = t.createEvents((event) => {
      if (isPluginEvent(event) && event.type === 'acme.tools/changed' && numberFromPluginEvent(event) === 3) {
        throw new Error('boom')
      }
      recordPluginEvent(t.broadcasts, event)
    })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    events.emit('acme.tools', 'changed', { n: 1 })
    expect(() => events.emit('acme.tools', 'changed', { n: 3 }, { immediate: true })).toThrow('boom')
    expect(t.broadcasts).toEqual([row('b', 1), changed(1), row('b', 2)])
    events.emit('acme.tools', 'changed', { n: 4 })
    await waitWindows()
    expect(t.broadcasts).toEqual([row('b', 1), changed(1), row('b', 2), changed(4)])
  })

  test('replacing a held event with an immediate emit counts as a merge', () => {
    let now = 0
    const t = setup({ now: () => now })
    t.events.emit('acme.tools', 'changed', { n: 0 })
    for (let n = 1; n <= 600; n++) {
      t.events.emit('acme.tools', 'changed', { n })
      t.events.emit('acme.tools', 'changed', { n }, { immediate: true })
    }
    now = 60_000
    t.events.emit('acme.tools', 'changed', { n: 601 })
    t.events.emit('acme.tools', 'changed', { n: 602 }, { immediate: true })
    expect(t.logs).toEqual(['acme.tools: acme.tools/changed merged 601 emits in the last 60 s'])
  })

  test('an immediate emit reserves its place before draining other keys', async () => {
    const t = setup()
    let events!: PluginEvents
    let reentered = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (
        !reentered &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'b' &&
        'n' in event.data &&
        event.data.n === 2
      ) {
        reentered = true
        events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 })
      }
    })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 }, { immediate: true })
    expect(t.broadcasts).toEqual([row('b', 1), row('b', 2), row('a', 1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([row('b', 1), row('b', 2), row('a', 1), row('a', 2)])
  })

  test('a reentrant immediate emit cannot overtake the older immediate emit', async () => {
    const run = async (activeTarget: boolean) => {
      const t = setup()
      let events!: PluginEvents
      let reentered = false
      events = t.createEvents((event) => {
        recordPluginEvent(t.broadcasts, event)
        if (
          !reentered &&
          isPluginEvent(event) &&
          event.type === 'acme.tools/row' &&
          event.data !== null &&
          typeof event.data === 'object' &&
          'sessionId' in event.data &&
          event.data.sessionId === 'b' &&
          'n' in event.data &&
          event.data.n === 2
        ) {
          reentered = true
          events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 }, { immediate: true })
        }
      })
      if (activeTarget) {
        events.emit('acme.tools', 'row', { sessionId: 'a', n: -1 })
        events.emit('acme.tools', 'row', { sessionId: 'a', n: 0 })
      }
      events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
      events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
      events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 }, { immediate: true })
      const expected = activeTarget
        ? [row('a', -1), row('b', 1), row('b', 2), row('a', 1), row('a', 2)]
        : [row('b', 1), row('b', 2), row('a', 1), row('a', 2)]
      expect(t.broadcasts).toEqual(expected)
      await waitWindows()
      expect(t.broadcasts).toEqual(expected)
    }

    await run(false)
    await run(true)
  })

  test('a failed outer immediate send does not strand a reentrant immediate emit', async () => {
    const t = setup()
    let events!: PluginEvents
    let reentered = false
    events = t.createEvents((event) => {
      if (
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'a' &&
        'n' in event.data &&
        event.data.n === 1
      ) {
        throw new Error('boom')
      }
      recordPluginEvent(t.broadcasts, event)
      if (
        !reentered &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'b' &&
        'n' in event.data &&
        event.data.n === 2
      ) {
        reentered = true
        events.emit('acme.tools', 'row', { sessionId: 'a', n: 2 }, { immediate: true })
      }
    })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    expect(() =>
      events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 }, { immediate: true })
    ).toThrow('boom')
    expect(t.broadcasts).toEqual([row('b', 1), row('b', 2), row('a', 2)])
    expect(t.logs).toEqual([])
    await waitWindows()
    expect(t.broadcasts).toEqual([row('b', 1), row('b', 2), row('a', 2)])
    expect(t.logs).toEqual([])
  })

  test('removing an owner while draining held events keeps the immediate emit', async () => {
    const t = setup()
    let events!: PluginEvents
    let removed = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (
        !removed &&
        isPluginEvent(event) &&
        event.type === 'acme.tools/row' &&
        event.data !== null &&
        typeof event.data === 'object' &&
        'sessionId' in event.data &&
        event.data.sessionId === 'b' &&
        'n' in event.data &&
        event.data.n === 2
      ) {
        removed = true
        events.removeAll('acme.tools')
      }
    })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'c', n: 1 })
    events.emit('acme.tools', 'row', { sessionId: 'b', n: 2 })
    events.emit('acme.tools', 'row', { sessionId: 'c', n: 2 })
    events.emit('acme.tools', 'row', { sessionId: 'a', n: 1 }, { immediate: true })
    expect(t.broadcasts).toEqual([row('b', 1), row('c', 1), row('b', 2), row('a', 1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([row('b', 1), row('c', 1), row('b', 2), row('a', 1)])
  })

  test('delivers the same coalesced stream to plugin listeners', async () => {
    const t = setup()
    let events!: PluginEvents
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      events.deliver(event)
    })
    const seen: unknown[] = []
    events.subscribe('acme.tools', (event) => {
      if (!isPluginEvent(event)) throw new Error('expected a plugin event')
      seen.push(event.data)
    })
    for (let n = 1; n <= 50; n++) events.emit('acme.tools', 'changed', { n })
    await waitWindows()
    const { promise, resolve } = Promise.withResolvers<void>()
    setImmediate(resolve)
    await promise
    expect(seen).toEqual([{ n: 1 }, { n: 50 }])
  })

  test('does not hold events disabled or replaced by an override', async () => {
    const t = setup({
      plugins: [{ id: 'acme.override', overrides: [{ id: 'event:acme.tools/changed' }] }],
    })
    await t.host.setEnabled('event:acme.tools/changed', false)
    expect(t.events.emit('acme.tools', 'changed', { n: 1 })).toBe(false)
    expect(t.broadcasts).toEqual([])
    await t.host.setEnabled('event:acme.tools/changed', true)
    expect(t.events.emit('acme.tools', 'changed', { n: 2 })).toBe(false)
    await waitWindows()
    expect(t.broadcasts).toEqual([])
  })

  test('adds a declared non-empty string worktree ID to the event envelope', () => {
    const t = setup()
    expect(t.events.emit('acme.tools', 'tree', { worktreeId: 'wt_1' })).toBe(true)
    expect(t.broadcasts).toEqual([
      { type: 'acme.tools/tree', data: { worktreeId: 'wt_1' }, worktreeId: 'wt_1' },
    ])
  })

  test('omits a tag when the declared worktree path is absent or invalid', () => {
    const t = setup()
    for (const data of [{}, { worktreeId: '' }, { worktreeId: 7 }, { worktreeId: null }, null]) {
      expect(t.events.emit('acme.tools', 'tree', data)).toBe(true)
    }
    expect(t.broadcasts).toEqual(
      [{}, { worktreeId: '' }, { worktreeId: 7 }, { worktreeId: null }, null].map((data) => ({
        type: 'acme.tools/tree',
        data,
      }))
    )
  })

  test('does not coalesce an event that only declares a worktree tag', () => {
    const t = setup()
    for (let n = 1; n <= 3; n++) t.events.emit('acme.tools', 'tree', { worktreeId: 'wt_1', n })
    expect(t.broadcasts).toEqual(
      [1, 2, 3].map((n) => ({
        type: 'acme.tools/tree',
        data: { worktreeId: 'wt_1', n },
        worktreeId: 'wt_1',
      }))
    )
  })

  test('uses nested key paths and includes worktree tags in the coalescing key', async () => {
    const t = setup()
    for (let n = 1; n <= 3; n++) {
      t.events.emit('acme.tools', 'status', { session: { id: 's1', worktreeId: 'wt_1', n } })
      t.events.emit('acme.tools', 'status', { session: { id: 's1', worktreeId: 'wt_2', n } })
    }
    expect(t.broadcasts).toEqual([
      {
        type: 'acme.tools/status',
        data: { session: { id: 's1', worktreeId: 'wt_1', n: 1 } },
        worktreeId: 'wt_1',
      },
      {
        type: 'acme.tools/status',
        data: { session: { id: 's1', worktreeId: 'wt_2', n: 1 } },
        worktreeId: 'wt_2',
      },
    ])
    await waitWindows()
    expect(t.broadcasts.slice(2)).toEqual([
      {
        type: 'acme.tools/status',
        data: { session: { id: 's1', worktreeId: 'wt_1', n: 3 } },
        worktreeId: 'wt_1',
      },
      {
        type: 'acme.tools/status',
        data: { session: { id: 's1', worktreeId: 'wt_2', n: 3 } },
        worktreeId: 'wt_2',
      },
    ])
  })

  test('ignores inherited and non-plain nested objects for tags and keys', async () => {
    const t = setup()
    const inherited: unknown = Object.create({ session: { id: 's1', worktreeId: 'wt_1' } })
    t.events.emit('acme.tools', 'status', { session: ['s1'] })
    t.events.emit('acme.tools', 'status', inherited)
    expect(t.broadcasts).toEqual([{ type: 'acme.tools/status', data: { session: ['s1'] } }])
    await waitWindows()
    expect(t.broadcasts).toEqual([
      { type: 'acme.tools/status', data: { session: ['s1'] } },
      { type: 'acme.tools/status', data: inherited },
    ])
  })

  test('drops only the removed plugin owner’s held events', async () => {
    const t = setup({
      plugins: [{ id: 'acme.other', contributes: { event: [{ id: 'changed', coalesce: [] }] } }],
    })
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.other', 'changed', { n: 1 })
    t.events.emit('acme.other', 'changed', { n: 2 })
    t.events.removeAll('acme.tools')
    await waitWindows()
    expect(t.broadcasts).toEqual([
      { type: 'acme.tools/changed', data: { n: 1 } },
      { type: 'acme.other/changed', data: { n: 1 } },
      { type: 'acme.other/changed', data: { n: 2 } },
    ])
    expect(t.events.emit('acme.tools', 'changed', { n: 3 })).toBe(true)
    expect(t.broadcasts.at(-1)).toEqual({ type: 'acme.tools/changed', data: { n: 3 } })
  })

  test('a failed leading send throws and leaves the next leading send immediate', () => {
    const t = setup()
    let attempts = 0
    const events = t.createEvents((event) => {
      if (++attempts === 1) throw new Error('boom')
      recordPluginEvent(t.broadcasts, event)
    })
    expect(() => events.emit('acme.tools', 'changed', { n: 1 })).toThrow('boom')
    expect(events.emit('acme.tools', 'changed', { n: 2 })).toBe(true)
    expect(t.broadcasts).toEqual([changed(2)])
  })

  test('discards reentrant held state when the leading send fails', async () => {
    const t = setup()
    let events!: PluginEvents
    let firstSend = true
    events = t.createEvents((event) => {
      if (firstSend) {
        firstSend = false
        events.emit('acme.tools', 'changed', { n: 2 })
        throw new Error('boom')
      }
      recordPluginEvent(t.broadcasts, event)
    })
    expect(() => events.emit('acme.tools', 'changed', { n: 1 })).toThrow('boom')
    expect(events.emit('acme.tools', 'changed', { n: 3 })).toBe(true)
    expect(t.broadcasts).toEqual([changed(3)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(3)])
  })

  test('logs and drops a failed held send', async () => {
    const t = setup()
    let attempts = 0
    const events = t.createEvents((event) => {
      if (++attempts === 2) throw new Error('boom')
      recordPluginEvent(t.broadcasts, event)
    })
    events.emit('acme.tools', 'changed', { n: 1 })
    events.emit('acme.tools', 'changed', { n: 2 })
    await waitWindows()
    expect(t.logs).toEqual(['acme.tools: could not send acme.tools/changed: boom'])
    expect(events.emit('acme.tools', 'changed', { n: 3 })).toBe(true)
    expect(t.broadcasts).toEqual([changed(1), changed(3)])
  })

  test('logs heavy per-type merging only when the minute span reaches the threshold', () => {
    let now = 0
    const t = setup({ now: () => now })
    t.events.emit('acme.tools', 'changed', { n: 0 })
    for (let n = 1; n <= 601; n++) t.events.emit('acme.tools', 'changed', { n })
    expect(t.logs).toEqual([])
    now = 60_000
    t.events.emit('acme.tools', 'changed', { n: 602 })
    expect(t.logs).toEqual(['acme.tools: acme.tools/changed merged 601 emits in the last 60 s'])

    for (let n = 0; n < 598; n++) t.events.emit('acme.tools', 'changed', { n: 603 + n })
    now = 120_000
    t.events.emit('acme.tools', 'changed', { n: 1201 })
    expect(t.logs).toEqual(['acme.tools: acme.tools/changed merged 601 emits in the last 60 s'])

    let belowThresholdNow = 0
    const belowThreshold = setup({ now: () => belowThresholdNow })
    belowThreshold.events.emit('acme.tools', 'changed', { n: 0 })
    for (let n = 1; n <= 599; n++) belowThreshold.events.emit('acme.tools', 'changed', { n })
    belowThresholdNow = 60_000
    belowThreshold.events.emit('acme.tools', 'changed', { n: 600 })
    expect(belowThreshold.logs).toEqual([])

    for (let n = 0; n < 598; n++) belowThreshold.events.emit('acme.tools', 'changed', { n: 601 + n })
    belowThresholdNow = 120_000
    belowThreshold.events.emit('acme.tools', 'changed', { n: 1199 })
    expect(belowThreshold.logs).toEqual([])
  })

  test('logs exactly 600 replacements when the minute span ends', () => {
    let now = 0
    const t = setup({ now: () => now })
    t.events.emit('acme.tools', 'changed', { n: 0 })
    for (let n = 1; n <= 600; n++) t.events.emit('acme.tools', 'changed', { n })
    expect(t.logs).toEqual([])
    now = 60_000
    t.events.emit('acme.tools', 'changed', { n: 601 })
    expect(t.logs).toEqual(['acme.tools: acme.tools/changed merged 600 emits in the last 60 s'])
  })

  test('preserves emit order when a leading broadcast reenters emit', async () => {
    const t = setup()
    let events!: PluginEvents
    let reentered = false
    events = t.createEvents((event) => {
      recordPluginEvent(t.broadcasts, event)
      if (!reentered) {
        reentered = true
        expect(events.emit('acme.tools', 'changed', { n: 2 })).toBe(true)
      }
    })
    events.emit('acme.tools', 'changed', { n: 1 })
    expect(t.broadcasts).toEqual([changed(1)])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), changed(2)])
  })

  test('uses the effective override metadata for coalescing', async () => {
    const t = setup({
      plugins: [
        {
          id: 'acme.override',
          overrides: [
            { id: 'event:acme.tools/changed' },
            { id: 'event:acme.tools/refreshed', coalesce: [] },
          ],
        },
      ],
    })
    for (let n = 1; n <= 3; n++) t.events.emit('acme.override', 'event:acme.tools/changed', { n })
    expect(t.broadcasts).toEqual([
      { type: 'acme.tools/changed', data: { n: 1 } },
      { type: 'acme.tools/changed', data: { n: 2 } },
      { type: 'acme.tools/changed', data: { n: 3 } },
    ])
    t.events.emit('acme.override', 'event:acme.tools/refreshed', { n: 1 })
    t.events.emit('acme.override', 'event:acme.tools/refreshed', { n: 2 })
    expect(t.broadcasts.at(-1)).toEqual({ type: 'acme.tools/refreshed', data: { n: 1 } })
    await waitWindows()
    expect(t.broadcasts.at(-1)).toEqual({ type: 'acme.tools/refreshed', data: { n: 2 } })
  })
})

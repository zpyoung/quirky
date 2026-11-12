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

  test('allows a held event to arrive after an event of another type', async () => {
    const t = setup()
    t.events.emit('acme.tools', 'changed', { n: 1 })
    t.events.emit('acme.tools', 'changed', { n: 2 })
    t.events.emit('acme.tools', 'refreshed', {})
    expect(t.broadcasts).toEqual([changed(1), refreshed])
    await waitWindows()
    expect(t.broadcasts).toEqual([changed(1), refreshed, changed(2)])
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

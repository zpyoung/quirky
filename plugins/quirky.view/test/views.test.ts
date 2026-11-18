import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type ApiDescription, type PluginInfo } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import bundleSize from './fixtures/bundle-size.json'
import { MAX_REJECTED_SOURCE_BYTES } from '../src/core/views'
import { agent, cleanupViews, spec, startView, strangerCaller, tempDatabasePath, windowCaller, type ViewHarness } from './support'

const started: ViewHarness[] = []
const harnesses: Harness[] = []
const tempDirs: string[] = []

function start(path?: string): ViewHarness {
  const harness = startView(path)
  started.push(harness)
  return harness
}

afterEach(async () => {
  for (const harness of started.splice(0)) harness.stop()
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanupViews()
})

async function rejection(promise: Promise<unknown>): Promise<{ code: number; message: string; data?: unknown }> {
  try {
    await promise
  } catch (error) {
    return error as never
  }
  throw new Error('expected a rejection')
}

describe('open', () => {
  test('stores the checked spec for the caller session, inline by default, and announces it once', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: bundleSize })
    expect(viewId).toMatch(/^view_[0-9a-f]{12}$/)
    expect(await h.call('get', { viewId }, windowCaller)).toEqual({
      viewId,
      sessionId: 's1',
      title: 'Bundle size by route',
      spec: bundleSize,
      placement: 'inline',
      movedByUser: false,
      updates: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      closed: false
    })
    expect(h.events).toEqual([{ event: 'changed', data: { sessionId: 's1', viewId } }])
  })

  test('an agent can open a view in the pane', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec(), placement: 'pane' })
    expect((await h.call('get', { viewId }, windowCaller)).placement).toBe('pane')
  })

  test('a placement other than inline or pane is refused', async () => {
    const h = start()
    const error = await rejection(h.call('open', { spec: spec(), placement: 'floating' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(h.events).toEqual([])
  })

  test('a spec given as JSON text is parsed', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: JSON.stringify(spec('From text')) })
    expect((await h.call('get', { viewId }, windowCaller)).title).toBe('From text')
  })

  test('the session comes from the caller authority, never from params', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec(), session: 's2', sessionId: 's2' }, agent('s1'))
    expect((await h.call('get', { viewId }, windowCaller)).sessionId).toBe('s1')
  })

  test('callers without a live session identity are refused with the session message', async () => {
    const h = start()
    const forged = { role: 'cli', sessionId: 's1' } as const
    const mismatched = { ...agent('s1'), sessionId: 's2' }
    for (const caller of [strangerCaller, windowCaller, forged, mismatched, { role: 'plugin', pluginId: 'quirky.structured' } as const]) {
      const error = await rejection(h.call('open', { spec: spec() }, caller))
      expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'quirky view works only inside a Quirky agent session' })
    }
    expect(h.events).toEqual([])
  })
})

describe('list and get', () => {
  test('list returns a session\'s views in opening order, closed ones included', async () => {
    const h = start()
    const first = (await h.call('open', { spec: spec('One') })).viewId
    const second = (await h.call('open', { spec: spec('Two'), placement: 'pane' })).viewId
    await h.call('open', { spec: spec('Other') }, agent('s2'))
    await h.call('close', { viewId: first })
    const views = await h.call('list', { session: 's1' }, windowCaller)
    expect(views.map((view: { viewId: string; closed: boolean }) => [view.viewId, view.closed])).toEqual([[first, true], [second, false]])
    expect(await h.call('list', { session: 'nobody' }, windowCaller)).toEqual([])
  })

  test('the window, plugins and the owning session can read; another session cannot', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('get', { viewId }, windowCaller)
    await h.call('get', { viewId }, { role: 'plugin', pluginId: 'quirky.structured' })
    await h.call('get', { viewId }, agent('s1'))
    expect((await rejection(h.call('get', { viewId }, agent('s2')))).code).toBe(RpcErrorCode.Conflict)
    expect((await rejection(h.call('list', { session: 's1' }, strangerCaller))).code).toBe(RpcErrorCode.Conflict)
  })

  test('an unknown view is not found', async () => {
    const h = start()
    expect((await rejection(h.call('get', { viewId: 'view_missing' }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('update', () => {
  test('replaces the content in place, counts the update and announces it', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('First', 'one') })
    await h.call('update', { viewId, spec: spec('Second', 'two') })
    await h.call('update', { viewId, spec: spec('Third', 'three') })
    const record = await h.call('get', { viewId }, windowCaller)
    expect(record).toMatchObject({ title: 'Third', spec: spec('Third', 'three'), updates: 2, placement: 'inline' })
    expect(record.updatedAt >= record.createdAt).toBe(true)
    expect(await h.call('list', { session: 's1' }, windowCaller)).toHaveLength(1)
    expect(h.events.map((event) => event.event)).toEqual(['changed', 'changed', 'changed'])
  })

  test('only the owning session can update, and only while the view is open', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('update', { viewId, spec: spec() }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('update', { viewId, spec: spec() }, strangerCaller))).message).toContain('Quirky agent session')
    await h.call('close', { viewId })
    expect((await rejection(h.call('update', { viewId, spec: spec() }))).code).toBe(RpcErrorCode.Conflict)
  })
})

describe('move', () => {
  test('the user\'s move holds across the agent\'s later updates', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec(), placement: 'pane' })
    const moved = await h.call('move', { viewId, placement: 'inline' }, windowCaller)
    expect(moved).toMatchObject({ placement: 'inline', movedByUser: true, updates: 0 })
    await h.call('update', { viewId, spec: spec('Updated') })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ placement: 'inline', movedByUser: true, updates: 1, title: 'Updated' })
    expect(h.events.at(-1)).toEqual({ event: 'changed', data: { sessionId: 's1', viewId } })
  })

  test('an update with no move keeps the placement the agent chose', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec(), placement: 'pane' })
    await h.call('update', { viewId, spec: spec('Updated') })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ placement: 'pane', movedByUser: false })
  })

  test('move is for the window: sessions, other clients and plugins are refused', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    for (const caller of [agent('s1'), strangerCaller, { role: 'mobile' } as const, { role: 'plugin', pluginId: 'quirky.structured' } as const]) {
      expect((await rejection(h.call('move', { viewId, placement: 'pane' }, caller))).code).toBe(RpcErrorCode.Conflict)
    }
    expect((await h.call('get', { viewId }, windowCaller)).movedByUser).toBe(false)
  })

  test('a placement other than inline or pane, and a closed view, are refused', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('move', { viewId, placement: 'x' }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
    await h.call('close', { viewId })
    expect((await rejection(h.call('move', { viewId, placement: 'pane' }, windowCaller))).code).toBe(RpcErrorCode.Conflict)
  })
})

describe('close', () => {
  test('marks the view closed, keeps its record and announces it', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('close', { viewId })
    await h.call('close', { viewId })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: true })
    expect(h.events.map((event) => event.event)).toEqual(['changed', 'changed'])
  })

  test('only the owning session can close', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('close', { viewId }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
  })

  test('ends a pending wait with a closed status', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const waiting = h.call('wait', { viewId })
    await h.call('close', { viewId })
    expect(await waiting).toEqual({ status: 'closed' })
    expect(await h.call('wait', { viewId })).toEqual({ status: 'closed' })
  })
})

describe('wait and action', () => {
  test('an action resolves the pending wait and is not also sent as a message', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Bundle size') })
    const waiting = h.call('wait', { viewId })
    const routed = await h.call('action', { viewId, name: 'lazy-load-zxcvbn', source: 'button', data: { reason: 'size' } }, windowCaller)
    expect(routed).toEqual({ delivered: 'wait' })
    expect(await waiting).toEqual({
      action: { name: 'lazy-load-zxcvbn', viewId, source: 'button', at: expect.any(String), data: { reason: 'size' } }
    })
    expect(h.sends).toEqual([])
  })

  test('a field action whose text breaks the declared pattern or format is refused', async () => {
    const h = start()
    const question = { id: 'email', type: 'text', question: 'Email?', pattern: '^[^ ]+@example\\.com$', format: 'email' }
    const { viewId } = await h.call('open', { spec: { title: 'Ask', root: { type: 'field', props: { question } } } })
    const bad = await rejection(h.call('action', { viewId, name: 'email', source: 'field', data: { value: 'not an email' } }, windowCaller))
    expect(bad.code).toBe(RpcErrorCode.InvalidParams)
    expect(h.sends).toEqual([])
    expect(await h.call('action', { viewId, name: 'email', source: 'field', data: { value: 'a@example.com' } }, windowCaller)).toEqual({ delivered: 'message' })
  })

  test('every wait parked on the view gets the action', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const waits = [h.call('wait', { viewId }), h.call('wait', { viewId })]
    await h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller)
    for (const result of await Promise.all(waits)) expect(result.action).toMatchObject({ name: 'go', viewId })
    expect(h.sends).toEqual([])
  })

  test('a wait that nobody answers times out, and timeoutMs 0 returns at once', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect(await h.call('wait', { viewId, timeoutMs: 20 })).toEqual({ status: 'timeout' })
    expect(await h.call('wait', { viewId, timeoutMs: 0 })).toEqual({ status: 'timeout' })
    expect((await rejection(h.call('wait', { viewId, timeoutMs: -1 }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a dropped connection releases its wait', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    let close: () => void = () => {}
    const caller = { ...agent('s1'), connection: { onClose: (listener: () => void) => ((close = listener), () => {}) } } as never
    const waiting = h.call('wait', { viewId }, caller)
    close()
    expect(await waiting).toEqual({ status: 'timeout' })
    const routed = await h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller)
    expect(routed).toEqual({ delivered: 'message' })
  })

  test('with no pending wait the action is sent to the session when idle, in the pinned text', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Bundle size') })
    expect(await h.call('action', { viewId, name: 'lazy-load-zxcvbn', source: 'button', data: { reason: 'size' } }, windowCaller)).toEqual({ delivered: 'message' })
    expect(await h.call('action', { viewId, name: 'refresh', source: 'button' }, windowCaller)).toEqual({ delivered: 'message' })
    expect(h.sends).toEqual([
      { session: 's1', text: `View action "lazy-load-zxcvbn" from "Bundle size" (view ${viewId}): {"reason":"size"}`, when: 'idle' },
      { session: 's1', text: `View action "refresh" from "Bundle size" (view ${viewId}): {}`, when: 'idle' }
    ])
  })

  test('the message names the view\'s current title', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Old') })
    await h.call('update', { viewId, spec: spec('New') })
    await h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller)
    expect(h.sends[0].text).toStartWith('View action "go" from "New"')
  })

  test('a session that cannot take the message makes the action fail visibly', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    h.sendResult.value = () => {
      throw new Error('session is stopped')
    }
    expect((await rejection(h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller))).message).toBe('could not send the action to the agent: session is stopped')
    h.sendResult.value = { ok: false, reason: 'agent-busy' }
    expect((await rejection(h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller))).message).toBe('the agent did not take the action: agent-busy')
  })

  test('action is for the window and checks its input', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    for (const caller of [agent('s1'), strangerCaller, { role: 'plugin', pluginId: 'quirky.structured' } as const]) {
      expect((await rejection(h.call('action', { viewId, name: 'go', source: 'button' }, caller))).code).toBe(RpcErrorCode.Conflict)
    }
    const bad: Record<string, unknown>[] = [
      { name: 'Go', source: 'button' },
      { name: '', source: 'button' },
      { name: 'go', source: '' },
      { name: 'go', source: 'button', data: 'text' },
      { name: 'go', source: 'button', data: ['a'] }
    ]
    for (const params of bad) expect((await rejection(h.call('action', { viewId, ...params }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await rejection(h.call('action', { viewId: 'view_missing', name: 'go', source: 'button' }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
    expect(h.sends).toEqual([])
  })

  test('a closed view takes no actions', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('close', { viewId })
    expect((await rejection(h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller))).code).toBe(RpcErrorCode.Conflict)
  })

  test('only the owning session can wait', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('wait', { viewId }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('wait', { viewId }, strangerCaller))).message).toContain('Quirky agent session')
  })

  test('stopping the plugin releases parked waits', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const waiting = h.call('wait', { viewId })
    h.stop()
    expect(await waiting).toEqual({ status: 'timeout' })
  })
})

describe('rejected specs', () => {
  const invalid = { title: 'Broken view', root: { type: 'tabel', props: {} } }

  test('open emits rejected with the title, formatted errors and the source, stores nothing and fails with the errors', async () => {
    const h = start()
    const error = await rejection(h.call('open', { spec: invalid }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: "root.type: unknown type 'tabel'; did you mean table?" })
    expect(h.events).toEqual([
      {
        event: 'rejected',
        data: {
          sessionId: 's1',
          title: 'Broken view',
          errors: ["root.type: unknown type 'tabel'; did you mean table?"],
          source: JSON.stringify(invalid, null, 2)
        }
      }
    ])
    expect(await h.call('list', { session: 's1' }, windowCaller)).toEqual([])
  })

  test('each error is its own entry', async () => {
    const h = start()
    await rejection(h.call('open', { spec: { title: 'T', root: { type: 'callout' } } }))
    expect(h.events[0].data.errors).toEqual(['root.props.tone: is required', 'root.props.text: is required'])
  })

  test('the title is Untitled view when the spec has none to read', async () => {
    const h = start()
    await rejection(h.call('open', { spec: { root: { type: 'stack' } } }))
    await rejection(h.call('open', { spec: { title: '   ', root: { type: 'stack' } } }))
    await rejection(h.call('open', { spec: [1, 2] }))
    expect(h.events.map((event) => event.data.title)).toEqual(['Untitled view', 'Untitled view', 'Untitled view'])
  })

  test('text that is not JSON is rejected with the text as its source', async () => {
    const h = start()
    const error = await rejection(h.call('open', { spec: '{"title": ' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(h.events[0].data).toMatchObject({ title: 'Untitled view', source: '{"title": ', errors: [expect.stringContaining('spec is not valid JSON')] })
  })

  test('the source is capped at 64 KiB', async () => {
    const h = start()
    const big = { title: 'Big', root: { type: 'stack', children: [{ type: 'code', props: { text: 'x'.repeat(100_000) } }, { type: 'nope' }] } }
    await rejection(h.call('open', { spec: big }))
    const { source } = h.events[0].data
    expect(Buffer.byteLength(source)).toBe(MAX_REJECTED_SOURCE_BYTES)
    expect(source.startsWith('{\n  "title": "Big"')).toBe(true)
  })

  test('a refused update emits rejected, keeps the old content and does not count', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Good') })
    await rejection(h.call('update', { viewId, spec: invalid }))
    expect(h.events.at(-1)).toMatchObject({ event: 'rejected', data: { sessionId: 's1', title: 'Broken view' } })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ title: 'Good', updates: 0 })
  })

  test('an update to a view the caller does not own is not found, and announces nothing', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const before = h.events.length
    await rejection(h.call('update', { viewId, spec: invalid }, agent('s2')))
    expect(h.events).toHaveLength(before)
  })

  test('a missing spec is invalid params without a rejected event', async () => {
    const h = start()
    expect((await rejection(h.call('open', {}))).code).toBe(RpcErrorCode.InvalidParams)
    expect(h.events).toEqual([])
  })
})

describe('persistence', () => {
  test('views, placement overrides and counters survive a restart', async () => {
    const path = tempDatabasePath()
    const before = start(path)
    const kept = (await before.call('open', { spec: bundleSize, placement: 'pane' })).viewId
    const closed = (await before.call('open', { spec: spec('Closed') })).viewId
    await before.call('update', { viewId: kept, spec: spec('Updated once') })
    await before.call('move', { viewId: kept, placement: 'inline' }, windowCaller)
    await before.call('close', { viewId: closed })
    const records = await before.call('list', { session: 's1' }, windowCaller)
    before.stop()

    const after = start(path)
    expect(await after.call('list', { session: 's1' }, windowCaller)).toEqual(records)
    expect(records[0]).toMatchObject({ viewId: kept, title: 'Updated once', placement: 'inline', movedByUser: true, updates: 1, closed: false })
    expect(records[1]).toMatchObject({ viewId: closed, closed: true })

    await after.call('update', { viewId: kept, spec: spec('Updated twice') })
    expect(await after.call('get', { viewId: kept }, windowCaller)).toMatchObject({ updates: 2, placement: 'inline' })
    const next = (await after.call('open', { spec: spec() })).viewId
    expect(new Set([kept, closed, next]).size).toBe(3)
  })
})

describe('as a built-in plugin', () => {
  async function daemon(): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'qv-bi-'))
    tempDirs.push(dir)
    symlinkSync(resolve(import.meta.dir, '..'), join(dir, 'quirky.view'))
    const harness = await startHarness({ home: makeTempHome('qv-'), builtinPluginsDir: dir })
    harnesses.push(harness)
    return harness
  }

  test('loads without diagnostics and lists its methods, events and CLI commands', async () => {
    const h = await daemon()
    const client = await h.connect('cli')
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.view')!
    expect(info).toMatchObject({ source: 'builtin', activation: 'lazy', dependencies: [] })
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(info.state).not.toBe('invalid')

    const api = (await client.call('api.describe', {})) as ApiDescription
    expect(api.methods.filter((method) => method.plugin === 'quirky.view').map((method) => method.name)).toEqual([
      'quirky.view/action',
      'quirky.view/close',
      'quirky.view/get',
      'quirky.view/list',
      'quirky.view/move',
      'quirky.view/open',
      'quirky.view/update',
      'quirky.view/wait'
    ])
    expect(api.events.filter((event) => event.plugin === 'quirky.view').map((event) => event.name)).toEqual(['quirky.view/changed', 'quirky.view/rejected'])
    expect(api.cli.commands.filter((command) => command.plugin === 'quirky.view').map((command) => command.words).sort()).toEqual([
      'view',
      'view close',
      'view open',
      'view update',
      'view wait'
    ])
  })

  test('refuses a client with no session identity and a non-window caller moving a view', async () => {
    const h = await daemon()
    const cli = await h.connect('cli')
    expect((await rejection(cli.callAny('quirky.view/open', { spec: spec() }))).message).toBe('quirky view works only inside a Quirky agent session')
    const window = await h.connect('ui')
    expect((await rejection(window.callAny('quirky.view/open', { spec: spec() }))).code).toBe(RpcErrorCode.Conflict)
    expect(await window.callAny('quirky.view/list', { session: 's1' })).toEqual([])
    expect((await rejection(cli.callAny('quirky.view/move', { viewId: 'view_x', placement: 'pane' }))).code).toBe(RpcErrorCode.Conflict)
  })
})

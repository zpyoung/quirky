import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RpcErrorCode, type ApiDescription, type PluginInfo } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import authFlowV1 from './fixtures/auth-flow-v1.json'
import authFlowV2 from './fixtures/auth-flow-v2.json'
import bundleSize from './fixtures/bundle-size.json'
import visualKinds from './fixtures/visual-kinds.json'
import { Database } from 'bun:sqlite'
import { viewsMigration } from '../src/core/store'
import { MAX_REJECTED_SOURCE_BYTES } from '../src/core/views'
import { agent, cleanupViews, spec, sqliteStore, startView, strangerCaller, tempDatabasePath, windowCaller, type ViewHarness } from './support'

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
  test('stores the checked spec for the caller session, in the pane by default, and announces it once', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: bundleSize })
    expect(viewId).toMatch(/^view_[0-9a-f]{12}$/)
    expect(await h.call('get', { viewId }, windowCaller)).toEqual({
      viewId,
      sessionId: 's1',
      title: 'Bundle size by route',
      spec: bundleSize,
      placement: 'pane',
      movedByUser: false,
      updates: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      closed: false,
      done: false,
      version: 1,
      latestVersion: 1,
      refused: null
    })
    expect(h.events).toEqual([{ event: 'changed', data: { sessionId: 's1', viewId, version: 1, kind: 'open', placement: 'pane' } }])
  })

  test('inline placement is still accepted, and an agent that names no placement gets the pane', async () => {
    const h = start()
    const inline = (await h.call('open', { spec: spec(), placement: 'inline' })).viewId
    const none = (await h.call('open', { spec: spec() })).viewId
    expect((await h.call('get', { viewId: inline }, windowCaller)).placement).toBe('inline')
    expect((await h.call('get', { viewId: none }, windowCaller)).placement).toBe('pane')
  })

  test('a spec with every new kind opens', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: visualKinds })
    expect((await h.call('get', { viewId }, windowCaller)).spec).toEqual(visualKinds)
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
    expect(record).toMatchObject({ title: 'Third', spec: spec('Third', 'three'), updates: 2, placement: 'pane', version: 3, latestVersion: 3 })
    expect(record.updatedAt >= record.createdAt).toBe(true)
    expect(await h.call('list', { session: 's1' }, windowCaller)).toHaveLength(1)
    expect(h.events.map((event) => event.event)).toEqual(['changed', 'changed', 'changed'])
  })

  test('only the owning session can update', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('update', { viewId, spec: spec() }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('update', { viewId, spec: spec() }, strangerCaller))).message).toContain('Quirky agent session')
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
    expect(h.events[1]).toEqual({ event: 'changed', data: { sessionId: 's1', viewId, version: 1, kind: 'move', placement: 'inline' } })
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

describe('label and done', () => {
  const labelled = (label: string, title = 'Mock') => ({ title, label, root: { type: 'markdown', props: { text: 'x' } } })

  test('the label of the current version is on the record, in list and get, and an old version reports its own', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: labelled('SDD run') })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ label: 'SDD run' })
    await h.call('update', { viewId, spec: labelled('Mock 2') })
    expect((await h.call('list', { session: 's1' }, windowCaller))[0]).toMatchObject({ label: 'Mock 2', done: false })
    expect(await h.call('get', { viewId, version: 1 }, windowCaller)).toMatchObject({ label: 'SDD run' })
    await h.call('update', { viewId, spec: spec('No label') })
    expect(await h.call('get', { viewId }, windowCaller)).not.toHaveProperty('label')
  })

  test('a spec with a label over 24 characters is refused', async () => {
    const h = start()
    const error = await rejection(h.call('open', { spec: labelled('x'.repeat(25)) }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'label: label must be at most 24 characters' })
  })

  test('done is set and cleared by the agent, persisted, and announced as done', async () => {
    const path = tempDatabasePath()
    const h = start(path)
    const { viewId } = await h.call('open', { spec: spec() })
    expect(await h.call('done', { viewId, done: true })).toEqual({ ok: true })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: true, closed: false })
    expect(h.events[1]).toEqual({ event: 'changed', data: { sessionId: 's1', viewId, version: 1, kind: 'done', placement: 'pane' } })
    h.stop()
    const again = start(path)
    expect(await again.call('get', { viewId }, windowCaller)).toMatchObject({ done: true })
    await again.call('done', { viewId, done: false })
    expect(await again.call('get', { viewId }, windowCaller)).toMatchObject({ done: false })
    expect(again.events.map((event) => event.data.kind)).toEqual(['done'])
  })

  test('setting the value it already has emits nothing', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('done', { viewId, done: false })
    await h.call('done', { viewId, done: true })
    await h.call('done', { viewId, done: true })
    expect(h.events.map((event) => event.data.kind)).toEqual(['open', 'done'])
  })

  test('done needs a boolean', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    for (const done of [undefined, 'yes', 1]) {
      expect((await rejection(h.call('done', { viewId, done }))).code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('an update or a patch makes the view live again and announces update or patch', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('A', 'one') })
    await h.call('done', { viewId, done: true })
    await h.call('update', { viewId, spec: spec('B', 'two') })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: false, version: 2 })
    await h.call('done', { viewId, done: true })
    await h.call('patch', { viewId, ops: [{ op: 'replace', path: '/title', value: 'C' }] })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: false, version: 3 })
    expect(h.events.map((event) => event.data.kind)).toEqual(['open', 'done', 'update', 'done', 'patch'])
  })

  test('a refused update leaves done alone', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('done', { viewId, done: true })
    await rejection(h.call('update', { viewId, spec: { title: 'x', root: { type: 'carousel' } } }))
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: true, version: 1 })
  })

  test('the window can mark done, and only for a session it can read; another session\'s agent cannot', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect(await h.call('done', { viewId, done: true }, windowCaller)).toEqual({ ok: true })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: true })
    expect((await rejection(h.call('done', { viewId, done: false }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('done', { viewId, done: false }, strangerCaller))).message).toContain('Quirky agent session')
    expect((await rejection(h.call('done', { viewId: 'view_missing', done: true }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
    expect((await h.call('get', { viewId }, windowCaller)).done).toBe(true)
  })
})

describe('reopen and closing from the window', () => {
  test('the window closes and reopens a view, and each announces itself', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect(await h.call('close', { viewId }, windowCaller)).toEqual({ ok: true })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: true })
    expect(await h.call('reopen', { viewId }, windowCaller)).toEqual({ ok: true })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: false })
    expect(h.events.map((event) => event.data.kind)).toEqual(['open', 'close', 'reopen'])
    expect(h.events[2].data).toEqual({ sessionId: 's1', viewId, version: 1, kind: 'reopen', placement: 'pane' })
  })

  test('reopening an open view changes nothing and emits nothing', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect(await h.call('reopen', { viewId }, windowCaller)).toEqual({ ok: true })
    expect(h.events).toHaveLength(1)
  })

  test('reopening keeps done', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('done', { viewId, done: true })
    await h.call('close', { viewId })
    await h.call('reopen', { viewId }, windowCaller)
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: false, done: true })
  })

  test('reopen is for the window; an unknown view is not found', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('close', { viewId })
    for (const caller of [agent('s1'), agent('s2'), strangerCaller, { role: 'mobile' } as const]) {
      expect((await rejection(h.call('reopen', { viewId }, caller))).code).toBe(RpcErrorCode.Conflict)
    }
    expect((await rejection(h.call('reopen', { viewId: 'view_missing' }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
    expect((await h.call('get', { viewId }, windowCaller)).closed).toBe(true)
  })

  test('closing from the window ends a pending wait, an unknown view is not found, and a second close is quiet', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const waiting = h.call('wait', { viewId })
    await h.call('close', { viewId }, windowCaller)
    expect(await waiting).toEqual({ status: 'closed' })
    await h.call('close', { viewId }, windowCaller)
    expect(h.events.map((event) => event.data.kind)).toEqual(['open', 'close'])
    expect((await rejection(h.call('close', { viewId: 'view_missing' }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
  })

  test('an update or patch on a closed view reopens it and applies the version', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('A', 'one') })
    await h.call('close', { viewId })
    await h.call('update', { viewId, spec: spec('B', 'two') })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: false, version: 2, title: 'B' })
    await h.call('close', { viewId }, windowCaller)
    await h.call('patch', { viewId, ops: [{ op: 'replace', path: '/title', value: 'C' }] })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: false, version: 3, title: 'C' })
    expect(h.events.map((event) => event.data.kind)).toEqual(['open', 'close', 'update', 'close', 'patch'])
  })

  test('a closed view still takes no move or action', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('close', { viewId })
    expect((await rejection(h.call('move', { viewId, placement: 'inline' }, windowCaller))).code).toBe(RpcErrorCode.Conflict)
    expect((await rejection(h.call('action', { viewId, name: 'go', source: 'button' }, windowCaller))).code).toBe(RpcErrorCode.Conflict)
  })
})

describe('migration 3', () => {
  test('a database from before done reads every view as not done', async () => {
    const path = tempDatabasePath()
    const db = new Database(path)
    sqliteStore(db, [viewsMigration])
    db.query(
      `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)
       VALUES ('view_old', 's1', 'Old', ?, 'pane', 0, 0, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z', 0)`
    ).run(JSON.stringify(spec('Old')))
    db.close()
    const h = start(path)
    expect(await h.call('get', { viewId: 'view_old' }, windowCaller)).toMatchObject({ done: false, closed: false })
    await h.call('done', { viewId: 'view_old', done: true })
    expect(await h.call('get', { viewId: 'view_old' }, windowCaller)).toMatchObject({ done: true })
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
      'quirky.view/done',
      'quirky.view/get',
      'quirky.view/list',
      'quirky.view/move',
      'quirky.view/open',
      'quirky.view/patch',
      'quirky.view/render-failed',
      'quirky.view/reopen',
      'quirky.view/update',
      'quirky.view/wait'
    ])
    expect(api.events.filter((event) => event.plugin === 'quirky.view').map((event) => event.name)).toEqual(['quirky.view/changed', 'quirky.view/rejected'])
    expect(api.cli.commands.filter((command) => command.plugin === 'quirky.view').map((command) => command.words).sort()).toEqual([
      'view',
      'view close',
      'view done',
      'view get',
      'view open',
      'view patch',
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

  test('a window connection passes the move guard through the daemon', async () => {
    const h = await daemon()
    const window = await h.connect('ui')
    // not-found, not conflict: the window got past windowOnly and the lookup ran
    expect((await rejection(window.callAny('quirky.view/move', { viewId: 'view_x', placement: 'pane' }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('versions', () => {
  test('open stores v1, and every update appends a version that get can return', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('update', { viewId, spec: authFlowV2 })
    await h.call('update', { viewId, spec: spec('Third', 'three') })
    const latest = await h.call('get', { viewId }, windowCaller)
    expect(latest).toMatchObject({ version: 3, latestVersion: 3, updates: 2, title: 'Third', spec: spec('Third', 'three') })
    expect(await h.call('get', { viewId, version: 3 }, windowCaller)).toEqual(latest)
    const v1 = await h.call('get', { viewId, version: 1 }, windowCaller)
    expect(v1).toMatchObject({ version: 1, latestVersion: 3, updates: 2, title: 'Auth flow', spec: authFlowV1 })
    expect(v1.updatedAt <= latest.updatedAt).toBe(true)
    expect(await h.call('get', { viewId, version: 2 }, windowCaller)).toMatchObject({ version: 2, spec: authFlowV2 })
  })

  test('an old version keeps the time it was made', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('A') })
    const opened = await h.call('get', { viewId }, windowCaller)
    await Bun.sleep(5)
    await h.call('update', { viewId, spec: spec('B') })
    expect((await h.call('get', { viewId, version: 1 }, windowCaller)).updatedAt).toBe(opened.updatedAt)
    expect((await h.call('get', { viewId }, windowCaller)).updatedAt > opened.updatedAt).toBe(true)
  })

  test('an unknown or malformed version is not found or invalid', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('get', { viewId, version: 2 }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('get', { viewId, version: 0 }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await rejection(h.call('get', { viewId, version: 1.5 }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await rejection(h.call('get', { viewId, version: '1' }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('another session cannot read an old version either', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    expect((await rejection(h.call('get', { viewId, version: 1 }, agent('s2')))).code).toBe(RpcErrorCode.Conflict)
    expect((await rejection(h.call('get', { viewId, version: 9 }, agent('s2')))).code).toBe(RpcErrorCode.Conflict)
    expect((await h.call('get', { viewId, version: 1 }, agent('s1'))).version).toBe(1)
  })

  test('the changed event carries the version and what happened', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await h.call('update', { viewId, spec: spec('Two') })
    await h.call('close', { viewId })
    expect(h.events.map((event) => [event.event, event.data.version, event.data.kind])).toEqual([
      ['changed', 1, 'open'],
      ['changed', 2, 'update'],
      ['changed', 2, 'close']
    ])
  })

  test('list returns the latest version of each view with the version fields', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('One') })
    await h.call('update', { viewId, spec: spec('Two') })
    expect(await h.call('list', { session: 's1' }, windowCaller)).toEqual([expect.objectContaining({ viewId, title: 'Two', version: 2, latestVersion: 2, updates: 1, refused: null })])
  })

  test('a refused spec is never a version', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Good') })
    await rejection(h.call('update', { viewId, spec: { title: 'Bad', root: { type: 'nope' } } }))
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ version: 1, latestVersion: 1, title: 'Good' })
    expect((await rejection(h.call('get', { viewId, version: 2 }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('refused state', () => {
  const invalid = { title: 'Broken view', root: { type: 'tabel', props: {} } }

  test('a refused update keeps the latest version and records what was refused', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Good') })
    await rejection(h.call('update', { viewId, spec: invalid }))
    const record = await h.call('get', { viewId }, windowCaller)
    expect(record).toMatchObject({ title: 'Good', version: 1, latestVersion: 1, updates: 0 })
    expect(record.refused).toEqual({
      attempt: 'update',
      version: null,
      errors: ["root.type: unknown type 'tabel'; did you mean table?"],
      source: JSON.stringify(invalid, null, 2),
      at: expect.any(Number)
    })
    expect(h.events.map((event) => [event.event, event.data.kind])).toEqual([['changed', 'open'], ['changed', 'refused'], ['rejected', undefined]])
    expect(h.events[1].data).toEqual({ sessionId: 's1', viewId, version: 1, kind: 'refused', placement: 'pane' })
  })

  test('the next good version clears it, from update and from patch', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await rejection(h.call('update', { viewId, spec: invalid }))
    await h.call('update', { viewId, spec: authFlowV2 })
    expect((await h.call('get', { viewId }, windowCaller)).refused).toBeNull()
    await rejection(h.call('update', { viewId, spec: invalid }))
    await h.call('patch', { viewId, ops: [{ op: 'replace', path: '/title', value: 'Auth flow 3' }] })
    expect((await h.call('get', { viewId }, windowCaller)).refused).toBeNull()
  })

  test('the source of a refusal is capped at 64 KiB', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const big = { title: 'Big', root: { type: 'stack', children: [{ type: 'code', props: { text: 'x'.repeat(100_000) } }, { type: 'nope' }] } }
    await rejection(h.call('update', { viewId, spec: big }))
    expect(Buffer.byteLength((await h.call('get', { viewId }, windowCaller)).refused.source)).toBe(MAX_REJECTED_SOURCE_BYTES)
  })

  test('a refused open has no view, so it only emits rejected', async () => {
    const h = start()
    await rejection(h.call('open', { spec: invalid }))
    expect(h.events.map((event) => event.event)).toEqual(['rejected'])
    expect(await h.call('list', { session: 's1' }, windowCaller)).toEqual([])
  })

  test('a refused update of a view the caller does not own changes nothing', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await rejection(h.call('update', { viewId, spec: invalid }, agent('s2')))
    expect((await h.call('get', { viewId }, windowCaller)).refused).toBeNull()
  })

  test('daemon checks refuse new kinds on the same call', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const remote = { title: 'Remote', root: { type: 'html', props: { html: '<img src="https://x.test/a.png">', interactive: false } } }
    const error = await rejection(h.call('update', { viewId, spec: remote }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'root.props.html: remote content is not allowed in html; inline it as data:' })
  })
})

describe('patch', () => {
  const ops = [
    { op: 'replace', path: '/root/children/0/props/source', value: authFlowV2.root.children[0].props!.source },
    { op: 'add', path: '/root/children/1/props/rows/-', value: ['Refresh', 'expiry under 5 min', 'lease.ts'] }
  ]

  test('applies the ops to the latest spec as a new version and returns it', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    expect(await h.call('patch', { viewId, ops })).toEqual({ viewId, version: 2 })
    expect((await h.call('get', { viewId }, windowCaller)).spec).toEqual(authFlowV2)
    expect((await h.call('get', { viewId, version: 1 }, windowCaller)).spec).toEqual(authFlowV1)
    expect(h.events.at(-1)).toEqual({ event: 'changed', data: { sessionId: 's1', viewId, version: 2, kind: 'patch', placement: 'pane' } })
  })

  test('ops may be given as JSON text', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    expect(await h.call('patch', { viewId, ops: JSON.stringify(ops) })).toEqual({ viewId, version: 2 })
  })

  test('add inserts at an index, replace and remove address arrays and objects, ~ escapes work', async () => {
    const h = start()
    const base = {
      title: 'Escapes',
      root: {
        type: 'stack',
        children: [
          { type: 'markdown', props: { text: 'a' } },
          { type: 'markdown', props: { text: 'c' } }
        ]
      }
    }
    const { viewId } = await h.call('open', { spec: base })
    await h.call('patch', { viewId, ops: [{ op: 'add', path: '/root/children/1', value: { type: 'markdown', props: { text: 'b' } } }] })
    await h.call('patch', { viewId, ops: [{ op: 'remove', path: '/root/children/0' }, { op: 'replace', path: '/title', value: 'Done' }] })
    const record = await h.call('get', { viewId }, windowCaller)
    expect(record.title).toBe('Done')
    expect(record.spec.root.children.map((child: { props: { text: string } }) => child.props.text)).toEqual(['b', 'c'])
    expect(record).toMatchObject({ version: 3, updates: 2 })
  })

  test('a node id can be added with a pointer', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('T', 'x') })
    await h.call('patch', { viewId, ops: [{ op: 'add', path: '/root/id', value: 'intro' }] })
    expect((await h.call('get', { viewId }, windowCaller)).spec.root.id).toBe('intro')
  })

  test.each([
    ['a missing target', [{ op: 'replace', path: '/root/children/9/props', value: {} }], 'ops[0].path: /root/children/9/props does not exist'],
    ['a missing parent', [{ op: 'add', path: '/root/nope/deeper', value: 1 }], 'ops[0].path: /root/nope/deeper does not exist'],
    ['a pointer with no leading slash', [{ op: 'replace', path: 'title', value: 'x' }], "ops[0].path: 'title' is not a JSON Pointer"],
    ['an unknown op', [{ op: 'move', path: '/title' }], "ops[0].op: must be one of add | replace | remove"],
    ['an add with no value', [{ op: 'add', path: '/root/id' }], 'ops[0].value: is required for add'],
    ['an index past the end', [{ op: 'add', path: '/root/children/5', value: { type: 'stack' } }], 'ops[0].path: index 5 is out of range'],
    ['a remove of the whole spec', [{ op: 'remove', path: '' }], 'ops[0].path: the whole spec cannot be removed'],
    ['a result that is not a valid spec', [{ op: 'replace', path: '/root/type', value: 'carousel' }], "root.type: unknown type 'carousel'; the catalog has stack, columns"]
  ])('%s is refused with path: message, and nothing is stored', async (_name, badOps, message) => {
    const h = start()
    const start1 = { title: 'Start', root: { type: 'stack', children: [{ type: 'markdown', props: { text: 'x' } }] } }
    const { viewId } = await h.call('open', { spec: start1 })
    const error = await rejection(h.call('patch', { viewId, ops: badOps }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toStartWith(message)
    const record = await h.call('get', { viewId }, windowCaller)
    expect(record).toMatchObject({ version: 1, spec: start1 })
    expect(record.refused).toMatchObject({ attempt: 'patch', version: null, errors: [expect.stringContaining(message.split(':')[0])], source: JSON.stringify(badOps, null, 2) })
    expect(h.events.map((event) => event.event)).toEqual(['changed', 'changed', 'rejected'])
    expect(h.events.at(-1)!.data).toMatchObject({ sessionId: 's1', title: 'Start' })
  })

  test('ops apply atomically: one bad op leaves the stored spec as it was', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await rejection(h.call('patch', { viewId, ops: [ops[0], { op: 'remove', path: '/root/children/7' }] }))
    expect((await h.call('get', { viewId }, windowCaller)).spec).toEqual(authFlowV1)
  })

  test('at most 200 ops, and ops must be a list', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('T') })
    const many = Array.from({ length: 201 }, () => ({ op: 'replace', path: '/title', value: 'x' }))
    expect((await rejection(h.call('patch', { viewId, ops: many }))).message).toBe('ops: at most 200 ops allowed')
    const fine = Array.from({ length: 200 }, (_, i) => ({ op: 'replace', path: '/title', value: `t${i}` }))
    expect(await h.call('patch', { viewId, ops: fine })).toEqual({ viewId, version: 2 })
    expect((await rejection(h.call('patch', { viewId, ops: { op: 'add' } }))).message).toContain('ops: must be an array')
    expect((await rejection(h.call('patch', { viewId, ops: '[oops' }))).message).toContain('ops is not valid JSON')
    expect((await rejection(h.call('patch', { viewId }))).message).toBe('ops is required')
  })

  test('a __proto__ key cannot reach the prototype', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    await rejection(h.call('patch', { viewId, ops: [{ op: 'add', path: '/root/props/__proto__', value: { polluted: true } }] }))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('only the owning session can patch', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec() })
    const op = [{ op: 'replace', path: '/title', value: 'x' }]
    expect((await rejection(h.call('patch', { viewId, ops: op }, agent('s2')))).code).toBe(RpcErrorCode.NotFound)
    expect((await rejection(h.call('patch', { viewId, ops: op }, windowCaller))).message).toContain('Quirky agent session')
  })

  test('patching a view with a refused update applies to the last good version', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: spec('Good') })
    await rejection(h.call('update', { viewId, spec: { title: 'Bad', root: { type: 'nope' } } }))
    await h.call('patch', { viewId, ops: [{ op: 'replace', path: '/title', value: 'Better' }] })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ title: 'Better', version: 2, refused: null })
  })
})

describe('render-failed', () => {
  const text = (viewId: string, version = 1, title = 'Auth flow', error = 'Parse error on line 2') =>
    `Visual "${title}" v${version} didn't render: ${error}. Fix it with quirky view update or patch (view ${viewId}).`

  test('marks the version refused and tells the live session once', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    expect(await h.call('render-failed', { viewId, version: 1, error: 'Parse error on line 2' }, windowCaller)).toEqual({ ok: true })
    expect(h.sends).toEqual([{ session: 's1', text: text(viewId), when: 'idle' }])
    const record = await h.call('get', { viewId }, windowCaller)
    expect(record.refused).toEqual({
      attempt: 'render',
      version: 1,
      errors: ['Parse error on line 2'],
      source: JSON.stringify(authFlowV1, null, 2),
      at: expect.any(Number)
    })
    expect(h.events.at(-1)).toEqual({ event: 'changed', data: { sessionId: 's1', viewId, version: 1, kind: 'render-failed', placement: 'pane' } })
  })

  test('a second report for the same view and version is a no-op', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)
    const events = h.events.length
    expect(await h.call('render-failed', { viewId, version: 1, error: 'boom again' }, windowCaller)).toEqual({ duplicate: true })
    expect(h.sends).toHaveLength(1)
    expect(h.events).toHaveLength(events)
  })

  test('a duplicate is still recognised after the refused state was replaced by a refused update', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)
    await rejection(h.call('update', { viewId, spec: { title: 'x', root: { type: 'nope' } } }))
    expect(await h.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)).toEqual({ duplicate: true })
    expect(h.sends).toHaveLength(1)
  })

  test('a duplicate is still recognised after a refused update and a restart', async () => {
    const path = tempDatabasePath()
    const before = start(path)
    const { viewId } = await before.call('open', { spec: authFlowV1 })
    await before.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)
    await rejection(before.call('update', { viewId, spec: { title: 'x', root: { type: 'nope' } } }))
    expect(before.sends).toHaveLength(1)
    before.stop()

    const after = start(path)
    expect(await after.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)).toEqual({ duplicate: true })
    expect(after.sends).toHaveLength(0)
    await after.call('update', { viewId, spec: authFlowV2 })
    expect(await after.call('render-failed', { viewId, version: 2, error: 'boom' }, windowCaller)).toEqual({ ok: true })
    expect(after.sends).toHaveLength(1)
  })

  test('a failure for a version that is not the latest is ignored', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('update', { viewId, spec: authFlowV2 })
    expect(await h.call('render-failed', { viewId, version: 1, error: 'old' }, windowCaller)).toEqual({ ignored: true })
    expect(await h.call('render-failed', { viewId, version: 7, error: 'future' }, windowCaller)).toEqual({ ignored: true })
    expect(h.sends).toEqual([])
    expect((await h.call('get', { viewId }, windowCaller)).refused).toBeNull()
    expect(await h.call('render-failed', { viewId, version: 2, error: 'new' }, windowCaller)).toEqual({ ok: true })
    expect(h.sends).toEqual([{ session: 's1', text: text(viewId, 2, 'Auth flow', 'new'), when: 'idle' }])
  })

  test('each version reports once, so a fixed version that fails again is reported again', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('render-failed', { viewId, version: 1, error: 'one' }, windowCaller)
    await h.call('update', { viewId, spec: authFlowV2 })
    await h.call('render-failed', { viewId, version: 2, error: 'two' }, windowCaller)
    expect(h.sends.map((send) => send.text)).toEqual([text(viewId, 1, 'Auth flow', 'one'), text(viewId, 2, 'Auth flow', 'two')])
  })

  test('a session that cannot take the message does not fail the report', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    h.sendResult.value = () => {
      throw new Error('session is stopped')
    }
    expect(await h.call('render-failed', { viewId, version: 1, error: 'boom' }, windowCaller)).toEqual({ ok: true })
    expect((await h.call('get', { viewId }, windowCaller)).refused).toMatchObject({ attempt: 'render', version: 1 })
  })

  test('the window reports and nobody else does', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    for (const caller of [agent('s1'), strangerCaller, { role: 'plugin', pluginId: 'quirky.structured' } as const, { role: 'mobile' } as const]) {
      expect((await rejection(h.call('render-failed', { viewId, version: 1, error: 'x' }, caller))).code).toBe(RpcErrorCode.Conflict)
    }
    expect(h.sends).toEqual([])
  })

  test('checks its input and the view', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    const bad: Record<string, unknown>[] = [{ version: 0, error: 'x' }, { version: 'one', error: 'x' }, { version: 1.5, error: 'x' }, { version: 1, error: '' }, { version: 1 }]
    for (const params of bad) expect((await rejection(h.call('render-failed', { viewId, ...params }, windowCaller))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await rejection(h.call('render-failed', { viewId: 'view_missing', version: 1, error: 'x' }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
  })

  test('a closed view is ignored', async () => {
    const h = start()
    const { viewId } = await h.call('open', { spec: authFlowV1 })
    await h.call('close', { viewId })
    expect(await h.call('render-failed', { viewId, version: 1, error: 'x' }, windowCaller)).toEqual({ ignored: true })
    expect(h.sends).toEqual([])
  })
})

describe('migration 2', () => {
  function legacyDatabase(path: string): void {
    const db = new Database(path)
    sqliteStore(db, [viewsMigration])
    db.query(
      `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('view_old', 's1', 'Auth flow', JSON.stringify(authFlowV1), 'inline', 1, 2, '2026-11-01T10:00:00.000Z', '2026-11-02T11:30:00.000Z', 0)
    db.query(
      `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('view_new', 's1', 'Bundle size by route', JSON.stringify(bundleSize), 'pane', 0, 0, '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z', 1)
    db.close()
  }

  test('a database that ran only migration 1 gets every view a v1 and keeps what it had', async () => {
    const path = tempDatabasePath()
    legacyDatabase(path)
    const h = start(path)
    const [old, fresh] = await h.call('list', { session: 's1' }, windowCaller)
    expect(old).toMatchObject({ viewId: 'view_old', spec: authFlowV1, placement: 'inline', movedByUser: true, version: 1, latestVersion: 1, updates: 0, refused: null, closed: false })
    expect(fresh).toMatchObject({ viewId: 'view_new', closed: true, version: 1, latestVersion: 1 })
    expect(await h.call('get', { viewId: 'view_old', version: 1 }, windowCaller)).toMatchObject({ version: 1, spec: authFlowV1, updatedAt: '2026-11-02T11:30:00.000Z' })
    expect((await rejection(h.call('get', { viewId: 'view_old', version: 2 }, windowCaller))).code).toBe(RpcErrorCode.NotFound)
  })

  test('the backfilled v1 keeps the milliseconds of updated_at', async () => {
    const path = tempDatabasePath()
    const db = new Database(path)
    sqliteStore(db, [viewsMigration])
    db.query(
      `INSERT INTO views (view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('view_ms', 's1', 'Auth flow', JSON.stringify(authFlowV1), 'inline', 0, 0, '2026-11-01T10:00:00.000Z', '2026-11-02T11:30:00.123Z', 0)
    db.close()
    const h = start(path)
    await h.call('update', { viewId: 'view_ms', spec: authFlowV2 })
    expect(await h.call('get', { viewId: 'view_ms', version: 1 }, windowCaller)).toMatchObject({ version: 1, updatedAt: '2026-11-02T11:30:00.123Z' })
  })

  test('an old view carries on from its v1, and the original table is untouched', async () => {
    const path = tempDatabasePath()
    legacyDatabase(path)
    const h = start(path)
    await h.call('update', { viewId: 'view_old', spec: authFlowV2 })
    expect(await h.call('get', { viewId: 'view_old', version: 1 }, windowCaller)).toMatchObject({ spec: authFlowV1 })
    expect(await h.call('get', { viewId: 'view_old' }, windowCaller)).toMatchObject({ version: 2, spec: authFlowV2 })
    h.stop()
    const db = new Database(path)
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    expect(db.query('SELECT count(*) AS n FROM view_versions').get()).toEqual({ n: 3 })
    expect(db.query('SELECT updates FROM views WHERE view_id = ?').get('view_old')).toEqual({ updates: 1 })
    db.close()
  })
})

describe('persistence of versions', () => {
  test('versions, the refused state and render failures survive a restart', async () => {
    const path = tempDatabasePath()
    const before = start(path)
    const { viewId } = await before.call('open', { spec: authFlowV1 })
    await before.call('update', { viewId, spec: authFlowV2 })
    await before.call('render-failed', { viewId, version: 2, error: 'boom' }, windowCaller)
    const latest = await before.call('get', { viewId }, windowCaller)
    before.stop()

    const after = start(path)
    expect(await after.call('get', { viewId }, windowCaller)).toEqual(latest)
    expect(await after.call('get', { viewId, version: 1 }, windowCaller)).toMatchObject({ spec: authFlowV1, version: 1, latestVersion: 2 })
    expect(await after.call('render-failed', { viewId, version: 2, error: 'boom' }, windowCaller)).toEqual({ duplicate: true })
    await after.call('patch', { viewId, ops: [{ op: 'replace', path: '/title', value: 'Auth flow 3' }] })
    expect(await after.call('get', { viewId }, windowCaller)).toMatchObject({ version: 3, refused: null })
    expect(await after.call('get', { viewId, version: 2 }, windowCaller)).toMatchObject({ spec: authFlowV2 })
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activate, announceChanges, deactivate } from '../main'
import type { AvatarBusEvent } from '../src/contracts'
import { createAvatarStore } from '../src/store'
import { makeTestApp, sampleMandate } from './support'

describe('avatar app stubs', () => {
  test('every stub method resolves to an unavailable or empty result and never throws', async () => {
    const { app } = makeTestApp()
    const { gate, handoff, brain, supervisor, shipping, report } = app.services
    const call = { agent: 'claude' as const, sessionId: 's', worktreeId: 'w', cwd: '/', toolName: 'Bash', toolInput: {}, event: 'PreToolUse' as const }

    expect(await gate.decideCall(call, 1000, new AbortController().signal)).toMatchObject({ outcome: 'retry' })
    expect(await gate.gateCheck('w')).toMatchObject({ ok: false })
    expect(gate.hasReceipt('s', 'f', 0, 1)).toBe(false)
    expect(() => {
      gate.writeMarker('s', 'w', 'full')
      gate.removeMarker('s')
      gate.approveOnce('n')
      gate.resolveInFlight('w', 'passthrough')
      gate.noteObservedCall('s', 'f', 0)
    }).not.toThrow()

    expect(await handoff.eligibility()).toEqual([])
    expect(await handoff.resolveNeed('n', 'deny')).toMatchObject({ ok: false })
    expect(await handoff.takeBack({ all: true })).toEqual([])
    expect(await handoff.takeBack({ worktreeIds: ['w'] })).toEqual([{ worktreeId: 'w', ok: false, handedBackWith: [] }])
    expect(handoff.mandate('w')).toBeNull()
    expect(handoff.active()).toEqual([])
    expect(() => handoff.setState('w', 'working', 'n')).not.toThrow()
    const { worktreeId: _worktreeId, updatedAt: _updatedAt, sharedGoalId: _sharedGoalId, ...rest } = sampleMandate()
    expect(await handoff.handoff([{ ...rest, worktreeId: 'w' }])).toEqual([{ worktreeId: 'w', ok: false, error: 'unavailable' }])

    expect(brain.ready()).toBe(false)
    expect(await brain.judge(call, sampleMandate(), 1000)).toBe('unavailable')
    expect(() => brain.wake()).not.toThrow()

    expect(await supervisor.send('w', 't')).toMatchObject({ sent: false })
    expect(await supervisor.stepIn('w', 't')).toMatchObject({ sent: false })
    expect(await supervisor.startSession('w', 'n')).toMatchObject({ sessionId: null })
    expect(await supervisor.restartWorker('w', 'n')).toMatchObject({ sessionId: null })
    expect(() => {
      supervisor.park('w', 's')
      supervisor.recordDenial('w', true)
    }).not.toThrow()

    expect(await shipping.runDoneWhen('w')).toMatchObject({ pass: false })
    expect(await shipping.startReview('w')).toMatchObject({ started: false })
    await expect(shipping.judgeFinding('w', 'f', true, 'r')).resolves.toBeUndefined()
    expect(await shipping.openPr('w')).toMatchObject({ ok: false })
    expect(await shipping.merge('w')).toMatchObject({ ok: false })
    expect(await shipping.mergeMainIn('w')).toMatchObject({ ok: false })
    await expect(shipping.reconcileOutbox()).resolves.toBeUndefined()
    expect(shipping.cancelOutbox('w')).toBe(0)

    expect(report.report()).toMatchObject({ needsYou: [], stories: [], topSkippedCalls: [] })
    expect(report.status()).toEqual({ handoffs: [], needsYouCount: 0 })
    expect(report.sidebarStatus()).toEqual({})
  })
})

describe('avatar app bus, journal and needs', () => {
  test('the journal appends a row and emits it on the bus', () => {
    const { app } = makeTestApp()
    const seen: AvatarBusEvent[] = []
    app.on((event) => void seen.push(event))
    app.now = () => 42
    const entry = app.journal('w', 'handoff', { goal: 'x' })
    expect(entry).toMatchObject({ at: 42, worktreeId: 'w', kind: 'handoff', data: { goal: 'x' } })
    expect(seen).toEqual([{ type: 'journal', entry }])
    expect(app.store.journalSince(0)).toEqual([entry])
  })

  test('needs add, list and close, each change emitting needs-changed', () => {
    const { app } = makeTestApp()
    const seen: AvatarBusEvent[] = []
    app.on((event) => void seen.push(event))
    app.now = () => 10
    const held = app.needs.add({ worktreeId: 'a', kind: 'held-call', title: 'Held', detail: {}, actions: ['allow-once', 'deny'] })
    const question = app.needs.add({ worktreeId: 'b', kind: 'question', title: 'Q', detail: {}, actions: ['answer'] })
    expect(held).toMatchObject({ createdAt: 10, resolvedAt: null, resolution: null })
    expect(held.id).not.toBe(question.id)
    expect(app.needs.list().map((item) => item.id)).toEqual([held.id, question.id])
    expect(app.needs.list({ worktreeId: 'b' }).map((item) => item.id)).toEqual([question.id])

    app.now = () => 20
    app.needs.close(held.id, 'denied')
    expect(app.needs.list({ open: true }).map((item) => item.id)).toEqual([question.id])
    expect(app.needs.list({ open: false })).toEqual([{ ...held, resolvedAt: 20, resolution: 'denied' }])
    expect(seen.filter((event) => event.type === 'needs-changed')).toHaveLength(3)

    app.needs.close(held.id, 'again')
    expect(app.needs.list({ open: false })[0]?.resolution).toBe('denied')
    expect(seen.filter((event) => event.type === 'needs-changed')).toHaveLength(3)
  })

  test('an unsubscribed listener hears nothing and a throwing listener does not stop the others', () => {
    const { app } = makeTestApp()
    const heard: string[] = []
    const off = app.on(() => void heard.push('first'))
    app.on(() => {
      throw new Error('listener failed')
    })
    app.on(() => void heard.push('third'))
    app.emit({ type: 'handoffs-changed' })
    expect(heard).toEqual(['first', 'third'])
    off()
    app.emit({ type: 'handoffs-changed' })
    expect(heard).toEqual(['first', 'third', 'third'])
  })
})

describe('avatar settings', () => {
  test('defaults apply when nothing is stored', () => {
    expect(makeTestApp().app.settings()).toEqual({
      defaultLevel: 'full',
      switches: { messaging: false, historyRewrite: false, deploys: false },
      houseRules: [],
      allowCommands: [],
      denyCommands: [],
      deployCommands: [],
      brainAgent: 'claude',
      brainModel: null,
      judgmentTimeoutSeconds: 55
    })
  })

  test('stored values are read by their declared setting names', () => {
    const { app } = makeTestApp({
      settings: {
        'default-level': 'shadow',
        'switch-messaging': true,
        'switch-history-rewrite': true,
        'house-rules': 'be kind\n\n  ship small  ',
        'allow-commands': 'bun test',
        'deny-commands': 'rm -rf',
        'deploy-commands': 'make deploy',
        'brain-agent': 'codex',
        'brain-model': ' gpt-x ',
        'judgment-timeout-seconds': 30
      }
    })
    expect(app.settings()).toEqual({
      defaultLevel: 'shadow',
      switches: { messaging: true, historyRewrite: true, deploys: false },
      houseRules: ['be kind', 'ship small'],
      allowCommands: ['bun test'],
      denyCommands: ['rm -rf'],
      deployCommands: ['make deploy'],
      brainAgent: 'codex',
      brainModel: 'gpt-x',
      judgmentTimeoutSeconds: 30
    })
  })

  test('an invalid stored value falls back to the default', () => {
    const { app } = makeTestApp({ settings: { 'default-level': 'reckless', 'brain-agent': 'nope', 'judgment-timeout-seconds': -1 } })
    expect(app.settings()).toMatchObject({ defaultLevel: 'full', brainAgent: 'claude', judgmentTimeoutSeconds: 55 })
  })
})

describe('avatar main wiring', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'quirky-plugin.json'), 'utf8')) as { contributes: { method: { id: string }[] } }

  test('activate provides every manifest method and nothing the manifest lacks', async () => {
    const test = makeTestApp()
    await activate(test.context)
    const provided = [...test.provided.keys()].filter((id) => id.startsWith('method:')).sort()
    expect(provided).toEqual(manifest.contributes.method.map((method) => `method:quirky.avatar/${method.id}`).sort())
    await deactivate()
  })

  test('methods delegate to the services', async () => {
    const test = makeTestApp()
    await activate(test.context)
    const call = (name: string, params: Record<string, unknown> = {}) => (test.provided.get(`method:quirky.avatar/${name}`) as (params: Record<string, unknown>) => unknown)(params)

    expect(await call('status')).toEqual({ handoffs: [], needsYouCount: 0 })
    expect(await call('takeBack', { all: true })).toEqual({ results: [] })
    expect(await call('mandate', { worktreeId: 'w' })).toBeNull()
    expect(await call('resolveNeed', { needId: 'n', action: 'deny' })).toMatchObject({ ok: false })
    expect(await call('handoff', { items: [{ worktreeId: 'w' }] })).toEqual({ results: [{ worktreeId: 'w', ok: false, error: 'unavailable' }] })
    expect(await call('settings')).toMatchObject({ defaultLevel: 'full' })

    expect(test.emitted).toEqual([])
    await deactivate()
  })

  test('bad params are rejected as invalid-params', async () => {
    const test = makeTestApp()
    await activate(test.context)
    const call = (name: string, params: Record<string, unknown>) => (test.provided.get(`method:quirky.avatar/${name}`) as (params: Record<string, unknown>) => unknown)(params)
    const rejection = async (run: () => unknown) => {
      try {
        await run()
      } catch (error) {
        return (error as { kind?: string }).kind
      }
      return null
    }

    expect(await rejection(() => call('handoff', {}))).toBe('invalid-params')
    expect(await rejection(() => call('takeBack', { worktreeIds: 'w' }))).toBe('invalid-params')
    expect(await rejection(() => call('mandate', {}))).toBe('invalid-params')
    expect(await rejection(() => call('resolveNeed', { needId: 'n', action: 'explode' }))).toBe('invalid-params')
    expect(await rejection(() => call('log', { limit: -1 }))).toBe('invalid-params')
    expect(await rejection(() => call('setSettings', { defaultLevel: 'reckless' }))).toBe('invalid-params')
    expect(await rejection(() => call('setSettings', { surprise: true }))).toBe('invalid-params')
    expect(test.calls).toEqual([])
    await deactivate()
  })

  test('setSettings writes each changed setting through setting.set', async () => {
    const test = makeTestApp({ fakeCalls: { 'setting.set': () => ({}) } })
    await activate(test.context)
    const setSettings = test.provided.get('method:quirky.avatar/setSettings') as (params: Record<string, unknown>) => Promise<unknown>
    await setSettings({ defaultLevel: 'local', switches: { deploys: true }, houseRules: ['a', 'b'], brainModel: null })
    expect(test.calls).toEqual([
      { method: 'setting.set', params: { id: 'setting:quirky.avatar/default-level', value: 'local' } },
      { method: 'setting.set', params: { id: 'setting:quirky.avatar/switch-deploys', value: true } },
      { method: 'setting.set', params: { id: 'setting:quirky.avatar/house-rules', value: 'a\nb' } },
      { method: 'setting.set', params: { id: 'setting:quirky.avatar/brain-model', value: '' } }
    ])
    await deactivate()
  })

  test('bus events announce `changed`', () => {
    const test = makeTestApp()
    const stop = announceChanges(test.context, test.app)
    test.app.journal('a', 'gate', {})
    test.app.needs.add({ worktreeId: 'a', kind: 'question', title: 'Q', detail: {}, actions: ['answer'] })
    expect(test.emitted).toEqual([
      { event: 'changed', data: { type: 'journal' } },
      { event: 'changed', data: { type: 'needs-changed' } }
    ])
    stop()
    test.app.emit({ type: 'handoffs-changed' })
    expect(test.emitted).toHaveLength(2)
  })

  test('the log method pages the journal the plugin opened', async () => {
    const test = makeTestApp()
    await activate(test.context)
    const store = createAvatarStore(test.openedStores[0]!)
    const first = store.appendJournal({ at: 1, worktreeId: 'a', kind: 'gate', data: {} })
    const second = store.appendJournal({ at: 2, worktreeId: 'b', kind: 'gate', data: {} })
    const log = test.provided.get('method:quirky.avatar/log') as (params: Record<string, unknown>) => unknown
    expect(log({ worktreeId: 'a' })).toEqual([first])
    expect(log({ limit: 1 })).toEqual([second])
    await deactivate()
  })

  test('the gate placeholder answers unavailable, which is never an approval', async () => {
    const test = makeTestApp()
    await activate(test.context)
    const gate = test.provided.get('tool-gate:quirky.avatar/gate') as () => Promise<unknown>
    expect(await gate()).toMatchObject({ decision: 'unavailable', encoded: null })
    await deactivate()
  })
})

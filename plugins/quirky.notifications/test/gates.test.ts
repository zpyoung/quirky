import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { Rig } from './support'

let rig: Rig
afterEach(() => rig?.cleanup())

const send = (params: Record<string, unknown>) => rig.client.callAny('quirky.notifications/send', params)
const askFrom = (session: string, worktree: string, text = 'Ship to prod?') =>
  rig.client.callAny('quirky.ask/create', {
    spec: { title: 'Deploy?', questions: [{ id: 'go', question: text, type: 'confirm' }] },
    session,
    worktree
  })

describe('delivery gates', () => {
  test('SC-11: the gates run in order and the result names the first that fails', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    const params = { session: s.id, title: 'T', body: 'x' }

    await rig.setting('enabled', false)
    expect(await send(params)).toEqual({ delivered: false, reason: 'disabled' })
    await rig.setting('enabled', true)

    await rig.setting('terminalNotifications', false)
    expect(await send(params)).toEqual({ delivered: false, reason: 'source-disabled' })
    await rig.setting('terminalNotifications', true)

    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])
    expect(await send(params)).toEqual({ delivered: false, reason: 'suppressed-focus' })
    await rig.win.close()

    expect(await send(params)).toEqual({ delivered: true, reason: 'delivered' })
    expect(await send(params)).toEqual({ delivered: false, reason: 'cooldown' })
    expect(rig.notifies()).toHaveLength(1)
  })

  test('SC-12: the cooldown is per worktree and shared by every source', async () => {
    rig = await Rig.start({ cooldownMs: 1500 })
    await rig.setting('terminalBell', true)
    const s1 = await rig.session('b', 'shell')
    const s2 = await rig.session('b', 'claude')
    const s3 = await rig.session('c', 'claude')

    rig.bell(s1.id)
    await Bun.sleep(600)
    await rig.claudeTurn(s2.id, 'one')
    await rig.claudeTurn(s3.id, 'two')
    await rig.waitDecided(3)
    await Bun.sleep(1300)
    await rig.claudeTurn(s2.id, 'three')
    await rig.waitDecided(4)

    const results = rig.decisions().map((d) => `${d.source}:${d.sessionId === s1.id ? 's1' : d.sessionId === s2.id ? 's2' : 's3'}:${d.result}`)
    expect(results.sort()).toEqual(['agent:s2:cooldown', 'agent:s2:delivered', 'agent:s3:delivered', 'bell:s1:delivered'])
    expect(rig.notifies()).toHaveLength(3)
    for (const session of [s1, s2, s3]) expect((await rig.getSession(session.id)).unread).toBeTruthy()
  })

  test('SC-13: the test notification skips the cooldown and the toast', async () => {
    rig = await Rig.start()
    const call = () => rig.client.callAny('quirky.notifications/test', {})
    expect(await call()).toEqual({ delivered: true, reason: 'delivered' })
    expect(await call()).toEqual({ delivered: true, reason: 'delivered' })
    const sent = rig.notifies()
    expect(sent).toHaveLength(2)
    for (const event of sent) {
      expect(event).toMatchObject({ title: 'Quirky notifications are on', body: 'This is a test notification from Quirky.', toast: false })
      expect(event.sessionId).toBeUndefined()
    }
  })

  test('the test notification honours Enable Notifications and marks nothing', async () => {
    rig = await Rig.start()
    await rig.setting('enabled', false)
    expect(await rig.client.callAny('quirky.notifications/test', {})).toEqual({ delivered: false, reason: 'disabled' })
    expect(rig.notifies()).toEqual([])
    expect((await rig.status()).badge).toBe(0)
  })

  test('SC-14: with Suppress While Focused off, the open worktree still gets a banner', async () => {
    rig = await Rig.start()
    await rig.setting('suppressWhenFocused', false)
    const b = await rig.worktree('b')
    const s1 = await rig.session('b', 'claude')
    const s2 = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s1.id])

    await rig.claudeTurn(s2.id, 'done')
    await rig.waitDecided(1)

    expect(rig.decisions()[0]).toMatchObject({ result: 'delivered' })
    expect(rig.notifies()).toHaveLength(1)
  })

  test('SC-15: work done while Agent Task Complete was off is never reported later', async () => {
    rig = await Rig.start()
    await rig.setting('agentTaskComplete', false)
    const s = await rig.session('b', 'claude')

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)
    await rig.setting('agentTaskComplete', true)
    await rig.settle(400)

    expect(rig.notifies()).toEqual([])
    expect((await rig.getSession(s.id)).unread).toBe('agent')
    expect(rig.decisions()).toMatchObject([{ result: 'source-disabled' }])
  })

  test('SC-16: a session boundary raises nothing', async () => {
    rig = await Rig.start()
    const s = await rig.session('b', 'claude')

    await rig.hook('claude', s.id, { hook_event_name: 'SessionStart', source: 'startup' })
    await rig.settle(300)

    expect(rig.decisions()).toEqual([])
    expect(rig.notifies()).toEqual([])
    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
  })

  test('SC-17: a still-working agent is never announced as finished', async () => {
    rig = await Rig.start()
    const s = await rig.session('b', 'claude')
    await rig.hook('claude', s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await rig.hook('claude', s.id, { hook_event_name: 'SubagentStart', agent_id: 'a1' })

    await rig.hook('claude', s.id, { hook_event_name: 'Stop', last_assistant_message: 'started it' })
    await rig.settle(300)
    expect(rig.decisions()).toEqual([])
    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()

    await rig.hook('claude', s.id, { hook_event_name: 'SubagentStop', agent_id: 'a1' })
    await rig.waitDecided(1)
    expect(rig.notifies()).toMatchObject([{ title: 'quirky / b - Claude finished', body: 'started it' }])
    expect((await rig.getSession(s.id)).unread).toBe('agent')
  })

  test('SC-18: every source goes through the same gates', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const shown = await rig.session('b')
    const claude = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [shown.id])

    await rig.claudeTurn(claude.id, 'done')
    await askFrom(claude.id, b.id)
    rig.oscNotify(claude.id, 'Build', 'done')
    await rig.waitDecided(3)

    expect(rig.decisions().map((d) => `${d.source}:${d.result}`).sort()).toEqual([
      'agent:suppressed-focus',
      'ask:suppressed-focus',
      'program:suppressed-focus'
    ])
    expect(rig.notifies()).toEqual([])
  })
})

describe('bells', () => {
  test('SC-26: a bell marks unread whatever Terminal Bell says', async () => {
    rig = await Rig.start()
    const s = await rig.session('b')

    rig.bell(s.id)
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread).toBe('bell')
    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect(rig.decisions()[0]).toMatchObject({ source: 'bell', result: 'source-disabled' })
    expect(rig.notifies()).toEqual([])
  })

  test('SC-27: a completion within 250 ms replaces the bell\'s banner', async () => {
    rig = await Rig.start()
    await rig.setting('terminalBell', true)
    const s = await rig.session('b', 'claude')
    await rig.hook('claude', s.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })

    rig.bell(s.id)
    await Bun.sleep(60)
    await rig.hook('claude', s.id, { hook_event_name: 'Stop', last_assistant_message: 'done' })
    await rig.waitDecided(2)

    expect(rig.decisions().map((d) => `${d.source}:${d.result}`).sort()).toEqual(['agent:delivered', 'bell:superseded'])
    expect(rig.notifies()).toMatchObject([{ title: 'quirky / b - Claude finished' }])
    expect((await rig.getSession(s.id)).unread).toBe('agent')
  })

  test('SC-28: a bell on screen does nothing', async () => {
    rig = await Rig.start()
    await rig.setting('terminalBell', true)
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])

    rig.bell(s.id)
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
    expect((await rig.getWorktree('b')).unread).toBe(false)
    expect(rig.notifies()).toEqual([])
  })

  test('a bell is held 250 ms before it is decided', async () => {
    rig = await Rig.start()
    await rig.setting('terminalBell', true)
    const s = await rig.session('b')

    const started = Date.now()
    rig.bell(s.id)
    await waitFor(() => rig.attentions().length === 1)
    expect(rig.decisions()).toEqual([])
    await rig.waitDecided(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    expect(rig.decisions()[0]).toMatchObject({ result: 'delivered' })
  })
})

describe('program notifications', () => {
  test('SC-32: the occasion is honoured', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])

    rig.oscNotify(s.id, null, 'Hi', 'unfocused')
    rig.oscNotify(s.id, null, 'Hey', 'invisible')
    await rig.waitDecided(2)
    expect(rig.decisions().map((d) => d.result)).toEqual(['dropped', 'dropped'])
    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
    expect(rig.attentions()).toEqual([])

    await rig.win.blur()
    rig.oscNotify(s.id, null, 'Hi', 'unfocused')
    await rig.waitDecided(3)
    expect(rig.decisions()[2]).toMatchObject({ source: 'program', result: 'delivered' })
    expect((await rig.getSession(s.id)).unread).toBe('notification')
  })

  test('SC-35: Terminal Notifications off still marks', async () => {
    rig = await Rig.start()
    await rig.setting('terminalNotifications', false)
    const s = await rig.session('b')

    rig.oscNotify(s.id, 'Build', 'done')
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread).toBe('notification')
    expect(rig.decisions()[0]).toMatchObject({ result: 'source-disabled' })
    expect(rig.notifies()).toEqual([])
  })

  test('SC-36: a script can send a notification about a worktree, which marks only the worktree', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')

    expect(await send({ worktree: b.id, title: 'Deploy', body: 'staging is up' })).toEqual({ delivered: true, reason: 'delivered' })

    expect(rig.notifies()).toMatchObject([{ title: 'b: Deploy', body: 'staging is up', worktreeId: b.id }])
    expect(rig.notifies()[0]!.sessionId).toBeUndefined()
    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
  })

  test('send names a session or a worktree selector and refuses an empty body', async () => {
    rig = await Rig.start()
    const s = await rig.session('b')
    await expect(send({ body: '  ' })).rejects.toThrow()
    await expect(send({ body: 'x', session: 'nope' })).rejects.toThrow()
    expect(await send({ body: 'hi', worktree: 'name:b' })).toEqual({ delivered: true, reason: 'delivered' })
    expect(rig.notifies()[0]).toMatchObject({ title: 'Notification in b', body: 'hi' })
    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
  })
})

describe('asks', () => {
  test('Q3: registration stays silent, and only the surfaced head contributes to pending attention', async () => {
    rig = await Rig.start()
    const session = await rig.session('b')
    const worktree = rig.worktrees.b!
    const first = (await askFrom(session.id, worktree.id, 'First?')) as { askId: string }
    const second = (await askFrom(session.id, worktree.id, 'Second?')) as { askId: string }

    const pending = await rig.client.callAny('quirky.ask/list', { pendingOnly: true }) as { id: string; queued: boolean }[]
    expect(pending.map((ask) => ask.queued)).toEqual([false, true])
    expect((await rig.status()).pendingAsks).toBe(1)
    expect(rig.notifies()).toEqual([])
    expect(rig.attentions()).toEqual([])
    expect(rig.decisions()).toEqual([])
    expect((await rig.getSession(session.id)).unread ?? null).toBeNull()
    expect((await rig.getWorktree('b')).unread).toBe(false)

    await rig.client.callAny('quirky.ask/cancel', { askId: first.askId })
    await waitForAsync(async () => {
      const asks = await rig.client.callAny('quirky.ask/list', { pendingOnly: true }) as { id: string; queued: boolean }[]
      return asks.length === 1 && asks[0]?.id === second.askId && !asks[0].queued
    })
    expect((await rig.status()).pendingAsks).toBe(1)
    expect(rig.notifies()).toEqual([])
    expect(rig.decisions()).toEqual([])
  })

  test('an ask with notifications disabled is not delivered at registration', async () => {
    rig = await Rig.start()
    await rig.setting('enabled', false)
    const session = await rig.session('b')

    await askFrom(session.id, rig.worktrees.b!.id)

    expect(rig.notifies()).toEqual([])
    expect(rig.decisions()).toEqual([])
  })
})

describe('attention events', () => {
  test('SC-43: the attention event goes out whatever the switches say, for attention sources only', async () => {
    rig = await Rig.start()
    await rig.setting('enabled', false)
    await rig.setting('terminalBell', true)
    const claude = await rig.session('b', 'claude')
    const shell = await rig.session('c')

    await rig.claudeTurn(claude.id, 'done')
    rig.bell(shell.id)
    rig.oscNotify(shell.id, 'Build', 'ok')
    await askFrom(claude.id, rig.worktrees.b!.id)
    await rig.client.callAny('quirky.notifications/test', {})
    await rig.waitDecided(5)

    expect(rig.attentions().map((a) => a.source).sort()).toEqual(['agent', 'bell', 'program'])
    expect(rig.notifies()).toEqual([])
    await waitForAsync(async () => true)
  })
})

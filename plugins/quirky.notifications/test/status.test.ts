import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { CliArgs, QuirkyClient } from '@quirky/protocol'
import { Store } from '../../../packages/daemon/src/store'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { testCliContext } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { badgeLabel } from '../src/service'
import { Rig } from './support'

let rig: Rig
afterEach(() => rig?.cleanup())

const ask = (session: string | null, text: string) =>
  rig.client.callAny('quirky.ask/create', {
    spec: { questions: [{ id: 'go', question: text, type: 'confirm' }] },
    ...(session === null ? {} : { session })
  })

async function run(client: QuirkyClient, command: string, flags: CliArgs['flags'] = {}, json = false): Promise<string> {
  const { ctx, lines } = testCliContext(client, { json })
  await commands[command]!({ positionals: [], flags }, ctx)
  return lines.join('\n')
}

describe('badge and status', () => {
  test('SC-42: the badge counts unread worktrees plus pending asks', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const c = await rig.worktree('c')
    const sessions = [await rig.session('b'), await rig.session('b'), await rig.session('b')]
    for (const s of sessions) await rig.client.callAny('quirky.session/setUnread', { session: s.id, unread: 'agent' })
    for (const w of [b, c]) await rig.client.callAny('quirky.worktree/set', { worktree: `id:${w.id}`, unread: true })
    const one = await rig.session('c')
    const two = await rig.session('c')
    await ask(one.id, 'One?')
    await ask(two.id, 'Two?')

    const status = await rig.status()

    expect(status).toMatchObject({ badge: 4, label: '4', pendingAsks: 2 })
    expect(status.unreadWorktrees.map((w) => w.name).sort()).toEqual(['b', 'c'])
    expect(status.unreadSessions).toHaveLength(3)
  })

  test('the badge label is empty at 0, the number up to 99 and 99+ above', () => {
    expect([0, 1, 99, 100, 120].map(badgeLabel)).toEqual(['', '1', '99', '99+', '99+'])
  })

  test('an answered ask leaves the badge, and the change is announced', async () => {
    rig = await Rig.start()
    const s = await rig.session('b')
    const { askId } = (await ask(s.id, 'Go?')) as { askId: string }
    await waitForAsync(async () => (await rig.status()).badge === 1)
    await waitForAsync(async () => rig.pluginEvents('changed').some((e) => e.badge === 1))

    await rig.client.callAny('quirky.ask/answer', { askId, answers: { go: { value: true, source: 'input' } } })

    await waitForAsync(async () => (await rig.status()).badge === 0)
    await waitForAsync(async () => rig.pluginEvents('changed').at(-1)?.badge === 0)
  })

  test('the status reports a sound problem', async () => {
    rig = await Rig.start()
    expect((await rig.status()).sound).toEqual({ ok: true })
    await rig.setting('sound', 'custom')
    expect((await rig.status()).sound).toEqual({ ok: false, reason: 'no custom file chosen' })
    await waitForAsync(async () => rig.pluginEvents('changed').length > 0)
  })
})

describe('CLI', () => {
  test('SC-52: status prints the badge, the unread worktrees and sessions, the asks and the sound check', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    await rig.client.callAny('quirky.session/setUnread', { session: s.id, unread: 'bell' })
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, unread: true })

    expect(await run(rig.client, 'status')).toBe(
      [`badge 1`, `worktree ${b.id} b`, `session ${s.id} ${b.id} bell`, 'asks 0', 'sound ok'].join('\n')
    )
    expect(JSON.parse(await run(rig.client, 'status', {}, true))).toMatchObject({
      badge: 1,
      unreadWorktrees: [{ id: b.id, name: 'b' }],
      unreadSessions: [{ id: s.id, worktreeId: b.id, reason: 'bell' }],
      pendingAsks: 0
    })
  })

  test('send resolves --worktree through the worktree plugin and prints the reason', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')

    expect(await run(rig.client, 'send', { worktree: 'name:b', title: 'Deploy', body: 'staging is up' }, true)).toBe(
      '{"delivered":true,"reason":"delivered"}'
    )
    expect(rig.notifies()).toMatchObject([{ title: 'b: Deploy', body: 'staging is up', worktreeId: b.id }])
    expect(await run(rig.client, 'send', { worktree: 'name:b', body: 'again' })).toBe('cooldown')
    await expect(run(rig.client, 'send', { title: 'x' })).rejects.toThrow('missing --body')
    await expect(run(rig.client, 'send', { body: 'x', session: 's', worktree: 'b' })).rejects.toThrow('not both')
    await expect(run(rig.client, 'send', { body: 'x', worktree: 'name:nope' })).rejects.toThrow()
  })

  test('test prints the reason and preview prints played or the reason', async () => {
    rig = await Rig.start()
    expect(await run(rig.client, 'test')).toBe('delivered')
    await rig.setting('enabled', false)
    expect(await run(rig.client, 'test')).toBe('disabled')
    expect(await run(rig.client, 'preview', { sound: 'beep', volume: 20 })).toBe('played')
    expect(await run(rig.client, 'preview', { path: 'nope.wav' })).toBe('must be an absolute path')
    expect(await run(rig.client, 'preview', { sound: 'system' }, true)).toBe('{"played":false,"reason":"System Default has no preview"}')
  })

  test('SC-52: the API lists status, send, test and preview with their schemas', async () => {
    rig = await Rig.start()
    const description = (await rig.client.callAny('api.describe', {})) as {
      methods: { name: string; plugin: string | null; params: unknown; result: unknown }[]
      events: { name: string }[]
    }
    const ours = description.methods.filter((m) => m.plugin === 'quirky.notifications')
    expect(ours.map((m) => m.name).sort()).toEqual([
      'quirky.notifications/preview',
      'quirky.notifications/send',
      'quirky.notifications/status',
      'quirky.notifications/test'
    ])
    for (const method of ours) expect(method.result).toHaveProperty('properties')
    expect(description.events.filter((e) => e.name.startsWith('quirky.notifications/')).map((e) => e.name).sort()).toEqual([
      'quirky.notifications/attention',
      'quirky.notifications/changed',
      'quirky.notifications/decided',
      'quirky.notifications/sound'
    ])
  })
})

describe('migration', () => {
  const NOTIFICATIONS = 'setting:quirky.agent-status/notifications'

  test('SC-51: an old "off" carries over to Agent Task Complete', async () => {
    const home = makeTempHome('qn-mig-')
    const store = new Store(join(home, 'quirky.db'))
    store.setSettingValue(NOTIFICATIONS, false)
    store.close()
    rig = await Rig.start({ home })

    await waitForAsync(async () => ((await rig.client.callAny('setting.get', { id: 'setting:quirky.notifications/agentTaskComplete' })) as { value: unknown }).value === false)
    expect(((await rig.client.callAny('setting.get', { id: 'setting:quirky.notifications/enabled' })) as { value: unknown }).value).toBe(true)
    await expect(rig.client.callAny('setting.get', { id: NOTIFICATIONS })).rejects.toThrow()
  })

  test('SC-51: v1\'s "notifications: false" arrives the same way', async () => {
    const home = makeTempHome('qn-mig-')
    new Store(join(home, 'quirky.db')).close()
    const db = new Database(join(home, 'quirky.db'))
    db.query("INSERT INTO settings (key, value) VALUES ('notifications', 'false')").run()
    db.close()
    rig = await Rig.start({ home })

    await waitForAsync(async () => ((await rig.client.callAny('setting.get', { id: 'setting:quirky.notifications/agentTaskComplete' })) as { value: unknown }).value === false)
  })

  test('an old "on", or none, leaves the defaults; and the carry-over happens once', async () => {
    const home = makeTempHome('qn-mig-')
    const store = new Store(join(home, 'quirky.db'))
    store.setSettingValue(NOTIFICATIONS, false)
    store.close()
    rig = await Rig.start({ home })
    const get = async () =>
      ((await rig.client.callAny('setting.get', { id: 'setting:quirky.notifications/agentTaskComplete' })) as { value: unknown }).value
    await waitForAsync(async () => (await get()) === false)

    await rig.setting('agentTaskComplete', true)
    await rig.h.daemon.stop()
    rig.h.pty.stop()
    const again = await Rig.start({ home })
    await again.settle(300)
    expect(((await again.client.callAny('setting.get', { id: 'setting:quirky.notifications/agentTaskComplete' })) as { value: unknown }).value).toBe(true)
    await again.cleanup()
  })

  test('with nothing stored the defaults stand', async () => {
    rig = await Rig.start()
    await rig.settle(200)
    const values = (await rig.client.callAny('setting.list', { pluginId: 'quirky.notifications' })) as { id: string; value: unknown }[]
    expect(Object.fromEntries(values.map((v) => [v.id.split('/')[1], v.value]))).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: false,
      terminalNotifications: true,
      sound: 'system',
      customSoundPath: '',
      volume: 100,
      suppressWhenFocused: true,
      showMenuBarIcon: true
    })
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { Rig } from './support'

let rig: Rig
afterEach(() => rig?.cleanup())

/** Waits for the unread value of a session to settle on `expected`. */
const sessionUnread = (id: string, expected: string | null) =>
  waitForAsync(async () => ((await rig.getSession(id)).unread ?? null) === expected)

const worktreeUnread = (name: string, expected: boolean) => waitForAsync(async () => (await rig.getWorktree(name)).unread === expected)

describe('unread markers', () => {
  test('SC-1: an agent finishing in a background worktree marks its session and worktree', async () => {
    rig = await Rig.start()
    const a = await rig.worktree('a')
    await rig.worktree('b')
    const sa = await rig.session('a')
    const s = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(a.id, [sa.id])

    await rig.claudeTurn(s.id, 'All green')
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread).toBe('agent')
    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect((await rig.getWorktree('a')).unread).toBe(false)
    expect((await rig.getSession(sa.id)).unread ?? null).toBeNull()
    const status = await rig.status()
    expect(status).toMatchObject({
      badge: 1,
      label: '1',
      unreadWorktrees: [{ id: rig.worktrees.b!.id, name: 'b' }],
      unreadSessions: [{ id: s.id, worktreeId: rig.worktrees.b!.id, reason: 'agent' }]
    })
  })

  test('SC-2: finishing in the session on screen marks nothing and sends no notify', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread ?? null).toBeNull()
    expect((await rig.getWorktree('b')).unread).toBe(false)
    expect((await rig.status()).badge).toBe(0)
    expect(rig.notifies()).toEqual([])
    expect(rig.decisions()[0]).toMatchObject({ source: 'agent', result: 'suppressed-focus' })
  })

  test('SC-3: a background tab of the open worktree is marked, the worktree is not', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s1 = await rig.session('b', 'claude')
    const s2 = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s1.id])

    await rig.claudeTurn(s2.id, 'done')
    await rig.waitDecided(1)

    expect((await rig.getSession(s2.id)).unread).toBe('agent')
    expect((await rig.getWorktree('b')).unread).toBe(false)
    expect((await rig.status()).badge).toBe(0)
    expect(rig.notifies()).toEqual([])
  })

  test('SC-4: an away person still gets the marker, and the next touch clears it', async () => {
    rig = await Rig.start({ awayMs: 400 })
    const b = await rig.worktree('b')
    const s = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(b.id, [s.id])
    await Bun.sleep(480)

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)
    expect((await rig.getSession(s.id)).unread).toBe('agent')
    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect((await rig.status()).badge).toBe(1)

    await rig.win.input()
    await sessionUnread(s.id, null)
    await worktreeUnread('b', false)
    await waitForAsync(async () => (await rig.status()).badge === 0)
  })

  test('SC-5: focusing the window clears what it shows, and only that', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s1 = await rig.session('b')
    const s2 = await rig.session('b')
    await rig.client.callAny('quirky.session/setUnread', { session: s1.id, unread: 'agent' })
    await rig.client.callAny('quirky.session/setUnread', { session: s2.id, unread: 'agent' })
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, unread: true })
    await rig.win.open(b.id, [s1.id])
    await rig.settle()
    expect((await rig.status()).badge).toBe(1)

    await rig.win.focus()
    await rig.win.input()

    await sessionUnread(s1.id, null)
    await worktreeUnread('b', false)
    expect((await rig.getSession(s2.id)).unread).toBe('agent')
    await waitForAsync(async () => (await rig.status()).badge === 0)
  })

  test('SC-7: Mark Read clears the worktree and all its sessions; Mark Unread marks only the worktree', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s1 = await rig.session('b')
    const s2 = await rig.session('b')
    const set = (unread: boolean) => rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, unread })
    for (const s of [s1, s2]) await rig.client.callAny('quirky.session/setUnread', { session: s.id, unread: 'bell' })
    await set(true)
    await rig.settle()
    expect((await rig.status()).badge).toBe(1)

    await set(false)
    await sessionUnread(s1.id, null)
    await sessionUnread(s2.id, null)
    await waitForAsync(async () => (await rig.status()).badge === 0)

    await set(true)
    await worktreeUnread('b', true)
    await waitForAsync(async () => (await rig.status()).badge === 1)
    expect((await rig.getSession(s1.id)).unread ?? null).toBeNull()
    expect((await rig.getSession(s2.id)).unread ?? null).toBeNull()

    // B already read, a session still unread (the state SC-3 leaves): Mark Read still clears the session
    await set(false)
    await worktreeUnread('b', false)
    await rig.client.callAny('quirky.session/setUnread', { session: s1.id, unread: 'agent' })
    await set(false)
    await sessionUnread(s1.id, null)
  })

  test('SC-7: the plugin\'s own worktree writes are not mistaken for Mark Read', async () => {
    rig = await Rig.start()
    const a = await rig.worktree('a')
    const sa = await rig.session('a')
    const sb = await rig.session('b', 'claude')
    const other = await rig.session('b')
    await rig.client.callAny('quirky.session/setUnread', { session: other.id, unread: 'bell' })
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(a.id, [sa.id])

    await rig.claudeTurn(sb.id, 'done')
    await rig.waitDecided(1)
    await rig.settle()

    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect((await rig.getSession(other.id)).unread).toBe('bell')
    expect((await rig.getSession(sb.id)).unread).toBe('agent')
  })

  test('SC-8: markers are written even when notifications are off', async () => {
    rig = await Rig.start()
    await rig.setting('enabled', false)
    const a = await rig.worktree('a')
    const sa = await rig.session('a')
    const s = await rig.session('b', 'claude')
    await rig.win.focus()
    await rig.win.input()
    await rig.win.open(a.id, [sa.id])

    await rig.claudeTurn(s.id, 'done')
    await rig.waitDecided(1)

    expect((await rig.getSession(s.id)).unread).toBe('agent')
    expect((await rig.getWorktree('b')).unread).toBe(true)
    expect((await rig.status()).badge).toBe(1)
    expect(rig.notifies()).toEqual([])
    expect(rig.attentions()).toHaveLength(1)
    expect(rig.decisions()[0]).toMatchObject({ result: 'disabled' })
  })

  test('SC-9: presence never reported never clears a marker', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    await rig.client.callAny('quirky.session/setUnread', { session: s.id, unread: 'agent' })
    await rig.win.open(b.id, [s.id])
    await rig.win.focus()
    await rig.win.focus()
    await rig.settle()

    expect((await rig.getSession(s.id)).unread).toBe('agent')
  })

  test('SC-10: closing a session drops its marker from the status and leaves the worktree marked', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    const s = await rig.session('b')
    await rig.client.callAny('quirky.session/setUnread', { session: s.id, unread: 'agent' })
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, unread: true })
    await waitForAsync(async () => (await rig.status()).unreadSessions.length === 1)

    await rig.client.callAny('quirky.session/close', { session: s.id })

    await waitFor(() => true)
    const status = await rig.status()
    expect(status.unreadSessions).toEqual([])
    expect(status.unreadWorktrees).toEqual([{ id: b.id, name: 'b' }])
  })

  test('a changed badge is announced, an unchanged status is not', async () => {
    rig = await Rig.start()
    const b = await rig.worktree('b')
    await rig.settle()
    const changed = () => rig.pluginEvents('changed')
    const before = changed().length

    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, unread: true })
    await waitFor(() => changed().length > before)
    expect(changed().at(-1)).toEqual({ badge: 1 })

    const after = changed().length
    await rig.client.callAny('quirky.worktree/set', { worktree: `id:${b.id}`, comment: 'x' })
    await rig.settle()
    expect(changed()).toHaveLength(after)
  })
})

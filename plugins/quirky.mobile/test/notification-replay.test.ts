import { describe, expect, test } from 'bun:test'
import { NotificationReplay } from '../src/daemon/notification-replay'

describe('mobile scoped notification replay', () => {
  test('filters away/focused events while advancing the cursor and never replays filtered rows', async () => {
    const replay = new NotificationReplay()
    replay.append({ title: 'Present', body: 'a', worktreeId: 'one' }, false)
    replay.append({ title: 'Focused', body: 'b', worktreeId: 'two' }, true)
    replay.append({ title: 'Unknown presence', body: 'c', worktreeId: 'three' }, null)
    const page = await replay.poll('device-a', { onlyWhenDesktopAway: true, suppressWorktree: 'two', waitMs: 0 })
    expect(page.notifications.map(row => row.title)).toEqual(['Unknown presence'])
    expect(page.cursor).toBe(3)
    expect(page.presenceAvailable).toBe(false)
    const next = await replay.poll('device-a', { after: page.cursor, epoch: page.epoch, onlyWhenDesktopAway: false, waitMs: 0 })
    expect(next.notifications).toEqual([])
    replay.dispose()
  })

  test('bounds replay, identifies gaps and resets old process epochs without trusting future cursors', async () => {
    const replay = new NotificationReplay()
    for (let n = 1; n <= 260; n++) replay.append({ title: `n${n}`, body: '' }, true)
    const page = await replay.poll('device-a', { after: 1, epoch: replay.epoch, waitMs: 0 })
    expect(page.truncated).toBe(true)
    expect(page.notifications[0]?.seq).toBe(5)
    expect(page.notifications.at(-1)?.seq).toBe(260)
    expect(new Set(page.notifications.map(row => row.id)).size).toBe(256)
    const reset = await replay.poll('device-a', { after: 9999, epoch: 'old-process', waitMs: 0 })
    expect(reset.reset).toBe(true)
    expect(reset.cursor).toBe(260)
    expect(reset.notifications[0]?.seq).toBe(5)
    await expect(replay.poll('device-a', { after: 9999, epoch: replay.epoch, waitMs: 0 })).rejects.toThrow('cursor')
    replay.dispose()
  })

  test('isolates pending polls by authenticated device and aborts without leaking later notifications', async () => {
    const replay = new NotificationReplay()
    const abort = new AbortController()
    const first = replay.poll('device-a', { waitMs: 1000 }, abort.signal)
    await expect(replay.poll('device-a', { waitMs: 1000 })).rejects.toThrow('pending')
    const other = replay.poll('device-b', { waitMs: 1000 })
    abort.abort()
    await expect(first).rejects.toThrow('closed')
    replay.append({ title: 'After disconnect', body: 'safe' }, true)
    expect((await other).notifications.map(row => row.title)).toEqual(['After disconnect'])
    const resumed = await replay.poll('device-a', { after: 1, epoch: replay.epoch, waitMs: 0 })
    expect(resumed.notifications).toEqual([])
    replay.dispose()
  })
})

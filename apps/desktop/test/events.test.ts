import { describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import {
  TRAY_MENU,
  attentionIn,
  badgeLabel,
  createBadgeUpdater,
  loadBadge,
  loadShowMenuBarIcon,
  notificationFor,
  shouldRefreshBadge,
  showMenuBarIconIn,
  soundIn,
  trayState,
  type TrayState
} from '../src/bun/events'

describe('notificationFor', () => {
  test('SC-23: maps a notify event for the desktop to a notification', () => {
    const event: QuirkyEvent = { type: 'notify', title: 'Claude', body: 'needs input', sessionId: 's1', desktop: true }
    expect(notificationFor(event)).toEqual({
      title: 'Claude',
      body: 'needs input',
      silent: true,
      soundFile: null,
      volume: 100
    })
  })

  test('SC-40: a notify event without a sound is silent and plays nothing', () => {
    const event: QuirkyEvent = { type: 'notify', title: 'Claude', body: 'done', desktop: true }
    expect(notificationFor(event)).toMatchObject({ silent: true, soundFile: null })
  })

  test('keeps the toast target and key so a banner click can open and retire it', () => {
    const open = { view: 'view:quirky.session/worktree', input: { worktree: 'w1', session: 's1' } }
    const event: QuirkyEvent = { type: 'notify', title: 'Claude', body: 'done', desktop: true, open, key: 'session:s1' }
    expect(notificationFor(event)).toMatchObject({ open, key: 'session:s1' })
  })

  test('falls back to the app name for a blank title', () => {
    const event: QuirkyEvent = { type: 'notify', title: '  ', body: 'hello', desktop: true }
    expect(notificationFor(event)?.title).toBe('Quirky')
  })

  test('SC-23: a notify event without desktop: true shows no native notification', () => {
    expect(notificationFor({ type: 'notify', title: 'Claude', body: 'quiet', desktop: false })).toBeNull()
    expect(notificationFor({ type: 'notify', title: 'Claude', body: 'unspecified' } as QuirkyEvent)).toBeNull()
  })

  test('ignores other events', () => {
    expect(notificationFor({ type: 'plugin.changed' })).toBeNull()
  })

  test('SC-37: a chosen sound file makes the banner silent and names the file and volume', () => {
    const event: QuirkyEvent = {
      type: 'notify',
      title: 'Claude',
      body: 'done',
      desktop: true,
      sound: { file: '/sounds/bong.wav', volume: 60 }
    }
    expect(notificationFor(event)).toEqual({
      title: 'Claude',
      body: 'done',
      silent: true,
      soundFile: '/sounds/bong.wav',
      volume: 60
    })
  })

  test('SC-37: System Default (file null) keeps the banner audible and plays nothing itself', () => {
    const event: QuirkyEvent = {
      type: 'notify',
      title: 'Claude',
      body: 'done',
      desktop: true,
      sound: { file: null, volume: 40 }
    }
    expect(notificationFor(event)).toMatchObject({ silent: false, soundFile: null, volume: 40 })
  })
})

describe('badge', () => {
  test('SC-42: labels are empty for zero and capped at 99+', () => {
    expect(badgeLabel(0)).toBe('')
    expect(badgeLabel(4)).toBe('4')
    expect(badgeLabel(120)).toBe('99+')
  })

  test('only notification changes and plugin-set changes trigger a refresh', () => {
    expect(shouldRefreshBadge({ type: 'quirky.notifications/changed', data: { badge: 2 } })).toBe(true)
    expect(shouldRefreshBadge({ type: 'plugin.changed' })).toBe(true)
    expect(shouldRefreshBadge({ type: 'quirky.session/changed', data: {} })).toBe(false)
    expect(shouldRefreshBadge({ type: 'quirky.ask/created', data: {} })).toBe(false)
    expect(shouldRefreshBadge({ type: 'quirky.git/changed', data: {} })).toBe(false)
    expect(shouldRefreshBadge({ type: 'notify', title: 't', body: 'b', desktop: false })).toBe(false)
  })
})

describe('loadBadge', () => {
  test('reads the badge from quirky.notifications/status', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const badge = await loadBadge(async (method, params) => {
      calls.push([method, params])
      return { badge: 4, label: '4' }
    })
    expect(badge).toBe(4)
    expect(calls).toEqual([['quirky.notifications/status', {}]])
  })

  test('a missing method because the plugin is off counts as zero', async () => {
    const badge = await loadBadge(async (method) => {
      throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method ${method}`)
    })
    expect(badge).toBe(0)
  })

  test('any other failure propagates so the badge stays as it was', async () => {
    const failing = loadBadge(async () => {
      throw new RpcError(RpcErrorCode.Internal, 'boom')
    })
    await expect(failing).rejects.toThrow('boom')
  })

  test('a malformed result counts as zero', async () => {
    expect(await loadBadge(async () => ({ label: 'x' }))).toBe(0)
    expect(await loadBadge(async () => null)).toBe(0)
  })
})

describe('createBadgeUpdater', () => {
  test('refresh applies the current count', async () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({ load: async () => 3, apply: (count) => applied.push(count) })
    await updater.refresh()
    expect(applied).toEqual([3])
  })

  test('overlapping refreshes coalesce into one trailing reload', async () => {
    let loads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const applied: number[] = []
    const updater = createBadgeUpdater({
      load: async () => {
        loads += 1
        const n = loads
        if (n === 1) await gate
        return n
      },
      apply: (count) => applied.push(count)
    })
    const first = updater.refresh()
    const second = updater.refresh()
    const third = updater.refresh()
    release()
    await Promise.all([first, second, third])
    expect(loads).toBe(2)
    expect(applied.at(-1)).toBe(2)
  })

  test('a failed load keeps the last badge and does not throw', async () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({
      load: async () => {
        throw new Error('down')
      },
      apply: (count) => applied.push(count)
    })
    await updater.refresh()
    expect(applied).toEqual([])
  })

  test('reset clears the badge', () => {
    const applied: number[] = []
    const updater = createBadgeUpdater({ load: async () => 0, apply: (c) => applied.push(c) })
    updater.reset()
    expect(applied).toEqual([0])
  })
})

describe('trayState', () => {
  const start: TrayState = { visible: true, dot: false }

  test('SC-44: the dot lights only while the window is hidden, and focus clears it', () => {
    const visibleAttention = trayState(start, { type: 'attention', windowVisible: true })
    expect(visibleAttention.dot).toBe(false)

    const minimizedAttention = trayState(visibleAttention, { type: 'attention', windowVisible: false })
    expect(minimizedAttention.dot).toBe(true)

    const focused = trayState(minimizedAttention, { type: 'focus' })
    expect(focused.dot).toBe(false)
  })

  test('attention while the window is visible leaves an existing dot alone', () => {
    const lit: TrayState = { visible: true, dot: true }
    expect(trayState(lit, { type: 'attention', windowVisible: true })).toEqual(lit)
  })

  test('SC-45: Show Menu Bar Icon off hides the item and keeps the dot for when it returns', () => {
    const lit: TrayState = { visible: true, dot: true }
    const hidden = trayState(lit, { type: 'showMenuBarIcon', value: false })
    expect(hidden).toEqual({ visible: false, dot: true })
    expect(trayState(hidden, { type: 'showMenuBarIcon', value: true })).toEqual({ visible: true, dot: true })
  })

  test('attention while the icon is hidden still records the dot', () => {
    const hidden: TrayState = { visible: false, dot: false }
    expect(trayState(hidden, { type: 'attention', windowVisible: false })).toEqual({ visible: false, dot: true })
  })

  test('does not mutate the previous state', () => {
    const prev: TrayState = { visible: true, dot: false }
    trayState(prev, { type: 'attention', windowVisible: false })
    expect(prev).toEqual({ visible: true, dot: false })
  })
})

describe('tray menu', () => {
  test('SC-45: Show Quirky, divider, Settings…, divider, Quit Quirky', () => {
    expect(TRAY_MENU).toEqual([
      { type: 'normal', label: 'Show Quirky', action: 'show' },
      { type: 'divider' },
      { type: 'normal', label: 'Settings…', action: 'settings' },
      { type: 'divider' },
      { type: 'normal', label: 'Quit Quirky', action: 'quit' }
    ])
  })
})

describe('loadShowMenuBarIcon', () => {
  const id = 'setting:quirky.notifications/showMenuBarIcon'

  test('reads the setting value through setting.get', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const shown = await loadShowMenuBarIcon(async (method, params) => {
      calls.push([method, params])
      return { id, value: false }
    })
    expect(shown).toBe(false)
    expect(calls).toEqual([['setting.get', { id }]])
  })

  test('the icon shows when the setting does not exist because the plugin is off', async () => {
    const missing = loadShowMenuBarIcon(async () => {
      throw new RpcError(RpcErrorCode.NotFound, 'no such setting')
    })
    expect(await missing).toBe(true)
  })

  test('any other failure propagates', async () => {
    const failing = loadShowMenuBarIcon(async () => {
      throw new RpcError(RpcErrorCode.Internal, 'boom')
    })
    await expect(failing).rejects.toThrow('boom')
  })
})

describe('plugin event readers', () => {
  test('attentionIn recognises quirky.notifications/attention only', () => {
    const attention = { source: 'agent', sessionId: 's', worktreeId: 'w' }
    expect(attentionIn({ type: 'quirky.notifications/attention', data: attention })).toBe(true)
    expect(attentionIn({ type: 'quirky.notifications/changed', data: { badge: 1 } })).toBe(false)
    expect(attentionIn({ type: 'plugin.changed' })).toBe(false)
  })

  test('soundIn returns the file and volume of a sound event, nothing for the system sound', () => {
    expect(soundIn({ type: 'quirky.notifications/sound', data: { file: '/s/ding.wav', volume: 40 } })).toEqual({
      file: '/s/ding.wav',
      volume: 40
    })
    expect(soundIn({ type: 'quirky.notifications/sound', data: { file: null, volume: 40 } })).toBeNull()
    expect(soundIn({ type: 'quirky.notifications/sound', data: null })).toBeNull()
    expect(soundIn({ type: 'plugin.changed' })).toBeNull()
  })

  test('showMenuBarIconIn follows setting.changed for the setting and ignores others', () => {
    const id = 'setting:quirky.notifications/showMenuBarIcon'
    expect(showMenuBarIconIn({ type: 'setting.changed', id, value: false })).toBe(false)
    expect(showMenuBarIconIn({ type: 'setting.changed', id, value: true })).toBe(true)
    expect(showMenuBarIconIn({ type: 'setting.changed', id: 'setting:other/x', value: false })).toBeNull()
    expect(showMenuBarIconIn({ type: 'setting.changed', id, value: 'no' })).toBeNull()
    expect(showMenuBarIconIn({ type: 'plugin.changed' })).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type { NativeNotification } from '../src/bun/events'
import {
  NativeNotifications,
  notificationCapabilities,
  notificationCapabilitiesPreamble,
  notificationIdIn,
  preloadNotificationCapabilities,
  readNotificationPermission,
  registerNotificationPermission,
  type NotificationPermission,
  type NotificationUtils
} from '../src/bun/native-notifications'

type Shown = { title: string; body?: string; silent?: boolean; id?: string }

function fakeUtils(overrides: Partial<NotificationUtils> = {}): NotificationUtils & { shown: Shown[] } {
  const shown: Shown[] = []
  return {
    shown,
    showNotification: (options) => {
      shown.push(options)
      return options.id ?? 'generated'
    },
    ...overrides
  }
}

function banner(overrides: Partial<NativeNotification> = {}): NativeNotification {
  return { title: 'Claude', body: 'needs input', silent: true, soundFile: null, volume: 100, ...overrides }
}

function recordingActions() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let shown = 0
  return {
    calls,
    get shown() { return shown },
    actions: {
      showWindow: () => { shown++ },
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return undefined
      }
    }
  }
}

describe('readNotificationPermission', () => {
  test('an SDK without the permission API is unsupported', async () => {
    expect(await readNotificationPermission(fakeUtils())).toBe('unsupported')
  })

  test('returns what the SDK reports', async () => {
    const utils = fakeUtils({ getNotificationPermission: async () => 'denied' })
    expect(await readNotificationPermission(utils)).toBe('denied')
  })

  test('a failing SDK call is unsupported rather than a guessed permission', async () => {
    const utils = fakeUtils({ getNotificationPermission: async () => { throw new Error('no bridge') } })
    expect(await readNotificationPermission(utils)).toBe('unsupported')
  })

  test('an unanswered SDK call stops waiting and reports unsupported', async () => {
    const utils = fakeUtils({ getNotificationPermission: () => new Promise<NotificationPermission>(() => {}) })
    expect(await readNotificationPermission(utils, 5)).toBe('unsupported')
  })
})

describe('registerNotificationPermission', () => {
  test('asks only when macOS has no recorded decision', async () => {
    const asked: string[] = []
    const utils = fakeUtils({
      requestNotificationPermission: async () => {
        asked.push('request')
        return 'authorized'
      }
    })
    expect(await registerNotificationPermission(utils, 'not-determined')).toBe('authorized')
    for (const decided of ['denied', 'authorized', 'provisional', 'unsupported'] as const) {
      expect(await registerNotificationPermission(utils, decided)).toBe(decided)
    }
    expect(asked).toEqual(['request'])
  })

  test('an SDK that cannot request keeps the read permission', async () => {
    expect(await registerNotificationPermission(fakeUtils(), 'not-determined')).toBe('not-determined')
  })
})

describe('notification capabilities', () => {
  test('are all true only when the SDK reports a permission', () => {
    expect(notificationCapabilities('denied')).toEqual({ permission: true, click: true, dismiss: true })
    expect(notificationCapabilities('unsupported')).toEqual({ permission: false, click: false, dismiss: false })
  })

  test('reach the preload through the preamble', () => {
    const sandbox: { __quirkyNotificationCapabilities?: unknown } = {}
    runInNewContext(notificationCapabilitiesPreamble(notificationCapabilities('authorized')), sandbox)
    expect(preloadNotificationCapabilities(sandbox.__quirkyNotificationCapabilities))
      .toEqual({ permission: true, click: true, dismiss: true })
  })

  test('a missing or malformed preamble reports nothing as supported', () => {
    const none = { permission: false, click: false, dismiss: false }
    expect(preloadNotificationCapabilities(undefined)).toEqual(none)
    expect(preloadNotificationCapabilities(null)).toEqual(none)
    expect(preloadNotificationCapabilities({ permission: 'yes', click: 1, dismiss: true }))
      .toEqual({ permission: false, click: false, dismiss: true })
  })
})

describe('NativeNotifications', () => {
  test('shows each banner with an id', () => {
    const utils = fakeUtils()
    const notifications = new NativeNotifications(utils, () => 'uuid-1')
    expect(notifications.show(banner())).toBe('uuid-1')
    expect(utils.shown).toEqual([{ title: 'Claude', body: 'needs input', silent: true, id: 'uuid-1' }])
  })

  test('a keyed notification reuses its id so the newer banner replaces the older', () => {
    const utils = fakeUtils()
    let next = 0
    const notifications = new NativeNotifications(utils, () => `uuid-${++next}`)
    notifications.show(banner({ key: 'ask-1' }))
    notifications.show(banner({ key: 'ask-1', body: 'still waiting' }))
    expect(utils.shown.map((shown) => shown.id)).toEqual(['key:ask-1', 'key:ask-1'])
    expect(notifications.size).toBe(1)
  })

  test('a click brings Quirky forward, opens the target and retires the toast', async () => {
    const notifications = new NativeNotifications(fakeUtils(), () => 'uuid-1')
    const open = { view: 'view:quirky.session/worktree', input: { worktree: 'w1', session: 's1' } }
    const id = notifications.show(banner({ open, key: 'session:s1' }))
    const recorded = recordingActions()

    await notifications.click(id, recorded.actions)

    expect(recorded.shown).toBe(1)
    expect(recorded.calls).toEqual([
      { method: 'ui.view.open', params: { id: 'view:quirky.session/worktree', input: { worktree: 'w1', session: 's1' } } },
      { method: 'ui.toast.dismiss', params: { key: 'session:s1' } }
    ])
    expect(notifications.size).toBe(0)
  })

  test('a toast that is already gone does not fail the click', async () => {
    const notifications = new NativeNotifications(fakeUtils(), () => 'uuid-1')
    const id = notifications.show(banner({ key: 'gone' }))
    await expect(notifications.click(id, {
      showWindow: () => {},
      call: async () => { throw new Error('NotFound') }
    })).resolves.toBeUndefined()
  })

  test('a click on an unknown or dismissed banner only brings Quirky forward', async () => {
    const notifications = new NativeNotifications(fakeUtils(), () => 'uuid-1')
    const id = notifications.show(banner({ open: { view: 'view:x' } }))
    notifications.dismiss(id)
    const recorded = recordingActions()

    await notifications.click(id, recorded.actions)
    await notifications.click('from-an-earlier-run', recorded.actions)

    expect(recorded.shown).toBe(2)
    expect(recorded.calls).toEqual([])
  })

  test('keeps only the newest targets past the cap', async () => {
    let next = 0
    const notifications = new NativeNotifications(fakeUtils(), () => `uuid-${++next}`, 2)
    notifications.show(banner({ open: { view: 'view:first' } }))
    notifications.show(banner({ open: { view: 'view:second' } }))
    notifications.show(banner({ open: { view: 'view:third' } }))
    expect(notifications.size).toBe(2)

    const recorded = recordingActions()
    await notifications.click('uuid-1', recorded.actions)
    await notifications.click('uuid-3', recorded.actions)
    expect(recorded.calls.map((call) => call.params.id)).toEqual(['view:third'])
  })
})

describe('notificationIdIn', () => {
  test('reads the id an Electrobun notification event carries', () => {
    expect(notificationIdIn({ id: 'uuid-1' })).toBe('uuid-1')
    expect(notificationIdIn({ id: '' })).toBeNull()
    expect(notificationIdIn({})).toBeNull()
    expect(notificationIdIn(null)).toBeNull()
  })
})

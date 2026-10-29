import { describe, expect, test } from 'bun:test'
import { TRAY_MENU } from '../src/bun/events'
import {
  createUpdateController,
  trayMenuWithUpdates,
  updateActionFromEvent,
  type UpdateInfoLike,
  type UpdateNotice,
  type UpdaterLike
} from '../src/bun/updates'

const NONE: UpdateInfoLike = { version: '', updateAvailable: false, updateReady: false, error: '' }

function fakeUpdater(overrides: Partial<UpdaterLike> & { channel?: string; baseUrl?: string } = {}) {
  const calls: string[] = []
  let info: UpdateInfoLike = NONE
  const updater: UpdaterLike = {
    getLocalInfo: async () => ({
      channel: overrides.channel ?? 'stable',
      version: '0.1.0',
      baseUrl: overrides.baseUrl ?? 'https://example.test/releases'
    }),
    checkForUpdate: async () => {
      calls.push('check')
      info = { ...NONE, version: '0.2.0', updateAvailable: true }
      return info
    },
    downloadUpdate: async () => {
      calls.push('download')
      info = { ...info, updateReady: true }
    },
    applyUpdate: async () => {
      calls.push('apply')
    },
    updateInfo: () => info,
    ...overrides
  }
  return { updater, calls, setInfo: (next: UpdateInfoLike) => (info = next) }
}

function harness(overrides: Parameters<typeof fakeUpdater>[0] = {}) {
  const fake = fakeUpdater(overrides)
  const notices: UpdateNotice[] = []
  const warnings: string[] = []
  const ready: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const controller = createUpdateController({
    updater: fake.updater,
    notify: (notice) => notices.push(notice),
    onReady: (version) => ready.push(version),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    warn: (message) => warnings.push(message),
    firstCheckDelayMs: 100,
    intervalMs: 1000
  })
  const fire = async (index: number) => {
    timers[index]!.fn()
    await Bun.sleep(5)
  }
  return { ...fake, controller, notices, warnings, ready, timers, fire }
}

describe('createUpdateController', () => {
  test('downloads an available update in the background and announces it once ready', async () => {
    const h = harness()
    await h.controller.start()
    expect(h.timers.map((t) => t.ms)).toEqual([100])
    await h.fire(0)
    expect(h.calls).toEqual(['check', 'download'])
    expect(h.ready).toEqual(['0.2.0'])
    expect(h.controller.readyVersion()).toBe('0.2.0')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.title).toBe('Update ready')
    expect(h.notices[0]!.body).toContain('0.2.0')
  })

  test('reschedules after every check at the long interval', async () => {
    const h = harness()
    await h.controller.start()
    await h.fire(0)
    expect(h.timers.map((t) => t.ms)).toEqual([100, 1000])
    await h.fire(1)
    expect(h.timers.map((t) => t.ms)).toEqual([100, 1000, 1000])
  })

  test('a scheduled re-check of the same staged version does not notify again', async () => {
    const h = harness()
    await h.controller.start()
    await h.fire(0)
    await h.fire(1)
    expect(h.notices).toHaveLength(1)
    expect(h.ready).toEqual(['0.2.0', '0.2.0'])
  })

  test('the dev channel never checks or schedules', async () => {
    const h = harness({ channel: 'dev' })
    await h.controller.start()
    expect(h.timers).toEqual([])
    expect(h.calls).toEqual([])
  })

  test('an app with no release URL never checks', async () => {
    const h = harness({ baseUrl: '' })
    await h.controller.start()
    expect(h.timers).toEqual([])
  })

  test('a scheduled check that finds nothing stays silent', async () => {
    const h = harness({ checkForUpdate: async () => ({ ...NONE, version: '0.1.0' }) })
    await h.controller.start()
    await h.fire(0)
    expect(h.notices).toEqual([])
    expect(h.ready).toEqual([])
    expect(h.timers).toHaveLength(2)
  })

  test('a manual check says when the app is up to date', async () => {
    const h = harness({ checkForUpdate: async () => ({ ...NONE, version: '0.1.0' }) })
    expect(await h.controller.checkNow()).toBe('current')
    expect(h.notices).toEqual([{ title: "You're up to date", body: expect.any(String) }])
  })

  test('a manual check on the dev channel explains why nothing happens', async () => {
    const h = harness({ channel: 'dev' })
    expect(await h.controller.checkNow()).toBe('disabled')
    expect(h.notices).toHaveLength(1)
    expect(h.calls).toEqual([])
  })

  test('a failed scheduled check is logged, silent, and keeps the schedule', async () => {
    const h = harness({
      checkForUpdate: async () => {
        throw new Error('offline')
      }
    })
    await h.controller.start()
    await h.fire(0)
    expect(h.warnings).toHaveLength(1)
    expect(h.notices).toEqual([])
    expect(h.timers).toHaveLength(2)
  })

  test('a failed manual check reports the failure', async () => {
    const h = harness({
      checkForUpdate: async () => ({ ...NONE, error: 'Failed to check for updates: HTTP 404' })
    })
    expect(await h.controller.checkNow()).toBe('failed')
    expect(h.warnings).toHaveLength(1)
    expect(h.notices[0]).toEqual({ title: 'Update check failed', body: 'Failed to check for updates: HTTP 404' })
  })

  test('a download that reports an error never marks the update ready', async () => {
    const h = harness()
    h.updater.downloadUpdate = async () => {
      h.setInfo({ ...NONE, version: '0.2.0', updateAvailable: true, error: 'Failed to download update: HTTP 500' })
    }
    expect(await h.controller.checkNow()).toBe('failed')
    expect(h.ready).toEqual([])
    expect(h.controller.readyVersion()).toBeNull()
    expect(h.notices[0]!.body).toContain('HTTP 500')
  })

  test('a download that ends without a staged update counts as a failure', async () => {
    const h = harness()
    h.updater.downloadUpdate = async () => {}
    expect(await h.controller.checkNow()).toBe('failed')
    expect(h.ready).toEqual([])
  })

  test('a manual check while a scheduled one runs still reports its own outcome', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = harness({
      checkForUpdate: async () => {
        await gate
        return { ...NONE, version: '0.1.0' }
      }
    })
    await h.controller.start()
    h.timers[0]!.fn()
    const manual = h.controller.checkNow()
    release()
    expect(await manual).toBe('current')
    expect(h.notices.map((n) => n.title)).toEqual(["You're up to date"])
  })

  test('a scheduled check never overlaps a running one', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let checks = 0
    const h = harness({
      checkForUpdate: async () => {
        checks += 1
        await gate
        return { ...NONE }
      }
    })
    const first = h.controller.checkNow()
    h.timers.length = 0
    await h.controller.start()
    h.timers[0]!.fn()
    release()
    await first
    await Bun.sleep(5)
    expect(checks).toBe(1)
  })

  test('restart applies the staged update', async () => {
    const h = harness()
    await h.controller.restart()
    expect(h.calls).toEqual(['apply'])
    expect(h.notices).toEqual([])
  })

  test('restart reports an apply failure without throwing', async () => {
    const h = harness()
    h.updater.applyUpdate = async () => {
      h.setInfo({ ...NONE, error: 'Failed to start update helper: boom' })
    }
    await h.controller.restart()
    expect(h.notices[0]).toEqual({ title: 'Could not restart to update', body: 'Failed to start update helper: boom' })
  })

  test('restart reports a thrown apply error without throwing', async () => {
    const h = harness({
      applyUpdate: async () => {
        throw new Error('no helper')
      }
    })
    await h.controller.restart()
    expect(h.warnings).toHaveLength(1)
    expect(h.notices[0]!.body).toBe('no helper')
  })

  test('stop cancels the pending timer and prevents rescheduling', async () => {
    const h = harness()
    await h.controller.start()
    h.controller.stop()
    expect(h.timers[0]!.cancelled).toBe(true)
    await h.fire(0)
    expect(h.timers).toHaveLength(1)
  })
})

describe('trayMenuWithUpdates', () => {
  test('adds Check for Updates above Quit in its own group', () => {
    const menu = trayMenuWithUpdates(TRAY_MENU, null)
    expect(menu.map((item) => (item.type === 'normal' ? item.action : '|'))).toEqual([
      'show',
      '|',
      'settings',
      '|',
      'check-update',
      '|',
      'quit'
    ])
  })

  test('adds Restart to Update first in the group once an update is staged', () => {
    const menu = trayMenuWithUpdates(TRAY_MENU, '0.2.0')
    expect(menu.map((item) => (item.type === 'normal' ? item.action : '|'))).toEqual([
      'show',
      '|',
      'settings',
      '|',
      'apply-update',
      'check-update',
      '|',
      'quit'
    ])
  })
})

describe('updateActionFromEvent', () => {
  test('reads update actions from a menu click', () => {
    expect(updateActionFromEvent({ data: { action: 'check-update' } })).toBe('check-update')
    expect(updateActionFromEvent({ data: { action: 'apply-update' } })).toBe('apply-update')
  })

  test('ignores other clicks and malformed events', () => {
    expect(updateActionFromEvent({ data: { action: 'quit' } })).toBeNull()
    expect(updateActionFromEvent({})).toBeNull()
    expect(updateActionFromEvent(null)).toBeNull()
  })
})

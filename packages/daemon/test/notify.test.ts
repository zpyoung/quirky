import { describe, expect, test } from 'bun:test'
import type { QuirkyEvent } from '@quirky/protocol'
import { notificationScript, sendNotification, type Notifier } from '../src/notify'

function setup(options: { desktopClient?: boolean; notifier?: Notifier } = {}) {
  const events: QuirkyEvent[] = []
  const shown: Parameters<Notifier>[0][] = []
  const deps = {
    broadcast: (event: QuirkyEvent) => events.push(event),
    hasDesktopClient: () => options.desktopClient ?? false,
    notifier: options.notifier ?? ((n: Parameters<Notifier>[0]) => void shown.push(n))
  }
  return { deps, events, shown }
}

describe('sendNotification', () => {
  test('SC-50: passes the whole notification, sound included, to the notifier', () => {
    const t = setup()
    sendNotification(t.deps, { title: 'T', body: 'B', sound: { file: null, volume: 40 }, toast: false })
    expect(t.shown).toEqual([{ title: 'T', body: 'B', sound: { file: null, volume: 40 } }])
  })

  test('the notifier gets no sound key when the notification has none', () => {
    const t = setup()
    sendNotification(t.deps, { title: 'T', body: 'B' })
    expect(t.shown).toEqual([{ title: 'T', body: 'B' }])
  })

  test('the notify event carries sound and toast when set, and omits them otherwise', () => {
    const t = setup()
    sendNotification(t.deps, { title: 'T', body: 'B', sound: { file: '/a.aiff', volume: 10 }, toast: false })
    sendNotification(t.deps, { title: 'T', body: 'B' })
    expect(t.events[0]).toEqual({
      type: 'notify',
      title: 'T',
      body: 'B',
      desktop: true,
      sound: { file: '/a.aiff', volume: 10 },
      toast: false
    })
    expect(t.events[1]).toEqual({ type: 'notify', title: 'T', body: 'B', desktop: true })
  })

  test('still broadcasts always and notifies only without a desktop client and with desktop on', () => {
    const withDesktop = setup({ desktopClient: true })
    sendNotification(withDesktop.deps, { title: 'T', body: 'B', sound: { file: null, volume: 100 } })
    expect(withDesktop.events).toHaveLength(1)
    expect(withDesktop.shown).toEqual([])

    const suppressed = setup()
    sendNotification(suppressed.deps, { title: 'T', body: 'B', desktop: false })
    expect(suppressed.events).toHaveLength(1)
    expect(suppressed.shown).toEqual([])
  })

  test('a throwing notifier does not escape', () => {
    const t = setup({
      notifier: () => {
        throw new Error('boom')
      }
    })
    expect(() => sendNotification(t.deps, { title: 'T', body: 'B' })).not.toThrow()
  })
})

describe('notificationScript', () => {
  test('adds the default system sound only for file null', () => {
    expect(notificationScript('T', 'B')).toBe('display notification "B" with title "T"')
    expect(notificationScript('T', 'B', { file: null, volume: 50 })).toBe(
      'display notification "B" with title "T" sound name "default"'
    )
    expect(notificationScript('T', 'B', { file: '/tmp/x.aiff', volume: 50 })).toBe(
      'display notification "B" with title "T"'
    )
  })
})

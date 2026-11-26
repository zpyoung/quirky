import { describe, expect, it, vi } from 'vitest'
import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'
import { PublicEventBus } from '../public-events/public-event-bus'
import {
  ACTIVITY_RECORDED_CHANNEL,
  ACTIVITY_TRAIL_MAX_ENTRIES,
  ActivityTrailStore,
  type ActivityEntry,
  type ActivityWindow
} from './activity-trail-store'

const AGENT: AttributedCaller = { kind: 'agent-session', label: 'Agent abc12345' }

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    caller: AGENT,
    method: 'events.unsubscribe',
    summary: 'did a thing',
    at: 1,
    ...overrides
  }
}

function fakeWindow(overrides: Partial<ActivityWindow> = {}) {
  const send = vi.fn()
  const window: ActivityWindow = {
    isDestroyed: () => false,
    webContents: { send },
    ...overrides
  }
  return { window, send }
}

function createStore(window: ActivityWindow | null = null) {
  const bus = new PublicEventBus()
  const store = new ActivityTrailStore({ bus, getWindow: () => window })
  return { bus, store }
}

describe('ActivityTrailStore', () => {
  it('keeps the newest 1000 entries and drops the oldest', () => {
    const { store } = createStore()
    for (let index = 1; index <= ACTIVITY_TRAIL_MAX_ENTRIES + 1; index += 1) {
      store.record(entry({ at: index, summary: `call ${index}` }))
    }

    const entries = store.list()

    expect(entries).toHaveLength(ACTIVITY_TRAIL_MAX_ENTRIES)
    expect(entries[0].summary).toBe(`call ${ACTIVITY_TRAIL_MAX_ENTRIES + 1}`)
    expect(entries.at(-1)?.summary).toBe('call 2')
  })

  it('publishes activity.recorded with the caller and call details', () => {
    const { bus, store } = createStore()

    store.record(entry({ method: 'chat.send', summary: 'sent a message', workspaceId: 'wt-1' }))

    expect(bus.since(0, ['activity'])).toMatchObject([
      {
        seq: 1,
        topic: 'activity',
        type: 'activity.recorded',
        caller: AGENT,
        data: { method: 'chat.send', summary: 'sent a message', worktreeId: 'wt-1' }
      }
    ])
  })

  it('leaves worktreeId out of the event when the call had no workspace', () => {
    const { bus, store } = createStore()

    store.record(entry())

    expect(bus.since(0, ['activity'])).toMatchObject([
      { data: { method: 'events.unsubscribe', summary: 'did a thing' } }
    ])
    expect(JSON.stringify(bus.since(0, ['activity']))).not.toContain('worktreeId')
  })

  it('pushes the entry to the authoritative window', () => {
    const { window, send } = fakeWindow()
    const { store } = createStore(window)
    const recorded = entry({ workspaceId: 'wt-1' })

    store.record(recorded)

    expect(send).toHaveBeenCalledWith(ACTIVITY_RECORDED_CHANNEL, recorded)
  })

  it('sends nothing when no window exists, but still records and publishes', () => {
    const { bus, store } = createStore(null)

    store.record(entry())

    expect(store.list()).toHaveLength(1)
    expect(bus.latestSeq()).toBe(1)
  })

  it('does not send to a destroyed window', () => {
    const { window, send } = fakeWindow({ isDestroyed: () => true })
    const { store } = createStore(window)

    store.record(entry())

    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the entry when the window rejects the send', () => {
    const { window } = fakeWindow({
      webContents: {
        send: () => {
          throw new Error('Render frame was disposed')
        }
      }
    })
    const { store } = createStore(window)

    expect(() => store.record(entry())).not.toThrow()
    expect(store.list()).toHaveLength(1)
  })

  it('lists newest first, filtered by workspace and capped by limit', () => {
    const { store } = createStore()
    store.record(entry({ summary: 'one', workspaceId: 'wt-1' }))
    store.record(entry({ summary: 'two', workspaceId: 'wt-2' }))
    store.record(entry({ summary: 'three', workspaceId: 'wt-1' }))

    expect(store.list({ worktreeId: 'wt-1' }).map((item) => item.summary)).toEqual(['three', 'one'])
    expect(store.list({ limit: 2 }).map((item) => item.summary)).toEqual(['three', 'two'])
    expect(store.list({ worktreeId: 'wt-3' })).toEqual([])
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  createAskAttachedSurfaceRoster,
  trackAskSurfacePaneSubscription,
  untrackAskSurfacePaneSubscription,
  type AskAttachedSurfaceRosterHost,
  type AskPaneLivenessSink
} from './ask-attached-surface-roster'
import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'

function roster(hasLocalRendererWindow = false) {
  const host: AskAttachedSurfaceRosterHost = {
    hasLocalRendererWindow: () => hasLocalRendererWindow
  }
  return createAskAttachedSurfaceRoster(host)
}

function rosterWithLivenessSink(hasLocalRendererWindow = false) {
  const host: AskAttachedSurfaceRosterHost = {
    hasLocalRendererWindow: () => hasLocalRendererWindow
  }
  const sink: AskPaneLivenessSink = { notePaneDetached: vi.fn(), notePaneAttached: vi.fn() }
  return { roster: createAskAttachedSurfaceRoster(host, sink), sink }
}

describe('AskAttachedSurfaceRoster', () => {
  it('gains an entry on subscribe and loses it on detach', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('keeps ownership alive across an overlapping second subscription until both detach', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    r.trackPaneSubscription('conn-1', 'pane:1')

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('leaves no phantom owner once a dropped connection is forgotten', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    // A dropped socket never sends an unsubscribe frame — forgetConnection is the sweep.
    r.forgetConnection('conn-1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('does not satisfy the predicate for a different pane the same connection does not own', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:a')

    expect(r.hasCapableOwner('pane:a')).toBe(true)
    expect(r.hasCapableOwner('pane:b')).toBe(false)
  })

  it('does not satisfy the predicate when the owning connection never advertised the ask capability', () => {
    const r = roster()
    r.trackPaneSubscription('conn-1', 'pane:1')

    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('is satisfied by the local desktop renderer window for any pane, with no roster entry', () => {
    const r = roster(true)
    expect(r.hasCapableOwner('pane:never-subscribed')).toBe(true)
  })
})

describe('AskAttachedSurfaceRoster — liveness sink', () => {
  it('reports a detach when the only capable owner unsubscribes, and an attach on reattach', () => {
    const { roster: r, sink } = rosterWithLivenessSink()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    // Gaining the pane's first owner is itself a false->true transition worth reporting;
    // AskRegistry.notePaneAttached is a no-op when no grace timer is running.
    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(sink.notePaneAttached).toHaveBeenCalledExactlyOnceWith('pane:1')

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(sink.notePaneDetached).toHaveBeenCalledExactlyOnceWith('pane:1')

    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(sink.notePaneAttached).toHaveBeenCalledTimes(2)
  })

  it('reports a detach when a dropped connection was the last capable owner', () => {
    const { roster: r, sink } = rosterWithLivenessSink()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')

    r.forgetConnection('conn-1')
    expect(sink.notePaneDetached).toHaveBeenCalledExactlyOnceWith('pane:1')
  })

  it('does not report a detach while a second capable owner still holds the pane', () => {
    const { roster: r, sink } = rosterWithLivenessSink()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.recordConnectionCapabilities('conn-2', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    r.trackPaneSubscription('conn-2', 'pane:1')

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(sink.notePaneDetached).not.toHaveBeenCalled()
  })

  it('reports a detach when the owning connection loses the ask capability', () => {
    const { roster: r, sink } = rosterWithLivenessSink()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')

    r.recordConnectionCapabilities('conn-1', [])
    expect(sink.notePaneDetached).toHaveBeenCalledExactlyOnceWith('pane:1')
  })

  it('is a no-op when no liveness sink was given', () => {
    const r = roster()
    expect(() => {
      r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
      r.trackPaneSubscription('conn-1', 'pane:1')
      r.untrackPaneSubscription('conn-1', 'pane:1')
      r.forgetConnection('conn-1')
    }).not.toThrow()
  })
})

describe('trackAskSurfacePaneSubscription / untrackAskSurfacePaneSubscription', () => {
  function fakeRuntime(paneKeyByHandle: Record<string, string | null>) {
    const askRoster = createAskAttachedSurfaceRoster({ hasLocalRendererWindow: () => false })
    return {
      getTerminalPaneKey: vi.fn((handle: string) => paneKeyByHandle[handle] ?? null),
      getAskServices: () => ({ roster: askRoster }),
      askRoster
    }
  }

  it('resolves the handle to a pane key and tracks/untracks it', () => {
    const runtime = fakeRuntime({ 'term-1': 'pane:1' })
    runtime.askRoster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])

    trackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(true)

    untrackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(false)
  })

  it('is a no-op when the handle resolves to no pane key', () => {
    const runtime = fakeRuntime({ 'term-1': null })
    expect(() => trackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')).not.toThrow()
    expect(() => untrackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')).not.toThrow()
  })

  it('F6: untracks by the pane key recorded at subscribe time, even once the terminal no longer resolves', () => {
    const runtime = fakeRuntime({ 'term-1': 'pane:1' })
    runtime.askRoster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])

    trackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(true)

    // The terminal is torn down before cleanup runs, so it no longer resolves to a pane.
    runtime.getTerminalPaneKey.mockReturnValue(null)
    untrackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(false)
  })
})

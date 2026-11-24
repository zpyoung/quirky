import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { askServicesFor } from './ask-services'
import { ASK_LIVENESS_GRACE_MS } from './ask-registry'
import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'

describe('askServicesFor', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quirky-ask-services-'))
    // Why: the shared vitest userData would let register()'s requestId idempotency reach across tests.
    installFakeAppEnvironment({ getPath: () => root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('opens the ask db on the first db or registry read, not on construction, then memoizes it', () => {
    const runtimeKey = { getRuntimeId: () => 'runtime-under-test' }
    const dbPath = join(root, 'asks.db')

    const services = askServicesFor(runtimeKey, () => false)
    // connection bookkeeping is what every authenticated client drives; it must not need the store
    services.roster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    services.roster.trackPaneSubscription('conn-1', 'pane:1')
    services.roster.forgetConnection('conn-1')
    expect(existsSync(dbPath)).toBe(false)

    expect(services.registry).toBeDefined()
    expect(existsSync(dbPath)).toBe(true)
    expect(askServicesFor(runtimeKey, () => false)).toBe(services)
    expect(askServicesFor(runtimeKey, () => false).db).toBe(services.db)
  })

  it('builds the registry over the same db and keeps both stable across calls', async () => {
    const runtimeKey = { getRuntimeId: () => 'runtime-under-test' }

    const { db, registry } = askServicesFor(runtimeKey, () => false)
    const second = askServicesFor(runtimeKey, () => false)
    expect(second.db).toBe(db)
    expect(second.registry).toBe(registry)

    const { askId } = await registry.register(
      { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
      { paneKey: 'pane:1', worktreeId: null },
      { requestId: 'req_1' }
    )
    expect(db.getAsk(askId)).toBeTruthy()
  })

  it('keeps separate service bundles for separate runtime keys', () => {
    const services1 = askServicesFor({ getRuntimeId: () => 'runtime-under-test' }, () => false)
    const services2 = askServicesFor({ getRuntimeId: () => 'runtime-under-test' }, () => false)
    expect(services1).not.toBe(services2)
    expect(services1.db).not.toBe(services2.db)
  })

  it('wires the roster to the hasLocalRendererWindow callback given at first construction', () => {
    const runtimeKey = { getRuntimeId: () => 'runtime-under-test' }
    const { roster } = askServicesFor(runtimeKey, () => true)
    expect(roster.hasCapableOwner('pane:never-subscribed')).toBe(true)
  })

  describe('liveness wiring', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('resolves unavailable once the roster reports the last capable owner detached and the grace window elapses', async () => {
      vi.useFakeTimers()
      const { registry, roster, db } = askServicesFor(
        { getRuntimeId: () => 'runtime-under-test' },
        () => false
      )
      roster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
      roster.trackPaneSubscription('conn-1', 'pane:1')

      const { askId } = await registry.register(
        { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
        { paneKey: 'pane:1', worktreeId: null },
        { requestId: 'req_1' }
      )

      // Driven through the roster's own subscription bookkeeping, not by calling
      // registry.notePaneDetached directly.
      roster.untrackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS)

      expect(db.getAsk(askId)?.status).toBe('unavailable')
    })

    it('cancels the grace timer when the roster reports the pane reattached inside the window', async () => {
      vi.useFakeTimers()
      const { registry, roster, db } = askServicesFor(
        { getRuntimeId: () => 'runtime-under-test' },
        () => false
      )
      roster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
      roster.trackPaneSubscription('conn-1', 'pane:1')

      const { askId } = await registry.register(
        { questions: [{ id: 'q1', type: 'text', question: 'Q1?' }] },
        { paneKey: 'pane:1', worktreeId: null },
        { requestId: 'req_1' }
      )

      roster.untrackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS - 1_000)
      roster.trackPaneSubscription('conn-1', 'pane:1')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(db.getAsk(askId)?.status).toBe('registered')
    })
  })
})

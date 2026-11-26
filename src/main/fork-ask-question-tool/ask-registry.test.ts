import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskDb } from './ask-db'
import { ASK_LIVENESS_GRACE_MS, AskRegistry, type AskOrigin } from './ask-registry'
import type { AskSpec } from '../../shared/fork-ask-question-tool/ask-question-schema'

function textSpec(question = 'Q1?', withDefault?: string): AskSpec {
  return { questions: [{ id: 'q1', type: 'text', question, default: withDefault }] }
}

function paneOrigin(paneKey: string): AskOrigin {
  return { paneKey, worktreeId: null }
}

describe('AskRegistry', () => {
  let db: AskDb

  beforeEach(() => {
    db = new AskDb(':memory:')
  })

  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('durably inserts before returning the id', async () => {
    const registry = new AskRegistry(db)
    const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
      requestId: 'req_1'
    })
    expect(db.getAsk(askId)).toBeTruthy()
  })

  describe('getEpoch', () => {
    it('is stable across calls on one instance and differs across two instances', () => {
      const registry = new AskRegistry(db)
      expect(registry.getEpoch()).toBe(registry.getEpoch())

      const otherDb = new AskDb(':memory:')
      try {
        const other = new AskRegistry(otherDb)
        expect(other.getEpoch()).not.toBe(registry.getEpoch())
      } finally {
        otherDb.close()
      }
    })
  })

  describe('register idempotency', () => {
    it('returns the existing askId on a requestId replay, emitting no second registered event', async () => {
      const registry = new AskRegistry(db)
      const events: string[] = []
      registry.onAskChanged((event) => events.push(event.status))

      const spec = textSpec()
      const first = await registry.register(spec, paneOrigin('pane:1'), { requestId: 'req_1' })
      const second = await registry.register(spec, paneOrigin('pane:1'), { requestId: 'req_1' })

      expect(second.askId).toBe(first.askId)
      expect(events).toEqual(['registered'])
    })

    it('throws when a requestId replay carries a different spec', async () => {
      const registry = new AskRegistry(db)
      await registry.register(textSpec('Original?'), paneOrigin('pane:1'), { requestId: 'req_1' })
      await expect(
        registry.register(textSpec('Different?'), paneOrigin('pane:1'), { requestId: 'req_1' })
      ).rejects.toThrow()
    })
  })

  describe('per-pane FIFO', () => {
    it('surfaces only the head, promoting the next ask once the head resolves', async () => {
      const registry = new AskRegistry(db)
      const events: { askId: string; status: string }[] = []
      registry.onAskChanged((event) => events.push({ askId: event.askId, status: event.status }))

      const first = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      const second = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2'
      })
      expect(events).toEqual([{ askId: first.askId, status: 'registered' }])

      registry.cancel(first.askId, 'user')

      expect(events).toEqual([
        { askId: first.askId, status: 'registered' },
        { askId: first.askId, status: 'declined' },
        { askId: second.askId, status: 'registered' }
      ])
    })

    it('lets asks on different panes surface independently', async () => {
      const registry = new AskRegistry(db)
      const events: string[] = []
      registry.onAskChanged((event) => events.push(event.askId))
      const a = await registry.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_1' })
      const b = await registry.register(textSpec(), paneOrigin('pane:2'), { requestId: 'req_2' })
      expect(events).toEqual([a.askId, b.askId])
    })
  })

  describe('waitChunk', () => {
    it('resolves immediately and repeatably for an already-terminal ask', async () => {
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      registry.answer(askId, { q1: { value: 'hi', source: 'input' } }, [])

      const signal = new AbortController().signal
      const first = await registry.waitChunk(askId, 1_000, signal)
      const second = await registry.waitChunk(askId, 1_000, signal)
      expect(first).toEqual(second)
      expect(first.status).toBe('answered')
    })

    it('returns unavailable for an unknown askId without throwing', async () => {
      const registry = new AskRegistry(db)
      const envelope = await registry.waitChunk('ask_missing', 1_000, new AbortController().signal)
      expect(envelope.status).toBe('unavailable')
    })

    it('resolves with a pending envelope once chunkMs elapses unanswered', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      const promise = registry.waitChunk(askId, 5_000, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await promise).toEqual({
        status: 'pending',
        askId,
        instruction: `quirky ask wait --id ${askId}`
      })
    })

    it('never resolves the ask on a mid-chunk transport abort, and a later waitChunk resumes it', async () => {
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      const controller = new AbortController()
      const aborted = registry.waitChunk(askId, 60_000, controller.signal)
      controller.abort()
      const envelope = await aborted

      expect(envelope.status).toBe('pending')
      expect(db.getAsk(askId)?.status).toBe('registered')

      expect(registry.answer(askId, { q1: { value: 'hi', source: 'input' } }, []).committed).toBe(
        true
      )
      const resumed = await registry.waitChunk(askId, 1_000, new AbortController().signal)
      expect(resumed.status).toBe('answered')
    })
  })

  describe('answer / cancel', () => {
    it('enforces exactly one terminal transition; a later commit is a no-op', async () => {
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })

      const firstAnswer = registry.answer(askId, { q1: { value: 'hi', source: 'input' } }, [])
      const secondAnswer = registry.answer(askId, { q1: { value: 'bye', source: 'input' } }, [])
      const secondCancel = registry.cancel(askId, 'user')

      expect(firstAnswer.committed).toBe(true)
      expect(secondAnswer.committed).toBe(false)
      expect(secondCancel.committed).toBe(false)
      expect(db.getAsk(askId)?.status).toBe('answered')
    })

    it('emits "answered" only when nothing is skipped, and "partial" when anything is', async () => {
      const registry = new AskRegistry(db)
      const events: string[] = []
      registry.onAskChanged((event) => events.push(event.status))
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      registry.answer(askId, {}, ['q1'])
      expect(events).toEqual(['registered', 'partial'])
      expect(db.getAsk(askId)?.status).toBe('partial')
    })

    it('resolves cancel as "declined" with every question skipped', async () => {
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      expect(registry.cancel(askId, 'interrupt').committed).toBe(true)
      const row = db.getAsk(askId)
      expect(row?.status).toBe('declined')
      expect(JSON.parse(row?.answers_json as string)).toEqual({
        answers: {},
        skipped: ['q1'],
        summary: ''
      })
    })

    it('returns committed:false for an unknown askId rather than throwing', () => {
      const registry = new AskRegistry(db)
      expect(registry.answer('ask_missing', {}, []).committed).toBe(false)
      expect(registry.cancel('ask_missing', 'user').committed).toBe(false)
    })
  })

  describe('updatePartial', () => {
    it('persists and emits only the known question ids', async () => {
      const registry = new AskRegistry(db)
      const events: (Record<string, unknown> | undefined)[] = []
      registry.onAskChanged((event) => events.push(event.partial))
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })

      registry.updatePartial(askId, {
        q1: { draft: 'partial answer' },
        bogus: { draft: 'dropped' }
      })

      expect(events).toEqual([undefined, { q1: { draft: 'partial answer' } }])
      expect(JSON.parse(db.getAsk(askId)?.partial_json as string)).toEqual({
        q1: { draft: 'partial answer' }
      })
    })

    it('is a no-op for an unknown askId', () => {
      const registry = new AskRegistry(db)
      expect(() => registry.updatePartial('ask_missing', {})).not.toThrow()
    })
  })

  describe('programmer errors', () => {
    it('throws for a structurally invalid askId rather than returning a domain envelope', async () => {
      const registry = new AskRegistry(db)
      expect(() => registry.answer('', {}, [])).toThrow()
      expect(() => registry.cancel('', 'user')).toThrow()
      await expect(registry.waitChunk('', 1_000, new AbortController().signal)).rejects.toThrow()
    })
  })

  describe('timeout expiry', () => {
    it('resolves timed_out at the registered timeout, applying declared defaults', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec('Q1?', 'fallback'), paneOrigin('pane:1'), {
        requestId: 'req_1',
        timeoutMs: 10_000
      })
      const promise = registry.waitChunk(askId, 60_000, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10_000)
      const envelope = await promise
      expect(envelope.status).toBe('timed_out')
      if (envelope.status === 'timed_out') {
        expect(envelope.answers.q1).toEqual({ value: 'fallback', source: 'default' })
      }
    })

    it('expires a queued, never-surfaced ask on its own schedule without ever surfacing it', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const events: { askId: string; status: string }[] = []
      registry.onAskChanged((event) => events.push({ askId: event.askId, status: event.status }))

      const head = await registry.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_1' })
      const queued = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2',
        timeoutMs: 5_000
      })

      await vi.advanceTimersByTimeAsync(5_000)

      expect(db.getAsk(queued.askId)?.status).toBe('timed_out')
      expect(db.getAsk(head.askId)?.status).toBe('registered')
      expect(events).not.toContainEqual({ askId: queued.askId, status: 'registered' })
      expect(events).toContainEqual({ askId: queued.askId, status: 'timed_out' })
    })

    it('resumes the original wall-clock deadline after a restart rather than restarting the countdown', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

      db.registerAsk(
        {
          askId: 'ask_1',
          requestId: 'req_1',
          paneKey: null,
          worktreeId: null,
          origin: 'cli',
          specJson: JSON.stringify(textSpec()),
          timeoutMs: 60_000,
          handoff: null
        },
        new Date().toISOString()
      )

      // simulate downtime with no registry instance running at all before the "restart"
      await vi.advanceTimersByTimeAsync(30_000)

      const registry = new AskRegistry(db)
      let resolved = false
      registry.waitChunk('ask_1', 120_000, new AbortController().signal).then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)

      // 30s (already elapsed) + 31s > the original 60s deadline, but well short of a fresh
      // 60s counted from this instance's construction (which would land at 90s)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(resolved).toBe(true)
      expect(db.getAsk('ask_1')?.status).toBe('timed_out')
    })
  })

  describe('liveness expiry', () => {
    it('cancels the grace timer on a reconnect inside the window', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })

      registry.notePaneDetached('pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS - 1_000)
      registry.notePaneAttached('pane:1')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(db.getAsk(askId)?.status).toBe('registered')
    })

    it('resolves unavailable once the grace window elapses without a reconnect', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })

      const promise = registry.waitChunk(
        askId,
        ASK_LIVENESS_GRACE_MS + 60_000,
        new AbortController().signal
      )
      registry.notePaneDetached('pane:1')
      await vi.advanceTimersByTimeAsync(ASK_LIVENESS_GRACE_MS)

      const envelope = await promise
      expect(envelope.status).toBe('unavailable')
    })
  })

  describe('handoff origin', () => {
    it('persists the handoff identity on the durable row', async () => {
      const registry = new AskRegistry(db)
      const origin: AskOrigin = {
        paneKey: null,
        worktreeId: null,
        handoff: { runId: 'run_1', dispatchId: 'dispatch_1', askerHandle: 'asker_1' }
      }
      const { askId } = await registry.register(textSpec(), origin, { requestId: 'req_1' })
      const row = db.getAsk(askId)
      expect(row?.origin).toBe('handoff')
      expect(row?.handoff_run_id).toBe('run_1')
      expect(row?.handoff_dispatch_id).toBe('dispatch_1')
      expect(row?.handoff_asker).toBe('asker_1')
      expect(row?.handoff_question_id).toBeNull()
    })
  })
  describe('queue promotion and restart', () => {
    it('emits the promoted ask with a seq newer than the head resolution', async () => {
      const registry = new AskRegistry(db)
      const events: { askId: string; status: string; seq: number }[] = []
      registry.onAskChanged((event) =>
        events.push({ askId: event.askId, status: event.status, seq: event.seq })
      )
      const first = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      const second = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2'
      })

      registry.cancel(first.askId, 'user')

      const declined = events.find((event) => event.status === 'declined')
      const promoted = events.find((event) => event.askId === second.askId)
      expect(promoted?.seq).toBeGreaterThan(declined?.seq ?? Infinity)
    })

    it('rebuilds the pane queue in registration order on construction', async () => {
      const original = new AskRegistry(db)
      const first = await original.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1'
      })
      const second = await original.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2'
      })
      original.updatePartial(first.askId, { q1: { draft: 'typing' } })
      original.updatePartial(second.askId, { q1: { draft: 'typing' } })

      const restarted = new AskRegistry(db)
      const events: string[] = []
      restarted.onAskChanged((event) => events.push(`${event.askId}:${event.status}`))
      restarted.cancel(first.askId, 'user')

      expect(events).toEqual([`${first.askId}:declined`, `${second.askId}:registered`])
    })

    it('replaces an untouched restored ask when a new ask registers on the same pane', async () => {
      const original = new AskRegistry(db)
      const old = await original.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_1' })

      const restarted = new AskRegistry(db)
      const fresh = await restarted.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2'
      })

      expect(db.getAsk(old.askId)?.status).toBe('unavailable')
      expect(db.getAsk(fresh.askId)?.status).toBe('registered')
      const events: string[] = []
      restarted.onAskChanged((event) => events.push(`${event.askId}:${event.status}`))
      restarted.cancel(fresh.askId, 'user')
      expect(events).toEqual([`${fresh.askId}:declined`])
    })

    it('keeps a restored ask that has had a waiter', async () => {
      const original = new AskRegistry(db)
      const old = await original.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_1' })

      const restarted = new AskRegistry(db)
      await restarted.waitChunk(old.askId, 0, new AbortController().signal)
      await restarted.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_2' })

      expect(db.getAsk(old.askId)?.status).toBe('registered')
    })

    it('resolves an expired pending ask on construction without any waiter', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      db.registerAsk(
        {
          askId: 'ask_old',
          requestId: 'req_old',
          paneKey: null,
          worktreeId: null,
          origin: 'cli',
          specJson: JSON.stringify(textSpec()),
          timeoutMs: 1_000,
          handoff: null
        },
        new Date().toISOString()
      )
      await vi.advanceTimersByTimeAsync(5_000)

      new AskRegistry(db)
      await vi.advanceTimersByTimeAsync(0)

      expect(db.getAsk('ask_old')?.status).toBe('timed_out')
    })
  })

  describe('long timeouts', () => {
    it('never fires early for a timeout beyond the 32-bit timer limit', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1',
        timeoutMs: thirtyDaysMs
      })

      await vi.advanceTimersByTimeAsync(thirtyDaysMs - 1_000)
      expect(db.getAsk(askId)?.status).toBe('registered')

      await vi.advanceTimersByTimeAsync(1_000)
      expect(db.getAsk(askId)?.status).toBe('timed_out')
    })

    it('still resolves timed_out when a stored draft has an unexpected shape', async () => {
      vi.useFakeTimers()
      const registry = new AskRegistry(db)
      const { askId } = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_1',
        timeoutMs: 3_000
      })
      db.updatePartial(askId, JSON.stringify({ q1: { draft: 5 } }))

      await vi.advanceTimersByTimeAsync(3_000)

      expect(db.getAsk(askId)?.status).toBe('timed_out')
      expect((await registry.waitChunk(askId, 0, new AbortController().signal)).status).toBe(
        'timed_out'
      )
    })
  })

  describe('pane teardown', () => {
    it('resolves every pending ask of a closed pane as unavailable', async () => {
      const registry = new AskRegistry(db)
      const head = await registry.register(textSpec(), paneOrigin('pane:1'), { requestId: 'req_1' })
      const queued = await registry.register(textSpec(), paneOrigin('pane:1'), {
        requestId: 'req_2'
      })
      const other = await registry.register(textSpec(), paneOrigin('pane:2'), {
        requestId: 'req_3'
      })

      const events: string[] = []
      registry.onAskChanged((event) => events.push(`${event.askId}:${event.status}`))

      registry.resolvePaneClosed('pane:1')

      // the queued ask must not flash up as the new head before it too resolves
      expect(events).not.toContain(`${queued.askId}:registered`)
      for (const askId of [head.askId, queued.askId]) {
        const envelope = await registry.waitChunk(askId, 0, new AbortController().signal)
        expect(envelope).toMatchObject({
          status: 'unavailable',
          reason: 'the pane that asked was closed'
        })
      }
      expect(db.getAsk(other.askId)?.status).toBe('registered')
    })
  })
})

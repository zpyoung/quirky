import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskEnvelope } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { createAskRpcHarness, type AskRpcHarness } from './ask-rpc-test-harness'

const PANE_KEY = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_PANE_KEY = 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ASK_SURFACE_CAPABILITY = 'ask.surface.v1'

function textSpec() {
  return { questions: [{ id: 'q1', type: 'text', question: 'What is your name?' }] }
}

async function registerOnCapablePane(h: AskRpcHarness, requestId = 'req_1') {
  h.setPaneOwner(PANE_KEY, 'term_1')
  h.hasLocalRendererWindow.value = true
  return h.call('ask.register', {
    spec: textSpec(),
    requestId,
    paneKey: PANE_KEY,
    cwd: '/repo'
  }) as Promise<{
    askId: string
  }>
}

describe('ask.* RPC methods', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  describe('register/wait/answer/cancel round-trips', () => {
    it('registers, waits, and answers; the blocked wait resolves with the answer', async () => {
      const { askId } = await registerOnCapablePane(h)
      expect(askId).toBeTruthy()

      const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
      const answerResult = await h.call('ask.answer', {
        askId,
        answers: { q1: { value: 'Ada', source: 'input' } },
        skipped: []
      })
      expect(answerResult).toEqual({ committed: true })

      const envelope = (await waitPromise) as AskEnvelope
      expect(envelope).toMatchObject({
        status: 'answered',
        askId,
        answers: { q1: { value: 'Ada', source: 'input' } }
      })
    })

    it('cancel resolves the ask declined and a later wait sees the same envelope', async () => {
      const { askId } = await registerOnCapablePane(h)
      const cancelled = (await h.call('ask.cancel', { askId })) as AskEnvelope
      expect(cancelled).toMatchObject({ status: 'declined', askId })

      const resumed = (await h.call('ask.wait', { askId, chunkMs: 1000 })) as AskEnvelope
      expect(resumed).toMatchObject({ status: 'declined', askId })
    })

    it('registers idempotently on requestId: a retried register returns the original askId', async () => {
      const first = await registerOnCapablePane(h, 'req_dup')
      const second = await registerOnCapablePane(h, 'req_dup')
      expect(second.askId).toBe(first.askId)
    })

    it('updatePartial persists the draft and a later snapshot reflects it', async () => {
      const { askId } = await registerOnCapablePane(h)
      const result = await h.call('ask.updatePartial', { askId, partial: { q1: { draft: 'Ad' } } })
      expect(result).toEqual({ ok: true })
      expect(h.askDb.getAsk(askId)?.partial_json).toContain('"draft":"Ad"')
    })
  })

  describe('wait concurrency gate', () => {
    it('answers a wait on an already-resolved ask even while every gate slot is parked', async () => {
      const pending = await Promise.all(
        [1, 2, 3, 4].map((n) => registerOnCapablePane(h, `req_parked_${n}`))
      )
      const resolved = await registerOnCapablePane(h, 'req_resolved')
      await h.call('ask.cancel', { askId: resolved.askId })
      const controller = new AbortController()
      const parked = pending.map(({ askId }) =>
        h.call('ask.wait', { askId, chunkMs: 60_000 }, { signal: controller.signal })
      )

      const envelope = await h.call('ask.wait', { askId: resolved.askId, chunkMs: 1000 })

      expect(envelope).toMatchObject({ status: 'declined', askId: resolved.askId })
      controller.abort()
      await Promise.all(parked)
    })
  })

  describe('abort-signal release', () => {
    it('a mid-chunk abort resolves pending without touching the ask, so a later wait resumes it', async () => {
      const { askId } = await registerOnCapablePane(h)
      const controller = new AbortController()

      const abortedWait = h.call(
        'ask.wait',
        { askId, chunkMs: 60_000 },
        { signal: controller.signal }
      )
      controller.abort()
      const pending = (await abortedWait) as AskEnvelope
      expect(pending).toMatchObject({ status: 'pending', askId })
      expect(h.askDb.getAsk(askId)?.status).toBe('registered')

      const resumedWait = h.call('ask.wait', { askId, chunkMs: 5000 })
      await h.call('ask.answer', {
        askId,
        answers: { q1: { value: 'Ada', source: 'input' } },
        skipped: []
      })
      const answered = (await resumedWait) as AskEnvelope
      expect(answered.status).toBe('answered')
    })
  })

  describe('capability-roster gating (C4)', () => {
    it('a capable roster connection owning the resolved pane registers as a normal ask', async () => {
      h.setPaneOwner(PANE_KEY, 'term_1')
      h.roster.recordConnectionCapabilities('conn_1', [ASK_SURFACE_CAPABILITY])
      h.roster.trackPaneSubscription('conn_1', PANE_KEY)

      const result = (await h.call('ask.register', {
        spec: textSpec(),
        requestId: 'req_cap_1',
        paneKey: PANE_KEY,
        cwd: '/repo'
      })) as { askId?: string }
      expect(result.askId).toBeTruthy()
      expect(h.askDb.getAsk(result.askId as string)?.origin).toBe('cli')
    })

    it('a capable connection owning only another pane routes to the no-UI path', async () => {
      h.setPaneOwner(PANE_KEY, 'term_1')
      h.roster.recordConnectionCapabilities('conn_1', [ASK_SURFACE_CAPABILITY])
      h.roster.trackPaneSubscription('conn_1', OTHER_PANE_KEY)

      const result = (await h.call('ask.register', {
        spec: textSpec(),
        requestId: 'req_cap_2',
        paneKey: PANE_KEY,
        cwd: '/repo'
      })) as { status?: string; askId?: string }
      // No active orchestration run exists in this fixture, so the no-UI path resolves immediately.
      expect(result.status).toBe('unavailable')
      expect(result.askId).toBeUndefined()
    })

    it('a roster entry removed on disconnect no longer counts as a capable owner', async () => {
      h.setPaneOwner(PANE_KEY, 'term_1')
      h.roster.recordConnectionCapabilities('conn_1', [ASK_SURFACE_CAPABILITY])
      h.roster.trackPaneSubscription('conn_1', PANE_KEY)
      h.roster.forgetConnection('conn_1')

      const result = (await h.call('ask.register', {
        spec: textSpec(),
        requestId: 'req_cap_3',
        paneKey: PANE_KEY,
        cwd: '/repo'
      })) as { status?: string }
      expect(result.status).toBe('unavailable')
    })

    it('the local desktop renderer window is implicitly capable of every local pane', async () => {
      const { askId } = await registerOnCapablePane(h)
      expect(h.askDb.getAsk(askId)?.origin).toBe('cli')
    })
  })

  describe('answer validation (C4)', () => {
    it('rejects the whole submission on a domain violation and commits nothing', async () => {
      const { askId } = await registerOnCapablePane(h)
      await expect(
        h.call('ask.answer', {
          askId,
          answers: { q1: { value: 123, source: 'input' } },
          skipped: []
        })
      ).rejects.toThrow()
      expect(h.askDb.getAsk(askId)?.status).toBe('registered')
    })

    it('rejects an answer naming an unknown question id', async () => {
      const { askId } = await registerOnCapablePane(h)
      await expect(
        h.call('ask.answer', {
          askId,
          answers: { nope: { value: 'x', source: 'input' } },
          skipped: ['q1']
        })
      ).rejects.toThrow(/nope/)
    })
  })

  describe('double-answer race', () => {
    it('the first commit wins; a second concurrent answer returns committed: false exactly once', async () => {
      const { askId } = await registerOnCapablePane(h)
      const [first, second] = await Promise.all([
        h.call('ask.answer', {
          askId,
          answers: { q1: { value: 'first', source: 'input' } },
          skipped: []
        }),
        h.call('ask.answer', {
          askId,
          answers: { q1: { value: 'second', source: 'input' } },
          skipped: []
        })
      ])
      const results = [first, second] as { committed: boolean }[]
      const wins = results.filter((result) => result.committed)
      expect(wins).toHaveLength(1)
      expect(results.filter((result) => !result.committed)).toHaveLength(1)
    })
  })
})

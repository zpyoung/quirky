import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskStreamFrame } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import { createAskRpcHarness, type AskRpcHarness } from './ask-rpc-test-harness'

const PANE_KEY = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

function framesOfType<T extends AskStreamFrame['type']>(
  frames: unknown[],
  type: T
): Extract<AskStreamFrame, { type: T }>[] {
  return (frames as AskStreamFrame[]).filter(
    (frame): frame is Extract<AskStreamFrame, { type: T }> => frame.type === type
  )
}

describe('ask.snapshot / ask.subscribe (C4)', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness

  beforeEach(() => {
    h = harness.setup()
  })
  afterEach(() => harness.cleanup())

  it('a fresh subscribe emits one snapshot frame per pending ask, then a watermark, then live events', async () => {
    const { askId } = await registerOnCapablePane(h)
    const sub = h.subscribe('ask.subscribe', {})

    const snapshots = framesOfType(sub.frames, 'snapshot')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].event.askId).toBe(askId)
    expect(framesOfType(sub.frames, 'watermark')).toHaveLength(1)
    expect(framesOfType(sub.frames, 'event')).toHaveLength(0)

    await h.call('ask.answer', {
      askId,
      answers: { q1: { value: 'Ada', source: 'input' } },
      skipped: []
    })
    const events = framesOfType(sub.frames, 'event')
    expect(events).toHaveLength(1)
    expect(events[0].event).toMatchObject({ askId, status: 'answered' })

    await sub.stop()
  })

  it('a valid-watermark subscribe skips the snapshot and replays everything missed since it', async () => {
    const bootstrap = h.subscribe('ask.subscribe', {})
    const watermark = framesOfType(bootstrap.frames, 'watermark')[0]
    await bootstrap.stop()

    const { askId } = await registerOnCapablePane(h)

    const resumed = h.subscribe('ask.subscribe', {
      sinceSeq: watermark.seq,
      epoch: watermark.epoch
    })
    expect(framesOfType(resumed.frames, 'snapshot')).toHaveLength(0)
    expect(framesOfType(resumed.frames, 'watermark')).toHaveLength(0)
    const events = framesOfType(resumed.frames, 'event')
    expect(events).toHaveLength(1)
    expect(events[0].event.askId).toBe(askId)

    await resumed.stop()
  })

  it('a valid-watermark subscribe replays a terminal transition that happened while disconnected', async () => {
    const { askId } = await registerOnCapablePane(h)
    const bootstrap = h.subscribe('ask.subscribe', {})
    const watermark = framesOfType(bootstrap.frames, 'watermark')[0]
    await bootstrap.stop()

    // Why: this resolves with nobody subscribed — the exact gap listSinceSeq exists to close.
    await h.call('ask.answer', {
      askId,
      answers: { q1: { value: 'Ada', source: 'input' } },
      skipped: []
    })

    const resumed = h.subscribe('ask.subscribe', {
      sinceSeq: watermark.seq,
      epoch: watermark.epoch
    })
    const events = framesOfType(resumed.frames, 'event')
    expect(events).toHaveLength(1)
    expect(events[0].event).toMatchObject({ askId, status: 'answered' })

    await resumed.stop()
  })

  it('a stale epoch forces a fresh snapshot instead of a missed-events replay', async () => {
    const { askId } = await registerOnCapablePane(h)
    const sub = h.subscribe('ask.subscribe', { sinceSeq: 0, epoch: 'some-other-process-epoch' })
    expect(framesOfType(sub.frames, 'snapshot').map((frame) => frame.event.askId)).toEqual([askId])
    await sub.stop()
  })

  it('ask.snapshot returns the same pending events a fresh subscribe snapshots', async () => {
    await registerOnCapablePane(h)
    const snapshotResult = (await h.call('ask.snapshot', {})) as {
      asks: unknown[]
      seq: number
      epoch: string
    }

    const sub = h.subscribe('ask.subscribe', {})
    const subscribeSnapshotEvents = framesOfType(sub.frames, 'snapshot').map((frame) => frame.event)
    await sub.stop()

    expect(subscribeSnapshotEvents).toEqual(snapshotResult.asks)
  })

  it('the epoch ask.snapshot publishes equals the epoch on a live event from the same registry instance', async () => {
    const { askId } = await registerOnCapablePane(h)
    const snapshotResult = (await h.call('ask.snapshot', {})) as { epoch: string }

    const sub = h.subscribe('ask.subscribe', {})
    await h.call('ask.answer', {
      askId,
      answers: { q1: { value: 'Ada', source: 'input' } },
      skipped: []
    })
    const liveEvent = framesOfType(sub.frames, 'event')[0]
    await sub.stop()

    expect(liveEvent.event.epoch).toBe(snapshotResult.epoch)
    expect(snapshotResult.epoch).toBe(h.registry.getEpoch())
  })

  it('ask.snapshot honors the paneKey filter', async () => {
    await registerOnCapablePane(h)
    const filtered = (await h.call('ask.snapshot', {
      paneKey: 'tab_z:zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz'
    })) as {
      asks: unknown[]
    }
    expect(filtered.asks).toEqual([])
  })

  it('F1: the snapshot watermark is the store head, not just the highest seq among pending rows', async () => {
    const { askId: askA } = await registerOnCapablePane(h, 'req_a')
    const { askId: askB } = await registerOnCapablePane(h, 'req_b')
    // Resolving A bumps its seq past B's — the true head now belongs to a row listPending() excludes.
    await h.call('ask.answer', {
      askId: askA,
      answers: { q1: { value: 'Ada', source: 'input' } },
      skipped: []
    })

    const snapshotResult = (await h.call('ask.snapshot', {})) as { seq: number; epoch: string }
    expect(snapshotResult.seq).toBe(h.askDb.currentSeq())
    expect(snapshotResult.seq).toBeGreaterThan(h.askDb.getAsk(askB)?.seq as number)

    // A reconnect quoting that watermark already covers the resolved ask, so nothing replays.
    const resumed = h.subscribe('ask.subscribe', {
      sinceSeq: snapshotResult.seq,
      epoch: snapshotResult.epoch
    })
    expect(framesOfType(resumed.frames, 'event')).toHaveLength(0)
    await resumed.stop()
  })
})

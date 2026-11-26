import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AskRegistryEvent } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import {
  ASK_DISMISS_DELAY_MS,
  createAsksSlice,
  selectHeadAsk,
  selectPendingAskCount,
  type AsksSlice
} from './asks'

type SnapshotResult = { asks: AskRegistryEvent[]; seq: number; epoch: string }

function createSliceStore() {
  return create<AsksSlice>()((...a) => ({
    ...createAsksSlice(...(a as unknown as Parameters<typeof createAsksSlice>))
  }))
}

function makeEvent(overrides: Partial<AskRegistryEvent> = {}): AskRegistryEvent {
  return {
    seq: 1,
    epoch: 'epoch-a',
    askId: 'ask-1',
    paneKey: 'pane-a',
    status: 'registered',
    spec: { questions: [{ id: 'q1', question: 'Continue?', type: 'confirm' }] },
    partial: {},
    ...overrides
  }
}

function successResponse(result: SnapshotResult): RuntimeRpcResponse<SnapshotResult> {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function stubSnapshotApi(call: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { api: { runtime: { call } } })
  return call
}

function stubSnapshotResult(result: SnapshotResult) {
  return stubSnapshotApi(vi.fn().mockResolvedValue(successResponse(result)))
}

function stubDeferredSnapshot() {
  let resolve: (response: RuntimeRpcResponse<SnapshotResult>) => void = () => {}
  const promise = new Promise<RuntimeRpcResponse<SnapshotResult>>((r) => {
    resolve = r
  })
  const call = stubSnapshotApi(vi.fn().mockReturnValue(promise))
  return { call, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function hydratedStore(seq = 0) {
  stubSnapshotResult({ asks: [], seq, epoch: 'epoch-a' })
  const store = createSliceStore()
  await store.getState().hydrateAsks()
  return store
}

describe('asks slice', () => {
  it('starts unhydrated with no pending asks', () => {
    const store = createSliceStore()
    expect(store.getState().pendingAsksByPaneKey).toEqual({})
    expect(store.getState().askWatermark).toBeNull()
  })

  it('seeds pending asks, partials, and the watermark from ask.snapshot', async () => {
    const event = makeEvent({ partial: { q1: { confirm: true } } })
    stubSnapshotResult({ asks: [event], seq: 5, epoch: 'epoch-a' })
    const store = createSliceStore()

    await store.getState().hydrateAsks()

    expect(store.getState().pendingAsksByPaneKey['pane-a']).toEqual([
      {
        askId: 'ask-1',
        paneKey: 'pane-a',
        status: 'registered',
        spec: event.spec,
        partial: { q1: { confirm: true } },
        result: undefined
      }
    ])
    expect(store.getState().askWatermark).toEqual({ seq: 5, epoch: 'epoch-a' })
  })

  it('buffers events that arrive before hydration resolves, then applies them in order', async () => {
    const { resolve } = stubDeferredSnapshot()
    const store = createSliceStore()

    const hydration = store.getState().hydrateAsks()
    store.getState().applyAskRegistryEvent(makeEvent({ seq: 1, status: 'registered' }))
    store
      .getState()
      .applyAskRegistryEvent(
        makeEvent({ seq: 2, status: 'partial', partial: { q1: { confirm: false } } })
      )

    expect(store.getState().pendingAsksByPaneKey).toEqual({})

    resolve(successResponse({ asks: [], seq: 0, epoch: 'epoch-a' }))
    await hydration

    expect(store.getState().pendingAsksByPaneKey['pane-a']?.[0]).toMatchObject({
      askId: 'ask-1',
      status: 'partial',
      partial: { q1: { confirm: false } }
    })
    expect(store.getState().askWatermark).toEqual({ seq: 2, epoch: 'epoch-a' })
  })

  it('drops an event at or below the watermark', async () => {
    stubSnapshotResult({ asks: [], seq: 5, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ seq: 5, status: 'answered' }))

    expect(store.getState().pendingAsksByPaneKey).toEqual({})
    expect(store.getState().askWatermark).toEqual({ seq: 5, epoch: 'epoch-a' })
  })

  it('discards the slice and re-hydrates when an event carries a different epoch', async () => {
    const call = stubSnapshotResult({ asks: [makeEvent()], seq: 1, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()
    expect(call).toHaveBeenCalledTimes(1)

    call.mockResolvedValueOnce(
      successResponse({ asks: [makeEvent({ epoch: 'epoch-b' })], seq: 1, epoch: 'epoch-b' })
    )
    store.getState().applyAskRegistryEvent(makeEvent({ epoch: 'epoch-b', seq: 99 }))

    expect(store.getState().askWatermark).toBeNull()

    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
    expect(store.getState().askWatermark).toEqual({ seq: 1, epoch: 'epoch-b' })
    expect(store.getState().pendingAsksByPaneKey['pane-a']?.[0]?.askId).toBe('ask-1')
  })

  it('keeps a pane FIFO with the first-registered ask as the head', async () => {
    stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-2', seq: 2 }))

    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-1')
    expect(store.getState().pendingAsksByPaneKey['pane-a'].map((card) => card.askId)).toEqual([
      'ask-1',
      'ask-2'
    ])
  })

  it('counts only non-terminal asks across panes for the global pending count', async () => {
    stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', paneKey: 'pane-a', seq: 1 }))
    store
      .getState()
      .applyAskRegistryEvent(
        makeEvent({ askId: 'ask-2', paneKey: 'pane-b', seq: 2, status: 'answered' })
      )

    expect(selectPendingAskCount(store.getState())).toBe(1)
  })
})

describe('asks slice — terminal auto-dismiss', () => {
  it('keeps the resolved card at the head until the flash window elapses', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-2', seq: 2 }))
    store.getState().applyAskRegistryEvent(
      makeEvent({
        askId: 'ask-1',
        seq: 3,
        status: 'declined',
        result: { answers: {}, skipped: [], summary: 'Declined.' }
      })
    )

    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-1')

    vi.advanceTimersByTime(ASK_DISMISS_DELAY_MS - 1)
    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-1')
  })

  it('drops the resolved card and surfaces the next queued ask once the window elapses', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-2', seq: 2 }))
    store
      .getState()
      .applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 3, status: 'answered' }))

    vi.advanceTimersByTime(ASK_DISMISS_DELAY_MS)

    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-2')
    expect(store.getState().pendingAsksByPaneKey['pane-a'].map((card) => card.askId)).toEqual([
      'ask-2'
    ])
    expect(store.getState()._dismissTimers).toEqual({})
  })

  it('clears the pane key entirely when the dismissed card was the last one', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store
      .getState()
      .applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 2, status: 'timed_out' }))

    vi.advanceTimersByTime(ASK_DISMISS_DELAY_MS)

    expect(store.getState().pendingAsksByPaneKey).toEqual({})
  })

  it('schedules one dismiss per ask even when several terminal events arrive', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store
      .getState()
      .applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 2, status: 'answered' }))
    const armed = store.getState()._dismissTimers['ask-1']
    store.getState().applyAskRegistryEvent(
      makeEvent({
        askId: 'ask-1',
        seq: 3,
        status: 'answered',
        result: { answers: {}, skipped: [], summary: 'Done.' }
      })
    )

    expect(store.getState()._dismissTimers['ask-1']).toBe(armed)
  })

  it('keeps an ask with no pane in globalAsks and out of every pane queue', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))

    expect(store.getState().pendingAsksByPaneKey).toEqual({})
    expect(store.getState().globalAsks).toMatchObject([{ askId: 'ask-1', paneKey: null }])
    expect(store.getState().askWatermark).toEqual({ seq: 1, epoch: 'epoch-a' })
  })

  it('merges later events for a global ask and queues a second one behind it', async () => {
    const store = await hydratedStore()

    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))
    store.getState().applyAskRegistryEvent(
      makeEvent({
        paneKey: null,
        seq: 2,
        status: 'partial',
        spec: undefined,
        partial: { q1: { confirm: true } }
      })
    )
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, askId: 'ask-2', seq: 3 }))

    expect(store.getState().globalAsks.map((card) => card.askId)).toEqual(['ask-1', 'ask-2'])
    expect(store.getState().globalAsks[0]).toMatchObject({
      status: 'partial',
      partial: { q1: { confirm: true } }
    })
    expect(store.getState().globalAsks[0]?.spec).not.toBeNull()
  })

  it('seeds global asks from ask.snapshot', async () => {
    stubSnapshotResult({
      asks: [makeEvent({ paneKey: null }), makeEvent({ askId: 'ask-2', paneKey: 'pane-a' })],
      seq: 2,
      epoch: 'epoch-a'
    })
    const store = createSliceStore()

    await store.getState().hydrateAsks()

    expect(store.getState().globalAsks.map((card) => card.askId)).toEqual(['ask-1'])
    expect(Object.keys(store.getState().pendingAsksByPaneKey)).toEqual(['pane-a'])
  })

  it('buffers a no-pane event until hydration resolves', async () => {
    const { resolve } = stubDeferredSnapshot()
    const store = createSliceStore()

    const hydration = store.getState().hydrateAsks()
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))
    expect(store.getState().globalAsks).toEqual([])

    resolve(successResponse({ asks: [], seq: 0, epoch: 'epoch-a' }))
    await hydration

    expect(store.getState().globalAsks.map((card) => card.askId)).toEqual(['ask-1'])
  })

  it('drops a no-pane event at or below the watermark', async () => {
    const store = await hydratedStore(5)

    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 5 }))

    expect(store.getState().globalAsks).toEqual([])
  })

  it('auto-dismisses a resolved global ask after the window elapses', async () => {
    const store = await hydratedStore()
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, askId: 'ask-2', seq: 2 }))
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 3, status: 'answered' }))

    expect(Object.keys(store.getState()._dismissTimers)).toEqual(['ask-1'])
    expect(store.getState().globalAsks).toHaveLength(2)

    vi.advanceTimersByTime(ASK_DISMISS_DELAY_MS)

    expect(store.getState().globalAsks.map((card) => card.askId)).toEqual(['ask-2'])
    expect(store.getState()._dismissTimers).toEqual({})
  })

  it('dismisses a global ask with a null pane key and no-ops for an unknown askId', async () => {
    const store = await hydratedStore()
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))

    store.getState().dismissAsk(null, 'ask-missing')
    expect(store.getState().globalAsks).toHaveLength(1)

    store.getState().dismissAsk(null, 'ask-1')
    expect(store.getState().globalAsks).toEqual([])
  })

  it('clears global asks and their timers when an epoch mismatch discards the slice', async () => {
    const call = stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 1 }))
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, seq: 2, status: 'answered' }))

    call.mockResolvedValueOnce(successResponse({ asks: [], seq: 1, epoch: 'epoch-b' }))
    store.getState().applyAskRegistryEvent(makeEvent({ paneKey: null, epoch: 'epoch-b', seq: 99 }))

    expect(store.getState().globalAsks).toEqual([])
    expect(store.getState()._dismissTimers).toEqual({})
  })

  it('no-ops for an unknown pane or askId without creating a phantom key', async () => {
    const store = await hydratedStore()
    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))

    store.getState().dismissAsk('pane-missing', 'ask-1')
    store.getState().dismissAsk('pane-a', 'ask-missing')

    expect(Object.keys(store.getState().pendingAsksByPaneKey)).toEqual(['pane-a'])
    expect(selectHeadAsk(store.getState(), 'pane-a')?.askId).toBe('ask-1')
  })

  it('clears armed timers when an epoch mismatch discards the slice', async () => {
    const call = stubSnapshotResult({ asks: [], seq: 0, epoch: 'epoch-a' })
    const store = createSliceStore()
    await store.getState().hydrateAsks()

    store.getState().applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 1 }))
    store
      .getState()
      .applyAskRegistryEvent(makeEvent({ askId: 'ask-1', seq: 2, status: 'answered' }))
    expect(Object.keys(store.getState()._dismissTimers)).toEqual(['ask-1'])

    call.mockResolvedValueOnce(successResponse({ asks: [], seq: 1, epoch: 'epoch-b' }))
    store.getState().applyAskRegistryEvent(makeEvent({ epoch: 'epoch-b', seq: 99 }))

    expect(store.getState()._dismissTimers).toEqual({})
  })
})

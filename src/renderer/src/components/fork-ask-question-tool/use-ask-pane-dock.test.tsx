// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskCardModel as StoreAskCardModel } from '@/store/slices/fork-ask-question-tool/asks'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

const storeState: { pendingAsksByPaneKey: Record<string, StoreAskCardModel[]> } = {
  pendingAsksByPaneKey: {}
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useAskPaneDock } from './use-ask-pane-dock'

function successResponse<T>(result: T): RuntimeRpcResponse<T> {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function card(overrides: Partial<StoreAskCardModel> = {}): StoreAskCardModel {
  return {
    askId: 'ask-1',
    paneKey: 'pane-a',
    status: 'registered',
    spec: { questions: [{ id: 'name', type: 'text', question: 'Name?' }] },
    partial: {},
    ...overrides
  }
}

function stubRuntimeCall(call: ReturnType<typeof vi.fn>) {
  ;(window as unknown as { api: unknown }).api = { runtime: { call } }
}

afterEach(() => {
  storeState.pendingAsksByPaneKey = {}
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

describe('useAskPaneDock — debounced partial updates', () => {
  it('sends nothing before the debounce window elapses', () => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue(successResponse({ ok: true }))
    stubRuntimeCall(call)
    storeState.pendingAsksByPaneKey['pane-a'] = [card()]

    const { result } = renderHook(() => useAskPaneDock('pane-a'))
    act(() => result.current.onDraftChange({ name: { draft: 'o' } }))

    expect(call).not.toHaveBeenCalled()
  })

  it('coalesces rapid draft changes into one ask.updatePartial call carrying the latest partial', () => {
    vi.useFakeTimers()
    const call = vi.fn().mockResolvedValue(successResponse({ ok: true }))
    stubRuntimeCall(call)
    storeState.pendingAsksByPaneKey['pane-a'] = [card()]

    const { result } = renderHook(() => useAskPaneDock('pane-a'))
    act(() => {
      result.current.onDraftChange({ name: { draft: 'o' } })
      result.current.onDraftChange({ name: { draft: 'or' } })
      result.current.onDraftChange({ name: { draft: 'quirky' } })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith({
      method: 'ask.updatePartial',
      params: { askId: 'ask-1', partial: { name: { draft: 'quirky' } } }
    })
  })
})

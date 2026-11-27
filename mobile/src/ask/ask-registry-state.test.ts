import { describe, expect, it } from 'vitest'
import {
  applyAskStreamFrame,
  currentLiveAsksForWorktree,
  EMPTY_ASK_REGISTRY_STATE,
  settledAsksForWorktree,
  type AskRegistryState
} from './ask-registry-state'
import type { AskStreamEvent, AskStreamFrameInput } from './ask-stream-frame-schema'

const SPEC = { questions: [{ id: 'q1', type: 'text', question: 'Name?' }] }

function event(overrides: Partial<AskStreamEvent> & { askId: string }): AskStreamEvent {
  return {
    seq: 1,
    epoch: 'e1',
    paneKey: 'pane-a',
    status: 'registered',
    spec: SPEC,
    worktreeId: 'wt-1',
    ...overrides
  }
}

function apply(start: AskRegistryState, ...input: AskStreamFrameInput[]): AskRegistryState {
  return input.reduce(applyAskStreamFrame, start)
}

describe('ask registry state', () => {
  it('shows only the earliest-registered live ask of a pane as current', () => {
    const state = apply(
      EMPTY_ASK_REGISTRY_STATE,
      { type: 'snapshot', event: event({ askId: 'a1', seq: 1 }) },
      { type: 'snapshot', event: event({ askId: 'a2', seq: 2 }) },
      { type: 'snapshot', event: event({ askId: 'b1', seq: 3, paneKey: 'pane-b' }) },
      { type: 'watermark', seq: 3, epoch: 'e1' }
    )
    expect(currentLiveAsksForWorktree(state, 'wt-1').map((ask) => ask.askId)).toEqual(['a1', 'b1'])
  })

  it('promotes the queued ask once the current one settles', () => {
    const state = apply(
      EMPTY_ASK_REGISTRY_STATE,
      { type: 'snapshot', event: event({ askId: 'a1' }) },
      { type: 'snapshot', event: event({ askId: 'a2', seq: 2 }) },
      { type: 'watermark', seq: 2, epoch: 'e1' },
      {
        type: 'event',
        event: event({
          askId: 'a1',
          seq: 3,
          status: 'answered',
          spec: undefined,
          result: { summary: 'Name: Ada', skipped: [] }
        })
      }
    )
    expect(currentLiveAsksForWorktree(state, 'wt-1').map((ask) => ask.askId)).toEqual(['a2'])
    expect(settledAsksForWorktree(state, 'wt-1')[0]?.result?.summary).toBe('Name: Ada')
  })

  it('keeps the earliest-registered ask current even when its event arrives second', () => {
    const state = apply(
      EMPTY_ASK_REGISTRY_STATE,
      {
        type: 'event',
        event: event({ askId: 'a2', seq: 5, createdAt: '2026-01-01T00:00:02.000Z' })
      },
      {
        type: 'event',
        event: event({ askId: 'a1', seq: 6, createdAt: '2026-01-01T00:00:01.000Z' })
      }
    )
    expect(currentLiveAsksForWorktree(state, 'wt-1').map((ask) => ask.askId)).toEqual(['a1'])
  })

  it('ignores handoff asks and asks with no worktree', () => {
    const state = apply(
      EMPTY_ASK_REGISTRY_STATE,
      { type: 'event', event: event({ askId: 'h1', paneKey: null }) },
      { type: 'event', event: event({ askId: 'n1', worktreeId: null }) }
    )
    expect(state.asks.size).toBe(0)
  })

  it('drops an ask whose spec the shared validator rejects', () => {
    const state = apply(EMPTY_ASK_REGISTRY_STATE, {
      type: 'event',
      event: event({ askId: 'x', spec: { questions: [] } })
    })
    expect(state.asks.size).toBe(0)
  })

  it('replaces the pending set atomically at the watermark and keeps settled summaries', () => {
    const before = apply(
      EMPTY_ASK_REGISTRY_STATE,
      { type: 'snapshot', event: event({ askId: 'gone' }) },
      { type: 'watermark', seq: 1, epoch: 'e1' },
      { type: 'event', event: event({ askId: 'done', seq: 2, status: 'declined' }) }
    )
    const after = apply(
      before,
      { type: 'snapshot', event: event({ askId: 'fresh', seq: 5, epoch: 'e2' }) },
      { type: 'watermark', seq: 5, epoch: 'e2' }
    )
    expect([...after.asks.keys()].sort()).toEqual(['done', 'fresh'])
    expect(after.cursor).toEqual({ seq: 5, epoch: 'e2' })
  })

  it('tracks the resume cursor from events and clears it when the epoch changes', () => {
    const live = apply(
      EMPTY_ASK_REGISTRY_STATE,
      { type: 'watermark', seq: 4, epoch: 'e1' },
      { type: 'event', event: event({ askId: 'a1', seq: 9 }) }
    )
    expect(live.cursor).toEqual({ seq: 9, epoch: 'e1' })
    expect(apply(live, { type: 'end', reason: 'epoch_changed' }).cursor).toBeNull()
    expect(apply(live, { type: 'end', reason: 'closed' }).cursor).toEqual(live.cursor)
  })
})

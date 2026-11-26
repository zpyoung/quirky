import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import type { AgentJournalVisualItem } from '../../../../../shared/agent-session-journal-v1-items'
import {
  latestVisualsNewestFirst,
  loadVisualSpec,
  visualSpecNeedsFullItem,
  type VisualRenderItem
} from './visual-spec-source'

const VALID_SPEC = JSON.stringify({
  title: 'Overview',
  root: { type: 'markdown', props: { text: 'hello' } }
})

function visual(
  viewId: string,
  overrides: Partial<AgentJournalVisualItem> = {},
  item: Partial<AgentJournalRenderItem> = {}
): VisualRenderItem {
  return {
    itemId: `item-${viewId}`,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    ...item,
    body: {
      kind: 'visual',
      viewId,
      version: 1,
      placement: 'pane',
      spec: { head: VALID_SPEC, byteLength: VALID_SPEC.length, digest: 'd', truncated: false },
      ...overrides
    }
  }
}

describe('latestVisualsNewestFirst', () => {
  it('keeps the newest revision per view and lists the newest view first', () => {
    const items = [
      visual('a', {}, { itemId: 'a1', revision: 1, sequence: 1 }),
      visual('b', {}, { itemId: 'b1', revision: 1, sequence: 5 }),
      visual('a', { version: 2 }, { itemId: 'a1', revision: 3, sequence: 1 })
    ]
    const listed = latestVisualsNewestFirst(items)
    expect(listed.map((item) => item.body.viewId)).toEqual(['b', 'a'])
    expect(listed[1]?.body.version).toBe(2)
  })
})

describe('visualSpecNeedsFullItem', () => {
  it('is false for a complete head', () => {
    expect(visualSpecNeedsFullItem(visual('a'))).toBe(false)
  })

  it('is true when the item was shortened for the wire', () => {
    expect(visualSpecNeedsFullItem(visual('a', {}, { shortened: true }))).toBe(true)
  })

  it('is true when the spec head is truncated', () => {
    const item = visual('a', {
      spec: { head: VALID_SPEC.slice(0, 10), byteLength: 99, digest: 'd', truncated: true }
    })
    expect(visualSpecNeedsFullItem(item)).toBe(true)
  })
})

describe('loadVisualSpec', () => {
  it('reads the head without fetching when it is complete', async () => {
    const readFull = vi.fn()
    const state = await loadVisualSpec(visual('a'), readFull)
    expect(readFull).not.toHaveBeenCalled()
    expect(state.kind).toBe('ready')
    expect(state.kind === 'ready' && state.spec.title).toBe('Overview')
  })

  it('fetches the whole item when the item is shortened', async () => {
    const full = visual('a')
    const readFull = vi.fn().mockResolvedValue(full)
    const shortened = visual(
      'a',
      { spec: { head: '{"title"', byteLength: 999, digest: 'd', truncated: true } },
      { shortened: true }
    )
    const state = await loadVisualSpec(shortened, readFull)
    expect(readFull).toHaveBeenCalledTimes(1)
    expect(state.kind).toBe('ready')
  })

  it('fails when the fetched item is still truncated', async () => {
    const stillCut = visual('a', {
      spec: { head: '{"title"', byteLength: 999, digest: 'd', truncated: true }
    })
    const state = await loadVisualSpec(stillCut, vi.fn().mockResolvedValue(stillCut))
    expect(state.kind).toBe('failed')
  })

  it('fails when the host no longer has the item', async () => {
    const shortened = visual('a', {}, { shortened: true })
    const state = await loadVisualSpec(shortened, vi.fn().mockResolvedValue(null))
    expect(state.kind).toBe('failed')
  })

  it('fails with the reason when the fetch rejects', async () => {
    const shortened = visual('a', {}, { shortened: true })
    const state = await loadVisualSpec(shortened, vi.fn().mockRejectedValue(new Error('offline')))
    expect(state).toEqual({ kind: 'failed', message: 'offline' })
  })

  it('reports validation errors instead of a spec', async () => {
    const bad = visual('a', {
      spec: {
        head: JSON.stringify({ title: 'x', root: { type: 'nope' } }),
        byteLength: 40,
        digest: 'd',
        truncated: false
      }
    })
    const state = await loadVisualSpec(bad, vi.fn())
    expect(state.kind).toBe('invalid')
    expect(state.kind === 'invalid' && state.errors.length).toBeGreaterThan(0)
    expect(state.kind === 'invalid' && state.source).toContain('nope')
  })

  it('reports a head that is not JSON as invalid', async () => {
    const bad = visual('a', {
      spec: { head: 'not json', byteLength: 8, digest: 'd', truncated: false }
    })
    const state = await loadVisualSpec(bad, vi.fn())
    expect(state.kind).toBe('invalid')
  })
})

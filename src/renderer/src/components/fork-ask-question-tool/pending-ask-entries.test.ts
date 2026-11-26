import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AskCardModel } from '../../store/slices/fork-ask-question-tool/asks'
import { buildPendingAskEntries } from './pending-ask-entries'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function card(askId: string, status: AskCardModel['status'] = 'registered'): AskCardModel {
  return {
    askId,
    paneKey: null,
    status,
    spec: { questions: [{ id: 'q', type: 'confirm', question: `Ship ${askId}?` }] },
    partial: {}
  }
}

function state(
  overrides: Partial<Parameters<typeof buildPendingAskEntries>[0]> = {}
): Parameters<typeof buildPendingAskEntries>[0] {
  return {
    pendingAsksByPaneKey: {},
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', title: 'Terminal 1', customTitle: null }] },
    terminalLayoutsByTabId: {},
    getKnownWorktreeById: () => ({ displayName: 'feature-x' }),
    ...overrides
  }
}

describe('buildPendingAskEntries', () => {
  it('lists unanswered asks with their worktree and tab, skipping resolved ones', () => {
    const entries = buildPendingAskEntries(
      state({
        pendingAsksByPaneKey: {
          [makePaneKey('tab-1', LEAF)]: [card('a'), card('b', 'answered')]
        }
      })
    )
    expect(entries).toEqual([
      expect.objectContaining({
        askId: 'a',
        worktreeId: 'wt-1',
        worktreeLabel: 'feature-x',
        tabTitle: 'Terminal 1',
        question: 'Ship a?',
        paneClosed: false
      })
    ])
  })

  it('flags an ask whose tab or split leaf no longer exists', () => {
    const entries = buildPendingAskEntries(
      state({
        pendingAsksByPaneKey: {
          [makePaneKey('gone-tab', LEAF)]: [card('a')],
          [makePaneKey('tab-1', OTHER_LEAF)]: [card('b')]
        },
        terminalLayoutsByTabId: {
          'tab-1': { root: { type: 'leaf', leafId: LEAF } }
        }
      })
    )
    expect(entries.map((entry) => entry.paneClosed)).toEqual([true, true])
  })

  it('finds a tab in another worktree when the ask names a different one', () => {
    const entries = buildPendingAskEntries(
      state({
        pendingAsksByPaneKey: {
          [makePaneKey('tab-1', LEAF)]: [{ ...card('a'), worktreeId: 'wt-2' }]
        }
      })
    )
    expect(entries[0]).toMatchObject({ worktreeId: 'wt-1', paneClosed: false })
  })

  it('does not call a pane closed while its worktree tabs have not loaded', () => {
    const entries = buildPendingAskEntries(
      state({
        tabsByWorktree: {},
        pendingAsksByPaneKey: {
          [makePaneKey('tab-1', LEAF)]: [{ ...card('a'), worktreeId: 'wt-1' }]
        }
      })
    )
    expect(entries[0].paneClosed).toBe(false)
  })
})

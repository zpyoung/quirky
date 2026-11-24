import { describe, expect, it } from 'vitest'
import { SetTabProps } from '../../../../../shared/rpc-contract/session-tabs-schemas-params'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import {
  DEFAULT_TERMINAL_DOCK_GUTTER_ROWS,
  MAX_TERMINAL_DOCK_PANE_ENTRIES,
  mergeTerminalDockByPaneKey,
  removeTerminalDockPaneKeys
} from '../../../fork-terminal-dock/terminal-dock-session-tab-props'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import type { Tab } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { RuntimeSyncWindowGraph } from '../../../../../shared/runtime-types'

const WT = 'id:wt'
const DOCK_WORKTREE_ID = 'repo::/worktree'
const DOCK_TAB_ID = 'tab'
const DOCK_PANE_KEY = makePaneKey(DOCK_TAB_ID, '11111111-1111-4111-a111-111111111111')

function makeDockWorktreeSession(
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  const terminalTab: TerminalTab = {
    id: DOCK_TAB_ID,
    ptyId: 'pty-1',
    worktreeId: DOCK_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [DOCK_WORKTREE_ID]: [terminalTab] },
    ...overrides
  }
}

describe('SetTabProps.terminalDock (session.tabs.setTabProps params)', () => {
  // D4: paneKey is attacker-reachable input, so its shape is bound to the two
  // formats the host ever mints (makePaneKey's tabId:UUID, or the legacy
  // tabId:N numeric pane) instead of accepting an arbitrary string.
  it.each([
    ['parses a single-pane dock patch', { paneKey: 'tab-1:1', docked: true, gutterRows: 6 }],
    ['accepts a partial dock patch', { paneKey: 'tab-1:1', docked: true }],
    ['accepts a paneKey minted by makePaneKey', { paneKey: DOCK_PANE_KEY, docked: true }],
    ['accepts a legacy numeric pane key', { paneKey: 'tab-1:3', docked: true }],
    ['accepts the user-undock decision', { paneKey: 'tab-1:1', docked: false, userUndocked: true }]
  ])('%s', (_, terminalDock) => {
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock })
    expect(parsed.terminalDock).toEqual(terminalDock)
  })

  it('leaves other props unchanged when terminalDock is absent', () => {
    const parsed = SetTabProps.parse({
      worktree: WT,
      tabId: 'tab-1',
      color: '#fff'
    })
    expect(parsed.terminalDock).toBeUndefined()
    expect(parsed.color).toBe('#fff')
  })

  it.each([
    ['rejects a gutterRows value outside 3..15', { paneKey: 'tab-1:1', gutterRows: 999 }],
    ['rejects a missing paneKey', { docked: true }],
    ['rejects an invalid pane key format', { paneKey: 'not-a-pane-key', docked: true }],
    ['rejects an overlong pane key', { paneKey: `tab-1:${'1'.repeat(300)}`, docked: true }]
  ])('%s', (_, terminalDock) => {
    expect(() => SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock })).toThrow()
  })
})

describe('SetTabProps.terminalDock.remove (session.tabs.setTabProps params)', () => {
  const OTHER_PANE_KEY = makePaneKey(DOCK_TAB_ID, '22222222-2222-4222-a222-222222222222')

  it.each([
    ['accepts a removal-only patch', { remove: [DOCK_PANE_KEY, OTHER_PANE_KEY] }],
    [
      'accepts a combined set and removal',
      { paneKey: DOCK_PANE_KEY, docked: true, remove: [OTHER_PANE_KEY] }
    ]
  ])('%s', (_, terminalDock) => {
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock })
    expect(parsed.terminalDock).toEqual(terminalDock)
  })

  it.each([
    ['rejects set fields without paneKey', { docked: true, remove: [OTHER_PANE_KEY] }],
    ['rejects an invalid key in the removal list', { remove: ['not-a-pane-key'] }],
    [
      'rejects a removal list past the cap',
      { remove: Array.from({ length: 65 }, (_, i) => `tab-1:${i}`) }
    ]
  ])('%s', (_, terminalDock) => {
    expect(() => SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock })).toThrow()
  })

  it('accepts a removal list at the cap', () => {
    const remove = Array.from({ length: 64 }, (_, i) => `tab-1:${i}`)
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', terminalDock: { remove } })
    expect(parsed.terminalDock?.remove).toHaveLength(64)
  })

  it('leaves terminalDock unaffected when the patch carries neither paneKey nor remove', () => {
    // Absence must stay a pure leave-unchanged signal — an accidental
    // absence-clears reading would silently wipe other clients' state.
    const parsed = SetTabProps.parse({ worktree: WT, tabId: 'tab-1', color: '#fff' })
    expect(parsed.terminalDock).toBeUndefined()
  })
})

describe('removeTerminalDockPaneKeys (host removal semantics)', () => {
  it('drops only the named keys', () => {
    const existing = {
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: false, gutterRows: 10 }
    }
    expect(removeTerminalDockPaneKeys(existing, ['pane-1'])).toEqual({
      'pane-2': { docked: false, gutterRows: 10 }
    })
  })

  it('is a no-op, not an error, when the key is not present', () => {
    const existing = { 'pane-1': { docked: true, gutterRows: 6 } }
    expect(removeTerminalDockPaneKeys(existing, ['pane-missing'])).toBe(existing)
  })

  it('is a no-op for an undefined record', () => {
    expect(removeTerminalDockPaneKeys(undefined, ['pane-1'])).toBeUndefined()
  })
})

describe('mergeTerminalDockByPaneKey (host merge semantics)', () => {
  it('merges into an existing multi-pane record and defaults a fresh entry', () => {
    const existing = {
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: false, gutterRows: 10 }
    }
    expect(mergeTerminalDockByPaneKey(existing, { paneKey: 'pane-2', docked: true })).toEqual({
      'pane-1': { docked: true, gutterRows: 6 },
      'pane-2': { docked: true, gutterRows: 10 }
    })
    expect(mergeTerminalDockByPaneKey(undefined, { paneKey: 'pane-3', docked: true })).toEqual({
      'pane-3': { docked: true, gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }
    })
  })

  // the flag is what tells every client the undock was a user decision, so an
  // agent-exit patch (docked only) must leave it exactly as it found it
  it('carries the user-undock decision and never drops it on a docked-only patch', () => {
    const undocked = mergeTerminalDockByPaneKey(
      { 'pane-1': { docked: true, gutterRows: 6 } },
      { paneKey: 'pane-1', docked: false, userUndocked: true }
    )
    expect(undocked).toEqual({ 'pane-1': { docked: false, gutterRows: 6, userUndocked: true } })
    expect(mergeTerminalDockByPaneKey(undocked, { paneKey: 'pane-1', docked: false })).toEqual({
      'pane-1': { docked: false, gutterRows: 6, userUndocked: true }
    })
    expect(
      mergeTerminalDockByPaneKey(undocked, { paneKey: 'pane-1', docked: true, userUndocked: false })
    ).toEqual({ 'pane-1': { docked: true, gutterRows: 6, userUndocked: false } })
  })

  it('omits the flag entirely for a pane no user ever undocked', () => {
    expect(mergeTerminalDockByPaneKey(undefined, { paneKey: 'pane-1', docked: true })).toEqual({
      'pane-1': { docked: true, gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }
    })
  })
})

describe('mergeTerminalDockByPaneKey entry cap (D4: unbounded attacker-supplied pane keys)', () => {
  it('evicts the oldest entry once the cap is exceeded, and keeps the entry just written', () => {
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      record = mergeTerminalDockByPaneKey(record, { paneKey: `pane-${i}`, docked: true })
    }
    expect(Object.keys(record!)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)

    const grown = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-new', docked: true })

    expect(Object.keys(grown)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(grown['pane-new']).toEqual({
      docked: true,
      gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS
    })
    expect(grown['pane-0']).toBeUndefined()
    expect(grown['pane-1']).toBeDefined()
  })

  it('updating an existing entry at the cap evicts nothing', () => {
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      record = mergeTerminalDockByPaneKey(record, { paneKey: `pane-${i}`, docked: false })
    }

    const updated = mergeTerminalDockByPaneKey(record, { paneKey: 'pane-0', docked: true })

    expect(Object.keys(updated)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(updated['pane-0']).toEqual({
      docked: true,
      gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS
    })
  })
})

describe('mergeTerminalDockByPaneKey eviction protects live panes (M2: unverified pane-key flood)', () => {
  it('evicts unverified keys before a verified one, even though the verified key was inserted first', () => {
    const livePaneKeys = new Set(['pane-live'])
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined
    record = mergeTerminalDockByPaneKey(
      record,
      { paneKey: 'pane-live', docked: true },
      livePaneKeys
    )
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES - 1; i++) {
      record = mergeTerminalDockByPaneKey(
        record,
        { paneKey: `pane-fake-${i}`, docked: true },
        livePaneKeys
      )
    }
    expect(Object.keys(record!)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)

    const flooded = mergeTerminalDockByPaneKey(
      record,
      { paneKey: 'pane-fake-new', docked: true },
      livePaneKeys
    )

    expect(Object.keys(flooded)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(flooded['pane-live']).toBeDefined()
    expect(flooded['pane-fake-0']).toBeUndefined()
  })

  it('falls back to oldest-first eviction among verified keys once no unverified key remains', () => {
    const livePaneKeys = new Set(['pane-0', 'pane-1'])
    let record: Record<string, { docked: boolean; gutterRows: number }> | undefined = {
      'pane-0': { docked: true, gutterRows: 5 },
      'pane-1': { docked: true, gutterRows: 5 }
    }
    for (let i = 2; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      livePaneKeys.add(`pane-${i}`)
      record = mergeTerminalDockByPaneKey(
        record,
        { paneKey: `pane-${i}`, docked: true },
        livePaneKeys
      )
    }

    livePaneKeys.add('pane-new')
    const grown = mergeTerminalDockByPaneKey(
      record,
      { paneKey: 'pane-new', docked: true },
      livePaneKeys
    )

    expect(Object.keys(grown)).toHaveLength(MAX_TERMINAL_DOCK_PANE_ENTRIES)
    expect(grown['pane-0']).toBeUndefined()
    expect(grown['pane-new']).toBeDefined()
  })
})

describe('terminalDockByPaneKey publication (D3: write-only field)', () => {
  function makePersistedSession(
    overrides: Partial<WorkspaceSessionState> = {}
  ): WorkspaceSessionState {
    const terminalTab: TerminalTab = {
      id: DOCK_TAB_ID,
      ptyId: 'pty-1',
      worktreeId: DOCK_WORKTREE_ID,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    return {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [DOCK_WORKTREE_ID]: [terminalTab] },
      ...overrides
    }
  }

  it('echoes a terminalDock patch back on the published mobile session snapshot', async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })
    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('removes the named key, persists, and republishes, leaving other panes untouched', async () => {
    const otherPaneKey = makePaneKey(DOCK_TAB_ID, '22222222-2222-4222-a222-222222222222')
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: otherPaneKey, docked: false, gutterRows: 8 }
    })
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { remove: [DOCK_PANE_KEY] }
    })
    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [otherPaneKey]: { docked: false, gutterRows: 8 } }
    })
  })

  it('removing a key that is not present is a no-op, never an error', async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)

    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })

    await expect(
      runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { remove: ['tab:404'] }
      })
    ).resolves.toEqual({ updated: true })

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })

  it('a live pane survives churn that previously evicted it, once retired panes are pruned', async () => {
    // Repro (task description): P0 stays docked while P1..P64 are created, docked, and
    // closed one at a time. Before the removal path existed, each churned pane grew the
    // record and the cap eventually evicted P0 by insertion order, not liveness.
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: 'pane-p0', docked: true }
    })

    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      const churnKey = `pane-churn-${i}`
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: churnKey, docked: true }
      })
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { remove: [churnKey] }
      })
    }

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: {
        'pane-p0': { docked: true, gutterRows: DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }
      }
    })
  })

  it('a flood of fabricated pane keys cannot evict a host-verified live pane, and legitimate updates for known panes still persist (M2)', async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makePersistedSession()
    } as never)
    // Why: registerPty is the host's own PTY-binding record, independent of any
    // client-supplied dock patch — it's the "known live pane" source under test.
    runtime.registerPty('pty-live', DOCK_WORKTREE_ID, null, {
      tabId: DOCK_TAB_ID,
      leafId: '11111111-1111-4111-a111-111111111111'
    })
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, docked: true, gutterRows: 6 }
    })

    const fakeLeafId = (i: number): string =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    for (let i = 0; i < MAX_TERMINAL_DOCK_PANE_ENTRIES; i++) {
      await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
        tabId: DOCK_TAB_ID,
        terminalDock: { paneKey: makePaneKey(DOCK_TAB_ID, fakeLeafId(i)), docked: true }
      })
    }

    const flooded = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(flooded.tabs[0]).toMatchObject({
      terminalDockByPaneKey: expect.objectContaining({
        [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 }
      })
    })

    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: DOCK_PANE_KEY, gutterRows: 9 }
    })
    const updated = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(updated.tabs[0]).toMatchObject({
      terminalDockByPaneKey: expect.objectContaining({
        [DOCK_PANE_KEY]: { docked: true, gutterRows: 9 }
      })
    })
  })

  it('rehydrates a persisted dock record from the unified tab on restart', async () => {
    const unifiedTab: Tab = {
      id: DOCK_TAB_ID,
      entityId: DOCK_TAB_ID,
      groupId: 'group-1',
      worktreeId: DOCK_WORKTREE_ID,
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    }
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () =>
        makePersistedSession({ unifiedTabs: { [DOCK_WORKTREE_ID]: [unifiedTab] } })
    } as never)

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { [DOCK_PANE_KEY]: { docked: true, gutterRows: 6 } }
    })
  })
})

describe('renderer graph publication merges terminalDockByPaneKey per pane (r2-7)', () => {
  it("preserves another client's newer per-pane patch when the desktop renderer republishes a record that never touched that pane", async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makeDockWorktreeSession()
    } as never)
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    // A headless client (no authoritative renderer window yet) patches pane B directly.
    await runtime.setMobileSessionTabProps(`id:${DOCK_WORKTREE_ID}`, {
      tabId: DOCK_TAB_ID,
      terminalDock: { paneKey: 'pane-b', docked: true, gutterRows: 9 }
    })

    // The desktop renderer then publishes its own full graph: it changed pane A
    // locally and has never tracked pane B at all.
    const graph: RuntimeSyncWindowGraph = {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: DOCK_WORKTREE_ID,
          publicationEpoch: 'renderer:epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: `${DOCK_TAB_ID}::leaf-1`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${DOCK_TAB_ID}::leaf-1`,
              parentTabId: DOCK_TAB_ID,
              leafId: 'leaf-1',
              title: 'Terminal',
              ptyId: 'pty-1',
              isActive: true,
              terminalDockByPaneKey: { 'pane-a': { docked: true, gutterRows: 6 } }
            }
          ]
        }
      ]
    }
    runtime.syncWindowGraph(1, graph)

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: {
        'pane-a': { docked: true, gutterRows: 6 },
        'pane-b': { docked: true, gutterRows: 9 }
      }
    })
  })

  it('still adopts a genuine local edit from the renderer, even for a pane the renderer had published before', async () => {
    const runtime = new QuirkyRuntimeService({
      getWorkspaceSession: () => makeDockWorktreeSession()
    } as never)
    await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)

    const rendererTab = (
      paneA: { docked: boolean; gutterRows: number },
      snapshotVersion: number
    ): RuntimeSyncWindowGraph => ({
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: DOCK_WORKTREE_ID,
          publicationEpoch: 'renderer:epoch-1',
          snapshotVersion,
          activeGroupId: 'group-1',
          activeTabId: `${DOCK_TAB_ID}::leaf-1`,
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `${DOCK_TAB_ID}::leaf-1`,
              parentTabId: DOCK_TAB_ID,
              leafId: 'leaf-1',
              title: 'Terminal',
              ptyId: 'pty-1',
              isActive: true,
              terminalDockByPaneKey: { 'pane-a': paneA }
            }
          ]
        }
      ]
    })

    // First renderer publish establishes the baseline the next one is diffed against.
    runtime.syncWindowGraph(1, rendererTab({ docked: true, gutterRows: 6 }, 1))
    // The user then flips pane A on the desktop itself.
    runtime.syncWindowGraph(1, rendererTab({ docked: false, gutterRows: 6 }, 2))

    const result = await runtime.listMobileSessionTabs(`id:${DOCK_WORKTREE_ID}`)
    expect(result.tabs[0]).toMatchObject({
      terminalDockByPaneKey: { 'pane-a': { docked: false, gutterRows: 6 } }
    })
  })
})

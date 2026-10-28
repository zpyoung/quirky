import { afterEach, expect, test } from 'bun:test'
import type { Tab, ViewTab, Workspace } from '../src/layout/types'
import { isViewTab } from '../src/layout/types'
import { loopConfig, startLoopRig, type LoopRig, type ScriptedTurn } from '../../quirky.loops/test/rig'
import type { LoopSnapshot } from '../../quirky.loops/src/types'

let rig: LoopRig | null = null
let releaseTurn: (() => void) | null = null
const loopIds: string[] = []

afterEach(async () => {
  releaseTurn?.()
  releaseTurn = null
  if (rig) {
    for (const loopId of loopIds) {
      try {
        await rig.call('quirky.loops/stop', { loopId, mode: 'now' })
      } catch {
        // A loop may already have stopped during the test.
      }
    }
  }
  loopIds.length = 0
  await rig?.cleanup()
  rig = null
})
function holdTurn(): { script: ScriptedTurn; started: Promise<void> } {
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<{ status: 'waiting' }>()
  releaseTurn = () => pending.resolve({ status: 'waiting' })
  return {
    script: async () => {
      started.resolve()
      return pending.promise
    },
    started: started.promise
  }
}

function tabsIn(node: Workspace['root']): Tab[] {
  if (node.kind === 'split') return [...tabsIn(node.first), ...tabsIn(node.second)]
  return node.tabs
}

function viewIn(workspace: Workspace, tabId: string): ViewTab | undefined {
  return tabsIn(workspace.root).find((tab): tab is ViewTab => tab.id === tabId && isViewTab(tab))
}


async function startLiveLoop() {
  const held = holdTurn()
  rig = await startLoopRig({ extraPlugins: ['quirky.terminal'], script: held.script })
  const base = await rig.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig.worktree.id, ensure: true })
  const anchor = tabsIn(base.workspace.root).find((tab) => !isViewTab(tab))
  if (!anchor) throw new Error('terminal fixture did not create its initial tab')

  const loop = await rig.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: rig.worktree.id,
    agent: 'claude',
    config: loopConfig('Run the integration fixture')
  })
  loopIds.push(loop.id)
  await held.started
  const running = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'running')
  const opened = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    viewId: 'view:quirky.loops/loop',
    key: loop.id,
    input: { loopId: loop.id },
    title: running.name,
    activate: false,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: 'quirky.loops/viewCloseGuard',
    closeParams: {
      loopId: loop.id,
      closeReason: 'bulk',
      closeViewId: 'view:untrusted/other',
      closeViewKey: 'other',
      closeViewInput: { loopId: 'other' }
    },
    closeContext: true
  })
  return { anchor: anchor.id, loop: running, opened }
}

test('hosted loop close context persists without changing legacy tab invocation shape', async () => {
  rig = await startLoopRig({ extraPlugins: ['quirky.terminal'] })
  const initial = await rig.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig.worktree.id, ensure: true })
  const initialTabIds = tabsIn(initial.workspace.root).map((tab) => tab.id)
  const group = initial.workspace.activeGroup
  const bound = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    group,
    viewId: 'view:quirky.loops/loop',
    key: 'bound-loop',
    input: { loopId: 'bound-loop' },
    title: 'Loop bound',
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: 'quirky.loops/viewCloseGuard',
    closeParams: { loopId: 'bound-loop' },
    closeContext: true
  })
  const legacy = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    group,
    viewId: 'view:quirky.loops/loop',
    key: 'legacy-loop',
    input: { loopId: 'legacy-loop' },
    title: 'Legacy loop'
  })
  const optedOut = await rig.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig.worktree.id,
    group,
    viewId: 'view:quirky.loops/loop',
    key: 'opted-out',
    input: { loopId: 'opted-out' },
    title: 'Opted out loop',
    closeContext: false
  })
  expect(viewIn(bound.workspace, bound.tab)).toMatchObject({ closeContext: true, closeParams: { loopId: 'bound-loop' } })
  expect(viewIn(legacy.workspace, legacy.tab)).not.toHaveProperty('closeContext')
  expect(viewIn(optedOut.workspace, optedOut.tab)).toHaveProperty('closeContext', false)

  await rig.restart()
  const restored = await rig.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig.worktree.id })
  expect(tabsIn(restored.workspace.root).map((tab) => tab.id).sort()).toEqual([...initialTabIds, bound.tab, legacy.tab, optedOut.tab].sort())
  expect(viewIn(restored.workspace, bound.tab)).toMatchObject({ closeContext: true, closeParams: { loopId: 'bound-loop' } })
  expect(viewIn(restored.workspace, legacy.tab)).not.toHaveProperty('closeContext')
  expect(viewIn(restored.workspace, optedOut.tab)).toHaveProperty('closeContext', false)
})

test('raw single closes are denied while a bulk close detaches without stopping the loop', async () => {
  const { anchor, loop, opened } = await startLiveLoop()

  await expect(rig!.call('quirky.terminal/closeTab', { tab: opened.tab })).rejects.toThrow('refused to close')
  const closeGuard = {
    allowed: await rig!.call('quirky.loops/viewCloseGuard', {
      loopId: loop.id,
      tabId: opened.tab,
      closeReason: 'bulk',
      closeViewId: 'view:quirky.loops/loop',
      closeViewKey: loop.id,
      closeViewInput: { loopId: loop.id }
    })
  }
  expect(closeGuard).toHaveProperty('allowed', false)

  await rig!.call('quirky.terminal/openViewTab', {
    workspace: rig!.worktree.id,
    viewId: 'view:quirky.loops/loop',
    key: loop.id,
    title: loop.name,
    closeContext: false
  })
  await expect(rig!.call('quirky.terminal/closeTab', { tab: opened.tab })).rejects.toThrow('refused to close')
  await rig!.call('quirky.terminal/openViewTab', {
    workspace: rig!.worktree.id,
    viewId: 'view:quirky.loops/loop',
    key: loop.id,
    title: loop.name,
    closeContext: true
  })

  await rig!.call('quirky.terminal/closeTabs', { tab: anchor, which: 'right' })
  const workspace = await rig!.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig!.worktree.id })
  expect(viewIn(workspace.workspace, opened.tab)).toBeUndefined()
  const after = await rig!.snapshot(loop.id)
  expect(after.state).toBe('running')
  expect(after.sessionId).toBe(loop.sessionId)
})

test('closeGroup and preview replacement use bulk and replacement contexts', async () => {
  const { loop, opened } = await startLiveLoop()
  const moved = await rig!.call<{ workspace: Workspace }>('quirky.terminal/moveTab', { tab: opened.tab, split: 'right' })
  const targetGroup = findGroup(moved.workspace.root, opened.tab)
  if (!targetGroup) throw new Error('loop view was not moved into a split group')
  await rig!.call('quirky.terminal/closeGroup', { group: targetGroup.id })
  const afterGroupClose = await rig!.call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: rig!.worktree.id })
  expect(viewIn(afterGroupClose.workspace, opened.tab)).toBeDefined()
  expect(findGroup(afterGroupClose.workspace.root, opened.tab)?.id).not.toBe(targetGroup.id)
  expect((await rig!.snapshot(loop.id)).state).toBe('running')

  const preview = await rig!.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig!.worktree.id,
    viewId: 'view:quirky.loops/loop',
    key: loop.id,
    input: { loopId: loop.id },
    title: 'Loop preview',
    preview: true,
    closeCommand: 'command:quirky.loops/close-tab',
    closeMethod: 'quirky.loops/viewCloseGuard',
    closeParams: { loopId: loop.id },
    closeContext: true
  })
  const replaced = await rig!.call<{ workspace: Workspace; tab: string }>('quirky.terminal/openViewTab', {
    workspace: rig!.worktree.id,
    viewId: 'view:quirky.loops/loop',
    key: `${loop.id}-replacement`,
    input: { loopId: loop.id },
    title: 'Loop replacement',
    replace: preview.tab
  })
  expect(viewIn(replaced.workspace, preview.tab)).toMatchObject({ key: `${loop.id}-replacement` })
  expect((await rig!.snapshot(loop.id)).state).toBe('running')
})

function findGroup(node: Workspace['root'], tabId: string): { id: string } | null {
  if (node.kind === 'group') return node.tabs.some((tab) => tab.id === tabId) ? { id: node.id } : null
  return findGroup(node.first, tabId) ?? findGroup(node.second, tabId)
}

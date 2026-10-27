import { recentOrder, removeRecent, touchRecent } from './titles'
import {
  equalize as equalizeTree,
  findGroup,
  findPane,
  groupsInOrder,
  insertGroup,
  insertPane,
  movePane as movePaneInTree,
  neighborPane,
  paneLeaves,
  removeGroup,
  removePane,
  setGroupRatio,
  setGroupShare,
  setPaneRatio,
  setPaneShare,
  splitPane as splitPaneInTree
} from './tree'
import type { GroupSide, IdSource, TreeError, TreeResult } from './tree'
import { MAX_CLOSED_TABS, TAB_COLORS, TITLE_MAX } from './types'
import type { ClosedTab, Edge, Group, GroupNode, PaneExit, PaneLeaf, PaneNode, SplitDirection, Tab, TabColor, Workspace } from './types'

export type OpResult<T = Workspace> = TreeResult<T>

const ok = <T>(value: T): OpResult<T> => ({ ok: true, value })
const fail = (kind: TreeError['kind'], message: string): OpResult<never> => ({ ok: false, error: { kind, message } })

export const LAST_PANE_MESSAGE = "the last pane of a tab can't be moved out"

export type TabLocation = { group: Group; tab: Tab; index: number }
export type PaneLocation = TabLocation & { pane: PaneLeaf }

/** Every tab of a workspace in visual order (groups left to right, tabs in strip order). */
export function workspaceTabs(ws: Workspace): Tab[] {
  return groupsInOrder(ws.root).flatMap((group) => group.tabs)
}

/** The tab `tabId` with its group and strip position, or null. */
export function locateTab(ws: Workspace, tabId: string): TabLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    const index = group.tabs.findIndex((tab) => tab.id === tabId)
    if (index >= 0) return { group, tab: group.tabs[index]!, index }
  }
  return null
}

/** The pane `paneId` with its tab and group, or null. */
export function locatePane(ws: Workspace, paneId: string): PaneLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    for (const [index, tab] of group.tabs.entries()) {
      const pane = findPane(tab.root, paneId)
      if (pane) return { group, tab, index, pane }
    }
  }
  return null
}

/** The pane showing `sessionId`, or null. */
export function locateSession(ws: Workspace, sessionId: string): PaneLocation | null {
  for (const group of groupsInOrder(ws.root)) {
    for (const [index, tab] of group.tabs.entries()) {
      const pane = paneLeaves(tab.root).find((leaf) => leaf.session === sessionId)
      if (pane) return { group, tab, index, pane }
    }
  }
  return null
}

/** The sessions held by the workspace's panes. */
export function boundSessions(ws: Workspace): string[] {
  return workspaceTabs(ws).flatMap((tab) => paneLeaves(tab.root).map((leaf) => leaf.session))
}

function mapGroupNode(node: GroupNode, fn: (group: Group) => Group): GroupNode {
  if (node.kind === 'group') return fn(node)
  const first = mapGroupNode(node.first, fn)
  const second = mapGroupNode(node.second, fn)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function updateGroup(ws: Workspace, groupId: string, fn: (group: Group) => Group): Workspace {
  return { ...ws, root: mapGroupNode(ws.root, (group) => (group.id === groupId ? fn(group) : group)) }
}

function updateTab(ws: Workspace, tabId: string, fn: (tab: Tab) => Tab): Workspace {
  return {
    ...ws,
    root: mapGroupNode(ws.root, (group) =>
      group.tabs.some((tab) => tab.id === tabId) ? { ...group, tabs: group.tabs.map((tab) => (tab.id === tabId ? fn(tab) : tab)) } : group
    )
  }
}

function mapLeaf(node: PaneNode, paneId: string, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'pane') return node.id === paneId ? fn(node) : node
  const first = mapLeaf(node.first, paneId, fn)
  const second = mapLeaf(node.second, paneId, fn)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** An empty group, the only content a fresh workspace has. */
export function newGroup(ids: IdSource): Group {
  return { kind: 'group', id: ids.next('grp'), tabs: [], activeTab: null, recent: [], lastQuickCommand: null }
}

/** A workspace with one empty group and revision 0. */
export function emptyWorkspace(id: string, ids: IdSource, revision = 0): Workspace {
  const group = newGroup(ids)
  return { id, revision, root: group, activeGroup: group.id, closed: [] }
}

/** A tab holding one pane on `session`. */
export function makeTab(
  ids: IdSource,
  spec: { defaultTitle: string; session: string; now: string; customTitle?: string | null; color?: TabColor }
): Tab {
  const pane: PaneLeaf = { kind: 'pane', id: ids.next('pane'), session: spec.session, title: null, exit: null }
  return {
    id: ids.next('tab'),
    defaultTitle: spec.defaultTitle,
    customTitle: spec.customTitle ?? null,
    liveTitle: null,
    color: spec.color ?? 'none',
    pinned: false,
    root: pane,
    activePane: pane.id,
    expandedPane: null,
    createdAt: spec.now
  }
}

function activate(ws: Workspace, groupId: string, tabId: string | null): Workspace {
  const next = updateGroup(ws, groupId, (group) => ({
    ...group,
    activeTab: tabId,
    recent: tabId ? touchRecent(group.recent, tabId) : group.recent
  }))
  return { ...next, activeGroup: groupId }
}

/** Adds `tab` at the end of group `groupId` and makes it the group's active tab. */
export function appendTab(ws: Workspace, groupId: string, tab: Tab): OpResult {
  if (!findGroup(ws.root, groupId)) return fail('not-found', `no group ${groupId}`)
  const added = updateGroup(ws, groupId, (group) => ({ ...group, tabs: [...group.tabs, tab] }))
  return ok(activate(added, groupId, tab.id))
}

/** Records which quick command the group's strip button ran last. */
export function setLastQuickCommand(ws: Workspace, groupId: string, commandId: string): Workspace {
  return updateGroup(ws, groupId, (group) => ({ ...group, lastQuickCommand: commandId }))
}

/** Removes group `groupId` when it has no tabs and is not the workspace's only group. */
function dropEmptyGroup(ws: Workspace, groupId: string): Workspace {
  const group = findGroup(ws.root, groupId)
  if (!group || group.tabs.length > 0 || groupsInOrder(ws.root).length < 2) return ws
  const removed = removeGroup(ws.root, groupId)
  if (!removed.ok) return ws
  return { ...ws, root: removed.value.tree, activeGroup: ws.activeGroup === groupId ? removed.value.target : ws.activeGroup }
}

function detachTab(ws: Workspace, tab: Tab, groupId: string): Workspace {
  return updateGroup(ws, groupId, (group) => {
    const tabs = group.tabs.filter((entry) => entry.id !== tab.id)
    const recent = removeRecent(group.recent, tab.id)
    const activeTab = group.activeTab === tab.id ? (recentOrder(tabs, recent)[0] ?? null) : group.activeTab
    return { ...group, tabs, activeTab, recent: activeTab ? touchRecent(recent, activeTab) : recent }
  })
}

/**
 * Removes a tab; the group's previously used tab (by recency, not position) becomes active, and a
 * group left empty goes away unless it is the last. `record` is remembered for reopening.
 */
export function removeTab(ws: Workspace, tabId: string, record: ClosedTab | null): OpResult {
  const loc = locateTab(ws, tabId)
  if (!loc) return fail('not-found', `no tab ${tabId}`)
  const detached = dropEmptyGroup(detachTab(ws, loc.tab, loc.group.id), loc.group.id)
  const closed = record ? [record, ...ws.closed].slice(0, MAX_CLOSED_TABS) : ws.closed
  return ok({ ...detached, closed })
}

/** Sets a tab's custom title; the empty string clears it. */
export function renameTab(ws: Workspace, tabId: string, title: string): OpResult {
  if (!locateTab(ws, tabId)) return fail('not-found', `no tab ${tabId}`)
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX) return fail('invalid-params', `title must be at most ${TITLE_MAX} characters`)
  return ok(updateTab(ws, tabId, (tab) => ({ ...tab, customTitle: trimmed === '' ? null : trimmed })))
}

export function setTabColor(ws: Workspace, tabId: string, color: string): OpResult {
  if (!locateTab(ws, tabId)) return fail('not-found', `no tab ${tabId}`)
  if (!(TAB_COLORS as readonly string[]).includes(color)) return fail('invalid-params', `color must be one of ${TAB_COLORS.join(', ')}`)
  return ok(updateTab(ws, tabId, (tab) => ({ ...tab, color: color as TabColor })))
}

/** Pins or unpins a tab; pinned tabs sort before unpinned ones, and a tab joins the end of its new section. */
export function pinTab(ws: Workspace, tabId: string, pinned: boolean): OpResult {
  const loc = locateTab(ws, tabId)
  if (!loc) return fail('not-found', `no tab ${tabId}`)
  if (loc.tab.pinned === pinned) return ok(ws)
  const others = loc.group.tabs.filter((tab) => tab.id !== tabId)
  const tabs = [...others.filter((tab) => tab.pinned), { ...loc.tab, pinned }, ...others.filter((tab) => !tab.pinned)]
  return ok(updateGroup(ws, loc.group.id, (group) => ({ ...group, tabs })))
}

function insertTabAt(group: Group, tab: Tab, index: number | undefined): Group {
  const pinnedCount = group.tabs.filter((entry) => entry.pinned).length
  const low = tab.pinned ? 0 : pinnedCount
  const high = tab.pinned ? pinnedCount : group.tabs.length
  const at = Math.min(Math.max(index ?? high, low), high)
  const tabs = [...group.tabs.slice(0, at), tab, ...group.tabs.slice(at)]
  return { ...group, tabs, activeTab: tab.id, recent: touchRecent(group.recent, tab.id) }
}

/** Moves a tab to position `index` (default the end of its section) of group `groupId`; it becomes that group's active tab. */
export function moveTabToGroup(ws: Workspace, tabId: string, groupId: string, index?: number): OpResult {
  const loc = locateTab(ws, tabId)
  if (!loc) return fail('not-found', `no tab ${tabId}`)
  if (!findGroup(ws.root, groupId)) return fail('not-found', `no group ${groupId}`)
  const detached = detachTab(ws, loc.tab, loc.group.id)
  const inserted = updateGroup(detached, groupId, (group) => insertTabAt(group, loc.tab, index))
  const settled = loc.group.id === groupId ? inserted : dropEmptyGroup(inserted, loc.group.id)
  return ok({ ...settled, activeGroup: groupId })
}

/** Moves a tab into a new group opened on `side` of group `ofGroup` (default the tab's own group). */
export function moveTabToSplit(ws: Workspace, tabId: string, side: GroupSide, ofGroup: string | undefined, ids: IdSource): OpResult {
  const loc = locateTab(ws, tabId)
  if (!loc) return fail('not-found', `no tab ${tabId}`)
  const target = ofGroup ?? loc.group.id
  if (!findGroup(ws.root, target)) return fail('not-found', `no group ${target}`)
  if (target === loc.group.id && loc.group.tabs.length === 1) {
    return fail('invalid-params', "a group's only tab can't be split off its own group")
  }
  const created: Group = { kind: 'group', id: ids.next('grp'), tabs: [loc.tab], activeTab: loc.tab.id, recent: [loc.tab.id], lastQuickCommand: null }
  const detached = detachTab(ws, loc.tab, loc.group.id)
  const inserted = insertGroup(detached.root, target, side, created, ids)
  if (!inserted.ok) return inserted
  const withGroup = dropEmptyGroup({ ...detached, root: inserted.value }, loc.group.id)
  return ok({ ...withGroup, activeGroup: created.id })
}

/** Makes a tab the active tab of its group, and that group the active one. */
export function activateTab(ws: Workspace, tabId: string): OpResult {
  const loc = locateTab(ws, tabId)
  return loc ? ok(activate(ws, loc.group.id, tabId)) : fail('not-found', `no tab ${tabId}`)
}

/** Activates the tab at the 1-based `index` of a group (default the active group). */
export function activateTabAt(ws: Workspace, groupId: string | undefined, index: number): OpResult {
  const group = findGroup(ws.root, groupId ?? ws.activeGroup)
  if (!group) return fail('not-found', `no group ${groupId}`)
  const tab = group.tabs[index - 1]
  return tab ? ok(activate(ws, group.id, tab.id)) : fail('invalid-params', `group ${group.id} has no tab at index ${index}`)
}

/** Activates the next (`1`) or previous (`-1`) tab of the active group, wrapping, by position or by recent use. */
export function activateTabBy(ws: Workspace, offset: 1 | -1, order: 'position' | 'recent'): OpResult {
  const group = findGroup(ws.root, ws.activeGroup)
  if (!group || group.tabs.length === 0) return ok(ws)
  const ids = order === 'recent' ? recentOrder(group.tabs, group.recent) : group.tabs.map((tab) => tab.id)
  const current = Math.max(ids.indexOf(group.activeTab ?? ''), 0)
  return ok(activate(ws, group.id, ids[(current + offset + ids.length) % ids.length]!))
}

/** Splits pane `paneId`; `leaf` becomes the new second pane, active, and an expanded pane collapses. */
export function splitPaneOp(ws: Workspace, paneId: string, direction: SplitDirection, leaf: PaneLeaf, ids: IdSource): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  const root = splitPaneInTree(loc.tab.root, paneId, direction, leaf, ids)
  if (!root.ok) return root
  return ok(updateTab(ws, loc.tab.id, (tab) => ({ ...tab, root: root.value, activePane: leaf.id, expandedPane: null })))
}

/** Removes a pane; closing a tab's only pane closes the tab (and remembers it when `record` is given). */
export function closePaneOp(ws: Workspace, paneId: string, record: ClosedTab | null): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  const root = removePane(loc.tab.root, paneId)
  if (!root) return removeTab(ws, loc.tab.id, record)
  const leaves = paneLeaves(root)
  return ok(
    updateTab(ws, loc.tab.id, (tab) => ({
      ...tab,
      root,
      activePane: tab.activePane === paneId ? leaves[0]!.id : tab.activePane,
      expandedPane: tab.expandedPane === paneId || leaves.length < 2 ? null : tab.expandedPane
    }))
  )
}

/** Points a pane at a fresh session and clears its exit. */
export function rebindPane(ws: Workspace, paneId: string, session: string): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  return ok(updateTab(ws, loc.tab.id, (tab) => ({ ...tab, root: mapLeaf(tab.root, paneId, (leaf) => ({ ...leaf, session, exit: null })) })))
}

/** Records how a pane's process ended (or clears it with null). */
export function setPaneExit(ws: Workspace, paneId: string, exit: PaneExit | null): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  return ok(updateTab(ws, loc.tab.id, (tab) => ({ ...tab, root: mapLeaf(tab.root, paneId, (leaf) => ({ ...leaf, exit })) })))
}

/** Makes a pane its tab's active pane (collapsing an expanded one), its tab active, and its group the active group. */
export function focusPaneOp(ws: Workspace, paneId: string): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  const focused = updateTab(ws, loc.tab.id, (tab) => ({ ...tab, activePane: paneId, expandedPane: null }))
  return ok(activate(focused, loc.group.id, loc.tab.id))
}

/** Moves a tab's focus to the next (`1`) or previous (`-1`) pane in visual order, wrapping; the tab defaults to the active group's active tab. */
export function focusPaneBy(ws: Workspace, tabId: string | undefined, offset: 1 | -1): OpResult {
  const resolved = tabId ?? findGroup(ws.root, ws.activeGroup)?.activeTab ?? null
  const loc = resolved ? locateTab(ws, resolved) : null
  if (!loc) return tabId ? fail('not-found', `no tab ${tabId}`) : fail('invalid-params', 'there is no tab to move focus in')
  const next = neighborPane(loc.tab.root, loc.tab.activePane, offset)
  return next ? focusPaneOp(ws, next) : ok(ws)
}

export function setPaneTitle(ws: Workspace, paneId: string, title: string): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX) return fail('invalid-params', `title must be at most ${TITLE_MAX} characters`)
  return ok(updateTab(ws, loc.tab.id, (tab) => ({ ...tab, root: mapLeaf(tab.root, paneId, (leaf) => ({ ...leaf, title: trimmed === '' ? null : trimmed })) })))
}

/** Expands a pane to fill its tab (making it active), or collapses whatever is expanded. */
export function expandPaneOp(ws: Workspace, paneId: string, expanded: boolean): OpResult {
  const loc = locatePane(ws, paneId)
  if (!loc) return fail('not-found', `no pane ${paneId}`)
  if (expanded && paneLeaves(loc.tab.root).length < 2) return fail('invalid-params', 'a tab with one pane has nothing to expand')
  return ok(
    updateTab(ws, loc.tab.id, (tab) => ({
      ...tab,
      activePane: expanded ? paneId : tab.activePane,
      expandedPane: expanded ? paneId : null
    }))
  )
}

export function equalizeTab(ws: Workspace, tabId: string): OpResult {
  if (!locateTab(ws, tabId)) return fail('not-found', `no tab ${tabId}`)
  return ok(updateTab(ws, tabId, (tab) => ({ ...tab, root: equalizeTree(tab.root) })))
}

function paneSplitOwner(ws: Workspace, splitId: string): Tab | null {
  return workspaceTabs(ws).find((tab) => hasSplit(tab.root, splitId)) ?? null
}

function hasSplit(node: PaneNode | GroupNode, id: string): boolean {
  return node.kind === 'split' && (node.id === id || hasSplit(node.first, id) || hasSplit(node.second, id))
}

/** Whether the workspace has a divider `splitId`, between groups or between a tab's panes. */
export function hasDivider(ws: Workspace, splitId: string): boolean {
  return hasSplit(ws.root, splitId) || paneSplitOwner(ws, splitId) !== null
}

/** Sets what a tab shows when it has no custom title: the active pane's latest terminal title. */
export function setLiveTitle(ws: Workspace, tabId: string, title: string | null): Workspace {
  return updateTab(ws, tabId, (tab) => ({ ...tab, liveTitle: title }))
}

export type ResizeTarget = { split: string; ratio: number } | { pane: string; share: number } | { group: string; share: number }

/** Sets one divider: by split ID and first-side ratio, or by the share a pane or group should get of its pair. */
export function resizeSplitOp(ws: Workspace, target: ResizeTarget): OpResult {
  if ('pane' in target) {
    const loc = locatePane(ws, target.pane)
    if (!loc) return fail('not-found', `no pane ${target.pane}`)
    const root = setPaneShare(loc.tab.root, target.pane, target.share)
    return root.ok ? ok(updateTab(ws, loc.tab.id, (tab) => ({ ...tab, root: root.value }))) : root
  }
  if ('group' in target) {
    const root = setGroupShare(ws.root, target.group, target.share)
    return root.ok ? ok({ ...ws, root: root.value }) : root
  }
  if (hasSplit(ws.root, target.split)) {
    const root = setGroupRatio(ws.root, target.split, target.ratio)
    return root.ok ? ok({ ...ws, root: root.value }) : root
  }
  const owner = paneSplitOwner(ws, target.split)
  if (!owner) return fail('not-found', `no split ${target.split}`)
  const root = setPaneRatio(owner.root, target.split, target.ratio)
  return root.ok ? ok(updateTab(ws, owner.id, (tab) => ({ ...tab, root: root.value }))) : root
}

/** Moves a pane to an edge of another pane, in the same tab or another tab of the workspace. */
export function movePaneToPane(ws: Workspace, paneId: string, toPaneId: string, edge: Edge, ids: IdSource): OpResult {
  const from = locatePane(ws, paneId)
  if (!from) return fail('not-found', `no pane ${paneId}`)
  const to = locatePane(ws, toPaneId)
  if (!to) return fail('not-found', `no pane ${toPaneId}`)
  if (paneId === toPaneId) return fail('invalid-params', "a pane can't be moved onto itself")
  if (from.tab.id === to.tab.id) {
    const root = movePaneInTree(from.tab.root, paneId, toPaneId, edge, ids)
    if (!root.ok) return root
    return ok(updateTab(ws, from.tab.id, (tab) => ({ ...tab, root: root.value, activePane: paneId, expandedPane: null })))
  }
  return moveAcross(ws, from, to.tab, (root) => insertPane(root, toPaneId, from.pane, edge, ids))
}

/** Moves a pane into another tab, beside that tab's active pane. */
export function movePaneToTab(ws: Workspace, paneId: string, toTabId: string, ids: IdSource): OpResult {
  const from = locatePane(ws, paneId)
  if (!from) return fail('not-found', `no pane ${paneId}`)
  const to = locateTab(ws, toTabId)
  if (!to) return fail('not-found', `no tab ${toTabId}`)
  if (from.tab.id === toTabId) return fail('invalid-params', `pane ${paneId} is already in tab ${toTabId}`)
  return moveAcross(ws, from, to.tab, (root) => insertPane(root, to.tab.activePane, from.pane, 'right', ids))
}

function moveAcross(ws: Workspace, from: PaneLocation, target: Tab, insert: (root: PaneNode) => OpResult<PaneNode>): OpResult {
  const remaining = removePane(from.tab.root, from.pane.id)
  if (!remaining) return fail('invalid-params', LAST_PANE_MESSAGE)
  const inserted = insert(target.root)
  if (!inserted.ok) return inserted
  const leaves = paneLeaves(remaining)
  const shrunk = updateTab(ws, from.tab.id, (tab) => ({
    ...tab,
    root: remaining,
    activePane: tab.activePane === from.pane.id ? leaves[0]!.id : tab.activePane,
    expandedPane: tab.expandedPane === from.pane.id || leaves.length < 2 ? null : tab.expandedPane
  }))
  const grown = updateTab(shrunk, target.id, (tab) => ({ ...tab, root: inserted.value, activePane: from.pane.id, expandedPane: null }))
  const group = locateTab(grown, target.id)!.group
  return ok(activate(grown, group.id, target.id))
}

/** Removes group `groupId`, keeping its tabs in the first group of the sibling side. */
export function closeGroupOp(ws: Workspace, groupId: string): OpResult {
  const removed = removeGroup(ws.root, groupId)
  if (!removed.ok) return removed
  return ok({ ...ws, root: removed.value.tree, activeGroup: ws.activeGroup === groupId ? removed.value.target : ws.activeGroup })
}

/** Binds a freshly started session as a new tab at the end of `groupId` and drops the closed tab it reopens. */
export function reopenTabOp(ws: Workspace, groupId: string, tab: Tab): OpResult {
  const appended = appendTab(ws, groupId, tab)
  return appended.ok ? ok({ ...appended.value, closed: ws.closed.slice(1) }) : appended
}

function repairTab(tab: Tab): Tab {
  const leaves = paneLeaves(tab.root)
  const ids = new Set(leaves.map((leaf) => leaf.id))
  const activePane = ids.has(tab.activePane) ? tab.activePane : leaves[0]!.id
  const expandedPane = tab.expandedPane !== null && ids.has(tab.expandedPane) && leaves.length > 1 ? tab.expandedPane : null
  return activePane === tab.activePane && expandedPane === tab.expandedPane ? tab : { ...tab, activePane, expandedPane }
}

function repairGroup(group: Group): Group {
  const tabs = group.tabs.map(repairTab)
  const present = new Set(tabs.map((tab) => tab.id))
  const recent = [...new Set(group.recent.filter((id) => present.has(id)))]
  const activeTab = group.activeTab !== null && present.has(group.activeTab) ? group.activeTab : (recentOrder(tabs, recent)[0] ?? null)
  return { ...group, tabs, activeTab, recent }
}

/**
 * Brings a workspace to a state the rest of the code can rely on: empty groups other than the
 * last are gone, every active ID (group, tab, pane) and recent list points at something that
 * exists, an expanded pane needs 2+ panes, and the closed list is capped.
 */
export function normalize(ws: Workspace): Workspace {
  let current: Workspace = ws
  for (const group of groupsInOrder(ws.root)) {
    if (group.tabs.length === 0) current = dropEmptyGroup(current, group.id)
  }
  const root = mapGroupNode(current.root, repairGroup)
  const groups = groupsInOrder(root)
  const activeGroup = groups.some((group) => group.id === current.activeGroup) ? current.activeGroup : groups[0]!.id
  return { ...current, root, activeGroup, closed: current.closed.slice(0, MAX_CLOSED_TABS) }
}

import { touchRecent } from './titles'
import { GROUP_RATIO_MAX, GROUP_RATIO_MIN } from './types'
import type { Edge, Group, GroupNode, GroupSplit, PaneLeaf, PaneNode, PaneSplit, SplitDirection } from './types'

/** Allocates the IDs of new tabs, groups, panes and splits (`tab-3`, `grp-1`, `pane-7`, `split-2`). */
export interface IdSource {
  next(kind: 'tab' | 'grp' | 'pane' | 'split'): string
}

/** An `IdSource` counting up from `start` across all kinds, as the store's single counter does. */
export function sequentialIds(start = 1): IdSource {
  let n = start
  return { next: (kind) => `${kind}-${n++}` }
}

/** Why an operation was refused, in the vocabulary the daemon's errors use. */
export type TreeError = { kind: 'not-found' | 'invalid-params'; message: string }
export type TreeResult<T> = { ok: true; value: T } | { ok: false; error: TreeError }

const ok = <T>(value: T): TreeResult<T> => ({ ok: true, value })
const fail = (kind: TreeError['kind'], message: string): TreeResult<never> => ({ ok: false, error: { kind, message } })

type AnyNode = PaneNode | GroupNode
type AnySplit = PaneSplit | GroupSplit

export type Rect = { x: number; y: number; width: number; height: number }
export type PaneRect = Rect & { pane: string }
export type DividerRect = Rect & { split: string; direction: SplitDirection; area: Rect }
export type GroupSide = 'right' | 'left' | 'down' | 'up'
export type DropZone = 'center' | 'left' | 'right' | 'up' | 'down'

export const PANE_RATIO_MESSAGE = 'a pane divider stays between 0 and 1'
export const GROUP_RATIO_MESSAGE = 'a group divider stays between 0.15 and 0.85'
export const LAST_GROUP_MESSAGE = "the last group of a workspace can't be closed"
export const SELF_MOVE_MESSAGE = "a pane can't be moved onto itself"

/** Ratios are stored rounded to three decimals. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 1000) / 1000
}

function isSplit(node: AnyNode): node is AnySplit {
  return node.kind === 'split'
}

function locate(tree: AnyNode, id: string, parent: AnySplit | null = null): { node: AnyNode; parent: AnySplit | null } | null {
  if (tree.id === id) return { node: tree, parent }
  if (!isSplit(tree)) return null
  return locate(tree.first, id, tree) ?? locate(tree.second, id, tree)
}

/** Replaces the node `id` with `replacement`, sharing every untouched subtree. */
function replaceNode<N extends AnyNode>(tree: N, id: string, replacement: AnyNode): N {
  if (tree.id === id) return replacement as N
  if (!isSplit(tree)) return tree
  const first = replaceNode(tree.first, id, replacement)
  const second = replaceNode(tree.second, id, replacement)
  return first === tree.first && second === tree.second ? tree : ({ ...tree, first, second } as N)
}

function edgeSplit(edge: Edge): { direction: SplitDirection; before: boolean } {
  return { direction: edge === 'left' || edge === 'right' ? 'right' : 'down', before: edge === 'left' || edge === 'top' }
}

function sideSplit(side: GroupSide): { direction: SplitDirection; before: boolean } {
  return { direction: side === 'left' || side === 'right' ? 'right' : 'down', before: side === 'left' || side === 'up' }
}

function checkRatio(ratio: number, min: number, max: number, inclusive: boolean, message: string): TreeResult<number> {
  const rounded = roundRatio(ratio)
  const valid = Number.isFinite(ratio) && (inclusive ? rounded >= min && rounded <= max : rounded > min && rounded < max)
  return valid ? ok(rounded) : fail('invalid-params', message)
}

const checkPaneRatio = (ratio: number) => checkRatio(ratio, 0, 1, false, PANE_RATIO_MESSAGE)
const checkGroupRatio = (ratio: number) => checkRatio(ratio, GROUP_RATIO_MIN, GROUP_RATIO_MAX, true, GROUP_RATIO_MESSAGE)

function setSplitRatio<N extends AnyNode>(tree: N, splitId: string, check: (ratio: number) => TreeResult<number>, ratio: number): TreeResult<N> {
  const hit = locate(tree, splitId)
  if (!hit || !isSplit(hit.node)) return fail('not-found', `no split ${splitId}`)
  const checked = check(ratio)
  if (!checked.ok) return checked
  return ok(replaceNode(tree, splitId, { ...hit.node, ratio: checked.value } as AnySplit))
}

/** Sets the divider of whichever split holds `id` so that `id` gets `share` of it. */
function setShare<N extends AnyNode>(tree: N, id: string, check: (ratio: number) => TreeResult<number>, share: number, noun: string): TreeResult<N> {
  const hit = locate(tree, id)
  if (!hit) return fail('not-found', `no ${noun} ${id}`)
  if (!hit.parent) return fail('invalid-params', `${noun} ${id} has no divider`)
  return setSplitRatio(tree, hit.parent.id, check, hit.parent.first.id === id ? share : 1 - share)
}

/** The panes of a tab in visual order (left to right, top to bottom). */
export function paneLeaves(tree: PaneNode): PaneLeaf[] {
  return tree.kind === 'pane' ? [tree] : [...paneLeaves(tree.first), ...paneLeaves(tree.second)]
}

/** The pane leaf `id`, or null. */
export function findPane(tree: PaneNode, id: string): PaneLeaf | null {
  const hit = locate(tree, id)
  return hit && hit.node.kind === 'pane' ? hit.node : null
}

/** The split that directly holds the pane or split `id`, or null for the root and for unknown IDs. */
export function paneParent(tree: PaneNode, id: string): PaneSplit | null {
  return (locate(tree, id)?.parent as PaneSplit | null | undefined) ?? null
}

/** The pane after (`offset` 1) or before (`-1`) `paneId` in visual order, wrapping; null for an unknown pane. */
export function neighborPane(tree: PaneNode, paneId: string, offset: 1 | -1): string | null {
  const leaves = paneLeaves(tree)
  const index = leaves.findIndex((leaf) => leaf.id === paneId)
  if (index < 0) return null
  return leaves[(index + offset + leaves.length) % leaves.length]!.id
}

/** Splits pane `paneId` in two: it stays first and `newLeaf` becomes `second`, each with half the space. */
export function splitPane(tree: PaneNode, paneId: string, direction: SplitDirection, newLeaf: PaneLeaf, ids: IdSource): TreeResult<PaneNode> {
  const target = findPane(tree, paneId)
  if (!target) return fail('not-found', `no pane ${paneId}`)
  const split: PaneSplit = { kind: 'split', id: ids.next('split'), direction, ratio: 0.5, first: target, second: newLeaf }
  return ok(replaceNode(tree, paneId, split))
}

/**
 * The tree without pane `paneId`: its sibling takes the parent split's place. Returns null when
 * that was the only pane, and the tree itself when the pane is not in it.
 */
export function removePane(tree: PaneNode, paneId: string): PaneNode | null {
  if (tree.kind === 'pane') return tree.id === paneId ? null : tree
  const first = removePane(tree.first, paneId)
  const second = removePane(tree.second, paneId)
  if (!first || !second) return first ?? second
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second }
}

/**
 * Puts `leaf` beside pane `targetId` on `edge`: left and right make a "right" split, top and
 * bottom a "down" split, with `leaf` first for left and top. The new split is 0.5.
 */
export function insertPane(tree: PaneNode, targetId: string, leaf: PaneLeaf, edge: Edge, ids: IdSource): TreeResult<PaneNode> {
  const target = findPane(tree, targetId)
  if (!target) return fail('not-found', `no pane ${targetId}`)
  const { direction, before } = edgeSplit(edge)
  const split: PaneSplit = {
    kind: 'split',
    id: ids.next('split'),
    direction,
    ratio: 0.5,
    first: before ? leaf : target,
    second: before ? target : leaf
  }
  return ok(replaceNode(tree, targetId, split))
}

/**
 * Moves pane `paneId` to the `edge` of pane `toPaneId` within one tab. The pane keeps its ID and
 * session. A pane can't move onto itself.
 */
export function movePane(tree: PaneNode, paneId: string, toPaneId: string, edge: Edge, ids: IdSource): TreeResult<PaneNode> {
  const moving = findPane(tree, paneId)
  if (!moving) return fail('not-found', `no pane ${paneId}`)
  if (!findPane(tree, toPaneId)) return fail('not-found', `no pane ${toPaneId}`)
  if (paneId === toPaneId) return fail('invalid-params', SELF_MOVE_MESSAGE)
  const rest = removePane(tree, paneId)
  return rest ? insertPane(rest, toPaneId, moving, edge, ids) : fail('invalid-params', SELF_MOVE_MESSAGE)
}

/** How many panes sit along `direction` in a chain of splits of that direction; any other node counts as one. */
function axisWeight(node: PaneNode, direction: SplitDirection): number {
  return node.kind === 'split' && node.direction === direction ? axisWeight(node.first, direction) + axisWeight(node.second, direction) : 1
}

/** Gives every split the share its first side's panes deserve, so three panes side by side become thirds. */
export function equalize(tree: PaneNode): PaneNode {
  if (tree.kind === 'pane') return tree
  const first = axisWeight(tree.first, tree.direction)
  const second = axisWeight(tree.second, tree.direction)
  return { ...tree, ratio: roundRatio(first / (first + second)), first: equalize(tree.first), second: equalize(tree.second) }
}

/** Sets pane split `splitId` to `ratio`, the first side's share, strictly between 0 and 1. */
export function setPaneRatio(tree: PaneNode, splitId: string, ratio: number): TreeResult<PaneNode> {
  return setSplitRatio(tree, splitId, checkPaneRatio, ratio)
}

/** Resizes the divider next to pane `paneId` so the pane gets `share` of the pair. */
export function setPaneShare(tree: PaneNode, paneId: string, share: number): TreeResult<PaneNode> {
  return setShare(tree, paneId, checkPaneRatio, share, 'pane')
}

/** Every group of a workspace in visual order. */
export function groupsInOrder(tree: GroupNode): Group[] {
  return tree.kind === 'group' ? [tree] : [...groupsInOrder(tree.first), ...groupsInOrder(tree.second)]
}

/** The group `id`, or null. */
export function findGroup(tree: GroupNode, id: string): Group | null {
  const hit = locate(tree, id)
  return hit && hit.node.kind === 'group' ? hit.node : null
}

/** The split that directly holds the group or split `id`, or null for the root and for unknown IDs. */
export function groupParent(tree: GroupNode, id: string): GroupSplit | null {
  return (locate(tree, id)?.parent as GroupSplit | null | undefined) ?? null
}

/** The leftmost-topmost group of a subtree: depth-first, `first` child first. */
export function firstGroup(tree: GroupNode): Group {
  return tree.kind === 'group' ? tree : firstGroup(tree.first)
}

/** Opens `newGroup` beside group `groupId` on `side`, splitting its area 0.5. */
export function insertGroup(tree: GroupNode, groupId: string, side: GroupSide, newGroup: Group, ids: IdSource): TreeResult<GroupNode> {
  const target = findGroup(tree, groupId)
  if (!target) return fail('not-found', `no group ${groupId}`)
  const { direction, before } = sideSplit(side)
  const split: GroupSplit = {
    kind: 'split',
    id: ids.next('split'),
    direction,
    ratio: 0.5,
    first: before ? newGroup : target,
    second: before ? target : newGroup
  }
  return ok(replaceNode(tree, groupId, split))
}

/**
 * Removes group `groupId` and keeps its tabs: they are appended, in order, to the first group of
 * the sibling subtree, which takes over the group's active tab; the sibling replaces the parent
 * split. `target` is the ID of the group that received the tabs. The only group can't be removed.
 */
export function removeGroup(tree: GroupNode, groupId: string): TreeResult<{ tree: GroupNode; target: string }> {
  const hit = locate(tree, groupId)
  if (!hit || hit.node.kind !== 'group') return fail('not-found', `no group ${groupId}`)
  const closing = hit.node
  const parent = hit.parent as GroupSplit | null
  if (!parent) return fail('invalid-params', LAST_GROUP_MESSAGE)
  const sibling = parent.first.id === groupId ? parent.second : parent.first
  const receiver = firstGroup(sibling)
  const moved = closing.tabs.map((tab) => tab.id)
  const activeTab = closing.activeTab ?? receiver.activeTab
  let recent = [...new Set([...receiver.recent, ...closing.recent.filter((id) => moved.includes(id)), ...moved])]
  if (activeTab) recent = touchRecent(recent, activeTab)
  const merged: Group = { ...receiver, tabs: [...receiver.tabs, ...closing.tabs], activeTab, recent }
  return ok({ tree: replaceNode(tree, parent.id, replaceNode(sibling, receiver.id, merged)), target: receiver.id })
}

/** Sets group split `splitId` to `ratio`, the first side's share, between 0.15 and 0.85. */
export function setGroupRatio(tree: GroupNode, splitId: string, ratio: number): TreeResult<GroupNode> {
  return setSplitRatio(tree, splitId, checkGroupRatio, ratio)
}

/** Resizes the divider next to group `groupId` so the group gets `share` of the pair. */
export function setGroupShare(tree: GroupNode, groupId: string, share: number): TreeResult<GroupNode> {
  return setShare(tree, groupId, checkGroupRatio, share, 'group')
}

/**
 * Where a dragged tab lands on a group body: the middle 80% merges ('center'); outside it the
 * left and right thirds open a group on that side and the middle third opens one above or below.
 * In a group that is already split, the outer 20% of the width and height open a split instead,
 * so a drop near a group's edge never merges. `rect` is the body (below the tab strip).
 */
export function dropZone(rect: { left: number; top: number; width: number; height: number }, point: { x: number; y: number }, isSplitGroup: boolean): DropZone {
  const x = point.x - rect.left
  const y = point.y - rect.top

  if (isSplitGroup) {
    const edgeX = rect.width * 0.2
    const edgeY = rect.height * 0.2
    if (x < edgeX) return 'left'
    if (x > rect.width - edgeX) return 'right'
    if (y < edgeY) return 'up'
    if (y > rect.height - edgeY) return 'down'
  }

  const insetX = rect.width * 0.1
  const insetY = rect.height * 0.1
  if (x > insetX && x < rect.width - insetX && y > insetY && y < rect.height - insetY) return 'center'

  const third = rect.width / 3
  if (x < third) return 'left'
  if (x > third * 2) return 'right'
  return y < rect.height / 2 ? 'up' : 'down'
}

/** The size of a split's first side in pixels, never leaving either side under `minPx` (or half the pair when the pair is smaller). */
function firstSize(total: number, ratio: number, minPx: number): number {
  const min = Math.min(minPx, total / 2)
  return Math.min(Math.max(total * ratio, min), total - min)
}

/**
 * Lays a pane tree out in a `width` x `height` area: one rectangle per pane, tiling the area with
 * no gaps, and one rectangle per divider, `dividerPx` thick and centred on the seam between its
 * two sides (so dividers overlay the panes). No pane is drawn narrower than `minPx`, or half
 * the pair when the pair is smaller. `area` of a divider is the whole rectangle its split divides,
 * for turning a pointer position into a ratio.
 */
export function paneRects(tree: PaneNode, width: number, height: number, minPx = 50, dividerPx = 3): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = []
  const dividers: DividerRect[] = []

  const walk = (node: PaneNode, area: Rect) => {
    if (node.kind === 'pane') {
      panes.push({ pane: node.id, ...area })
      return
    }
    if (node.direction === 'right') {
      const w = firstSize(area.width, node.ratio, minPx)
      dividers.push({ split: node.id, direction: 'right', x: area.x + w - dividerPx / 2, y: area.y, width: dividerPx, height: area.height, area })
      walk(node.first, { ...area, width: w })
      walk(node.second, { ...area, x: area.x + w, width: area.width - w })
    } else {
      const h = firstSize(area.height, node.ratio, minPx)
      dividers.push({ split: node.id, direction: 'down', x: area.x, y: area.y + h - dividerPx / 2, width: area.width, height: dividerPx, area })
      walk(node.first, { ...area, height: h })
      walk(node.second, { ...area, y: area.y + h, height: area.height - h })
    }
  }

  walk(tree, { x: 0, y: 0, width, height })
  return { panes, dividers }
}

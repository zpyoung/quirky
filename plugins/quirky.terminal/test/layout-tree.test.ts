import { describe, expect, test } from 'bun:test'
import {
  dropZone,
  equalize,
  findGroup,
  findPane,
  firstGroup,
  groupParent,
  groupsInOrder,
  insertGroup,
  insertPane,
  movePane,
  neighborPane,
  paneLeaves,
  paneParent,
  paneRects,
  removeGroup,
  removePane,
  roundRatio,
  sequentialIds,
  setGroupRatio,
  setGroupShare,
  setPaneRatio,
  setPaneShare,
  splitPane,
  type TreeResult
} from '../src/layout/tree'
import type { Group, GroupNode, PaneLeaf, PaneNode, PaneSplit, TerminalTab } from '../src/layout/types'

const leaf = (id: string): PaneLeaf => ({ kind: 'pane', id, session: `s-${id}`, title: null, exit: null })
const split = (id: string, direction: 'right' | 'down', first: PaneNode, second: PaneNode, ratio = 0.5): PaneSplit => ({ kind: 'split', id, direction, ratio, first, second })
const tab = (id: string): TerminalTab => ({
  id,
  defaultTitle: id,
  customTitle: null,
  liveTitle: null,
  color: 'none',
  pinned: false,
  root: leaf(`pane-of-${id}`),
  activePane: `pane-of-${id}`,
  expandedPane: null,
  createdAt: '2026-10-26T00:00:00.000Z'
})
const group = (id: string, tabIds: string[], activeTab: string | null = tabIds[0] ?? null, recent: string[] = tabIds): Group => ({
  kind: 'group',
  id,
  tabs: tabIds.map(tab),
  activeTab,
  recent,
  lastQuickCommand: null
})
const gsplit = (id: string, direction: 'right' | 'down', first: GroupNode, second: GroupNode, ratio = 0.5): GroupNode => ({ kind: 'split', id, direction, ratio, first, second })

function unwrap<T>(result: TreeResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`)
  return result.value
}
const ids = (tree: PaneNode) => paneLeaves(tree).map((p) => p.id)

describe('pane lookup', () => {
  // pane-2 | (pane-3 / pane-4)
  const tree = split('split-1', 'right', leaf('pane-2'), split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))

  test('leaves come in visual order', () => {
    expect(ids(tree)).toEqual(['pane-2', 'pane-3', 'pane-4'])
  })

  test('finds a pane and its parent split', () => {
    expect(findPane(tree, 'pane-3')?.session).toBe('s-pane-3')
    expect(findPane(tree, 'split-2')).toBeNull()
    expect(findPane(tree, 'pane-99')).toBeNull()
    expect(paneParent(tree, 'pane-3')?.id).toBe('split-2')
    expect(paneParent(tree, 'split-2')?.id).toBe('split-1')
    expect(paneParent(tree, 'split-1')).toBeNull()
    expect(paneParent(tree, 'pane-99')).toBeNull()
  })

  test('SC-28: next and previous pane wrap', () => {
    expect(neighborPane(tree, 'pane-4', 1)).toBe('pane-2')
    expect(neighborPane(tree, 'pane-2', -1)).toBe('pane-4')
    expect(neighborPane(tree, 'pane-2', 1)).toBe('pane-3')
    expect(neighborPane(tree, 'pane-3', -1)).toBe('pane-2')
    expect(neighborPane(tree, 'pane-99', 1)).toBeNull()
    expect(neighborPane(leaf('pane-1'), 'pane-1', 1)).toBe('pane-1')
  })
})

describe('splitPane', () => {
  test('SC-23: splitting right keeps the pane first and puts the new pane second at 0.5', () => {
    const tree = unwrap(splitPane(leaf('pane-2'), 'pane-2', 'right', leaf('pane-3'), sequentialIds(10)))
    expect(tree).toMatchObject({ kind: 'split', id: 'split-10', direction: 'right', ratio: 0.5 })
    expect(ids(tree)).toEqual(['pane-2', 'pane-3'])
  })

  test('SC-23: a second split down inside the new pane makes a right column', () => {
    const idSource = sequentialIds(10)
    const once = unwrap(splitPane(leaf('pane-2'), 'pane-2', 'right', leaf('pane-3'), idSource))
    const twice = unwrap(splitPane(once, 'pane-3', 'down', leaf('pane-4'), idSource))
    expect(twice).toEqual(
      split('split-10', 'right', leaf('pane-2'), split('split-11', 'down', leaf('pane-3'), leaf('pane-4')))
    )
  })

  test('does not mutate its input and shares the untouched subtree', () => {
    const left = leaf('pane-2')
    const tree = split('split-1', 'right', left, leaf('pane-3'))
    const before = structuredClone(tree)
    const next = unwrap(splitPane(tree, 'pane-3', 'down', leaf('pane-4'), sequentialIds(5))) as PaneSplit
    expect(tree).toEqual(before)
    expect(next.first).toBe(left)
  })

  test('an unknown pane is not found', () => {
    expect(splitPane(leaf('pane-1'), 'pane-9', 'right', leaf('pane-2'), sequentialIds())).toEqual({
      ok: false,
      error: { kind: 'not-found', message: 'no pane pane-9' }
    })
  })
})

describe('removePane', () => {
  test('SC-29: the sibling takes the parent split place', () => {
    const tree = split('split-1', 'right', leaf('pane-2'), split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))
    expect(removePane(tree, 'pane-3')).toEqual(split('split-1', 'right', leaf('pane-2'), leaf('pane-4')))
    expect(removePane(tree, 'pane-2')).toEqual(split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))
  })

  test('removing the only pane leaves nothing', () => {
    expect(removePane(leaf('pane-1'), 'pane-1')).toBeNull()
  })

  test('an unknown pane leaves the very same tree', () => {
    const tree = split('split-1', 'right', leaf('pane-2'), leaf('pane-3'))
    expect(removePane(tree, 'pane-9')).toBe(tree)
  })
})

describe('movePane', () => {
  const base = () => split('split-1', 'right', leaf('pane-2'), leaf('pane-3'))

  test('SC-26: dropping on the top edge puts the pane above the target in a down split', () => {
    const tree = unwrap(movePane(base(), 'pane-3', 'pane-2', 'top', sequentialIds(7)))
    expect(tree).toEqual(split('split-7', 'down', leaf('pane-3'), leaf('pane-2')))
  })

  test.each([
    ['left', 'right', ['pane-3', 'pane-2']],
    ['right', 'right', ['pane-2', 'pane-3']],
    ['top', 'down', ['pane-3', 'pane-2']],
    ['bottom', 'down', ['pane-2', 'pane-3']]
  ] as const)('the %s edge makes a %s split in order %p', (edge, direction, order) => {
    const tree = unwrap(movePane(base(), 'pane-3', 'pane-2', edge, sequentialIds(7))) as PaneSplit
    expect(tree.direction).toBe(direction)
    expect(tree.ratio).toBe(0.5)
    expect(ids(tree)).toEqual([...order])
  })

  test('moves a pane within a deeper tree, keeping its session', () => {
    const tree = split('split-1', 'right', leaf('pane-2'), split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))
    const moved = unwrap(movePane(tree, 'pane-4', 'pane-2', 'bottom', sequentialIds(7)))
    expect(moved).toEqual(split('split-1', 'right', split('split-7', 'down', leaf('pane-2'), leaf('pane-4')), leaf('pane-3')))
    expect(findPane(moved, 'pane-4')?.session).toBe('s-pane-4')
  })

  test('rejects a move onto itself', () => {
    expect(movePane(base(), 'pane-2', 'pane-2', 'left', sequentialIds())).toEqual({
      ok: false,
      error: { kind: 'invalid-params', message: "a pane can't be moved onto itself" }
    })
  })

  test('rejects unknown panes', () => {
    expect(movePane(base(), 'pane-9', 'pane-2', 'left', sequentialIds())).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no pane pane-9' } })
    expect(movePane(base(), 'pane-2', 'pane-9', 'left', sequentialIds())).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no pane pane-9' } })
  })

  test('insertPane places a pane from another tab beside a target', () => {
    const tree = unwrap(insertPane(leaf('pane-1'), 'pane-1', leaf('pane-5'), 'right', sequentialIds(3)))
    expect(tree).toEqual(split('split-3', 'right', leaf('pane-1'), leaf('pane-5')))
  })
})

describe('equalize', () => {
  test('SC-25: three panes made by splitting right twice become thirds', () => {
    const tree = split('split-1', 'right', leaf('pane-2'), split('split-2', 'right', leaf('pane-3'), leaf('pane-4')))
    expect(equalize(tree)).toEqual(split('split-1', 'right', leaf('pane-2'), split('split-2', 'right', leaf('pane-3'), leaf('pane-4'), 0.5), 0.333))
  })

  test('SC-25: the left-leaning chain weighs its first side', () => {
    const tree = split('split-1', 'right', split('split-2', 'right', leaf('pane-2'), leaf('pane-3'), 0.2), leaf('pane-4'), 0.9)
    expect((equalize(tree) as PaneSplit).ratio).toBe(0.667)
  })

  test('four panes in a row are quarters at every level', () => {
    const row = split('s1', 'right', leaf('a'), split('s2', 'right', leaf('b'), split('s3', 'right', leaf('c'), leaf('d'))))
    const out = equalize(row) as PaneSplit
    const mid = out.second as PaneSplit
    expect([out.ratio, mid.ratio, (mid.second as PaneSplit).ratio]).toEqual([0.25, 0.333, 0.5])
  })

  test('a split on the other axis counts as one pane', () => {
    // a | (b / c / d stacked): the right side is one column, so the top split is 0.5
    const column = split('s2', 'down', leaf('b'), split('s3', 'down', leaf('c'), leaf('d')), 0.9)
    const out = equalize(split('s1', 'right', leaf('a'), column, 0.2)) as PaneSplit
    expect(out.ratio).toBe(0.5)
    expect((out.second as PaneSplit).ratio).toBe(0.333)
  })

  test('a lone pane is unchanged', () => {
    const only = leaf('pane-1')
    expect(equalize(only)).toBe(only)
  })
})

describe('pane ratios', () => {
  const tree = split('split-1', 'right', leaf('pane-2'), leaf('pane-3'))

  test('SC-24: sets the first side share and rounds to three decimals', () => {
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.3)) as PaneSplit).ratio).toBe(0.3)
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.123456)) as PaneSplit).ratio).toBe(0.123)
    expect(roundRatio(0.3333333)).toBe(0.333)
  })

  test('SC-24: the pane form sets the pane share from either side', () => {
    expect((unwrap(setPaneShare(tree, 'pane-2', 0.3)) as PaneSplit).ratio).toBe(0.3)
    expect((unwrap(setPaneShare(tree, 'pane-3', 0.3)) as PaneSplit).ratio).toBe(0.7)
  })

  test.each([0, 1, -0.2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p as a pane ratio', (ratio) => {
    expect(setPaneRatio(tree, 'split-1', ratio)).toEqual({ ok: false, error: { kind: 'invalid-params', message: 'a pane divider stays between 0 and 1' } })
  })

  test('a ratio strictly between 0 and 1 is valid even when it rounds to an endpoint, and is stored as 0.001 or 0.999', () => {
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.0001)) as PaneSplit).ratio).toBe(0.001)
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.0004)) as PaneSplit).ratio).toBe(0.001)
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.9996)) as PaneSplit).ratio).toBe(0.999)
  })

  test('accepts the extremes the window will clamp when drawing', () => {
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.001)) as PaneSplit).ratio).toBe(0.001)
    expect((unwrap(setPaneRatio(tree, 'split-1', 0.999)) as PaneSplit).ratio).toBe(0.999)
  })

  test('unknown or non-split targets are not found, and a root pane has no divider', () => {
    expect(setPaneRatio(tree, 'split-9', 0.4)).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no split split-9' } })
    expect(setPaneRatio(tree, 'pane-2', 0.4)).toMatchObject({ ok: false, error: { kind: 'not-found' } })
    expect(setPaneShare(tree, 'pane-9', 0.4)).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no pane pane-9' } })
    expect(setPaneShare(leaf('pane-1'), 'pane-1', 0.4)).toMatchObject({ ok: false, error: { kind: 'invalid-params' } })
  })

  test('the share of a pane in a nested split sets only its own parent', () => {
    const nested = split('split-1', 'right', leaf('pane-2'), split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))
    const out = unwrap(setPaneShare(nested, 'pane-4', 0.25)) as PaneSplit
    expect(out.ratio).toBe(0.5)
    expect((out.second as PaneSplit).ratio).toBe(0.75)
  })
})

describe('group tree', () => {
  const g = (id: string) => findGroup(layout, id)
  let layout: GroupNode
  // grp-1 | (grp-2 / grp-3)
  layout = gsplit('split-1', 'right', group('grp-1', ['tab-1']), gsplit('split-2', 'down', group('grp-2', ['tab-2', 'tab-3'], 'tab-3', ['tab-3', 'tab-2']), group('grp-3', ['tab-4'])))

  test('lists groups in visual order and finds them', () => {
    expect(groupsInOrder(layout).map((x) => x.id)).toEqual(['grp-1', 'grp-2', 'grp-3'])
    expect(g('grp-3')?.tabs.map((t) => t.id)).toEqual(['tab-4'])
    expect(g('grp-9')).toBeNull()
    expect(groupParent(layout, 'grp-3')?.id).toBe('split-2')
    expect(groupParent(layout, 'split-1')).toBeNull()
  })

  test('the first group of a subtree is depth-first, first child first', () => {
    expect(firstGroup(layout).id).toBe('grp-1')
    expect(firstGroup((layout as { second: GroupNode }).second).id).toBe('grp-2')
  })

  test.each([
    ['right', 'right', ['grp-1', 'grp-new']],
    ['left', 'right', ['grp-new', 'grp-1']],
    ['down', 'down', ['grp-1', 'grp-new']],
    ['up', 'down', ['grp-new', 'grp-1']]
  ] as const)('SC-45: a new group on the %s side makes a %s split', (side, direction, order) => {
    const out = unwrap(insertGroup(group('grp-1', ['tab-1']), 'grp-1', side, group('grp-new', []), sequentialIds(8)))
    expect(out).toMatchObject({ kind: 'split', id: 'split-8', direction, ratio: 0.5 })
    expect(groupsInOrder(out).map((x) => x.id)).toEqual([...order])
  })

  test('inserting beside an unknown group is not found', () => {
    expect(insertGroup(layout, 'grp-9', 'right', group('grp-new', []), sequentialIds())).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no group grp-9' } })
  })

  test('SC-48: closing a group appends its tabs to the sibling and the sibling takes the split', () => {
    const two = gsplit('split-1', 'right', group('grp-1', ['tab-1'], 'tab-1'), group('grp-2', ['tab-2', 'tab-3'], 'tab-3', ['tab-3', 'tab-2']))
    const { tree, target } = unwrap(removeGroup(two, 'grp-2'))
    expect(target).toBe('grp-1')
    expect(tree.kind).toBe('group')
    const merged = tree as Group
    expect(merged.id).toBe('grp-1')
    expect(merged.tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3'])
    expect(merged.activeTab).toBe('tab-3')
    expect(merged.recent).toEqual(['tab-3', 'tab-1', 'tab-2'])
  })

  test('SC-48: closing the first group sends its tabs to the other side', () => {
    const two = gsplit('split-1', 'right', group('grp-1', ['tab-1']), group('grp-2', ['tab-2'], 'tab-2'))
    const { tree, target } = unwrap(removeGroup(two, 'grp-1'))
    expect(target).toBe('grp-2')
    expect((tree as Group).tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-1'])
    expect((tree as Group).activeTab).toBe('tab-1')
  })

  test('SC-48: a split sibling gives its leftmost-topmost group the tabs', () => {
    const { tree, target } = unwrap(removeGroup(layout, 'grp-1'))
    expect(target).toBe('grp-2')
    expect(tree.kind).toBe('split')
    expect(tree.id).toBe('split-2')
    const receiver = findGroup(tree, 'grp-2')!
    expect(receiver.tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1'])
    expect(receiver.activeTab).toBe('tab-1')
    expect(findGroup(tree, 'grp-3')?.tabs.map((t) => t.id)).toEqual(['tab-4'])
  })

  test('an empty group closing keeps the receiver active tab', () => {
    const two = gsplit('split-1', 'right', group('grp-1', ['tab-1']), group('grp-2', []))
    const { tree } = unwrap(removeGroup(two, 'grp-2'))
    expect(tree).toMatchObject({ id: 'grp-1', activeTab: 'tab-1' })
  })

  test('SC-48: the last group is never removed', () => {
    expect(removeGroup(group('grp-1', ['tab-1']), 'grp-1')).toEqual({
      ok: false,
      error: { kind: 'invalid-params', message: "the last group of a workspace can't be closed" }
    })
    expect(removeGroup(layout, 'grp-9')).toMatchObject({ ok: false, error: { kind: 'not-found', message: 'no group grp-9' } })
  })

  test('SC-47: group dividers stay between 0.15 and 0.85', () => {
    expect((unwrap(setGroupRatio(layout, 'split-1', 0.15)) as { ratio: number }).ratio).toBe(0.15)
    expect((unwrap(setGroupRatio(layout, 'split-1', 0.85)) as { ratio: number }).ratio).toBe(0.85)
    for (const bad of [0.1, 0.9, 0.149, 0.1499, 0.8501, 0.851, 0, 1, Number.NaN]) {
      expect(setGroupRatio(layout, 'split-1', bad)).toEqual({ ok: false, error: { kind: 'invalid-params', message: 'a group divider stays between 0.15 and 0.85' } })
    }
  })

  test('SC-7: resizing a group by share past the limit gives the exact message', () => {
    const two = gsplit('split-1', 'right', group('grp-1', ['tab-1']), group('grp-2', ['tab-2']))
    expect(setGroupShare(two, 'grp-1', 0.9)).toEqual({ ok: false, error: { kind: 'invalid-params', message: 'a group divider stays between 0.15 and 0.85' } })
    expect((unwrap(setGroupShare(two, 'grp-1', 0.3)) as { ratio: number }).ratio).toBe(0.3)
    expect((unwrap(setGroupShare(two, 'grp-2', 0.3)) as { ratio: number }).ratio).toBe(0.7)
  })
})

describe('dropZone', () => {
  // SC-46: a 900 px wide, 600 px high group body at the origin
  const rect = { left: 0, top: 0, width: 900, height: 600 }

  test('SC-46: the middle 80% merges', () => {
    expect(dropZone(rect, { x: 450, y: 300 }, false)).toBe('center')
    expect(dropZone(rect, { x: 91, y: 61 }, false)).toBe('center')
    expect(dropZone(rect, { x: 809, y: 539 }, false)).toBe('center')
  })

  test('SC-46: outside the centre the left third opens left and the right third opens right', () => {
    expect(dropZone(rect, { x: 50, y: 300 }, false)).toBe('left')
    expect(dropZone(rect, { x: 299, y: 20 }, false)).toBe('left')
    expect(dropZone(rect, { x: 850, y: 300 }, false)).toBe('right')
    expect(dropZone(rect, { x: 601, y: 580 }, false)).toBe('right')
  })

  test('SC-46: in the middle third the top half opens up and the bottom half down', () => {
    expect(dropZone(rect, { x: 450, y: 20 }, false)).toBe('up')
    expect(dropZone(rect, { x: 450, y: 59 }, false)).toBe('up')
    expect(dropZone(rect, { x: 450, y: 560 }, false)).toBe('down')
    expect(dropZone(rect, { x: 450, y: 541 }, false)).toBe('down')
  })

  test('SC-46: the centre borders are outside the centre', () => {
    expect(dropZone(rect, { x: 90, y: 300 }, false)).toBe('left')
    expect(dropZone(rect, { x: 810, y: 300 }, false)).toBe('right')
    expect(dropZone(rect, { x: 450, y: 60 }, false)).toBe('up')
    expect(dropZone(rect, { x: 450, y: 540 }, false)).toBe('down')
  })

  test('SC-46: in a split group the outer 20% of the width and height open a split instead of merging', () => {
    expect(dropZone(rect, { x: 150, y: 300 }, true)).toBe('left')
    expect(dropZone(rect, { x: 751, y: 300 }, true)).toBe('right')
    expect(dropZone(rect, { x: 450, y: 100 }, true)).toBe('up')
    expect(dropZone(rect, { x: 450, y: 500 }, true)).toBe('down')
    // the same two points merge in an unsplit group
    expect(dropZone(rect, { x: 450, y: 100 }, false)).toBe('center')
    expect(dropZone(rect, { x: 450, y: 500 }, false)).toBe('center')
  })

  test('SC-46: in a split group the middle of the body still merges', () => {
    expect(dropZone(rect, { x: 450, y: 300 }, true)).toBe('center')
    expect(dropZone(rect, { x: 181, y: 121 }, true)).toBe('center')
  })

  test('uses the rect origin', () => {
    const offset = { left: 200, top: 100, width: 900, height: 600 }
    expect(dropZone(offset, { x: 650, y: 400 }, false)).toBe('center')
    expect(dropZone(offset, { x: 220, y: 400 }, false)).toBe('left')
  })
})

describe('paneRects', () => {
  test('a lone pane fills the area', () => {
    expect(paneRects(leaf('pane-1'), 800, 600)).toEqual({ panes: [{ pane: 'pane-1', x: 0, y: 0, width: 800, height: 600 }], dividers: [] })
  })

  test('SC-23: a right split halves the width and a down split halves the height', () => {
    const tree = split('split-1', 'right', leaf('pane-2'), split('split-2', 'down', leaf('pane-3'), leaf('pane-4')))
    const { panes, dividers } = paneRects(tree, 1000, 600, 50, 4)
    expect(panes).toEqual([
      { pane: 'pane-2', x: 0, y: 0, width: 500, height: 600 },
      { pane: 'pane-3', x: 500, y: 0, width: 500, height: 300 },
      { pane: 'pane-4', x: 500, y: 300, width: 500, height: 300 }
    ])
    expect(dividers).toEqual([
      { split: 'split-1', direction: 'right', x: 498, y: 0, width: 4, height: 600, area: { x: 0, y: 0, width: 1000, height: 600 } },
      { split: 'split-2', direction: 'down', x: 500, y: 298, width: 500, height: 4, area: { x: 500, y: 0, width: 500, height: 600 } }
    ])
  })

  test('SC-24: the ratio places the divider', () => {
    const { panes } = paneRects(split('s', 'right', leaf('a'), leaf('b'), 0.3), 1000, 600)
    expect(panes.map((p) => p.width)).toEqual([300, 700])
  })

  test('SC-24: no pane is drawn narrower than 50 px', () => {
    const left = paneRects(split('s', 'right', leaf('a'), leaf('b'), 0.01), 1000, 600).panes
    expect(left.map((p) => p.width)).toEqual([50, 950])
    const right = paneRects(split('s', 'right', leaf('a'), leaf('b'), 0.99), 1000, 600).panes
    expect(right.map((p) => p.width)).toEqual([950, 50])
    const down = paneRects(split('s', 'down', leaf('a'), leaf('b'), 0.01), 1000, 600).panes
    expect(down.map((p) => p.height)).toEqual([50, 550])
  })

  test('SC-24: a pair under twice the minimum splits in halves', () => {
    const { panes } = paneRects(split('s', 'right', leaf('a'), leaf('b'), 0.1), 80, 600)
    expect(panes.map((p) => p.width)).toEqual([40, 40])
  })

  test('a custom minimum applies', () => {
    const { panes } = paneRects(split('s', 'right', leaf('a'), leaf('b'), 0.01), 1000, 600, 120)
    expect(panes.map((p) => p.width)).toEqual([120, 880])
  })
})

describe('id source', () => {
  test('ids are unique across kinds and counted up', () => {
    const source = sequentialIds(4)
    expect([source.next('tab'), source.next('pane'), source.next('split'), source.next('grp')]).toEqual(['tab-4', 'pane-5', 'split-6', 'grp-7'])
  })
})

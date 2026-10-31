import { describe, expect, test } from 'bun:test'
import type { UiToolEntry, UiToolLayout } from '@quirky/protocol'
import {
  clampToolResize,
  effectiveToolPlacement,
  fitToolShellGeometry,
  formatChord,
  getToolShellOpenSlots,
  hideTrailingTools,
  toolShortcut,
  resolveToolDropId,
  resizeFromPointerDelta,
  type ToolShellChrome,
  type ToolShellOpenSlots
} from '../src/shell/ToolShell'

const sizes: UiToolLayout['sizes'] = {
  left: 420,
  right: 480,
  bottom: 320,
  leftSplit: 0.4,
  rightSplit: 0.6,
  bottomSplit: 0.35
}
const GAP = 5
const RAIL = 42
const chrome: ToolShellChrome = {
  rail: RAIL,
  splitter: 4,
  gap: GAP,
  centerMinWidth: 320,
  centerMinHeight: 120
}
const allOpen: ToolShellOpenSlots = {
  'left-top': true,
  'left-bottom': true,
  'right-top': true,
  'right-bottom': true,
  'bottom-left': true,
  'bottom-right': true
}

function tool(id: string, defaultSlot: UiToolEntry['defaultSlot']): UiToolEntry {
  return { id, title: id, icon: id, hue: 'slate', defaultSlot, contributionId: id, aliases: [] }
}

describe('tool shell geometry and gestures', () => {
  test('resize values honor daemon bounds for dimensions and split ratios', () => {
    expect(clampToolResize('left', 20)).toBe(160)
    expect(clampToolResize('right', 1500)).toBe(1200)
    expect(clampToolResize('bottom', 20)).toBe(100)
    expect(clampToolResize('bottom', 1200)).toBe(1000)
    expect(clampToolResize('leftSplit', 0)).toBe(0.15)
    expect(clampToolResize('rightSplit', 1)).toBe(0.85)
    expect(clampToolResize('bottomSplit', 0.5)).toBe(0.5)
  })

  test('side slots open independently and an unknown stored occupant is not rendered', () => {
    const tools = [
      tool('worktrees', 'left-top'),
      tool('tasks', 'left-bottom'),
      tool('changes', 'right-top')
    ]
    const layout: UiToolLayout = {
      placements: { worktrees: 'left-top', tasks: 'left-bottom', changes: 'right-top' },
      order: ['worktrees', 'tasks', 'changes'],
      open: {
        'left-top': 'worktrees',
        'left-bottom': 'tasks',
        'right-top': 'changes',
        'right-bottom': 'disabled-tool',
        'bottom-left': null,
        'bottom-right': null
      },
      sizes
    }

    expect(getToolShellOpenSlots(tools, layout)).toEqual({
      'left-top': true,
      'left-bottom': true,
      'right-top': true,
      'right-bottom': false,
      'bottom-left': false,
      'bottom-right': false
    })
  })

  test('a tool placed in overflow has no slot and never counts as open', () => {
    const tools = [tool('tasks', 'left-bottom'), tool('changes', 'right-top')]
    const layout: UiToolLayout = {
      placements: { tasks: 'overflow', changes: 'right-top' },
      order: ['tasks', 'changes'],
      open: {
        'left-top': null,
        'left-bottom': 'tasks',
        'right-top': 'changes',
        'right-bottom': null,
        'bottom-left': null,
        'bottom-right': null
      },
      sizes
    }

    expect(effectiveToolPlacement(tools[0]!, layout)).toBeNull()
    expect(effectiveToolPlacement(tools[1]!, layout)).toBe('right-top')
    expect(getToolShellOpenSlots(tools, layout)).toMatchObject({ 'left-bottom': false, 'right-top': true })
  })

  test('contracts both side panels and the bottom panel without changing saved preferences', () => {
    const preferences = { ...sizes, left: 1200, right: 1200, bottom: 1000 }
    const fitted = fitToolShellGeometry(preferences, { width: 700, height: 400 }, allOpen, chrome)

    expect(fitted.leftPanelWidth).toBeLessThan(preferences.left)
    expect(fitted.rightPanelWidth).toBeLessThan(preferences.right)
    expect(fitted.bottomPanelHeight).toBeLessThan(preferences.bottom)
    expect(fitted.leftRailWidth + fitted.leftPanelWidth + fitted.leftEdgeWidth + fitted.centerWidth + fitted.rightEdgeWidth + fitted.rightPanelWidth + fitted.rightRailWidth).toBeLessThanOrEqual(700)
    expect(fitted.bottomPanelHeight + fitted.bottomEdgeHeight + fitted.centerHeight).toBeLessThanOrEqual(400)

    expect(fitted.leftTopHeight).toBeLessThan(fitted.leftBottomHeight)
    expect(fitted.rightTopHeight).toBeGreaterThan(fitted.rightBottomHeight)
    expect(fitted.leftTopHeight + fitted.leftBottomHeight + fitted.leftSplitHandleHeight).toBeCloseTo(fitted.sideHeight)
    expect(fitted.bottomLeftPanelWidth).toBeLessThan(fitted.bottomRightPanelWidth)
    expect(preferences).toEqual({ ...sizes, left: 1200, right: 1200, bottom: 1000 })
  })

  test('there is no bottom rail: the center and bottom panel share the full height, split by the card gap', () => {
    const fitted = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, allOpen, chrome)

    expect('bottomRailHeight' in fitted).toBe(false)
    expect(fitted.cardGap).toBe(GAP)
    expect(fitted.bottomEdgeHeight).toBe(GAP)
    expect(fitted.centerHeight + fitted.bottomEdgeHeight + fitted.bottomPanelHeight).toBe(800)
    expect(fitted.bottomPanelTop).toBe(fitted.centerHeight + GAP)

    const without = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, { ...allOpen, 'bottom-left': false, 'bottom-right': false }, chrome)
    expect(without.bottomEdgeHeight).toBe(0)
    expect(without.centerHeight).toBe(800)
  })

  test('cards are separated by the gap and the bottom panels span the width between the stripes', () => {
    const fitted = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, allOpen, chrome)

    expect(fitted.leftRailWidth).toBe(RAIL)
    expect(fitted.rightRailWidth).toBe(RAIL)
    expect(fitted.leftEdgeWidth).toBe(GAP)
    expect(fitted.rightEdgeWidth).toBe(GAP)
    expect(fitted.leftSplitHandleHeight).toBe(GAP)
    expect(fitted.rightSplitHandleHeight).toBe(GAP)
    expect(fitted.bottomSplitHandleWidth).toBe(GAP)
    expect(fitted.bottomLeftPanelWidth + fitted.bottomSplitHandleWidth + fitted.bottomRightPanelWidth).toBe(1200 - 2 * RAIL)
    expect(fitted.leftRailWidth + fitted.leftPanelWidth + fitted.leftEdgeWidth + fitted.centerWidth + fitted.rightEdgeWidth + fitted.rightPanelWidth + fitted.rightRailWidth).toBe(1200)
  })

  test('the center keeps its minimum size however large the saved panels are', () => {
    const preferences = { ...sizes, left: 1200, right: 1200, bottom: 1000 }
    const fitted = fitToolShellGeometry(preferences, { width: 900, height: 500 }, allOpen, chrome)

    expect(fitted.centerWidth).toBeGreaterThanOrEqual(chrome.centerMinWidth)
    expect(fitted.centerHeight).toBeGreaterThanOrEqual(chrome.centerMinHeight)
  })

  test('a lone open side slot fills its side while the opposite slot remains independently closed', () => {
    const open: ToolShellOpenSlots = { ...allOpen, 'left-bottom': false, 'right-top': false, 'right-bottom': false }
    const fitted = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, open, chrome)

    expect(fitted.leftTopHeight).toBe(fitted.sideHeight)
    expect(fitted.leftBottomHeight).toBe(0)
    expect(fitted.rightTopHeight).toBe(0)
    expect(fitted.rightBottomHeight).toBe(0)
  })

  test.each(['bottom-left', 'bottom-right'] as const)('a lone %s tool fills the dock without changing the saved split', (slot) => {
    const preferences = { ...sizes }
    const open: ToolShellOpenSlots = {
      ...allOpen,
      'bottom-left': slot === 'bottom-left',
      'bottom-right': slot === 'bottom-right'
    }
    const fitted = fitToolShellGeometry(preferences, { width: 1200, height: 800 }, open, chrome)
    const between = 1200 - 2 * RAIL

    expect(fitted.bottomLeftPanelWidth).toBe(slot === 'bottom-left' ? between : 0)
    expect(fitted.bottomRightPanelWidth).toBe(slot === 'bottom-right' ? between : 0)
    expect(fitted.bottomSplitHandleWidth).toBe(0)
    expect(preferences).toEqual(sizes)

    const both = fitToolShellGeometry(preferences, { width: 1200, height: 800 }, allOpen, chrome)
    expect(both.bottomSplitHandleWidth).toBe(GAP)
    expect(both.bottomLeftPanelWidth).toBeCloseTo((between - GAP) * sizes.bottomSplit)
    expect(both.bottomLeftPanelWidth + both.bottomSplitHandleWidth + both.bottomRightPanelWidth).toBe(between)
  })

  test('pointer movement uses edge direction and axis extent before applying bounds', () => {
    expect(resizeFromPointerDelta('left', 360, 24, 1, 100)).toBe(384)
    expect(resizeFromPointerDelta('right', 360, 24, -1, 100)).toBe(336)
    expect(resizeFromPointerDelta('bottomSplit', 0.5, 50, 1, 500)).toBe(0.6)
    expect(resizeFromPointerDelta('leftSplit', 0.5, -500, 1, 400)).toBe(0.15)
  })

  test('drop resolution accepts only a known in-flight tool ID', () => {
    const ids = new Set(['tasks', 'ledger'])
    expect(resolveToolDropId('ledger', ids)).toBe('ledger')
    expect(resolveToolDropId(null, ids)).toBeNull()
    expect(resolveToolDropId('external-payload', ids)).toBeNull()
  })

  describe('stripe overflow', () => {
    const upper = ['u1', 'u2', 'u3']
    const lower = ['l1', 'l2', 'l3']

    test('nothing is hidden when every tool fits', () => {
      expect(hideTrailingTools({ upper, lower, pinned: new Set(), capacity: 6 })).toEqual([])
      expect(hideTrailingTools({ upper, lower, pinned: new Set(), capacity: 9 })).toEqual([])
    })

    test('trailing tools of the lower group go first, from the end', () => {
      expect(hideTrailingTools({ upper, lower, pinned: new Set(), capacity: 4 })).toEqual(['l3', 'l2'])
    })

    test('the upper group gives up its trailing tools only after the lower group is empty', () => {
      expect(hideTrailingTools({ upper, lower, pinned: new Set(), capacity: 2 })).toEqual(['l3', 'l2', 'l1', 'u3'])
    })

    test('an open tool is never hidden, so the next trailing tool goes instead', () => {
      expect(hideTrailingTools({ upper, lower, pinned: new Set(['l3']), capacity: 5 })).toEqual(['l2'])
      expect(hideTrailingTools({ upper, lower, pinned: new Set(['l1', 'l2', 'l3', 'u3']), capacity: 4 })).toEqual(['u2', 'u1'])
    })

    test('when only open tools remain, the rest stay visible even over capacity', () => {
      expect(hideTrailingTools({ upper, lower, pinned: new Set([...upper, ...lower]), capacity: 0 })).toEqual([])
    })

    test('a capacity below zero hides every tool that is not open', () => {
      expect(hideTrailingTools({ upper: ['a'], lower: ['b'], pinned: new Set(['a']), capacity: -3 })).toEqual(['b'])
    })
  })

  describe('shortcuts', () => {
    const binding = (command: string, key: string, status: 'active' | 'shadowed' = 'active') => ({
      id: `${command}-${key}`,
      plugin: 'acme',
      key,
      command,
      status
    })

    test('chords are written the way the platform shows them', () => {
      expect(formatChord('mod+shift+g')).toBe('⌘⇧G')
      expect(formatChord('ctrl+alt+1')).toBe('⌃⌥1')
      expect(formatChord('f7')).toBe('F7')
    })

    test('a tool shows the chord of an active binding aimed at it, and never an invented one', () => {
      const changes: UiToolEntry = { ...tool('panel:acme/changes', 'right-top'), aliases: ['activity-item:acme/changes'] }
      expect(toolShortcut(changes, [binding('panel:acme/changes', 'mod+shift+g')])).toBe('⌘⇧G')
      expect(toolShortcut(changes, [binding('activity-item:acme/changes', 'f7')])).toBe('F7')
      expect(toolShortcut(changes, [binding('command:acme/other', 'mod+k')])).toBeNull()
      expect(toolShortcut(changes, [binding('panel:acme/changes', 'mod+k', 'shadowed')])).toBeNull()
      expect(toolShortcut(changes, [])).toBeNull()
    })
  })
})

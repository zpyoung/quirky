import { describe, expect, test } from 'bun:test'
import type { UiToolEntry, UiToolLayout } from '@quirky/protocol'
import {
  clampToolResize,
  fitToolShellGeometry,
  getToolShellOpenSlots,
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
const chrome: ToolShellChrome = {
  rail: 40,
  splitter: 4,
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
  return { id, title: id, icon: id, defaultSlot, contributionId: id, aliases: [] }
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

  test('contracts both side panels and the bottom panel without changing saved preferences', () => {
    const preferences = { ...sizes, left: 1200, right: 1200, bottom: 1000 }
    const fitted = fitToolShellGeometry(preferences, { width: 700, height: 400 }, allOpen, chrome)

    expect(fitted.leftPanelWidth).toBeLessThan(preferences.left)
    expect(fitted.rightPanelWidth).toBeLessThan(preferences.right)
    expect(fitted.bottomPanelHeight).toBeLessThan(preferences.bottom)
    expect(fitted.leftRailWidth + fitted.leftPanelWidth + fitted.leftEdgeWidth + fitted.centerWidth + fitted.rightEdgeWidth + fitted.rightPanelWidth + fitted.rightRailWidth).toBeLessThanOrEqual(700)
    expect(fitted.bottomPanelHeight + fitted.bottomRailHeight + fitted.centerHeight).toBeLessThanOrEqual(400)

    expect(fitted.leftTopHeight).toBeLessThan(fitted.leftBottomHeight)
    expect(fitted.rightTopHeight).toBeGreaterThan(fitted.rightBottomHeight)
    expect(fitted.leftTopHeight + fitted.leftBottomHeight + fitted.leftSplitHandleHeight).toBeCloseTo(fitted.sideHeight)
    expect(fitted.bottomLeftPanelWidth).toBeLessThan(fitted.bottomRightPanelWidth)
    expect(preferences).toEqual({ ...sizes, left: 1200, right: 1200, bottom: 1000 })
  })

  test('a lone open side slot fills its side while the opposite slot remains independently closed', () => {
    const open: ToolShellOpenSlots = { ...allOpen, 'left-bottom': false, 'right-top': false, 'right-bottom': false }
    const fitted = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, open, chrome)

    expect(fitted.leftTopHeight).toBe(fitted.sideHeight)
    expect(fitted.leftBottomHeight).toBe(0)
    expect(fitted.rightTopHeight).toBe(0)
    expect(fitted.rightBottomHeight).toBe(0)
  })

  test('a single bottom tool stays in its configured half', () => {
    const open: ToolShellOpenSlots = {
      ...allOpen,
      'left-top': false,
      'left-bottom': false,
      'right-top': false,
      'right-bottom': false,
      'bottom-right': false
    }
    const fitted = fitToolShellGeometry(sizes, { width: 1200, height: 800 }, open, chrome)

    expect(fitted.bottomLeftPanelWidth).toBe(420)
    expect(fitted.bottomRightPanelWidth).toBe(0)
    expect(fitted.bottomLeftStripeWidth + fitted.bottomRightStripeWidth).toBe(1200)
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
})

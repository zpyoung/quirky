import { describe, expect, test } from 'bun:test'
import {
  BUTTON_SIZE,
  clampBounds,
  clampButton,
  defaultBounds,
  defaultButton,
  maximizedBounds,
  moveBounds,
  resizeBounds,
  resolveBounds,
  type Edge
} from '../../src/window/floating/geometry'

const VIEW = { width: 1400, height: 900 }

describe('the panel placement', () => {
  test('SC-55: the default is 920x560, 24 px from the right and 84 px from the bottom', () => {
    expect(defaultBounds(VIEW)).toEqual({ x: 1400 - 920 - 24, y: 900 - 560 - 84, width: 920, height: 560 })
  })

  test('the default shrinks to fit a small window but never below the minimum', () => {
    expect(defaultBounds({ width: 800, height: 500 })).toEqual({ x: 24, y: 12, width: 752, height: 404 })
    const tiny = defaultBounds({ width: 300, height: 200 })
    expect(tiny.width).toBe(420)
    expect(tiny.height).toBe(280)
    expect(tiny.x).toBe(0)
    expect(tiny.y).toBe(0)
  })

  test('SC-56: maximized is the window minus a 12 px margin all around', () => {
    expect(maximizedBounds(VIEW)).toEqual({ x: 12, y: 12, width: 1376, height: 876 })
    expect(maximizedBounds({ width: 400, height: 200 })).toEqual({ x: 12, y: 12, width: 420, height: 280 })
  })

  test('SC-57: bounds that no longer fit the window are pulled inside it', () => {
    const away = { x: 2000, y: -50, width: 920, height: 560 }
    expect(clampBounds(away, VIEW)).toEqual({ x: 480, y: 0, width: 920, height: 560 })
    expect(clampBounds({ x: -300, y: 700, width: 920, height: 560 }, VIEW)).toEqual({ x: 0, y: 340, width: 920, height: 560 })
  })

  test('bounds larger than the window are shrunk to it, down to the minimum', () => {
    expect(clampBounds({ x: 0, y: 0, width: 5000, height: 4000 }, VIEW)).toEqual({ x: 0, y: 0, width: 1400, height: 900 })
    expect(clampBounds({ x: 0, y: 0, width: 5000, height: 4000 }, { width: 300, height: 200 })).toEqual({ x: 0, y: 0, width: 420, height: 280 })
  })

  test('resolveBounds picks maximized, the saved bounds (clamped) or the default', () => {
    const saved = { x: 10, y: 20, width: 600, height: 400 }
    expect(resolveBounds({ maximized: true, bounds: saved }, VIEW)).toEqual(maximizedBounds(VIEW))
    expect(resolveBounds({ maximized: false, bounds: saved }, VIEW)).toEqual(saved)
    expect(resolveBounds({ maximized: false, bounds: null }, VIEW)).toEqual(defaultBounds(VIEW))
    expect(resolveBounds({ maximized: false, bounds: { x: 5000, y: 5000, width: 600, height: 400 } }, VIEW)).toEqual({ x: 800, y: 500, width: 600, height: 400 })
  })
})

describe('dragging the title bar', () => {
  const start = { x: 100, y: 100, width: 600, height: 400 }

  test('moves the panel by the pointer distance', () => {
    expect(moveBounds(start, 50, -20, VIEW)).toEqual({ x: 150, y: 80, width: 600, height: 400 })
  })

  test('stops at the window edges', () => {
    expect(moveBounds(start, -500, -500, VIEW)).toEqual({ x: 0, y: 0, width: 600, height: 400 })
    expect(moveBounds(start, 5000, 5000, VIEW)).toEqual({ x: 800, y: 500, width: 600, height: 400 })
  })
})

describe('dragging an edge', () => {
  const start = { x: 200, y: 150, width: 600, height: 400 }
  const resize = (edge: Edge, dx: number, dy: number) => resizeBounds(start, edge, dx, dy, VIEW)

  test('east and south grow the far sides', () => {
    expect(resize('e', 40, 99)).toEqual({ x: 200, y: 150, width: 640, height: 400 })
    expect(resize('s', 99, 30)).toEqual({ x: 200, y: 150, width: 600, height: 430 })
    expect(resize('se', 40, 30)).toEqual({ x: 200, y: 150, width: 640, height: 430 })
  })

  test('west and north move the near sides and keep the far ones in place', () => {
    expect(resize('w', -50, 0)).toEqual({ x: 150, y: 150, width: 650, height: 400 })
    expect(resize('n', 0, -50)).toEqual({ x: 200, y: 100, width: 600, height: 450 })
    expect(resize('nw', 30, 20)).toEqual({ x: 230, y: 170, width: 570, height: 380 })
    expect(resize('ne', 30, -20)).toEqual({ x: 200, y: 130, width: 630, height: 420 })
    expect(resize('sw', -30, 20)).toEqual({ x: 170, y: 150, width: 630, height: 420 })
  })

  test('SC-56: never below 420x280, whichever edge is dragged', () => {
    expect(resize('e', -1000, 0).width).toBe(420)
    expect(resize('s', 0, -1000).height).toBe(280)
    expect(resize('w', 1000, 0)).toEqual({ x: 380, y: 150, width: 420, height: 400 })
    expect(resize('n', 0, 1000)).toEqual({ x: 200, y: 270, width: 600, height: 280 })
  })

  test('stays inside the window', () => {
    expect(resize('e', 5000, 0)).toEqual({ x: 200, y: 150, width: 1200, height: 400 })
    expect(resize('w', -5000, 0)).toEqual({ x: 0, y: 150, width: 800, height: 400 })
    expect(resize('s', 0, 5000)).toEqual({ x: 200, y: 150, width: 600, height: 750 })
    expect(resize('n', 0, -5000)).toEqual({ x: 200, y: 0, width: 600, height: 550 })
  })
})

describe('the floating button', () => {
  test('centers in a supplied anchor', () => {
    expect(defaultButton(VIEW, { left: 1200, top: 700, width: 40, height: 40 })).toEqual({ x: 1202, y: 702 })
    expect(clampButton({ x: -40, y: -40 }, VIEW)).toEqual({ x: 8, y: 8 })
    expect(clampButton({ x: 5000, y: 5000 }, VIEW)).toEqual({ x: 1400 - BUTTON_SIZE - 8, y: 900 - BUTTON_SIZE - 8 })
    expect(clampButton({ x: 300, y: 200 }, VIEW)).toEqual({ x: 300, y: 200 })
  })
  test('falls back when the anchor has not been measured', () => {
    expect(defaultButton(VIEW, { left: 0, top: 0, width: 0, height: 0 })).toEqual(defaultButton(VIEW))
  })
})

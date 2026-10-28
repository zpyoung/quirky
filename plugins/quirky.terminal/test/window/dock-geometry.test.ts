import { describe, expect, test } from 'bun:test'
import { dockHeight, gutterRowsAfterDrag, shouldMountDock } from '../../src/window/dock/geometry'

describe('terminal dock geometry', () => {
  test('uses fixed eighty-pixel chrome and twenty-pixel rows', () => {
    expect(dockHeight(5)).toBe(180)
    expect(dockHeight(3)).toBe(140)
    expect(dockHeight(15)).toBe(380)
  })

  test('changes one row per twenty-pixel drag step and clamps rows to three through fifteen', () => {
    expect(gutterRowsAfterDrag(5, -40)).toBe(7)
    expect(gutterRowsAfterDrag(5, 40)).toBe(3)
    expect(gutterRowsAfterDrag(3, 80)).toBe(3)
    expect(gutterRowsAfterDrag(15, -200)).toBe(15)
    expect(gutterRowsAfterDrag(5, -9)).toBe(5)
  })

  test('applies distinct unmount and remount boundaries with a drag freeze', () => {
    const gutter = dockHeight(5)
    expect(shouldMountDock(true, gutter + 59, gutter, false)).toBe(false)
    expect(shouldMountDock(true, gutter + 60, gutter, false)).toBe(true)
    expect(shouldMountDock(false, gutter + 99, gutter, false)).toBe(false)
    expect(shouldMountDock(false, gutter + 100, gutter, false)).toBe(true)
    expect(shouldMountDock(true, 100, gutter, true)).toBe(true)
    expect(shouldMountDock(false, 100, gutter, true)).toBe(false)
  })
})

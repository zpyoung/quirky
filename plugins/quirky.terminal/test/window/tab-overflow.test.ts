import { describe, expect, test } from 'bun:test'
import { hiddenTabIndexes, tabsFit } from '../../src/window/workspace/tab-overflow'

const span = (left: number, width: number) => ({ left, right: left + width })
const row = (viewport: { left: number; right: number }, widths: number[], scroll = 0) => {
  let left = viewport.left - scroll
  return widths.map((width) => {
    const next = span(left, width)
    left += width
    return next
  })
}

describe('hiddenTabIndexes', () => {
  const viewport = span(0, 250)

  test('reports nothing when every tab fits', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100]))).toEqual([])
    expect(hiddenTabIndexes(viewport, row(viewport, [125, 125]))).toEqual([])
    expect(hiddenTabIndexes(viewport, [])).toEqual([])
  })

  test('reports the tabs past the right edge', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100]))).toEqual([3])
  })

  test('reports tabs on both sides of a scrolled strip', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100, 100, 100], 200))).toEqual([0, 1, 5])
  })

  test('a tab is hidden when less than half of it shows, whichever edge clips it', () => {
    expect(hiddenTabIndexes(viewport, [span(200, 100)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(201, 100)])).toEqual([0])
    expect(hiddenTabIndexes(viewport, [span(-50, 100)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(-51, 100)])).toEqual([0])
  })

  test('the active tab with only its edge clipped is not listed', () => {
    expect(hiddenTabIndexes(viewport, [span(0, 252), span(252, 100), span(352, 100)])).toEqual([1, 2])
  })

  test('ignores sub-pixel overhang from rounding', () => {
    expect(hiddenTabIndexes(viewport, [span(0, 250.4)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(-0.4, 250)])).toEqual([])
  })

  test('works from a viewport that does not start at zero', () => {
    const offset = span(32, 150)
    expect(hiddenTabIndexes(offset, row(offset, [100, 100, 100]))).toEqual([2])
  })
})

describe('tabsFit', () => {
  test('fits up to the room, allowing for rounding', () => {
    expect(tabsFit(300, 299)).toBe(true)
    expect(tabsFit(300, 300.4)).toBe(true)
    expect(tabsFit(300, 302)).toBe(false)
  })
})

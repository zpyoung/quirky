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
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100]))).toEqual([2, 3])
  })

  test('reports tabs on both sides of a scrolled strip', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100, 100], 200))).toEqual([0, 1, 4])
  })

  test('counts a partly clipped tab as hidden, whichever edge clips it', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100]))).toEqual([2])
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100], 50))).toEqual([0, 3])
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100], 100))).toEqual([0])
  })

  test('ignores sub-pixel overhang from rounding', () => {
    expect(hiddenTabIndexes(viewport, [span(0, 250.4)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(-0.4, 250)])).toEqual([])
  })

  test('works from a viewport that does not start at zero', () => {
    const offset = span(32, 150)
    expect(hiddenTabIndexes(offset, row(offset, [100, 100, 100]))).toEqual([1, 2])
  })
})

describe('tabsFit', () => {
  test('fits up to the room, allowing for rounding', () => {
    expect(tabsFit(300, 299)).toBe(true)
    expect(tabsFit(300, 300.4)).toBe(true)
    expect(tabsFit(300, 302)).toBe(false)
  })
})

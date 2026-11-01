import { describe, expect, test } from 'bun:test'
import { firstTabBeside, hiddenTabIndexes, scrollBackToFill, tabsFit, trailingScrollSlack } from '../../src/window/workspace/tab-overflow'

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

  test('reports tabs with less than a full viewport of room on either side of a scrolled strip', () => {
    expect(hiddenTabIndexes(viewport, row(viewport, [100, 100, 100, 100, 100, 100], 200))).toEqual([0, 1, 4, 5])
  })

  test('hides normal-sized tabs when more than one pixel is clipped at either edge', () => {
    expect(hiddenTabIndexes(viewport, [span(0, 140)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(-1, 140)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(-1.1, 140)])).toEqual([0])
    expect(hiddenTabIndexes(viewport, [span(111, 140)])).toEqual([])
    expect(hiddenTabIndexes(viewport, [span(111.1, 140)])).toEqual([0])
  })

  test('keeps an oversized tab usable when it fills the viewport', () => {
    expect(hiddenTabIndexes(viewport, [span(-25, 300)])).toEqual([])
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

describe('firstTabBeside', () => {
  const tabs = row(span(0, 0), [100, 100, 150, 100])

  test('walks back as far as the tabs still fit beside the target', () => {
    expect(firstTabBeside(350, tabs, 3)).toBe(1)
    expect(firstTabBeside(340, tabs, 3)).toBe(2)
    expect(firstTabBeside(250, tabs, 2)).toBe(1)
  })

  test('allows layout rounding, the same as hiddenTabIndexes', () => {
    expect(firstTabBeside(349.4, tabs, 3)).toBe(1)
    expect(firstTabBeside(348.9, tabs, 3)).toBe(2)
  })

  test('stops at the target when not even it fits', () => {
    expect(firstTabBeside(50, tabs, 3)).toBe(3)
  })

  test('reads the same at any scroll position', () => {
    expect(firstTabBeside(350, row(span(0, 0), [100, 100, 150, 100], 240), 3)).toBe(1)
  })
})

describe('trailingScrollSlack', () => {
  test('lets the last tab reach the leading edge when no other tab fits beside it', () => {
    expect(trailingScrollSlack(156, row(span(0, 0), [100, 100, 100]))).toBe(56)
  })

  test('stops at the earliest tab that fits beside the last, so no earlier tab fits in what is left', () => {
    expect(trailingScrollSlack(360, row(span(0, 0), [100, 150, 100, 100]))).toBe(10)
    expect(trailingScrollSlack(300, row(span(0, 0), [100, 100, 100, 100]))).toBe(0)
  })

  test('adds nothing for a last tab wider than the viewport or for an empty strip', () => {
    expect(trailingScrollSlack(100, row(span(0, 0), [50, 300]))).toBe(0)
    expect(trailingScrollSlack(100, [])).toBe(0)
  })

  test('does not depend on where the strip is scrolled', () => {
    expect(trailingScrollSlack(360, row(span(0, 0), [100, 150, 100, 100], 100))).toBe(10)
  })
})

describe('scrollBackToFill', () => {
  const viewport = span(0, 520)

  test('returns the width of the hidden tabs that fit in the blank space after the visible run', () => {
    expect(scrollBackToFill(viewport, row(viewport, [100, 200, 200, 400, 100], 100))).toBe(100)
    expect(scrollBackToFill(viewport, row(viewport, [60, 60, 200, 200, 400], 120))).toBe(120)
  })

  test('stops at a hidden tab too wide for what is left', () => {
    expect(scrollBackToFill(viewport, row(viewport, [130, 200, 200, 400], 130))).toBe(0)
  })

  test('returns nothing at the start of the strip', () => {
    expect(scrollBackToFill(viewport, row(viewport, [100, 200, 400]))).toBe(0)
  })

  test('returns nothing when no tab fully fits, as with an oversized tab filling the viewport', () => {
    expect(scrollBackToFill(viewport, row(viewport, [100, 900], 100))).toBe(0)
    expect(scrollBackToFill(viewport, [])).toBe(0)
  })
})

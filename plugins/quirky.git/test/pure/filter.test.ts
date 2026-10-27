import { describe, expect, test } from 'bun:test'
import {
  FILTER_TOO_LARGE,
  MAX_FILTER_BYTES,
  applyFilter,
  filterTooLarge,
  matchesFilter
} from '../../src/panel/filter'

const rows = [{ path: 'README.md' }, { path: 'src/Math.ts' }, { path: 'src/app/notes.txt' }]

describe('matchesFilter', () => {
  test('is a case-insensitive substring of the whole path', () => {
    expect(matchesFilter('src/Math.ts', 'MATH')).toBe(true)
    expect(matchesFilter('src/Math.ts', 'src/ma')).toBe(true)
    expect(matchesFilter('src/Math.ts', 'readme')).toBe(false)
  })

  test('matches non-ASCII case-insensitively', () => {
    expect(matchesFilter('docs/Über.md', 'über')).toBe(true)
  })

  test('is not a glob or regular expression', () => {
    expect(matchesFilter('a/b.ts', 'a.*b')).toBe(false)
    expect(matchesFilter('a.*b', 'a.*b')).toBe(true)
  })
})

describe('applyFilter', () => {
  test('an empty or blank query leaves every row and is inactive', () => {
    expect(applyFilter(rows, '')).toEqual({ state: 'inactive', items: rows })
    expect(applyFilter(rows, '   ')).toEqual({ state: 'inactive', items: rows })
  })

  test('SC-16: MATH narrows to math.ts', () => {
    expect(applyFilter(rows, 'MATH')).toEqual({ state: 'filtering', items: [{ path: 'src/Math.ts' }] })
  })

  test('no match is filtering with no rows', () => {
    expect(applyFilter(rows, 'zzz')).toEqual({ state: 'filtering', items: [] })
  })

  test('a query over 2048 bytes reports too large and no rows', () => {
    expect(applyFilter(rows, 'a'.repeat(3000))).toEqual({
      state: 'too-large',
      items: [],
      title: 'Search text is too large',
      message: 'Use a shorter file filter.'
    })
  })
})

describe('filterTooLarge', () => {
  test('the limit is 2048 UTF-8 bytes', () => {
    expect(MAX_FILTER_BYTES).toBe(2048)
    expect(filterTooLarge('a'.repeat(2048))).toBe(false)
    expect(filterTooLarge('a'.repeat(2049))).toBe(true)
  })

  test('counts bytes, not characters', () => {
    expect(filterTooLarge('é'.repeat(1024))).toBe(false)
    expect(filterTooLarge('é'.repeat(1025))).toBe(true)
    expect(filterTooLarge('😀'.repeat(512))).toBe(false)
    expect(filterTooLarge('😀'.repeat(513))).toBe(true)
  })

  test('exposes the copy', () => {
    expect(FILTER_TOO_LARGE).toEqual({ title: 'Search text is too large', message: 'Use a shorter file filter.' })
  })
})

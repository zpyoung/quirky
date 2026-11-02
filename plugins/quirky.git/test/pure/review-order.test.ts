import { describe, expect, test } from 'bun:test'
import type { ReviewFile, ReviewMarkState } from '@quirky/protocol'
import { nextToReview, reviewOrder } from '../../src/review/order'

const file = (path: string, mark: ReviewMarkState = 'none', extra: Partial<ReviewFile> = {}): ReviewFile => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  binary: false,
  uncommitted: true,
  staged: false,
  mark,
  notes: 0,
  ...extra
})

const paths = (files: readonly ReviewFile[]) => files.map((f) => f.path)

describe('reviewOrder', () => {
  const files = [file('top.ts'), file('src/app/b.ts'), file('lib/c.ts'), file('src/app/a.ts'), file('B.ts')]

  test('list order is byte order of the path', () => {
    expect(paths(reviewOrder(files, 'list'))).toEqual(['B.ts', 'lib/c.ts', 'src/app/a.ts', 'src/app/b.ts', 'top.ts'])
  })

  test('tree order lists folders before files, as the panel tree does', () => {
    expect(paths(reviewOrder(files, 'tree'))).toEqual(['lib/c.ts', 'src/app/a.ts', 'src/app/b.ts', 'B.ts', 'top.ts'])
  })

  test('does not mutate its input', () => {
    const before = paths(files)
    reviewOrder(files, 'list')
    reviewOrder(files, 'tree')
    expect(paths(files)).toEqual(before)
  })

  test('empty input gives an empty order', () => {
    expect(reviewOrder([], 'tree')).toEqual([])
    expect(reviewOrder([], 'list')).toEqual([])
  })
})

describe('nextToReview', () => {
  test('returns the next file that is not reviewed', () => {
    const ordered = [file('a', 'reviewed'), file('b'), file('c', 'changed')]
    expect(nextToReview(ordered, 'a')).toBe('b')
    expect(nextToReview(ordered, 'b')).toBe('c')
  })

  test('skips reviewed and conflicted files', () => {
    const ordered = [
      file('a'),
      file('b', 'reviewed'),
      file('c', 'none', { conflict: { kind: 'both_modified', state: 'unresolved' } }),
      file('d', 'changed')
    ]
    expect(nextToReview(ordered, 'a')).toBe('d')
  })

  test('wraps to the start', () => {
    const ordered = [file('a', 'changed'), file('b', 'reviewed'), file('c', 'reviewed')]
    expect(nextToReview(ordered, 'c')).toBe('a')
  })

  test('never returns the current file', () => {
    const ordered = [file('a'), file('b', 'reviewed')]
    expect(nextToReview(ordered, 'a')).toBeNull()
  })

  test('is null when everything is reviewed', () => {
    expect(nextToReview([file('a', 'reviewed'), file('b', 'reviewed')], 'a')).toBeNull()
    expect(nextToReview([], null)).toBeNull()
  })

  test('starts from the top with no current file or an unknown one', () => {
    const ordered = [file('a', 'reviewed'), file('b')]
    expect(nextToReview(ordered, null)).toBe('b')
    expect(nextToReview(ordered, 'gone')).toBe('b')
  })
})

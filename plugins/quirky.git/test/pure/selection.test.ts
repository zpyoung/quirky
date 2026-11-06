import { describe, expect, test } from 'bun:test'
import type { ReviewFile, ReviewMarkState } from '@quirky/protocol'
import { advanceAfterMark, keyIntent } from '../../src/panel/selection'

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

const rows = [file('a.ts'), file('b.ts', 'reviewed'), file('c.ts', 'changed'), file('d.ts')]

describe('keyIntent arrows', () => {
  test('down from nothing selects the first row and up selects the last', () => {
    expect(keyIntent(rows, null, 'ArrowDown')).toEqual({ type: 'select', path: 'a.ts' })
    expect(keyIntent(rows, null, 'ArrowUp')).toEqual({ type: 'select', path: 'd.ts' })
  })

  test('moves one row and stays at either end', () => {
    expect(keyIntent(rows, 'a.ts', 'ArrowDown')).toEqual({ type: 'select', path: 'b.ts' })
    expect(keyIntent(rows, 'c.ts', 'ArrowUp')).toEqual({ type: 'select', path: 'b.ts' })
    expect(keyIntent(rows, 'd.ts', 'ArrowDown')).toEqual({ type: 'select', path: 'd.ts' })
    expect(keyIntent(rows, 'a.ts', 'ArrowUp')).toEqual({ type: 'select', path: 'a.ts' })
  })

  test('a selection that is no longer shown acts like no selection', () => {
    expect(keyIntent(rows, 'gone.ts', 'ArrowDown')).toEqual({ type: 'select', path: 'a.ts' })
  })

  test('an empty list has nothing to move to', () => {
    expect(keyIntent([], null, 'ArrowDown')).toBeNull()
  })
})

describe('keyIntent actions', () => {
  test('Enter opens the selected row', () => {
    expect(keyIntent(rows, 'b.ts', 'Enter')).toEqual({ type: 'open', path: 'b.ts' })
  })

  test('Space marks an unreviewed or changed file and unmarks a reviewed one', () => {
    expect(keyIntent(rows, 'a.ts', ' ')).toEqual({ type: 'toggle-mark', path: 'a.ts', reviewed: true })
    expect(keyIntent(rows, 'c.ts', ' ')).toEqual({ type: 'toggle-mark', path: 'c.ts', reviewed: true })
    expect(keyIntent(rows, 'b.ts', ' ')).toEqual({ type: 'toggle-mark', path: 'b.ts', reviewed: false })
  })

  test('Space leaves a conflicted file alone', () => {
    const conflicted = [file('x.ts', 'none', { conflict: { kind: 'both_modified', state: 'unresolved' } })]
    expect(keyIntent(conflicted, 'x.ts', ' ')).toBeNull()
  })

  test('Backspace and Delete start Revert file', () => {
    expect(keyIntent(rows, 'a.ts', 'Backspace')).toEqual({ type: 'revert', path: 'a.ts' })
    expect(keyIntent(rows, 'a.ts', 'Delete')).toEqual({ type: 'revert', path: 'a.ts' })
  })

  test('keys that need a selection do nothing without one', () => {
    for (const key of ['Enter', ' ', 'Backspace', 'Delete']) expect(keyIntent(rows, null, key)).toBeNull()
  })

  test('Escape clears a selection and is ignored without one', () => {
    expect(keyIntent(rows, 'a.ts', 'Escape')).toEqual({ type: 'select', path: null })
    expect(keyIntent(rows, null, 'Escape')).toBeNull()
  })

  test('other keys are not the list\'s', () => {
    expect(keyIntent(rows, 'a.ts', 'x')).toBeNull()
  })
})

describe('advanceAfterMark', () => {
  test('moves to the next file in path order that is not yet reviewed, skipping reviewed ones', () => {
    expect(advanceAfterMark(rows, 'list', 'a.ts')).toBe('c.ts')
  })

  test('wraps to the start', () => {
    expect(advanceAfterMark(rows, 'list', 'd.ts')).toBe('a.ts')
  })

  test('stays put when nothing else needs a look', () => {
    const done = [file('a.ts'), file('b.ts', 'reviewed')]
    expect(advanceAfterMark(done, 'list', 'a.ts')).toBeNull()
  })

  test('follows the tree order in tree mode', () => {
    const files = [file('top.ts'), file('src/a.ts'), file('lib/b.ts')]
    expect(advanceAfterMark(files, 'tree', 'lib/b.ts')).toBe('src/a.ts')
    expect(advanceAfterMark(files, 'list', 'lib/b.ts')).toBe('src/a.ts')
    expect(advanceAfterMark(files, 'tree', 'src/a.ts')).toBe('top.ts')
  })
})

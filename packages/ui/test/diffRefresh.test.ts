import { expect, test } from 'bun:test'
import type { GitDiff, GitFileStatus } from '@quirky/protocol'
import { keepSelection, reuseDiff } from '../src/lib/diffRefresh'

const file = (path: string, index: string, worktree: string): GitFileStatus => ({
  path,
  index,
  worktree,
  untracked: false
})

const diff = (original: string, modified: string, overrides: Partial<GitDiff> = {}): GitDiff => ({
  path: 'a.ts',
  staged: false,
  original,
  modified,
  binary: false,
  ...overrides
})

test('keeps a selection whose file is still listed on that side', () => {
  const selection = { path: 'a.ts', staged: false }
  expect(keepSelection(selection, [], [file('a.ts', ' ', 'M')])).toEqual(selection)
})

test('drops a selection whose file left the status list', () => {
  expect(keepSelection({ path: 'a.ts', staged: false }, [], [file('b.ts', ' ', 'M')])).toBeNull()
})

test('drops a selection when the file moved to the other side', () => {
  expect(keepSelection({ path: 'a.ts', staged: false }, [file('a.ts', 'M', ' ')], [])).toBeNull()
})

test('has nothing to keep without a selection', () => {
  expect(keepSelection(null, [file('a.ts', 'M', ' ')], [])).toBeNull()
})

test('reuses the previous diff object when the text is unchanged', () => {
  const prev = diff('one\n', 'two\n')
  expect(reuseDiff(prev, diff('one\n', 'two\n'))).toBe(prev)
})

test('takes the new diff when the modified text changed', () => {
  const next = diff('one\n', 'three\n')
  expect(reuseDiff(diff('one\n', 'two\n'), next)).toBe(next)
})

test('takes the new diff when the original text changed', () => {
  const next = diff('zero\n', 'two\n')
  expect(reuseDiff(diff('one\n', 'two\n'), next)).toBe(next)
})

test('takes the new diff when it is for another file or side', () => {
  const prev = diff('x', 'y')
  const otherPath = diff('x', 'y', { path: 'b.ts' })
  const otherSide = diff('x', 'y', { staged: true })
  expect(reuseDiff(prev, otherPath)).toBe(otherPath)
  expect(reuseDiff(prev, otherSide)).toBe(otherSide)
})

test('takes the new diff when binary flips or there was no previous diff', () => {
  const next = diff('x', 'y', { binary: true })
  expect(reuseDiff(diff('x', 'y'), next)).toBe(next)
  expect(reuseDiff(null, next)).toBe(next)
})

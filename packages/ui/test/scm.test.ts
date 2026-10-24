import { expect, test } from 'bun:test'
import type { GitFileStatus } from '@quirky/protocol'
import { splitFiles, statusLetter } from '../src/lib/scm'

const file = (path: string, index: string, worktree: string, untracked = false): GitFileStatus => ({
  path,
  index,
  worktree,
  untracked
})

test('splits files into staged and unstaged', () => {
  const { staged, unstaged } = splitFiles([
    file('a', 'M', ' '),
    file('b', ' ', 'M'),
    file('c', 'A', 'M'),
    file('d', '?', '?', true)
  ])
  expect(staged.map((f) => f.path)).toEqual(['a', 'c'])
  expect(unstaged.map((f) => f.path)).toEqual(['b', 'c', 'd'])
})

test('picks the status letter for a side', () => {
  expect(statusLetter(file('a', 'M', ' '), true)).toBe('M')
  expect(statusLetter(file('d', '?', '?', true), false)).toBe('U')
  expect(statusLetter(file('b', ' ', 'D'), false)).toBe('D')
})

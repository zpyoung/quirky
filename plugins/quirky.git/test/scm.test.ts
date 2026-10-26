import { expect, test } from 'bun:test'
import type { GitFileStatus, UiLayout } from '@quirky/protocol'
import { scmReport, splitFiles, statusLetter, worktreeOf } from '../src/scm'

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

test('reads the worktree selector from the open view input', () => {
  const layout = (view: UiLayout['view']): UiLayout => ({ view, panel: null, sidebar: true, focus: null })
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree', input: { worktree: 'fix-login' } }))).toBe('fix-login')
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree' }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: { worktree: '' } }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: { worktree: 4 } }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: 'fix-login' }))).toBeNull()
  expect(worktreeOf(layout(null))).toBeNull()
})

test('summarizes what the panel shows', () => {
  const status = { branch: 'main', upstream: null, ahead: 0, behind: 0, files: [file('a', 'M', ' '), file('b', ' ', 'M'), file('c', 'A', 'M')] }
  expect(scmReport('w1', status)).toEqual({ worktree: 'w1', branch: 'main', staged: 2, unstaged: 2 })
  expect(scmReport('w1', null)).toEqual({ worktree: 'w1', branch: null, staged: 0, unstaged: 0 })
  expect(scmReport(null, null)).toEqual({ worktree: null, branch: null, staged: 0, unstaged: 0 })
})

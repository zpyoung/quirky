import { expect, test } from 'bun:test'
import { emptyMainMessage } from '../src/components/MainArea'

test('the empty center asks for a repo only when there is none', () => {
  expect(emptyMainMessage({ views: 3, repos: 0 })).toBe('Add a repo and pick a worktree to get started.')
  expect(emptyMainMessage({ views: 3, repos: null })).toBe('Add a repo and pick a worktree to get started.')
})

test('with repos added, the empty center asks for a worktree', () => {
  expect(emptyMainMessage({ views: 3, repos: 1 })).toBe('Pick a worktree to get started.')
})

test('with no views at all there is nothing to show', () => {
  expect(emptyMainMessage({ views: 0, repos: 1 })).toBe('Nothing to show here.')
})

import { expect, test } from 'bun:test'
import type { UiLayout } from '@quirky/protocol'
import { EMPTY_REPORT, worktreeOf } from '../src/scm'

const layout = (view: UiLayout['view']): UiLayout => ({ view, panel: null, sidebar: true, focus: null })

test('reads the worktree selector from the open view input', () => {
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree', input: { worktree: 'fix-login' } }))).toBe('fix-login')
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree' }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: { worktree: '' } }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: { worktree: 4 } }))).toBeNull()
  expect(worktreeOf(layout({ id: 'view:x/y', input: 'fix-login' }))).toBeNull()
  expect(worktreeOf(layout(null))).toBeNull()
})

test('the report of a panel with no worktree shows nothing', () => {
  expect(EMPTY_REPORT).toMatchObject({ worktree: null, branch: null, sections: [], primary: null, selection: [], filter: '' })
})

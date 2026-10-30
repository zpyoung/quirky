import { expect, test } from 'bun:test'
import type { UiLayout } from '@quirky/protocol'
import { EMPTY_REPORT, worktreeOf } from '../src/scm'

const layout = (view: UiLayout['view'], worktree: UiLayout['worktree'] = null): UiLayout => ({ worktree, view, panel: null, sidebar: true, focus: null })

test('reads the daemon-selected worktree independently of the open view input', () => {
  expect(worktreeOf(layout({ id: 'view:global/home' }, 'selected'))).toBe('selected')
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree', input: { worktree: 'view-target' } }, 'selected'))).toBe('selected')
  expect(worktreeOf(layout({ id: 'view:quirky.session/worktree', input: { worktree: 'view-target' } }))).toBeNull()
  expect(worktreeOf(layout(null, 'selected'))).toBe('selected')
  expect(worktreeOf(layout(null))).toBeNull()
})

test('the report of a panel with no worktree shows nothing', () => {
  expect(EMPTY_REPORT).toMatchObject({ worktree: null, branch: null, sections: [], primary: null, selection: [], filter: '' })
})

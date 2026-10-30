import { expect, test } from 'bun:test'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { worktreeFromLayout } from '../src/window/editorState'

const contextFor = (layout: UiLayout) => ({ getLayout: () => layout }) as UiPluginContext

test('reads the daemon-selected worktree when the current view has no worktree input', () => {
  const layout: UiLayout = {
    worktree: 'layout-selected',
    view: { id: 'view:global/home' },
    panel: null,
    sidebar: true,
    focus: 'view'
  }

  expect(worktreeFromLayout(contextFor(layout))).toBe('layout-selected')
})

test('does not infer the current worktree from a view-specific input', () => {
  const layout: UiLayout = {
    worktree: null,
    view: { id: 'view:quirky.session/worktree', input: { worktree: 'view-only-target' } },
    panel: null,
    sidebar: true,
    focus: 'view'
  }

  expect(worktreeFromLayout(contextFor(layout))).toBeUndefined()
})

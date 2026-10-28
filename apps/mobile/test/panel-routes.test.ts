import { expect, test } from 'bun:test'
import { validatePanelRoute } from '../src/panels/routes'

test('file preview navigation requires a bounded contained path and exact route fields', () => {
  expect(validatePanelRoute({ kind: 'file-preview', worktreeId: 'w1', path: 'src/main.ts' })).toMatchObject({ kind: 'file-preview', path: 'src/main.ts' })
  for (const path of ['/etc/passwd', '../escape', 'src/../escape', 'C:\\secret', 'x'.repeat(1025)]) {
    expect(() => validatePanelRoute({ kind: 'file-preview', worktreeId: 'w1', path })).toThrow()
  }
  expect(() => validatePanelRoute({ kind: 'file-preview', worktreeId: 'w1' })).toThrow()
  expect(() => validatePanelRoute({ kind: 'file-preview', worktreeId: 'w1', path: 'a.txt', grants: ['admin'] })).toThrow()
})

test('host routes do not acquire workspace authority or unsupported tabs through extra parameters', () => {
  expect(validatePanelRoute({ kind: 'source-control', worktreeId: 'w1', tab: 'pull-request' })).toMatchObject({ tab: 'pull-request' })
  expect(() => validatePanelRoute({ kind: 'source-control', worktreeId: 'w1', tab: 'admin' })).toThrow()
  expect(() => validatePanelRoute({ kind: 'accounts', worktreeId: 'w1' })).toThrow()
  expect(() => validatePanelRoute({ kind: 'agent-history', worktreeId: '' })).toThrow()
  expect(() => validatePanelRoute({ kind: 'notifications', worktreeId: 'x'.repeat(1025) })).toThrow()
  expect(() => validatePanelRoute({ kind: 'unknown' })).toThrow()
})

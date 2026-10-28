import { expect, test } from 'bun:test'
import { assertPanelParameters } from '../src/daemon/panel-authorization'

test('file uploads permit bounded draft transfers, not new file/import or arbitrary path authority', () => {
  expect(() => assertPanelParameters('quirky.editor/transfer', { action: 'begin', kind: 'draft', bufferId: 'b1', expectedRevision: 2, totalBytes: 1048576 })).not.toThrow()
  for (const input of [
    { action: 'begin', kind: 'import', path: '/tmp', totalBytes: 1 },
    { action: 'begin', kind: 'createFile', path: '../escape', totalBytes: 1 },
    { action: 'begin', kind: 'draft', bufferId: 'b1', expectedRevision: 2, totalBytes: 1048577 },
    { action: 'chunk', transferId: 't1', offset: 0, data: 'x'.repeat(65537) }
  ]) expect(() => assertPanelParameters('quirky.editor/transfer', input)).toThrow()
  expect(() => assertPanelParameters('quirky.editor/open', { worktree: 'wt', path: '/etc/passwd' })).toThrow()
  expect(() => assertPanelParameters('quirky.editor/open', { worktree: 'wt', path: '../secret' })).toThrow()
  expect(() => assertPanelParameters('quirky.editor/open', { worktree: 'wt', path: 'src/index.ts', mode: 'source' })).not.toThrow()
})

test('validates scoped search and notes without treating a feature scope as caller identity', () => {
  expect(() => assertPanelParameters('quirky.vault/search', { host: 'local', query: 'repo:demo', scope: 'all', within: { repo: 'r1' }, filters: { sort: 'newest' } })).not.toThrow()
  expect(() => assertPanelParameters('quirky.vault/search', { host: 'another-host', query: 'x' })).toThrow()
  expect(() => assertPanelParameters('quirky.vault/list', { within: { repo: 'r1', worktree: 'w1' } })).toThrow()
  expect(() => assertPanelParameters('quirky.git/stage', { worktree: 'wt', scope: 'all' })).not.toThrow()
  expect(() => assertPanelParameters('quirky.git/sendNotes', { worktree: 'wt', scope: 'all', session: 's1' })).not.toThrow()
  expect(() => assertPanelParameters('quirky.git/sendNotes', { worktree: 'wt', scope: 'admin', session: 's1' })).toThrow()
})

test('confirmation and hosted targets remain constrained to consumer operations', () => {
  expect(() => assertPanelParameters('quirky.git/switchBranch', { worktree: 'wt', branch: 'feature', yes: true })).not.toThrow()
  expect(() => assertPanelParameters('quirky.git/switchBranch', { worktree: 'wt', branch: 'feature', yes: 'true' })).toThrow()
  expect(() => assertPanelParameters('quirky.hosting/reviewConversation', { worktree: 'wt', number: 1, action: 'delete', commentId: 3 })).toThrow()
  expect(() => assertPanelParameters('quirky.tasks/workspace', { target: { worktree: 'wt', kind: 'issue', number: 1 }, action: 'unlink' })).toThrow()
  expect(() => assertPanelParameters('quirky.tasks/workspace', { target: { worktree: 'wt', kind: 'issue', number: 1, env: { CREDENTIAL: 'spoof' } }, action: 'start' })).toThrow()
})

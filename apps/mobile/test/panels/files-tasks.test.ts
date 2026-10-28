import { expect, test } from 'bun:test'
import {
  classifyWorkspaceResult,
  MOBILE_EDITOR_DRAFT_LIMIT,
  MOBILE_EDITOR_INLINE_DRAFT_LIMIT,
  MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT,
  draftChunkLength,
  draftWriteMode,
  replaceTaskFilter,
  safeExplorerPath,
  sortExplorerEntries
} from '../../src/panels/files-tasks/model'

test('explorer accepts only entries contained by the returned worktree root and sorts folders first', () => {
  const root = '/work/repo'
  expect(safeExplorerPath({ path: '/work/repo/src/index.ts', name: 'index.ts', isDirectory: false }, root)).toBe('src/index.ts')
  expect(safeExplorerPath({ path: '/work/repo-link/secret', name: 'secret', isDirectory: false }, root)).toBeNull()
  expect(safeExplorerPath({ path: '/work/repo/leak', name: 'leak', isDirectory: false, isSymlink: true, error: 'This link points outside the worktree.' }, root)).toBeNull()
  expect(safeExplorerPath({ path: '../secret', name: 'secret', isDirectory: false }, root)).toBeNull()

  expect(sortExplorerEntries([
    { path: 'z.ts', name: 'z.ts', isDirectory: false },
    { path: 'docs', name: 'docs', isDirectory: true },
    { path: 'a', name: 'a', isDirectory: true }
  ]).map(({ name }) => name)).toEqual(['a', 'docs', 'z.ts'])
})

test('task filter updates replace only their own qualifiers and retain search/repository context', () => {
  const query = 'is:issue is:open assignee:old repo:acme/app "bad parser"'
  const closed = replaceTaskFilter(query, 'status', 'closed')
  expect(closed).toBe('is:issue assignee:old repo:acme/app "bad parser" is:closed')
  expect(replaceTaskFilter(closed, 'assignee', '@me')).toBe('is:issue repo:acme/app "bad parser" is:closed assignee:@me')
  expect(replaceTaskFilter('is:pr review-requested:alice review:approved repo:acme/app', 'review', 'needs-review'))
    .toBe('is:pr repo:acme/app review-requested:@me')
})


test('workspace composer is not success until the plugin confirms a created worktree', () => {
  expect(classifyWorkspaceResult({ kind: 'composer', requestId: 'req-1', name: 'fix-parser' }))
    .toMatchObject({ kind: 'composer', requestId: 'req-1' })
  expect(classifyWorkspaceResult({ kind: 'created', worktree: { id: 'wt-1', name: 'fix-parser' } }))
    .toMatchObject({ kind: 'created', worktreeId: 'wt-1', name: 'fix-parser' })
  expect(classifyWorkspaceResult({ kind: 'resumed', worktree: { id: 'existing-wt', name: 'linked-task' } }))
    .toMatchObject({ kind: 'resumed', worktreeId: 'existing-wt', name: 'linked-task' })
  expect(classifyWorkspaceResult({ kind: 'created', worktree: {} }).kind).toBe('invalid')
})
test('file drafts switch to bounded transfers beyond the safe direct-write size', () => {
  const inlineLimit = MOBILE_EDITOR_INLINE_DRAFT_LIMIT
  const totalBytes = MOBILE_EDITOR_DRAFT_LIMIT
  expect(draftWriteMode(inlineLimit)).toBe('inline')
  expect(draftWriteMode(inlineLimit + 1)).toBe('transfer')
  expect(draftWriteMode(totalBytes)).toBe('transfer')
  expect(() => draftWriteMode(totalBytes + 1)).toThrow('1 MiB')

  let offset = 0
  while (offset < totalBytes) {
    const length = draftChunkLength(totalBytes, offset, MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)
    expect(length).toBeGreaterThan(0)
    expect(length).toBeLessThanOrEqual(MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)
    offset += length
  }
  expect(offset).toBe(totalBytes)
  expect(draftChunkLength(totalBytes, totalBytes, MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT)).toBe(0)
})

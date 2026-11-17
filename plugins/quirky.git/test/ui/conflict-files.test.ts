import { expect, test } from 'bun:test'
import type { GitStatusEntry, ReviewFile } from '@quirky/protocol'
import { withStatusConflicts } from '../../src/panel/conflict-files'

test('a newly visible conflict combines status areas without inventing unknown line counts', () => {
  const entries: GitStatusEntry[] = [
    { path: 'new.ts', area: 'unstaged', status: 'modified', added: 2, removed: 3 },
    { path: 'new.ts', area: 'conflicts', status: 'modified', removed: 0, conflict: { kind: 'both_modified', state: 'unresolved' } },
    { path: 'new.ts', oldPath: 'old.ts', area: 'staged', status: 'renamed', added: 4, removed: 1 },
    { path: 'unrelated.ts', area: 'untracked', status: 'untracked' }
  ]

  const files = withStatusConflicts([], entries)
  expect(files.map(file => file.path)).toEqual(['new.ts'])
  expect(files[0]).toMatchObject({
    oldPath: 'old.ts', status: 'R', uncommitted: true, staged: true,
    added: null, removed: 4,
    conflict: { kind: 'both_modified', state: 'unresolved' }
  })
})

test('a capped status cannot clear a known conflict by omitting it', () => {
  const file: ReviewFile = {
    path: 'known.ts', status: 'M', added: 1, removed: 0, binary: false,
    uncommitted: true, staged: false, mark: 'none', notes: 0,
    conflict: { kind: 'both_modified', state: 'unresolved' }
  }
  const partialEntries: GitStatusEntry[][] = [
    [],
    [{ path: 'known.ts', area: 'staged', status: 'modified' }]
  ]
  for (const entries of partialEntries) {
    const projected = withStatusConflicts([file], entries, true)
    expect(projected[0]).toMatchObject({
      uncommitted: true,
      conflict: { kind: 'both_modified', state: 'unresolved' }
    })
  }
})

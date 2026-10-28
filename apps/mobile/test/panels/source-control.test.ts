import { describe, expect, test } from 'bun:test'
import {
  clearSentNotes,
  collectReviewFiles,
  moveDiffIndex,
  recordSentNotes,
  reviewProgress,
  reviewStorageKey,
  stageableReviewedPaths,
  toggleReviewedPath,
  type ReviewState
} from '../../src/panels/source-control/model'

const EMPTY: ReviewState = { reviewedPaths: [], sentNotes: [] }

describe('source-control review state', () => {
  test('completion uses the current unique file set, not stale reviewed paths', () => {
    expect(reviewProgress(['a.ts', 'b.ts', 'a.ts'], ['a.ts', 'removed.ts'])).toEqual({
      total: 2,
      reviewed: 1,
      complete: false
    })
    expect(reviewProgress(['a.ts', 'b.ts'], ['a.ts', 'b.ts'])).toEqual({ total: 2, reviewed: 2, complete: true })
    expect(reviewProgress([], ['removed.ts'])).toEqual({ total: 0, reviewed: 0, complete: false })
  })

  test('review toggles do not retain duplicate paths', () => {
    expect(toggleReviewedPath(['a.ts', 'a.ts', 'b.ts'], 'a.ts')).toEqual(['b.ts'])
    expect(toggleReviewedPath(['a.ts', 'a.ts'], 'b.ts')).toEqual(['a.ts', 'b.ts'])
  })

  test('stage-reviewed includes only unstaged and untracked reviewed worktree files', () => {
    expect(
      stageableReviewedPaths(['staged.ts', 'dirty.ts', 'new.ts', 'branch-only.ts'], [
        { path: 'staged.ts', area: 'staged' },
        { path: 'dirty.ts', area: 'unstaged' },
        { path: 'new.ts', area: 'untracked' },
        { path: 'conflict.ts', area: 'conflicts' }
      ])
    ).toEqual(['dirty.ts', 'new.ts'])
  })

  test('review traversal deduplicates local areas and appends branch-only files', () => {
    expect(
      collectReviewFiles(
        [
          { path: 'a.ts', area: 'staged', status: 'modified' },
          { path: 'a.ts', area: 'unstaged', status: 'modified' },
          { path: 'conflict.ts', area: 'conflicts', status: 'modified' },
          { path: 'new.ts', area: 'untracked', status: 'untracked' }
        ],
        [
          { path: 'a.ts', status: 'modified', binary: false },
          { path: 'branch-only.ts', status: 'added', binary: false }
        ]
      )
    ).toEqual([
      { path: 'a.ts', status: 'modified', binary: false, source: 'unstaged', areas: ['staged', 'unstaged'] },
      { path: 'conflict.ts', status: 'modified', binary: false, source: 'conflict', areas: ['conflicts'] },
      { path: 'new.ts', status: 'untracked', binary: false, source: 'unstaged', areas: ['untracked'] },
      { path: 'branch-only.ts', status: 'added', binary: false, source: 'branch', areas: [] }
    ])
  })

  test('only note IDs reported sent become locally clearable sent notes', () => {
    const notes = [
      { id: 'sent', path: 'a.ts', startLine: 2, line: 4, body: 'Keep this invariant', createdAt: 10, updatedAt: null },
      { id: 'kept', path: 'a.ts', startLine: 7, line: 7, body: 'Check edge case', createdAt: 11, updatedAt: null }
    ]
    const sent = recordSentNotes(EMPTY, notes, ['sent'], 'session-opaque', 42)
    expect(sent.sentNotes).toEqual([{ ...notes[0], sentAt: 42, targetSession: 'session-opaque' }])
    expect(recordSentNotes(EMPTY, notes, [], 'session-opaque', 43)).toBe(EMPTY)
    expect(clearSentNotes({ ...sent, reviewedPaths: ['a.ts'] })).toEqual({ reviewedPaths: ['a.ts'], sentNotes: [] })
  })

  test('diff navigation clamps at both ends and has no target for an empty file set', () => {
    expect(moveDiffIndex(0, 3, -1)).toBe(0)
    expect(moveDiffIndex(1, 3, 1)).toBe(2)
    expect(moveDiffIndex(2, 3, 1)).toBe(2)
    expect(moveDiffIndex(0, 0, 1)).toBeNull()
  })

  test('review persistence keys isolate both host and worktree identity', () => {
    expect(reviewStorageKey('host/a', 'wt:1')).not.toBe(reviewStorageKey('host', 'a/wt:1'))
    expect(reviewStorageKey('host/a', 'wt:1')).not.toBe(reviewStorageKey('other-host', 'wt:1'))
  })
})

import { describe, expect, test } from 'bun:test'
import type { GitStatusEntry } from '@quirky/protocol'
import {
  actionPaths,
  entryActions,
  isStageable,
  uncommittedBadge
} from '../../src/panel/sections'

const entry = (
  path: string,
  area: GitStatusEntry['area'],
  status: GitStatusEntry['status'] = 'modified',
  extra: Partial<GitStatusEntry> = {}
): GitStatusEntry => ({ path, area, status, ...extra })

const unresolved = (path: string): GitStatusEntry =>
  entry(path, 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })
const resolved = (path: string): GitStatusEntry =>
  entry(path, 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'resolved_locally' } })

const sample = [
  entry('README.md', 'staged'),
  entry('math.ts', 'unstaged'),
  entry('notes.txt', 'untracked', 'untracked'),
  unresolved('a.ts')
]

describe('entryActions', () => {
  test('a changed file can be staged and discarded', () => {
    expect(entryActions(entry('math.ts', 'unstaged'))).toEqual({ stage: true, unstage: false, discard: 'discard' })
  })

  test('a deleted tracked file offers restore', () => {
    expect(entryActions(entry('gone.ts', 'unstaged', 'deleted')).discard).toBe('restore')
  })

  test('an untracked file offers delete', () => {
    expect(entryActions(entry('n.txt', 'untracked', 'untracked'))).toEqual({
      stage: true,
      unstage: false,
      discard: 'delete'
    })
  })

  test('a staged row only offers unstage', () => {
    expect(entryActions(entry('README.md', 'staged'))).toEqual({ stage: false, unstage: true, discard: null })
  })

  test('an unresolved conflict is stageable only once its markers are gone', () => {
    const a = unresolved('a.ts')
    expect(entryActions(a)).toEqual({ stage: false, unstage: false, discard: null })
    expect(entryActions(a, { markersGone: new Set(['b.ts']) }).stage).toBe(false)
    expect(entryActions(a, { markersGone: new Set(['a.ts']) })).toEqual({ stage: true, unstage: false, discard: null })
  })

  test('modify/delete conflicts require named resolution instead of row or bulk Stage', () => {
    const context = { markersGone: new Set(['deleted-by-us.ts', 'deleted-by-them.ts', 'ordinary.ts']) }
    for (const kind of ['deleted_by_us', 'deleted_by_them'] as const) {
      const path = kind === 'deleted_by_us' ? 'deleted-by-us.ts' : 'deleted-by-them.ts'
      const conflict = entry(path, 'conflicts', 'deleted', { conflict: { kind, state: 'unresolved' } })
      expect(entryActions(conflict, context).stage).toBe(false)
      expect(actionPaths([conflict], 'stage', context)).toEqual([])
    }

    const ordinaryConflict = unresolved('ordinary.ts')
    expect(entryActions(ordinaryConflict, context).stage).toBe(true)
    expect(actionPaths([ordinaryConflict], 'stage', context)).toEqual(['ordinary.ts'])
  })

  test('unreadable modify/delete conflicts can be staged after markers are gone', () => {
    for (const kind of ['deleted_by_us', 'deleted_by_them'] as const) {
      const path = kind === 'deleted_by_us' ? 'binary-deleted-by-us' : 'binary-deleted-by-them'
      const conflict = entry(path, 'conflicts', 'deleted', { conflict: { kind, state: 'unresolved' } })
      const readableContext = { markersGone: new Set([path]) }
      const unreadableContext = { markersGone: new Set([path]), unreadableConflicts: new Set([path]) }

      expect(entryActions(conflict, readableContext).stage).toBe(false)
      expect(actionPaths([conflict], 'stage', readableContext)).toEqual([])

      expect(entryActions(conflict, unreadableContext).stage).toBe(true)
      expect(actionPaths([conflict], 'stage', unreadableContext)).toEqual([path])
    }

    const protectedContext = {
      markersGone: new Set(['resolved.ts', 'vendor/lib']),
      unreadableConflicts: new Set(['resolved.ts', 'vendor/lib'])
    }
    const resolvedConflict = entry('resolved.ts', 'conflicts', 'deleted', {
      conflict: { kind: 'deleted_by_them', state: 'resolved_locally' }
    })
    const submoduleConflict = entry('vendor/lib', 'conflicts', 'deleted', {
      conflict: { kind: 'deleted_by_them', state: 'unresolved' },
      submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
    })
    for (const conflict of [resolvedConflict, submoduleConflict]) {
      expect(entryActions(conflict, protectedContext).stage).toBe(false)
      expect(actionPaths([conflict], 'stage', protectedContext)).toEqual([])
    }
  })

  test('a conflict resolved locally is already staged in git, so it has no row actions', () => {
    expect(entryActions(resolved('d.ts'), { markersGone: new Set(['d.ts']) })).toEqual({
      stage: false,
      unstage: false,
      discard: null
    })
  })

  test('submodule rows are read-only', () => {
    const sub = entry('vendor/lib', 'unstaged', 'modified', {
      submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
    })
    expect(entryActions(sub)).toEqual({ stage: false, unstage: false, discard: null })
    expect(entryActions({ ...sub, area: 'staged' })).toEqual({ stage: false, unstage: false, discard: null })
  })

  test('isStageable mirrors the stage flag', () => {
    expect(isStageable(entry('a', 'unstaged'))).toBe(true)
    expect(isStageable(entry('a', 'staged'))).toBe(false)
  })
})

describe('actionPaths', () => {
  const rename = entry('new.ts', 'staged', 'renamed', { oldPath: 'old.ts' })

  test('unstaging a rename includes both paths', () => {
    expect(actionPaths([rename, entry('b.ts', 'staged')], 'unstage')).toEqual(['new.ts', 'old.ts', 'b.ts'])
  })

  test('discarding staged renames includes the old path', () => {
    expect(actionPaths([rename], 'discard')).toEqual([])
    expect(actionPaths([rename], 'discard-all')).toEqual(['new.ts', 'old.ts'])
  })

  test('stage skips rows that are not stageable', () => {
    const rows = [entry('a', 'unstaged'), unresolved('c.ts'), entry('s', 'staged')]
    expect(actionPaths(rows, 'stage')).toEqual(['a'])
    expect(actionPaths(rows, 'stage', { markersGone: new Set(['c.ts']) })).toEqual(['a', 'c.ts'])
  })

  test('discard-all also takes staged rows but still skips conflicts', () => {
    const rows = [entry('s', 'staged'), entry('a', 'unstaged'), unresolved('c'), resolved('d')]
    expect(actionPaths(rows, 'discard-all')).toEqual(['s', 'a'])
  })

  test('discard skips conflicts, staged rows and submodules', () => {
    const rows = [entry('a', 'unstaged'), entry('u', 'untracked', 'untracked'), unresolved('c'), resolved('d')]
    expect(actionPaths(rows, 'discard')).toEqual(['a', 'u'])
  })
})

describe('uncommittedBadge', () => {
  test('is null with nothing changed', () => {
    expect(uncommittedBadge([], false)).toBeNull()
  })

  test('singular and plural titles', () => {
    expect(uncommittedBadge([entry('a', 'unstaged')], false)).toEqual({
      count: 1,
      title: 'Source Control — 1 uncommitted change'
    })
    expect(uncommittedBadge(sample, false)).toEqual({ count: 4, title: 'Source Control — 4 uncommitted changes' })
  })

  test('a capped status adds a plus', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => entry(`f${i}`, 'unstaged'))
    expect(uncommittedBadge(rows, true)).toEqual({ count: 1000, title: 'Source Control — 1000+ uncommitted changes' })
    expect(uncommittedBadge([entry('a', 'unstaged')], true)?.title).toBe('Source Control — 1+ uncommitted changes')
  })

  test('a resolved-locally row that also has another row counts once', () => {
    const rows = [resolved('a.ts'), entry('a.ts', 'staged'), resolved('b.ts')]
    expect(uncommittedBadge(rows, false)?.count).toBe(2)
  })
})

import { describe, expect, test } from 'bun:test'
import type { GitStatusEntry } from '@quirky/protocol'
import {
  actionPaths,
  entryActions,
  groupSections,
  isStageable,
  sectionButtons,
  uncommittedBadge,
  type Section
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

describe('groupSections', () => {
  const ids = (sections: Section[]) => sections.map((s) => s.id)

  test('changes-first puts conflicts, then changes, staged and untracked', () => {
    expect(ids(groupSections(sample, 'changes-first'))).toEqual(['conflicts', 'unstaged', 'staged', 'untracked'])
  })

  test('staged-first', () => {
    expect(ids(groupSections(sample, 'staged-first'))).toEqual(['conflicts', 'staged', 'unstaged', 'untracked'])
  })

  test('untracked-first', () => {
    expect(ids(groupSections(sample, 'untracked-first'))).toEqual(['conflicts', 'untracked', 'unstaged', 'staged'])
  })

  test('conflicts stay first in every order', () => {
    for (const order of ['changes-first', 'staged-first', 'untracked-first'] as const) {
      expect(groupSections(sample, order)[0].id).toBe('conflicts')
    }
  })

  test('empty sections are omitted', () => {
    expect(ids(groupSections([entry('a', 'staged')], 'changes-first'))).toEqual(['staged'])
    expect(groupSections([], 'changes-first')).toEqual([])
  })

  test('headings and counts', () => {
    const sections = groupSections(sample, 'changes-first')
    expect(sections.map((s) => [s.heading, s.count])).toEqual([
      ['Conflicts', 1],
      ['Changes', 1],
      ['Staged Changes', 1],
      ['Untracked Files', 1]
    ])
  })

  test('a path both staged and changed appears in both sections', () => {
    const sections = groupSections([entry('a.ts', 'staged'), entry('a.ts', 'unstaged')], 'changes-first')
    expect(sections.map((s) => s.id)).toEqual(['unstaged', 'staged'])
  })

  test('sorts unresolved conflicts, then resolved locally, then the rest', () => {
    const conflicts = groupSections([resolved('a.ts'), unresolved('z.ts'), unresolved('b.ts')], 'changes-first')[0]
    expect(conflicts.entries.map((e) => e.path)).toEqual(['b.ts', 'z.ts', 'a.ts'])
  })

  test('sorts by natural file name, ignoring the folder, then by path', () => {
    const rows = [
      entry('z/file10.ts', 'unstaged'),
      entry('a/file2.ts', 'unstaged'),
      entry('b/file2.ts', 'unstaged'),
      entry('file1.ts', 'unstaged')
    ]
    expect(groupSections(rows, 'changes-first')[0].entries.map((e) => e.path)).toEqual([
      'file1.ts',
      'a/file2.ts',
      'b/file2.ts',
      'z/file10.ts'
    ])
  })

  test('name order is case-insensitive like the collator', () => {
    const rows = [entry('b.ts', 'unstaged'), entry('A.ts', 'unstaged'), entry('c.ts', 'unstaged')]
    expect(groupSections(rows, 'changes-first')[0].entries.map((e) => e.path)).toEqual(['A.ts', 'b.ts', 'c.ts'])
  })

  test('does not reorder the input', () => {
    const input = [entry('b', 'unstaged'), entry('a', 'unstaged')]
    groupSections(input, 'changes-first')
    expect(input.map((e) => e.path)).toEqual(['b', 'a'])
  })
})

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
      expect(sectionButtons(groupSections([conflict], 'changes-first')[0], context).stageAll).toBe(false)
      expect(actionPaths([conflict], 'stage', context)).toEqual([])
    }

    const ordinaryConflict = unresolved('ordinary.ts')
    expect(entryActions(ordinaryConflict, context).stage).toBe(true)
    expect(sectionButtons(groupSections([ordinaryConflict], 'changes-first')[0], context).stageAll).toBe(true)
    expect(actionPaths([ordinaryConflict], 'stage', context)).toEqual(['ordinary.ts'])
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

describe('sectionButtons', () => {
  const section = (entries: GitStatusEntry[], order: 'changes-first' = 'changes-first') => groupSections(entries, order)[0]

  test('changes section', () => {
    expect(sectionButtons(section([entry('a', 'unstaged')]))).toEqual({
      discardAll: { label: 'Discard all' },
      stageAll: true,
      unstageAll: false,
      viewAll: true
    })
  })

  test('untracked section says Delete all untracked', () => {
    expect(sectionButtons(section([entry('a', 'untracked', 'untracked')])).discardAll).toEqual({
      label: 'Delete all untracked'
    })
  })

  test('untracked Stage all is hidden when the list is capped', () => {
    const s = section([entry('a', 'untracked', 'untracked')])
    expect(sectionButtons(s, { capped: true }).stageAll).toBe(false)
    expect(sectionButtons(section([entry('a', 'unstaged')]), { capped: true }).stageAll).toBe(true)
  })

  test('staged section offers Unstage all and Discard all', () => {
    expect(sectionButtons(section([entry('a', 'staged')]))).toEqual({
      discardAll: { label: 'Discard all' },
      stageAll: false,
      unstageAll: true,
      viewAll: true
    })
  })

  test('conflicts section only offers View all', () => {
    expect(sectionButtons(section([unresolved('a.ts')]))).toEqual({
      discardAll: null,
      stageAll: false,
      unstageAll: false,
      viewAll: true
    })
  })

  test('a section of submodules has no stage or discard buttons', () => {
    const sub = entry('v', 'unstaged', 'modified', {
      submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
    })
    expect(sectionButtons(section([sub]))).toEqual({
      discardAll: null,
      stageAll: false,
      unstageAll: false,
      viewAll: true
    })
  })

  test('filtering hides every button', () => {
    expect(sectionButtons(section([entry('a', 'unstaged')]), { filtering: true })).toEqual({
      discardAll: null,
      stageAll: false,
      unstageAll: false,
      viewAll: false
    })
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

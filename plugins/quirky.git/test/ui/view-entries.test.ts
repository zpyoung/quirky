import { describe, expect, test } from 'bun:test'
import type { GitChange, GitStatusEntry } from '@quirky/protocol'
import {
  changeSections,
  combinedTitle,
  entrySignature,
  loadMode,
  statusSections,
  uncommittedAreas,
  type SectionEntry
} from '../../src/view/entries'

const row = (overrides: Partial<GitStatusEntry> & Pick<GitStatusEntry, 'path' | 'area'>): GitStatusEntry => ({
  status: 'modified',
  added: 1,
  removed: 1,
  ...overrides
})

const entry = (overrides: Partial<SectionEntry> = {}): SectionEntry => ({
  key: 'unstaged:a.ts',
  path: 'a.ts',
  source: 'unstaged',
  status: 'modified',
  added: 1,
  removed: 1,
  binary: false,
  submodule: false,
  ...overrides
})

describe('statusSections', () => {
  const status = {
    entries: [
      row({ path: 'a.ts', area: 'unstaged' }),
      row({ path: 'a.ts', area: 'staged' }),
      row({ path: 'new.txt', area: 'untracked', status: 'untracked', added: 3, removed: 0 }),
      row({ path: 'c.ts', area: 'conflicts', conflict: { kind: 'both_modified', state: 'unresolved' } }),
      row({ path: 'd.ts', area: 'conflicts', conflict: { kind: 'both_modified', state: 'resolved_locally' } })
    ]
  }

  test('SC-62: takes the areas asked for in order, with unstaged diffs read from the working file', () => {
    const { entries } = statusSections(status, ['staged', 'unstaged', 'untracked'])
    expect(entries.map((e) => `${e.source}:${e.path}`)).toEqual(['staged:a.ts', 'unstaged:a.ts', 'unstaged:new.txt'])
    expect(new Set(entries.map((e) => e.key)).size).toBe(3)
  })

  test('SC-62: unresolved conflicts are counted as excluded, never listed', () => {
    const { entries, excluded } = statusSections(status, ['unstaged'])
    expect(excluded).toBe(1)
    expect(entries.map((e) => e.path)).toEqual(['a.ts'])
  })

  test('counts that git did not give are null', () => {
    const { entries } = statusSections({ entries: [{ path: 'x', area: 'unstaged', status: 'modified' }] }, ['unstaged'])
    expect(entries[0]).toMatchObject({ added: null, removed: null, binary: false, submodule: false })
  })
})

describe('changeSections', () => {
  test('branch and commit diffs carry their source, and a commit its id', () => {
    const changes: GitChange[] = [{ path: 'b.ts', oldPath: 'a.ts', status: 'renamed', added: 2, removed: 1, binary: false }]
    expect(changeSections(changes, 'commit', 'c'.repeat(40))[0]).toMatchObject({
      key: 'commit:b.ts',
      oldPath: 'a.ts',
      source: 'commit',
      commit: 'c'.repeat(40)
    })
    expect(changeSections(changes, 'branch')[0].commit).toBeUndefined()
  })
})

describe('loadMode', () => {
  test('SC-62: small files load by themselves, large and unsized ones wait for a click', () => {
    expect(loadMode(entry())).toBe('auto')
    expect(loadMode(entry({ added: 6000, removed: 4000 }))).toBe('auto')
    expect(loadMode(entry({ added: 12_000, removed: 0 }))).toBe('large')
    expect(loadMode(entry({ added: null, removed: null }))).toBe('unknown')
  })

  test('binary files and submodules never wait', () => {
    expect(loadMode(entry({ added: null, removed: null, binary: true }))).toBe('auto')
    expect(loadMode(entry({ added: null, removed: null, submodule: true }))).toBe('auto')
  })
})

describe('combinedTitle and areas', () => {
  const input = { worktree: 'w', mode: 'combined' as const }
  test('SC-62: titles follow the area, and the branch title names its base', () => {
    expect(combinedTitle(input, null, null)).toBe('Changes')
    expect(combinedTitle({ ...input, area: 'staged' }, null, null)).toBe('Staged Changes')
    expect(combinedTitle({ ...input, area: 'all' }, null, null)).toBe('All Changes')
    expect(combinedTitle({ ...input, area: 'branch' }, { base: 'origin/main' }, null)).toBe('Branch Changes (origin/main)')
    expect(combinedTitle({ ...input, commit: 'abcdef0123' }, null, null)).toBe('Commit abcdef0')
    expect(combinedTitle({ ...input, area: 'unstaged', title: 'Mine' }, null, null)).toBe('Mine')
  })

  test('which uncommitted areas each combined diff covers', () => {
    expect(uncommittedAreas('all')).toEqual(['staged', 'unstaged', 'untracked'])
    expect(uncommittedAreas('branch')).toEqual([])
    expect(uncommittedAreas('unstaged')).toEqual(['unstaged'])
  })
})

test('entrySignature changes with the counts, so a changed file reloads', () => {
  expect(entrySignature(entry())).toBe(entrySignature(entry()))
  expect(entrySignature(entry({ added: 2 }))).not.toBe(entrySignature(entry()))
})

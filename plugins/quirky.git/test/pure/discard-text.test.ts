import { describe, expect, test } from 'bun:test'
import type { GitStatusEntry } from '@quirky/protocol'
import { describeDiscardText, discardText } from '../../src/shared/discard-text'

const entry = (path: string, area: GitStatusEntry['area'], status: GitStatusEntry['status'] = 'modified'): GitStatusEntry => ({
  path,
  area,
  status
})

describe('discardText', () => {
  test('untracked file', () => {
    expect(discardText({ kind: 'file', path: 'src/notes.txt', area: 'untracked', status: 'untracked' })).toEqual({
      title: 'Delete "notes.txt"?',
      body: 'This will permanently delete this file. This cannot be undone.',
      confirm: 'Delete'
    })
  })

  test('deleted tracked file', () => {
    expect(discardText({ kind: 'file', path: 'gone.ts', area: 'unstaged', status: 'deleted' })).toEqual({
      title: 'Restore "gone.ts"?',
      body: 'This will restore the last staged version and discard the deletion. This cannot be undone.',
      confirm: 'Restore'
    })
  })

  test('other file', () => {
    expect(discardText({ kind: 'file', path: 'math.ts', area: 'unstaged', status: 'modified' })).toEqual({
      title: 'Discard changes to "math.ts"?',
      body: 'This will revert the unstaged changes to this file. This cannot be undone.',
      confirm: 'Discard'
    })
  })

  test('untracked section of several files', () => {
    expect(discardText({ kind: 'section', area: 'untracked', count: 3 })).toEqual({
      title: 'Delete 3 untracked files?',
      body: 'This will permanently delete these 3 untracked files. This cannot be undone.',
      confirm: 'Delete 3'
    })
  })

  test('untracked section of one file', () => {
    expect(discardText({ kind: 'section', area: 'untracked', count: 1 })).toEqual({
      title: 'Delete 1 untracked file?',
      body: 'This will permanently delete this untracked file. This cannot be undone.',
      confirm: 'Delete'
    })
  })

  test('staged section', () => {
    expect(discardText({ kind: 'section', area: 'staged', count: 2 })).toEqual({
      title: 'Discard all staged changes?',
      body: 'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.',
      confirm: 'Discard all'
    })
  })

  test('changes section', () => {
    expect(discardText({ kind: 'section', area: 'unstaged', count: 2 })).toEqual({
      title: 'Discard all unstaged changes?',
      body: 'This will revert all unstaged changes. This cannot be undone.',
      confirm: 'Discard all'
    })
  })
})

describe('describeDiscardText', () => {
  const entries = [
    entry('math.ts', 'unstaged'),
    entry('gone.ts', 'unstaged', 'deleted'),
    entry('notes.txt', 'untracked', 'untracked'),
    entry('tmp/a', 'untracked', 'untracked'),
    entry('tmp/b', 'untracked', 'untracked'),
    entry('README.md', 'staged')
  ]

  test('one changed path', () => {
    expect(describeDiscardText({ paths: ['math.ts'], entries })).toBe(
      'Discard changes to "math.ts"? This will revert the unstaged changes to this file. This cannot be undone.'
    )
  })

  test('one deleted path', () => {
    expect(describeDiscardText({ paths: ['gone.ts'], entries })).toStartWith('Restore "gone.ts"? ')
  })

  test('one untracked path', () => {
    expect(describeDiscardText({ paths: ['notes.txt'], entries })).toStartWith('Delete "notes.txt"? ')
  })

  test('a path both staged and changed is described by its changed side', () => {
    const both = [entry('a.ts', 'staged'), entry('a.ts', 'unstaged')]
    expect(describeDiscardText({ paths: ['a.ts'], entries: both })).toStartWith('Discard changes to "a.ts"? ')
  })

  test('a path that is not listed is described as other', () => {
    expect(describeDiscardText({ paths: ['x/y.ts'], entries: [] })).toStartWith('Discard changes to "y.ts"? ')
  })

  test('an area counts its entries', () => {
    expect(describeDiscardText({ area: 'untracked', entries })).toBe(
      'Delete 3 untracked files? This will permanently delete these 3 untracked files. This cannot be undone.'
    )
    expect(describeDiscardText({ area: 'staged', entries })).toStartWith('Discard all staged changes? ')
    expect(describeDiscardText({ area: 'unstaged', entries })).toStartWith('Discard all unstaged changes? ')
  })

  test('several untracked paths read as an untracked section', () => {
    expect(describeDiscardText({ paths: ['tmp/a', 'tmp/b'], entries })).toStartWith('Delete 2 untracked files? ')
  })

  test('several mixed paths get a count-based title', () => {
    expect(describeDiscardText({ paths: ['math.ts', 'notes.txt', 'gone.ts'], entries })).toStartWith(
      'Discard changes to 3 files? '
    )
  })
})

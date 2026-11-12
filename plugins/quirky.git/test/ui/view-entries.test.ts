import { describe, expect, test } from 'bun:test'
import type { GitChange, ReviewFile } from '@quirky/protocol'
import { AUTO_LOAD_MAX_LINES, EAGER_SECTIONS } from '../../src/view/entries'
import { itemFromChange, itemFromFile, loadModeOf } from '../../src/view/review-layout'

const file = (overrides: Partial<ReviewFile> = {}): ReviewFile => ({
  path: 'a.ts',
  status: 'M',
  added: 1,
  removed: 1,
  binary: false,
  uncommitted: true,
  staged: false,
  mark: 'none',
  notes: 0,
  ...overrides
})

describe('loadModeOf', () => {
  test('SC-62: small files load by themselves, large and unsized ones wait for a click', () => {
    expect(AUTO_LOAD_MAX_LINES).toBe(10_000)
    expect(loadModeOf(itemFromFile(file()))).toBe('auto')
    expect(loadModeOf(itemFromFile(file({ added: 6000, removed: 4000 })))).toBe('auto')
    expect(loadModeOf(itemFromFile(file({ added: 12_000, removed: 0 })))).toBe('large')
    expect(loadModeOf(itemFromFile(file({ added: null, removed: null })))).toBe('unknown')
  })

  test('binary files and submodules never wait', () => {
    expect(loadModeOf(itemFromFile(file({ added: null, removed: null, binary: true })))).toBe('auto')
    expect(loadModeOf({ added: null, removed: null, binary: false, submodule: true })).toBe('auto')
  })

  test('the first cards load at once', () => {
    expect(EAGER_SECTIONS).toBe(6)
  })
})

describe('review items', () => {
  test('a path is a different card in another scope', () => {
    const change: GitChange = { path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false }
    expect(itemFromFile(file()).key).not.toBe(itemFromChange(change, 'c'.repeat(40)).key)
    expect(itemFromChange(change, 'c'.repeat(40)).key).not.toBe(itemFromChange(change, 'd'.repeat(40)).key)
  })

  test('a commit file is never reviewed and carries no notes', () => {
    const change: GitChange = { path: 'b.ts', oldPath: 'a.ts', status: 'renamed', added: 2, removed: 1, binary: false }
    expect(itemFromChange(change, 'c'.repeat(40))).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', mark: 'none', notes: 0 })
  })

  test('the signature changes with the counts, so a changed file reloads', () => {
    expect(itemFromFile(file()).signature).toBe(itemFromFile(file()).signature)
    expect(itemFromFile(file({ added: 2 })).signature).not.toBe(itemFromFile(file()).signature)
    expect(itemFromFile(file({ status: 'A' })).signature).not.toBe(itemFromFile(file()).signature)
  })

  test('the signature ignores the review mark and the notes, which do not change the diff', () => {
    expect(itemFromFile(file({ mark: 'reviewed', notes: 3 })).signature).toBe(itemFromFile(file()).signature)
  })
})

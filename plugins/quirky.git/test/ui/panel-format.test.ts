import { describe, expect, test } from 'bun:test'
import {
  commitTitle,
  conflictLabel,
  dataOf,
  hasMoreDetail,
  manyDiscardText,
  messageRows,
  reasonOf,
  relativeTime,
  shortOid,
  splitPath,
  splitQuestion,
  statusLetter
} from '../../src/panel/format'

describe('the panel\'s text helpers', () => {
  test('splitPath separates the folder from the name', () => {
    expect(splitPath('src/app/a.ts')).toEqual({ name: 'a.ts', dir: 'src/app' })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
  })

  test('commit titles use the seven-character id', () => {
    expect(shortOid('1a2b3c4d5e6f')).toBe('1a2b3c4')
    expect(commitTitle('1a2b3c4d5e6f', 'Merge main')).toBe('Commit 1a2b3c4: Merge main')
  })

  test('letters and conflict labels', () => {
    expect(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked'].map((s) => statusLetter(s as never))).toEqual(['M', 'A', 'D', 'R', 'C', 'U'])
    expect(conflictLabel('deleted_by_them')).toBe('Deleted by them')
  })

  test('the message box has 2 to 12 rows, one per line', () => {
    expect(messageRows('')).toBe(2)
    expect(messageRows('a\nb\nc')).toBe(3)
    expect(messageRows('\n'.repeat(40))).toBe(12)
    expect(messageRows('a\n'.repeat(70_000))).toBeLessThanOrEqual(12)
  })

  test('relative times', () => {
    const now = 10_000_000_000
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2d ago')
  })

  test('errors give their reason, falling back to failed', () => {
    const error = Object.assign(new Error('x'), { data: { reason: 'stale-lease', summary: 's' } })
    expect(reasonOf(error)).toBe('stale-lease')
    expect(dataOf(error).summary).toBe('s')
    expect(reasonOf(new Error('x'))).toBe('failed')
    expect(reasonOf(Object.assign(new Error('x'), { data: { reason: 'something-new' } }))).toBe('failed')
    expect(dataOf(null)).toEqual({})
  })

  test('Details show only when the output says more than the summary', () => {
    expect(hasMoreDetail('Lint failed.', 'eslint found 2 problems')).toBe(true)
    expect(hasMoreDetail('Pre-commit hook failed.', 'Pre-commit   hook\nfailed.')).toBe(false)
    expect(hasMoreDetail('Failed.', '')).toBe(false)
    expect(hasMoreDetail('Failed.', 'x'.repeat(70_000))).toBe(true)
  })

  test('a confirmation sentence splits into heading and body', () => {
    expect(splitQuestion('Force push a to origin? This replaces the remote.')).toEqual({ title: 'Force push a to origin?', body: 'This replaces the remote.' })
    expect(splitQuestion('Sure?')).toEqual({ title: 'Sure?', body: '' })
  })

  test('discarding several rows reads as a section when all are untracked', () => {
    const row = (path: string, area: 'untracked' | 'unstaged') => ({ path, area, status: area === 'untracked' ? 'untracked' : 'modified' }) as never
    expect(manyDiscardText([row('a', 'untracked'), row('b', 'untracked')]).title).toBe('Delete 2 untracked files?')
    expect(manyDiscardText([row('a', 'unstaged'), row('b', 'untracked')])).toEqual({
      title: 'Discard changes to 2 files?',
      body: 'This will revert the unstaged changes to these files. This cannot be undone.',
      confirm: 'Discard 2'
    })
  })
})

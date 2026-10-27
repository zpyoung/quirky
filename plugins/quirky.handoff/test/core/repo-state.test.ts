import { describe, expect, test } from 'bun:test'
import { formatRepoState } from '../../src/core/repo-state'
import { gitStatus, textDiff } from './support'

describe('formatRepoState', () => {
  test('lists staged renames, unstaged changes and untracked files (SC-14)', () => {
    const status = gitStatus([
      { path: 'b.ts', oldPath: 'a.ts', area: 'staged', status: 'renamed' },
      { path: 'c.ts', area: 'unstaged', status: 'modified' },
      { path: 'd.ts', area: 'untracked', status: 'untracked' }
    ])
    expect(formatRepoState(status)).toEqual({
      text: [
        'Branch: feature',
        'Git status:',
        'staged: renamed a.ts -> b.ts',
        'unstaged: modified c.ts',
        'untracked: untracked d.ts',
        'Changed file paths:',
        'b.ts',
        'c.ts',
        'd.ts'
      ].join('\n'),
      truncated: false
    })
  })

  test('lists a path once when it is both staged and changed', () => {
    const status = gitStatus([
      { path: 'a.ts', area: 'staged', status: 'modified' },
      { path: 'a.ts', area: 'unstaged', status: 'modified' }
    ])
    expect(formatRepoState(status).text.split('Changed file paths:\n')[1]).toBe('a.ts')
  })

  test('says so when the tree is clean (SC-14)', () => {
    const { text } = formatRepoState(gitStatus([]))
    expect(text).toContain('Git status:\nClean working tree.')
    expect(text).toContain('Changed file paths:\nNo repository changes were reported.')
  })

  test('names the detached state when there is no branch', () => {
    expect(formatRepoState(gitStatus([], { branch: null, detached: true })).text).toStartWith('Branch: detached HEAD')
  })

  test('says more changes were omitted when the status was capped (SC-16)', () => {
    const status = gitStatus([{ path: 'a.ts', area: 'unstaged', status: 'modified' }], { capped: true })
    const result = formatRepoState(status)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('unstaged: modified a.ts\n... additional changes omitted.\nChanged file paths:')
  })

  test('includes diff bodies per file and omits binary ones (SC-15)', () => {
    const status = gitStatus([
      { path: 'c.ts', area: 'unstaged', status: 'modified' },
      { path: 'logo.png', area: 'unstaged', status: 'modified' }
    ])
    const diffs = [
      textDiff('c.ts', 'old line', 'new line'),
      { ...textDiff('logo.png', '', ''), binary: true, kind: 'image' as const }
    ]
    const result = formatRepoState(status, diffs)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain(
      'Included diff bodies:\n### unstaged: modified c.ts\n--- before\nold line\n+++ after\nnew line\n### unstaged: modified logo.png\n[binary diff omitted]'
    )
  })

  test('treats a too-large diff as omitted', () => {
    const status = gitStatus([{ path: 'big.ts', area: 'unstaged', status: 'modified' }])
    const diff = { ...textDiff('big.ts', '', ''), tooLarge: { originalLines: 1, modifiedLines: 1, characters: 9, reason: 'characters' as const } }
    expect(formatRepoState(status, [diff]).text).toContain('### unstaged: modified big.ts\n[binary diff omitted]')
  })

  test('picks the staged entry for a staged diff', () => {
    const status = gitStatus([
      { path: 'a.ts', area: 'unstaged', status: 'modified' },
      { path: 'a.ts', area: 'staged', status: 'added' }
    ])
    expect(formatRepoState(status, [textDiff('a.ts', '', 'x', true)]).text).toContain('### staged: added a.ts')
  })

  test('cuts diff bodies at 12,000 characters with a note (SC-15)', () => {
    const status = gitStatus([{ path: 'c.ts', area: 'unstaged', status: 'modified' }])
    const result = formatRepoState(status, [textDiff('c.ts', 'a'.repeat(20_000), 'b')])
    const bodies = result.text.split('Included diff bodies:\n')[1]!
    expect(result.truncated).toBe(true)
    expect(bodies).toEndWith('\n[Diff bodies truncated at 12000 characters.]')
    expect(bodies.length).toBe(12_000 + '\n[Diff bodies truncated at 12000 characters.]'.length)
  })

  test('leaves the diff section out when no diffs are given', () => {
    const status = gitStatus([{ path: 'c.ts', area: 'unstaged', status: 'modified' }])
    expect(formatRepoState(status, []).text).not.toContain('Included diff bodies')
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { editedPathsOfItem, editToolFiles } from './turn-edit-tool-paths'

function call(
  name: string,
  input: unknown,
  state: 'running' | 'completed' | 'failed' = 'completed'
): AgentJournalItemBody {
  return { kind: 'tool-call', name, input, state }
}

describe('editedPathsOfItem', () => {
  it('reads the path field of each agent edit tool', () => {
    expect(editedPathsOfItem(call('Edit', { file_path: '/w/a.ts' }))).toEqual(['/w/a.ts'])
    expect(editedPathsOfItem(call('Write', { file_path: '/w/b.ts' }))).toEqual(['/w/b.ts'])
    expect(editedPathsOfItem(call('MultiEdit', { file_path: '/w/c.ts' }))).toEqual(['/w/c.ts'])
    expect(editedPathsOfItem(call('NotebookEdit', { notebook_path: '/w/n.ipynb' }))).toEqual([
      '/w/n.ipynb'
    ])
    expect(editedPathsOfItem(call('edit', { path: 'src/d.ts' }))).toEqual(['src/d.ts'])
  })

  it('reads the files an apply_patch names', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch'
    expect(editedPathsOfItem(call('apply_patch', { input: patch }))).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
    expect(editedPathsOfItem(call('apply_patch', { changes: [{ path: '/w/x.ts' }] }))).toEqual([
      '/w/x.ts'
    ])
  })

  it('reads a diff item but not a multi-file count', () => {
    const patch = { head: '', byteLength: 0, digest: 'd', truncated: false }
    expect(editedPathsOfItem({ kind: 'diff', path: '/w/a.ts', patch })).toEqual(['/w/a.ts'])
    expect(editedPathsOfItem({ kind: 'diff', path: '3 files', patch })).toEqual([])
  })

  it('ignores a call that did not complete, and every other tool', () => {
    expect(editedPathsOfItem(call('Edit', { file_path: '/w/a.ts' }, 'failed'))).toEqual([])
    expect(editedPathsOfItem(call('Edit', { file_path: '/w/a.ts' }, 'running'))).toEqual([])
    expect(editedPathsOfItem(call('Bash', { command: 'touch x' }))).toEqual([])
    expect(editedPathsOfItem(call('Read', { file_path: '/w/a.ts' }))).toEqual([])
  })
})

describe('editToolFiles', () => {
  it('makes workspace paths relative, deduplicates, and keeps outside paths whole', () => {
    expect(editToolFiles(['/w/src/a.ts', 'src/a.ts', '/w/b.ts', '/elsewhere/c.ts'], '/w')).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'b.ts', status: 'modified' },
      { path: '/elsewhere/c.ts', status: 'modified' }
    ])
  })
})

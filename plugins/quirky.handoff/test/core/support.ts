import type { GitDiff, GitStatus, GitStatusEntry } from '@quirky/protocol'

export function gitStatus(entries: GitStatusEntry[], overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feature',
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    head: null,
    detached: false,
    unborn: false,
    entries,
    operation: 'none',
    capped: false,
    upstreamStatus: { hasUpstream: false, name: '', sha: null, ahead: 0, behind: 0 } as GitStatus['upstreamStatus'],
    busy: null,
    ...overrides
  }
}

export function textDiff(path: string, original: string, modified: string, staged = false): GitDiff {
  return { path, staged, original, modified, binary: false, source: staged ? 'staged' : 'unstaged', kind: 'text' }
}

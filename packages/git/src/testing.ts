import { existsSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import type { GitDiff, GitDiffPair, GitStatus, GitStatusSummary } from '@quirky/protocol'
import * as realGit from './index'
import type { GitApi } from './api'

export type FakeGit = GitApi & {
  calls: { fn: string; args: unknown[] }[]
  addRepo(root: string): void
  worktreesByRepo: Map<string, realGit.GitWorktreeInfo[]>
}

/** An in-memory git: repos are registered with `addRepo`, and worktree operations edit a list. */
export function createFakeGit(): FakeGit {
  const worktreesByRepo = new Map<string, realGit.GitWorktreeInfo[]>()
  const calls: { fn: string; args: unknown[] }[] = []
  const record = (fn: string, ...args: unknown[]) => calls.push({ fn, args })

  const fake: FakeGit = {
    ...realGit,
    calls,
    worktreesByRepo,
    addRepo(root) {
      worktreesByRepo.set(root, [{ path: root, branch: 'main', head: 'a'.repeat(40), isMain: true, locked: null }])
    },
    async resolveRepoRoot(path) {
      record('resolveRepoRoot', path)
      for (const root of worktreesByRepo.keys()) {
        if (path === root || path.startsWith(`${root}/`)) return root
      }
      throw new realGit.GitError('not a git repository', 'fatal: not a git repository', 128)
    },
    async listWorktrees(repoPath) {
      record('listWorktrees', repoPath)
      const list = worktreesByRepo.get(repoPath)
      if (!list) throw new realGit.GitError('not a git repository', 'fatal', 128)
      return list.map((w) => ({ ...w }))
    },
    async listRegistrations(repoPath) {
      record('listRegistrations', repoPath)
      const list = worktreesByRepo.get(repoPath)
      if (!list) throw new realGit.GitError('not a git repository', 'fatal', 128)
      return list.map((w) => ({ ...w, locked: null, prunable: false, exists: existsSync(w.path) }))
    },
    async addWorktree(repoPath, path, branch, baseRef) {
      record('addWorktree', repoPath, path, branch, baseRef)
      mkdirSync(path, { recursive: true })
      worktreesByRepo.get(repoPath)?.push({ path, branch, head: 'b'.repeat(40), isMain: false, locked: null })
    },
    async removeWorktree(repoPath, path, force) {
      record('removeWorktree', repoPath, path, force)
      const list = worktreesByRepo.get(repoPath)
      if (list) {
        worktreesByRepo.set(
          repoPath,
          list.filter((w) => w.path !== path)
        )
      }
    },
    async status(cwd): Promise<GitStatusSummary> {
      record('status', cwd)
      return {
        branch: basename(cwd),
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [{ path: 'a.txt', index: ' ', worktree: 'M', untracked: false }]
      }
    },
    async statusV2(cwd): Promise<GitStatus> {
      record('statusV2', cwd)
      return {
        branch: basename(cwd),
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [{ path: 'a.txt', index: ' ', worktree: 'M', untracked: false }],
        head: 'a'.repeat(40),
        detached: false,
        unborn: false,
        entries: [{ path: 'a.txt', area: 'unstaged', status: 'modified', added: 1, removed: 1 }],
        operation: 'none',
        capped: false,
        upstreamStatus: { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null },
        busy: null
      }
    },
    async diffSource(cwd, request): Promise<GitDiff> {
      record('diffSource', cwd, request)
      const staged = request.source === 'staged'
      return { path: request.path, staged, original: 'old', modified: 'new', binary: false, source: request.source, kind: 'text' }
    },
    async diff(cwd, path, staged): Promise<GitDiffPair> {
      record('diff', cwd, path, staged)
      return { path, staged, original: 'old', modified: 'new', binary: false }
    },
    async stage(cwd, paths) {
      record('stage', cwd, paths)
    },
    async unstage(cwd, paths) {
      record('unstage', cwd, paths)
    },
    async commit(cwd, message) {
      record('commit', cwd, message)
      return 'c'.repeat(40)
    }
  }
  return fake
}

/** Installs `api` as the git implementation `gitApi()` returns; `null` restores the real one. */
export function useTestGit(api: GitApi | null): void {
  globalThis.__QUIRKY_TEST_GIT__ = api ?? undefined
}

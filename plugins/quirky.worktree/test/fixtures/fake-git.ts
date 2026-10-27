import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeGit } from '@quirky/git/testing'
import { makeTempDir } from '../../../../packages/daemon/test/plugins/fixtures'

const SHA = 'c'.repeat(40)

/**
 * Makes the shared fake git able to serve a create: a repo has commits and a `main` base, no
 * remotes and no git user, and the add-worktree primitives register the worktree the way the
 * fake's own `addWorktree` does. A worktree is always clean, and its branch has no head, so
 * a remove has nothing to clean up after. Tests that need real branches, remotes or hooks use real git.
 */
export function fakeRegistrations(fake: FakeGit): void {
  fake.hasCommits = async () => true
  fake.detectDefaultBase = async () => 'main'
  fake.resolveBaseRef = async (_repo, name) => `refs/heads/${name}`
  fake.refExists = async () => false
  fake.resolveCommit = async () => SHA
  fake.showFile = async () => null
  fake.listRemotes = async () => []
  fake.localBranchExists = async (repo, branch) => (fake.worktreesByRepo.get(repo) ?? []).some((worktree) => worktree.branch === branch)
  fake.remoteBranchExists = async () => false
  fake.branchHead = async () => null
  fake.gitUsername = async () => null
  fake.getConfig = async () => null
  fake.setLocalConfig = async () => {}
  fake.deleteRefIfAt = async () => true
  fake.dirtyEntries = async () => []
  fake.hasPopulatedSubmodules = async () => false
  fake.prune = async () => {}
  fake.addNewBranchWorktree = (repo, path, branch, fullBase) => fake.addWorktree(repo, path, branch, fullBase)
  fake.addExistingBranchWorktree = (repo, path, branch) => fake.addWorktree(repo, path, branch)
}

/** A real directory called `name` registered as a repo in the fake git, so folder-based checks (birth time, existence) work. */
export function addFakeRepo(fake: FakeGit, name: string): string {
  const dir = join(realpathSync(makeTempDir('qf-')), name)
  mkdirSync(dir, { recursive: true })
  fake.addRepo(dir)
  return dir
}

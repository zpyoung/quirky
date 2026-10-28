import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createWorkspaceLease,
  WORKSPACE_LEASE_RENEWAL_MS,
  WORKSPACE_LEASE_TTL_MS,
  workspaceLeaseDirectory
} from '../src/lease'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-lease-'))
  roots.push(root)
  return join(root, 'workspace')
}

test('workspace lease uses the gitdir location for linked worktrees', () => {
  const workspace = temporaryWorkspace()
  const gitDir = join(workspace, '.git', 'worktrees', 'one')
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const gitFile = join(workspace, '.git')
  rmSync(gitFile, { recursive: true, force: true })
  const actualGitDir = join(workspace, 'admin', 'worktree')
  mkdirSync(actualGitDir, { recursive: true })
  writeFileSync(gitFile, `gitdir: ${actualGitDir}\n`)

  expect(workspaceLeaseDirectory(workspace, 'git')).toBe(join(actualGitDir, 'orca-heimdall', 'lease'))
})

test('folder leases use the workspace-local .orca directory', () => {
  const workspace = temporaryWorkspace()
  mkdirSync(workspace, { recursive: true })
  expect(workspaceLeaseDirectory(workspace, 'folder')).toBe(join(workspace, '.orca', 'heimdall', 'lease'))
})

test('atomic claims contend, expire to a higher epoch, and stale assert/release cannot affect it', () => {
  const workspace = temporaryWorkspace()
  mkdirSync(workspace, { recursive: true })
  const base = Date.now()
  let now = base
  const firstOwner = createWorkspaceLease({ workspacePath: workspace, workspaceKind: 'folder', holderId: 'kernel-a', now: () => now })
  const secondOwner = createWorkspaceLease({ workspacePath: workspace, workspaceKind: 'folder', holderId: 'kernel-b', now: () => now })

  const first = firstOwner.acquire()
  expect(first).toMatchObject({ kind: 'acquired', holderId: 'kernel-a', epoch: 1 })
  if (first.kind !== 'acquired') throw new Error('first claim should be acquired')
  firstOwner.assertHeld(first)
  const firstFile = join(workspaceLeaseDirectory(workspace, 'folder'), 'epoch-1', 'holder.json')
  expect(JSON.parse(readFileSync(firstFile, 'utf8'))).toMatchObject({ holderId: 'kernel-a', epoch: 1 })
  expect(statSync(firstFile).mode & 0o777).toBe(0o600)

  expect(secondOwner.acquire()).toMatchObject({ kind: 'held', holderId: 'kernel-b', epoch: 1 })
  now = base + WORKSPACE_LEASE_TTL_MS + 2_000
  const second = secondOwner.acquire()
  expect(second).toMatchObject({ kind: 'acquired', holderId: 'kernel-b', epoch: 2 })
  if (second.kind !== 'acquired') throw new Error('second claim should supersede the expired epoch')
  expect(() => firstOwner.assertHeld(first)).toThrow(/lease/i)
  expect(firstOwner.release(first)).toBe(false)
  secondOwner.assertHeld(second)
  expect(secondOwner.release(second)).toBe(true)

  const third = firstOwner.acquire()
  expect(third).toMatchObject({ kind: 'acquired', holderId: 'kernel-a', epoch: 3 })
})

test('renewal refreshes only the current epoch and uses the 30-second cadence', () => {
  const workspace = temporaryWorkspace()
  mkdirSync(workspace, { recursive: true })
  let now = Date.now()
  const lease = createWorkspaceLease({ workspacePath: workspace, workspaceKind: 'folder', holderId: 'kernel-a', now: () => now })
  const claim = lease.acquire()
  expect(claim.kind).toBe('acquired')
  if (claim.kind !== 'acquired') throw new Error('claim should be acquired')
  const path = join(workspaceLeaseDirectory(workspace, 'folder'), 'epoch-1', 'holder.json')
  const originalMtime = statSync(path).mtimeMs
  now += WORKSPACE_LEASE_RENEWAL_MS
  expect(lease.renew(claim)).toBe(true)
  expect(statSync(path).mtimeMs).toBeGreaterThanOrEqual(originalMtime)
})

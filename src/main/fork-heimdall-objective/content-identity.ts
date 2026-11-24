import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  OBJECTIVE_SYMLINK_OID_ALIAS,
  OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG
} from '../../shared/fork-heimdall/objective-git-exec-shapes'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import {
  localGitOptionsForTarget,
  requireLocalRuntimeGitRoute,
  type RuntimeGitTarget
} from '../runtime/runtime-git-command-target'
import { requireLocalRuntimeFileRoute } from '../runtime/files/file-target'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'

const HASH_CONCURRENCY = 8

export type ObjectiveWorkspaceTarget = {
  kind: 'git' | 'folder'
  executionHostId: ExecutionHostId
  workspacePath: string
  gitTarget?: RuntimeGitTarget
}

export type ObjectiveGitCommand = (args: string[]) => Promise<{ stdout: string; stderr: string }>
export type ObjectiveDirtyPath = {
  path: string
  deleted: boolean
  metadata: string
  submodule: boolean
  untracked: boolean
}
type ParsedGitStatus = { entries: ObjectiveDirtyPath[]; unborn: boolean }
export type GitDirtyFingerprint = { path: string; fingerprint: string }
export type GitWorkspaceObservation = { treeOid: string; dirty: GitDirtyFingerprint[] }

// Every porcelain-v2 arm records the same tag, so the identity hash re-injects it as a constant.
const DIRTY_ENTRY_METADATA = 'worktree'
type ObservedStat = { type: string; mode?: number }

function sha256(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part)
  }
  return hash.digest('hex')
}

export function isObjectiveMetadataPath(relativePath: string, caseInsensitive = false): boolean {
  const candidate = caseInsensitive ? relativePath.toLowerCase() : relativePath
  return candidate === '.quirky' || candidate.startsWith('.quirky/')
}

export function parseObjectiveDirtyPaths(
  status: string,
  caseInsensitivePaths: boolean
): ParsedGitStatus {
  const fields = status.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  const entries: ObjectiveDirtyPath[] = []
  let unborn = false

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!
    if (field.startsWith('# ')) {
      if (field === '# branch.oid (initial)') {
        unborn = true
      }
      continue
    }
    if (field.startsWith('? ')) {
      const path = field.slice(2)
      if (!path) {
        throw new Error('Git returned an empty porcelain path')
      }
      entries.push({
        path,
        deleted: false,
        metadata: 'worktree',
        submodule: false,
        untracked: true
      })
      continue
    }
    if (field.startsWith('! ')) {
      continue
    }

    const ordinary =
      /^1 ([^ ]{2}) ([^ ]{4}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([\s\S]+)$/u.exec(
        field
      )
    if (ordinary) {
      const [, , submoduleState, , , worktreeMode, , , path] = ordinary
      entries.push({
        path: path!,
        deleted: worktreeMode === '000000',
        metadata: 'worktree',
        submodule: submoduleState![0] === 'S' || worktreeMode === '160000',
        untracked: false
      })
      continue
    }

    const renamed =
      /^2 ([^ ]{2}) ([^ ]{4}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([RC][0-9]+) ([\s\S]+)$/u.exec(
        field
      )
    if (renamed) {
      const [, , submoduleState, , , worktreeMode, , , score, path] = renamed
      const sourcePath = fields[++index]
      if (!sourcePath) {
        throw new Error('Git returned a rename without its source path')
      }
      entries.push({
        path: path!,
        deleted: worktreeMode === '000000',
        metadata: 'worktree',
        submodule: submoduleState![0] === 'S' || worktreeMode === '160000',
        untracked: false
      })
      if (score![0] === 'R') {
        entries.push({
          path: sourcePath,
          deleted: true,
          metadata: 'worktree',
          submodule: submoduleState![0] === 'S',
          untracked: false
        })
      }
      continue
    }

    const unmerged =
      /^u ([^ ]{2}) ([^ ]{4}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([\s\S]+)$/u.exec(
        field
      )
    if (unmerged) {
      const [, , submoduleState, , , , worktreeMode, , , , path] = unmerged
      entries.push({
        path: path!,
        deleted: worktreeMode === '000000',
        metadata: 'worktree',
        submodule: submoduleState![0] === 'S' || worktreeMode === '160000',
        untracked: false
      })
      continue
    }
    throw new Error('Git returned malformed porcelain status')
  }

  return {
    entries: entries
      .filter((entry) => !isObjectiveMetadataPath(entry.path, caseInsensitivePaths))
      .sort((left, right) => {
        if (left.path !== right.path) {
          return left.path < right.path ? -1 : 1
        }
        if (left.metadata !== right.metadata) {
          return left.metadata < right.metadata ? -1 : 1
        }
        return Number(left.deleted) - Number(right.deleted)
      }),
    unborn
  }
}

export function objectiveGitCommandForTarget(
  target: ObjectiveWorkspaceTarget
): ObjectiveGitCommand {
  const gitTarget = target.gitTarget
  if (!gitTarget) {
    throw new Error('Git objective target has no runtime Git target')
  }
  if (gitTarget.executionHostId !== target.executionHostId) {
    throw new Error('Git and filesystem routes disagree on execution host')
  }
  requireLocalRuntimeGitRoute(gitTarget)
  const options = localGitOptionsForTarget(gitTarget)
  const cwd = resolveWorktreeHostPath(target.workspacePath, options) ?? target.workspacePath
  return (args) =>
    gitExecFileAsync(args, {
      ...options,
      cwd,
      admissionTier: 'background'
    })
}

function workspaceFilesystemRoot(target: ObjectiveWorkspaceTarget): string {
  if (!target.gitTarget) {
    return target.workspacePath
  }
  return (
    resolveWorktreeHostPath(target.workspacePath, localGitOptionsForTarget(target.gitTarget)) ??
    target.workspacePath
  )
}

async function readWorkingTreeStat(
  target: ObjectiveWorkspaceTarget,
  repositoryPrefix: string,
  path: string
): Promise<ObservedStat> {
  const relativePath = repositoryPrefix ? posix.join(repositoryPrefix, path) : path
  const root = workspaceFilesystemRoot(target)
  const flavor = resolveLeasePathFlavor(target.executionHostId, root)
  const absolutePath = flavor.join(root, ...relativePath.split('/'))
  const stat = await lstat(absolutePath)
  return {
    type: stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : stat.isFile()
          ? 'file'
          : 'other',
    mode: stat.mode
  }
}

// git hash-object resolves a symlink to its target, which both hides a retarget and fails outright
// on a broken link; hashing the link text shell-side reproduces the blob Git itself stores.
async function symlinkBlobObjectId(runGit: ObjectiveGitCommand, path: string): Promise<string> {
  const { stdout } = await runGit([
    '-c',
    OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG,
    OBJECTIVE_SYMLINK_OID_ALIAS,
    '--',
    path
  ])
  const fields = stdout.split('\0')
  if (fields.at(-1) === '') {
    fields.pop()
  }
  const objectId = fields.length === 1 ? fields[0] : undefined
  if (objectId === undefined || !/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw new Error(`Git did not return a symlink object hash for ${path}`)
  }
  return objectId
}

async function fingerprintDirtyPath(
  target: ObjectiveWorkspaceTarget,
  runGit: ObjectiveGitCommand,
  repositoryPrefix: string,
  entry: ObjectiveDirtyPath,
  caseInsensitivePaths: boolean
): Promise<string> {
  if (entry.deleted) {
    return 'deleted'
  }

  if (entry.submodule) {
    const nestedRunGit: ObjectiveGitCommand = (args) => runGit(['-C', entry.path, ...args])
    const nestedPrefix = repositoryPrefix ? posix.join(repositoryPrefix, entry.path) : entry.path
    return `submodule\0${await computeGitRepositoryIdentity(
      target,
      nestedRunGit,
      nestedPrefix,
      caseInsensitivePaths
    )}`
  }

  const stat = await readWorkingTreeStat(target, repositoryPrefix, entry.path)
  const modeIdentity =
    stat.type === 'file' && typeof stat.mode === 'number'
      ? (stat.mode & 0o111) === 0
        ? 'regular'
        : 'executable'
      : 'mode-unavailable'
  const workingMetadata = [stat.type, modeIdentity].join('\0')
  if (stat.type === 'directory') {
    const nestedRunGit: ObjectiveGitCommand = (args) => runGit(['-C', entry.path, ...args])
    const nestedPrefix = repositoryPrefix ? posix.join(repositoryPrefix, entry.path) : entry.path
    return `nested-repository\0${workingMetadata}\0${await computeGitRepositoryIdentity(
      target,
      nestedRunGit,
      nestedPrefix,
      caseInsensitivePaths
    )}`
  }

  if (stat.type === 'symlink') {
    return `blob\0${workingMetadata}\0${await symlinkBlobObjectId(runGit, entry.path)}`
  }

  const output = (await runGit(['hash-object', '--', entry.path])).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(output)) {
    throw new Error(`Git did not return an object hash for ${entry.path}`)
  }
  return `blob\0${workingMetadata}\0${output}`
}

export async function observeGitRepositoryState(
  target: ObjectiveWorkspaceTarget,
  runGit: ObjectiveGitCommand,
  repositoryPrefix: string,
  caseInsensitivePaths: boolean
): Promise<GitWorkspaceObservation> {
  const [treeResult, statusResult] = await Promise.allSettled([
    runGit(['rev-parse', '--verify', 'HEAD^{tree}']),
    runGit([
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '--'
    ])
  ])
  if (statusResult.status === 'rejected') {
    throw statusResult.reason
  }

  const parsed = parseObjectiveDirtyPaths(statusResult.value.stdout, caseInsensitivePaths)
  let treeOid = 'unborn'
  if (treeResult.status === 'fulfilled') {
    treeOid = treeResult.value.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/u.test(treeOid)) {
      throw new Error('Git did not return a valid tree object id')
    }
  } else if (!parsed.unborn) {
    throw treeResult.reason
  }

  const fingerprints = await mapWithConcurrency(parsed.entries, HASH_CONCURRENCY, (entry) =>
    fingerprintDirtyPath(target, runGit, repositoryPrefix, entry, caseInsensitivePaths)
  )
  return {
    treeOid,
    dirty: parsed.entries.map((entry, index) => ({
      path: entry.path,
      fingerprint: fingerprints[index]!
    }))
  }
}

export async function computeGitRepositoryIdentity(
  target: ObjectiveWorkspaceTarget,
  runGit: ObjectiveGitCommand,
  repositoryPrefix: string,
  caseInsensitivePaths: boolean
): Promise<string> {
  const observed = await observeGitRepositoryState(
    target,
    runGit,
    repositoryPrefix,
    caseInsensitivePaths
  )
  const parts: string[] = [observed.treeOid, '\0']
  for (const entry of observed.dirty) {
    parts.push(entry.path, '\0', DIRTY_ENTRY_METADATA, '\0', entry.fingerprint, '\0')
  }
  return sha256(parts)
}

export async function observeGitWorkspaceState(
  target: ObjectiveWorkspaceTarget
): Promise<GitWorkspaceObservation> {
  return await observeGitRepositoryState(
    target,
    objectiveGitCommandForTarget(target),
    '',
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  )
}

async function computeGitIdentity(target: ObjectiveWorkspaceTarget): Promise<string> {
  const caseInsensitivePaths =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  return await computeGitRepositoryIdentity(
    target,
    objectiveGitCommandForTarget(target),
    '',
    caseInsensitivePaths
  )
}

async function computeFolderIdentity(target: ObjectiveWorkspaceTarget): Promise<string> {
  // Loaded after this module is initialized because the manifest owns host observation and imports
  // the public target/Git-command contracts above.
  const { observeObjectiveWorkspaceManifest } = await import('./objective-workspace-manifest')
  const manifest = await observeObjectiveWorkspaceManifest(target)
  const hash = createHash('sha256')
  for (const entry of manifest) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.fingerprint)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function computeWorkspaceContentIdentity(
  target: ObjectiveWorkspaceTarget
): Promise<string> {
  requireLocalRuntimeFileRoute(target)
  return target.kind === 'git' ? computeGitIdentity(target) : computeFolderIdentity(target)
}

import { randomUUID } from 'node:crypto'
import type { DiffStats, TreeSnapshot } from '../../shared/fork-loops/loop-types'
import { resolveGitReportedPath, type LoopWorkspaceTarget } from './loop-notes-file'

export type LoopGitTarget = LoopWorkspaceTarget

function emptyDiff(): DiffStats {
  return { added: 0, removed: 0, files: [] }
}

async function resolveHeadSha(
  runGit: NonNullable<LoopGitTarget['runGit']>
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '-q', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Captures the whole working tree, untracked non-ignored files included, as a git tree object.
 * Staging happens in a private temporary index, so the user's index, HEAD, refs, and stash are
 * untouched. Returns null for folder workspaces and when git fails.
 */
export async function snapshotWorkingTree(target: LoopGitTarget): Promise<TreeSnapshot | null> {
  const runGit = target.kind === 'git' ? target.runGit : null
  if (!runGit) {
    return null
  }
  let indexPath: string | null = null
  try {
    const { stdout } = await runGit([
      'rev-parse',
      '--git-path',
      `quirky-loop-snapshot-${randomUUID()}.index`
    ])
    const reported = stdout.trim()
    if (!reported) {
      return null
    }
    indexPath = resolveGitReportedPath(target, reported)
    const env = { GIT_INDEX_FILE: indexPath }
    const headSha = await resolveHeadSha(runGit)
    // seeding from HEAD keeps tracked-but-ignored files in the tree; add -A then applies the working tree on top
    if (headSha) {
      await runGit(['read-tree', 'HEAD'], { env })
    }
    await runGit(['add', '-A'], { env })
    const { stdout: treeOut } = await runGit(['write-tree'], { env })
    const treeId = treeOut.trim()
    return treeId ? { treeId, headSha } : null
  } catch {
    return null
  } finally {
    if (indexPath) {
      await target.fs.deletePath(indexPath).catch(() => undefined)
    }
  }
}

function parseNumstat(output: string): DiffStats {
  let added = 0
  let removed = 0
  const files: string[] = []
  for (const record of output.split('\0')) {
    if (!record) {
      continue
    }
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) {
      continue
    }
    const addedField = record.slice(0, firstTab)
    const removedField = record.slice(firstTab + 1, secondTab)
    // binary files report "-" for both counts
    added += addedField === '-' ? 0 : Number.parseInt(addedField, 10) || 0
    removed += removedField === '-' ? 0 : Number.parseInt(removedField, 10) || 0
    files.push(record.slice(secondTab + 1))
  }
  return { added, removed, files }
}

/**
 * Line and file differences between two snapshots. Equal tree ids, or a workspace without git,
 * short-circuit to an empty diff. A git failure returns null: the change is unmeasured, which
 * protected-path enforcement must not read as "nothing changed".
 */
export async function diffSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
  target: LoopGitTarget
): Promise<DiffStats | null> {
  const runGit = target.kind === 'git' ? target.runGit : null
  if (!runGit || before.treeId === after.treeId) {
    return emptyDiff()
  }
  try {
    const { stdout } = await runGit([
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      before.treeId,
      after.treeId
    ])
    return parseNumstat(stdout)
  } catch {
    return null
  }
}

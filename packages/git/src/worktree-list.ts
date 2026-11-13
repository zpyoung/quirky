import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { git, onGitWrite } from './run'

export const WORKTREE_LIST_QUIET_MS = 2000

export type WorktreeListStats = { hits: number; spawns: number; uncacheable: number; entries: number }

export type WorktreeListReader = {
  /** The text `git worktree list --porcelain` prints for `repo` now. */
  read(repo: string): Promise<string>
  /** Forgets every repository. */
  drop(): void
  stats(): WorktreeListStats
}

/** Returns fresh listings after changes to git's listing inputs; unverifiable layouts always run git. */
export function createWorktreeListReader(options: {
  /** Runs git; defaults to `git(repo, ['worktree', 'list', '--porcelain'], { readOnly: true })`. */
  run?: (repo: string) => Promise<string>
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  now?: () => number
  quietMs?: number
  maxEntries?: number
  env?: Record<string, string | undefined>
} = {}): WorktreeListReader {
  const run = options.run ?? ((repo: string) => git(repo, ['worktree', 'list', '--porcelain'], { readOnly: true }))
  const now = options.now ?? Date.now
  const quietMs = options.quietMs ?? WORKTREE_LIST_QUIET_MS
  const maxEntries = Math.max(0, options.maxEntries ?? 64)
  const env = options.env ?? process.env
  const entries = new Map<string, { fingerprint: string; output: string }>()
  let hits = 0
  let spawns = 0
  let uncacheable = 0
  let generation = 0

  function drop(): void {
    entries.clear()
    generation++
  }

  function stats(): WorktreeListStats {
    return { hits, spawns, uncacheable, entries: entries.size }
  }

  function remember(repoPath: string, fingerprint: string, output: string): void {
    if (maxEntries === 0) return
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    entries.set(repoPath, { fingerprint, output })
  }

  function isQuiet(snapshot: Fingerprint, timestamp: number): boolean {
    if (quietMs <= 0) return false
    const quietNs = BigInt(Math.ceil(quietMs * 1_000_000))
    const threshold = BigInt(Math.trunc(timestamp * 1_000_000)) - quietNs
    return snapshot.newestNs > threshold
  }

  async function read(repo: string): Promise<string> {
    const repoPath = resolve(repo)
    const readGeneration = generation
    const before = fingerprint(repoPath, env)
    if (before === null || isQuiet(before, now())) {
      entries.delete(repoPath)
      uncacheable++
      spawns++
      return run(repo)
    }

    const cached = entries.get(repoPath)
    if (cached?.fingerprint === before.value) {
      hits++
      return cached.output
    }
    entries.delete(repoPath)

    spawns++
    const output = await run(repo)
    if (generation !== readGeneration) return output

    const after = fingerprint(repoPath, env)
    if (after !== null && after.value === before.value) {
      remember(repoPath, before.value, output)
    }
    return output
  }

  return { read, drop, stats }
}

type Fingerprint = { value: string; newestNs: bigint }

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function fingerprint(repo: string, env: Record<string, string | undefined>): Fingerprint | null {
  if (env.GIT_DIR !== undefined || env.GIT_COMMON_DIR !== undefined || env.GIT_WORK_TREE !== undefined) return null

  try {
    const gitDir = join(repo, '.git')
    const gitDirStat = lstatSync(gitDir)
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) return null

    try {
      lstatSync(join(gitDir, 'reftable'))
      return null
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    const parts: unknown[] = []
    let newestNs = 0n
    const addStat = (path: string) => {
      try {
        const stat = statSync(path, { bigint: true })
        parts.push([path, stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()])
        if (stat.mtimeNs > newestNs) newestNs = stat.mtimeNs
        if (stat.ctimeNs > newestNs) newestNs = stat.ctimeNs
        return stat
      } catch (error) {
        if (!isMissing(error)) throw error
        parts.push([path, 'missing'])
        return undefined
      }
    }

    for (const name of ['config', 'packed-refs']) {
      const path = join(gitDir, name)
      const stat = addStat(path)
      if (stat !== undefined && !stat.isFile()) return null
    }

    const worktreesPath = join(gitDir, 'worktrees')
    const worktreesStat = addStat(worktreesPath)
    let worktreeNames: string[] = []
    if (worktreesStat !== undefined) {
      const worktreesLstat = lstatSync(worktreesPath)
      if (!worktreesLstat.isDirectory() || worktreesLstat.isSymbolicLink()) return null
      worktreeNames = readdirSync(worktreesPath).sort()
    }
    parts.push([worktreesPath, worktreeNames])

    const addBranchRef = (branch: string): boolean => {
      const headsPath = resolve(gitDir, 'refs', 'heads')
      const branchPath = resolve(headsPath, branch)
      if (!branchPath.startsWith(`${headsPath}${sep}`)) return false
      const stat = addStat(branchPath)
      if (stat === undefined) return true
      if (!stat.isFile()) return false
      return !readFileSync(branchPath, 'utf8').startsWith('ref:')
    }

    const addHead = (headPath: string): boolean => {
      const stat = addStat(headPath)
      if (stat === undefined || !stat.isFile()) return false
      const head = readFileSync(headPath, 'utf8').trim()
      if (/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(head)) return true
      const symbolic = /^ref: refs\/heads\/(.+)$/.exec(head)
      return symbolic !== null && addBranchRef(symbolic[1]!)
    }

    if (!addHead(join(gitDir, 'HEAD'))) return null

    for (const name of worktreeNames) {
      const worktreeDir = join(worktreesPath, name)
      const worktreeLstat = lstatSync(worktreeDir)
      if (!worktreeLstat.isDirectory() || worktreeLstat.isSymbolicLink()) return null

      const headPath = join(worktreeDir, 'HEAD')
      if (!addHead(headPath)) return null

      const gitdirPath = join(worktreeDir, 'gitdir')
      const gitdirStat = addStat(gitdirPath)
      if (gitdirStat === undefined || !gitdirStat.isFile()) return null
      const worktreeGitFile = readFileSync(gitdirPath, 'utf8').trim()
      if (!worktreeGitFile || /[\r\n]/.test(worktreeGitFile) || !isAbsolute(worktreeGitFile)) return null
      const worktreeGitStat = addStat(worktreeGitFile)
      if (worktreeGitStat !== undefined && !worktreeGitStat.isFile()) return null

      const lockedPath = join(worktreeDir, 'locked')
      const lockedStat = addStat(lockedPath)
      if (lockedStat !== undefined && !lockedStat.isFile()) return null
    }

    return { value: JSON.stringify(parts), newestNs }
  } catch {
    return null
  }
}

const sharedReader = createWorktreeListReader()
onGitWrite(() => sharedReader.drop())

/** The reader `listRegistrations` and `listWorktrees` use. */
export function readWorktreeList(repo: string): Promise<string> {
  return sharedReader.read(repo)
}

export function dropWorktreeListCache(): void {
  sharedReader.drop()
}

export function worktreeListStats(): WorktreeListStats {
  return sharedReader.stats()
}

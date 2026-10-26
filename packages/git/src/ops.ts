/**
 * Git primitives for the worktree create/delete pipeline. Each spawns the `git` binary through
 * `runGit`/`git`; a function throws `GitError` on an unexpected git failure unless its doc says
 * it reports failure through its return value.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { BranchCheckedOutError, GitError } from './index'
import { git, runGit } from './run'

export type GitRegistration = {
  path: string
  branch: string | null
  head: string
  isMain: boolean
  locked: string | null
  prunable: boolean
  exists: boolean
}

export type DeleteBranchResult =
  | { deleted: true }
  | { deleted: false; reason: 'not-merged' | 'checked-out' | 'other'; message: string }

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const nonEmpty = (lines: string[]): string[] => lines.filter((l) => l.length > 0)

/** Every `git worktree list --porcelain` entry (prunable and missing-folder ones included), main first, bare skipped. */
export async function listRegistrations(repo: string): Promise<GitRegistration[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  const result: GitRegistration[] = []
  let isFirst = true
  for (const block of out.split(/\n\n+/)) {
    const lines = nonEmpty(block.split('\n'))
    if (lines.length === 0) continue
    let path = ''
    let head = ''
    let branch: string | null = null
    let locked: string | null = null
    let prunable = false
    let bare = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'locked') locked = ''
      else if (line.startsWith('locked ')) locked = line.slice('locked '.length)
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true
      else if (line === 'bare') bare = true
    }
    const isMain = isFirst
    isFirst = false
    if (bare || !path) continue
    result.push({ path, branch, head, isMain, locked, prunable, exists: existsSync(path) })
  }
  return result
}

/** Whether HEAD points at a commit (false in a freshly initialised repo). */
export async function hasCommits(repo: string): Promise<boolean> {
  return (await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode === 0
}

/** Whether the fully qualified ref (`refs/heads/x`) exists. */
export async function refExists(repo: string, fullRef: string): Promise<boolean> {
  return (await runGit(repo, ['show-ref', '--verify', '--quiet', fullRef])).exitCode === 0
}

/** The full sha `rev` resolves to as a commit, or null when it does not. */
export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  if (rev.startsWith('-')) return null
  const r = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (r.exitCode !== 0) return null
  return text(r.stdout).trim() || null
}

const DEFAULT_BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']

/** The repo's default base as a short name (`origin/develop`, `main`), or null when none can be found. */
export async function detectDefaultBase(repo: string): Promise<string | null> {
  const r = await runGit(
    repo,
    [
      'for-each-ref',
      '--format=%(refname)%00%(symref)',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
      'refs/remotes/origin/master',
      'refs/heads/main',
      'refs/heads/master'
    ],
    { timeoutMs: 15000 }
  )
  if (r.exitCode !== 0) return null
  const found = new Set<string>()
  for (const line of nonEmpty(text(r.stdout).split('\n'))) {
    const [refname = '', symref = ''] = line.split('\0')
    if (refname === 'refs/remotes/origin/HEAD' && symref.startsWith('refs/remotes/')) {
      return symref.slice('refs/remotes/'.length)
    }
    found.add(refname.replace(/^refs\/(remotes|heads)\//, ''))
  }
  return DEFAULT_BASE_CANDIDATES.find((c) => found.has(c)) ?? null
}

/** The full ref for a base name (`refs/remotes/...`, `refs/heads/...`), else the sha of any commit-ish; null if nothing matches. */
export async function resolveBaseRef(repo: string, name: string): Promise<string | null> {
  const candidates = name.includes('/') ? [`refs/remotes/${name}`, `refs/heads/${name}`] : [`refs/heads/${name}`]
  for (const ref of candidates) {
    if (await refExists(repo, ref)) return ref
  }
  return resolveCommit(repo, name)
}

/** Names of the configured remotes. */
export async function listRemotes(repo: string): Promise<string[]> {
  return nonEmpty((await git(repo, ['remote'])).split('\n').map((l) => l.trim()))
}

/** Every distinct fetch/push URL of the configured remotes. */
export async function remoteUrls(repo: string): Promise<string[]> {
  const urls = new Set<string>()
  for (const remote of await listRemotes(repo)) {
    const r = await runGit(repo, ['remote', 'get-url', '--all', remote])
    if (r.exitCode !== 0) continue
    for (const url of nonEmpty(text(r.stdout).split('\n'))) urls.add(url.trim())
  }
  return [...urls]
}

/** Fetches `remote` (optionally one refspec); true on success, false on any failure or timeout, never throws. */
export async function fetchRemote(
  repo: string,
  remote: string,
  refspec?: string,
  timeoutMs = 30000
): Promise<boolean> {
  try {
    const r = await runGit(repo, ['fetch', '--', remote, ...(refspec ? [refspec] : [])], { timeoutMs })
    return r.exitCode === 0
  } catch {
    return false
  }
}

/** Whether `refs/heads/<branch>` exists. */
export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  return refExists(repo, `refs/heads/${branch}`)
}

/** Whether any `refs/remotes/<remote>/<branch>` exists. */
export async function remoteBranchExists(repo: string, branch: string): Promise<boolean> {
  const r = await runGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])
  if (r.exitCode !== 0) return false
  const suffix = `/${branch}`
  return nonEmpty(text(r.stdout).split('\n')).some((ref) => {
    const rest = ref.slice('refs/remotes/'.length)
    const slash = rest.indexOf('/')
    return slash > 0 && rest.slice(slash) === suffix && !rest.endsWith('/HEAD')
  })
}

/** The sha a local branch points at, or null when it does not exist. */
export async function branchHead(repo: string, branch: string): Promise<string | null> {
  const r = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (r.exitCode !== 0) return null
  return text(r.stdout).trim() || null
}

/** A local branch's upstream as a short name (`origin/main`), or null when it has none. */
export async function upstreamOf(repo: string, branch: string): Promise<string | null> {
  const r = await runGit(repo, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])
  if (r.exitCode !== 0) return null
  return text(r.stdout).trim() || null
}

/** Whether `name` is a valid branch name; a name starting with `-` is never valid. */
export async function checkRefFormatBranch(name: string): Promise<boolean> {
  if (name.length === 0 || name.startsWith('-')) return false
  return (await runGit('/', ['check-ref-format', '--branch', name])).exitCode === 0
}

/** Adds a worktree at `path` on new branch `branch` cut from `fullBase`, without upstream tracking; creates parent dirs. */
export async function addNewBranchWorktree(
  repo: string,
  path: string,
  branch: string,
  fullBase: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, path, fullBase])
}

/** Adds a worktree at `path` checking out existing `branch`; throws BranchCheckedOutError when another worktree holds it. */
export async function addExistingBranchWorktree(repo: string, path: string, branch: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await git(repo, ['worktree', 'add', path, branch])
  } catch (error) {
    const stderr = error instanceof GitError ? error.stderr : ''
    if (/already (checked out|used by worktree)/.test(stderr)) {
      throw new BranchCheckedOutError(branch, /at '([^']+)'/.exec(stderr)?.[1] ?? null, stderr)
    }
    throw error
  }
}

/** Creates local `branch` at `remoteRef` with that remote branch as its upstream. */
export async function createTrackingBranch(repo: string, branch: string, remoteRef: string): Promise<void> {
  await git(repo, ['branch', '--track', branch, remoteRef])
}

/** The effective value of a git config key, or null when unset. */
export async function getConfig(repo: string, key: string): Promise<string | null> {
  const r = await runGit(repo, ['config', '--get', key])
  if (r.exitCode !== 0) return null
  return text(r.stdout).replace(/\r?\n$/, '')
}

/** Sets a repo-local config key, replacing every existing value. */
export async function setLocalConfig(repo: string, key: string, value: string): Promise<void> {
  await git(repo, ['config', '--local', '--replace-all', key, value])
}

/** Paths git considers changed in a worktree (modified, staged, untracked, submodule changes); renames give the new path. */
export async function dirtyEntries(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none'
  ])
  const entries = out.split('\0')
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++
  }
  return paths
}

/** Whether any submodule of the worktree is checked out; false when it has no `.gitmodules`. */
export async function hasPopulatedSubmodules(worktreePath: string): Promise<boolean> {
  if (!existsSync(resolve(worktreePath, '.gitmodules'))) return false
  const out = await git(worktreePath, ['submodule', 'status'])
  return nonEmpty(out.split('\n')).some((line) => !line.startsWith('-'))
}

/** Drops registrations whose worktree folder is gone. */
export async function prune(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune'])
}

/** `git branch -d`: deletes only a merged branch, and says why otherwise instead of throwing. */
export async function deleteBranchSafe(repo: string, branch: string): Promise<DeleteBranchResult> {
  const r = await runGit(repo, ['branch', '-d', '--', branch])
  if (r.exitCode === 0) return { deleted: true }
  const message = r.stderr.trim() || `git branch failed (exit ${r.exitCode})`
  if (/not fully merged/.test(r.stderr)) return { deleted: false, reason: 'not-merged', message }
  if (/checked out|used by worktree/.test(r.stderr)) return { deleted: false, reason: 'checked-out', message }
  return { deleted: false, reason: 'other', message }
}

/** Whether merging `branch` into `target` would change nothing (a squash or rebase merge landed it); false on conflicts or errors. */
export async function mergedByTree(repo: string, branch: string, target: string): Promise<boolean> {
  const [merge, tree] = await Promise.all([
    runGit(repo, ['merge-tree', '--write-tree', target, branch]),
    runGit(repo, ['rev-parse', '--verify', '--quiet', `${target}^{tree}`])
  ])
  if (merge.exitCode !== 0 || tree.exitCode !== 0) return false
  const first = text(merge.stdout).split('\n')[0]?.trim()
  return !!first && first === text(tree.stdout).trim()
}

/** Deletes `refs/heads/<branch>` only if it still points at `head`; false when it moved or is gone. */
export async function deleteRefIfAt(repo: string, branch: string, head: string): Promise<boolean> {
  return (await runGit(repo, ['update-ref', '-d', `refs/heads/${branch}`, head])).exitCode === 0
}

/**
 * The text of `path` at `ref`, or null when either is missing. Throws GitError for a `ref` or
 * `path` that starts with `-`, which git would read as an option.
 */
export async function showFile(repo: string, ref: string, path: string): Promise<string | null> {
  if (ref.startsWith('-') || path.startsWith('-')) {
    throw new GitError(`refusing ${ref.startsWith('-') ? 'ref' : 'path'} that starts with '-'`, '', -1)
  }
  const r = await runGit(repo, ['show', `${ref}:${path}`])
  return r.exitCode === 0 ? text(r.stdout) : null
}

/** Ignored, untracked files under `cwd` per the standard excludes, with directories expanded to files. */
export async function ignoredUntracked(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
  return nonEmpty(out.split('\0'))
}

/** Untracked files under `cwd` matching the patterns in `excludeFile`. */
export async function matchingExcludeFrom(cwd: string, excludeFile: string): Promise<string[]> {
  const out = await git(cwd, ['ls-files', '--others', '--ignored', '-z', `--exclude-from=${excludeFile}`])
  return nonEmpty(out.split('\0'))
}

/** Whether git ignores `path` (relative to `cwd`). */
export async function isIgnored(cwd: string, path: string): Promise<boolean> {
  return (await runGit(cwd, ['check-ignore', '-q', '--', path])).exitCode === 0
}

/** Absolute path of `rel` inside the git dir that serves this worktree (`git rev-parse --git-path`). */
export async function gitPath(worktreePath: string, rel: string): Promise<string> {
  const out = (await git(worktreePath, ['rev-parse', '--git-path', rel])).replace(/\r?\n$/, '')
  return resolve(worktreePath, out)
}

/** Creates `path` (and parents) and runs `git init` there, leaving the default branch name to git. */
export async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, ['init'])
}

/** Whether a clone source is a filesystem path rather than a URL (`scheme://`) or an scp-style `host:path`. */
function isLocalSource(source: string): boolean {
  return !source.includes('://') && !/^[^/\\:]+:/.test(source)
}

/**
 * Clones `url` into `dest`, creating its parent directory; never prompts for credentials. A
 * relative local source is resolved against this process's cwd, so it never depends on where git runs.
 */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  const target = resolve(dest)
  const parent = dirname(target)
  const source = isLocalSource(url) ? resolve(url) : url
  await mkdir(parent, { recursive: true })
  await git(parent, ['clone', '--', source, target])
}

const GH_FAILURE_TTL_MS = 5 * 60 * 1000
const GH_TIMEOUT_MS = 2500
let ghFailedAt: number | null = null

/** Forgets a cached `gh` failure so the next `gitUsername` tries `gh` again. */
export function resetGhFailureCache(): void {
  ghFailedAt = null
}

async function runGh(args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(['gh', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited])
      return code === 0 ? out : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

async function configTrimmed(repo: string, key: string): Promise<string | null> {
  const value = (await getConfig(repo, key))?.trim()
  return value ? value : null
}

/**
 * The user's name for branch prefixes: `github.user`, `user.username`, the GitHub login (only for
 * a github.com remote; `gh` failures are skipped for 5 minutes), then `user.name` if it forms a
 * valid branch prefix; null otherwise.
 */
export async function gitUsername(
  repo: string,
  opts: { gh?: (args: string[], timeoutMs: number) => Promise<string | null> } = {}
): Promise<string | null> {
  const fromConfig = (await configTrimmed(repo, 'github.user')) ?? (await configTrimmed(repo, 'user.username'))
  if (fromConfig) return fromConfig

  const recentlyFailed = ghFailedAt !== null && Date.now() - ghFailedAt < GH_FAILURE_TTL_MS
  if (!recentlyFailed && (await remoteUrls(repo)).some((url) => url.includes('github.com'))) {
    let login: string | null = null
    try {
      login = (await (opts.gh ?? runGh)(['api', 'user', '-q', '.login'], GH_TIMEOUT_MS))?.trim() || null
    } catch {
      login = null
    }
    if (login) return login
    ghFailedAt = Date.now()
  }

  const name = await configTrimmed(repo, 'user.name')
  if (name && (await checkRefFormatBranch(`${name}/x`))) return name
  return null
}

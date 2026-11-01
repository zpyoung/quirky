/** Commit history, a commit's files and the branch list that feeds the base picker. */
import type { GitChange, GitCommit, GitHistory } from '@quirky/protocol'
import { changeList } from './compare'
import { GitError } from './index'
import { git, runGit } from './run'

export const HISTORY_DEFAULT_LIMIT = 50
export const HISTORY_MAX_LIMIT = 200

const BRANCH_LIST_LIMIT = 200
const LOG_FIELDS = ['%H', '%P', '%aN', '%aE', '%at', '%ct', '%D', '%s', '%b']
// git messages cannot hold NUL, so NUL-joined fields (and -z between commits) parse as fixed-size groups
const LOG_FORMAT = LOG_FIELDS.join('%x00')

const decoder = new TextDecoder()

async function resolveCommitOid(cwd: string, rev: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { readOnly: true })
  if (r.exitCode !== 0) return null
  return decoder.decode(r.stdout).trim() || null
}

function shortRef(ref: string): string {
  if (ref.startsWith('tag: ')) return `tag: ${ref.slice('tag: '.length).replace(/^refs\/tags\//, '')}`
  if (ref.startsWith('HEAD -> ')) return `HEAD -> ${shortRef(ref.slice('HEAD -> '.length))}`
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

function parseCommit(fields: string[]): GitCommit {
  const [oid, parents, author, email, authored, committed, refs, subject, body] = fields
  return {
    oid: oid!,
    parents: parents ? parents.split(' ') : [],
    author: author!,
    email: email!,
    authoredAt: Number(authored) * 1000,
    committedAt: Number(committed) * 1000,
    subject: subject!,
    body: (body ?? '').replace(/\n+$/, ''),
    refs: refs ? refs.split(', ').map(shortRef) : []
  }
}

/**
 * Up to `limit` commits reachable from HEAD, newest first in topological order (default 50,
 * clamped to 1..200); `hasMore` says older ones exist. An unborn HEAD has no commits.
 */
export async function history(cwd: string, limit: number = HISTORY_DEFAULT_LIMIT): Promise<GitHistory> {
  const clamped = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT
  if (!(await resolveCommitOid(cwd, 'HEAD'))) return { commits: [], hasMore: false }
  const out = await git(
    cwd,
    [
      'log',
      '--no-show-signature',
      '--no-color',
      '--topo-order',
      '--decorate=full',
      '-z',
      `-n${clamped + 1}`,
      `--format=${LOG_FORMAT}`,
      'HEAD',
      '--'
    ],
    { readOnly: true }
  )
  const tokens = out.split('\0')
  const commits: GitCommit[] = []
  for (let at = 0; at + LOG_FIELDS.length <= tokens.length; at += LOG_FIELDS.length) {
    commits.push(parseCommit(tokens.slice(at, at + LOG_FIELDS.length)))
  }
  return { commits: commits.slice(0, clamped), hasMore: commits.length > clamped }
}

/**
 * What `commit` changed against its first parent (a root commit against nothing). `commit` is
 * returned as the full id, `parent` as the first parent's id or null for a root. Throws `GitError`
 * when `commit` is not a commit.
 */
export async function commitFiles(
  cwd: string,
  commit: string
): Promise<{ commit: string; parent: string | null; entries: GitChange[] }> {
  const oid = await resolveCommitOid(cwd, commit)
  if (!oid) throw new GitError(`Unknown commit ${commit}`, '', 128)
  const [, parent] = (await git(cwd, ['rev-list', '--parents', '-n1', oid, '--'], { readOnly: true })).trim().split(' ')
  return { commit: oid, parent: parent ?? null, entries: await changeList(cwd, parent ?? null, oid) }
}

/**
 * Local and remote branch names for the base picker, filtered by a case-insensitive substring
 * `query`: locals first, each group by name, at most 200; an exact-name match is retained if it
 * falls beyond the cap. `current` is the checked-out branch, or null when HEAD is detached.
 */
export async function listBranches(
  cwd: string,
  query?: string
): Promise<{ refs: { name: string; kind: 'local' | 'remote'; checkedOutIn?: string }[]; current: string | null }> {
  const out = await git(
    cwd,
    ['for-each-ref', '--format=%(refname)%00%(worktreepath)%00', 'refs/heads', 'refs/remotes'],
    { readOnly: true }
  )
  const fields = out.split('\0')
  const refs: { name: string; kind: 'local' | 'remote'; checkedOutIn?: string }[] = []
  const localBranches = new Map<string, string | null>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const full = fields[i]!.replace(/^\n/, '')
    const worktreePath = fields[i + 1]!
    if (full.startsWith('refs/heads/')) {
      const name = full.slice('refs/heads/'.length)
      localBranches.set(name, worktreePath || null)
      refs.push({ name, kind: 'local', ...(worktreePath ? { checkedOutIn: worktreePath } : {}) })
    } else if (full.startsWith('refs/remotes/')) {
      refs.push({ name: full.slice('refs/remotes/'.length), kind: 'remote' })
    }
  }

  const remoteRefs = refs.filter((ref) => ref.kind === 'remote')
  if (remoteRefs.length > 0) {
    const remoteNames = new Set((await git(cwd, ['remote'], { readOnly: true })).trim().split('\n').filter(Boolean))
    for (const ref of remoteRefs) {
      let checkedOutIn = localBranches.get(ref.name)
      if (checkedOutIn === undefined) {
        const slash = ref.name.indexOf('/')
        if (slash > 0 && remoteNames.has(ref.name.slice(0, slash))) {
          checkedOutIn = localBranches.get(ref.name.slice(slash + 1))
        }
      }
      if (checkedOutIn) ref.checkedOutIn = checkedOutIn
    }
  }

  const needle = query?.toLowerCase() ?? ''
  const filtered = refs
    .filter((ref) => !ref.name.endsWith('/HEAD') && ref.name.toLowerCase().includes(needle))
    .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'local' ? -1 : 1))
  const exactMatchIndex = query
    ? filtered.findIndex((ref) => ref.name === query)
    : -1
  const limited = filtered.slice(0, BRANCH_LIST_LIMIT)
  if (exactMatchIndex >= BRANCH_LIST_LIMIT) {
    limited[BRANCH_LIST_LIMIT - 1] = filtered[exactMatchIndex]!
  }
  const head = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true })
  const current = head.exitCode === 0 ? decoder.decode(head.stdout).trim() || null : null
  return { refs: limited, current }
}

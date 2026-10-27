/**
 * Operations that talk to a remote: push (and force push with an explicit lease), pull,
 * fast-forward, fetch and rebase from a remote base. Each refuses a detached HEAD and throws
 * `RemoteError` with a normalised reason; git runs without prompts and under a 120 s timeout,
 * and a timeout is reported as `network`.
 */
import { getConfig, checkRefFormatBranch, listRemotes, upstreamOf } from './ops'
import { RemoteError, normalizeRemoteError, type RemoteAction } from './remote-error'
import { runGit, type GitResult } from './run'

const NETWORK_TIMEOUT_MS = 120_000
const NO_UPSTREAM = 'Branch has no upstream. Publish the branch first.'
const FULL_SHA = /^[0-9a-f]{40}$/i
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

async function currentBranch(cwd: string): Promise<string> {
  const r = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true })
  const branch = r.exitCode === 0 ? text(r.stdout).trim() : ''
  if (!branch) throw new RemoteError('detached', 'Check out a branch first.')
  return branch
}

async function requireUpstream(cwd: string, branch: string): Promise<void> {
  if (!(await upstreamOf(cwd, branch))) throw new RemoteError('no-upstream', NO_UPSTREAM)
}

function fail(action: RemoteAction, r: GitResult): RemoteError {
  if (r.timedOut) return new RemoteError('network', 'Network error. Check your connection.')
  const n = normalizeRemoteError(action, r.stderr, text(r.stdout))
  return new RemoteError(n.reason, n.message, { summary: n.summary, output: n.output })
}

/** Runs `args` as a network command for `action`; throws the normalised `RemoteError` on failure. */
async function runRemote(cwd: string, action: RemoteAction, args: string[], env?: Record<string, string>): Promise<GitResult> {
  const r = await runGit(cwd, args, { network: true, timeoutMs: NETWORK_TIMEOUT_MS, env })
  if (r.exitCode !== 0 || r.timedOut) throw fail(action, r)
  return r
}

/**
 * Where a push of `branch` goes: the remote is `branch.<b>.pushRemote`, else `remote.pushDefault`,
 * else `branch.<b>.remote`, else `origin`; the destination is the upstream's branch name when the
 * upstream lives on that remote, otherwise `branch` itself.
 */
export async function pushTarget(cwd: string, branch: string): Promise<{ remote: string; dest: string }> {
  const upstreamRemote = await getConfig(cwd, `branch.${branch}.remote`)
  const remote =
    (await getConfig(cwd, `branch.${branch}.pushRemote`)) ||
    (await getConfig(cwd, 'remote.pushDefault')) ||
    upstreamRemote ||
    'origin'
  const merge = await getConfig(cwd, `branch.${branch}.merge`)
  const onPushRemote = upstreamRemote === remote && merge?.startsWith('refs/heads/')
  return { remote, dest: onPushRemote ? merge!.slice('refs/heads/'.length) : branch }
}

/**
 * Pushes HEAD to its push target and sets it as the upstream. With `lease` the push replaces the
 * remote branch only if it is still at `expected` (`null` means the branch must not exist), so a
 * commit pushed since the caller last looked survives; `expected` must be a full 40-hex sha.
 */
export async function push(
  cwd: string,
  options: { lease?: { expected: string | null } } = {}
): Promise<{ remote: string; branch: string; upstream: string }> {
  const branch = await currentBranch(cwd)
  const { remote, dest } = await pushTarget(cwd, branch)
  const lease = options.lease
  if (lease && lease.expected !== null && !FULL_SHA.test(lease.expected)) {
    throw new RemoteError('failed', 'Force push needs the full 40-character commit id the remote branch is expected to be at.')
  }
  const leaseArg = lease ? [`--force-with-lease=refs/heads/${dest}:${lease.expected ?? ''}`] : []
  await runRemote(cwd, lease ? 'force-push' : 'push', ['push', '--set-upstream', ...leaseArg, remote, `HEAD:refs/heads/${dest}`])
  return { remote, branch, upstream: `${remote}/${dest}` }
}

/** The sha of `refs/remotes/<remote>/<dest>` as of the last fetch, or null when there is no such ref. Never contacts the remote. */
export async function remoteTrackingSha(cwd: string, remote: string, dest: string): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${dest}^{commit}`], { readOnly: true })
  return r.exitCode === 0 ? text(r.stdout).trim() || null : null
}

/**
 * `git pull` for the current branch. Fails with `no-upstream` before running git when there is
 * none; a divergent branch with no configured pull strategy is retried as a merge.
 */
export async function pull(cwd: string): Promise<void> {
  await requireUpstream(cwd, await currentBranch(cwd))
  const env = { GIT_EDITOR: 'true' }
  try {
    await runRemote(cwd, 'pull', ['pull'], env)
  } catch (error) {
    if (!(error instanceof RemoteError) || error.reason !== 'divergent-policy') throw error
    await runRemote(cwd, 'pull', ['pull', '--no-rebase'], env)
  }
}

/** Brings the current branch level with its upstream only if that is a fast-forward; a diverged branch fails and is left unchanged. */
export async function fastForward(cwd: string): Promise<void> {
  await requireUpstream(cwd, await currentBranch(cwd))
  await runRemote(cwd, 'fast-forward', ['pull', '--ff-only'], { GIT_EDITOR: 'true' })
}

/** Fetches every configured remote's changes and prunes remote-tracking refs the remote deleted. */
export async function fetch(cwd: string): Promise<void> {
  await currentBranch(cwd)
  await runRemote(cwd, 'fetch', ['fetch', '--prune'])
}

/** The `<remote>` and `<branch>` of `base` (`origin/main`) when it names a configured remote and a valid branch, else null. */
async function parseBase(cwd: string, base: string): Promise<{ remote: string; branch: string } | null> {
  const remote = (await listRemotes(cwd)).filter((r) => base.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
  if (!remote) return null
  const branch = base.slice(remote.length + 1)
  return (await checkRefFormatBranch(branch)) ? { remote, branch } : null
}

/**
 * Fetches the remote base branch and rebases the current branch onto it, replaying only the
 * commits made since the branch left the base. `base` must be `<remote>/<branch>`. A rebase that
 * stops on conflicts throws `conflicts` and is left in progress for the caller to resolve; the
 * temporary ref used for the fetch is always removed.
 */
export async function rebaseFromBase(cwd: string, base: string): Promise<{ result: 'rebased' | 'up-to-date' }> {
  await currentBranch(cwd)
  const parsed = await parseBase(cwd, base)
  if (!parsed) throw new RemoteError('invalid-base', 'Rebase needs a remote base branch (like origin/main).')
  const { remote, branch } = parsed
  const trackingRef = `refs/remotes/${remote}/${branch}`
  const forkPoint = text((await runGit(cwd, ['merge-base', '--fork-point', trackingRef, 'HEAD'], { readOnly: true })).stdout).trim()
  const tmp = `refs/quirky/rebase/${crypto.randomUUID()}`
  try {
    await runRemote(cwd, 'rebase', [
      'fetch',
      '--no-write-fetch-head',
      remote,
      `+refs/heads/${branch}:${tmp}`,
      `+refs/heads/${branch}:${trackingRef}`
    ])
    const unborn = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { readOnly: true })).exitCode !== 0
    if (!unborn && (await runGit(cwd, ['merge-base', '--is-ancestor', tmp, 'HEAD'], { readOnly: true })).exitCode === 0) {
      return { result: 'up-to-date' }
    }
    const args = unborn ? ['merge', '--ff-only', tmp] : forkPoint ? ['rebase', '--onto', tmp, forkPoint] : ['rebase', tmp]
    const r = await runGit(cwd, args, { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } })
    if (r.exitCode !== 0) throw fail('rebase', r)
    return { result: 'rebased' }
  } finally {
    await runGit(cwd, ['update-ref', '-d', tmp])
  }
}

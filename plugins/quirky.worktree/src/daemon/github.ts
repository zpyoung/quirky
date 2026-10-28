import { createHash } from 'node:crypto'
import type { GitHubRepositoryIdentity, GitHubWorktreeSource, WorktreePushTarget } from '@quirky/protocol'
import { gitApi } from '@quirky/git'
import type { Repo } from '@quirky/protocol'
import { worktreeIdForPath } from '../../paths'
import type { ResolvedBase } from './base'

const FETCH_TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 5_000
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const SSH_CONFIG_TIMEOUT_MS = 5_000

type GitHubEnv = {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
}

type GitResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type RemoteUrls = { fetch: string[]; push: string[] }
type BranchSource = { branch: string; fullRef: string; remote: null }

export type PullRequestPlan = {
  branch: string
  startRef: string
  hooksRef: string
  base: ResolvedBase
  baseRef: string
  existing: BranchSource | null
  pushTarget: WorktreePushTarget
  pushRemoteUrl: string | null
  trackingRef: string
  oldTrackingHead: string | null
  fetchedHead: string
  baseTrackingRef: string
  oldBaseTrackingHead: string | null
  fetchedBaseHead: string
}

const failure = (env: GitHubEnv, reason: string, message: string, data: Record<string, unknown> = {}) =>
  env.fail('conflict', message, { reason, ...data })


type ParsedRemoteIdentity = { identity: GitHubRepositoryIdentity; sshHost: string | null }

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return host === 'ssh.github.com' ? 'github.com' : host
}

function parseRemoteIdentity(value: string): ParsedRemoteIdentity | null {
  const url = value.trim()
  let host: string
  let path: string
  let sshHost: string | null = null
  const scp = url.includes('://') ? null : /^(?:[^@/:]+@)?([^/:]+):([^?#]+)$/.exec(url)
  if (scp) {
    host = scp[1]!
    sshHost = host
    path = scp[2]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:' && parsed.protocol !== 'git:') return null
    const ssh = parsed.protocol === 'ssh:' || parsed.protocol === 'git:'
    host = ssh ? parsed.hostname : parsed.host
    sshHost = ssh ? parsed.hostname : null
    path = parsed.pathname.replace(/^\/+/, '')
  }
  const parts = path.replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null
  return {
    identity: { host: normalizeHost(host), owner: parts[0]!, repo: parts[1]! },
    sshHost: sshHost === null ? null : normalizeHost(sshHost)
  }
}


function isDotlessAlias(host: string): boolean {
  return !host.includes('.') && !host.startsWith('[') && host !== 'localhost'
}

async function remoteIdentityFromUrl(value: string): Promise<ParsedRemoteIdentity | null> {
  const parsed = parseRemoteIdentity(value)
  if (!parsed) return null
  if (parsed.sshHost === null || !isDotlessAlias(parsed.sshHost)) return parsed
  const host = await resolveSshAlias(parsed.sshHost)
  return host === null ? null : { ...parsed, identity: { ...parsed.identity, host } }
}

async function resolveSshAlias(alias: string): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['ssh', '-G', '--', alias], { env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  } catch {
    return null
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill('SIGKILL')
    } catch {
      // the lookup process already exited
    }
  }, SSH_CONFIG_TIMEOUT_MS)
  try {
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (timedOut || exitCode !== 0) return null
    const hostname = /^hostname\s+(\S+)\s*$/im.exec(output)?.[1]
    if (!hostname || normalizeHost(hostname) === normalizeHost(alias)) return null
    return normalizeHost(hostname)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function hostnameOf(value: string): string {
  const host = normalizeHost(value)
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close !== -1) return host.slice(0, close + 1)
  }
  const port = host.lastIndexOf(':')
  return port === -1 ? host : host.slice(0, port)
}

function identityMatchesRemote(actual: ParsedRemoteIdentity, expected: GitHubRepositoryIdentity): boolean {
  const hostMatches = actual.sshHost === null
    ? actual.identity.host === normalizeHost(expected.host)
    : hostnameOf(actual.identity.host) === hostnameOf(expected.host)
  return hostMatches &&
    actual.identity.owner.toLowerCase() === expected.owner.toLowerCase() &&
    actual.identity.repo.toLowerCase() === expected.repo.toLowerCase()
}

function identityMatches(url: string, identity: GitHubRepositoryIdentity): boolean {
  const actual = parseRemoteIdentity(url)
  return actual !== null && identityMatchesRemote(actual, identity)
}

function canonicalUrl(source: GitHubWorktreeSource, scheme: 'ssh' | 'https'): string {
  const head = source.head!
  const url = scheme === 'https' ? head.httpsUrl : head.sshUrl
  if (!identityMatches(url, head.repository)) {
    throw new Error(`GitHub clone URL does not match ${head.repository.host}/${head.repository.owner}/${head.repository.repo}`)
  }
  return url
}

async function readLimited(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = MAX_GIT_OUTPUT_BYTES - size
      if (room > 0) {
        const kept = value.length <= room ? value : value.subarray(0, room)
        chunks.push(kept)
        size += kept.length
      }
      if (value.length > room) truncated = true
    }
  } finally {
    reader.releaseLock()
  }
  return `${Buffer.concat(chunks).toString('utf8')}${truncated ? '\n[output truncated]' : ''}`
}

async function runGit(repo: string, args: string[], options: { timeoutMs?: number; network?: boolean } = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (options.network) {
    env.GIT_ASKPASS = ''
    env.SSH_ASKPASS = ''
    const configuredSsh = process.env.GIT_SSH_COMMAND ?? (await gitApi().getConfig(repo, 'core.sshCommand')) ?? process.env.GIT_SSH ?? 'ssh'
    env.GIT_SSH_COMMAND = /(?:^|\s)-o\s+BatchMode=/i.test(configuredSsh) ? configuredSsh : `${configuredSsh} -o BatchMode=yes`
  }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd: repo,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...({ detached: true } as object)
    })
  } catch (error) {
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: null, timedOut: false }
  }
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal)
    } catch {
      try {
        proc.kill(signal)
      } catch {
        // the process already exited
      }
    }
  }
  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    killGroup('SIGTERM')
    hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
  }, options.timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimited(proc.stdout as ReadableStream<Uint8Array>),
      readLimited(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited
    ])
    return { stdout, stderr, exitCode, timedOut }
  } finally {
    clearTimeout(timer)
    if (hardKill !== undefined) {
      killGroup('SIGKILL')
      clearTimeout(hardKill)
    }
  }
}

async function configValues(repo: string, key: string): Promise<string[]> {
  const result = await runGit(repo, ['config', '--local', '--get-all', key])
  return result.exitCode === 0 ? result.stdout.replace(/\r?\n$/, '').split(/\r?\n/) : []
}

async function remoteUrls(repo: string, remote: string): Promise<RemoteUrls> {
  const [fetch, push] = await Promise.all([
    configValues(repo, `remote.${remote}.url`),
    configValues(repo, `remote.${remote}.pushurl`)
  ])
  return { fetch, push: push.length === 0 ? fetch : push }
}

type UrlMatcher = (url: string) => Promise<boolean>
function urlMatcherForIdentity(identity: GitHubRepositoryIdentity): UrlMatcher {
  const cache = new Map<string, Promise<boolean>>()
  return (url) => {
    let match = cache.get(url)
    if (!match) {
      match = remoteIdentityFromUrl(url).then((actual) => actual !== null && identityMatchesRemote(actual, identity))
      cache.set(url, match)
    }
    return match
  }
}

async function urlsMatchIdentity(urls: string[], matchesUrl: UrlMatcher): Promise<boolean> {
  if (urls.length === 0) return false
  for (const url of urls) {
    if (!await matchesUrl(url)) return false
  }
  return true
}

async function urlsIncludeIdentity(urls: string[], matchesUrl: UrlMatcher): Promise<boolean> {
  for (const url of urls) {
    if (await matchesUrl(url)) return true
  }
  return false
}

async function matchingRemote(repo: string, identity: GitHubRepositoryIdentity, requirePushIdentity = true): Promise<{ name: string; urls: RemoteUrls } | null> {
  const git = gitApi()
  const candidates: { name: string; urls: RemoteUrls }[] = []
  const matchesUrl = urlMatcherForIdentity(identity)
  for (const name of await git.listRemotes(repo)) {
    const urls = await remoteUrls(repo, name)
    if (!await urlsIncludeIdentity(urls.fetch, matchesUrl)) continue
    if (!await urlsMatchIdentity(urls.fetch, matchesUrl) || (requirePushIdentity && !await urlsMatchIdentity(urls.push, matchesUrl))) {
      throw failureForRemote(name, identity)
    }
    candidates.push({ name, urls })
  }
  candidates.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name.localeCompare(b.name)))
  return candidates[0] ?? null
}

function failureForRemote(remote: string, identity: GitHubRepositoryIdentity): Error {
  return Object.assign(new Error(`remote ${remote} has conflicting fetch and push URLs for ${identity.owner}/${identity.repo}`), { reason: 'remote-url-conflict', remote })
}

function remoteNameForFork(identity: GitHubRepositoryIdentity): string {
  const owner = identity.owner.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const repo = identity.repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `pr-${owner}-${repo}`
}

async function restoreRef(repo: string, ref: string, oldHead: string | null, fetchedHead: string | null): Promise<void> {
  if (fetchedHead === null || fetchedHead === oldHead) return
  const args = oldHead === null ? ['update-ref', '-d', ref, fetchedHead] : ['update-ref', ref, oldHead, fetchedHead]
  const result = await runGit(repo, args)
  if (result.exitCode !== 0) throw new Error(`could not restore temporary GitHub tracking ref ${ref}: ${result.stderr.trim() || 'git update-ref failed'}`)
}

export async function resolveGitHubSource(env: GitHubEnv, repo: Repo, reference: string): Promise<GitHubWorktreeSource> {
  return (await env.call('quirky.hosting/worktreeSource', {
    worktree: worktreeIdForPath(repo.path),
    reference
  })) as GitHubWorktreeSource
}

export async function planPullRequest(env: GitHubEnv, repo: Repo, source: GitHubWorktreeSource): Promise<PullRequestPlan> {
  const git = gitApi()
  const head = source.head
  const base = source.base
  if (source.item.kind !== 'pullRequest' || head === null || base === null) {
    throw env.fail('invalid-params', 'The GitHub source is not a complete pull request.')
  }
  if (!FULL_OID.test(head.oid) || !FULL_OID.test(base.oid)) {
    throw env.fail('invalid-params', 'The GitHub pull request contains an invalid commit ID.')
  }
  const headOid = head.oid.toLowerCase()
  if (!(await git.checkRefFormatBranch(head.refName)) || !(await git.checkRefFormatBranch(base.refName))) {
    throw env.fail('invalid-params', 'The GitHub pull request contains an invalid branch name.')
  }

  const baseRemote = await matchingRemote(repo.path, base.repository, false)
  if (!baseRemote) {
    throw failure(env, 'github-base-remote-missing', `No configured Git remote matches the pull request base repository ${base.repository.owner}/${base.repository.repo}.`, {
      repository: base.repository
    })
  }
  const baseUrl = baseRemote.urls.fetch.length === 1 ? baseRemote.urls.fetch[0]! : [...baseRemote.urls.fetch].sort().join('\n')
  const refComponent = createHash('sha256').update(baseUrl).digest('hex')
  const trackingRef = `refs/quirky/pull/${refComponent}/${source.item.number}`
  const baseTrackingRef = `refs/remotes/${baseRemote.name}/${base.refName}`
  const oldBaseTrackingHead = await git.resolveCommit(repo.path, baseTrackingRef)
  const oldTrackingHead = await git.resolveCommit(repo.path, trackingRef)
  const fetched = await runGit(
    repo.path,
    ['fetch', '--no-tags', '--no-write-fetch-head', '--', baseRemote.name, `+refs/pull/${source.item.number}/head:${trackingRef}`, `+refs/heads/${base.refName}:${baseTrackingRef}`],
    { timeoutMs: FETCH_TIMEOUT_MS, network: true }
  )
  if (fetched.exitCode !== 0 || fetched.timedOut) {
    const changedHead = await git.resolveCommit(repo.path, trackingRef)
    await restoreRef(repo.path, trackingRef, oldTrackingHead, changedHead).catch(() => {})
    const changedBaseHead = await git.resolveCommit(repo.path, baseTrackingRef)
    await restoreRef(repo.path, baseTrackingRef, oldBaseTrackingHead, changedBaseHead).catch(() => {})
    throw failure(env, 'github-head-fetch-failed', `Could not fetch pull request #${source.item.number} from ${baseRemote.name}; no local or stale head was used. Check the configured remote and try again.`, {
      number: source.item.number,
      remote: baseRemote.name,
      timedOut: fetched.timedOut
    })
  }

  const fetchedHead = await git.resolveCommit(repo.path, trackingRef)
  const fetchedBaseHead = await git.resolveCommit(repo.path, baseTrackingRef)
  if (fetchedBaseHead === null) {
    await restoreRef(repo.path, trackingRef, oldTrackingHead, fetchedHead).catch(() => {})
    await restoreRef(repo.path, baseTrackingRef, oldBaseTrackingHead, fetchedBaseHead).catch(() => {})
    throw failure(env, 'github-base-fetch-failed', `Could not fetch base branch ${base.refName} from ${baseRemote.name}.`, { number: source.item.number, remote: baseRemote.name })
  }
  if (fetchedHead === null || fetchedHead.toLowerCase() !== headOid) {
    await restoreRef(repo.path, trackingRef, oldTrackingHead, fetchedHead).catch(() => {})
    await restoreRef(repo.path, baseTrackingRef, oldBaseTrackingHead, fetchedBaseHead).catch(() => {})
    throw failure(env, 'github-head-moved', `Pull request #${source.item.number} head changed while it was being fetched; resolve it again and retry.`, {
      number: source.item.number,
      expectedHead: headOid,
      fetchedHead
    })
  }

  let pushTarget: WorktreePushTarget
  let pushRemoteUrl: string | null = null
  try {
    const headRemote = await matchingRemote(repo.path, head.repository)
    if (headRemote) {
      pushTarget = { remoteName: headRemote.name, branchName: head.refName, maintainerCanModify: head.maintainerCanModify }
    } else {
      const remoteName = remoteNameForFork(head.repository)
      const configured = await remoteUrls(repo.path, remoteName)
      if (configured.fetch.length > 0 || configured.push.length > 0) {
        const matchesUrl = urlMatcherForIdentity(head.repository)
        const [fetchMatches, pushMatches] = await Promise.all([
          urlsMatchIdentity(configured.fetch, matchesUrl),
          urlsMatchIdentity(configured.push, matchesUrl)
        ])
        if (!fetchMatches || !pushMatches) {
          throw failure(env, 'github-push-remote-conflict', `Remote ${remoteName} already points to a different repository and was not changed.`, {
            remote: remoteName,
            repository: head.repository
          })
        }
      } else {
        const originUrl = (await configValues(repo.path, 'remote.origin.url'))[0] ?? ''
        const scheme = /^https:\/\//i.test(originUrl) ? 'https' : 'ssh'
        pushRemoteUrl = canonicalUrl(source, scheme)
      }
      pushTarget = { remoteName, branchName: head.refName, maintainerCanModify: head.maintainerCanModify }
    }
  } catch (error) {
    await restoreRef(repo.path, trackingRef, oldTrackingHead, fetchedHead).catch(() => {})
    await restoreRef(repo.path, baseTrackingRef, oldBaseTrackingHead, fetchedBaseHead).catch(() => {})
    if (error instanceof Error && 'code' in error) throw error
    if (error instanceof Error && 'reason' in error) throw env.fail('conflict', error.message, { reason: (error as { reason?: string }).reason, remote: (error as { remote?: string }).remote })
    throw error
  }

  const existing = await git.localBranchExists(repo.path, head.refName)
    ? { branch: head.refName, fullRef: `refs/heads/${head.refName}`, remote: null as null }
    : null
  if (existing !== null && (await git.branchHead(repo.path, head.refName))?.toLowerCase() !== headOid) {
    await restoreRef(repo.path, trackingRef, oldTrackingHead, fetchedHead).catch(() => {})
    await restoreRef(repo.path, baseTrackingRef, oldBaseTrackingHead, fetchedBaseHead).catch(() => {})
    throw failure(env, 'github-branch-diverged', `Local branch ${head.refName} does not point at the current pull request head; it was left unchanged.`, {
      branch: head.refName,
      expectedHead: headOid
    })
  }

  const baseRef = `refs/remotes/${baseRemote.name}/${base.refName}`
  return {
    branch: head.refName,
    startRef: headOid,
    hooksRef: headOid,
    base: { fullRef: baseRef, shortRef: `${baseRemote.name}/${base.refName}` },
    baseRef: `${baseRemote.name}/${base.refName}`,
    existing,
    pushTarget,
    pushRemoteUrl,
    trackingRef,
    oldTrackingHead,
    fetchedHead,
    baseTrackingRef,
    oldBaseTrackingHead,
    fetchedBaseHead
  }
}

export async function restorePullRef(repo: string, plan: PullRequestPlan): Promise<void> {
  await Promise.all([
    restoreRef(repo, plan.trackingRef, plan.oldTrackingHead, plan.fetchedHead),
    restoreRef(repo, plan.baseTrackingRef, plan.oldBaseTrackingHead, plan.fetchedBaseHead)
  ])
}

export async function addPushRemote(repo: string, plan: PullRequestPlan): Promise<boolean> {
  if (plan.pushRemoteUrl === null) return false
  const result = await runGit(repo, ['remote', 'add', plan.pushTarget.remoteName, plan.pushRemoteUrl])
  if (result.exitCode !== 0) throw new Error(`could not add Git remote ${plan.pushTarget.remoteName}: ${result.stderr.trim() || 'git remote add failed'}`)
  return true
}

export async function removePushRemote(repo: string, plan: PullRequestPlan): Promise<void> {
  const urls = await remoteUrls(repo, plan.pushTarget.remoteName)
  if (
    urls.fetch.length !== 1 ||
    urls.fetch[0] !== plan.pushRemoteUrl ||
    urls.push.length !== 1 ||
    urls.push[0] !== plan.pushRemoteUrl
  ) return
  const result = await runGit(repo, ['remote', 'remove', plan.pushTarget.remoteName])
  if (result.exitCode !== 0) throw new Error(`could not remove temporary remote ${plan.pushTarget.remoteName}: ${result.stderr.trim()}`)
}

export async function snapshotBranchConfig(repo: string, branch: string): Promise<Map<string, string[]>> {
  const keys = [
    `branch.${branch}.base`,
    `branch.${branch}.remote`,
    `branch.${branch}.merge`,
    `branch.${branch}.pushRemote`
  ]
  const values = new Map<string, string[]>()
  for (const key of keys) values.set(key, await configValues(repo, key))
  return values
}

export async function configurePullBranch(repo: string, plan: PullRequestPlan): Promise<void> {
  const git = gitApi()
  await git.setLocalConfig(repo, `branch.${plan.branch}.base`, plan.base.fullRef)
  await git.setLocalConfig(repo, `branch.${plan.branch}.remote`, plan.pushTarget.remoteName)
  await git.setLocalConfig(repo, `branch.${plan.branch}.merge`, `refs/heads/${plan.pushTarget.branchName}`)
  await git.setLocalConfig(repo, `branch.${plan.branch}.pushRemote`, plan.pushTarget.remoteName)
}

export async function restoreBranchConfig(repo: string, snapshot: Map<string, string[]>): Promise<void> {
  for (const [key, values] of snapshot) {
    const unset = await runGit(repo, ['config', '--local', '--unset-all', key])
    if (unset.exitCode !== 0 && unset.exitCode !== 5) throw new Error(`could not restore Git config ${key}: ${unset.stderr.trim()}`)
    for (const value of values) {
      const add = await runGit(repo, ['config', '--local', '--add', key, value])
      if (add.exitCode !== 0) throw new Error(`could not restore Git config ${key}: ${add.stderr.trim()}`)
    }
  }
}

import type { PluginCaller } from '@quirky/protocol'
import { isHost, normalizeHost } from '../auth-inventory'
import { isRecord } from '../data'
import type { HostingEnv, Identity } from '../env'
import { gitlabError, type GitLabClient } from './api'
import type { GitLabToken } from './token'
import type { GitLabHandler, GitLabHandlers, GitLabScope } from './types'

const MAX_REMOTE_LENGTH = 4096
const MAX_PATH_SEGMENTS = 21
const MAX_SEGMENT_LENGTH = 255
const REQUIRED_SCOPES = ['api'] as const

type GitLabIdentity = { host: string; owner: string; repo: string }
type AuthAccountResult = { host: string; user: string; source: 'env' | 'keyring'; active: true; scopes: string[] }

export function parseGitLabRemote(remote: string): GitLabIdentity | null {
  if (typeof remote !== 'string' || remote.length === 0 || remote.length > MAX_REMOTE_LENGTH
    || /[\\\s\u0000-\u001f\u007f]/u.test(remote)) return null

  const value = remote.trim()
  let host: string
  let rawPath: string

  if (!value.includes('://')) {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value)
    if (!scp) return null
    host = normalizeHost(scp[1] ?? '')
    rawPath = `/${scp[2] ?? ''}`
  } else {
    const remoteParts = /^([a-z][a-z\d+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:[?#].*)?$/iu.exec(value)
    if (!remoteParts) return null
    const protocol = `${(remoteParts[1] ?? '').toLowerCase()}:`
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(protocol)) return null

    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.search.length > 0 || url.hash.length > 0) return null
    const ssh = protocol === 'ssh:' || protocol === 'git:' || protocol === 'git+ssh:'
    host = normalizeHost(ssh ? url.hostname : url.host)
    rawPath = remoteParts[3] ?? ''
  }

  if (!isHost(host) || !rawPath.startsWith('/')) return null
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const rawSegments = path.slice(1).split('/')
  if (rawSegments.length < 2 || rawSegments.length > MAX_PATH_SEGMENTS || rawSegments.some((segment) => segment.length === 0)) {
    return null
  }

  const segments: string[] = []
  for (const rawSegment of rawSegments) {
    let segment: string
    try {
      segment = decodeURIComponent(rawSegment)
    } catch {
      return null
    }
    if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH || segment === '.' || segment === '..'
      || segment.startsWith('-') || /[\s\u0000-\u001f\u007f/\\]/u.test(segment)
      || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(segment)) return null
    segments.push(segment)
  }

  const repositoryName = segments.pop()
  if (!repositoryName) return null
  const repo = repositoryName.replace(/\.git$/iu, '')
  if (repo.length === 0 || repo.length > MAX_SEGMENT_LENGTH || repo.startsWith('-')) return null
  return { host, owner: segments.join('/'), repo }
}

export function parseGitLabHosts(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const hosts: string[] = []
  const seen = new Set<string>()
  for (const entry of value.split(/[\s,]+/u)) {
    if (entry.length === 0) continue
    const host = normalizeHost(entry)
    if (!isHost(host) || seen.has(host)) continue
    seen.add(host)
    hosts.push(host)
    if (hosts.length === 64) break
  }
  return hosts
}

export function gitlabApiBase(host: string): string {
  const normalized = normalizeHost(host)
  const hostname = normalized.startsWith('[')
    ? normalized.slice(1, normalized.indexOf(']'))
    : normalized.replace(/:\d+$/u, '')
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  return `${local ? 'http' : 'https'}://${normalized}/api/v4`
}

export async function resolveGitLabScope(
  env: HostingEnv,
  params: Record<string, unknown>,
  caller: PluginCaller
): Promise<GitLabScope | null> {
  try {
    if (params.worktree !== undefined && typeof params.worktree !== 'string') return null
    const selector = typeof params.worktree === 'string' ? params.worktree : 'current'
    const worktree = await env.resolveWorktree(selector, caller)
    if (worktree.kind !== 'git') return null

    const remotes = await env.remoteUrls(worktree)
    if (remotes.origin === null) return null
    const parsed = parseGitLabRemote(remotes.origin)
    if (!parsed) return null
    const configuredHosts = parseGitLabHosts(env.context.getSetting('gitlabHosts') ?? 'gitlab.com')
    if (!configuredHosts.includes(parsed.host)) return null

    const identity: Identity = { host: parsed.host, owner: parsed.owner, repo: parsed.repo }
    return {
      worktree,
      origin: identity,
      repository: identity,
      candidates: [identity],
      issueRepository: identity,
      issueSourcePreference: 'origin',
      issueSourceFellBack: false,
      provider: 'gitlab',
      apiBase: gitlabApiBase(identity.host),
      projectId: encodeURIComponent(`${identity.owner}/${identity.repo}`)
    }
  } catch {
    return null
  }
}

export function createGitLabIdentityHandlers(env: HostingEnv, client: GitLabClient): GitLabHandlers {
  const repository: GitLabHandler = (scope) => ({
    provider: 'gitlab',
    worktreeId: scope.worktree.id,
    origin: scope.origin,
    head: scope.origin,
    repository: scope.repository,
    candidates: scope.candidates,
    issueRepository: scope.issueRepository,
    issueSourcePreference: 'origin',
    issueSourceFellBack: false,
    apiBase: scope.apiBase
  })

  const diagnoseAuth: GitLabHandler = async (scope, _params) => {
    const token = await client.token(scope)
    if (token.token === null) return authResult(scope, token, null, [], false, false)

    try {
      const userResponse = await client.request(scope, { method: 'GET', path: '/user' })
      const user = userResponse.json
      if (!isRecord(user) || typeof user.username !== 'string' || user.username.length === 0) {
        throw gitlabError(env, 'schema_drift', 'GitLab returned an unsupported authenticated user.')
      }

      let scopes: string[] = []
      let scopesKnown = true
      try {
        const tokenResponse = await client.request(scope, { method: 'GET', path: '/personal_access_tokens/self' })
        const tokenInfo = tokenResponse.json
        if (!isRecord(tokenInfo) || !Array.isArray(tokenInfo.scopes)) {
          throw gitlabError(env, 'schema_drift', 'GitLab returned unsupported token scope information.')
        }
        for (const scopeName of tokenInfo.scopes) {
          if (typeof scopeName !== 'string') {
            throw gitlabError(env, 'schema_drift', 'GitLab returned unsupported token scope information.')
          }
          scopes.push(scopeName)
        }
      } catch (error) {
        if (errorReason(error) === 'not_found') {
          scopesKnown = false
        } else if (errorReason(error) === 'auth_required') {
          return authResult(scope, token, null, [], false, true)
        } else {
          throw error
        }
      }
      return authResult(scope, token, user.username, scopes, scopesKnown, false)
    } catch (error) {
      if (errorReason(error) === 'auth_required') return authResult(scope, token, null, [], false, true)
      throw error
    }
  }

  const viewer: GitLabHandler = async (scope, _params) => env.cache(
    env.cacheKey(scope, 'gitlab-viewer'),
    30_000,
    async () => {
      const response = await client.request(scope, { method: 'GET', path: '/user' })
      const user = response.json
      if (!isRecord(user) || typeof user.username !== 'string' || user.username.length === 0) {
        throw gitlabError(env, 'schema_drift', 'GitLab returned an invalid authenticated viewer.')
      }
      return { login: user.username }
    }
  )

  return { repository, diagnoseAuth, viewer }
}

function authResult(
  scope: GitLabScope,
  token: GitLabToken,
  username: string | null,
  scopes: string[],
  scopesKnown: boolean,
  tokenRejected: boolean
): Record<string, unknown> {
  const account: AuthAccountResult | null = username === null ? null : {
    host: scope.origin.host,
    user: username,
    source: token.source === 'env' ? 'env' : 'keyring',
    active: true,
    scopes
  }
  return {
    provider: 'gitlab',
    tokenSource: token.source,
    glabAvailable: token.glabAvailable,
    tokenRejected,
    activeAccount: account === null ? null : { host: account.host, user: account.user },
    accounts: account === null ? [] : [account],
    envTokenInProcess: (process.env.GITLAB_TOKEN ?? '').trim().length > 0,
    missingScopes: scopesKnown ? REQUIRED_SCOPES.filter((scopeName) => !scopes.includes(scopeName)) : [],
    requiredScopes: [...REQUIRED_SCOPES],
    hasKeyringFallback: account?.source === 'keyring',
    requiredHost: scope.origin.host,
    requiredHostAuthenticated: account !== null
  }
}

function errorReason(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.reason !== 'string') return undefined
  return error.data.reason
}

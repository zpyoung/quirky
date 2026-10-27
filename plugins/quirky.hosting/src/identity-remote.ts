import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { matchEnterpriseHost, normalizeHost, type AuthAccount } from './auth-inventory'
import type { Identity } from './env'

const execFileAsync = promisify(execFile)
const ALIAS_SUCCESS_TTL_MS = 60_000
const ALIAS_FAILURE_TTL_MS = 5_000
const ALIAS_CACHE_LIMIT = 256

type RemoteIdentity = {
  identity: Identity
  ssh: boolean
  requiresAliasResolution: boolean
}

type AliasResult = { host: string | null; expiresAt: number }
const aliasCache = new Map<string, AliasResult>()

export function parseRemoteIdentity(remote: string): RemoteIdentity | null {
  const trimmed = remote.trim()
  if (!trimmed || trimmed.length > 4096) return null

  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(trimmed)
  if (scp && !trimmed.includes('://')) {
    const path = normalizeRepositoryPath(scp[2] ?? '')
    const host = normalizeHost(scp[1] ?? '')
    if (!path || !validRemoteHost(host)) return null
    return {
      identity: { host, owner: path.owner, repo: path.repo },
      ssh: true,
      requiresAliasResolution: isDotlessAlias(host)
    }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(protocol)) return null
  if (url.username && url.username.length > 256) return null
  const path = normalizeRepositoryPath(url.pathname)
  const ssh = protocol === 'ssh:' || protocol === 'git+ssh:' || protocol === 'git:'
  let host = normalizeHost(ssh ? url.hostname : url.host)
  if (ssh && url.port && host === 'github.com' && url.port !== '22') host = 'github.com'
  if (!path || !validRemoteHost(host)) return null
  return {
    identity: { host, owner: path.owner, repo: path.repo },
    ssh,
    requiresAliasResolution: ssh && isDotlessAlias(host)
  }
}

export async function resolveTrustedIdentity(
  remote: RemoteIdentity,
  accountsForHost: (host: string) => Promise<readonly AuthAccount[]>
): Promise<Identity | null> {
  let host = remote.identity.host
  if (remote.requiresAliasResolution) {
    const resolved = await resolveSshAlias(host)
    if (resolved === null) return null
    host = resolved
  }

  host = normalizeHost(host)
  if (host === 'github.com') return { ...remote.identity, host }
  const inventory = await accountsForHost(host)
  const trustedHost = matchEnterpriseHost(host, remote.ssh, inventory)
  return trustedHost === null ? null : { ...remote.identity, host: trustedHost }
}

async function resolveSshAlias(alias: string): Promise<string | null> {
  const cacheKey = `${process.env.HOME ?? ''}|${alias}`
  const cached = aliasCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    refreshAliasLru(cacheKey, cached)
    return cached.host
  }

  let host: string | null = null
  try {
    const result = await execFileAsync('ssh', ['-G', '--', alias], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      windowsHide: true
    })
    const stdout = result.stdout
    const hostname = /^hostname\s+(\S+)\s*$/im.exec(stdout)?.[1]
    if (hostname && hostname.toLowerCase() !== alias.toLowerCase()) {
      const normalized = normalizeHost(hostname)
      if (validRemoteHost(normalized)) host = normalized
    }
  } catch {
    host = null
  }

  aliasCache.set(cacheKey, {
    host,
    expiresAt: now + (host === null ? ALIAS_FAILURE_TTL_MS : ALIAS_SUCCESS_TTL_MS)
  })
  while (aliasCache.size > ALIAS_CACHE_LIMIT) {
    const oldest = aliasCache.keys().next().value
    if (oldest === undefined) break
    aliasCache.delete(oldest)
  }
  return host
}

function refreshAliasLru(key: string, value: AliasResult): void {
  aliasCache.delete(key)
  aliasCache.set(key, value)
}

function normalizeRepositoryPath(value: string): { owner: string; repo: string } | null {
  let path = value.replace(/^\/+|\/+$/g, '')
  if (path.endsWith('.git')) path = path.slice(0, -4)
  const parts = path.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null
  return { owner, repo }
}

function validRemoteHost(value: string): boolean {
  if (!value || value.length > 255 || /[\s/@?#\\]/.test(value)) return false
  return /^(?:[a-z0-9.-]+)(?::\d{1,5})?$/.test(value) && value !== '.' && value !== '..'
}

function isDotlessAlias(host: string): boolean {
  return !host.includes('.') && !host.startsWith('[') && host !== 'localhost'
}

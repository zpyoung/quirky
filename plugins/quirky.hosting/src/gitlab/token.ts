import type { ProcessRunner } from '@quirky/protocol'

export type GitLabToken = {
  token: string | null
  source: 'env' | 'glab' | null
  glabAvailable: boolean | null
}

type CacheEntry = {
  expiresAt: number
  value?: GitLabToken
  pending?: Promise<GitLabToken>
}

const TOKEN_TTL_MS = 5 * 60_000
const EMPTY_TOKEN_TTL_MS = 30_000
const GLAB_TIMEOUT_MS = 5_000
const GLAB_OUTPUT_LIMIT = 64 * 1024
const tokenCaches = new WeakMap<ProcessRunner, Map<string, CacheEntry>>()

export async function readGitLabToken(runner: ProcessRunner, host: string): Promise<GitLabToken> {
  const environmentToken = (process.env.GITLAB_TOKEN ?? '').trim()
  if (environmentToken.length > 0) {
    return { token: environmentToken, source: 'env', glabAvailable: null }
  }

  const cache = cacheFor(runner)
  const cached = cache.get(host)
  if (cached?.pending) return cached.pending
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value
  if (cached) cache.delete(host)

  const entry: CacheEntry = { expiresAt: Number.POSITIVE_INFINITY }
  const pending = loadGitLabToken(runner, host)
    .then((value) => {
      if (cache.get(host) === entry) {
        cache.set(host, {
          value,
          expiresAt: Date.now() + (value.token === null ? EMPTY_TOKEN_TTL_MS : TOKEN_TTL_MS)
        })
      }
      return value
    })
    .catch(() => {
      const value: GitLabToken = { token: null, source: null, glabAvailable: false }
      if (cache.get(host) === entry) cache.set(host, { value, expiresAt: Date.now() + EMPTY_TOKEN_TTL_MS })
      return value
    })
  entry.pending = pending
  cache.set(host, entry)
  return pending
}

export function invalidateGitLabToken(runner: ProcessRunner, host: string): void {
  tokenCaches.get(runner)?.delete(host)
}

function cacheFor(runner: ProcessRunner): Map<string, CacheEntry> {
  let cache = tokenCaches.get(runner)
  if (!cache) {
    cache = new Map<string, CacheEntry>()
    tokenCaches.set(runner, cache)
  }
  return cache
}

async function loadGitLabToken(runner: ProcessRunner, host: string): Promise<GitLabToken> {
  const childEnvironment: Record<string, string | undefined> = {
    ...process.env,
    GLAB_CHECK_UPDATE: 'false',
    GLAB_SEND_TELEMETRY: 'false',
    GLAB_NO_PROMPT: 'true'
  }
  delete childEnvironment.GITLAB_HOST
  delete childEnvironment.GITLAB_URI
  delete childEnvironment.GL_HOST

  try {
    const result = await runner.run(['glab', 'config', 'get', 'token', '--host', host], {
      timeoutMs: GLAB_TIMEOUT_MS,
      maxOutputBytes: GLAB_OUTPUT_LIMIT,
      env: childEnvironment
    })
    if (result.spawnError !== undefined) return { token: null, source: null, glabAvailable: false }

    const completed = result.exitCode === 0
      && result.signal === null
      && result.stopped === undefined
      && result.truncated?.stdout !== true
    const token = completed ? result.stdoutText.trim() : ''
    return token.length > 0
      ? { token, source: 'glab', glabAvailable: true }
      : { token: null, source: null, glabAvailable: true }
  } catch {
    return { token: null, source: null, glabAvailable: false }
  }
}

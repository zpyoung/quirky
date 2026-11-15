import { isRecord } from '../data'
import type { HostingEnv } from '../env'
import { invalidateGitLabToken, readGitLabToken, type GitLabToken } from './token'
import type { GitLabScope } from './types'

export type GitLabRequest = {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  query?: Record<string, string | number | boolean>
  body?: Record<string, unknown>
}

export type GitLabResponse = {
  status: number
  json: unknown
  nextPage: number | null
  retryAfterMs: number | null
}

const BODY_LIMIT_BYTES = 4 * 1024 * 1024
const READ_DEADLINE_MS = 30_000
const WRITE_DEADLINE_MS = 60_000
const AUTH_REQUIRED_MESSAGE = 'GitLab authentication is unavailable. Set GITLAB_TOKEN or run glab auth login.'

export function gitlabError(
  env: HostingEnv,
  reason: string,
  message: string,
  extras: Record<string, unknown> = {}
): Error {
  const kind = reason === 'not_found' ? 'not-found' : 'conflict'
  return Object.assign(env.context.error(kind, message), { data: { ...extras, reason } })
}

export function createGitLabClient(
  env: HostingEnv,
  options: { fetch?: typeof fetch; readToken?: typeof readGitLabToken } = {}
) {
  const fetcher = options.fetch ?? fetch
  const readToken = options.readToken ?? readGitLabToken

  async function token(scope: GitLabScope): Promise<GitLabToken> {
    return readToken(env.context.process, scope.origin.host)
  }

  async function request(scope: GitLabScope, request: GitLabRequest): Promise<GitLabResponse> {
    const url = requestUrl(env, scope, request)
    const credentials = await token(scope)
    if (!credentials.token) throw gitlabError(env, 'auth_required', AUTH_REQUIRED_MESSAGE)

    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${credentials.token}`
    })
    const body = request.body === undefined ? undefined : JSON.stringify(request.body)
    if (body !== undefined) headers.set('Content-Type', 'application/json')

    const controller = new AbortController()
    let timedOut = false
    const deadlineMs = request.method === 'GET' ? READ_DEADLINE_MS : WRITE_DEADLINE_MS
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, deadlineMs)

    try {
      const response = await fetcher(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: controller.signal
      })

      if (response.status === 401) {
        invalidateGitLabToken(env.context.process, scope.origin.host)
        void response.body?.cancel().catch(() => undefined)
        throw gitlabError(env, 'auth_required', AUTH_REQUIRED_MESSAGE)
      }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined)
        throw gitlabError(env, 'redirect_refused', 'GitLab redirected the request; redirects are not followed.')
      }
      const statusFailure = responseError(env, response)
      if (statusFailure) {
        void response.body?.cancel().catch(() => undefined)
        throw statusFailure
      }

      const bytes = await readResponseBody(env, response)
      let json: unknown = null
      if (response.status !== 204 && response.status !== 205) {
        if (bytes.byteLength === 0) {
          throw gitlabError(env, 'schema_drift', 'GitLab returned an unsupported API response.')
        }
        try {
          json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        } catch {
          throw gitlabError(env, 'schema_drift', 'GitLab returned an unsupported API response.')
        }
      }
      return {
        status: response.status,
        json,
        nextPage: parseNextPage(response.headers.get('x-next-page')),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
      }
    } catch (error) {
      if (hasGitLabReason(error)) throw error
      if (timedOut || isAbortError(error)) {
        throw gitlabError(env, 'timeout', 'The GitLab request timed out.')
      }
      throw gitlabError(env, 'network_error', 'The GitLab request could not be completed.')
    } finally {
      clearTimeout(timer)
    }
  }

  async function pages(
    scope: GitLabScope,
    requestSpec: GitLabRequest,
    maxPages: number
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw gitlabError(env, 'invalid_input', 'The GitLab page limit is invalid.')
    }

    const items: unknown[] = []
    const seenPages = new Set<number>()
    const initialPage = positivePage(requestSpec.query?.page) ?? 1
    seenPages.add(initialPage)
    let query = requestSpec.query === undefined ? undefined : { ...requestSpec.query }

    for (let index = 0; index < maxPages; index++) {
      const response = await request(scope, { ...requestSpec, ...(query === undefined ? {} : { query }) })
      if (!Array.isArray(response.json)) {
        throw gitlabError(env, 'schema_drift', 'GitLab returned an unsupported API response.')
      }
      items.push(...response.json)
      if (response.nextPage === null) return { items, truncated: false }
      if (index === maxPages - 1 || seenPages.has(response.nextPage)) return { items, truncated: true }

      seenPages.add(response.nextPage)
      query = { ...query, page: response.nextPage }
    }

    return { items, truncated: false }
  }

  return { request, pages, token }
}

export type GitLabClient = ReturnType<typeof createGitLabClient>

function requestUrl(env: HostingEnv, scope: GitLabScope, request: GitLabRequest): URL {
  const path = request.path
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048 || !path.startsWith('/')
    || /[\u0000-\u0020\u007f\\?#]/u.test(path) || /%(?![0-9a-f]{2})/iu.test(path)) {
    throw gitlabError(env, 'invalid_input', 'The GitLab API path is invalid.')
  }

  for (const segment of path.split('/')) {
    try {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..') throw new Error('dot segment')
    } catch {
      throw gitlabError(env, 'invalid_input', 'The GitLab API path is invalid.')
    }
  }

  let base: URL
  try {
    base = new URL(scope.apiBase)
  } catch {
    throw gitlabError(env, 'invalid_input', 'The GitLab API base is invalid.')
  }

  const host = scope.origin.host.toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/u, '')
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  const expectedProtocol = loopback ? 'http:' : 'https:'
  if (base.protocol !== expectedProtocol || base.host.toLowerCase() !== host || base.username.length > 0
    || base.password.length > 0 || base.pathname !== '/api/v4' || base.search.length > 0 || base.hash.length > 0) {
    throw gitlabError(env, 'invalid_input', 'The GitLab API base is invalid.')
  }

  const url = new URL(base.href)
  url.pathname = `${base.pathname}${path}`
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value))
  return url
}

async function readResponseBody(env: HostingEnv, response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw gitlabError(env, 'output_limit', 'The GitLab response exceeded the configured output limit.')
  }

  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      totalBytes += value.byteLength
      if (totalBytes > BODY_LIMIT_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The response is already over its cap; cancellation is best-effort.
        }
        throw gitlabError(env, 'output_limit', 'The GitLab response exceeded the configured output limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function responseError(env: HostingEnv, response: Response): Error | null {
  const status = response.status
  if (status >= 200 && status < 300) return null
  if (status === 403) return gitlabError(env, 'permission_denied', 'GitLab denied the request.')
  if (status === 404) return gitlabError(env, 'not_found', 'The GitLab resource was not found.')
  if (status === 409) return gitlabError(env, 'already_exists', 'A matching GitLab resource already exists.')
  if (status === 400 || status === 422) return gitlabError(env, 'validation_error', 'GitLab rejected the requested operation.')
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
    return gitlabError(env, 'rate_limited', 'GitLab rate limit was reached.', retryAfterMs === null
      ? {}
      : { retryDisabledUntil: Date.now() + retryAfterMs })
  }
  if (status >= 500) return gitlabError(env, 'server_error', 'GitLab reported a server error.')
  if (status >= 400) return gitlabError(env, 'validation_error', 'GitLab rejected the requested operation.')
  return gitlabError(env, 'server_error', 'GitLab returned an unsupported API status.')
}

function parseNextPage(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null
  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? page : null
}

function positivePage(value: string | number | boolean | undefined): number | null {
  const page = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(page) && page > 0 ? page : null
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function hasGitLabReason(error: unknown): boolean {
  return isRecord(error) && isRecord(error.data) && typeof error.data.reason === 'string'
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError'
}

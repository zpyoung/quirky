import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PluginContext, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import type { HostingEnv } from '../../src/env'
import { isRecord } from '../../src/data'
import { createGitLabClient, type GitLabFetch } from '../../src/gitlab/api'
import type { GitLabScope } from '../../src/gitlab/types'
import { gitlabApiBase, parseGitLabHosts, parseGitLabRemote } from '../../src/gitlab/identity'
import { invalidateGitLabToken, readGitLabToken } from '../../src/gitlab/token'

const ENV_KEYS = ['GITLAB_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST'] as const
const savedEnvironment = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
const HOST = '127.0.0.1:8123'
const SCOPE = {
  origin: { host: HOST, owner: 'group/sub', repo: 'proj' },
  repository: { host: HOST, owner: 'group/sub', repo: 'proj' },
  apiBase: `http://${HOST}/api/v4`,
  projectId: 'group%2Fsub%2Fproj'
} as unknown as GitLabScope

type RunCall = { argv: string[]; options?: RunOptions }
type RunResponder = (argv: readonly string[], options?: RunOptions) => RunResult | Promise<RunResult>

function runResult(stdoutText = '', overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: 0,
    ...overrides
  }
}

function recordingRunner(respond: RunResponder): { runner: ProcessRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  return {
    runner: {
      run: async (argv, options) => {
        calls.push({ argv: [...argv], ...(options === undefined ? {} : { options }) })
        return respond(argv, options)
      }
    },
    calls
  }
}

function hostingEnv(runner: ProcessRunner): HostingEnv {
  const context = {
    process: runner,
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
  } as unknown as PluginContext
  return { context } as unknown as HostingEnv
}

function rejectionReason(error: unknown): unknown {
  return isRecord(error) && isRecord(error.data) ? error.data.reason : undefined
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function expectRejectionReason(promise: Promise<unknown>, reason: string): Promise<unknown> {
  let failure: unknown
  try {
    await promise
  } catch (error) {
    failure = error
  }
  expect(rejectionReason(failure)).toBe(reason)
  return failure
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('GitLab remote identity', () => {
  test('parses subgroup SSH and HTTPS remotes without exposing credentials', () => {
    expect(parseGitLabRemote('git@gitlab.example.com:a/b/c/d.git')).toEqual({
      host: 'gitlab.example.com', owner: 'a/b/c', repo: 'd'
    })
    expect(parseGitLabRemote('ssh://git@gitlab.example.com:2222/a/b.git')).toEqual({
      host: 'gitlab.example.com', owner: 'a', repo: 'b'
    })
    expect(parseGitLabRemote('https://gitlab.example.com:8443/a/b/')).toEqual({
      host: 'gitlab.example.com:8443', owner: 'a', repo: 'b'
    })
    const identity = parseGitLabRemote('https://user:secret@GitLab.com/a/b.git')
    expect(identity).toEqual({ host: 'gitlab.com', owner: 'a', repo: 'b' })
    expect(JSON.stringify(identity)).not.toContain('secret')
  })

  test('rejects unsupported or unsafe remote forms', () => {
    for (const remote of [
      'https://gitlab.com/a',
      'https://gitlab.com/a/-/b',
      'https://gitlab.com/a/../b',
      'https://gitlab.com/a/.git',
      'https://gitlab.com/-a/b',
      'https://gitlab.com/a/b%2Fc',
      `https://gitlab.com/${Array.from({ length: 22 }, (_, index) => `p${index}`).join('/')}`,
      `https://gitlab.com/${'x'.repeat(256)}/b`,
      'https://gitlab.com/a/b\u0000',
      'https://gitlab.com/a/b c',
      'file:///a/b',
      `https://gitlab.com/a/${'x'.repeat(4100)}`
    ]) {
      expect(parseGitLabRemote(remote)).toBeNull()
    }
  })

  test('normalizes and bounds the configured host list', () => {
    expect(parseGitLabHosts('GitLab.Example.com, 127.0.0.1:8123  bad/host  ')).toEqual([
      'gitlab.example.com', '127.0.0.1:8123'
    ])
    expect(parseGitLabHosts('')).toEqual([])
    expect(parseGitLabHosts(Array.from({ length: 70 }, (_, index) => `host${index}.example`).join(' '))).toHaveLength(64)
    expect(parseGitLabHosts(null)).toEqual([])
  })

  test('uses HTTP only for loopback API hosts', () => {
    expect(gitlabApiBase('gitlab.example.com')).toBe('https://gitlab.example.com/api/v4')
    expect(gitlabApiBase('gitlab.example.com:8443')).toBe('https://gitlab.example.com:8443/api/v4')
    expect(gitlabApiBase('127.0.0.1:8123')).toBe('http://127.0.0.1:8123/api/v4')
    expect(gitlabApiBase('localhost:8123')).toBe('http://localhost:8123/api/v4')
    expect(gitlabApiBase('[::1]:8123')).toBe('http://[::1]:8123/api/v4')
    expect(gitlabApiBase('gitlab.local')).toBe('https://gitlab.local/api/v4')
  })
})

describe('GitLab token lookup', () => {
  test('prefers GITLAB_TOKEN and never starts glab', async () => {
    process.env.GITLAB_TOKEN = '  env-token  '
    const { runner, calls } = recordingRunner(() => runResult('glab-token'))

    await expect(readGitLabToken(runner, 'gitlab.example.com')).resolves.toEqual({
      token: 'env-token', source: 'env', glabAvailable: null
    })
    expect(calls).toEqual([])
  })

  test('reads and caches glab tokens with a bounded sanitized invocation', async () => {
    process.env.GITLAB_HOST = 'overridden.example'
    process.env.GITLAB_URI = 'https://overridden.example'
    process.env.GL_HOST = 'overridden.example'
    const { runner, calls } = recordingRunner(() => runResult('  glab-token\n'))

    const first = await readGitLabToken(runner, 'gitlab.example.com')
    const second = await readGitLabToken(runner, 'gitlab.example.com')

    expect(first).toEqual({ token: 'glab-token', source: 'glab', glabAvailable: true })
    expect(second).toEqual(first)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['glab', 'config', 'get', 'token', '--host', 'gitlab.example.com'])
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 })
    expect(calls[0]?.options?.env).toMatchObject({
      GLAB_CHECK_UPDATE: 'false',
      GLAB_SEND_TELEMETRY: 'false',
      GLAB_NO_PROMPT: 'true'
    })
    expect(calls[0]?.options?.env).not.toHaveProperty('GITLAB_HOST')
    expect(calls[0]?.options?.env).not.toHaveProperty('GITLAB_URI')
    expect(calls[0]?.options?.env).not.toHaveProperty('GL_HOST')

    invalidateGitLabToken(runner, 'gitlab.example.com')
    await readGitLabToken(runner, 'gitlab.example.com')
    expect(calls).toHaveLength(2)
  })

  test('caches an empty glab result briefly and reports a missing executable', async () => {
    const empty = recordingRunner(() => runResult('  \n'))
    await expect(readGitLabToken(empty.runner, 'gitlab.example.com')).resolves.toEqual({
      token: null, source: null, glabAvailable: true
    })
    await readGitLabToken(empty.runner, 'gitlab.example.com')
    expect(empty.calls).toHaveLength(1)

    const missing = recordingRunner(() => runResult('', { exitCode: null, spawnError: { code: 'ENOENT', message: 'not found' } }))
    await expect(readGitLabToken(missing.runner, 'gitlab.example.com')).resolves.toEqual({
      token: null, source: null, glabAvailable: false
    })
  })
})

describe('GitLab API transport', () => {
  function apiClient(fetcher: GitLabFetch, runner: ProcessRunner = recordingRunner(() => runResult()).runner, readToken?: typeof readGitLabToken) {
    return createGitLabClient(hostingEnv(runner), {
      fetch: fetcher,
      ...(readToken === undefined ? {} : { readToken })
    })
  }

  const testToken: typeof readGitLabToken = async () => ({ token: 'dummy-gitlab-token', source: 'env', glabAvailable: null })

  test('uses bearer auth, encodes query parameters, and follows no redirects', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const client = apiClient(async (input, init) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      return new Response('{"ok":true}', { status: 200 })
    }, undefined, testToken)

    await client.request(SCOPE, {
      method: 'GET', path: '/projects/group%2Fsub%2Fproj/merge_requests',
      query: { source_branch: 'feature/x', state: 'all', page: 2 }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`http://${HOST}/api/v4/projects/group%2Fsub%2Fproj/merge_requests?source_branch=feature%2Fx&state=all&page=2`)
    expect(calls[0]?.init?.redirect).toBe('manual')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer dummy-gitlab-token')
  })

  test('refuses redirects without exposing response data', async () => {
    let fetchCalls = 0
    const client = apiClient(async () => {
      fetchCalls += 1
      return new Response('dummy-gitlab-token', { status: 302, headers: { location: 'http://other.test/steal' } })
    }, undefined, testToken)

    const error = await expectRejectionReason(client.request(SCOPE, { method: 'GET', path: '/user' }), 'redirect_refused')
    expect(errorMessage(error)).not.toContain('dummy-gitlab-token')
    expect(JSON.stringify(isRecord(error) ? error.data : undefined)).not.toContain('dummy-gitlab-token')
    expect(fetchCalls).toBe(1)
  })

  test('rejects oversized and non-JSON responses safely', async () => {
    const oversized = apiClient(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index++) controller.enqueue(new Uint8Array(1024 * 1024))
        controller.close()
      }
    }), { status: 200 }), undefined, testToken)
    await expectRejectionReason(oversized.request(SCOPE, { method: 'GET', path: '/user' }), 'output_limit')

    const malformed = apiClient(async () => new Response('<html>secret response</html>', { status: 200 }), undefined, testToken)
    const error = await expectRejectionReason(malformed.request(SCOPE, { method: 'GET', path: '/user' }), 'schema_drift')
    expect(errorMessage(error)).not.toContain('secret response')
  })

  test('classifies network failures and aborted requests without echoing upstream messages', async () => {
    const network = apiClient(async () => { throw new Error('upstream secret') }, undefined, testToken)
    const networkError = await expectRejectionReason(network.request(SCOPE, { method: 'GET', path: '/user' }), 'network_error')
    expect(errorMessage(networkError)).not.toContain('upstream secret')

    const timeout = apiClient(async () => { throw new DOMException('deadline secret', 'AbortError') }, undefined, testToken)
    const timeoutError = await expectRejectionReason(timeout.request(SCOPE, { method: 'GET', path: '/user' }), 'timeout')
    expect(errorMessage(timeoutError)).not.toContain('deadline secret')
  })

  test('invalidates a cached glab token when the API returns 401', async () => {
    const runner = recordingRunner(() => runResult('glab-token'))
    const client = apiClient(async () => new Response('{"message":"dummy-gitlab-token"}', { status: 401 }), runner.runner)

    const error = await expectRejectionReason(client.request(SCOPE, { method: 'GET', path: '/user' }), 'auth_required')
    expect(errorMessage(error)).not.toContain('dummy-gitlab-token')
    expect(JSON.stringify(isRecord(error) ? error.data : undefined)).not.toContain('dummy-gitlab-token')
    await client.token(SCOPE)
    expect(runner.calls).toHaveLength(2)
  })

  test('collects paginated arrays and marks a page-limit truncation', async () => {
    let page = 0
    const client = apiClient(async () => {
      page += 1
      return new Response(JSON.stringify([page]), {
        status: 200,
        headers: page < 3 ? { 'x-next-page': String(page + 1) } : {}
      })
    }, undefined, testToken)

    await expect(client.pages(SCOPE, { method: 'GET', path: '/projects' }, 2)).resolves.toEqual({
      items: [1, 2], truncated: true
    })
    expect(page).toBe(2)
  })
})

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { RpcError, RpcErrorCode, type PluginCaller, type PluginContext } from '@quirky/protocol'
import { activate } from '../main'
import { assertHeimdallCaller, authorize, execute } from '../src/github'

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>
type Hook = (params: Record<string, unknown>, caller: PluginCaller) => unknown

type CallRecord = { method: string; params: Record<string, unknown> }
type ProcessCallRecord = { argv: string[]; cwd?: string }
type ProcessResult = {
  stdout: Uint8Array
  stdoutText: string
  stderr: string
  exitCode: number | null
  signal: string | null
  durationMs: number
}
type ProcessRun = (argv: readonly string[], options?: { cwd?: string }) => Promise<ProcessResult>
type Runtime = {
  calls: CallRecord[]
  processCalls: ProcessCallRecord[]
  logs: string[]
  methods: Map<string, Hook>
  context: PluginContext
}

function processResult(stdoutText: string, exitCode = 0): ProcessResult {
  return {
    stdout: new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: '',
    exitCode,
    signal: null,
    durationMs: 0
  }
}

function defaultProcessRun(argv: readonly string[]): ProcessResult {
  const args = argv.slice(1)
  if (args[0] === 'rev-parse' && args.includes('HEAD')) return processResult(H1)
  if (args[0] === 'rev-list' && args.includes('-n')) return processResult(`${H1} ${B1}`)
  if (args[0] === 'log' && args.includes('%B')) return processResult('')
  return processResult('')
}

const HOOK_NAMES = ['authorize', 'read', 'decide', 'execute', 'resolveOutcome', 'pace', 'stop', 'preflight'] as const
const HEIMDALL_CALLER = { role: 'plugin', pluginId: 'quirky.heimdall' } as PluginCaller
const REPOSITORY = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const REVIEW_URL = 'https://github.com/test-owner/test-repo/pull/7'
const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)

function runtimeContext(
  respond: Call = async () => undefined,
  processRun: ProcessRun = async argv => defaultProcessRun(argv)
): Runtime {
  const calls: CallRecord[] = []
  const processCalls: ProcessCallRecord[] = []
  const logs: string[] = []
  const methods = new Map<string, Hook>()
  const context = {
    provide: (id: string, handler: unknown) => {
      if (id.startsWith('method:quirky.sitter/')) methods.set(id, handler as Hook)
    },
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.worktree/resolve') {
        return { id: 'w1', path: '/tmp/quirky-sitter-hooks-worktree', kind: 'git', branch: 'feature' }
      }
      return respond(method, params)
    },
    process: {
      run: async (argv: readonly string[], options?: { cwd?: string }) => {
        processCalls.push({ argv: [...argv], ...(options?.cwd ? { cwd: options.cwd } : {}) })
        return processRun(argv, options)
      }
    },
    error: (_kind: string, message: string) => new RpcError(RpcErrorCode.InvalidParams, message),
    log: (message: string) => logs.push(message)
  } as unknown as PluginContext
  return { calls, processCalls, logs, methods, context }
}

async function startRuntime(
  respond: Call = async () => undefined,
  processRun: ProcessRun = async argv => defaultProcessRun(argv)
): Promise<Runtime> {
  const runtime = runtimeContext(respond, processRun)
  await activate(runtime.context)
  runtime.calls.length = 0
  runtime.processCalls.length = 0
  return runtime
}


function githubReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: REVIEW_URL,
    state: 'open',
    headRefName: 'feature',
    repository: { ...REPOSITORY },
    headRefOid: H1,
    baseRefOid: B1,
    draft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    ...overrides
  }
}

function foundReview(review = githubReview()): Record<string, unknown> {
  return { kind: 'found', review, fetchedAt: 1 }
}

function enrollmentInput(worktree = 'id:w1'): Record<string, unknown> {
  return {
    kind: 'hosted-review',
    kindPayload: {
      worktree,
      branchUpdateMode: 'merge-base-update',
      mergeMethod: null,
      reviewNumber: 99,
      reviewUrl: 'https://evil.test'
    },
    capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' }
  }
}

function storedPayload(): Record<string, unknown> {
  return {
    worktreeId: 'w1',
    branch: 'feature',
    headRefName: 'feature',
    provider: 'github',
    reviewNumber: 7,
    reviewUrl: REVIEW_URL,
    repository: { ...REPOSITORY },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope: 'all'
  }
}

function enrollment(): Record<string, unknown> {
  return {
    kindPayload: storedPayload(),
    capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'on' }
  }
}

function sitterWorld(): Record<string, unknown> {
  return {
    reviewNumber: 7,
    reviewUrl: REVIEW_URL,
    lifecycle: 'open',
    draft: false,
    headSha: H1,
    baseSha: B1,
    headRefName: 'feature',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    defaultMergeMethod: 'squash',
    allowedMergeMethods: ['squash', 'merge', 'rebase'],
    checksComplete: true,
    checks: []
  }
}

function snapshot(): Record<string, unknown> {
  return { freshness: 'live', contentIdentity: JSON.stringify([H1, B1]), observedAtMs: 1, world: sitterWorld() }
}
async function observeChecks(checkRows: unknown[], detailResponse?: unknown): Promise<{ runtime: Runtime; current: Record<string, unknown> }> {
  const runtime = await startRuntime(async method => {
    if (method === 'quirky.hosting/review') return foundReview()
    if (method === 'quirky.hosting/checks') {
      return { number: 7, headSha: H1, checks: checkRows, partial: false, partialFailures: [] }
    }
    if (method === 'quirky.hosting/checkDetails') {
      if (detailResponse instanceof Error) throw detailResponse
      return detailResponse
    }
    throw new Error(`unexpected call: ${method}`)
  })
  const current = await runtime.methods.get('method:quirky.sitter/read')!(
    { enrollment: enrollment(), options: { fresh: false } },
    HEIMDALL_CALLER
  ) as Record<string, unknown>
  return { runtime, current }
}
test('read signs normalized check-run details and bounds the failure excerpt', async () => {
  const check = { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 9001, workflowRunId: 41 }
  const timestamp1 = '2026-11-14T11:12:13Z'
  const timestamp2 = '2026-11-15T20:21:22Z'
  const sha1 = 'a'.repeat(40)
  const sha2 = 'c'.repeat(64)
  const uuid1 = '550e8400-e29b-41d4-a716-446655440000'
  const uuid2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const details = (timestamp: string, sha: string, uuid: string, message = 'module not found') => ({
    annotations: [{
      title: `Build failure ${uuid}`,
      message: `\u001b[31m${timestamp} commit ${sha} ${uuid}: ${message}\u001b[0m`,
      rawDetails: `raw evidence ${timestamp} ${sha} ${uuid}: ${message}`
    }],
    logTails: [{ jobId: 301, jobName: 'build', tail: `${timestamp} ${sha} ${uuid}: log output: ${message} in dependency graph` }]
  })

  const first = await observeChecks([check], details(timestamp1, sha1, uuid1))
  const second = await observeChecks([{ ...check, checkRunId: 9002, workflowRunId: 42 }], details(timestamp2, sha2, uuid2))
  const firstCheck = (first.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>
  const secondCheck = (second.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>
  expect(firstCheck[0].failureSignature).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(firstCheck[0].failureSignature).toBe(secondCheck[0].failureSignature)
  expect(first.runtime.calls.find(call => call.method === 'quirky.hosting/checkDetails')?.params).toMatchObject({
    worktree: 'w1',
    number: 7,
    prRepo: REPOSITORY,
    checkRunId: 9001,
    workflowRunId: 41
  })
  const excerpt = firstCheck[0].failureExcerpt
  expect(excerpt).toContain('Build failure')
  expect(excerpt).toContain('module not found')
  expect(excerpt).toContain('raw evidence')
  expect(excerpt).toContain('log output')
  expect(excerpt).not.toContain(timestamp1)
  expect(excerpt).not.toContain(sha1)
  expect(excerpt).not.toContain(uuid1)

  const changed = await observeChecks([check], details(timestamp2, sha2, uuid2, 'permission denied'))
  const changedCheck = ((changed.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
  expect(changedCheck.failureSignature).not.toBe(firstCheck[0].failureSignature)

  const logLines = Array.from({ length: 420 }, (_, index) => `line-${index + 1} ${'x'.repeat(128)}`)
  const longDetails = (lines: string[]) => ({ annotations: [], logTails: [{ jobId: 301, jobName: 'build', tail: lines.join('\n') }] })
  const longFirst = await observeChecks([check], longDetails(logLines))
  const priorOnly = [...logLines]
  priorOnly[0] = 'different-early-line'
  const longSecond = await observeChecks([check], longDetails(priorOnly))
  const longChanged = [...logLines]
  longChanged[419] = 'meaningful failure changed'
  const longThird = await observeChecks([check], longDetails(longChanged))
  const longCheck1 = ((longFirst.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
  const longCheck2 = ((longSecond.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
  const longCheck3 = ((longThird.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
  expect(longCheck1.failureSignature).toBe(longCheck2.failureSignature)
  expect(longCheck1.failureSignature).not.toBe(longCheck3.failureSignature)
  expect(new TextEncoder().encode(longCheck1.failureExcerpt as string).byteLength).toBeLessThanOrEqual(32 * 1024)
  expect((longCheck1.failureExcerpt as string).split(/\r?\n/).filter(line => line.trim().length > 0).length).toBeLessThanOrEqual(400)
  expect(longCheck1.failureExcerpt).not.toMatch(/(^|\n)line-1 /)
})

test('read marks empty or unreadable check details as unverifiable', async () => {
  const check = { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 9001, workflowRunId: 41 }
  for (const details of [
    { annotations: [], logTails: [], partialFailures: [] },
    new Error('check details unavailable')
  ]) {
    const observed = await observeChecks([check], details)
    const result = ((observed.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
    expect(result.failureSignature).toBeNull()
    expect(result.failureExcerpt).toBeNull()
  }
})

test('read signs legacy status failures from their status observation', async () => {
  const observed = await observeChecks([{
    kind: 'status',
    name: 'lint',
    status: 'failure',
    conclusion: '',
    checkRunId: null,
    workflowRunId: null
  }])
  const status = ((observed.current.world as Record<string, unknown>).checks as Array<Record<string, unknown>>)[0]
  const key = JSON.stringify(['status', 'lint'])
  const text = `failure\u0000\u0000${String(status.observation)}`
  const expected = `sha256:${createHash('sha256').update(`${key}\u0000${text}`).digest('hex')}`
  expect(status.failureSignature).toBe(expected)
  expect(status.failureExcerpt).toBe(status.observation)
  expect(observed.runtime.calls.some(call => call.method === 'quirky.hosting/checkDetails')).toBe(false)
})

function methodParams(): Record<(typeof HOOK_NAMES)[number], Record<string, unknown>> {
  const enrolled = enrollment()
  const current = snapshot()
  return {
    authorize: { input: enrollmentInput() },
    read: { enrollment: enrolled, options: { fresh: false } },
    decide: { snapshot: current, journal: [], enrollment: enrolled },
    execute: { action: { kind: 'unknown' }, enrollment: enrolled },
    resolveOutcome: { attempt: { action: { kind: 'unknown' } }, snapshot: current },
    pace: { snapshot: current, journal: [] },
    stop: { snapshot: current, journal: [], enrollment: enrolled },
    preflight: { action: { kind: 'merge' }, snapshot: current, journal: [], enrollment: enrolled }
  }
}

function authorizationCalls(
  directory: string,
  input: Record<string, unknown>,
  overrides: { worktree?: unknown; lookup?: unknown; uiState?: unknown; windowState?: unknown } = {}
): { calls: CallRecord[]; result: Promise<unknown> } {
  const calls: CallRecord[] = []
  const call: Call = async (method, params) => {
    calls.push({ method, params })
    if (method === 'quirky.worktree/resolve') {
      return Object.hasOwn(overrides, 'worktree')
        ? overrides.worktree
        : { id: 'w1', repoId: 'r1', path: directory, branch: 'feature', kind: 'git' }
    }
    if (method === 'quirky.hosting/forBranch') {
      return Object.hasOwn(overrides, 'lookup') ? overrides.lookup : foundReview()
    }
    if (method === 'ui.state') {
      if (overrides.uiState instanceof Error) throw overrides.uiState
      return Object.hasOwn(overrides, 'uiState') ? overrides.uiState : { windows: [{ connId: 4 }] }
    }
    if (method === 'ui.window.state') {
      if (overrides.windowState instanceof Error) throw overrides.windowState
      return Object.hasOwn(overrides, 'windowState')
        ? overrides.windowState
        : { connId: 4, layout: { view: null, worktree: 'w1' } }
    }
    throw new Error(`unexpected call: ${method}`)
  }
  return { calls, result: authorize(call, input as never) }
}

function directCall(respond: Call): { calls: CallRecord[]; call: Call } {
  const calls: CallRecord[] = []
  const call: Call = async (method, params) => {
    calls.push({ method, params })
    return respond(method, params)
  }
  return { calls, call }
}

function action(kind: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    capability: kind === 'merge' ? 'merge' : kind === 'update-branch' ? 'updateBranch' : 'fixChecks',
    visibility: 'external',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: 'evidence',
    expectedState: { target: REVIEW_URL, before: H1 },
    head: H1,
    ...fields
  }
}

function failure(message: string, reason?: string): Error {
  const error = new Error(message) as Error & { data?: { reason: string } }
  if (reason !== undefined) error.data = { reason }
  return error
}

test('every hook refuses a caller other than quirky.heimdall', async () => {
  const runtime = await startRuntime()
  expect([...runtime.methods.keys()].sort()).toEqual(HOOK_NAMES.map(name => `method:quirky.sitter/${name}`).sort())
  const callers = [
    { role: 'cli' },
    { role: 'ui' },
    { role: 'plugin', pluginId: 'quirky.reviews' }
  ] as unknown as PluginCaller[]
  const message = 'quirky.sitter hooks accept only quirky.heimdall as the caller'
  for (const name of HOOK_NAMES) {
    const hook = runtime.methods.get(`method:quirky.sitter/${name}`)!
    for (const caller of callers) {
      await expect(Promise.resolve().then(() => hook({}, caller))).rejects.toMatchObject({ code: -32602, message })
      expect(runtime.calls).toEqual([])
    }
  }
  expect(() => assertHeimdallCaller(HEIMDALL_CALLER)).not.toThrow()
  for (const name of HOOK_NAMES) {
    const hook = runtime.methods.get(`method:quirky.sitter/${name}`)!
    try {
      await hook(methodParams()[name], HEIMDALL_CALLER)
    } catch (error) {
      expect(error).not.toMatchObject({ code: -32602, message })
    }
  }
})

test("authorization takes the pull request's identity from GitHub and refuses what this slice can't run", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-sitter-hooks-'))
  try {
    const realPath = realpathSync(directory)
    const valid = authorizationCalls(directory, enrollmentInput())
    const result = await valid.result as Record<string, unknown>
    expect(result).toMatchObject({
      workspaceKey: `local::${realPath}`,
      workspacePath: realPath,
      executionHostId: 'local',
      schedulerOwner: 'daemon',
      repoId: 'r1',
      worktreeId: 'w1',
      kindPayload: {
        worktreeId: 'w1',
        branch: 'feature',
        headRefName: 'feature',
        provider: 'github',
        reviewNumber: 7,
        reviewUrl: REVIEW_URL,
        repository: REPOSITORY,
        branchUpdateMode: 'merge-base-update',
        mergeMethod: null,
        mergeCheckScope: 'all'
      }
    })
    expect(valid.calls.find(call => call.method === 'quirky.hosting/forBranch')?.params).toEqual({ worktree: 'w1', branch: 'feature', fresh: true })

    const invalidInputs: Array<[Record<string, unknown>, string]> = []
    const missingCapability = enrollmentInput()
    delete (missingCapability.capabilities as Record<string, unknown>).merge
    invalidInputs.push([missingCapability, 'The PR sitter needs exactly the capabilities updateBranch, resolveConflicts, fixChecks and merge.'])
    const extraCapability = enrollmentInput()
    ;(extraCapability.capabilities as Record<string, unknown>).extra = 'off'
    invalidInputs.push([extraCapability, 'The PR sitter needs exactly the capabilities updateBranch, resolveConflicts, fixChecks and merge.'])
    invalidInputs.push([{ ...enrollmentInput(), owner: { agent: 'claude' } }, 'The PR sitter does not accept an owner agent.'])
    invalidInputs.push([{ ...enrollmentInput(), ownerInterventionCapability: 'gated' }, 'The PR sitter does not accept owner interventions.'])
    const rebase = enrollmentInput()
    ;(rebase.kindPayload as Record<string, unknown>).branchUpdateMode = 'rebase'
    invalidInputs.push([rebase, 'The PR sitter updates a branch by merging its base; rebase is not supported.'])
    const required = enrollmentInput()
    ;(required.kindPayload as Record<string, unknown>).mergeCheckScope = 'required'
    invalidInputs.push([required, 'The PR sitter supports only the all-checks merge scope.'])
    const invalidMethod = enrollmentInput()
    ;(invalidMethod.kindPayload as Record<string, unknown>).mergeMethod = 'fast-forward'
    invalidInputs.push([invalidMethod, 'mergeMethod must be null, merge, squash or rebase.'])
    const noWorktree = enrollmentInput()
    delete (noWorktree.kindPayload as Record<string, unknown>).worktree
    invalidInputs.push([noWorktree, 'kindPayload.worktree must name a worktree.'])
    for (const [input, message] of invalidInputs) {
      const attempt = authorizationCalls(directory, input)
      await expect(attempt.result).rejects.toMatchObject({ message })
      expect(attempt.calls.some(call => call.method === 'quirky.hosting/forBranch')).toBe(false)
    }

    for (const [worktree, message] of [
      [{ id: 'w1', repoId: 'r1', path: directory, branch: null, kind: 'git' }, 'Check out a branch in the worktree before arming the PR sitter.'],
      [{ id: 'w1', repoId: 'r1', path: directory, branch: 'feature', kind: 'folder' }, 'The PR sitter needs a git worktree.']
    ] as Array<[Record<string, unknown>, string]>) {
      const attempt = authorizationCalls(directory, enrollmentInput(), { worktree })
      await expect(attempt.result).rejects.toMatchObject({ message })
      expect(attempt.calls.some(call => call.method === 'quirky.hosting/forBranch')).toBe(false)
    }

    const activeSuccess = authorizationCalls(directory, enrollmentInput('active'))
    await activeSuccess.result
    expect(activeSuccess.calls.find(call => call.method === 'ui.window.state')?.params).toEqual({ connId: 4 })
    expect(activeSuccess.calls.find(call => call.method === 'quirky.worktree/resolve')?.params).toEqual({ selector: 'id:w1' })
    expect(activeSuccess.calls.find(call => call.method === 'quirky.hosting/forBranch')?.params).toEqual({ worktree: 'w1', branch: 'feature', fresh: true })

    const activeFailures: Array<[unknown, string, boolean?]> = [
      [{ windows: [] }, 'worktree-unresolved: no Quirky window is connected, so there is no active worktree; pass --worktree id:<id>.'],
      [{ windows: [{ connId: 4 }, { connId: 5 }] }, 'worktree-unresolved: 2 Quirky windows are connected, so the active worktree is ambiguous; pass --worktree id:<id>.', false],
      [{ windows: [{ connId: 4 }] }, 'worktree-unresolved: the connected window has no selected worktree; pass --worktree id:<id>.'],
      [{ windows: [{ connId: 4 }] }, 'worktree-unresolved: the connected window has no selected worktree; pass --worktree id:<id>.'],
      [new Error('m'), 'worktree-unresolved: window state is unavailable (m); pass --worktree id:<id>.'],
      [{ windows: [{ connId: 0 }] }, 'worktree-unresolved: window state is unavailable (bad window list); pass --worktree id:<id>.']
    ]
    for (let index = 0; index < activeFailures.length; index++) {
      const [uiState, message, shouldReadWindow] = activeFailures[index]
      const windowState = index === 2 ? { connId: 4, layout: { view: null } } : index === 3 ? { connId: 4, layout: { view: null, worktree: null } } : undefined
      const attempt = authorizationCalls(directory, enrollmentInput('active'), { uiState, ...(windowState ? { windowState } : {}) })
      await expect(attempt.result).rejects.toMatchObject({ message })
      expect(attempt.calls.some(call => call.method === 'quirky.worktree/resolve' || call.method === 'quirky.hosting/forBranch')).toBe(false)
      if (shouldReadWindow === false) expect(attempt.calls.some(call => call.method === 'ui.window.state')).toBe(false)
    }

    for (const selector of ['id:w1', 'branch:feature', 'current']) {
      const attempt = authorizationCalls(directory, enrollmentInput(selector))
      await attempt.result
      expect(attempt.calls.some(call => call.method === 'ui.state')).toBe(false)
      expect(attempt.calls.find(call => call.method === 'quirky.worktree/resolve')?.params).toEqual({ selector })
    }
    for (const [lookup, message] of [
      [{ kind: 'no-review' }, 'No open pull request exists for branch feature.'],
      [{ kind: 'unavailable', message: 'm' }, 'Pull request lookup is unavailable: m'],
      [foundReview(githubReview({ state: 'closed' })), 'Only an open pull request can be enrolled; #7 is closed.']
    ] as Array<[unknown, string]>) {
      const attempt = authorizationCalls(directory, enrollmentInput(), { lookup })
      await expect(attempt.result).rejects.toMatchObject({ message })
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reads are live and pinned to the enrolled pull request', async () => {
  const enrolled = enrollment()
  const runtime = await startRuntime(async method => {
    if (method === 'quirky.hosting/review') return foundReview()
    if (method === 'quirky.hosting/checks') return { number: 7, headSha: H1, checks: [], partial: false, partialFailures: [] }
    throw new Error(`unexpected call: ${method}`)
  })
  const read = runtime.methods.get('method:quirky.sitter/read')!
  const current = await read({ enrollment: enrolled, options: { fresh: false } }, HEIMDALL_CALLER) as Record<string, unknown>
  expect(runtime.calls.filter(call => call.method.startsWith('quirky.hosting/'))).toEqual([
    { method: 'quirky.hosting/review', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY } },
    { method: 'quirky.hosting/checks', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY, noCache: true } }
  ])
  expect(runtime.calls.find(call => call.method === 'quirky.worktree/resolve')?.params).toEqual({ selector: 'id:w1' })
  expect(runtime.processCalls.some(call => call.argv[0] === 'git' && call.cwd === '/tmp/quirky-sitter-hooks-worktree')).toBe(true)
  expect(current.freshness).toBe('live')
  expect(current.contentIdentity).toBe(JSON.stringify([H1, B1]))
  const world = current.world as Record<string, unknown>
  expect(world.localHeadSha).toBe(H1)
  expect(world.localDirty).toBe(false)
  expect(world.localPrepared).toMatchObject({ sha: H1, dirty: false, attemptTrailer: null })

  const mergedRuntime = await startRuntime(async method => {
    if (method === 'quirky.hosting/review') return foundReview(githubReview({ state: 'merged' }))
    throw new Error(`unexpected call: ${method}`)
  })
  const merged = await mergedRuntime.methods.get('method:quirky.sitter/read')!(
    { enrollment: enrolled, options: { fresh: false } },
    HEIMDALL_CALLER
  ) as Record<string, unknown>
  expect(mergedRuntime.calls.filter(call => call.method.startsWith('quirky.hosting/')).map(call => call.method)).toEqual(['quirky.hosting/review'])
  expect(mergedRuntime.calls.some(call => call.method === 'quirky.hosting/checks' || call.method === 'quirky.hosting/checkDetails')).toBe(false)
  expect((merged.world as Record<string, unknown>).checks).toEqual([])
  expect((merged.world as Record<string, unknown>).checksComplete).toBe(true)

  const identityChanges = [
    githubReview({ number: 8 }),
    githubReview({ url: 'https://github.com/test-owner/test-repo/pull/8' }),
    githubReview({ headRefName: 'other-branch' }),
    githubReview({ repository: { ...REPOSITORY, repo: 'other-repo' } })
  ]
  for (const changedReview of identityChanges) {
    const changedRuntime = await startRuntime(async method => {
      if (method === 'quirky.hosting/review') return foundReview(changedReview)
      throw new Error(`unexpected call: ${method}`)
    })
    await expect(Promise.resolve().then(() => changedRuntime.methods.get('method:quirky.sitter/read')!({ enrollment: enrolled }, HEIMDALL_CALLER)))
      .rejects.toMatchObject({ message: 'Pull request identity changed: expected test-owner/test-repo#7 on feature.' })
    expect(changedRuntime.calls.map(call => call.method)).toEqual(['quirky.hosting/review'])
  }

  for (const [lookup, message] of [
    [{ kind: 'no-review' }, 'Pull request #7 is no longer visible in test-owner/test-repo.'],
    [{ kind: 'unavailable', message: 'm' }, 'm']
  ] as Array<[unknown, string]>) {
    const unavailableRuntime = await startRuntime(async method => {
      if (method === 'quirky.hosting/review') return lookup
      throw new Error(`unexpected call: ${method}`)
    })
    await expect(Promise.resolve().then(() => unavailableRuntime.methods.get('method:quirky.sitter/read')!({ enrollment: enrolled }, HEIMDALL_CALLER)))
      .rejects.toMatchObject({ message })
  }
})

test('executors call quirky.hosting once and classify every failure', async () => {
  const enrolled = enrollment()
  const merge = action('merge', { method: 'squash' })
  const mergeRun = directCall(async () => ({ state: 'merged', number: 7, head: H1 }))
  await expect(execute(mergeRun.call, merge as never, enrolled as never, async () => undefined)).resolves.toEqual({ effect: 'landed' })
  expect(mergeRun.calls).toEqual([{
    method: 'quirky.hosting/merge',
    params: { worktree: 'w1', number: 7, prRepo: REPOSITORY, expectedHead: H1, method: 'squash', action: 'direct', yes: true }
  }])

  for (const [state, reason] of [['enqueued', 'merge enqueued'], ['pending', 'pending']]) {
    const run = directCall(async () => ({ state, number: 7, head: H1 }))
    await expect(execute(run.call, merge as never, enrolled as never, async () => undefined))
      .resolves.toEqual({ effect: 'indeterminate', reason })
    expect(run.calls).toHaveLength(1)
  }

  const update = action('update-branch', { base: B1 })
  const updateCalls = directCall(async method => {
    if (method === 'quirky.hosting/updateBranch') return { state: 'requested', number: 7, head: H1 }
    if (method === 'quirky.hosting/review') return foundReview(githubReview({ headRefOid: H2 }))
    throw new Error(`unexpected call: ${method}`)
  })
  const updateSleeps: number[] = []
  await expect(execute(updateCalls.call, update as never, enrolled as never, async ms => { updateSleeps.push(ms) }))
    .resolves.toEqual({ effect: 'landed', expectedAfter: { head: H2 } })
  expect(updateCalls.calls).toEqual([
    { method: 'quirky.hosting/updateBranch', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY, expectedHead: H1 } },
    { method: 'quirky.hosting/review', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY } }
  ])
  expect(updateSleeps).toEqual([])

  let unchangedReads = 0
  const unchanged = directCall(async method => {
    if (method === 'quirky.hosting/updateBranch') return { state: 'requested', number: 7, head: H1 }
    if (method === 'quirky.hosting/review') {
      unchangedReads++
      return foundReview()
    }
    throw new Error(`unexpected call: ${method}`)
  })
  const pollSleeps: number[] = []
  await expect(execute(unchanged.call, update as never, enrolled as never, async ms => { pollSleeps.push(ms) }))
    .resolves.toEqual({ effect: 'indeterminate', reason: 'update-branch requested; head unchanged after polling' })
  expect(unchangedReads).toBe(10)
  expect(unchanged.calls.filter(call => call.method === 'quirky.hosting/updateBranch')).toHaveLength(1)
  expect(pollSleeps).toEqual(Array(9).fill(1000))

  const rerun = action('rerun-check', { observations: ['check_run:9001:41:completed:failure'], checkNames: ['build'] })
  const movedHead = directCall(async () => foundReview(githubReview({ headRefOid: H2 })))
  await expect(execute(movedHead.call, rerun as never, enrolled as never, async () => undefined))
    .resolves.toEqual({ effect: 'not-landed', reason: 'expected-state-mismatch: head moved' })
  expect(movedHead.calls.map(call => call.method)).toEqual(['quirky.hosting/review'])

  const rerunCalls = directCall(async method => {
    if (method === 'quirky.hosting/review') return foundReview()
    if (method === 'quirky.hosting/rerunChecks') return { started: 2, targetCount: 3 }
    throw new Error(`unexpected call: ${method}`)
  })
  await expect(execute(rerunCalls.call, rerun as never, enrolled as never, async () => undefined))
    .resolves.toEqual({ effect: 'landed', expectedAfter: { started: 2, targetCount: 3 } })
  expect(rerunCalls.calls).toEqual([
    { method: 'quirky.hosting/review', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY } },
    { method: 'quirky.hosting/rerunChecks', params: { worktree: 'w1', number: 7, prRepo: REPOSITORY, failedOnly: true } }
  ])

  for (const error of [
    failure('completion unknown', 'unknown_completion'),
    failure('some jobs failed', 'partial_failure'),
    failure('untyped failure'),
    failure('head moved', 'head_changed')
  ]) {
    const failed = directCall(async () => { throw error })
    const result = await execute(failed.call, merge as never, enrolled as never, async () => undefined)
    if (error.message === 'head moved') {
      expect(result).toEqual({ effect: 'not-landed', reason: 'head_changed: head moved' })
    } else {
      expect(result).toEqual({ effect: 'indeterminate', reason: error.message })
    }
    expect(failed.calls).toHaveLength(1)
  }

  const unsupported = directCall(async () => { throw new Error('must not call') })
  await expect(execute(unsupported.call, action('unknown') as never, enrolled as never, async () => undefined))
    .resolves.toEqual({ effect: 'not-landed', reason: 'unsupported-action' })
  expect(unsupported.calls).toEqual([])
})
test('rerun-check preflight reports unsuccessful lookups instead of a moved head', async () => {
  const enrolled = enrollment()
  const rerun = action('rerun-check', { observations: ['check_run:9001:41:completed:failure'], checkNames: ['build'] })
  const lookups = [
    {
      lookup: { kind: 'no-review' },
      reason: 'no-review: Pull request #7 is no longer visible in test-owner/test-repo.'
    },
    {
      lookup: { kind: 'unavailable', reason: 'auth_required', message: 'GitHub login required' },
      reason: 'auth_required: GitHub login required'
    },
    {
      lookup: { kind: 'unknown' },
      reason: 'lookup-unavailable: Pull request lookup is unavailable.'
    },
    {
      lookup: { kind: 'found', review: githubReview({ headRefOid: undefined }) },
      reason: 'lookup-unavailable: Pull request lookup is unavailable.'
    }
  ]

  for (const { lookup, reason } of lookups) {
    const run = directCall(async method => {
      if (method === 'quirky.hosting/review') return lookup
      throw new Error(`unexpected call: ${method}`)
    })
    await expect(execute(run.call, rerun as never, enrolled as never, async () => undefined))
      .resolves.toEqual({ effect: 'not-landed', reason })
    expect(run.calls.map(call => call.method)).toEqual(['quirky.hosting/review'])
  }


  const movedHead = directCall(async () => foundReview(githubReview({ headRefOid: H2 })))
  await expect(execute(movedHead.call, rerun as never, enrolled as never, async () => undefined))
    .resolves.toEqual({ effect: 'not-landed', reason: 'expected-state-mismatch: head moved' })
  expect(movedHead.calls.map(call => call.method)).toEqual(['quirky.hosting/review'])
})

test('update-branch polling failures are indeterminate after the request is accepted', async () => {
  const enrolled = enrollment()
  const update = action('update-branch', { base: B1 })

  for (const reason of ['head_changed', 'auth_required']) {
    const requestError = failure(`${reason} rejected update`, reason)
    const rejected = directCall(async () => { throw requestError })
    await expect(execute(rejected.call, update as never, enrolled as never, async () => undefined))
      .resolves.toEqual({ effect: 'not-landed', reason: `${reason}: ${requestError.message}` })
    expect(rejected.calls.map(call => call.method)).toEqual(['quirky.hosting/updateBranch'])

    const pollError = failure(`${reason} while polling`, reason)
    const accepted = directCall(async method => {
      if (method === 'quirky.hosting/updateBranch') return { state: 'requested' }
      throw pollError
    })
    const sleeps: number[] = []
    await expect(execute(accepted.call, update as never, enrolled as never, async ms => { sleeps.push(ms) }))
      .resolves.toEqual({ effect: 'indeterminate', reason: pollError.message })
    expect(accepted.calls.map(call => call.method)).toEqual([
      'quirky.hosting/updateBranch',
      'quirky.hosting/review'
    ])
    expect(sleeps).toEqual([])
  }
})


test('activation keeps the plugin up when Heimdall refuses the kind', async () => {
  const failed = runtimeContext(async method => {
    if (method === 'quirky.heimdall/registerKind') throw new Error('Heimdall storage is read-only')
    return undefined
  })
  await expect(activate(failed.context)).resolves.toBeUndefined()
  expect([...failed.methods.keys()].sort()).toEqual(HOOK_NAMES.map(name => `method:quirky.sitter/${name}`).sort())
  expect(failed.logs).toEqual(['hosted-review kind was not registered: Heimdall storage is read-only'])

  const registered = runtimeContext()
  await activate(registered.context)
  expect(registered.calls).toHaveLength(1)
  expect(registered.calls[0].method).toBe('quirky.heimdall/registerKind')
  const registration = registered.calls[0].params
  expect(registration.id).toBe('hosted-review')
  expect(registration.enrollmentPayloadSchema).toMatchObject({ properties: { agent: { type: 'string' } } })
  expect(registration.hooks).toEqual(Object.fromEntries(HOOK_NAMES.map(name => [name, `quirky.sitter/${name}`])))
  expect(registered.logs).toEqual([])
})

test('authorization keeps an explicit enabled-agent preference and rejects empty preferences', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-sitter-agent-'))
  try {
    const input = enrollmentInput()
    ;(input.kindPayload as Record<string, unknown>).agent = 'claude'
    await expect(authorizationCalls(directory, input).result).resolves.toMatchObject({ kindPayload: { agent: 'claude' } })
    for (const agent of ['', '   ', 42, null]) {
      ;(input.kindPayload as Record<string, unknown>).agent = agent
      await expect(authorizationCalls(directory, input).result).rejects.toThrow('agent')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('prepare execution dispatches a worker prompt with Heimdall’s actual attempt fingerprint', async () => {
  const fingerprint = 'actual-fingerprint-47'
  const enrolled = enrollment()
  ;(enrolled.kindPayload as Record<string, unknown>).agent = 'claude'
  const runtime = await startRuntime(async method => {
    if (method === 'quirky.agents/pick') return { agent: 'claude' }
    throw new Error(`unexpected call: ${method}`)
  })
  const prepare = action('prepare-fix', {
    capabilityKey: 'fixChecks',
    visibility: 'local',
    expectedHeadSha: H1,
    failedChecks: [{
      key: JSON.stringify(['check_run', 'build']),
      name: 'build',
      failureSignature: `sha256:${'a'.repeat(64)}`,
      failureExcerpt: 'module not found'
    }]
  })
  const result = await runtime.methods.get('method:quirky.sitter/execute')!({
    action: prepare,
    enrollment: enrolled,
    attemptId: 'attempt-47',
    fingerprint
  }, HEIMDALL_CALLER) as Record<string, unknown>
  const worker = result.worker as Record<string, unknown>
  expect(worker).toMatchObject({ worktree: 'id:w1', agent: 'claude', mode: 'structured' })
  expect(worker.spec).toContain(`Orca-Heimdall-Attempt: ${fingerprint}`)
  expect(runtime.calls.find(call => call.method === 'quirky.agents/pick')?.params).toEqual({
    forAgentTab: true,
    preferred: 'claude'
  })
})

test('publish execution routes a verified prepared commit through the review push target', async () => {
  const prepareFingerprint = 'prepare-fingerprint-82'
  const runtime = await startRuntime(async method => {
    if (method === 'quirky.git/pushTarget') return { ready: true, headOid: H1 }
    if (method === 'quirky.git/forcePush') return { pushed: true }
    throw new Error(`unexpected call: ${method}`)
  }, async argv => {
    const args = argv.slice(1)
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return processResult(H2)
    if (args[0] === 'rev-list') return processResult(`${H2} ${H1}`)
    if (args[0] === 'log' || args[0] === 'show') return processResult(`fix the checks\n\nOrca-Heimdall-Attempt: ${prepareFingerprint}`)
    return processResult('')
  })
  const publish = action('publish-fix', {
    capabilityKey: 'fixChecks',
    preparedCommitSha: H2,
    expectedHeadSha: H1,
    prepareFingerprint
  })
  const result = await runtime.methods.get('method:quirky.sitter/execute')!({
    action: publish,
    enrollment: enrollment(),
    attemptId: 'attempt-83',
    fingerprint: 'publish-fingerprint-83'
  }, HEIMDALL_CALLER)
  expect(result).toEqual({ effect: 'landed' })
  expect(runtime.calls.find(call => call.method === 'quirky.git/pushTarget')?.params).toEqual({
    worktree: 'id:w1',
    purpose: 'review'
  })
  expect(runtime.calls.find(call => call.method === 'quirky.git/forcePush')?.params).toEqual({
    worktree: 'id:w1',
    purpose: 'review',
    expected: H1,
    expectedLocalHead: H2,
    yes: true
  })
})

test('preflight holds prepare and publish actions for terminal and foreground-agent contention', async () => {
  const enrolled = enrollment()
  const actions = [
    action('prepare-fix', { expectedHeadSha: H1 }),
    action('publish-fix', { expectedHeadSha: H1, preparedCommitSha: H2, prepareFingerprint: 'prepare-fingerprint' })
  ]
  for (const currentAction of actions) {
    for (const [method, response] of [
      ['quirky.terminal/sessions', { sessions: [{ sessionId: 'shell-1', state: 'running', alive: true, worktreeId: 'w1' }] }],
      ['quirky.agent-status/list', [{ state: 'blocked', worktreeId: 'w1' }]]
    ] as Array<[string, unknown]>) {
      const runtime = await startRuntime(async current => {
        if (current === method) return response
        if (current === 'quirky.terminal/sessions') return { sessions: [] }
        if (current === 'quirky.agent-status/list') return []
        throw new Error(`unexpected call: ${current}`)
      })
      const verdict = await runtime.methods.get('method:quirky.sitter/preflight')!({
        action: currentAction,
        snapshot: snapshot(),
        journal: [],
        enrollment: enrolled
      }, HEIMDALL_CALLER)
      expect(verdict).toMatchObject({ verdict: 'hold', reason: 'worktree-busy' })
      expect(runtime.calls.some(call => call.method === method)).toBe(true)
    }
  }
})
test('manifest declares all runtime dependencies and a read-only preflight hook', () => {
  const manifest = JSON.parse(readFileSync(new URL('../quirky-plugin.json', import.meta.url), 'utf8')) as {
    dependencies: string[]
    contributes: { method: Array<Record<string, unknown>> }
  }
  expect(manifest.dependencies).toEqual([
    'quirky.heimdall',
    'quirky.hosting',
    'quirky.git',
    'quirky.worktree',
    'quirky.agents',
    'quirky.terminal',
    'quirky.agent-status'
  ])
  expect(manifest.contributes.method.find(method => method.id === 'preflight')).toMatchObject({
    readOnly: true,
    params: { type: 'object' },
    result: { type: 'object' }
  })
})

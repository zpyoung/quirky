import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import type { PluginContext, RunOptions, RunResult, StoreMigration } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createObjectiveStore } from '../src/store'
import type { CheckRecord, LandingRecord, ObjectiveStore, VerdictRecord } from '../src/store'
import type { ObjectiveAction, ObjectiveJournalEntry, ObjectiveWorld } from '../src/decide'
import { nextStep, stopObjective } from '../src/decide'
import { createObjectiveHooks } from '../src/hooks'
import { captureContentIdentity } from '../src/checks'
import { remoteActionEvidenceKey, sameRemoteAuthority } from '../src/contract'
import type { ObjectivePayload, ExpectedReview as ObjectiveExpectedReview, RemoteLandingAuthority, RemoteObservation } from '../src/contract'
import { executeRemoteLanding, observeRemoteLanding, resolveRemoteLandingOutcome } from '../src/remote-landing'
import type { ObjectiveRuntime } from '../src/checks'
import { authorize, execute, preflight } from '../../quirky.sitter/src/github'
import { decide, stop, worldFromHosting } from '../../quirky.sitter/src/policy'
import { deriveProgress } from '../src/decide'
import { contractProblems, objectivePayload, remoteExpectedStateTarget } from '../src/contract'
import { commitLocalBranch, readLocalGitHead } from '../src/landing'
import { reportDigest } from '../src/plan'


const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)
const REVIEW_URL = 'https://github.com/test-owner/test-repo/pull/7'
const REPOSITORY = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const HEAD_REPOSITORY = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }

type Identity = { host: string; owner: string; repo: string }
type ExpectedReview = {
  number: number
  url: string
  repository: Identity
  headRepository: Identity
  headRefName: string
  baseRefName: string
  headSha: string
}

function expectedReview(overrides: Partial<ExpectedReview> = {}): ExpectedReview {
  return {
    number: 7,
    url: REVIEW_URL,
    repository: { ...REPOSITORY },
    headRepository: { ...HEAD_REPOSITORY },
    headRefName: 'feature',
    baseRefName: 'main',
    headSha: H1,
    ...overrides
  }
}

function payload(pin: ExpectedReview | undefined = expectedReview()) {
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
    mergeCheckScope: 'all',
    ...(pin === undefined ? {} : { expectedReview: pin })
  }
}

function enrollment(pin: ExpectedReview | undefined = expectedReview()) {
  return {
    capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
    kindPayload: payload(pin)
  }
}

function hostingReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: REVIEW_URL,
    state: 'open',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: H1,
    baseRefOid: B1,
    repository: { ...REPOSITORY },
    headRepository: { name: 'test-repo', owner: { login: 'test-owner' } },
    headRepositoryOwner: { login: 'test-owner' },
    draft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    mergeQueueKnown: true,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    ...overrides
  }
}

function pinnedSnapshot(
  overrides: Record<string, unknown> = {},
  freshness: string = 'live'
) {
  const canonicalPayload = payload() as never
  const world = worldFromHosting(hostingReview(overrides), null, canonicalPayload)
  return {
    freshness,
    contentIdentity: JSON.stringify([world.headSha, world.baseSha]),
    observedAtMs: 1,
    world
  } as never
}

test('authorization validates and preserves the expected review pin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-sitter-pin-'))
  try {
    let review = hostingReview()
    const calls: string[] = []
    const call = async (method: string) => {
      calls.push(method)
      if (method === 'quirky.worktree/resolve') {
        return { id: 'w1', repoId: 'r1', path: directory, branch: 'feature', kind: 'git' }
      }
      if (method === 'quirky.hosting/forBranch') return { kind: 'found', review }
      throw new Error(`unexpected call: ${method}`)
    }
    const input = (pin: unknown) => ({
      kind: 'hosted-review',
      kindPayload: {
        worktree: 'id:w1',
        branchUpdateMode: 'merge-base-update',
        mergeMethod: null,
        mergeCheckScope: 'all',
        expectedReview: pin
      },
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' }
    })

    const pin = expectedReview()
    const authorized = await authorize(call as never, input(pin) as never)
    expect(authorized.kindPayload.expectedReview).toEqual(pin)

    const mismatches: Array<Record<string, unknown>> = [
      { headRefOid: H2 },
      { headRepository: { name: 'fork', owner: { login: 'contributor' } }, headRepositoryOwner: { login: 'contributor' } },
      { baseRefName: 'develop' },
      { number: 8 },
      { url: 'https://github.com/test-owner/test-repo/pull/8' }
    ]
    for (const mismatch of mismatches) {
      review = hostingReview(mismatch)
      await expect(authorize(call as never, input(pin) as never)).rejects.toThrow()
    }

    calls.length = 0
    const malformed = { ...pin, headSha: 'not-a-commit' }
    await expect(authorize(call as never, input(malformed) as never)).rejects.toThrow()
    expect(calls).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('hosting observations include the fork head repository identity', () => {
  const observed = worldFromHosting(hostingReview({
    headRepository: { name: 'contribution', owner: { login: 'contributor' } },
    headRepositoryOwner: { login: 'contributor' }
  }), null, payload() as never) as unknown as Record<string, unknown>
  expect(observed.headRepository).toEqual({ host: 'github.com', owner: 'contributor', repo: 'contribution' })
})

test('pinned policy parks moved heads and review mismatches before merged lifecycle completion', () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; reason: string }> = [
    { name: 'moved head', overrides: { headRefOid: H2 }, reason: 'objective-head-moved' },
    {
      name: 'fork head repository',
      overrides: { headRepository: { name: 'fork', owner: { login: 'contributor' } }, headRepositoryOwner: { login: 'contributor' } },
      reason: 'objective-review-mismatch'
    },
    { name: 'base ref', overrides: { baseRefName: 'develop' }, reason: 'objective-review-mismatch' },
    { name: 'review number', overrides: { number: 8 }, reason: 'objective-review-mismatch' },
    { name: 'review URL', overrides: { url: 'https://github.com/test-owner/test-repo/pull/8' }, reason: 'objective-review-mismatch' },
    {
      name: 'missing head repository metadata',
      overrides: { headRepository: undefined, headRepositoryOwner: undefined },
      reason: 'objective-review-mismatch'
    },
    { name: 'missing head SHA', overrides: { headRefOid: undefined }, reason: 'objective-head-moved' }
  ]

  for (const item of cases) {
    const merged = pinnedSnapshot({ state: 'merged', ...item.overrides })
    const stopped = stop(merged, [], enrollment() as never)
    expect(stopped?.kind, item.name).toBe('park')
    expect((stopped as { detail?: string } | null)?.detail, item.name).toContain(`${item.reason}:`)

    const open = pinnedSnapshot(item.overrides)
    expect(decide(open, [], enrollment() as never), item.name).toMatchObject({
      action: null,
      reason: item.reason
    })
  }
})

test('cached or incomplete observations cannot complete a pinned merged review', () => {
  const cached = pinnedSnapshot({ state: 'merged' }, 'cached')
  expect(stop(cached, [], enrollment() as never)).toMatchObject({
    kind: 'park',
    reason: 'stop-predicate',
    detail: expect.stringContaining('objective-review-mismatch:')
  })
  expect(decide(cached, [], enrollment() as never)).toMatchObject({
    action: null,
    reason: 'objective-review-mismatch'
  })

  for (const missing of [
    { headRefName: undefined },
    { baseRefName: undefined },
    { repository: undefined },
    { headRepository: undefined, headRepositoryOwner: undefined },
    { number: undefined },
    { url: undefined }
  ]) {
    expect(stop(pinnedSnapshot({ state: 'merged', ...missing }), [], enrollment() as never)).toMatchObject({
      kind: 'park',
      reason: 'stop-predicate'
    })
  }
})

test('only the exact live pinned review is accepted as merged', () => {
  expect(stop(pinnedSnapshot({ state: 'merged' }), [], enrollment() as never)).toEqual({
    kind: 'terminal',
    state: 'merged',
    reason: 'review merged'
  })
})

test('preflight and execution reject stale or forged pinned actions before mutation', async () => {
  const calls: string[] = []
  const call = async (method: string) => {
    calls.push(method)
    return undefined
  }
  let processCalls = 0
  const processRun = async () => {
    processCalls++
    return { stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: 0, signal: null, durationMs: 0 }
  }
  const pinned = enrollment()
  const staleSnapshot = pinnedSnapshot({ headRefOid: H2 })
  const preparation = {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: 'prepare',
    expectedHeadSha: H1,
    failedChecks: []
  }
  const verdict = await preflight(call as never, {
    action: preparation as never,
    snapshot: staleSnapshot,
    journal: [],
    enrollment: pinned as never
  }, processRun as never)
  expect(verdict).toMatchObject({ verdict: 'hold', reason: 'objective-head-moved' })
  expect(calls).toEqual([])
  expect(processCalls).toBe(0)
  const forgedPreflight = await preflight(call as never, {
    action: { ...preparation, expectedHeadSha: H2 } as never,
    snapshot: pinnedSnapshot(),
    journal: [],
    enrollment: pinned as never
  }, processRun as never)
  expect(forgedPreflight).toMatchObject({ verdict: 'hold', reason: 'objective-head-moved' })
  expect(calls).toEqual([])
  expect(processCalls).toBe(0)


  const forgedMerge = { kind: 'merge', head: H2, method: 'squash', ordinal: 1 }
  const result = await execute(call as never, forgedMerge as never, pinned as never)
  expect(result).toMatchObject({
    effect: 'not-landed',
    reason: expect.stringContaining('objective-head-moved')
  })
  expect(calls).toEqual([])
})
test('pinned execute revalidates the complete live review identity before merge', async () => {
  const staleReviews: Array<[string, unknown]> = [
    ['changed base ref', { kind: 'found', review: hostingReview({ baseRefName: 'release' }) }],
    ['changed head repository', {
      kind: 'found',
      review: hostingReview({
        headRepository: { name: 'forked-repo', owner: { login: 'test-owner' } }
      })
    }],
    ['changed review URL', { kind: 'found', review: hostingReview({ url: 'https://github.com/test-owner/test-repo/pull/8' }) }],
    ['changed review number', { kind: 'found', review: hostingReview({ number: 8 }) }],
    ['unavailable lookup', { kind: 'unavailable', message: 'lookup unavailable' }],
    ['unknown lookup', { kind: 'unknown' }]
  ]

  for (const [description, liveLookup] of staleReviews) {
    const calls: string[] = []
    const call = async (method: string) => {
      calls.push(method)
      if (method === 'quirky.hosting/review') return liveLookup
      if (method === 'quirky.hosting/merge') return { state: 'merged' }
      throw new Error(`unexpected call: ${method}`)
    }
    const result = await execute(
      call as never,
      { kind: 'merge', head: H1, method: 'squash', ordinal: 1 } as never,
      enrollment() as never
    )

    expect(result, description).toMatchObject({ effect: 'not-landed' })
    expect(calls, description).toEqual(['quirky.hosting/review'])
  }
})

test('pinned execute allows merge when the complete live review identity matches', async () => {
  const calls: string[] = []
  const call = async (method: string) => {
    calls.push(method)
    if (method === 'quirky.hosting/review') return { kind: 'found', review: hostingReview() }
    if (method === 'quirky.hosting/merge') return { state: 'merged' }
    throw new Error(`unexpected call: ${method}`)
  }

  const result = await execute(
    call as never,
    { kind: 'merge', head: H1, method: 'squash', ordinal: 1 } as never,
    enrollment() as never
  )

  expect(result).toEqual({ effect: 'landed' })
  expect(calls).toEqual(['quirky.hosting/review', 'quirky.hosting/merge'])
})
const OBJECTIVE_HEAD = 'c'.repeat(40)
const OBJECTIVE_TREE = 'd'.repeat(40)
const OBJECTIVE_PUSH_URL_FINGERPRINT = 'e'.repeat(64)
const OBJECTIVE_BASE_REPOSITORY = { host: 'github.com', owner: 'base-owner', repo: 'base-repo' }
const OBJECTIVE_HEAD_REPOSITORY = { host: 'github.com', owner: 'fork-owner', repo: 'fork-repo' }

function objectivePayloadFor(bar: ObjectivePayload['landingBar']): ObjectivePayload {
  return {
    objectiveText: 'Publish the approved objective',
    tier: 'express',
    landingBar: bar,
    lanesEnabled: true,
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: {},
    gates: [],
    worktree: 'id:objective-worktree'
  }
}

function objectiveAuthority(overrides: Partial<RemoteLandingAuthority> = {}): RemoteLandingAuthority {
  return {
    branch: 'feature',
    headSha: OBJECTIVE_HEAD,
    remote: 'origin',
    remoteRef: 'refs/heads/feature',
    pushUrlFingerprint: OBJECTIVE_PUSH_URL_FINGERPRINT,
    ...overrides
  }
}

function objectiveLanding(
  rung: LandingRecord['rung'],
  contentIdentity = `objective-tree:${OBJECTIVE_TREE}`,
  payload: Record<string, unknown> = { revision: 1 }
): LandingRecord {
  return { watcherId: 'objective-1', rung, contentIdentity, attemptId: `attempt-${rung}`, payload, recordedAtMs: 1 }
}

function objectiveReducerWorld(
  bar: 'pushed-ref' | 'hosted-review' | 'merged',
  authority = objectiveAuthority(),
  overrides: Partial<ObjectiveWorld> = {}
): ObjectiveWorld {
  const contentIdentity = overrides.contentIdentity ?? `objective-tree:${OBJECTIVE_TREE}`
  return {
    planMode: 'on',
    contract: objectivePayloadFor(bar),
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'gated' },
    contentIdentity,
    observedAtMs: 1,
    worktreeId: 'wt-objective',
    git: { branch: authority.branch, headSha: authority.headSha },
    revision: { number: 1, digest: 'plan-digest', tasks: [] },
    reports: [],
    issued: [],
    checks: [],
    verdicts: [],
    landings: [
      objectiveLanding('files-on-disk', contentIdentity, { revision: 1 }),
      objectiveLanding('committed-local-branch', contentIdentity, { revision: 1, headSha: authority.headSha })
    ],
    remote: { authority, remoteHeadSha: null, review: null, problem: null },
    rejectedDrafts: [],
    overruns: [],
    repairs: [],
    ...overrides
  }
}

test('remote actions carry the exact target state required for gated approval', () => {
  const authority = objectiveAuthority()
  const beforeSha = '9'.repeat(40)
  const world = objectiveReducerWorld('pushed-ref', authority, {
    remote: { authority, remoteHeadSha: beforeSha, review: null, problem: null }
  })
  const action = nextStep(world, []).action
  if (!action || action.kind !== 'push-ref') throw new Error('expected push-ref')

  expect(action.capability).toBe('land')
  expect(action.visibility).toBe('external')
  expect(action.expectedState).toEqual({
    target: `git-push:${authority.remote}:${authority.remoteRef}:${authority.pushUrlFingerprint}`,
    before: beforeSha
  })
  expect('recovery' in action).toBe(false)

  const absent = objectiveReducerWorld('pushed-ref', authority, {
    remote: { authority, remoteHeadSha: null, review: null, problem: null }
  })
  const absentAction = nextStep(absent, []).action
  if (!absentAction || absentAction.kind !== 'push-ref') throw new Error('expected push-ref for an absent exact ref')
  expect(absentAction.expectedState.before).toBeNull()
  expect(absentAction.evidenceKey).not.toBe(action.evidenceKey)
})
const remoteCleanup: Array<() => void> = []
afterEach(() => {
  for (const close of remoteCleanup.splice(0).reverse()) close()
})

type ProcessInterceptor = (
  argv: readonly string[],
  options: RunOptions | undefined,
  run: () => RunResult
) => RunResult | Promise<RunResult>
type CallHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>
type RemoteRigOptions = {
  landingBar?: ObjectivePayload['landingBar']
  tier?: 'express' | 'full'
  objectiveText?: string
}

function isolatedGitEnvironment(
  home: string,
  worktree: string,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...overrides,
    HOME: home,
    QUIRKY_HOME: home,
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false'
  }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
  ]) delete env[key]
  const index = env.GIT_INDEX_FILE
  if (index && !index.startsWith(`${home}/`) && !index.startsWith(`${worktree}/`)) delete env.GIT_INDEX_FILE
  return env
}

function execGit(cwd: string, args: string[], home = cwd): string {
  return execFileSync('git', args, {
    cwd,
    env: isolatedGitEnvironment(home, cwd),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function runResult(stdoutText = '', exitCode: number | null = 0, stderr = ''): RunResult {
  const stdout = Buffer.from(stdoutText)
  return { stdout, stdoutText, stderr, exitCode, signal: null, durationMs: 0 }
}

function runGitBroker(argv: readonly string[], options: RunOptions | undefined, home: string, worktree: string): RunResult {
  const [command, ...args] = argv
  const result = spawnSync(command!, args, {
    cwd: options?.cwd,
    env: isolatedGitEnvironment(home, worktree, options?.env),
    input: options?.input === undefined ? undefined : Buffer.from(options.input),
    timeout: options?.timeoutMs ?? 30_000,
    maxBuffer: options?.maxOutputBytes ?? 8 * 1024 * 1024
  })
  const stdout = result.stdout ?? Buffer.alloc(0)
  const stderr = result.stderr?.toString() ?? ''
  return {
    stdout,
    stdoutText: stdout.toString(),
    stderr,
    exitCode: result.status,
    signal: result.signal,
    durationMs: 0,
    ...(result.error ? {
      spawnError: {
        code: 'code' in result.error && typeof result.error.code === 'string' ? result.error.code : 'UNKNOWN',
        message: result.error.message
      }
    } : {})
  }
}


function remoteRig(options: RemoteRigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'objective-remote-worktree-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-remote-data-'))
  const bareDirectory = mkdtempSync(join(tmpdir(), 'objective-remote-bare-'))
  const bare = join(bareDirectory, 'remote.git')
  remoteCleanup.push(() => rmSync(root, { recursive: true, force: true }))
  remoteCleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  remoteCleanup.push(() => rmSync(bareDirectory, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', '--bare', bare], {
    env: isolatedGitEnvironment(dataDir, bareDirectory)
  })

  const landingBar = options.landingBar ?? 'pushed-ref'
  const tier = options.tier ?? 'full'
  const gate = { name: 'ready', command: 'test -f src/main.ts', timeoutSeconds: 45 }
  const criterion = {
    body: 'src/main.ts exists',
    shellCheckable: tier === 'full',
    checkCommand: tier === 'full' ? 'test -f src/main.ts' : null
  }
  const payload = objectivePayload({
    objectiveText: options.objectiveText ?? 'Publish the reviewed objective',
    tier,
    landingBar,
    lanesEnabled: true,
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: {},
    gates: tier === 'full' ? [gate] : [],
    worktree: 'id:remote-worktree'
  }, 'id:remote-worktree')
  const task = {
    taskKey: 'implement',
    title: 'Implement remote landing',
    spec: 'Implement the approved content.',
    deps: [],
    criteria: [criterion],
    territory: ['src/**']
  }
  const plan = { plan: { tasks: [task] }, assumptions: [] }
  const revision = {
    watcherId: 'objective-remote',
    number: 1,
    plan,
    digest: 'remote-plan-digest',
    sourceAttemptId: 'planner',
    approvedAtMs: 1
  }
  const checkRows: CheckRecord[] = []
  const verdictRows: VerdictRecord[] = []
  const issuedRows: Array<{
    attemptId: string
    watcherId: string
    role: 'implementer' | 'reviewer' | 'integrator'
    revision: number
    taskKey: string | null
    contentIdentity: string
  }> = []
  const landingRows: LandingRecord[] = []
  const processCalls: Array<{ argv: string[]; options?: RunOptions }> = []
  const contextCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const callHandlers = new Map<string, CallHandler>()
  let interceptor: ProcessInterceptor | null = null
  let initialized = false
  let currentContentIdentity = ''
  let currentHead: { branch: string | null; headSha: string | null } = { branch: null, headSha: null }
  let originRepository = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
  let baseRepository = { ...originRepository }

  const store = {
    revision(watcherId: string) { return watcherId === 'objective-remote' ? revision : null },
    issued(watcherId: string) { return issuedRows.filter(row => row.watcherId === watcherId) },
    checks(watcherId: string) { return checkRows.filter(row => row.watcherId === watcherId) },
    verdicts(watcherId: string) { return verdictRows.filter(row => row.watcherId === watcherId) },
    landings(watcherId: string) { return landingRows.filter(row => row.watcherId === watcherId) },
    recordLanding(row: LandingRecord) {
      if (!landingRows.some(existing => existing.watcherId === row.watcherId &&
        existing.rung === row.rung && existing.contentIdentity === row.contentIdentity)) {
        landingRows.push(structuredClone(row))
      }
    },
    reports() { return [] },
    rejectedDrafts() { return [] },
    overruns() { return [] },
    repairs() { return [] }
  } as unknown as ObjectiveStore

  const context = {
    dataDir,
    process: {
      async run(argv: readonly string[], runOptions?: RunOptions): Promise<RunResult> {
        const args = [...argv]
        processCalls.push({ argv: args, options: runOptions })
        const run = () => runGitBroker(args, runOptions, dataDir, root)
        return interceptor ? interceptor(args, runOptions, run) : run()
      }
    },
    async call(method: string, rawParams: Record<string, unknown>): Promise<unknown> {
      contextCalls.push({ method, params: rawParams })
      const handler = callHandlers.get(method)
      if (handler) return handler(rawParams)
      if (method === 'quirky.hosting/repository') {
        return { worktreeId: 'remote-worktree', origin: originRepository, candidates: [baseRepository] }
      }
      if (method === 'quirky.hosting/pushRepository') {
        const url = execGit(root, ['remote', 'get-url', '--push', '--all', 'origin'], dataDir).trim()
        return {
          ready: true,
          repository: originRepository,
          pushUrlFingerprint: createHash('sha256').update(url).digest('hex')
        }
      }
      if (method === 'quirky.hosting/creationEligibility') {
        return { eligible: true, defaultBase: 'main', blockers: [] }
      }
      if (method === 'quirky.hosting/forBranch') return { kind: 'no-review' }
      if (method === 'quirky.hosting/review') return { kind: 'no-review' }
      if (method === 'quirky.worktree/resolve') {
        return { id: 'remote-worktree', repoId: 'remote-repo', path: root, kind: 'git' }
      }
      throw new Error(`unexpected context.call: ${method}`)
    }
  } as unknown as PluginContext
  const enrollment = { watcherId: 'objective-remote', workspacePath: root, kindPayload: payload }
  const runtime: ObjectiveRuntime = {
    context,
    store,
    enrollment,
    captureContentIdentity: () => captureContentIdentity(context, root, dataDir, enrollment.watcherId)
  }

  function addLocalLandings(identity: string, headSha: string): void {
    store.recordLanding({
      watcherId: enrollment.watcherId,
      rung: 'files-on-disk',
      contentIdentity: identity,
      attemptId: 'files-on-disk',
      payload: { revision: 1 },
      recordedAtMs: 1
    })
    store.recordLanding({
      watcherId: enrollment.watcherId,
      rung: 'committed-local-branch',
      contentIdentity: identity,
      attemptId: 'committed-local-branch',
      payload: { revision: 1, headSha },
      recordedAtMs: 2
    })
  }

  function installCurrentEvidence(identity: string): void {
    currentContentIdentity = identity
    checkRows.splice(0)
    verdictRows.splice(0)
    issuedRows.splice(0)
    const nodeAttempt = {
      kind: 'dispatch-node',
      revision: 1,
      taskKey: 'implement',
      ordinal: 1,
      repairEpisode: 0
    }
    issuedRows.push({
      attemptId: 'implementer-attempt',
      watcherId: enrollment.watcherId,
      role: 'implementer',
      revision: 1,
      taskKey: 'implement',
      contentIdentity: identity
    })
    journal.splice(0, journal.length, {
      seq: 1,
      kind: 'attempt',
      attemptId: 'implementer-attempt',
      dispatchId: 'implementer-dispatch',
      action: nodeAttempt,
      state: 'settled',
      effect: 'landed'
    })
    if (tier === 'full') {
      const checkAttempt = 'criterion-attempt'
      const gateAttempt = 'gate-attempt'
      checkRows.push({
        attemptId: checkAttempt,
        watcherId: enrollment.watcherId,
        revision: 1,
        kind: 'criterion',
        targetKey: 'implement:0',
        contentIdentity: identity,
        command: 'test -f src/main.ts',
        status: 'passed',
        exitCode: 0,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
        checkedAtMs: 10
      })
      checkRows.push({
        attemptId: gateAttempt,
        watcherId: enrollment.watcherId,
        revision: 1,
        kind: 'gate',
        targetKey: 'ready',
        contentIdentity: identity,
        command: gate.command,
        status: 'passed',
        exitCode: 0,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
        checkedAtMs: 11
      })
      journal.push(
        {
          seq: 2,
          kind: 'attempt',
          attemptId: checkAttempt,
          dispatchId: `${checkAttempt}-dispatch`,
          action: {
            kind: 'run-check', revision: 1, taskKey: 'implement', criterionIndex: 0,
            command: criterion.checkCommand!, contentIdentity: identity,
            evidenceKey: `check:1:implement:0:${identity}`
          },
          state: 'settled',
          effect: 'landed'
        },
        {
          seq: 3,
          kind: 'attempt',
          attemptId: gateAttempt,
          dispatchId: `${gateAttempt}-dispatch`,
          action: {
            kind: 'run-gate', revision: 1, gateName: gate.name, command: gate.command,
            contentIdentity: identity, evidenceKey: `gate:1:${gate.name}:${identity}`
          },
          state: 'settled',
          effect: 'landed'
        }
      )
      const reviewerAttempt = 'reviewer-attempt'
      const integratorAttempt = 'integrator-attempt'
      issuedRows.push(
        {
          attemptId: reviewerAttempt, watcherId: enrollment.watcherId, role: 'reviewer',
          revision: 1, taskKey: null, contentIdentity: identity
        },
        {
          attemptId: integratorAttempt, watcherId: enrollment.watcherId, role: 'integrator',
          revision: 1, taskKey: null, contentIdentity: identity
        }
      )
      const criteriaResults = [{ taskKey: 'implement', criterionIndex: 0, result: 'pass' as const, note: 'verified' }]
      verdictRows.push(
        {
          attemptId: reviewerAttempt, watcherId: enrollment.watcherId, dispatchId: `${reviewerAttempt}-dispatch`,
          revision: 1, role: 'reviewer', contentIdentity: identity, verdict: 'approve',
          criteriaResults, checksRun: [], summary: 'Approved.', digest: 'reviewer-digest', acceptedAtMs: 20
        },
        {
          attemptId: integratorAttempt, watcherId: enrollment.watcherId, dispatchId: `${integratorAttempt}-dispatch`,
          revision: 1, role: 'integrator', contentIdentity: identity, verdict: 'approve',
          criteriaResults, checksRun: [{ command: gate.command, exitCode: 0 }],
          summary: 'Integrated.', digest: 'integrator-digest', acceptedAtMs: 21
        }
      )
      journal.push(
        {
          seq: 4, kind: 'attempt', attemptId: reviewerAttempt, dispatchId: `${reviewerAttempt}-dispatch`,
          action: { kind: 'dispatch-reviewer', revision: 1, contentIdentity: identity, evidenceKey: `review:1:reviewer:${identity}:1` },
          state: 'settled', effect: 'landed'
        },
        {
          seq: 5, kind: 'attempt', attemptId: integratorAttempt, dispatchId: `${integratorAttempt}-dispatch`,
          action: { kind: 'dispatch-integrator', revision: 1, contentIdentity: identity, evidenceKey: `review:1:integrator:${identity}:1` },
          state: 'settled', effect: 'landed'
        }
      )
    }
  }

  const journal: ObjectiveJournalEntry[] = []
  function world(remote: ObjectiveWorld['remote'] | null = null): ObjectiveWorld {
    return {
      planMode: 'on',
      contract: payload,
      capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'gated' },
      contentIdentity: currentContentIdentity,
      observedAtMs: 100,
      worktreeId: 'remote-worktree',
      git: currentHead,
      revision: {
        number: revision.number,
        digest: revision.digest,
        plan,
        tasks: [{ taskKey: task.taskKey, deps: [], criteriaCount: task.criteria.length, criteria: task.criteria }]
      },
      reports: [{
        attemptId: 'implementer-attempt', role: 'implementer', taskKey: 'implement',
        digest: 'implementer-digest', summary: 'Implemented.', filesModified: ['src/main.ts']
      }],
      issued: issuedRows,
      checks: checkRows,
      verdicts: verdictRows,
      landings: store.landings(enrollment.watcherId),
      rejectedDrafts: [],
      overruns: [],
      repairs: [],
      ...(remote === null ? {} : { remote })
    }
  }

  const fixture = {
    root, bare, dataDir, payload, task, plan, revision, checkRows, verdictRows, issuedRows, landingRows,
    processCalls, contextCalls, context, runtime, store, journal,
    get currentHead() { return currentHead },
    async initGit(commit = true): Promise<void> {
      if (initialized) return
      execGit(root, ['init', '--quiet', '--initial-branch=main'], dataDir)
      execGit(root, ['config', 'user.name', 'Objective Fixture'], dataDir)
      execGit(root, ['config', 'user.email', 'objective@example.test'], dataDir)
      execGit(root, ['config', 'commit.gpgsign', 'false'], dataDir)
      if (commit) {
        mkdirSync(join(root, 'src'), { recursive: true })
        writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 0\n')
        execGit(root, ['add', '-A'], dataDir)
        execGit(root, ['commit', '--quiet', '-m', 'Base for objective'], dataDir)
      }
      execGit(root, ['remote', 'add', 'origin', bare], dataDir)
      if (commit) {
        execGit(root, ['push', '--quiet', '--set-upstream', 'origin', 'main'], dataDir)
        execGit(root, ['checkout', '--quiet', '-b', 'feature'], dataDir)
        writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 1\n')
        execGit(root, ['add', 'src/main.ts'], dataDir)
        execGit(root, ['commit', '--quiet', '-m', 'Reviewed objective'], dataDir)
        execGit(root, ['config', 'branch.feature.remote', 'origin'], dataDir)
        execGit(root, ['config', 'branch.feature.merge', 'refs/heads/feature'], dataDir)
      }
      initialized = true
    },
    async prepare(): Promise<string> {
      await this.initGit()
      currentHead = await readLocalGitHead(context, root)
      if (!currentHead.branch || !currentHead.headSha) throw new Error('fixture did not create an attached commit')
      const identity = await captureContentIdentity(context, root, dataDir, enrollment.watcherId)
      installCurrentEvidence(identity)
      addLocalLandings(identity, currentHead.headSha)
      return identity
    },
    async prepareForLocalCommit(): Promise<{ contentIdentity: string; branch: string; headSha: string }> {
      await this.initGit()
      currentHead = await readLocalGitHead(context, root)
      if (!currentHead.branch || !currentHead.headSha) throw new Error('fixture did not create an attached commit')
      const contentIdentity = await captureContentIdentity(context, root, dataDir, enrollment.watcherId)
      installCurrentEvidence(contentIdentity)
      store.recordLanding({
        watcherId: enrollment.watcherId,
        rung: 'files-on-disk',
        contentIdentity,
        attemptId: 'files-on-disk-before-commit',
        payload: { revision: 1 },
        recordedAtMs: 1
      })
      return { contentIdentity, branch: currentHead.branch, headSha: currentHead.headSha }
    },
    async observe() {
      return observeRemoteLanding(context, root, 'remote-worktree', payload)
    },
    world,
    async action(remote?: RemoteObservation) {
      const observation = remote ?? await this.observe()
      const step = nextStep(world(observation), journal)
      if (!step.action || (step.action.kind !== 'push-ref' && step.action.kind !== 'open-hosted-review')) {
        throw new Error(`expected a remote action, got ${step.reason ?? 'no reason'}`)
      }
      return step.action
    },
    async addPushedLanding(authority: RemoteLandingAuthority, headSha = authority.headSha): Promise<void> {
      store.recordLanding({
        watcherId: enrollment.watcherId,
        rung: 'pushed-ref',
        contentIdentity: currentContentIdentity,
        attemptId: 'pushed-ref',
        payload: { ...authority, revision: 1, remoteHeadSha: headSha },
        recordedAtMs: 3
      })
    },
    setProcessInterceptor(value: ProcessInterceptor | null) { interceptor = value },
    setCallHandler(method: string, handler: CallHandler) { callHandlers.set(method, handler) },
    setRepositoryPair(origin: { host: string; owner: string; repo: string }, base: { host: string; owner: string; repo: string }) {
      originRepository = origin
      baseRepository = base
    },
    reviewFor(authority: RemoteLandingAuthority, overrides: Record<string, unknown> = {}) {
      const repository = authority.repository!
      const headRepository = authority.headRepository!
      return {
        provider: 'github',
        number: 7,
        url: `https://${repository.host}/${repository.owner}/${repository.repo}/pull/7`,
        title: 'Existing objective',
        body: 'A hosted objective review.',
        updatedAt: null,
        state: 'open',
        headRefName: authority.branch,
        baseRefName: authority.baseRefName,
        headRefOid: authority.headSha,
        baseRefOid: H1,
        mergeable: 'UNKNOWN',
        checksStatus: 'UNKNOWN',
        reviewDecision: 'NONE',
        mergeStateStatus: 'UNKNOWN',
        autoMergeRequest: null,
        stack: null,
        mergeMethods: { default: 'squash', allowed: ['squash'] },
        mergeQueueRequired: false,
        inMergeQueue: false,
        mergeQueueEntry: null,
        mergeQueueKnown: true,
        autoMergeAllowed: false,
        mergeMetadataKnown: true,
        repository,
        headRepository: { name: headRepository.repo, owner: { login: headRepository.owner } },
        headRepositoryOwner: { login: headRepository.owner },
        ...overrides
      }
    }
  }
  return fixture
}

function exactBareRef(bare: string, ref = 'refs/heads/feature'): string | null {
  try {
    return execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', ref], {
      cwd: bare,
      env: isolatedGitEnvironment(bare, bare),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

function landedAuthority(authority: RemoteLandingAuthority, contentIdentity: string, rung: 'pushed-ref' | 'hosted-review', extra: Record<string, unknown> = {}): LandingRecord {
  return {
    watcherId: 'objective-1',
    rung,
    contentIdentity,
    attemptId: `attempt-${rung}`,
    payload: { ...authority, revision: 1, ...extra },
    recordedAtMs: 1
  }
}

function persistentStore(home: string, dataDir: string) {
  let close: (() => void) | null = null
  const context = {
    dataDir,
    openStore(migrations: StoreMigration[], options?: { newerVersion?: 'read-only' }) {
      const opened = openPluginStore({
        home,
        pluginId: 'quirky.objective',
        migrations,
        isActive: () => true,
        newerVersion: options?.newerVersion
      })
      close = opened.close
      return opened.store
    }
  } as unknown as PluginContext
  return {
    context,
    store: createObjectiveStore(context),
    close() { close?.(); close = null }
  }
}

function persistRevision(store: ObjectiveStore, watcherId: string, plan: unknown): void {
  const digest = reportDigest(plan as never)
  store.issue({
    attemptId: 'persisted-planner',
    watcherId,
    role: 'planner',
    revision: null,
    taskKey: null,
    reportPath: '/tmp/persisted-plan.json',
    issuedAtMs: 1
  })
  store.accept({
    attemptId: 'persisted-planner',
    watcherId,
    dispatchId: 'persisted-planner-dispatch',
    role: 'planner',
    report: plan as never,
    digest,
    acceptedAtMs: 2
  })
  store.activate(watcherId, 'persisted-planner', digest)
}

type RemoteAction = Extract<ObjectiveAction, { kind: 'push-ref' | 'open-hosted-review' }>

async function executeFixtureAction(
  rig: ReturnType<typeof remoteRig>,
  action: RemoteAction,
  attemptId = 'remote-attempt'
) {
  const tasks = deriveProgress(rig.world(), rig.journal).tasks
  return executeRemoteLanding(rig.runtime, action, attemptId, rig.journal, tasks, 'remote-worktree')
}

async function preparePushedHostedReview(
  rig: ReturnType<typeof remoteRig>,
  origin = OBJECTIVE_HEAD_REPOSITORY,
  base = OBJECTIVE_BASE_REPOSITORY
): Promise<{ authority: RemoteLandingAuthority; action: RemoteAction; observation: RemoteObservation }> {
  await rig.prepare()
  rig.setRepositoryPair(origin, base)
  const beforePush = await rig.observe()
  if (!beforePush.authority) throw new Error(`hosted target unavailable: ${beforePush.problem}`)
  const authority = beforePush.authority
  execGit(rig.root, ['push', '--', rig.bare, `${authority.headSha}:${authority.remoteRef}`], rig.dataDir)
  await rig.addPushedLanding(authority)
  const observation = await rig.observe()
  return { authority, action: await rig.action(observation), observation }
}

test('remote bars enroll without weakening local or workspace validation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-authorize-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'objective-authorize-worktree-'))
  remoteCleanup.push(() => rmSync(home, { recursive: true, force: true }))
  remoteCleanup.push(() => rmSync(workspace, { recursive: true, force: true }))

  const githubOrigin = { host: 'github.com', owner: 'owner', repo: 'repo' }
  const repositoryDto = (origin: typeof githubOrigin, candidates = [origin]) => ({
    worktreeId: 'remote-worktree',
    origin,
    head: origin,
    repository: origin,
    candidates,
    issueRepository: origin,
    issueSourcePreference: 'auto',
    issueSourceFellBack: false
  })
  let repository: unknown = repositoryDto(githubOrigin)
  let workspaceKind: 'git' | 'folder' = 'git'
  const calls: string[] = []
  const context = {
    dataDir: home,
    process: { async run() { throw new Error('authorization must not run Git') } },
    async call(method: string) {
      calls.push(method)
      if (method === 'quirky.worktree/resolve') {
        return { id: 'remote-worktree', repoId: 'remote-repo', path: workspace, kind: workspaceKind }
      }
      if (method === 'quirky.hosting/repository') {
        if (repository === 'unavailable' || repository === 'unsupported') {
          throw Object.assign(new Error(`repository resolution ${repository}`), {
            reason: repository === 'unsupported' ? 'unsupported_provider' : 'repo_unavailable'
          })
        }
        return repository
      }
      throw new Error(`unexpected authorization call: ${method}`)
    }
  } as unknown as PluginContext
  const hooks = createObjectiveHooks(context, {} as ObjectiveStore)
  const enrollment = (landingBar: ObjectivePayload['landingBar']) => objectivePayload({
    objectiveText: 'A valid objective',
    tier: 'express',
    landingBar,
    lanesEnabled: true,
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: {},
    gates: [],
    worktree: 'id:remote-worktree'
  }, 'id:remote-worktree')

  for (const landingBar of ['files-on-disk', 'committed-local-branch', 'pushed-ref', 'hosted-review', 'merged'] as const) {
    const value = enrollment(landingBar)
    expect(contractProblems(value), landingBar).toEqual([])
    await hooks.authorize({ input: { kindPayload: value } } as never)
  }
  expect(calls.filter(method => method === 'quirky.hosting/repository')).toHaveLength(2)
  const pushedRef = enrollment('pushed-ref')
  expect(contractProblems({ ...pushedRef, objectiveText: '' }).some(problem => problem.startsWith('objective-text-invalid:'))).toBe(true)

  for (const invalidRepository of [
    null,
    { worktreeId: 'remote-worktree', origin: {}, candidates: [] },
    'unavailable',
    'unsupported'
  ]) {
    repository = invalidRepository
    await expect(hooks.authorize({ input: { kindPayload: enrollment('hosted-review') } } as never))
      .rejects.toThrow('landing-bar-requires-github')
    await expect(hooks.authorize({ input: { kindPayload: enrollment('merged') } } as never))
      .rejects.toThrow('landing-bar-requires-github')
  }

  workspaceKind = 'folder'
  await expect(hooks.authorize({ input: { kindPayload: pushedRef } } as never))
    .rejects.toThrow('workspace-requires-git')
  workspaceKind = 'git'

  const noPushConfig = remoteRig({ landingBar: 'pushed-ref', tier: 'express' })
  await noPushConfig.initGit()
  execGit(noPushConfig.root, ['remote', 'remove', 'origin'], noPushConfig.dataDir)
  expect(await noPushConfig.observe()).toMatchObject({ authority: null, problem: 'push-target-unavailable' })
  await hooks.authorize({ input: { kindPayload: pushedRef } } as never)
})

test('pushed-ref reaches the exact bare ref and stops without a review', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref' })
  const contentIdentity = await rig.prepare()
  const before = await rig.observe()
  const action = await rig.action(before)
  expect(action.kind).toBe('push-ref')
  expect(action).toMatchObject({
    capability: 'land',
    visibility: 'external',
    authority: { branch: 'feature', remote: 'origin', remoteRef: 'refs/heads/feature' },
    expectedState: { before: null }
  })
  expect(action.evidenceKey).toContain('remote:push-ref:')
  expect(rig.checkRows.every(row => row.status === 'passed')).toBe(true)
  expect(rig.verdictRows.every(row => row.verdict === 'approve')).toBe(true)

  const outcome = await executeFixtureAction(rig, action, 'push-exact-ref')
  expect(outcome).toEqual({ effect: 'landed' })
  expect(exactBareRef(rig.bare, action.authority.remoteRef)).toBe(action.authority.headSha)
  expect(rig.store.landings('objective-remote')).toContainEqual(expect.objectContaining({
    rung: 'pushed-ref',
    contentIdentity,
    attemptId: 'push-exact-ref',
    payload: expect.objectContaining({
      revision: 1,
      remoteHeadSha: action.authority.headSha,
      remoteRef: action.authority.remoteRef
    })
  }))

  const pushCalls = rig.processCalls.filter(call => call.argv[1] === 'push')
  expect(pushCalls).toHaveLength(1)
  expect(pushCalls[0]!.argv).toEqual([
    'git', 'push', '--', rig.bare, `${action.authority.headSha}:${action.authority.remoteRef}`
  ])
  expect(pushCalls[0]!.argv.some(argument => argument.includes('force'))).toBe(false)
  const exactReads = rig.processCalls.filter(call =>
    call.argv[1] === 'ls-remote' && call.argv.at(-1) === action.authority.remoteRef
  )
  expect(exactReads.length).toBeGreaterThanOrEqual(2)
  expect(rig.contextCalls.filter(call => call.method.startsWith('quirky.hosting/'))).toEqual([])

  const after = await rig.observe()
  const world = rig.world(after)
  expect(nextStep(world, rig.journal)).toEqual({ action: null, reason: 'objective-bar-reached' })
  expect(stopObjective({
    freshness: 'live',
    contentIdentity,
    observedAtMs: 100,
    world
  }, rig.journal)).toEqual({
    kind: 'terminal',
    state: 'landed',
    reason: 'pushed-ref landing bar reached'
  })
})

test('remote push requires a fresh exact-ref read rather than a successful process receipt', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref' })
  await rig.prepare()
  const action = await rig.action()
  execGit(rig.root, ['update-ref', `refs/remotes/origin/${action.authority.branch}`, action.authority.headSha], rig.dataDir)
  rig.setProcessInterceptor((argv, _options, run) =>
    argv[1] === 'push' ? runResult('Everything up to date\n') : run()
  )

  const outcome = await executeFixtureAction(rig, action, 'receipt-only')
  expect(outcome).toEqual({ effect: 'indeterminate', reason: 'landing-outcome-indeterminate' })
  expect(exactBareRef(rig.bare, action.authority.remoteRef)).toBeNull()
  expect(execGit(rig.root, ['rev-parse', `refs/remotes/origin/${action.authority.branch}`], rig.dataDir).trim())
    .toBe(action.authority.headSha)
  expect(rig.store.landings('objective-remote').some(row => row.rung === 'pushed-ref')).toBe(false)
})

test('remote approval cannot follow changed content branch or destination', () => {
  const originalAuthority = objectiveAuthority({
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    baseRefName: 'main'
  })
  const originalWorld = objectiveReducerWorld('hosted-review', originalAuthority)
  const original = nextStep(originalWorld, []).action
  if (!original || original.kind !== 'push-ref') throw new Error('expected target-bound push action')
  const oldScope = {
    actionKind: original.kind,
    contentIdentity: original.contentIdentity,
    evidenceKey: original.evidenceKey
  }
  expect(original.expectedState.target).toBe(remoteExpectedStateTarget('push-ref', originalAuthority))
  expect(remoteActionEvidenceKey(
    'push-ref', originalAuthority, original.retryGeneration, original.ordinal, undefined, original.expectedState
  )).toBe(original.evidenceKey)

  const contentTree = `objective-tree:${'f'.repeat(40)}`
  const changes: Array<{ name: string; authority: RemoteLandingAuthority; contentIdentity?: string }> = [
    { name: 'branch', authority: { ...originalAuthority, branch: 'retargeted' } },
    { name: 'local SHA', authority: { ...originalAuthority, headSha: H2 } },
    { name: 'configured push remote', authority: { ...originalAuthority, remote: 'backup' } },
    { name: 'destination ref', authority: { ...originalAuthority, remoteRef: 'refs/heads/release' } },
    { name: 'expanded push URL fingerprint', authority: { ...originalAuthority, pushUrlFingerprint: 'a'.repeat(64) } },
    {
      name: 'base repository',
      authority: { ...originalAuthority, repository: { host: 'github.com', owner: 'other-owner', repo: 'base-repo' } }
    },
    {
      name: 'head repository',
      authority: { ...originalAuthority, headRepository: { host: 'github.com', owner: 'other-fork', repo: 'fork-repo' } }
    },
    { name: 'selected base', authority: { ...originalAuthority, baseRefName: 'release' } },
    { name: 'content tree', authority: originalAuthority, contentIdentity: contentTree }
  ]
  for (const change of changes) {
    const identity = change.contentIdentity ?? original.contentIdentity
    const world = objectiveReducerWorld('hosted-review', change.authority, {
      contentIdentity: identity,
      remote: { authority: change.authority, remoteHeadSha: null, review: null, problem: null }
    })
    const replacement = nextStep(world, []).action
    if (!replacement || replacement.kind !== 'push-ref') throw new Error(`expected replacement action for ${change.name}`)
    const newScope = {
      actionKind: replacement.kind,
      contentIdentity: replacement.contentIdentity,
      evidenceKey: replacement.evidenceKey
    }
    expect(newScope, change.name).not.toEqual(oldScope)
    if (change.name !== 'content tree') {
      expect(replacement.evidenceKey, change.name).not.toBe(original.evidenceKey)
      expect(sameRemoteAuthority(originalAuthority, change.authority), change.name).toBe(false)
    }
    const published = objectiveLanding('pushed-ref', original.contentIdentity, {
      ...originalAuthority,
      revision: 1,
      remoteHeadSha: originalAuthority.headSha
    })
    const afterPublication = objectiveReducerWorld('hosted-review', change.authority, {
      contentIdentity: identity,
      remote: {
        authority: change.authority,
        remoteHeadSha: change.authority.headSha,
        review: null,
        problem: null
      },
      landings: [...world.landings!, published]
    })
    expect(nextStep(afterPublication, []).reason, change.name).toBe('landing-target-changed')
    const stopped = stopObjective({
      freshness: 'live',
      contentIdentity: identity,
      observedAtMs: 1,
      world: afterPublication
    }, [])
    expect(stopped).toMatchObject({
      kind: 'park',
      deviation: { naturalKey: 'landing-target-changed' }
    })
  }

  const gated = objectiveReducerWorld('pushed-ref', originalAuthority)
  const always = { ...gated, capabilities: { ...gated.capabilities, land: 'on' as const } }
  const turnedOff = { ...gated, capabilities: { ...gated.capabilities, land: 'off' as const } }
  expect(nextStep(gated, []).action).toMatchObject({ kind: 'push-ref', capability: 'land', visibility: 'external' })
  expect(nextStep(always, []).action).toMatchObject({ kind: 'push-ref', capability: 'land', visibility: 'external' })
  expect(nextStep(turnedOff, [])).toMatchObject({ action: null, reason: 'land-capability-off' })
})

test('three known no-effect failures exhaust one generation and resume preserves prior evidence', () => {
  const authority = objectiveAuthority()
  const world = objectiveReducerWorld('pushed-ref', authority)
  const journal: ObjectiveJournalEntry[] = []
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const action = nextStep(world, journal).action
    if (!action || action.kind !== 'push-ref') throw new Error('expected a known-no-effect push retry')
    expect(action.ordinal).toBe(ordinal)
    journal.push({
      seq: journal.length + 1,
      kind: 'attempt',
      attemptId: `push-${ordinal}`,
      action,
      state: 'settled',
      effect: 'not-landed'
    })
  }
  expect(nextStep(world, journal)).toMatchObject({
    action: null,
    reason: 'landing-retry-exhausted:push-ref'
  })
  const stopped = stopObjective({
    freshness: 'live',
    contentIdentity: world.contentIdentity!,
    observedAtMs: 1,
    world
  }, journal)
  expect(stopped).toMatchObject({
    kind: 'park',
    deviation: { naturalKey: 'landing-retry-exhausted:push-ref' }
  })

  journal.push({ seq: 4, kind: 'evidence', evidenceKind: 'operator-resume' })
  const resumed = nextStep(world, journal).action
  if (!resumed || resumed.kind !== 'push-ref') throw new Error('resume should open a fresh retry generation')
  expect(resumed).toMatchObject({ ordinal: 1, retryGeneration: 1 })
  expect(resumed.evidenceKey).not.toBe((journal[0]!.action as RemoteAction).evidenceKey)
  expect(journal).toHaveLength(4)
})

// Each case drives several isolated real Git worktrees and owned bare repositories.
test('remote actions revalidate checks, verdicts, committed trees, and dirty HEAD before mutation', async () => {
  const evidenceCases: Array<{
    name: string
    mutate: (rig: ReturnType<typeof remoteRig>) => void
    reason: string
  }> = [
    {
      name: 'stale criterion check',
      mutate: rig => { rig.checkRows.find(row => row.kind === 'criterion')!.status = 'stale' },
      reason: 'landing-evidence-incomplete'
    },
    {
      name: 'blocking reviewer verdict',
      mutate: rig => { rig.verdictRows.find(row => row.role === 'reviewer')!.verdict = 'block' },
      reason: 'landing-evidence-incomplete'
    },
    {
      name: 'committed local rung with a different SHA',
      mutate: rig => {
        rig.landingRows.find(row => row.rung === 'committed-local-branch')!.payload.headSha = H2
      },
      reason: 'remote-tree-not-committed'
    }
  ]
  for (const item of evidenceCases) {
    const rig = remoteRig({ landingBar: 'pushed-ref' })
    await rig.prepare()
    const action = await rig.action()
    item.mutate(rig)
    expect(await executeFixtureAction(rig, action, item.name), item.name).toMatchObject({
      effect: 'not-landed',
      reason: item.reason
    })
    expect(rig.processCalls.some(call => call.argv[1] === 'push'), item.name).toBe(false)
    expect(exactBareRef(rig.bare, action.authority.remoteRef), item.name).toBeNull()
    expect(rig.store.landings('objective-remote').some(row => row.rung === 'pushed-ref'), item.name).toBe(false)
  }

  const changedContent = remoteRig({ landingBar: 'pushed-ref' })
  await changedContent.prepare()
  const staleAction = await changedContent.action()
  writeFileSync(join(changedContent.root, 'src', 'main.ts'), 'changed after approval\n')
  expect(await executeFixtureAction(changedContent, staleAction, 'changed-content')).toMatchObject({
    effect: 'not-landed',
    reason: 'landing-evidence-stale'
  })
  expect(changedContent.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(changedContent.bare, staleAction.authority.remoteRef)).toBeNull()

  const changedHead = remoteRig({ landingBar: 'pushed-ref' })
  await changedHead.prepare()
  const oldHeadAction = await changedHead.action()
  execGit(changedHead.root, ['commit', '--quiet', '--allow-empty', '-m', 'Move local HEAD'], changedHead.dataDir)
  expect(await executeFixtureAction(changedHead, oldHeadAction, 'moved-head')).toMatchObject({
    effect: 'not-landed',
    reason: 'landing-evidence-stale'
  })
  expect(changedHead.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
}, 30_000)

test('remote push preserves outside-territory dirt after a real local commit', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref' })
  await rig.initGit()
  writeFileSync(join(rig.root, 'src', 'main.ts'), 'reviewed inside-territory content\n')
  writeFileSync(join(rig.root, 'outside.txt'), 'uncommitted outside-territory content\n')
  const prepared = await rig.prepareForLocalCommit()
  const localCommit = await commitLocalBranch(rig.runtime, {
    revision: 1,
    contentIdentity: prepared.contentIdentity,
    branch: prepared.branch,
    headSha: prepared.headSha
  }, 'outside-dirt-local-commit')
  expect(localCommit).toEqual({ effect: 'landed' })
  const committed = rig.store.landings('objective-remote').find(row => row.rung === 'committed-local-branch')
  const committedHead = committed?.payload.headSha
  if (typeof committedHead !== 'string') throw new Error('local commit did not record a committed HEAD')
  expect(committedHead).not.toBe(prepared.headSha)

  const observation = await rig.observe()
  const action = await rig.action(observation)
  expect(action.authority.headSha).toBe(committedHead)
  expect(await executeFixtureAction(rig, action, 'outside-dirt-push')).toEqual({ effect: 'landed' })
  expect(exactBareRef(rig.bare, action.authority.remoteRef)).toBe(action.authority.headSha)
  expect(execFileSync('git', ['--git-dir', rig.bare, 'show', `${action.authority.headSha}:src/main.ts`], {
    cwd: rig.root,
    env: isolatedGitEnvironment(rig.dataDir, rig.root),
    encoding: 'utf8'
  })).toBe('reviewed inside-territory content\n')
  const outsideBlob = spawnSync('git', ['--git-dir', rig.bare, 'cat-file', '-e', `${action.authority.headSha}:outside.txt`], {
    cwd: rig.root,
    env: isolatedGitEnvironment(rig.dataDir, rig.root)
  })
  expect(outsideBlob.status).not.toBe(0)
  expect(execGit(rig.root, ['status', '--porcelain', '--', 'outside.txt'], rig.dataDir).trim()).toBe('?? outside.txt')
}, 30_000)

test('remote authority is checked against the actual upstream destination before publication', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref' })
  await rig.prepare()
  const action = await rig.action()
  expect(action.authority.remoteRef).toBe('refs/heads/feature')

  // Git selects branch.<name>.merge when branch.<name>.remote is the chosen push remote.
  execGit(rig.root, ['config', 'branch.feature.remote', 'origin'], rig.dataDir)
  execGit(rig.root, ['config', 'branch.feature.merge', 'refs/heads/release'], rig.dataDir)
  expect(await executeFixtureAction(rig, action, 'retargeted-destination')).toMatchObject({
    effect: 'not-landed',
    reason: 'landing-evidence-stale'
  })
  expect(rig.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(rig.bare, 'refs/heads/feature')).toBeNull()
  expect(exactBareRef(rig.bare, 'refs/heads/release')).toBeNull()

  const hosted = remoteRig({ landingBar: 'hosted-review' })
  await hosted.prepare()
  const hostedAction = await hosted.action()
  hosted.setRepositoryPair(
    { host: 'github.com', owner: 'new-fork', repo: 'repo' },
    { host: 'github.com', owner: 'base-owner', repo: 'base-repo' }
  )
  expect(await executeFixtureAction(hosted, hostedAction, 'changed-repository')).toMatchObject({
    effect: 'not-landed',
    reason: 'landing-evidence-stale'
  })
  expect(hosted.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(hosted.bare, hostedAction.authority.remoteRef)).toBeNull()
})

test('invalid refs, option-like remotes, and multiple push URLs hold without mutation', async () => {
  const targetMutations: Array<{ label: string; configure: (rig: ReturnType<typeof remoteRig>) => void }> = [
    {
      label: 'option-like remote name',
      configure: rig => execGit(rig.root, ['config', 'remote.pushDefault', '--upload-pack=evil'], rig.dataDir)
    },
    {
      label: 'invalid destination ref',
      configure: rig => execGit(rig.root, ['config', 'branch.feature.merge', 'refs/heads/bad..ref'], rig.dataDir)
    },
    {
      label: 'multiple configured push URLs',
      configure: rig => {
        execGit(rig.root, ['config', '--add', 'remote.origin.pushurl', rig.bare], rig.dataDir)
        execGit(rig.root, ['config', '--add', 'remote.origin.pushurl', rig.bare], rig.dataDir)
      }
    }
  ]
  for (const item of targetMutations) {
    const rig = remoteRig({ landingBar: 'pushed-ref' })
    await rig.prepare()
    item.configure(rig)
    expect(await rig.observe(), item.label).toMatchObject({
      authority: null,
      problem: 'push-target-unavailable'
    })
    expect(rig.processCalls.some(call => call.argv[1] === 'push'), item.label).toBe(false)
    expect(exactBareRef(rig.bare), item.label).toBeNull()
  }
})

test('detached and unborn worktrees refuse remote landing without mutation', async () => {
  const detached = remoteRig({ landingBar: 'pushed-ref' })
  await detached.initGit()
  execGit(detached.root, ['checkout', '--quiet', '--detach', 'HEAD'], detached.dataDir)
  expect(await detached.observe()).toMatchObject({ authority: null, problem: 'branch-not-attached' })
  expect(detached.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(detached.bare)).toBeNull()

  const unborn = remoteRig({ landingBar: 'pushed-ref' })
  await unborn.initGit(false)
  expect(await unborn.observe()).toMatchObject({ authority: null, problem: 'head-unavailable' })
  expect(unborn.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(unborn.bare)).toBeNull()
})

test('non-fast-forward push rejection leaves the exact bare ref and landing rows unchanged', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref' })
  await rig.prepare()
  const competingDirectory = mkdtempSync(join(tmpdir(), 'objective-remote-competing-'))
  remoteCleanup.push(() => rmSync(competingDirectory, { recursive: true, force: true }))
  execGit(competingDirectory, ['init', '--quiet', '--initial-branch=feature'])
  execGit(competingDirectory, ['config', 'user.name', 'Competing Fixture'])
  execGit(competingDirectory, ['config', 'user.email', 'competing@example.test'])
  mkdirSync(join(competingDirectory, 'src'), { recursive: true })
  writeFileSync(join(competingDirectory, 'src', 'main.ts'), 'unrelated competing content\n')
  execGit(competingDirectory, ['add', '-A'])
  execGit(competingDirectory, ['commit', '--quiet', '-m', 'Unrelated root'])
  const competingSha = execGit(competingDirectory, ['rev-parse', 'HEAD']).trim()
  execGit(competingDirectory, ['push', '--', rig.bare, `${competingSha}:refs/heads/feature`])

  const action = await rig.action()
  expect(action.expectedState.before).toBe(competingSha)
  const outcome = await executeFixtureAction(rig, action, 'non-fast-forward')
  expect(outcome).toEqual({ effect: 'not-landed', reason: 'push-rejected' })
  expect(exactBareRef(rig.bare, action.authority.remoteRef)).toBe(competingSha)
  expect(rig.store.landings('objective-remote').some(row => row.rung === 'pushed-ref')).toBe(false)
})

async function stopFromPreActionSnapshot(
  rig: ReturnType<typeof remoteRig>,
  observation: RemoteObservation,
  contentIdentity: string
) {
  const hooks = createObjectiveHooks(rig.context, rig.store)
  const enrollment = {
    watcherId: 'objective-remote',
    kind: 'objective',
    workspacePath: rig.root,
    worktreeId: 'remote-worktree',
    kindPayload: rig.payload,
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'gated' }
  }
  return hooks.stop({
    snapshot: {
      freshness: 'live',
      contentIdentity,
      observedAtMs: 100,
      world: rig.world(observation)
    },
    journal: rig.journal,
    enrollment
  } as never)
}

// The post-action stop cases use real push/ref mutations and fresh Git observations.
test('stop refreshes remote evidence after a push and still parks genuine fresh retargets', async () => {
  const pushed = remoteRig({ landingBar: 'pushed-ref' })
  const contentIdentity = await pushed.prepare()
  const before = await pushed.observe()
  const action = await pushed.action(before)
  expect(await executeFixtureAction(pushed, action, 'push-before-stop')).toEqual({ effect: 'landed' })
  expect(await stopFromPreActionSnapshot(pushed, before, contentIdentity)).toEqual({
    kind: 'terminal',
    state: 'landed',
    reason: 'pushed-ref landing bar reached'
  })

  const hosted = remoteRig({ landingBar: 'hosted-review' })
  const hostedContent = await hosted.prepare()
  const hostedBefore = await hosted.observe()
  const hostedAction = await hosted.action(hostedBefore)
  expect(await executeFixtureAction(hosted, hostedAction, 'hosted-push-before-stop')).toEqual({ effect: 'landed' })
  expect(await stopFromPreActionSnapshot(hosted, hostedBefore, hostedContent)).toBeNull()
  const afterPush = await hosted.observe()
  const reviewContinuation = nextStep(hosted.world(afterPush), hosted.journal)
  expect(reviewContinuation, `review continuation was held: ${reviewContinuation.reason ?? 'no action'}`)
    .toMatchObject({ action: { kind: 'open-hosted-review' } })

  const retargeted = remoteRig({ landingBar: 'pushed-ref' })
  const retargetedContent = await retargeted.prepare()
  const retargetedBefore = await retargeted.observe()
  const retargetedAction = await retargeted.action(retargetedBefore)
  expect(await executeFixtureAction(retargeted, retargetedAction, 'push-before-retarget')).toEqual({ effect: 'landed' })
  const tree = execGit(retargeted.root, ['rev-parse', `${retargetedAction.authority.headSha}^{tree}`], retargeted.dataDir).trim()
  const movedSha = execGit(retargeted.root, [
    'commit-tree', tree, '-p', retargetedAction.authority.headSha, '-m', 'External ref movement'
  ], retargeted.dataDir).trim()
  execGit(retargeted.root, [
    'push', '--quiet', '--', retargeted.bare,
    `${movedSha}:${retargetedAction.authority.remoteRef}`
  ], retargeted.dataDir)
  expect(await stopFromPreActionSnapshot(retargeted, retargetedBefore, retargetedContent)).toMatchObject({
    kind: 'park',
    deviation: { naturalKey: 'landing-target-changed' }
  })

  const dirty = remoteRig({ landingBar: 'pushed-ref' })
  const cleanIdentity = await dirty.prepare()
  const dirtyBefore = await dirty.observe()
  const dirtyAction = await dirty.action(dirtyBefore)
  expect(await executeFixtureAction(dirty, dirtyAction, 'push-before-content-drift')).toEqual({ effect: 'landed' })
  writeFileSync(join(dirty.root, 'src', 'main.ts'), 'new content after publication\n')
  expect(await stopFromPreActionSnapshot(dirty, dirtyBefore, cleanIdentity)).toMatchObject({
    kind: 'park',
    deviation: { naturalKey: 'landing-target-changed' }
  })
}, 30_000)

test('store v3 migration preserves v2 rows and immutable remote landings across reopen', () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-store-v3-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-store-v3-data-'))
  remoteCleanup.push(() => rmSync(home, { recursive: true, force: true }))
  remoteCleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const storeDirectory = join(home, 'plugin-data', 'quirky.objective')
  mkdirSync(storeDirectory, { recursive: true })
  const storeFile = join(storeDirectory, 'store.db')
  const oldFiles: LandingRecord = {
    watcherId: 'legacy-watcher',
    rung: 'files-on-disk',
    contentIdentity: `objective-tree:${'a'.repeat(40)}`,
    attemptId: 'legacy-files',
    payload: { revision: 1, tasks: [{ taskKey: 'old-task', state: 'succeeded' }] },
    recordedAtMs: 10
  }
  const oldCommit: LandingRecord = {
    ...oldFiles,
    rung: 'committed-local-branch',
    attemptId: 'legacy-commit',
    payload: { revision: 1, headSha: H1 },
    recordedAtMs: 11
  }
  const legacyDb = new Database(storeFile)
  try {
    legacyDb.exec(`
      CREATE TABLE landing (
        watcher_id TEXT NOT NULL,
        rung TEXT NOT NULL CHECK (rung IN ('files-on-disk','committed-local-branch')),
        content_identity TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (watcher_id, rung, content_identity)
      );
      PRAGMA user_version = 2;
    `)
    const insert = legacyDb.query('INSERT INTO landing VALUES (?,?,?,?,?,?)')
    for (const row of [oldFiles, oldCommit]) {
      insert.run(row.watcherId, row.rung, row.contentIdentity, row.attemptId, JSON.stringify(row.payload), row.recordedAtMs)
    }
  } finally {
    legacyDb.close()
  }

  const identity = `objective-tree:${OBJECTIVE_TREE}`
  const authority = objectiveAuthority({
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    baseRefName: 'main'
  })
  const push = landedAuthority(authority, identity, 'pushed-ref', { remoteHeadSha: authority.headSha })
  const review: ObjectiveExpectedReview = {
    number: 7,
    url: 'https://github.com/base-owner/base-repo/pull/7',
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    headRefName: authority.branch,
    baseRefName: authority.baseRefName!,
    headSha: authority.headSha
  }
  const hosted = landedAuthority(authority, identity, 'hosted-review', { review })
  const opened = persistentStore(home, dataDir)
  try {
    opened.store.recordLanding(push)
    opened.store.recordLanding(hosted)
    opened.store.recordLanding({
      ...push,
      attemptId: 'replacement-attempt',
      payload: { ...push.payload, remoteHeadSha: H2 },
      recordedAtMs: 999
    })
    expect(opened.store.landings('legacy-watcher')).toEqual([oldFiles, oldCommit])
    expect(opened.store.landings('objective-1')).toContainEqual(push)
    expect(opened.store.landings('objective-1')).toContainEqual(hosted)
    expect(opened.store.landings('objective-1').find(row => row.rung === 'pushed-ref')).toEqual(push)
  } finally {
    opened.close()
  }

  const reopened = persistentStore(home, dataDir)
  try {
    expect(reopened.store.landings('legacy-watcher')).toEqual([oldFiles, oldCommit])
    expect(reopened.store.landings('objective-1')).toContainEqual(expect.objectContaining({
      rung: 'pushed-ref',
      attemptId: 'attempt-pushed-ref',
      payload: expect.objectContaining({ remoteHeadSha: OBJECTIVE_HEAD })
    }))
    expect(reopened.store.landings('objective-1')).toContainEqual(expect.objectContaining({
      rung: 'hosted-review',
      payload: expect.objectContaining({ review })
    }))
  } finally {
    reopened.close()
  }
  const versionDb = new Database(storeFile)
  try {
    expect(versionDb.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
  } finally {
    versionDb.close()
  }
})

test('remote uncertainty survives restart and resolves from the original ref without a second mutation', async () => {
  const rig = remoteRig({ landingBar: 'pushed-ref', tier: 'express' })
  const contentIdentity = await rig.prepare()
  const action = await rig.action()
  const home = mkdtempSync(join(tmpdir(), 'objective-uncertain-store-'))
  remoteCleanup.push(() => rmSync(home, { recursive: true, force: true }))

  let opened = persistentStore(home, rig.dataDir)
  persistRevision(opened.store, 'objective-remote', rig.plan)
  opened.store.recordLanding({
    watcherId: 'objective-remote',
    rung: 'files-on-disk',
    contentIdentity,
    attemptId: 'initial-files',
    payload: { revision: 1 },
    recordedAtMs: 1
  })
  opened.store.recordLanding({
    watcherId: 'objective-remote',
    rung: 'committed-local-branch',
    contentIdentity,
    attemptId: 'initial-commit',
    payload: { revision: 1, headSha: action.authority.headSha },
    recordedAtMs: 2
  })
  rig.runtime.store = opened.store

  let pushCount = 0
  let remoteReadUnavailable = false
  rig.setProcessInterceptor((argv, _options, run) => {
    if (argv[1] === 'push') {
      pushCount++
      const result = run()
      remoteReadUnavailable = true
      return { ...result, exitCode: null, stopped: 'timeout' as const }
    }
    if (argv[1] === 'ls-remote' && remoteReadUnavailable) {
      return runResult('', 128, 'exact-ref read timed out')
    }
    return run()
  })

  try {
    const effect = await executeFixtureAction(rig, action, 'ambiguous-push')
    expect(effect).toEqual({ effect: 'indeterminate', reason: 'landing-outcome-indeterminate' })
    expect(pushCount).toBe(1)
    expect(exactBareRef(rig.bare, action.authority.remoteRef)).toBe(action.authority.headSha)
    rig.journal.push({
      seq: rig.journal.length + 1,
      kind: 'attempt',
      attemptId: 'ambiguous-push',
      action,
      state: 'running',
      effect: 'indeterminate'
    })
    expect(await resolveRemoteLandingOutcome(rig.runtime, action, 'ambiguous-push', 'remote-worktree')).toBeNull()
    expect(opened.store.landings('objective-remote').some(row => row.rung === 'pushed-ref')).toBe(false)

    remoteReadUnavailable = false
    const fresh = await rig.observe()
    expect(nextStep(rig.world(fresh), rig.journal)).toMatchObject({
      action: null,
      reason: 'landing-outcome-indeterminate'
    })
    opened.close()

    opened = persistentStore(home, rig.dataDir)
    rig.runtime.store = opened.store
    const afterRestart = await rig.observe()
    expect(nextStep(rig.world(afterRestart), rig.journal)).toMatchObject({
      action: null,
      reason: 'landing-outcome-indeterminate'
    })
    const callsBeforeResolution = rig.processCalls.length
    expect(await resolveRemoteLandingOutcome(rig.runtime, action, 'ambiguous-push', 'remote-worktree'))
      .toEqual({ effect: 'landed' })
    expect(opened.store.landings('objective-remote')).toContainEqual(expect.objectContaining({
      rung: 'pushed-ref',
      contentIdentity,
      payload: expect.objectContaining({
        remoteRef: action.authority.remoteRef,
        remoteHeadSha: action.authority.headSha
      })
    }))
    const recoveryCalls = rig.processCalls.slice(callsBeforeResolution)
    expect(recoveryCalls.some(call => call.argv[1] === 'push')).toBe(false)
    expect(recoveryCalls.some(call =>
      call.argv[1] === 'ls-remote' && call.argv.at(-1) === action.authority.remoteRef
    )).toBe(true)
    expect(pushCount).toBe(1)
  } finally {
    opened.close()
  }
})

// Pre/post-push eligibility cases each execute real Git against their own bare remote.
test('creation blockers prevent an unremediable pre-push and rechecked post-push review', async () => {
  const blockedBeforePush = remoteRig({ landingBar: 'hosted-review' })
  await blockedBeforePush.prepare()
  const blockedAction = await blockedBeforePush.action()
  blockedBeforePush.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'dirty_tree' }]
  }))
  expect(await executeFixtureAction(blockedBeforePush, blockedAction, 'blocked-before-push')).toMatchObject({
    effect: 'not-landed',
    reason: 'creation-blocked:dirty_tree'
  })
  expect(blockedBeforePush.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(blockedBeforePush.bare, blockedAction.authority.remoteRef)).toBeNull()

  const remedyable = remoteRig({ landingBar: 'hosted-review' })
  await remedyable.prepare()
  remedyable.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'no_upstream' }]
  }))
  const remedyableObservation = await remedyable.observe()
  expect(remedyableObservation.problem).toBeNull()
  expect((await remedyable.action(remedyableObservation)).kind).toBe('push-ref')

  const branchAhead = remoteRig({ landingBar: 'hosted-review' })
  await branchAhead.prepare()
  branchAhead.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'branch_ahead' }]
  }))
  const branchAheadObservation = await branchAhead.observe()
  expect(branchAheadObservation.problem).toBeNull()
  const branchAheadAction = await branchAhead.action(branchAheadObservation)
  expect(branchAheadAction.kind).toBe('push-ref')
  expect(await executeFixtureAction(branchAhead, branchAheadAction, 'branch-ahead-remedy'))
    .toEqual({ effect: 'landed' })
  expect(exactBareRef(branchAhead.bare, branchAheadAction.authority.remoteRef))
    .toBe(branchAheadAction.authority.headSha)

  const existingReview = remoteRig({ landingBar: 'hosted-review' })
  await existingReview.prepare()
  const unreviewed = await existingReview.observe()
  if (!unreviewed.authority) throw new Error('existing-review target unavailable')
  const exactExisting = existingReview.reviewFor(unreviewed.authority)
  existingReview.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'existing_review' }],
    review: exactExisting
  }))
  const existingObservation = await existingReview.observe()
  expect(existingObservation.problem).toBeNull()
  expect((await existingReview.action(existingObservation)).kind).toBe('push-ref')
  const existingAction = await existingReview.action(existingObservation)
  expect(await executeFixtureAction(existingReview, existingAction, 'validated-existing-review'))
    .toEqual({ effect: 'landed' })
  expect(exactBareRef(existingReview.bare, existingAction.authority.remoteRef))
    .toBe(existingAction.authority.headSha)
  expect(existingReview.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toEqual([])

  const invalidExistingReview = remoteRig({ landingBar: 'hosted-review' })
  await invalidExistingReview.prepare()
  const invalidTarget = await invalidExistingReview.observe()
  if (!invalidTarget.authority) throw new Error('invalid-existing-review target unavailable')
  const wrongExisting = invalidExistingReview.reviewFor(invalidTarget.authority, { headRefName: 'main' })
  invalidExistingReview.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'existing_review' }],
    review: wrongExisting
  }))
  expect(await invalidExistingReview.observe()).toMatchObject({ problem: 'review-identity-mismatch' })
  expect(invalidExistingReview.processCalls.some(call => call.argv[1] === 'push')).toBe(false)
  expect(exactBareRef(invalidExistingReview.bare)).toBeNull()

  const afterPush = remoteRig({ landingBar: 'hosted-review' })
  await afterPush.prepare()
  const before = await afterPush.observe()
  const push = await afterPush.action(before)
  let eligibilityCalls = 0
  afterPush.setCallHandler('quirky.hosting/creationEligibility', () => {
    eligibilityCalls++
    return eligibilityCalls < 3
      ? { eligible: true, defaultBase: 'main', blockers: [] }
      : { eligible: false, defaultBase: 'main', blockers: [{ reason: 'default_branch' }] }
  })
  expect(await executeFixtureAction(afterPush, push, 'post-push-recheck')).toEqual({ effect: 'landed' })
  expect(exactBareRef(afterPush.bare, push.authority.remoteRef)).toBe(push.authority.headSha)
  const rechecked = await afterPush.observe()
  expect(rechecked.problem).toBe('creation-blocked:default_branch')
  expect(nextStep(afterPush.world(rechecked), afterPush.journal)).toMatchObject({
    action: null,
    reason: 'creation-blocked:default_branch'
  })
  expect(afterPush.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toEqual([])
}, 30_000)

// Review creation and recovery are exercised against several independent real bare refs.
test('hosted-review creates or reuses only the exact pushed review', async () => {
  const objectiveText = `\n${'Launch the approved remote objective '.repeat(12)}`
  const created = remoteRig({ landingBar: 'hosted-review', objectiveText })
  const { authority, action, observation } = await preparePushedHostedReview(created)
  if (action.kind !== 'open-hosted-review') throw new Error('expected review action after exact push')
  expect(action.expectedState).toEqual({
    target: remoteExpectedStateTarget('open-hosted-review', authority),
    before: null
  })
  expect(action.review).toBeUndefined()

  const expected = created.reviewFor(authority)
  let liveReview: Record<string, unknown> | null = null
  let branchLookups = 0
  let createParams: Record<string, unknown> | null = null
  created.plan.plan.tasks[0]!.criteria[0]!.body = `approved criterion ${'c'.repeat(61_000)}`
  created.setCallHandler('quirky.hosting/creationEligibility', () => liveReview
    ? { eligible: false, defaultBase: 'main', blockers: [{ reason: 'existing_review' }], review: liveReview }
    : { eligible: true, defaultBase: 'main', blockers: [] })
  created.setCallHandler('quirky.hosting/forBranch', () => {
    branchLookups++
    return branchLookups === 1
      ? { kind: 'no-review' }
      : { kind: 'found', review: liveReview }
  })
  created.setCallHandler('quirky.hosting/create', params => {
    createParams = params
    liveReview = expected
    return { number: 7, url: expected.url }
  })
  created.setCallHandler('quirky.hosting/review', params =>
    params.number === expected.number ? { kind: 'found', review: liveReview } : { kind: 'no-review' })

  expect(await executeFixtureAction(created, action, 'create-hosted-review')).toEqual({ effect: 'landed' })
  expect(created.store.landings('objective-remote')).toContainEqual(expect.objectContaining({
    rung: 'hosted-review',
    payload: expect.objectContaining({ review: expect.objectContaining({
      number: 7,
      url: expected.url,
      headSha: authority.headSha,
      headRepository: authority.headRepository
    }) })
  }))
  expect(createParams).not.toBeNull()
  const params = createParams!
  const expectedTitle = objectiveText.split(/\r?\n/u).find(line => line.trim())!.trim().slice(0, 120)
  expect(params.title).toBe(expectedTitle)
  expect((params.title as string).length).toBe(120)
  expect(typeof params.body).toBe('string')
  expect((params.body as string).length).toBe(60_000)
  expect(params.body).toContain(objectiveText.trimStart())
  expect(params.body).toContain('Approved plan criteria:')
  expect(params.body).toContain('approved criterion')
  expect((params.body as string).endsWith('[Approved objective and plan criteria truncated at 60,000 characters.]')).toBe(true)
  expect(params.expected).toEqual({
    branch: authority.branch,
    headSha: authority.headSha,
    baseRefName: authority.baseRefName,
    repository: authority.repository,
    headRepository: authority.headRepository
  })
  expect(branchLookups).toBe(2)
  expect(created.contextCalls.filter(call => call.method === 'quirky.hosting/review')).toHaveLength(1)
  expect(created.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toHaveLength(1)
  expect(created.contextCalls.filter(call => call.method === 'quirky.hosting/creationEligibility')
    .every(call => !Object.hasOwn(call.params, 'body'))).toBe(true)
  const hostedStop = await stopFromPreActionSnapshot(created, observation, await created.runtime.captureContentIdentity())
  expect(hostedStop).toMatchObject({
    kind: 'terminal',
    state: 'landed',
    reason: 'hosted-review landing bar reached',
    handoff: {
      kind: 'hosted-review',
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' },
      kindPayload: {
        worktree: 'id:remote-worktree',
        expectedReview: expect.objectContaining({ headSha: authority.headSha }),
        branchUpdateMode: 'merge-base-update',
        mergeCheckScope: 'all',
        mergeMethod: null
      }
    }
  })

  const reused = remoteRig({ landingBar: 'hosted-review' })
  await reused.prepare()
  reused.setRepositoryPair(OBJECTIVE_HEAD_REPOSITORY, OBJECTIVE_BASE_REPOSITORY)
  const unpushed = await reused.observe()
  if (!unpushed.authority) throw new Error(`fork target unavailable: ${unpushed.problem}`)
  execGit(reused.root, ['push', '--', reused.bare, `${unpushed.authority.headSha}:${unpushed.authority.remoteRef}`], reused.dataDir)
  await reused.addPushedLanding(unpushed.authority)
  const existing = reused.reviewFor(unpushed.authority)
  reused.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'existing_review' }],
    review: existing
  }))
  const current = await reused.observe()
  expect(current.review).toMatchObject({
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    headSha: unpushed.authority.headSha
  })
  const reuseAction = await reused.action(current)
  if (reuseAction.kind !== 'open-hosted-review') throw new Error('expected a review reuse action')
  expect(reuseAction.expectedState.before).toMatchObject({
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY
  })
  reused.setCallHandler('quirky.hosting/forBranch', () => ({ kind: 'found', review: existing }))
  expect(await executeFixtureAction(reused, reuseAction, 'reuse-hosted-review')).toEqual({ effect: 'landed' })
  expect(reused.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toEqual([])
  expect(reused.store.landings('objective-remote')).toContainEqual(expect.objectContaining({
    rung: 'hosted-review',
    payload: expect.objectContaining({ review: expect.objectContaining({
      repository: OBJECTIVE_BASE_REPOSITORY,
      headRepository: OBJECTIVE_HEAD_REPOSITORY
    }) })
  }))

  const failures = remoteRig({ landingBar: 'hosted-review' })
  await failures.prepare()
  failures.setRepositoryPair(OBJECTIVE_HEAD_REPOSITORY, OBJECTIVE_BASE_REPOSITORY)
  const beforeFailures = await failures.observe()
  if (!beforeFailures.authority) throw new Error(`fork review target unavailable: ${beforeFailures.problem}`)
  execGit(failures.root, ['push', '--', failures.bare, `${beforeFailures.authority.headSha}:${beforeFailures.authority.remoteRef}`], failures.dataDir)
  await failures.addPushedLanding(beforeFailures.authority)
  const expectedExisting = failures.reviewFor(beforeFailures.authority)
  failures.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'existing_review' }],
    review: expectedExisting
  }))
  const existingObservation = await failures.observe()
  const failureAction = await failures.action(existingObservation)
  if (failureAction.kind !== 'open-hosted-review') throw new Error('expected review action for failure cases')

  const failureCases: Array<{
    name: string
    result: unknown
    reason: string
  }> = [
    { name: 'review-lookup-unavailable', result: { kind: 'unavailable', message: 'offline' }, reason: 'review-lookup-unavailable' },
    {
      name: 'review-identity-mismatch',
      result: { kind: 'found', review: { ...expectedExisting, headRefName: 'other-branch' } },
      reason: 'landing-evidence-stale'
    },
    { name: 'review-not-open', result: { kind: 'found', review: { ...expectedExisting, state: 'closed' } }, reason: 'review-not-open' },
    { name: 'review-is-draft', result: { kind: 'found', review: { ...expectedExisting, state: 'draft' } }, reason: 'review-is-draft' },
    { name: 'multiple-review-results', result: { kind: 'multiple', reviews: [expectedExisting, expectedExisting] }, reason: 'review-lookup-unavailable' }
  ]
  for (const item of failureCases) {
    failures.setCallHandler('quirky.hosting/forBranch', () => item.result)
    expect(await executeFixtureAction(failures, failureAction, item.name), item.name).toMatchObject({
      effect: 'not-landed',
      reason: item.reason
    })
  }
  expect(failures.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toEqual([])
  expect(failures.store.landings('objective-remote').some(row => row.rung === 'hosted-review')).toBe(false)

  const blockedCreation = remoteRig({ landingBar: 'hosted-review' })
  const blockedSetup = await preparePushedHostedReview(blockedCreation)
  blockedCreation.setCallHandler('quirky.hosting/forBranch', () => ({ kind: 'no-review' }))
  blockedCreation.setCallHandler('quirky.hosting/creationEligibility', () => ({
    eligible: false,
    defaultBase: 'main',
    blockers: [{ reason: 'permission_denied' }]
  }))
  expect(await executeFixtureAction(blockedCreation, blockedSetup.action, 'blocked-review-create')).toMatchObject({
    effect: 'not-landed',
    reason: 'creation-blocked:permission_denied'
  })
  expect(blockedCreation.contextCalls.filter(call => call.method === 'quirky.hosting/create')).toEqual([])
  expect(blockedCreation.store.landings('objective-remote').some(row => row.rung === 'hosted-review')).toBe(false)
}, 30_000)

function objectiveProjectionRig(landingBar: 'hosted-review' | 'merged') {
  const sourceId = 'objective-source'
  const childId = 'review-successor'
  const workspacePath = '/owned/objective-projection-worktree'
  const worktreeId = 'wt-projection'
  const contentIdentity = `objective-tree:${OBJECTIVE_TREE}`
  const authority = objectiveAuthority({
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    baseRefName: 'main'
  })
  const review: ObjectiveExpectedReview = {
    number: 7,
    url: 'https://github.com/base-owner/base-repo/pull/7',
    repository: OBJECTIVE_BASE_REPOSITORY,
    headRepository: OBJECTIVE_HEAD_REPOSITORY,
    headRefName: authority.branch,
    baseRefName: authority.baseRefName!,
    headSha: authority.headSha
  }
  const payload = objectivePayloadFor(landingBar)
  const sourceSummary = {
    watcherId: sourceId,
    kind: 'objective',
    state: landingBar === 'merged' ? 'handed-off' : 'landed',
    reason: landingBar === 'merged'
      ? 'hosted-review reached; awaiting merged landing bar'
      : 'hosted-review landing bar reached',
    atMs: 90
  }
  const sourceInspection = {
    enrollment: {
      watcherId: sourceId,
      kind: 'objective',
      workspacePath,
      worktreeId,
      kindPayload: payload,
      capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'gated' },
      terminalAtMs: 100,
      enabled: true
    },
    journal: [{
      seq: 1,
      kind: 'terminal',
      handoff: { watcherId: childId, kind: 'hosted-review' }
    }],
    status: { state: 'closed' },
    summary: sourceSummary
  }
  const childPayload = {
    worktreeId,
    branch: authority.branch,
    headRefName: review.headRefName,
    provider: 'github',
    reviewNumber: review.number,
    reviewUrl: review.url,
    repository: review.repository,
    expectedReview: review,
    branchUpdateMode: 'merge-base-update',
    mergeCheckScope: 'all',
    mergeMethod: null
  }
  const baseChild = {
    enrollment: {
      watcherId: childId,
      kind: 'hosted-review',
      workspacePath,
      worktreeId,
      kindPayload: childPayload,
      enabled: true,
      paused: false,
      parkReason: null,
      terminalAtMs: null
    },
    journal: [],
    status: { state: 'active' },
    summary: null
  }
  const landing: LandingRecord = {
    watcherId: sourceId,
    rung: 'hosted-review',
    contentIdentity,
    attemptId: 'confirmed-hosted-review',
    payload: { ...authority, revision: 1, review },
    recordedAtMs: 50
  }
  const revision = {
    watcherId: sourceId,
    number: 1,
    plan: { plan: { tasks: [] }, assumptions: [] },
    digest: 'projection-plan',
    sourceAttemptId: 'projection-planner',
    approvedAtMs: 1
  }
  const store = {
    revision(watcherId: string) { return watcherId === sourceId ? revision : null },
    issued() { return [] },
    reports() { return [] },
    report() { return null },
    checks() { return [] },
    verdicts() { return [] },
    landings(watcherId: string) { return watcherId === sourceId ? [landing] : [] },
    rejectedDrafts() { return [] },
    overruns() { return [] },
    repairs() { return [] }
  } as unknown as ObjectiveStore
  let childMode: 'present' | 'missing' | 'malformed' | 'unreadable' = 'present'
  let child: Record<string, unknown> = structuredClone(baseChild)
  const processCalls: string[] = []
  const context = {
    dataDir: '/owned/objective-projection-home',
    process: {
      async run(argv: readonly string[]) {
        processCalls.push(argv.join(' '))
        throw new Error('terminal history must not recapture Git')
      }
    },
    async call(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (method !== 'quirky.heimdall/inspect') throw new Error(`unexpected projection call: ${method}`)
      if (params.watcherId === sourceId) return [sourceInspection]
      if (params.watcherId !== childId) return []
      if (childMode === 'missing') return []
      if (childMode === 'unreadable') throw new Error('successor inspection unavailable')
      if (childMode === 'malformed') {
        const malformed = {
          ...child,
          enrollment: { ...(child.enrollment as Record<string, unknown>), malformed: 'invalid payload' },
          status: { state: 'malformed' }
        }
        return [malformed]
      }
      return [child]
    }
  } as unknown as PluginContext

  return {
    sourceId,
    childId,
    worktreeId,
    workspacePath,
    contentIdentity,
    authority,
    review,
    sourceSummary,
    baseChild,
    processCalls,
    store,
    context,
    setChild(value: Record<string, unknown>) { child = value; childMode = 'present' },
    setChildMode(value: typeof childMode) { childMode = value },
    detail() {
      const hooks = createObjectiveHooks(context, store)
      return hooks.detail({ watcherId: sourceId })
    }
  }
}

test('handoff reports hosted-review completion but never premature merged completion', async () => {
  const hosted = objectiveProjectionRig('hosted-review')
  const hostedDetail = await hosted.detail()
  expect(hostedDetail?.completion).toEqual({
    requestedBar: 'hosted-review',
    reachedBar: 'hosted-review',
    state: 'landed',
    reason: 'hosted-review landing bar reached',
    handoff: { watcherId: hosted.childId, kind: 'hosted-review' },
    mergedEvidence: null
  })
  expect(hostedDetail?.next.reason).toBe('objective-bar-reached')
  expect(hosted.processCalls).toEqual([])

  const merged = objectiveProjectionRig('merged')
  const waiting = await merged.detail()
  expect(waiting?.completion).toEqual({
    requestedBar: 'merged',
    reachedBar: 'hosted-review',
    state: 'waiting',
    reason: 'awaiting-sitter-merge',
    handoff: { watcherId: merged.childId, kind: 'hosted-review' },
    mergedEvidence: null
  })
  expect(waiting?.next.reason).toBe('awaiting-sitter-merge')
  expect(merged.sourceSummary.state).toBe('handed-off')
  expect(merged.processCalls).toEqual([])

  const handoffAuthority = merged.authority
  const pushLanding = objectiveLanding('pushed-ref', merged.contentIdentity, {
    ...handoffAuthority,
    revision: 1,
    remoteHeadSha: handoffAuthority.headSha
  })
  const hostedLanding = objectiveLanding('hosted-review', merged.contentIdentity, {
    ...handoffAuthority,
    revision: 1,
    review: merged.review
  })
  const policyWorld = objectiveReducerWorld('merged', handoffAuthority, {
    worktreeId: merged.worktreeId,
    remote: { authority: handoffAuthority, remoteHeadSha: handoffAuthority.headSha, review: merged.review, problem: null },
    landings: [
      ...objectiveReducerWorld('merged', handoffAuthority).landings!,
      pushLanding,
      hostedLanding
    ]
  })
  const handoff = stopObjective({
    freshness: 'live',
    contentIdentity: merged.contentIdentity,
    observedAtMs: 100,
    world: policyWorld
  }, [])
  expect(handoff).toMatchObject({
    kind: 'terminal',
    state: 'handed-off',
    reason: 'hosted-review reached; awaiting merged landing bar',
    handoff: {
      kind: 'hosted-review',
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
      kindPayload: {
        worktree: 'id:wt-projection',
        expectedReview: merged.review,
        branchUpdateMode: 'merge-base-update',
        mergeCheckScope: 'all',
        mergeMethod: null
      }
    }
  })
  if (!handoff || handoff.kind !== 'terminal' || !handoff.handoff) {
    throw new Error('expected the merged-bar terminal handoff')
  }
  expect(handoff.handoff.kindPayload).toEqual({
    worktree: 'id:wt-projection',
    expectedReview: merged.review,
    branchUpdateMode: 'merge-base-update',
    mergeCheckScope: 'all',
    mergeMethod: null
  })
})

test('merged waits for the pinned sitter merge and survives restart', async () => {
  const rig = objectiveProjectionRig('merged')
  const active = await rig.detail()
  expect(active?.completion).toMatchObject({
    reachedBar: 'hosted-review',
    state: 'waiting',
    reason: 'awaiting-sitter-merge'
  })

  const terminalChild: Record<string, unknown> = structuredClone(rig.baseChild)
  terminalChild.enrollment = {
    ...(terminalChild.enrollment as Record<string, unknown>),
    terminalAtMs: 200
  }
  terminalChild.status = { state: 'closed' }
  terminalChild.summary = {
    watcherId: rig.childId,
    kind: 'hosted-review',
    state: 'merged',
    reason: 'review merged',
    atMs: 190
  }
  rig.setChild(terminalChild)
  const afterRestart = await rig.detail()
  expect(afterRestart?.completion).toEqual({
    requestedBar: 'merged',
    reachedBar: 'merged',
    state: 'landed',
    reason: 'merged landing bar reached',
    handoff: { watcherId: rig.childId, kind: 'hosted-review' },
    mergedEvidence: { review: rig.review, watcherId: rig.childId, observedAtMs: 190 }
  })
  expect(afterRestart?.next.reason).toBe('objective-bar-reached')
  expect(rig.sourceSummary.state).toBe('handed-off')

  const blockedCases: Array<{ name: string; update: (child: Record<string, unknown>) => Record<string, unknown>; reason: string }> = [
    {
      name: 'wrong child kind',
      update: child => ({ ...child, enrollment: { ...(child.enrollment as Record<string, unknown>), kind: 'sitter' } }),
      reason: 'sitter-kind-mismatch'
    },
    {
      name: 'wrong workspace path',
      update: child => ({ ...child, enrollment: { ...(child.enrollment as Record<string, unknown>), workspacePath: '/other/worktree' } }),
      reason: 'sitter-workspace-mismatch'
    },
    {
      name: 'wrong worktree',
      update: child => ({ ...child, enrollment: { ...(child.enrollment as Record<string, unknown>), worktreeId: 'other-worktree' } }),
      reason: 'sitter-workspace-mismatch'
    },
    {
      name: 'moved head SHA',
      update: child => {
        const enrollment = child.enrollment as Record<string, unknown>
        const kindPayload = enrollment.kindPayload as Record<string, unknown>
        return { ...child, enrollment: { ...enrollment, kindPayload: {
          ...kindPayload,
          expectedReview: { ...rig.review, headSha: H2 }
        } } }
      },
      reason: 'objective-review-mismatch'
    },
    {
      name: 'fork head repository',
      update: child => {
        const enrollment = child.enrollment as Record<string, unknown>
        const kindPayload = enrollment.kindPayload as Record<string, unknown>
        return { ...child, enrollment: { ...enrollment, kindPayload: {
          ...kindPayload,
          expectedReview: { ...rig.review, headRepository: { host: 'github.com', owner: 'different-fork', repo: 'fork-repo' } }
        } } }
      },
      reason: 'objective-review-mismatch'
    },
    {
      name: 'base ref',
      update: child => {
        const enrollment = child.enrollment as Record<string, unknown>
        const kindPayload = enrollment.kindPayload as Record<string, unknown>
        return { ...child, enrollment: { ...enrollment, kindPayload: {
          ...kindPayload,
          expectedReview: { ...rig.review, baseRefName: 'release' }
        } } }
      },
      reason: 'objective-review-mismatch'
    },
    {
      name: 'review number',
      update: child => {
        const enrollment = child.enrollment as Record<string, unknown>
        const kindPayload = enrollment.kindPayload as Record<string, unknown>
        return { ...child, enrollment: { ...enrollment, kindPayload: {
          ...kindPayload,
          expectedReview: { ...rig.review, number: 8, url: 'https://github.com/base-owner/base-repo/pull/8' }
        } } }
      },
      reason: 'objective-review-mismatch'
    },
    {
      name: 'review URL',
      update: child => {
        const enrollment = child.enrollment as Record<string, unknown>
        const kindPayload = enrollment.kindPayload as Record<string, unknown>
        return { ...child, enrollment: { ...enrollment, kindPayload: {
          ...kindPayload,
          expectedReview: { ...rig.review, url: 'https://github.com/base-owner/base-repo/pull/8' }
        } } }
      },
      reason: 'objective-review-mismatch'
    },
    {
      name: 'parked successor',
      update: child => ({ ...child, status: { state: 'parked' } }),
      reason: 'sitter-parked'
    },
    {
      name: 'disabled successor',
      update: child => ({
        ...child,
        enrollment: { ...(child.enrollment as Record<string, unknown>), enabled: false },
        status: { state: 'disabled' }
      }),
      reason: 'sitter-disabled'
    },
    {
      name: 'closed without merge',
      update: child => ({
        ...child,
        enrollment: { ...(child.enrollment as Record<string, unknown>), terminalAtMs: 200 },
        status: { state: 'closed' },
        summary: { watcherId: rig.childId, kind: 'hosted-review', state: 'closed', reason: 'closed', atMs: 190 }
      }),
      reason: 'sitter-closed'
    }
  ]
  for (const item of blockedCases) {
    rig.setChild(item.update(structuredClone(rig.baseChild)))
    const detail = await rig.detail()
    expect(detail?.completion, item.name).toMatchObject({
      reachedBar: 'hosted-review',
      state: 'blocked',
      reason: item.reason
    })
    expect(detail?.next.reason, item.name).toBe(item.reason)
  }

  for (const state of ['active', 'held', 'enqueued', 'pending']) {
    const child = structuredClone(rig.baseChild)
    child.status = { state }
    rig.setChild(child)
    expect((await rig.detail())?.completion, state).toMatchObject({
      reachedBar: 'hosted-review',
      state: 'waiting',
      reason: 'awaiting-sitter-merge'
    })
  }

  rig.setChildMode('missing')
  expect((await rig.detail())?.completion).toMatchObject({
    state: 'unavailable',
    reason: 'sitter-unavailable'
  })
  rig.setChildMode('malformed')
  expect((await rig.detail())?.completion).toMatchObject({
    state: 'unavailable',
    reason: 'sitter-malformed'
  })
  rig.setChildMode('unreadable')
  expect((await rig.detail())?.completion).toMatchObject({
    state: 'unavailable',
    reason: 'sitter-unavailable'
  })

  const invalidMerged = structuredClone(terminalChild)
  invalidMerged.summary = {
    watcherId: 'unrelated-successor',
    kind: 'hosted-review',
    state: 'merged',
    reason: 'unrelated review merged',
    atMs: 190
  }
  rig.setChild(invalidMerged)
  expect((await rig.detail())?.completion).toMatchObject({
    state: 'unavailable',
    reason: 'sitter-summary-unavailable'
  })
  expect(rig.processCalls).toEqual([])
})

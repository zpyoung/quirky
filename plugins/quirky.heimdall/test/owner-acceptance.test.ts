import { afterEach, expect, test } from 'bun:test'
import { lstatSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import type { ExecuteResult, KernelAction } from '../src/contracts'
import type { OwnerDeviation } from '../src/owner/contracts'
import type { StructuredRunnerFactory } from '../../quirky.structured/runner'
import { FakeWorld } from '../../quirky.structured/test/fakes/world'
import { ScriptedStructuredRunner, createScriptedStructuredRunnerFactory } from './owner-fakes/scripted-structured-runner'
import { readScriptedConversation, scriptedConversationPath, type ScriptedConversation } from './owner-fakes/scripted-conversation-store'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = resolve(PLUGIN_DIR, '../..')
const STRUCTURED_DIR = join(REPO_ROOT, 'plugins/quirky.structured')
const FAKES_DIR = join(STRUCTURED_DIR, 'test/fakes')
const KIND_PLUGIN_DIR = join(PLUGIN_DIR, 'test/owner-fakes/kind-plugin')
const ORCHESTRATION_PLUGIN_DIR = join(PLUGIN_DIR, 'test/owner-fakes/orchestration-plugin')
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/main.ts')
const KIND_ID = 'acme.owner-kind'
const LOCAL_EXECUTION_HOST_ID = 'local'
const LOCAL_SCHEDULER_OWNER = 'daemon'
const INITIAL_DETAIL = 'Plan verification rejected an operator edit to src/ledger.ts: expected 6c4a, found 91de after approval.'
const INITIAL_DEVIATION: OwnerDeviation = {
  kind: 'check-failed',
  naturalKey: 'check:abc',
  detail: INITIAL_DETAIL
}

type JsonRecord = Record<string, unknown>
type OwnerFixtureState = {
  deviation: OwnerDeviation | null
  deviations: Record<string, OwnerDeviation | null>
  contentIdentity: string
  executionHostId: string
  schedulerOwner: string
  translatedAction: KernelAction
  executeResult: ExecuteResult
}
type TestGlobals = typeof globalThis & {
  __structuredFakes?: FakeWorld
  __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory
  __HEIMDALL_OWNER_FAKE__?: OwnerFixtureState
}
type PendingOwner = { owner: JsonRecord; pending: JsonRecord }
type Capture<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown }

const globals = globalThis as TestGlobals
let harness: Harness | null = null
let client: QuirkyClient | null = null
let processScope: ProcessScope | null = null
let homeForCleanup: string | null = null
let structuredRunners: ScriptedStructuredRunner[] = []
let workspaceSerial = 0


function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function stringField(value: unknown, key: string, label: string): string {
  const field = record(value, label)[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return field
}

function arrayField(value: unknown, key: string, label: string): unknown[] {
  const field = record(value, label)[key]
  if (!Array.isArray(field)) throw new Error(`${label}.${key} must be an array`)
  return field
}

function defaultKindState(): OwnerFixtureState {
  return {
    deviation: { ...INITIAL_DEVIATION },
    deviations: {},
    contentIdentity: 'owner-fixture-snapshot-1',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    schedulerOwner: LOCAL_SCHEDULER_OWNER,
    translatedAction: {
      kind: 'publish',
      capability: 'publish',
      visibility: 'local',
      approvalRequired: false,
      contentIdentity: 'owner-fixture-snapshot-1',
      evidenceKey: INITIAL_DEVIATION.naturalKey
    },
    executeResult: { effect: 'landed' }
  }
}

function makeBuiltinPluginsDir(): string {
  const dir = makeTempDir('qho-builtin-')
  const plugins: Record<string, string> = {
    'quirky.heimdall': PLUGIN_DIR,
    'quirky.structured': STRUCTURED_DIR,
    'quirky.session': join(FAKES_DIR, 'quirky.session'),
    'quirky.worktree': join(FAKES_DIR, 'quirky.worktree'),
    'quirky.ask': join(FAKES_DIR, 'quirky.ask'),
    'quirky.agents': join(FAKES_DIR, 'quirky.agents'),
    'quirky.orchestration': ORCHESTRATION_PLUGIN_DIR,
    'acme.owner-fixture': KIND_PLUGIN_DIR
  }
  for (const [id, target] of Object.entries(plugins)) symlinkSync(target, join(dir, id))
  return dir
}

async function boot(options: {
  home?: string
  builtinDir?: string
  kindState?: OwnerFixtureState
  world?: FakeWorld
  runners?: ScriptedStructuredRunner[]
} = {}) {
  const home = options.home ?? makeTempHome('qho-')
  homeForCleanup = home
  const builtinDir = options.builtinDir ?? makeBuiltinPluginsDir()
  const kindState = options.kindState ?? defaultKindState()
  const world = options.world ?? new FakeWorld()
  const runners = options.runners ?? []
  const scope = processScope ?? createProcessScope(home)
  if (scope.home !== home) throw new Error('scripted provider scope must use the daemon home')
  processScope = scope
  if (world.worktree.path === '/fake/alpha') world.worktree.path = makeTempDir('owner-workspace-')
  structuredRunners = runners
  workspaceSerial = 0
  globals.__structuredFakes = world
  globals.__HEIMDALL_OWNER_FAKE__ = kindState
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = createScriptedStructuredRunnerFactory(scope, (runner) => runners.push(runner))

  harness = await startHarness({ home, builtinPluginsDir: builtinDir })
  client = await harness.connect('cli')
  await waitForAsync(async () => {
    const plugins = await api().callAny('plugin.list', {})
    if (!Array.isArray(plugins)) return null
    const fixture = plugins.find((plugin) => isRecord(plugin) && plugin.id === 'acme.owner-fixture')
    return isRecord(fixture) && fixture.state === 'active' ? true : null
  }, 10_000)
  return { home, builtinDir, kindState, world, runners }
}

afterEach(async () => {
  const cleanupErrors: unknown[] = []
  try {
    await harness?.cleanup()
  } catch (error) {
    cleanupErrors.push(error)
  }
  harness = null
  client = null

  try {
    await processScope?.cleanup()
  } catch (error) {
    cleanupErrors.push(error)
  }
  processScope = null

  try {
    if (homeForCleanup) rmSync(homeForCleanup, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
  homeForCleanup = null

  try {
    removeTempDirs()
  } catch (error) {
    cleanupErrors.push(error)
  }

  delete globals.__structuredFakes
  delete globals.__HEIMDALL_OWNER_FAKE__
  delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  structuredRunners = []

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'owner acceptance test cleanup failed')
  }
})

function api(): QuirkyClient {
  if (!client) throw new Error('owner acceptance harness is not connected')
  return client
}

const call = (method: string, params: JsonRecord = {}) => api().callAny(method, params) as Promise<unknown>
const enrollParams = (workspaceKey: string, extra: JsonRecord = {}): JsonRecord => ({
  kind: KIND_ID,
  kindPayload: { workspaceKey },
  capabilities: {},
  ...extra
})

async function enroll(options: {
  workspaceKey?: string
  owner?: { agent: 'claude'; model?: string; effort?: string }
  ownerInterventionCapability?: 'off' | 'gated' | 'on'
  capabilities?: Record<string, 'off' | 'gated' | 'on'>
} = {}): Promise<string> {
  const workspaceKey = options.workspaceKey ?? `owner-acceptance-${++workspaceSerial}`
  const params = enrollParams(workspaceKey, {
    capabilities: options.capabilities ?? {},
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.ownerInterventionCapability === undefined ? {} : { ownerInterventionCapability: options.ownerInterventionCapability })
  })
  const result = record(await call('quirky.heimdall/enroll', params), 'enroll result')
  return stringField(result.enrollment, 'watcherId', 'enroll result.enrollment')
}

async function inspect(watcherId: string): Promise<JsonRecord> {
  const result = await call('quirky.heimdall/inspect', { watcherId })
  if (!Array.isArray(result)) throw new Error('inspection must return an array')
  const selected = result.find(value => isRecord(value) && isRecord(value.enrollment) && value.enrollment.watcherId === watcherId)
  return record(selected, 'inspection')
}

async function ownerInspect(watcherId: string): Promise<JsonRecord> {
  return record(await call('quirky.heimdall/ownerInspect', { watcherId }), 'owner inspection')
}

async function reconcile(watcherId: string): Promise<void> {
  await call('quirky.heimdall/reconcile', { watcherId })
}

async function waitForPending(watcherId: string): Promise<PendingOwner> {
  return waitForAsync(async () => {
    const owner = await ownerInspect(watcherId)
    if (typeof owner.lastError === 'string' && owner.lastError !== '') throw new Error(`Owner failed before report readiness: ${owner.lastError}`)
    const pending = owner.pending
    if (
      !isRecord(pending) ||
      typeof owner.sessionId !== 'string' ||
      typeof pending.reportKey !== 'string' ||
      typeof pending.reportPath !== 'string' ||
      pending.phase !== 'waiting'
    ) return null
    return { owner, pending }
  }, 10_000)
}

type ProviderConversation = { session: JsonRecord; providerSessionId: string; conversation: ScriptedConversation }

function runnerFor(sessionId: string): ScriptedStructuredRunner {
  const runner =
    structuredRunners.find((candidate) => candidate.hasProcess(sessionId) && candidate.isAlive(sessionId)) ??
    structuredRunners.find((candidate) => candidate.hasProcess(sessionId))
  if (!runner) throw new Error(`no scripted provider owns session ${sessionId}`)
  return runner
}

function liveProviderCount(): number {
  return structuredRunners.reduce((count, runner) => count + runner.liveProcessCount, 0)
}

async function waitForLiveProvider(sessionId: string): Promise<ScriptedStructuredRunner> {
  return waitFor(() => {
    const runner = structuredRunners.find((candidate) => candidate.hasProcess(sessionId) && candidate.isAlive(sessionId))
    return runner ?? undefined
  }, 10_000)
}
async function waitForLoadedProvider(sessionId: string): Promise<ScriptedStructuredRunner> {
  return waitFor(() => {
    const runner = structuredRunners.find((candidate) =>
      candidate.hasProcess(sessionId) &&
      candidate.isAlive(sessionId) &&
      candidate.loadedTurnCount(sessionId) !== undefined
    )
    return runner ?? undefined
  }, 10_000)
}

async function waitForConversation(home: string, sessionId: string, minimumTurns = 1): Promise<ProviderConversation> {
  return waitForAsync(async () => {
    const session = record(await call('quirky.session/get', { session: sessionId }), 'structured session')
    const provider = session.providerSession
    if (!isRecord(provider) || typeof provider.id !== 'string') return null
    try {
      const conversation = readScriptedConversation(scriptedConversationPath(home, provider.id))
      return conversation.turns.length >= minimumTurns
        ? { session, providerSessionId: provider.id, conversation }
        : null
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  }, 10_000)
}

function lastResolvedFor(inspected: JsonRecord, naturalKey: string): boolean | undefined {
  const matching = arrayField(inspected, 'journal', 'inspection')
    .filter(isRecord)
    .filter((entry) => {
      const serialized = JSON.stringify(entry) ?? ''
      const isOwnerDeviation =
        (typeof entry.kind === 'string' && entry.kind.startsWith('owner-deviation')) ||
        (typeof entry.eventId === 'string' && entry.eventId.includes('owner-deviation'))
      return isOwnerDeviation && serialized.includes(naturalKey) && typeof entry.resolved === 'boolean'
    })
  if (matching.length === 0) return undefined
  const resolved = matching[matching.length - 1].resolved
  return typeof resolved === 'boolean' ? resolved : undefined
}
function attemptsForCapability(inspected: JsonRecord, capability: string): JsonRecord[] {
  return arrayField(inspected, 'journal', 'inspection')
    .filter(isRecord)
    .filter((entry) => entry.kind === 'attempt' && isRecord(entry.action) && entry.action.capability === capability)
}

async function waitForResolution(watcherId: string, naturalKey: string, expected: boolean): Promise<JsonRecord> {
  return waitForAsync(async () => {
    const inspected = await inspect(watcherId)
    return lastResolvedFor(inspected, naturalKey) === expected ? inspected : null
  }, 5_000)
}

function pendingField(pending: JsonRecord, key: string): string {
  return stringField(pending, key, 'owner inspection.pending')
}

function writeReport(path: string, report: unknown): void {
  const content = typeof report === 'string' ? report : JSON.stringify(report)
  if (content === undefined) throw new Error('owner report could not be serialized')
  writeFileSync(path, content, { mode: 0o600 })
}

function assertReportIsPrivate(home: string, reportPath: string): void {
  const homePath = realpathSync(home)
  const absolutePath = realpathSync(reportPath)
  const relativePath = relative(homePath, absolutePath)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`issued owner report escaped the disposable home: ${reportPath}`)
  }

  const reportDirectory = realpathSync(dirname(reportPath))
  const relativeDirectory = relative(homePath, reportDirectory)
  if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
    throw new Error(`owner report directory escaped the disposable home: ${reportPath}`)
  }
  expect(statSync(reportDirectory).mode & 0o077).toBe(0)

  try {
    const report = lstatSync(reportPath)
    expect(report.isSymbolicLink()).toBe(false)
    expect(report.isFile()).toBe(true)
    expect(report.mode & 0o077).toBe(0)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

async function capture<T>(promise: Promise<T>): Promise<Capture<T>> {
  try {
    return { kind: 'resolved', value: await promise }
  } catch (error) {
    return { kind: 'rejected', error }
  }
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined
}

async function expectEnrollmentRefused(params: JsonRecord): Promise<void> {
  const outcome = await capture(call('quirky.heimdall/enroll', params))
  if (outcome.kind === 'resolved') {
    expect(record(outcome.value, 'refused enroll result').kind).toBe('refused')
    return
  }
  expect(errorCode(outcome.error)).toBe(RpcErrorCode.InvalidParams)
}

async function expectReadyRefused(watcherId: string, reportKey: string): Promise<void> {
  const result = record(await call('quirky.heimdall/ownerReady', { watcherId, reportKey }), 'owner-ready result')
  expect(result.kind).toBe('refused')
}


async function runCliJson(scope: ProcessScope, builtinDir: string, args: string[]): Promise<unknown> {
  const env: Record<string, string> = {
    HOME: scope.home,
    QUIRKY_HOME: scope.home,
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    QUIRKY_BUILTIN_PLUGINS_DIR: builtinDir
  }
  const child = scope.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch {
      // ProcessScope remains responsible for any surviving descendants.
    }
  }, 20_000)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ])
    if (timedOut) throw new Error(`quirky ${args.slice(0, 2).join(' ')} timed out`)
    if (exitCode !== 0) throw new Error(`quirky ${args.slice(0, 2).join(' ')} exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    try {
      return JSON.parse(stdout.trim()) as unknown
    } catch (error) {
      throw new Error(`quirky ${args.slice(0, 2).join(' ')} did not return JSON: ${stdout}`, { cause: error })
    }
  } finally {
    clearTimeout(timer)
  }
}

async function stopHarnessPreservingHome(): Promise<void> {
  const current = harness
  if (!current) throw new Error('owner acceptance harness is not running')
  for (const activeClient of current.clients) await activeClient.close()
  await current.daemon.stop()
  current.pty.stop()
  harness = null
  client = null
}

test('optional Claude owner configuration survives restart and resumes its persisted provider conversation', async () => {
  const first = await boot()
  const owner = { agent: 'claude' as const, model: 'claude-opus-4', effort: 'high' }
  const watcherId = await enroll({
    owner,
    ownerInterventionCapability: 'on',
    capabilities: { continue: 'on' }
  })
  await reconcile(watcherId)
  const initialPending = await waitForPending(watcherId)
  const firstSessionId = stringField(initialPending.owner, 'sessionId', 'initial owner inspection')
  await waitForLiveProvider(firstSessionId)
  const firstConversation = await waitForConversation(first.home, firstSessionId)
  const firstTurn = firstConversation.conversation.turns[0]

  expect(firstConversation.providerSessionId).toBeTruthy()
  expect(firstTurn.prompt).toContain(INITIAL_DEVIATION.naturalKey)
  expect(firstTurn.prompt).toContain(INITIAL_DETAIL)
  expect(firstConversation.conversation.model).toBe(owner.model)
  expect(firstConversation.conversation.effort).toBe(owner.effort)
  expect(runnerFor(firstSessionId).loadedProviderOptions(firstSessionId)).toEqual({
    model: owner.model,
    effort: owner.effort
  })

  const initialInspection = await inspect(watcherId)
  expect(initialInspection.enrollment).toMatchObject({ owner, ownerInterventionCapability: 'on' })
  expect(pendingField(initialPending.pending, 'reportKey')).toBeTruthy()
  const initialTurns = firstConversation.conversation.turns.length

  await stopHarnessPreservingHome()
  const second = await boot({
    home: first.home,
    builtinDir: first.builtinDir,
    kindState: first.kindState,
    world: first.world,
    runners: first.runners
  })
  await reconcile(watcherId)
  const resumedSessionId = await waitForAsync(async () => {
    const ownerState = await ownerInspect(watcherId)
    const sessionId = ownerState.sessionId
    return typeof sessionId === 'string' &&
      structuredRunners.some((runner) => runner.hasProcess(sessionId) && runner.isAlive(sessionId))
      ? sessionId
      : null
  }, 10_000)

  const resumedRunner = await waitForLoadedProvider(resumedSessionId)
  const resumedConversation = await waitForConversation(second.home, resumedSessionId, initialTurns)
  expect(resumedConversation.providerSessionId).toBe(firstConversation.providerSessionId)
  expect(resumedRunner.loadedTurnCount(resumedSessionId)).toBe(initialTurns)
  expect(resumedRunner.loadedProviderOptions(resumedSessionId)).toEqual({ model: owner.model, effort: owner.effort })
  expect(resumedConversation.conversation.turns[0]).toEqual(firstTurn)

  const followup = 'Continue the restored conversation after daemon restart.'
  const turnsBeforeFollowup = resumedConversation.conversation.turns.length
  await call('quirky.structured/send', { session: resumedSessionId, text: followup })
  const continuedConversation = await waitForConversation(second.home, resumedSessionId, turnsBeforeFollowup + 1)
  expect(continuedConversation.conversation.turns.length).toBe(turnsBeforeFollowup + 1)
  expect(continuedConversation.conversation.turns[turnsBeforeFollowup]).toEqual({
    prompt: followup,
    response: `Scripted Claude completed turn ${turnsBeforeFollowup + 1}`
  })

  const restartedInspection = await inspect(watcherId)
  expect(restartedInspection.enrollment).toMatchObject({ owner, ownerInterventionCapability: 'on' })
  expect(second.home).toBe(first.home)
})

test('unowned enrollments run without starting an owner structured session', async () => {
  await boot()
  const watcherId = await enroll({ capabilities: { continue: 'on' } })
  await reconcile(watcherId)

  const owner = await ownerInspect(watcherId)
  expect(owner).toMatchObject({ sessionId: null, pending: null })
  expect(liveProviderCount()).toBe(0)
})

test('unknown owner harnesses, invalid effort types, and unsafe owner keys are refused', async () => {
  await boot()
  const unsupportedHarness = enrollParams('unsupported-owner', {
    owner: { agent: 'codex' },
    ownerInterventionCapability: 'on'
  })
  const invalidEffort = enrollParams('invalid-owner-effort', {
    owner: { agent: 'claude', model: 'claude-opus-4', effort: 7 },
    ownerInterventionCapability: 'on'
  })
  const unsafeOwnerKey = enrollParams('unsafe-owner-key', {
    owner: { agent: 'claude', model: 'claude-opus-4', shell: '/bin/sh' },
    ownerInterventionCapability: 'on'
  })

  await expectEnrollmentRefused(unsupportedHarness)
  await expectEnrollmentRefused(invalidEffort)
  await expectEnrollmentRefused(unsafeOwnerKey)
  expect(liveProviderCount()).toBe(0)
})

test('kind registration is plugin-only', async () => {
  await boot()
  const descriptor = {
    id: 'acme.owner-fixture.client-attempt',
    displayName: 'Unauthenticated kind',
    enrollmentPayloadSchema: { type: 'object' },
    hooks: {
      authorize: 'acme.owner-fixture/authorize',
      read: 'acme.owner-fixture/read',
      decide: 'acme.owner-fixture/decide',
      execute: 'acme.owner-fixture/execute'
    }
  }

  const outcome = await capture(call('quirky.heimdall/registerKind', descriptor))
  expect(outcome.kind).toBe('rejected')
  const forged = await call('quirky.heimdall/enroll', { kind: descriptor.id, kindPayload: {}, capabilities: {} })
  expect(forged).toMatchObject({ kind: 'refused', reason: 'unknown-kind' })
  const legitimate = await enroll({ workspaceKey: 'fixture-registration-still-works' })
  expect((await inspect(legitimate)).enrollment).toMatchObject({ kind: KIND_ID })
})

test('natural keys deduplicate provider turns while full failure detail appears in the conversation and inspection', async () => {
  const booted = await boot()
  const workspaceKey = 'dedupe-conversation'
  const watcherId = await enroll({
    workspaceKey,
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { continue: 'on' }
  })
  await reconcile(watcherId)
  const firstPending = await waitForPending(watcherId)
  const ownerSessionId = stringField(firstPending.owner, 'sessionId', 'initial owner inspection')
  await waitForLiveProvider(ownerSessionId)
  const firstConversation = await waitForConversation(booted.home, ownerSessionId)
  const firstTurnCount = firstConversation.conversation.turns.length
  expect(firstConversation.conversation.turns[0].prompt).toContain(INITIAL_DEVIATION.naturalKey)
  expect(firstConversation.conversation.turns[0].prompt).toContain(INITIAL_DETAIL)
  expect(firstPending.pending.deviation).toMatchObject(INITIAL_DEVIATION)

  const firstInspection = await inspect(watcherId)
  expect(JSON.stringify(firstInspection.journal)).toContain(INITIAL_DETAIL)
  await reconcile(watcherId)
  const deduplicatedConversation = await waitForConversation(booted.home, ownerSessionId, firstTurnCount)
  expect(deduplicatedConversation.conversation.turns).toHaveLength(firstTurnCount)
  expect(liveProviderCount()).toBe(1)

  const reportPath = pendingField(firstPending.pending, 'reportPath')
  writeReport(reportPath, { kind: 'continue' })
  expect(await call('quirky.heimdall/ownerReady', {
    watcherId,
    reportKey: pendingField(firstPending.pending, 'reportKey')
  })).toMatchObject({ kind: 'accepted' })
  await reconcile(watcherId)
  await waitForResolution(watcherId, INITIAL_DEVIATION.naturalKey, true)

  await reconcile(watcherId)
  const stillResolved = await waitForConversation(booted.home, ownerSessionId, firstTurnCount)
  expect(stillResolved.conversation.turns).toHaveLength(firstTurnCount)

  const nextDetail = 'A later independent check failed: release manifest digest differs from the approved plan.'
  booted.kindState.deviations[workspaceKey] = { kind: 'check-failed', naturalKey: 'check:def', detail: nextDetail }
  booted.kindState.contentIdentity = 'owner-fixture-snapshot-2'
  await reconcile(watcherId)
  const nextPending = await waitForAsync(async () => {
    const current = await ownerInspect(watcherId)
    const pending = current.pending
    return isRecord(pending) && isRecord(pending.deviation) && pending.deviation.naturalKey === 'check:def'
      ? { current, pending }
      : null
  }, 10_000)
  const nextConversation = await waitForConversation(booted.home, ownerSessionId, firstTurnCount + 1)

  expect(nextPending.current.sessionId).toBe(ownerSessionId)
  expect(nextConversation.providerSessionId).toBe(firstConversation.providerSessionId)
  expect(nextConversation.conversation.turns).toHaveLength(firstTurnCount + 1)
  expect(nextConversation.conversation.turns[firstTurnCount].prompt).toContain(nextDetail)
  expect(liveProviderCount()).toBe(1)
})

test('the generated owner-ready CLI accepts an issued file and translated kind actions pass through the native capability gate', async () => {
  const booted = await boot()
  const watcherId = await enroll({
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { publish: 'on' }
  })
  await reconcile(watcherId)
  const pending = await waitForPending(watcherId)
  const ownerSessionId = stringField(pending.owner, 'sessionId', 'owner inspection')
  await waitForLiveProvider(ownerSessionId)
  const reportPath = pendingField(pending.pending, 'reportPath')
  const reportKey = pendingField(pending.pending, 'reportKey')
  assertReportIsPrivate(booted.home, reportPath)

  const evidenceKey = 'publish:package-42'
  writeReport(reportPath, {
    kind: 'kind-action',
    action: { operation: 'publish', evidenceKey, note: 'publish checked package' }
  })
  assertReportIsPrivate(booted.home, reportPath)
  if (!processScope) throw new Error('scripted provider process scope is missing')
  const cliResult = await runCliJson(processScope, booted.builtinDir, [
    'heimdall', 'owner-ready', '--watcher-id', watcherId, '--report-key', reportKey, '--json'
  ])
  expect(cliResult).toMatchObject({ kind: 'accepted' })

  await reconcile(watcherId)
  const applied = await waitForResolution(watcherId, INITIAL_DEVIATION.naturalKey, true)
  const landed = attemptsForCapability(applied, 'publish').filter((attempt) => attempt.effect === 'landed')
  expect(landed).toHaveLength(1)
  expect(record(landed[0].action, 'published native action')).toMatchObject({
    kind: 'publish',
    capability: 'publish',
    contentIdentity: 'owner-fixture-snapshot-1',
    evidenceKey
  })
  expect(JSON.stringify(applied.journal)).toContain('publish checked package')
  const publications = readFileSync(join(booted.world.worktree.path, 'owner-publications.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)
  expect(publications).toEqual([{ evidenceKey, contentIdentity: 'owner-fixture-snapshot-1', note: 'publish checked package' }])
})

test('an owner human question parks until its exact escalation is answered in the same native conversation', async () => {
  const booted = await boot()
  const watcherId = await enroll({
    owner: { agent: 'claude' }, ownerInterventionCapability: 'on',
    capabilities: { 'ask-human': 'on' }
  })
  await reconcile(watcherId)
  const issued = await waitForPending(watcherId)
  const sessionId = stringField(issued.owner, 'sessionId', 'issued owner')
  const before = await waitForConversation(booted.home, sessionId)
  writeReport(pendingField(issued.pending, 'reportPath'), {
    kind: 'ask-human', question: 'Which verified result should be kept?'
  })
  expect(await call('quirky.heimdall/ownerReady', {
    watcherId, reportKey: pendingField(issued.pending, 'reportKey')
  })).toMatchObject({ kind: 'accepted' })
  await reconcile(watcherId)
  const parked = await waitForAsync(async () => {
    const current = await ownerInspect(watcherId)
    return isRecord(current.pending) && current.pending.phase === 'parked' ? current : null
  })
  const pending = record(parked.pending, 'parked owner')
  const escalationId = pendingField(pending, 'escalationId')
  const detail = () => call('quirky.heimdall/detail', { target: { watcherId } }).then(value => record(value, 'watcher detail'))
  const current = await detail()
  expect(current.enrollment).toMatchObject({ enabled: false, parkReason: 'owner-escalation' })
  const answer = (id: string, body: string, view: JsonRecord) => call('quirky.heimdall/command', {
    target: view.target, expectedOwner: view.ownerFence,
    command: { kind: 'answer-escalation', escalationId: id, body }
  })
  expect(await answer('not-the-owner-escalation', 'Wrong target.', current)).toMatchObject({ kind: 'refused' })
  expect(readScriptedConversation(scriptedConversationPath(booted.home, before.providerSessionId)).turns).toEqual(before.conversation.turns)
  expect((await detail()).enrollment).toMatchObject({ enabled: false, parkReason: 'owner-escalation' })
  const reply = 'Keep the result from the first verified run.'
  expect(await answer(escalationId, reply, await detail())).toMatchObject({ kind: 'applied' })
  const resumed = await waitForPending(watcherId)
  expect(resumed.owner.sessionId).toBe(sessionId)
  expect(resumed.pending.reportKey).not.toBe(issued.pending.reportKey)
  const conversation = await waitForConversation(booted.home, sessionId, 2)
  expect(conversation.providerSessionId).toBe(before.providerSessionId)
  expect(conversation.conversation.turns.at(-1)?.prompt).toContain(reply)
  expect((await detail()).enrollment).toMatchObject({ enabled: true, parkReason: null })
  expect(await answer(escalationId, 'Replay must not send.', await detail())).toMatchObject({ kind: 'refused' })
  expect(readScriptedConversation(scriptedConversationPath(booted.home, before.providerSessionId)).turns).toEqual(conversation.conversation.turns)
})

test('a report accepted for stale content is held and reissued in the same provider conversation', async () => {
  const booted = await boot()
  const watcherId = await enroll({
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { publish: 'on' }
  })
  await reconcile(watcherId)
  const issued = await waitForPending(watcherId)
  const ownerSessionId = stringField(issued.owner, 'sessionId', 'owner inspection')
  await waitForLiveProvider(ownerSessionId)
  const originalConversation = await waitForConversation(booted.home, ownerSessionId)
  const oldReportKey = pendingField(issued.pending, 'reportKey')
  const oldContentIdentity = stringField(issued.pending, 'contentIdentity', 'owner inspection.pending')

  writeReport(pendingField(issued.pending, 'reportPath'), {
    kind: 'kind-action',
    action: { operation: 'publish', evidenceKey: 'publish:stale-content', note: 'must wait for fresh evidence' }
  })
  expect(await call('quirky.heimdall/ownerReady', { watcherId, reportKey: oldReportKey })).toMatchObject({ kind: 'accepted' })

  booted.kindState.contentIdentity = 'owner-fixture-snapshot-2'
  expect(oldContentIdentity).toBe('owner-fixture-snapshot-1')
  await reconcile(watcherId)
  const refreshed = await waitForAsync(async () => {
    const owner = await ownerInspect(watcherId)
    const pending = owner.pending
    if (
      !isRecord(pending) ||
      pending.reportKey === oldReportKey ||
      pending.contentIdentity !== booted.kindState.contentIdentity ||
      !isRecord(pending.deviation) ||
      pending.deviation.kind !== 'gate-held' ||
      pending.phase !== 'waiting'
    ) return null
    return { owner, pending }
  }, 10_000)

  const refreshedConversation = await waitForConversation(
    booted.home,
    ownerSessionId,
    originalConversation.conversation.turns.length + 1
  )
  expect(refreshed.owner.sessionId).toBe(ownerSessionId)
  expect(pendingField(refreshed.pending, 'reportKey')).not.toBe(oldReportKey)
  expect(refreshed.pending.contentIdentity).toBe('owner-fixture-snapshot-2')
  expect(record(refreshed.pending.deviation, 'refreshed deviation').kind).toBe('gate-held')
  expect(refreshedConversation.providerSessionId).toBe(originalConversation.providerSessionId)
  const refreshedTurn = refreshedConversation.conversation.turns[refreshedConversation.conversation.turns.length - 1]
  expect(refreshedTurn.prompt).toContain('gate-held')
  expect(refreshedTurn.prompt).toContain('owner-fixture-snapshot-2')

  const inspected = await inspect(watcherId)
  expect(lastResolvedFor(inspected, INITIAL_DEVIATION.naturalKey)).toBe(false)
  expect(attemptsForCapability(inspected, 'publish').some((attempt) => attempt.effect === 'landed')).toBe(false)
  expect(await Bun.file(join(booted.world.worktree.path, 'owner-publications.jsonl')).exists()).toBe(false)
})

test('stale, malformed, oversized, and symlink reports are refused without native attempts', async () => {
  const booted = await boot()
  const watcherId = await enroll({
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { publish: 'on' }
  })
  await reconcile(watcherId)
  const pending = await waitForPending(watcherId)
  const ownerSessionId = stringField(pending.owner, 'sessionId', 'owner inspection')
  await waitForLiveProvider(ownerSessionId)
  const reportPath = pendingField(pending.pending, 'reportPath')
  const reportKey = pendingField(pending.pending, 'reportKey')
  const actionReport = {
    kind: 'kind-action',
    action: { operation: 'publish', evidenceKey: 'publish:must-not-land', note: 'must never publish' }
  }

  writeReport(reportPath, actionReport)
  await expectReadyRefused(watcherId, `${reportKey}-stale`)
  writeReport(reportPath, '{ not valid JSON')
  await expectReadyRefused(watcherId, reportKey)
  writeReport(reportPath, `${JSON.stringify(actionReport)}${' '.repeat(64 * 1024)}`)
  await expectReadyRefused(watcherId, reportKey)

  const outsideReport = join(makeTempDir('qho-outside-'), 'outside-report.json')
  writeReport(outsideReport, actionReport)
  rmSync(reportPath, { force: true })
  symlinkSync(outsideReport, reportPath)
  await expectReadyRefused(watcherId, reportKey)

  const inspected = await inspect(watcherId)
  expect(lastResolvedFor(inspected, INITIAL_DEVIATION.naturalKey)).toBe(false)
  expect(attemptsForCapability(inspected, 'publish')).toEqual([])
  expect(await Bun.file(join(booted.world.worktree.path, 'owner-publications.jsonl')).exists()).toBe(false)
})


for (const scenario of [
  { name: 'owner-off', ownerMode: 'off', nativeMode: 'on', allowed: false },
  { name: 'owner-gated', ownerMode: 'gated', nativeMode: 'on', allowed: false },
  { name: 'native-off', ownerMode: 'on', nativeMode: 'off', allowed: false },
  { name: 'native-gated', ownerMode: 'on', nativeMode: 'gated', allowed: false },
  { name: 'both-on', ownerMode: 'on', nativeMode: 'on', allowed: true }
] as const) {
  test(`continue capability boundary: ${scenario.name}`, async () => {
    const booted = await boot()
    const naturalKey = `check:${scenario.name}`
    booted.kindState.deviations[scenario.name] = {
      kind: 'check-failed', naturalKey, detail: `Capability boundary ${scenario.name}.`
    }
    const watcherId = await enroll({
      workspaceKey: scenario.name, owner: { agent: 'claude' },
      ownerInterventionCapability: scenario.ownerMode, capabilities: { continue: scenario.nativeMode }
    })
    await reconcile(watcherId)
    const pending = await waitForPending(watcherId)
    writeReport(pendingField(pending.pending, 'reportPath'), { kind: 'continue' })
    await call('quirky.heimdall/ownerReady', { watcherId, reportKey: pendingField(pending.pending, 'reportKey') })
    await reconcile(watcherId)
    const inspected = await waitForResolution(watcherId, naturalKey, scenario.allowed)
    expect(lastResolvedFor(inspected, naturalKey)).toBe(scenario.allowed)
    if (!scenario.allowed) {
      expect(attemptsForCapability(inspected, 'continue')).toEqual([])
    } else {
      expect(attemptsForCapability(inspected, 'continue').at(-1)).toMatchObject({ state: 'settled', effect: 'landed' })
    }
  })
}

test('a translated kind action cannot execute when its native action capability is off', async () => {
  const booted = await boot()
  const watcherId = await enroll({
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { publish: 'off' }
  })
  await reconcile(watcherId)
  const pending = await waitForPending(watcherId)
  const ownerSessionId = stringField(pending.owner, 'sessionId', 'owner inspection')
  await waitForLiveProvider(ownerSessionId)
  writeReport(pendingField(pending.pending, 'reportPath'), {
    kind: 'kind-action',
    action: { operation: 'publish', evidenceKey: 'publish:blocked', note: 'native gate must hold this' }
  })
  await call('quirky.heimdall/ownerReady', {
    watcherId,
    reportKey: pendingField(pending.pending, 'reportKey')
  })
  await reconcile(watcherId)

  const inspected = await inspect(watcherId)
  expect(lastResolvedFor(inspected, INITIAL_DEVIATION.naturalKey)).toBe(false)
  expect(inspected.status).toMatchObject({ state: 'held' })
  expect(attemptsForCapability(inspected, 'publish').some((attempt) => attempt.effect === 'landed')).toBe(false)
  expect(JSON.stringify(inspected)).toContain('publish:blocked')
  expect(await Bun.file(join(booted.world.worktree.path, 'owner-publications.jsonl')).exists()).toBe(false)
})

test('disabling Heimdall stops its owner child while an unrelated structured child accepts another turn', async () => {
  const booted = await boot()
  const unowned = record(await call('quirky.structured/create', {
    worktree: 'main',
    agent: 'claude',
    prompt: 'unowned background work'
  }), 'unowned structured session')
  const unownedSessionId = stringField(unowned, 'id', 'unowned structured session')
  const unownedConversation = await waitForConversation(booted.home, unownedSessionId)
  const unownedRunner = runnerFor(unownedSessionId)
  expect(unownedRunner.isAlive(unownedSessionId)).toBe(true)

  const watcherId = await enroll({
    owner: { agent: 'claude' },
    ownerInterventionCapability: 'on',
    capabilities: { continue: 'on' }
  })
  await reconcile(watcherId)
  const ownerState = await waitForPending(watcherId)
  const ownerSessionId = stringField(ownerState.owner, 'sessionId', 'owner inspection')
  const ownerConversation = await waitForConversation(booted.home, ownerSessionId)
  const ownerRunner = runnerFor(ownerSessionId)
  expect(ownerConversation.providerSessionId).not.toBe(unownedConversation.providerSessionId)
  expect(liveProviderCount()).toBe(2)

  await call('plugin.disable', { id: 'quirky.heimdall' })
  const ownerExit = await waitForAsync(async () => {
    const code = ownerRunner.exitCode(ownerSessionId)
    return code === undefined ? null : { code }
  }, 10_000)
  expect(ownerExit.code).toBe(0)
  expect(ownerRunner.isAlive(ownerSessionId)).toBe(false)
  expect(unownedRunner.isAlive(unownedSessionId)).toBe(true)

  const followup = 'unowned session continues after Heimdall is disabled'
  await call('quirky.structured/send', { session: unownedSessionId, text: followup })
  const continued = await waitForConversation(
    booted.home,
    unownedSessionId,
    unownedConversation.conversation.turns.length + 1
  )
  const lastTurn = continued.conversation.turns[continued.conversation.turns.length - 1]
  expect(lastTurn.prompt).toBe(followup)
  expect(lastTurn.response).toBe(`Scripted Claude completed turn ${continued.conversation.turns.length}`)

  const messages = await call('quirky.structured/messages', { session: unownedSessionId })
  expect(Array.isArray(messages)).toBe(true)
  expect((messages as unknown[]).some((message) => isRecord(message) && message.role === 'assistant' && message.text === lastTurn.response)).toBe(true)
})

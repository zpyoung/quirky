import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'

let harness: WorkerAcceptance | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function startHarness(): Promise<WorkerAcceptance> {
  if (!harness) harness = await startWorkerAcceptance()
  return harness
}

type JournalEntry = {
  kind: string
  seq: number
  attemptId?: string
  action?: {
    kind?: string
    evidenceKey?: string
    taskKey?: string
    revision?: number
    capability?: string
    plannerMode?: 'initial' | 'repair'
    repairEpisode?: number
    contentIdentity?: string
    gateName?: string
  }
  state?: string
  effect?: string
  dispatchId?: string
  reason?: string
}
type HeimdallInspection = {
  enrollment: { watcherId: string; orchestrationRunId: string | null }
  journal: JournalEntry[]
  status: { state: string; reason?: string; detail?: string } | null
}

type WorkerShow = {
  worker: { sessionId: string | null; startOptions: { agent?: string } } | null
}

type HeimdallShow = {
  status: { state: string; reason?: string; detail?: string } | null
  openEscalations: Array<{
    escalationId: string
    status: string
    approvalScope?: { actionKind: string; evidenceKey: string }
  }>
  workers: Array<{ identity: { dispatchId: string }; state: string; assignmentActive: boolean }>
}

type ObjectiveProjection = {
  contentIdentity: string | null
  git: { branch: string | null; headSha: string | null }
  rejectedDrafts: Array<{ attemptId: string; digest: string; reason: string | null }>
  draft: null | {
    kind: 'initial' | 'repair'
    plannerAttemptId: string
    digest: string
    tasks: Array<{ taskKey: string }>
    repair?: { upsertTasks: unknown[]; dropTaskKeys: string[] }
  }
  revision: null | {
    number: number
    digest: string
    approvedAtMs: number
    repairCount: number
    tasks: Array<{
      taskKey: string
      state: string
      attempts: number
      summary: string | null
      filesModified?: string[]
      overruns?: Array<{
        observedPaths: string[]
        outsidePaths: string[]
        unreportedPaths: string[]
        code: string
      }>
      checks?: Array<Record<string, unknown>>
    }>
  }
  gates: Array<Record<string, unknown>>
  verdicts: Array<{ role: 'reviewer' | 'integrator'; contentIdentity: string; verdict: string }>
  landings: Array<{
    rung: 'files-on-disk' | 'committed-local-branch'
    contentIdentity: string
    attemptId: string
    payload: Record<string, unknown>
  }>
  next: { actionKind: string | null; evidenceKey: string | null; reason: string | null }
}

type OrchestrationTask = { id: string; taskTitle: string; status: string; spec: string }

type WorkerDoneResult = {
  kind: string
  report: {
    status: string
    reason?: string
    lifecycle?: { code: string; reason: string }
  }
}

async function jsonCli<T>(harness: WorkerAcceptance, args: string[]): Promise<T> {
  const result = await harness.fixture.cli(args)
  if (result.code !== 0) throw new Error(`CLI ${args.join(' ')} exited ${result.code}: ${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function inspection(harness: WorkerAcceptance, watcherId: string): Promise<HeimdallInspection> {
  const inspections = await harness.fixture.call('quirky.heimdall/inspect', { watcherId }) as HeimdallInspection[]
  const current = inspections.find(candidate => candidate.enrollment.watcherId === watcherId)
  if (!current) throw new Error(`Heimdall inspection for ${watcherId} is missing`)
  return current
}

function latestAttempt(value: HeimdallInspection, actionKind: string): JournalEntry | null {
  return value.journal
    .filter(entry => entry.kind === 'attempt' && entry.action?.kind === actionKind)
    .sort((left, right) => left.seq - right.seq)
    .at(-1) ?? null
}

async function runningAttempt(harness: WorkerAcceptance, watcherId: string, actionKind: string): Promise<JournalEntry> {
  const current = await eventually(
    async () => latestAttempt(await inspection(harness, watcherId), actionKind),
    attempt => attempt?.state === 'running' && typeof attempt.dispatchId === 'string',
    `${actionKind} attempt to dispatch`,
    90_000,
  )
  if (!current) throw new Error(`${actionKind} attempt was not created`)
  return current
}


async function workerSession(harness: WorkerAcceptance, dispatchId: string): Promise<string> {
  const shown = await eventually(
    () => harness.fixture.call('quirky.orchestration/workerShow', { dispatchId }) as Promise<WorkerShow>,
    value => typeof value.worker?.sessionId === 'string',
    `launched worker ${dispatchId}`,
    90_000,
  )
  const sessionId = shown.worker?.sessionId
  if (!sessionId) throw new Error(`worker ${dispatchId} has no session`)
  return sessionId
}

function reportPathFrom(spec: string): string {
  const match = spec.match(/^REPORT PATH: (.+)$/m)
  if (!match) throw new Error('worker spec has no REPORT PATH')
  return match[1]!
}

async function expectKindHookGuard(harness: WorkerAcceptance, method: string): Promise<void> {
  let failure: unknown
  try {
    await harness.fixture.call(`quirky.objective/${method}`, {})
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect(String(failure)).toContain('only quirky.heimdall may call objective kind hooks')
}

function workerDoneFlags(
  taskId: string,
  dispatchId: string,
  reportPath: string,
  outcome: 'succeeded' | 'failed' = 'succeeded',
): string[] {
  return [
    '--type', 'worker_done',
    '--task-id', taskId,
    '--dispatch-id', dispatchId,
    '--outcome', outcome,
    '--subject', 'Objective worker report',
    '--body', 'The assigned objective work is complete.',
    '--report-path', reportPath,
  ]
}

async function approve(harness: WorkerAcceptance, watcherId: string, escalationId: string): Promise<void> {
  const result = await harness.fixture.cli(['heimdall', 'approve', watcherId, escalationId, '--json'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'applied' })
}

function assertGitExclude(repo: string): void {
  const exclude = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim()
  const excludePath = isAbsolute(exclude) ? exclude : join(repo, exclude)
  expect(readFileSync(excludePath, 'utf8').split(/\r?\n/)).toContain('/.quirky/objective/')
}
type ObjectiveOptions = {
  tier: 'express' | 'full'
  landingBar?: 'files-on-disk' | 'committed-local-branch'
  territory: string[]
  gate?: { name: string; command: string }
}

async function enrollObjective(
  harness: WorkerAcceptance,
  objective: string,
  options: ObjectiveOptions,
): Promise<string> {
  const args = [
    'heimdall', 'create', 'objective',
    '--objective', objective,
    '--worktree', `path:${harness.fixture.repo}`,
    '--tier', options.tier,
    '--landing-bar', options.landingBar ?? 'files-on-disk',
  ]
  for (const territory of options.territory) args.push('--territory', territory)
  if (options.gate) args.push('--gate', `${options.gate.name}=${options.gate.command}`)
  args.push('--json')
  const result = await harness.fixture.cli(args)
  if (result.code !== 0) throw new Error(`objective enrollment failed: ${result.stderr}\n${result.stdout}`)
  const created = JSON.parse(result.stdout) as {
    kind: string
    enrollment: {
      watcherId: string
      kind: string
      worktreeId: string
      kindPayload: Record<string, unknown>
      capabilities: Record<string, string>
    }
  }
  expect(created.kind).toBe('enrolled')
  expect(created.enrollment.kind).toBe('objective')
  expect(created.enrollment.kindPayload).toMatchObject({
    objectiveText: objective,
    tier: options.tier,
    landingBar: options.landingBar ?? 'files-on-disk',
    writeTerritory: options.territory,
    gates: options.gate ? [{ ...options.gate, timeoutSeconds: 1800 }] : [],
  })
  expect(created.enrollment.capabilities).toEqual({
    plan: 'gated',
    implement: 'on',
    review: 'on',
    check: 'on',
    land: options.landingBar === 'committed-local-branch' ? 'gated' : 'on',
  })
  const repos = await harness.fixture.call('quirky.repo/list', {}) as Array<{ id: string; path: string }>
  const repo = repos.find(candidate => candidate.path === harness.fixture.repo)
  if (!repo) throw new Error(`fixture repo ${harness.fixture.repo} is missing from quirky.repo/list`)
  const worktrees = await harness.fixture.call('quirky.worktree/list', { repo: repo.id }) as Array<{ id: string; isMain: boolean }>
  const main = worktrees.find(worktree => worktree.isMain)
  if (!main) throw new Error(`fixture repo ${repo.id} has no main worktree`)
  expect(created.enrollment.worktreeId).toBe(main.id)
  return created.enrollment.watcherId
}

function writeWorkspaceFile(repo: string, path: string, content: string): void {
  const absolute = join(repo, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

async function approvalFor(
  harness: WorkerAcceptance,
  watcherId: string,
  actionKind: string,
  evidenceKey?: string,
): Promise<HeimdallShow['openEscalations'][number]> {
  const show = await eventually(
    () => jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json']),
    value => value.openEscalations.some(escalation =>
      escalation.approvalScope?.actionKind === actionKind &&
      (evidenceKey === undefined || escalation.approvalScope.evidenceKey === evidenceKey)),
    `${actionKind} approval escalation`,
    90_000,
  )
  const escalation = show.openEscalations.find(candidate =>
    candidate.approvalScope?.actionKind === actionKind &&
    (evidenceKey === undefined || candidate.approvalScope.evidenceKey === evidenceKey))
  if (!escalation) throw new Error(`${actionKind} approval escalation is missing`)
  return escalation
}

async function settledAttempt(
  harness: WorkerAcceptance,
  watcherId: string,
  attemptId: string,
  effect: string,
): Promise<JournalEntry> {
  const current = await eventually(
    () => inspection(harness, watcherId),
    value => value.journal.some(entry =>
      entry.kind === 'attempt' && entry.attemptId === attemptId &&
      entry.state === 'settled' && entry.effect === effect),
    `attempt ${attemptId} to settle as ${effect}`,
    90_000,
  )
  const entry = current.journal.find(candidate => candidate.kind === 'attempt' && candidate.attemptId === attemptId)
  if (!entry) throw new Error(`attempt ${attemptId} is missing`)
  return entry
}

async function orchestrationTaskFor(
  harness: WorkerAcceptance,
  watcherId: string,
  attempt: JournalEntry,
): Promise<OrchestrationTask> {
  if (!attempt.attemptId) throw new Error('objective attempt has no attempt ID')
  const runId = (await inspection(harness, watcherId)).enrollment.orchestrationRunId
  if (!runId) throw new Error(`objective ${watcherId} has no orchestration run`)
  const listed = await harness.fixture.call('quirky.orchestration/taskList', { runId }) as { tasks: OrchestrationTask[] }
  const reportMarker = `/.quirky/objective/${watcherId}/${attempt.attemptId}.json`
  const task = listed.tasks.find(candidate => candidate.spec.includes(reportMarker))
  if (!task) throw new Error(`worker task for objective attempt ${attempt.attemptId} is missing`)
  return task
}

async function submitWorkerReport(
  harness: WorkerAcceptance,
  watcherId: string,
  session: string,
  attempt: JournalEntry,
  report: unknown,
  outcome: 'succeeded' | 'failed' = 'succeeded',
): Promise<{ task: OrchestrationTask; reportPath: string; result: WorkerDoneResult }> {
  if (!attempt.dispatchId) throw new Error('objective attempt has no dispatch ID')
  const task = await orchestrationTaskFor(harness, watcherId, attempt)
  const reportPath = reportPathFrom(task.spec)
  writeFileSync(reportPath, JSON.stringify(report))
  const result = await harness.callAs<WorkerDoneResult>(
    session,
    'send',
    workerDoneFlags(task.id, attempt.dispatchId, reportPath, outcome),
  )
  return { task, reportPath, result }
}

async function objectiveDetail(harness: WorkerAcceptance, watcherId: string): Promise<ObjectiveProjection> {
  return jsonCli<ObjectiveProjection>(harness, ['heimdall', 'objective', watcherId, '--json'])
}

type ObjectiveProgressDiagnostics = {
  status: HeimdallInspection['status']
  attempts: Array<{
    attemptId: string
    seq: number
    actionKind: string | null
    evidenceKey: string | null
    dispatchId: string | null
    state: string | null
    effect: string | null
    reason: string | null
  }>
  objective: {
    next: ObjectiveProjection['next']
    landings: Array<Pick<ObjectiveProjection['landings'][number], 'rung' | 'contentIdentity'>>
    checks: Array<Record<string, unknown>>
  }
}

async function objectiveProgressDiagnostics(
  harness: WorkerAcceptance,
  watcherId: string,
): Promise<ObjectiveProgressDiagnostics> {
  const [current, detail] = await Promise.all([
    inspection(harness, watcherId),
    harness.fixture.call('quirky.objective/detail', { watcherId }) as Promise<ObjectiveProjection>,
  ])
  const latestByAttempt = new Map<string, JournalEntry>()
  for (const entry of current.journal) {
    if (entry.kind !== 'attempt' || !entry.attemptId) continue
    const previous = latestByAttempt.get(entry.attemptId)
    if (!previous || entry.seq > previous.seq) latestByAttempt.set(entry.attemptId, entry)
  }
  const attempts = [...latestByAttempt.entries()]
    .map(([attemptId, entry]) => ({
      attemptId,
      seq: entry.seq,
      actionKind: entry.action?.kind ?? null,
      evidenceKey: entry.action?.evidenceKey ?? null,
      dispatchId: entry.dispatchId ?? null,
      state: entry.state ?? null,
      effect: entry.effect ?? null,
      reason: entry.reason ?? null,
    }))
    .sort((left, right) => left.seq - right.seq)
  const taskChecks = detail.revision?.tasks.flatMap(task =>
    (task.checks ?? []).map(check => ({
      taskKey: task.taskKey,
      kind: check.kind,
      targetKey: check.targetKey,
      contentIdentity: check.contentIdentity,
      command: check.command,
      status: check.status,
      exitCode: check.exitCode,
    }))
  ) ?? []
  const gateChecks = detail.gates.map(check => ({
    kind: check.kind,
    targetKey: check.targetKey,
    contentIdentity: check.contentIdentity,
    command: check.command,
    status: check.status,
    exitCode: check.exitCode,
  }))
  return {
    status: current.status,
    attempts,
    objective: {
      next: detail.next,
      landings: detail.landings.map(({ rung, contentIdentity }) => ({ rung, contentIdentity })),
      checks: [...taskChecks, ...gateChecks],
    },
  }
}

// The daemon ticks in a separate process, so poll its durable state rather than using fake timers.
async function waitForObjectiveLanding(
  harness: WorkerAcceptance,
  watcherId: string,
  landingBar: string,
  timeout = 90_000,
): Promise<ObjectiveProgressDiagnostics> {
  const deadline = Date.now() + timeout
  let current = await objectiveProgressDiagnostics(harness, watcherId)
  while (current.status?.state !== 'terminal') {
    if (Date.now() >= deadline) {
      throw new Error(`timed out: ${watcherId} to reach ${landingBar} landing bar; last=${JSON.stringify(current)}`)
    }
    await Bun.sleep(250)
    current = await objectiveProgressDiagnostics(harness, watcherId)
  }
  return current
}

async function enrollOtherKind(harness: WorkerAcceptance): Promise<string> {
  const pluginId = 'acme.objective-other-kind-fixture'
  const kindId = 'objective-other-kind-fixture'
  const methods = ['authorize', 'read', 'decide', 'execute', 'stop']
  const path = writePlugin(harness.fixture.home, {
    id: pluginId,
    name: 'Objective other-kind fixture',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'startup',
    dependencies: ['quirky.heimdall'],
    contributes: {
      method: methods.map(id => ({ id, params: { type: 'object', additionalProperties: true }, result: {} })),
    },
  }, {
    'main.ts': `import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const pluginId = ${JSON.stringify(pluginId)}
const kindId = ${JSON.stringify(kindId)}
export async function activate(context) {
  const method = name => pluginId + '/' + name
  context.provide('method:' + method('authorize'), async value => {
    const input = value.input ?? value
    const payload = input.kindPayload ?? {}
    const path = join(context.dataDir, 'workspaces', 'other-kind')
    mkdirSync(path, { recursive: true })
    const workspacePath = realpathSync(path)
    return { workspaceKey: 'local::' + workspacePath, workspacePath, executionHostId: 'local', schedulerOwner: 'daemon', kindPayload: payload }
  })
  context.provide('method:' + method('read'), async () => ({ freshness: 'live', contentIdentity: 'other-kind', observedAtMs: Date.now(), world: {} }))
  context.provide('method:' + method('decide'), () => ({ action: null, reason: 'fixture-idle' }))
  context.provide('method:' + method('execute'), () => ({ effect: 'landed', reason: 'fixture-unused' }))
  context.provide('method:' + method('stop'), () => null)
  await context.call('quirky.heimdall/registerKind', {
    id: kindId,
    displayName: 'Objective other-kind fixture',
    enrollmentPayloadSchema: { type: 'object', additionalProperties: true },
    hooks: {
      authorize: method('authorize'), read: method('read'), decide: method('decide'),
      execute: method('execute'), stop: method('stop')
    }
  })
}
`,
  })
  await harness.fixture.call('plugin.install', { path, yes: true })
  const enrolled = await harness.fixture.call('quirky.heimdall/enroll', {
    kind: kindId,
    kindPayload: { workspace: 'other-kind' },
    capabilities: { 'fixture.write': 'gated' },
  }) as { kind: string; enrollment: { watcherId: string } }
  if (enrolled.kind !== 'enrolled') throw new Error(`other-kind fixture enrollment refused: ${JSON.stringify(enrolled)}`)
  return enrolled.enrollment.watcherId
}

test('enrollment refuses an unresolvable active worktree and unsupported contracts through the CLI', async () => {
  const harness = await startHarness()
  const active = await harness.fixture.cli(['heimdall', 'create', 'objective', '--objective', 'Add a multiply function', '--json'])
  expect(active.code).not.toBe(0)
  expect(`${active.stdout}\n${active.stderr}`).toContain('worktree-unresolved')
  expect(`${active.stdout}\n${active.stderr}`).toContain('--worktree')

  const supportedPath = `path:${harness.fixture.repo}`
  const landing = await harness.fixture.cli([
    'heimdall', 'create', 'objective', '--objective', 'Add a multiply function',
    '--worktree', supportedPath, '--landing-bar', 'hosted-review', '--json',
  ])
  expect(landing.code).not.toBe(0)
  expect(`${landing.stdout}\n${landing.stderr}`).toContain('landing-bar-unsupported')

  const territory = await harness.fixture.cli([
    'heimdall', 'create', 'objective', '--objective', 'Add a multiply function',
    '--worktree', supportedPath, '--territory', '../x', '--json',
  ])
  expect(territory.code).not.toBe(0)
  expect(`${territory.stdout}\n${territory.stderr}`).toContain('territory-invalid')

  const missing = await harness.fixture.cli(['heimdall', 'objective', 'missing', '--json'])
  expect(missing.code).not.toBe(0)
  expect(`${missing.stdout}\n${missing.stderr}`).toContain('Watcher not found: missing')
  expect(await harness.fixture.call('quirky.objective/detail', { watcherId: 'missing' })).toBeNull()

  const otherWatcherId = await enrollOtherKind(harness)
  expect(await harness.fixture.call('quirky.objective/detail', { watcherId: otherWatcherId })).toBeNull()
  const otherKindCli = await harness.fixture.cli(['heimdall', 'objective', otherWatcherId, '--json'])
  expect(otherKindCli.code).not.toBe(0)
  expect(`${otherKindCli.stdout}\n${otherKindCli.stderr}`).toContain('not objective')

}, 180_000)

test('drives an objective from draft rejection and baseline overrun repair through shell checks and files-on-disk terminal stop', async () => {
  const harness = await startHarness()
  const repo = harness.fixture.repo
  const watcherId = await enrollObjective(harness, 'Repair an out-of-territory objective change', {
    tier: 'express',
    territory: ['src/**'],
    gate: { name: 'result-present', command: 'test -f src/result.ts' },
  })
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const beforeHooks = await inspection(harness, watcherId)
  for (const method of ['authorize', 'validate', 'read', 'decide', 'execute', 'submission', 'resolveOutcome', 'stop', 'pace']) {
    await expectKindHookGuard(harness, method)
  }
  const executeCli = await harness.fixture.cli(['objective', 'execute', '--params', '{}'])
  expect(executeCli.code).not.toBe(0)
  expect(`${executeCli.stdout}\n${executeCli.stderr}`).toContain('only quirky.heimdall may call objective kind hooks')
  expect((await inspection(harness, watcherId)).journal).toEqual(beforeHooks.journal)

  const firstPlannerApproval = await approvalFor(harness, watcherId, 'dispatch-planner', 'plan:1')
  expect((await objectiveDetail(harness, watcherId)).next).toMatchObject({
    actionKind: 'dispatch-planner',
    evidenceKey: 'plan:1',
  })
  await approve(harness, watcherId, firstPlannerApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const firstPlanner = await runningAttempt(harness, watcherId, 'dispatch-planner')
  expect(firstPlanner.action).toMatchObject({ kind: 'dispatch-planner', plannerMode: 'initial', evidenceKey: 'plan:1' })
  const firstPlannerSession = await workerSession(harness, firstPlanner.dispatchId!)
  const firstPlannerTask = await orchestrationTaskFor(harness, watcherId, firstPlanner)
  expect(firstPlannerTask.spec).toContain('ROLE: planner')
  expect(firstPlannerTask.spec).toContain('OBJECTIVE:')
  expect(firstPlannerTask.spec).toContain('Repair an out-of-territory objective change')
  expect(firstPlannerTask.spec).toContain('WRITE TERRITORY:')
  expect(firstPlannerTask.spec).toContain('REPORT CONTRACT:')
  expect(firstPlannerTask.spec).toContain('REPORT PATH:')
  expect(firstPlannerTask.spec).toContain(`/.quirky/objective/${watcherId}/${firstPlanner.attemptId}.json`)
  assertGitExclude(repo)
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')

  const firstPlannerReportPath = reportPathFrom(firstPlannerTask.spec)
  writeFileSync(firstPlannerReportPath, JSON.stringify({ plan: { tasks: [] }, assumptions: [] }))
  const refusedPlanner = await harness.cli(firstPlannerSession, [
    'orchestration', 'send', ...workerDoneFlags(firstPlannerTask.id, firstPlanner.dispatchId!, firstPlannerReportPath),
  ])
  expect(refusedPlanner.code).not.toBe(0)
  const invalidPlan = JSON.parse(refusedPlanner.stdout) as WorkerDoneResult
  expect(invalidPlan.report).toMatchObject({
    status: 'rejected',
    reason: 'submission_preflight_rejected',
    lifecycle: { code: 'invalid-report' },
  })
  expect(invalidPlan.report.lifecycle?.reason).toContain('tasks')
  expect(latestAttempt(await inspection(harness, watcherId), 'dispatch-planner')?.state).toBe('running')
  assertGitExclude(repo)
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')

  writeFileSync(firstPlannerReportPath, JSON.stringify({
    plan: {
      tasks: [{
        taskKey: 'discarded-draft',
        title: 'Draft that the operator rejects',
        spec: 'This draft is intentionally rejected.',
        deps: [],
        criteria: [{ body: 'The discarded result is present', shellCheckable: true, checkCommand: 'test -f src/discarded.ts' }],
        territory: ['src/**'],
      }],
    },
    assumptions: [],
  }))
  const submittedDraft = await harness.callAs<WorkerDoneResult>(
    firstPlannerSession,
    'send',
    workerDoneFlags(firstPlannerTask.id, firstPlanner.dispatchId!, firstPlannerReportPath),
  )
  expect(submittedDraft.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, firstPlanner.attemptId!, 'landed')

  const draft = await objectiveDetail(harness, watcherId)
  expect(draft.draft).toMatchObject({ kind: 'initial', plannerAttemptId: firstPlanner.attemptId })
  expect(draft.draft?.digest).toMatch(/^[0-9a-f]{64}$/)
  const draftApproval = await approvalFor(
    harness,
    watcherId,
    'activate-plan',
    `activate-plan:${firstPlanner.attemptId}`,
  )
  const rejected = await harness.fixture.cli([
    'objective', 'reject-draft',
    '--watcher-id', watcherId,
    '--digest', draft.draft!.digest,
    '--reason', 'The plan needs a safer write boundary.',
    '--json',
  ])
  expect(rejected).toMatchObject({ code: 0 })
  const rejection = JSON.parse(rejected.stdout) as {
    rejected: boolean
    attemptId: string
    digest: string
    reason: string | null
  }
  expect(rejection).toMatchObject({
    rejected: true,
    attemptId: firstPlanner.attemptId,
    digest: draft.draft!.digest,
    reason: 'The plan needs a safer write boundary.',
  })

  const supersededApproval = await eventually(
    () => jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json']),
    value => value.openEscalations.some(escalation =>
      escalation.approvalScope?.actionKind === 'dispatch-planner' &&
      escalation.approvalScope.evidenceKey !== 'plan:1') &&
      value.openEscalations.every(escalation => escalation.escalationId !== draftApproval.escalationId),
    'rejected draft approval to be superseded by a fresh planner approval',
    90_000,
  )
  expect(supersededApproval.openEscalations.map(escalation => escalation.escalationId))
    .not.toContain(draftApproval.escalationId)
  const detailAfterRejection = await objectiveDetail(harness, watcherId)
  expect(detailAfterRejection.rejectedDrafts.at(-1)).toMatchObject({
    attemptId: firstPlanner.attemptId,
    digest: draft.draft!.digest,
    reason: 'The plan needs a safer write boundary.',
  })

  const secondPlannerApproval = supersededApproval.openEscalations.find(escalation =>
    escalation.approvalScope?.actionKind === 'dispatch-planner')
  if (!secondPlannerApproval) throw new Error('fresh planner approval is missing')
  await approve(harness, watcherId, secondPlannerApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const planner = await runningAttempt(harness, watcherId, 'dispatch-planner')
  writeWorkspaceFile(repo, 'outside/pre-existing.txt', 'This dirty file predates every implementer dispatch.\n')
  expect(planner.action).toMatchObject({ kind: 'dispatch-planner', plannerMode: 'initial' })
  const plannerSession = await workerSession(harness, planner.dispatchId!)
  const plannerTask = await orchestrationTaskFor(harness, watcherId, planner)
  const plannerReportPath = reportPathFrom(plannerTask.spec)
  writeFileSync(plannerReportPath, JSON.stringify({
    plan: {
      tasks: [
        {
          taskKey: 'frozen-base',
          title: 'Write the base module',
          spec: 'Create the base module before the result task.',
          deps: [],
          criteria: [{ body: 'The base module exists', shellCheckable: true, checkCommand: 'test -s src/frozen.ts' }],
          territory: ['src/**'],
        },
        {
          taskKey: 'write-result',
          title: 'Write the result module',
          spec: 'Create the result module and report every changed path.',
          deps: ['frozen-base'],
          criteria: [{ body: 'The result module contains repaired', shellCheckable: true, checkCommand: 'grep -q repaired src/result.ts' }],
          territory: ['src/**'],
        },
      ],
    },
    assumptions: [],
  }))
  expect((await harness.callAs<WorkerDoneResult>(
    plannerSession,
    'send',
    workerDoneFlags(plannerTask.id, planner.dispatchId!, plannerReportPath),
  )).report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, planner.attemptId!, 'landed')

  const activateApproval = await approvalFor(harness, watcherId, 'activate-plan')
  await approve(harness, watcherId, activateApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const frozenAttempt = await runningAttempt(harness, watcherId, 'dispatch-node')
  expect(frozenAttempt.action).toMatchObject({ taskKey: 'frozen-base', revision: 1 })
  const frozenSession = await workerSession(harness, frozenAttempt.dispatchId!)
  const frozenTask = await orchestrationTaskFor(harness, watcherId, frozenAttempt)
  expect(frozenTask.spec).toContain('test -s src/frozen.ts')
  writeWorkspaceFile(repo, 'src/frozen.ts', 'export const frozen = true\n')
  const frozenReport = await submitWorkerReport(harness, watcherId, frozenSession, frozenAttempt, {
    taskKey: 'frozen-base',
    summary: 'Wrote the base module.',
    filesModified: ['src/frozen.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'The module is present.' }],
  })
  expect(frozenReport.result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, frozenAttempt.attemptId!, 'landed')

  const overrunAttempt = await runningAttempt(harness, watcherId, 'dispatch-node')
  expect(overrunAttempt.action).toMatchObject({ taskKey: 'write-result', revision: 1 })
  const overrunSession = await workerSession(harness, overrunAttempt.dispatchId!)
  const overrunTask = await orchestrationTaskFor(harness, watcherId, overrunAttempt)
  const overrunReportPath = reportPathFrom(overrunTask.spec)
  writeWorkspaceFile(repo, 'src/unreported-result.ts', 'export const result = \"bad\"\n')
  writeWorkspaceFile(repo, 'outside/unrelated-change.txt', 'This path is outside write territory.\n')
  writeFileSync(overrunReportPath, JSON.stringify({
    taskKey: 'write-result',
    summary: 'Wrote an invalid result.',
    filesModified: ['src/unreported-result.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'fail', note: 'This is the rejected attempt.' }],
  }))
  const refusedOverrun = await harness.cli(overrunSession, [
    'orchestration', 'send',
    ...workerDoneFlags(overrunTask.id, overrunAttempt.dispatchId!, overrunReportPath),
  ])
  expect(refusedOverrun.code).not.toBe(0)
  expect(`${refusedOverrun.stdout}\n${refusedOverrun.stderr}`)
    .toContain('observed-change-outside-write-territory:outside/unrelated-change.txt')
  expect(latestAttempt(await inspection(harness, watcherId), 'dispatch-node')?.state).toBe('running')

  const failedWorker = await harness.callAs<WorkerDoneResult>(
    overrunSession,
    'send',
    workerDoneFlags(overrunTask.id, overrunAttempt.dispatchId!, overrunReportPath, 'failed'),
  )
  expect(failedWorker.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, overrunAttempt.attemptId!, 'not-landed')
  const failedObjective = await objectiveDetail(harness, watcherId)
  const failedTask = failedObjective.revision?.tasks.find(task => task.taskKey === 'write-result')
  expect(failedTask?.overruns).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'observed-change-outside-write-territory',
      observedPaths: expect.arrayContaining(['outside/unrelated-change.txt']),
      outsidePaths: ['outside/unrelated-change.txt'],
    }),
  ]))
  expect(failedTask?.overruns?.flatMap(overrun => overrun.observedPaths)).not.toContain('outside/pre-existing.txt')

  const repairApproval = await approvalFor(harness, watcherId, 'dispatch-planner', 'plan-repair:1:1:1')
  await approve(harness, watcherId, repairApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const repairPlanner = await runningAttempt(harness, watcherId, 'dispatch-planner')
  expect(repairPlanner.action).toMatchObject({
    plannerMode: 'repair',
    repairEpisode: 1,
    evidenceKey: 'plan-repair:1:1:1',
  })
  const repairSession = await workerSession(harness, repairPlanner.dispatchId!)
  const repairPlannerTask = await orchestrationTaskFor(harness, watcherId, repairPlanner)
  expect(repairPlannerTask.spec).toContain('FROZEN TASKS:')
  expect(repairPlannerTask.spec).toContain('frozen-base')
  expect(repairPlannerTask.spec).toContain('OPEN TASKS:')
  expect(repairPlannerTask.spec).toContain('write-result')
  expect(repairPlannerTask.spec).toContain('FAILURE CONTEXT:')
  expect(repairPlannerTask.spec).toContain('outside/unrelated-change.txt')
  const repairReportPath = reportPathFrom(repairPlannerTask.spec)
  writeFileSync(repairReportPath, JSON.stringify({
    repair: {
      upsertTasks: [{
        taskKey: 'repair-result',
        title: 'Repair the result module',
        spec: 'Write a valid result and include every changed path in the report.',
        deps: ['frozen-base'],
        criteria: [{ body: 'The result module contains repaired', shellCheckable: true, checkCommand: 'grep -q repaired src/result.ts' }],
        territory: ['src/**'],
      }],
      dropTaskKeys: ['write-result'],
    },
    assumptions: [],
  }))
  expect((await harness.callAs<WorkerDoneResult>(
    repairSession,
    'send',
    workerDoneFlags(repairPlannerTask.id, repairPlanner.dispatchId!, repairReportPath),
  )).report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, repairPlanner.attemptId!, 'landed')

  const applyApproval = await approvalFor(harness, watcherId, 'apply-plan-repair')
  await approve(harness, watcherId, applyApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const repairAttempt = await runningAttempt(harness, watcherId, 'dispatch-node')
  expect(repairAttempt.action).toMatchObject({ taskKey: 'repair-result', revision: 1 })
  const repairWorkerSession = await workerSession(harness, repairAttempt.dispatchId!)
  const repairTask = await orchestrationTaskFor(harness, watcherId, repairAttempt)
  expect(repairTask.spec).toContain('grep -q repaired src/result.ts')
  writeWorkspaceFile(repo, 'src/result.ts', 'export const result = \"repaired\"\n')
  writeWorkspaceFile(repo, 'src/helper.ts', 'export const helper = true\n')
  const incompleteReport = {
    taskKey: 'repair-result',
    summary: 'Wrote the repaired result.',
    filesModified: ['src/result.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'The result is repaired.' }],
  }
  const repairReportPathForWorker = reportPathFrom(repairTask.spec)
  writeFileSync(repairReportPathForWorker, JSON.stringify(incompleteReport))
  const refusedUnreported = await harness.cli(repairWorkerSession, [
    'orchestration', 'send',
    ...workerDoneFlags(repairTask.id, repairAttempt.dispatchId!, repairReportPathForWorker),
  ])
  expect(refusedUnreported.code).not.toBe(0)
  expect(`${refusedUnreported.stdout}\n${refusedUnreported.stderr}`)
    .toContain('unreported-observed-change:src/helper.ts')
  const correctedReport = {
    ...incompleteReport,
    filesModified: ['src/result.ts', 'src/helper.ts'],
  }
  writeFileSync(repairReportPathForWorker, JSON.stringify(correctedReport))
  const acceptedRepair = await harness.callAs<WorkerDoneResult>(
    repairWorkerSession,
    'send',
    workerDoneFlags(repairTask.id, repairAttempt.dispatchId!, repairReportPathForWorker),
  )
  expect(acceptedRepair.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const terminal = await eventually(
    () => inspection(harness, watcherId),
    value => value.status?.state === 'terminal',
    `${watcherId} to reach the files-on-disk landing bar`,
    90_000,
  )
  expect(terminal.status).toMatchObject({ state: 'terminal', reason: 'files-on-disk landing bar reached' })
  const completed = await objectiveDetail(harness, watcherId)
  expect(completed.contentIdentity).toMatch(/^objective-tree:/)
  expect(completed.rejectedDrafts).toEqual(expect.arrayContaining([
    expect.objectContaining({ attemptId: firstPlanner.attemptId, digest: draft.draft!.digest }),
  ]))
  expect(completed.revision).toMatchObject({ number: 1, repairCount: 1 })
  expect(completed.revision?.tasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ taskKey: 'frozen-base', state: 'succeeded' }),
    expect.objectContaining({ taskKey: 'repair-result', state: 'succeeded' }),
  ]))
  expect(completed.revision?.tasks.map(task => task.taskKey)).not.toContain('write-result')
  const completedRepairTask = completed.revision?.tasks.find(task => task.taskKey === 'repair-result')
  expect(completedRepairTask?.filesModified).toEqual(expect.arrayContaining(['src/result.ts', 'src/helper.ts']))
  const passedChecks = completed.revision?.tasks.flatMap(task => task.checks ?? []) ?? []
  expect(passedChecks).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: 'test -s src/frozen.ts', status: 'passed' }),
    expect.objectContaining({ command: 'grep -q repaired src/result.ts', status: 'passed' }),
  ]))
  expect(completed.gates).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: 'test -f src/result.ts', status: 'passed' }),
  ]))
  expect(completed.landings).toEqual(expect.arrayContaining([
    expect.objectContaining({ rung: 'files-on-disk', contentIdentity: completed.contentIdentity }),
  ]))
}, 300_000)

test('completes a full-tier objective through reviewer, integrator edits, re-checks, and territory-only committed-local-branch landing', async () => {
  const harness = await startHarness()
  const repo = harness.fixture.repo
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test'])
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])
  writeWorkspaceFile(repo, 'outside-dirty.txt', 'tracked outside baseline\n')
  execFileSync('git', [
    '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'add', '--', 'outside-dirty.txt',
  ])
  execFileSync('git', [
    '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture outside baseline',
  ])
  writeWorkspaceFile(repo, 'outside-staged.txt', 'Staged outside the objective territory.\n')
  execFileSync('git', ['-C', repo, 'add', '--', 'outside-staged.txt'])
  writeWorkspaceFile(repo, 'outside-dirty.txt', 'Modified outside the objective territory.\n')
  writeWorkspaceFile(repo, 'outside-untracked.txt', 'Untracked outside the objective territory.\n')

  const watcherId = await enrollObjective(harness, 'Implement and integrate a feature', {
    tier: 'full',
    landingBar: 'committed-local-branch',
    territory: ['src/**'],
    gate: { name: 'feature-present', command: 'test -s src/feature.ts' },
  })
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const plannerApproval = await approvalFor(harness, watcherId, 'dispatch-planner', 'plan:1')
  assertGitExclude(repo)
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' })
    .trimEnd().split(/\r?\n/)).toEqual([
    ' M outside-dirty.txt',
    'A  outside-staged.txt',
    '?? outside-untracked.txt',
  ])
  await approve(harness, watcherId, plannerApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const planner = await runningAttempt(harness, watcherId, 'dispatch-planner')
  const plannerSession = await workerSession(harness, planner.dispatchId!)
  const plannerTask = await orchestrationTaskFor(harness, watcherId, planner)
  const plannerReport = await submitWorkerReport(harness, watcherId, plannerSession, planner, {
    plan: {
      tasks: [{
        taskKey: 'feature',
        title: 'Implement the feature',
        spec: 'Create the feature module.',
        deps: [],
        criteria: [{ body: 'Feature module exports feature', shellCheckable: true, checkCommand: 'grep -q feature src/feature.ts' }],
        territory: ['src/**'],
      }],
    },
    assumptions: [],
  })
  expect(plannerReport.task.id).toBe(plannerTask.id)
  expect(plannerReport.result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, planner.attemptId!, 'landed')
  const activateApproval = await approvalFor(harness, watcherId, 'activate-plan')
  await approve(harness, watcherId, activateApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const implementer = await runningAttempt(harness, watcherId, 'dispatch-node')
  const implementerSession = await workerSession(harness, implementer.dispatchId!)
  const implementerTask = await orchestrationTaskFor(harness, watcherId, implementer)
  writeWorkspaceFile(repo, 'src/feature.ts', "export const feature = 'implementer'\n")
  expect((await submitWorkerReport(harness, watcherId, implementerSession, implementer, {
    taskKey: 'feature',
    summary: 'Implemented the feature.',
    filesModified: ['src/feature.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'The feature file exists.' }],
  })).result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const firstReviewer = await runningAttempt(harness, watcherId, 'dispatch-reviewer')
  expect(firstReviewer.action?.contentIdentity).toMatch(/^objective-tree:/)
  const firstReviewerSession = await workerSession(harness, firstReviewer.dispatchId!)
  const firstReviewerTask = await orchestrationTaskFor(harness, watcherId, firstReviewer)
  expect(firstReviewerTask.spec).toContain('ROLE: reviewer')
  expect(firstReviewerTask.spec).toContain('criteriaResults')
  expect((await submitWorkerReport(harness, watcherId, firstReviewerSession, firstReviewer, {
    verdict: 'approve',
    criteriaResults: [{ taskKey: 'feature', criterionIndex: 0, result: 'pass', note: 'The feature meets its criterion.' }],
    summary: 'The implementation is ready to integrate.',
  })).result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, firstReviewer.attemptId!, 'landed')

  const firstIntegrator = await runningAttempt(harness, watcherId, 'dispatch-integrator')
  const firstIntegratorSession = await workerSession(harness, firstIntegrator.dispatchId!)
  const firstIntegratorTask = await orchestrationTaskFor(harness, watcherId, firstIntegrator)
  expect(firstIntegratorTask.spec).toContain('ROLE: integrator')
  expect(firstIntegratorTask.spec).toContain('WRITE TERRITORY:')
  expect(firstIntegratorTask.spec).toContain('grep -q feature src/feature.ts')
  writeWorkspaceFile(repo, 'src/feature.ts', "export const feature = 'integrated'\n")
  execFileSync('sh', ['-c', 'grep -q feature src/feature.ts'], { cwd: repo })
  expect((await submitWorkerReport(harness, watcherId, firstIntegratorSession, firstIntegrator, {
    verdict: 'approve',
    criteriaResults: [{ taskKey: 'feature', criterionIndex: 0, result: 'pass', note: 'Integrated feature meets its criterion.' }],
    checksRun: [{ command: 'grep -q feature src/feature.ts', exitCode: 0 }],
    summary: 'Integrated the feature and verified the check.',
  })).result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, firstIntegrator.attemptId!, 'landed')

  const secondReviewer = await runningAttempt(harness, watcherId, 'dispatch-reviewer')
  expect(secondReviewer.action?.contentIdentity).toMatch(/^objective-tree:/)
  expect(secondReviewer.action?.contentIdentity).not.toBe(firstReviewer.action?.contentIdentity)
  const afterIntegration = await objectiveDetail(harness, watcherId)
  const secondContentIdentity = secondReviewer.action?.contentIdentity
  if (secondContentIdentity === undefined) throw new Error('post-integration reviewer has no content identity')
  expect(afterIntegration.contentIdentity).toBe(secondContentIdentity)
  const postIntegrationChecks = afterIntegration.revision?.tasks.flatMap(task => task.checks ?? []) ?? []
  expect(postIntegrationChecks).toEqual(expect.arrayContaining([
    expect.objectContaining({
      command: 'grep -q feature src/feature.ts',
      status: 'passed',
      contentIdentity: secondContentIdentity,
    }),
  ]))
  expect(afterIntegration.gates).toEqual(expect.arrayContaining([
    expect.objectContaining({
      command: 'test -s src/feature.ts',
      status: 'passed',
      contentIdentity: secondContentIdentity,
    }),
  ]))
  const secondReviewerSession = await workerSession(harness, secondReviewer.dispatchId!)
  expect((await submitWorkerReport(harness, watcherId, secondReviewerSession, secondReviewer, {
    verdict: 'approve',
    criteriaResults: [{ taskKey: 'feature', criterionIndex: 0, result: 'pass', note: 'The integrated feature still meets its criterion.' }],
    summary: 'Re-reviewed the integrated implementation.',
  })).result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, secondReviewer.attemptId!, 'landed')

  const secondIntegrator = await runningAttempt(harness, watcherId, 'dispatch-integrator')
  expect(secondIntegrator.action?.contentIdentity).toBe(secondContentIdentity)
  const secondIntegratorSession = await workerSession(harness, secondIntegrator.dispatchId!)
  const secondIntegratorTask = await orchestrationTaskFor(harness, watcherId, secondIntegrator)
  expect(secondIntegratorTask.spec).toContain('ROLE: integrator')
  execFileSync('sh', ['-c', 'grep -q feature src/feature.ts'], { cwd: repo })
  expect((await submitWorkerReport(harness, watcherId, secondIntegratorSession, secondIntegrator, {
    verdict: 'approve',
    criteriaResults: [{ taskKey: 'feature', criterionIndex: 0, result: 'pass', note: 'The re-reviewed feature meets its criterion.' }],
    checksRun: [{ command: 'grep -q feature src/feature.ts', exitCode: 0 }],
    summary: 'Re-verified the reviewed integration without further edits.',
  })).result.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(harness, watcherId, secondIntegrator.attemptId!, 'landed')


  const commitApproval = await approvalFor(harness, watcherId, 'commit-local-branch')
  await approve(harness, watcherId, commitApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const terminal = await waitForObjectiveLanding(harness, watcherId, 'committed-local-branch')
  expect(terminal.status).toMatchObject({ state: 'terminal', reason: 'committed-local-branch landing bar reached' })

  const completed = await objectiveDetail(harness, watcherId)
  expect(completed.contentIdentity).toBe(secondContentIdentity)
  const committedLanding = completed.landings.find(landing => landing.rung === 'committed-local-branch')
  if (!committedLanding) throw new Error('committed-local-branch landing evidence is missing')
  expect(committedLanding.attemptId).toBeTruthy()
  expect(completed.landings).toEqual(expect.arrayContaining([
    expect.objectContaining({ rung: 'files-on-disk', contentIdentity: secondContentIdentity }),
    expect.objectContaining({ rung: 'committed-local-branch', contentIdentity: secondContentIdentity }),
  ]))
  expect(completed.verdicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'reviewer', contentIdentity: secondContentIdentity, verdict: 'approve' }),
    expect.objectContaining({ role: 'integrator', contentIdentity: secondContentIdentity, verdict: 'approve' }),
  ]))

  const committedPaths = execFileSync('git', ['-C', repo, 'diff-tree', '--no-commit-id', '-r', '--name-only', 'HEAD^', 'HEAD'], { encoding: 'utf8' })
    .trim().split(/\r?\n/)
  expect(committedPaths).toEqual(['src/feature.ts'])
  const latestCommitMessage = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%B'], { encoding: 'utf8' })
  expect(latestCommitMessage).toContain(`Quirky-Objective-Attempt: ${committedLanding.attemptId}`)
  const stagedOutsidePaths = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .trim().split(/\r?\n/)
  expect(stagedOutsidePaths).toEqual(['outside-staged.txt'])
  const remaining = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' })
    .trimEnd().split(/\r?\n/)
  expect(remaining).toEqual([
    ' M outside-dirty.txt',
    'A  outside-staged.txt',
    '?? outside-untracked.txt',
  ])
}, 300_000)

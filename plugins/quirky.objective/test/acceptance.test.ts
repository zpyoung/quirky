import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'

let harness: WorkerAcceptance | undefined
afterAll(async () => {
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
  action?: { kind?: string; evidenceKey?: string; taskKey?: string; revision?: number; capability?: string }
  state?: string
  effect?: string
  dispatchId?: string
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
  draft: null | { plannerAttemptId: string; digest: string; tasks: Array<{ taskKey: string }> }
  revision: null | {
    number: number
    digest: string
    approvedAtMs: number
    tasks: Array<{ taskKey: string; state: string; attempts: number; summary: string | null }>
  }
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

function workerDoneFlags(taskId: string, dispatchId: string, reportPath: string): string[] {
  return [
    '--type', 'worker_done',
    '--task-id', taskId,
    '--dispatch-id', dispatchId,
    '--outcome', 'succeeded',
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
  expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
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

test('an objective enrolled through the real CLI plans, waits for plan approval and dispatches each task to a worker', async () => {
  const harness = await startHarness()
  const repos = await harness.fixture.call('quirky.repo/list', {}) as Array<{ id: string; path: string }>
  const repo = repos.find(candidate => candidate.path === harness.fixture.repo)
  if (!repo) throw new Error(`fixture repo ${harness.fixture.repo} is missing from quirky.repo/list`)
  const worktrees = await harness.fixture.call('quirky.worktree/list', { repo: repo.id }) as Array<{ id: string; isMain: boolean }>
  const main = worktrees.find(worktree => worktree.isMain)
  if (!main) throw new Error(`fixture repo ${repo.id} has no main worktree`)

  const created = await harness.fixture.cli([
    'heimdall', 'create', 'objective', '--objective', 'Add a multiply function to math.ts',
    '--worktree', `path:${harness.fixture.repo}`, '--tier', 'express', '--json',
  ])
  expect(created.code).toBe(0)
  const result = JSON.parse(created.stdout) as {
    kind: string
    enrollment: {
      kind: string
      worktreeId: string
      kindPayload: Record<string, unknown>
      capabilities: Record<string, string>
      watcherId: string
    }
  }
  expect(result.kind).toBe('enrolled')
  expect(result.enrollment.kind).toBe('objective')
  expect(result.enrollment.worktreeId).toBe(main.id)
  expect(result.enrollment.kindPayload).toEqual({
    objectiveText: 'Add a multiply function to math.ts',
    tier: 'express',
    landingBar: 'files-on-disk',
    lanesEnabled: true,
    maxConcurrency: 3,
    writeTerritory: ['**'],
    roleAgents: {},
    gates: [],
    worktree: `id:${main.id}`,
  })
  expect(result.enrollment.capabilities).toEqual({ plan: 'gated', implement: 'on', review: 'on', check: 'on', land: 'on' })
  const watcherId = result.enrollment.watcherId
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const beforeHooks = await inspection(harness, watcherId)
  for (const method of ['authorize', 'validate', 'read', 'decide', 'execute', 'submission', 'stop', 'pace']) {
    await expectKindHookGuard(harness, method)
  }
  const executeCli = await harness.fixture.cli(['objective', 'execute', '--params', '{}'])
  expect(executeCli.code).not.toBe(0)
  expect(`${executeCli.stdout}\n${executeCli.stderr}`).toContain('only quirky.heimdall may call objective kind hooks')
  const afterHooks = await inspection(harness, watcherId)
  expect(afterHooks.journal).toEqual(beforeHooks.journal)

  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await eventually(
    () => inspection(harness, watcherId),
    value => value.status?.state === 'held',
    `${watcherId} to reach held`,
    90_000,
  )
  const held = await jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json'])
  expect(held.status).toMatchObject({ state: 'held', reason: 'awaiting-approval' })
  expect(held.openEscalations).toHaveLength(1)
  const plannerApproval = held.openEscalations[0]!
  expect(plannerApproval.approvalScope).toMatchObject({ actionKind: 'dispatch-planner', evidenceKey: 'plan:1' })
  const waitingForPlan = await jsonCli<ObjectiveProjection>(harness, ['heimdall', 'objective', watcherId, '--json'])
  expect(waitingForPlan).toMatchObject({
    draft: null,
    revision: null,
    next: { actionKind: 'dispatch-planner', evidenceKey: 'plan:1', reason: null },
  })

  await approve(harness, watcherId, plannerApproval.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const plannerAttempt = await runningAttempt(harness, watcherId, 'dispatch-planner')
  expect(plannerAttempt.attemptId).toBeTruthy()
  expect(plannerAttempt.action).toMatchObject({ kind: 'dispatch-planner', evidenceKey: 'plan:1' })
  const plannerDispatchId = plannerAttempt.dispatchId
  const plannerAttemptId = plannerAttempt.attemptId
  if (!plannerDispatchId || !plannerAttemptId) throw new Error('planner attempt has no dispatch or attempt ID')
  const plannerSession = await workerSession(harness, plannerDispatchId)
  const plannerShow = await harness.fixture.call('quirky.orchestration/workerShow', { dispatchId: plannerDispatchId }) as WorkerShow
  expect(plannerShow.worker?.startOptions.agent).toBe('claude')

  const plannerInspection = await inspection(harness, watcherId)
  const runId = plannerInspection.enrollment.orchestrationRunId
  if (!runId) throw new Error(`objective ${watcherId} has no orchestration run`)
  const plannerTasks = await harness.fixture.call('quirky.orchestration/taskList', { runId }) as { tasks: OrchestrationTask[] }
  expect(plannerTasks.tasks).toHaveLength(1)
  const plannerTask = plannerTasks.tasks[0]!
  expect(plannerTask.spec).toContain('ROLE: planner')
  expect(plannerTask.spec).toContain('OBJECTIVE:')
  expect(plannerTask.spec).toContain('Add a multiply function to math.ts')
  expect(plannerTask.spec).toContain('TIER: express')
  expect(plannerTask.spec).toContain('LANDING BAR: files-on-disk')
  expect(plannerTask.spec).toContain('WRITE TERRITORY:')
  expect(plannerTask.spec).toContain('REPORT CONTRACT:')
  expect(plannerTask.spec).toContain('REPORT PATH:')
  expect(plannerTask.spec).toContain(`/.quirky/objective/${watcherId}/${plannerAttemptId}.json`)
  const plannerReportPath = reportPathFrom(plannerTask.spec)
  assertGitExclude(harness.fixture.repo)

  writeFileSync(plannerReportPath, JSON.stringify({ plan: { tasks: [] }, assumptions: [] }))
  const refusedPlanner = await harness.cli(plannerSession, [
    'orchestration', 'send', ...workerDoneFlags(plannerTask.id, plannerDispatchId, plannerReportPath),
  ])
  expect(refusedPlanner.code).not.toBe(0)
  const refusal = JSON.parse(refusedPlanner.stdout) as WorkerDoneResult
  expect(refusal.report).toMatchObject({
    status: 'rejected',
    reason: 'submission_preflight_rejected',
    lifecycle: { code: 'invalid-report' },
  })
  expect(refusal.report.lifecycle?.reason).toContain('tasks')
  expect(latestAttempt(await inspection(harness, watcherId), 'dispatch-planner')?.state).toBe('running')
  assertGitExclude(harness.fixture.repo)

  writeFileSync(plannerReportPath, JSON.stringify({
    plan: {
      tasks: [{
        taskKey: 'add-multiply',
        title: 'Add multiply(a, b) to math.ts',
        spec: 'Export multiply from math.ts.',
        deps: [],
        criteria: [{ body: 'math.ts exports multiply', shellCheckable: true, checkCommand: 'grep -q multiply math.ts' }],
        territory: ['math.ts'],
      }],
    },
    assumptions: [],
  }))
  const acceptedPlanner = await harness.callAs<WorkerDoneResult>(plannerSession, 'send', workerDoneFlags(plannerTask.id, plannerDispatchId, plannerReportPath))
  expect(acceptedPlanner.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await eventually(
    async () => latestAttempt(await inspection(harness, watcherId), 'dispatch-planner'),
    attempt => attempt?.state === 'settled' && attempt.effect === 'landed',
    'accepted planner report to settle its attempt',
    90_000,
  )
  const drafted = await jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json'])
  expect(drafted.openEscalations).toHaveLength(1)
  expect(drafted.openEscalations[0]?.approvalScope).toMatchObject({
    actionKind: 'activate-plan',
    evidenceKey: `activate-plan:${plannerAttemptId}`,
  })
  const draft = await jsonCli<ObjectiveProjection>(harness, ['heimdall', 'objective', watcherId, '--json'])
  expect(draft.draft?.plannerAttemptId).toBe(plannerAttemptId)
  expect(draft.draft?.tasks[0]?.taskKey).toBe('add-multiply')
  expect(draft.draft?.digest).toMatch(/^[0-9a-f]{64}$/)
  expect(draft.revision).toBeNull()
  expect(draft.next.actionKind).toBe('activate-plan')
  const draftDigest = draft.draft!.digest

  await approve(harness, watcherId, drafted.openEscalations[0]!.escalationId)
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const nodeAttempt = await runningAttempt(harness, watcherId, 'dispatch-node')
  expect(nodeAttempt.action).toMatchObject({
    kind: 'dispatch-node',
    taskKey: 'add-multiply',
    revision: 1,
    capability: 'implement',
    evidenceKey: 'node:1:add-multiply:1',
  })
  const nodeDispatchId = nodeAttempt.dispatchId
  const nodeAttemptId = nodeAttempt.attemptId
  if (!nodeDispatchId || !nodeAttemptId) throw new Error('implementer attempt has no dispatch or attempt ID')
  const nodeSession = await workerSession(harness, nodeDispatchId)
  const nodeWorker = await harness.fixture.call('quirky.orchestration/workerShow', { dispatchId: nodeDispatchId }) as WorkerShow
  expect(nodeWorker.worker?.startOptions.agent).toBe('claude')

  const objectiveAfterActivation = await jsonCli<ObjectiveProjection>(harness, ['heimdall', 'objective', watcherId, '--json'])
  expect(objectiveAfterActivation.revision).toMatchObject({
    number: 1,
    digest: draftDigest,
    approvedAtMs: expect.any(Number),
    tasks: [expect.objectContaining({ taskKey: 'add-multiply', state: 'in-flight' })],
  })
  const live = await jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json'])
  expect(live.workers).toContainEqual(expect.objectContaining({
    identity: expect.objectContaining({ dispatchId: nodeDispatchId }),
    state: 'live',
    assignmentActive: true,
  }))

  const nodeTasks = await harness.fixture.call('quirky.orchestration/taskList', { runId }) as { tasks: OrchestrationTask[] }
  const nodeTask = nodeTasks.tasks.find(task => task.spec.includes('ROLE: implementer'))
  if (!nodeTask) throw new Error('implementer task is missing from orchestration task list')
  expect(nodeTask.spec).toContain('ASSIGNED TASK:')
  expect(nodeTask.spec).toContain('add-multiply')
  expect(nodeTask.spec).toContain('grep -q multiply math.ts')
  expect(nodeTask.spec).toContain('PLAN PROGRESS:')
  expect(nodeTask.spec).toContain(`/.quirky/objective/${watcherId}/${nodeAttemptId}.json`)
  const nodeReportPath = reportPathFrom(nodeTask.spec)
  writeFileSync(join(harness.fixture.repo, 'math.ts'), 'export function multiply(a: number, b: number): number { return a * b }')
  writeFileSync(nodeReportPath, JSON.stringify({
    taskKey: 'add-multiply',
    summary: 'Added multiply.',
    filesModified: ['math.ts'],
    criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'grep finds it' }],
  }))
  const acceptedNode = await harness.callAs<WorkerDoneResult>(nodeSession, 'send', workerDoneFlags(nodeTask.id, nodeDispatchId, nodeReportPath))
  expect(acceptedNode.report.status).toBe('accepted')
  await harness.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await eventually(
    () => inspection(harness, watcherId),
    value => value.status?.state === 'parked',
    `${watcherId} to reach parked`,
    90_000,
  )
  const parked = await jsonCli<HeimdallShow>(harness, ['heimdall', 'show', watcherId, '--json'])
  expect(parked.status).toMatchObject({
    state: 'parked',
    reason: 'stop-predicate',
    detail: 'All 1 plan tasks succeeded. Acceptance checks, review and landing are not available in this Quirky version.',
  })
  const completed = await jsonCli<ObjectiveProjection>(harness, ['heimdall', 'objective', watcherId, '--json'])
  expect(completed.revision).toMatchObject({
    number: 1,
    digest: draftDigest,
    tasks: [{ taskKey: 'add-multiply', state: 'succeeded', attempts: 1, summary: 'Added multiply.' }],
  })
  expect(completed.next.reason).toBe('verification-unavailable')
}, 180_000)

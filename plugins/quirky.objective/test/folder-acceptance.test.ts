import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'
import { captureFolderObservation } from '../src/folder-workspace'

let harness: WorkerAcceptance | undefined
afterEach(async () => {
  try {
    await harness?.cleanup()
  } finally {
    harness = undefined
  }
})

type Attempt = {
  kind: string
  seq: number
  attemptId?: string
  action?: {
    kind?: string
    taskKey?: string
    evidenceKey?: string
    plannerMode?: 'initial' | 'repair'
    contentIdentity?: string
  }
  state?: string
  effect?: string
  dispatchId?: string
}

type Inspection = {
  enrollment: { watcherId: string; orchestrationRunId: string | null }
  journal: Attempt[]
  status: { state: string; reason?: string; detail?: string } | null
}

type ObjectiveTask = {
  taskKey: string
  state: string
  attempts: number
  criteria: Array<{ body: string; shellCheckable: boolean; checkCommand: string }>
  filesModified: string[]
  overruns: Array<{
    code: string
    observedPaths: string[]
    outsidePaths: string[]
    unreportedPaths: string[]
  }>
  checks: Array<Record<string, unknown>>
}

type ObjectiveDetail = {
  watcherId: string
  worktreeId: string | null
  workspacePath: string
  effectiveConcurrency: number
  contract: {
    tier: string
    landingBar: string
    maxConcurrency: number
    worktree: string
    gates: Array<{ name: string; command: string }>
  }
  contentIdentity: string | null
  git: { branch: string | null; headSha: string | null }
  revision: null | { number: number; repairCount: number; tasks: ObjectiveTask[] }
  gates: Array<Record<string, unknown>>
  verdicts: Array<{ role: string; contentIdentity: string; verdict: string }>
  landings: Array<{
    rung: string
    contentIdentity: string
    attemptId: string
    payload: Record<string, unknown>
  }>
  completion: {
    requestedBar: string
    reachedBar: string | null
    state: string
    reason: string
    handoff: unknown
    mergedEvidence: unknown
  }
}

type Show = {
  openEscalations: Array<{
    escalationId: string
    approvalScope?: { actionKind: string; evidenceKey: string }
  }>
}

type OrchestrationTask = { id: string; taskTitle: string; status: string; spec: string }
type WorkerDoneResult = { kind: string; report: { status: string; reason?: string } }

async function jsonCli<T>(h: WorkerAcceptance, args: string[]): Promise<T> {
  const result = await h.fixture.cli(args)
  if (result.code !== 0) throw new Error(`CLI ${args.join(' ')} exited ${result.code}: ${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout) as T
}

async function detail(h: WorkerAcceptance, watcherId: string): Promise<ObjectiveDetail> {
  return jsonCli<ObjectiveDetail>(h, ['heimdall', 'objective', watcherId, '--json'])
}

async function inspection(h: WorkerAcceptance, watcherId: string): Promise<Inspection> {
  const rows = await h.fixture.call('quirky.heimdall/inspect', { watcherId }) as Inspection[]
  const current = rows.find(row => row.enrollment.watcherId === watcherId)
  if (!current) throw new Error(`inspection for ${watcherId} is missing`)
  return current
}

function latestAttempt(value: Inspection, actionKind: string): Attempt | null {
  return value.journal
    .filter(row => row.kind === 'attempt' && row.action?.kind === actionKind)
    .sort((left, right) => left.seq - right.seq)
    .at(-1) ?? null
}

async function runningAttempt(h: WorkerAcceptance, watcherId: string, actionKind: string): Promise<Attempt> {
  const current = await eventually(
    () => inspection(h, watcherId),
    value => {
      const attempt = latestAttempt(value, actionKind)
      return attempt?.state === 'running' && typeof attempt.dispatchId === 'string'
    },
    `${actionKind} to dispatch for ${watcherId}`,
    90_000,
  )
  const found = latestAttempt(current, actionKind)
  if (!found) throw new Error(`${actionKind} did not dispatch`)
  return found
}

async function settledAttempt(h: WorkerAcceptance, watcherId: string, attemptId: string, effect: string): Promise<Attempt> {
  const current = await eventually(
    () => inspection(h, watcherId),
    value => value.journal.some(row => row.kind === 'attempt' && row.attemptId === attemptId && row.state === 'settled' && row.effect === effect),
    `attempt ${attemptId} to settle as ${effect}`,
    90_000,
  )
  const row = current.journal.find(candidate => candidate.kind === 'attempt' && candidate.attemptId === attemptId)
  if (!row) throw new Error(`attempt ${attemptId} is missing`)
  return row
}

async function approvalFor(h: WorkerAcceptance, watcherId: string, actionKind: string, evidenceKey?: string) {
  const shown = await eventually(
    () => jsonCli<Show>(h, ['heimdall', 'show', watcherId, '--json']),
    value => value.openEscalations.some(row => row.approvalScope?.actionKind === actionKind &&
      (evidenceKey === undefined || row.approvalScope.evidenceKey === evidenceKey)),
    `${actionKind} approval for ${watcherId}`,
    90_000,
  )
  const item = shown.openEscalations.find(row => row.approvalScope?.actionKind === actionKind &&
    (evidenceKey === undefined || row.approvalScope.evidenceKey === evidenceKey))
  if (!item) throw new Error(`${actionKind} approval is missing`)
  return item
}

async function approve(h: WorkerAcceptance, watcherId: string, escalationId: string): Promise<void> {
  const result = await h.fixture.cli(['heimdall', 'approve', watcherId, escalationId, '--json'])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'applied' })
}

async function workerSession(h: WorkerAcceptance, dispatchId: string): Promise<string> {
  const shown = await eventually(
    () => h.fixture.call('quirky.orchestration/workerShow', { dispatchId }) as Promise<{ worker: { sessionId: string | null; startOptions: { agent?: string } } | null }>,
    value => typeof value.worker?.sessionId === 'string',
    `worker session for ${dispatchId}`,
    90_000,
  )
  const sessionId = shown.worker?.sessionId
  if (!sessionId) throw new Error(`worker ${dispatchId} has no session`)
  expect(shown.worker?.startOptions.agent).toBe('claude')
  return sessionId
}

function reportPathFrom(spec: string): string {
  const path = spec.match(/^REPORT PATH: (.+)$/m)?.[1]
  if (!path) throw new Error('worker spec has no REPORT PATH')
  return path
}

async function orchestrationTaskFor(h: WorkerAcceptance, watcherId: string, attempt: Attempt): Promise<OrchestrationTask> {
  if (!attempt.attemptId) throw new Error('attempt has no ID')
  const runId = (await inspection(h, watcherId)).enrollment.orchestrationRunId
  if (!runId) throw new Error(`objective ${watcherId} has no orchestration run`)
  const listed = await h.fixture.call('quirky.orchestration/taskList', { runId }) as { tasks: OrchestrationTask[] }
  const marker = `/.quirky/objective/${watcherId}/${attempt.attemptId}.json`
  const task = listed.tasks.find(row => row.spec.includes(marker))
  if (!task) throw new Error(`orchestration task for ${attempt.attemptId} is missing`)
  return task
}

function doneFlags(taskId: string, dispatchId: string, reportPath: string, outcome: 'succeeded' | 'failed' = 'succeeded'): string[] {
  return [
    '--type', 'worker_done', '--task-id', taskId, '--dispatch-id', dispatchId,
    '--outcome', outcome, '--subject', 'Objective worker report',
    '--body', 'The assigned objective work is complete.', '--report-path', reportPath,
  ]
}

async function submitReport(
  h: WorkerAcceptance,
  watcherId: string,
  attempt: Attempt,
  report: unknown,
  outcome: 'succeeded' | 'failed' = 'succeeded',
): Promise<{ task: OrchestrationTask; reportPath: string; result: WorkerDoneResult; session: string }> {
  if (!attempt.dispatchId) throw new Error('attempt has no dispatch ID')
  const task = await orchestrationTaskFor(h, watcherId, attempt)
  const reportPath = reportPathFrom(task.spec)
  const session = await workerSession(h, attempt.dispatchId)
  writeFileSync(reportPath, JSON.stringify(report))
  const result = await h.callAs<WorkerDoneResult>(session, 'send', doneFlags(task.id, attempt.dispatchId, reportPath, outcome))
  return { task, reportPath, result, session }
}

function writeWorkspaceFile(root: string, relativePath: string, bytes: string): void {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

function taskCriteria(body: string, command: string) {
  return { body, shellCheckable: true, checkCommand: command }
}

function guardFolderMutations(h: WorkerAcceptance): string {
  const git = Bun.which('git')
  if (!git || git === join(h.fixture.fakebin, 'git')) throw new Error('The fixture needs a real Git executable')
  const log = join(h.fixture.home, 'folder-mutations.jsonl')
  const roots = ['folder-project', 'group-folder'].map(mode => join(realpathSync(h.fixture.home), mode))
  writeFileSync(log, '')
  for (const command of ['git', 'gh']) {
    const launcher = join(h.fixture.fakebin, command)
    writeFileSync(launcher, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const roots = ${JSON.stringify(roots)}
const cwd = process.cwd()
const scoped = roots.some(root => cwd === root || cwd.startsWith(root + '/') || args.some(arg => arg.includes(root)))
const mutations = { init: true, add: true, 'update-index': true, 'read-tree': true, 'write-tree': true, commit: true, 'commit-tree': true, push: true, merge: true, rebase: true, reset: true, checkout: true, clean: true, apply: true, 'cherry-pick': true, revert: true }
if (${JSON.stringify(command)} === 'gh' || (scoped && args.some(arg => Object.hasOwn(mutations, arg)))) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command: ${JSON.stringify(command)}, args, cwd }) + '\\n')
  process.stderr.write('Unexpected Git or hosting mutation in folder fixture\\n')
  process.exit(97)
}
const result = Bun.spawnSync([${JSON.stringify(git)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.exit(result.exitCode)
`)
    chmodSync(launcher, 0o755)
  }
  return log
}

async function noParallelNodeDispatch(h: WorkerAcceptance, watcherId: string, expectedDispatchId: string): Promise<void> {
  const latest = new Map<string, Attempt>()
  for (const row of (await inspection(h, watcherId)).journal) {
    if (row.kind !== 'attempt') continue
    if (!row.attemptId) throw new Error('Journal attempt has no identity')
    const previous = latest.get(row.attemptId)
    if (!previous || row.seq > previous.seq) latest.set(row.attemptId, row)
  }
  const running = [...latest.values()].filter(row =>
    row.action?.kind === 'dispatch-node' && row.state === 'running')
  expect(running.map(row => row.dispatchId)).toEqual([expectedDispatchId])
}

async function completeFolderObjective(h: WorkerAcceptance, mode: 'folder-project' | 'group-folder', mutationLog: string): Promise<void> {
  const folderPath = join(h.fixture.home, mode)
  mkdirSync(folderPath, { recursive: true })
  const workspacePath = realpathSync(folderPath)
  const outsideBytes = 'preserve this pre-existing outside file\n'
  writeWorkspaceFile(workspacePath, 'outside/pre-existing.txt', outsideBytes)
  expect(existsSync(join(workspacePath, '.git'))).toBe(false)

  let workspaceId: string
  let expectedRepoId: string
  if (mode === 'folder-project') {
    const repo = await h.fixture.call('quirky.repo/add', { path: workspacePath, folder: true }) as { id: string }
    const worktrees = await h.fixture.call('quirky.worktree/list', { repo: repo.id }) as Array<{ id: string; isMain: boolean; path: string }>
    const primary = worktrees.find(row => row.isMain)
    if (!primary) throw new Error('registered folder project has no primary workspace')
    workspaceId = primary.id
    expectedRepoId = repo.id
  } else {
    const group = await h.fixture.call('quirky.repo/groupCreate', { name: `folder-${mode}`, parentPath: workspacePath }) as { id: string }
    const created = await h.fixture.call('quirky.worktree/create', { group: group.id, name: `workspace-${mode}` }) as { worktree: { id: string; path: string } }
    workspaceId = created.worktree.id
    expectedRepoId = `group:${group.id}`
  }

  const resolved = await h.fixture.call('quirky.worktree/resolve', { selector: `id:${workspaceId}` }) as {
    id: string; repoId: string; path: string; kind: string; branch: string | null; head: string | null
  }
  expect(resolved).toMatchObject({ id: workspaceId, repoId: expectedRepoId, path: workspacePath, kind: 'folder', branch: null })
  expect(resolved.head === null || resolved.head === '').toBe(true)

  const objective = `Complete the verified files-on-disk workflow in ${mode}`
  const enrolledResult = await h.fixture.cli([
    'heimdall', 'create', 'objective',
    '--objective', objective,
    '--worktree', `id:${workspaceId}`,
    '--tier', 'standard',
    '--landing-bar', 'files-on-disk',
    '--territory', 'src/**',
    '--gate', 'result-present=test -f src/result.txt',
    '--json',
  ])
  if (enrolledResult.code !== 0) throw new Error(`folder objective enrollment failed: ${enrolledResult.stderr}\n${enrolledResult.stdout}`)
  const enrolled = JSON.parse(enrolledResult.stdout) as {
    kind: string
    enrollment: { watcherId: string; worktreeId: string; kindPayload: Record<string, unknown> }
  }
  expect(enrolled.kind).toBe('enrolled')
  expect(enrolled.enrollment.worktreeId).toBe(workspaceId)
  expect(enrolled.enrollment.kindPayload).toMatchObject({
    objectiveText: objective,
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    worktree: `id:${workspaceId}`,
  })
  expect(enrolled.enrollment.kindPayload).not.toHaveProperty('maxConcurrency', 3)
  const watcherId = enrolled.enrollment.watcherId

  let current = await detail(h, watcherId)
  expect(current).toMatchObject({
    watcherId,
    worktreeId: workspaceId,
    workspacePath,
    effectiveConcurrency: 1,
    contract: { tier: 'standard', landingBar: 'files-on-disk', maxConcurrency: 1, worktree: `id:${workspaceId}` },
    git: { branch: null, headSha: null },
  })
  expect(current.contentIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/)

  const refused = await h.fixture.cli(['heimdall', 'set-concurrency', watcherId, '2', '--json'])
  expect(refused.code).not.toBe(0)
  expect(JSON.parse(refused.stdout)).toMatchObject({
    kind: 'refused',
    reason: 'unsupported-capability',
    detail: 'Folder workspaces support a concurrency cap of one.',
  })
  current = await detail(h, watcherId)
  expect(current.contract.maxConcurrency).toBe(1)
  expect(current.effectiveConcurrency).toBe(1)
  const acceptedOne = await h.fixture.cli(['heimdall', 'set-concurrency', watcherId, '1', '--json'])
  expect(acceptedOne.code).toBe(0)
  expect(JSON.parse(acceptedOne.stdout)).toMatchObject({ kind: 'applied' })
  current = await detail(h, watcherId)
  expect(current.contract.maxConcurrency).toBe(1)
  expect(current.effectiveConcurrency).toBe(1)

  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const approvalBaseline = await captureFolderObservation(workspacePath)
  const plannerApproval = await approvalFor(h, watcherId, 'dispatch-planner', 'plan:1')
  expect((await captureFolderObservation(workspacePath)).entries).toEqual(approvalBaseline.entries)
  await approve(h, watcherId, plannerApproval.escalationId)
  expect((await captureFolderObservation(workspacePath)).entries).toEqual(approvalBaseline.entries)
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const planner = await runningAttempt(h, watcherId, 'dispatch-planner')
  expect(planner.action).toMatchObject({ kind: 'dispatch-planner', plannerMode: 'initial' })
  const planReport = await submitReport(h, watcherId, planner, {
    plan: {
      tasks: [
        {
          taskKey: 'write-result',
          title: 'Write the verified result',
          spec: 'Create src/result.txt with the word ready and report only the changed file.',
          deps: [],
          criteria: [
            taskCriteria('The result contains ready.', 'grep -q ready src/result.txt'),
            taskCriteria('The result file exists.', 'test -f src/result.txt'),
          ],
          territory: ['src/**'],
        },
        {
          taskKey: 'write-note',
          title: 'Write a completion note',
          spec: 'Create src/note.txt with the word complete and report only the changed file.',
          deps: [],
          criteria: [taskCriteria('The completion note contains complete.', 'grep -q complete src/note.txt')],
          territory: ['src/**'],
        },
      ],
    },
    assumptions: [],
  })
  expect(planReport.result.report.status).toBe('accepted')
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(h, watcherId, planner.attemptId!, 'landed')

  const activateApproval = await approvalFor(h, watcherId, 'activate-plan')
  await approve(h, watcherId, activateApproval.escalationId)
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const firstNode = await runningAttempt(h, watcherId, 'dispatch-node')
  expect(firstNode.action?.taskKey).toBe('write-result')
  await noParallelNodeDispatch(h, watcherId, firstNode.dispatchId!)
  const started = await detail(h, watcherId)
  expect(started.effectiveConcurrency).toBe(1)
  expect(started.revision?.tasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ taskKey: 'write-result', state: 'in-flight' }),
    expect.objectContaining({ taskKey: 'write-note', state: 'pending' }),
  ]))

  writeWorkspaceFile(workspacePath, 'src/result.txt', 'unfinished\n')
  const overrunBytes = 'created by the rejected overrun\n'
  writeWorkspaceFile(workspacePath, 'outside/overrun.txt', overrunBytes)
  const overrunTask = await orchestrationTaskFor(h, watcherId, firstNode)
  const overrunReportPath = reportPathFrom(overrunTask.spec)
  const overrunSession = await workerSession(h, firstNode.dispatchId!)
  const overrunReport = {
    taskKey: 'write-result',
    summary: 'Wrote the result but changed an outside file.',
    filesModified: ['src/result.txt'],
    criteriaSelfAssessment: [
      { criterionIndex: 0, result: 'fail', note: 'The result is not ready yet.' },
      { criterionIndex: 1, result: 'pass', note: 'The file exists.' },
    ],
  }
  writeFileSync(overrunReportPath, JSON.stringify(overrunReport))
  const rejectedReport = await h.cli(overrunSession, [
    'orchestration', 'send', ...doneFlags(overrunTask.id, firstNode.dispatchId!, overrunReportPath),
  ])
  expect(rejectedReport.code).not.toBe(0)
  expect(`${rejectedReport.stdout}\n${rejectedReport.stderr}`).toContain('observed-change-outside-write-territory:outside/overrun.txt')
  expect(readFileSync(join(workspacePath, 'outside/pre-existing.txt'), 'utf8')).toBe(outsideBytes)
  const failedWorker = await h.callAs<WorkerDoneResult>(
    overrunSession,
    'send',
    doneFlags(overrunTask.id, firstNode.dispatchId!, overrunReportPath, 'failed'),
  )
  expect(failedWorker.report.status).toBe('accepted')
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(h, watcherId, firstNode.attemptId!, 'not-landed')
  const failedDetail = await detail(h, watcherId)
  const failedTask = failedDetail.revision?.tasks.find(row => row.taskKey === 'write-result')
  expect(failedTask?.overruns).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'observed-change-outside-write-territory',
      observedPaths: ['outside/overrun.txt', 'src/result.txt'],
      outsidePaths: ['outside/overrun.txt'],
      unreportedPaths: [],
    }),
  ]))
  expect(failedTask?.overruns.flatMap(row => row.observedPaths)).not.toContain('outside/pre-existing.txt')

  const repairApproval = await approvalFor(h, watcherId, 'dispatch-planner', 'plan-repair:1:1:1')
  await approve(h, watcherId, repairApproval.escalationId)
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const repairPlanner = await runningAttempt(h, watcherId, 'dispatch-planner')
  expect(repairPlanner.action).toMatchObject({ kind: 'dispatch-planner', plannerMode: 'repair' })
  const repairReport = await submitReport(h, watcherId, repairPlanner, {
    repair: {
      upsertTasks: [{
        taskKey: 'repair-result',
        title: 'Repair the result file',
        spec: 'Write src/result.txt with ready and report only the changed file.',
        deps: [],
        criteria: [
          taskCriteria('The result contains ready.', 'grep -q ready src/result.txt'),
          taskCriteria('The result file exists.', 'test -f src/result.txt'),
        ],
        territory: ['src/**'],
      }],
      dropTaskKeys: ['write-result'],
    },
    assumptions: [],
  })
  expect(repairReport.result.report.status).toBe('accepted')
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  await settledAttempt(h, watcherId, repairPlanner.attemptId!, 'landed')
  const applyRepairApproval = await approvalFor(h, watcherId, 'apply-plan-repair')
  await approve(h, watcherId, applyRepairApproval.escalationId)
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const successfulNodeDispatches: string[] = []
  for (let index = 0; index < 2; index++) {
    const attempt = await runningAttempt(h, watcherId, 'dispatch-node')
    const taskKey = attempt.action?.taskKey
    if (!taskKey) throw new Error('Running node has no assigned task key')
    expect(['repair-result', 'write-note']).toContain(taskKey)
    await noParallelNodeDispatch(h, watcherId, attempt.dispatchId!)
    const task = await orchestrationTaskFor(h, watcherId, attempt)
    let report: Record<string, unknown>
    if (taskKey === 'repair-result') {
      writeWorkspaceFile(workspacePath, 'src/result.txt', 'ready\n')
      report = {
        taskKey,
        summary: 'Wrote the repaired result.',
        filesModified: ['src/result.txt'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'pass', note: 'The content is present.' },
          { criterionIndex: 1, result: 'pass', note: 'The file exists.' },
        ],
      }
    } else {
      writeWorkspaceFile(workspacePath, 'src/note.txt', 'complete\n')
      report = {
        taskKey,
        summary: 'Wrote the completion note.',
        filesModified: ['src/note.txt'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'The note is present.' }],
      }
    }
    const submission = await submitReport(h, watcherId, attempt, report)
    expect(submission.result.report.status).toBe('accepted')
    successfulNodeDispatches.push(attempt.dispatchId!)
    await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
    await settledAttempt(h, watcherId, attempt.attemptId!, 'landed')
    expect(readFileSync(join(workspacePath, 'outside/pre-existing.txt'), 'utf8')).toBe(outsideBytes)
    expect(readFileSync(join(workspacePath, 'outside/overrun.txt'), 'utf8')).toBe(overrunBytes)
  }
  expect(successfulNodeDispatches).toHaveLength(2)
  expect(new Set(successfulNodeDispatches).size).toBe(2)

  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })
  const reviewer = await runningAttempt(h, watcherId, 'dispatch-reviewer')
  const beforeReview = await detail(h, watcherId)
  const finalIdentity = beforeReview.contentIdentity
  if (finalIdentity === null) throw new Error('Reviewer content identity is unavailable')
  expect(finalIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/)
  expect(reviewer.action?.contentIdentity).toBe(finalIdentity)
  const reviewerTask = await orchestrationTaskFor(h, watcherId, reviewer)
  expect(reviewerTask.spec).toContain('ROLE: reviewer')
  expect(reviewerTask.spec).toContain('Do not modify any workspace files')
  const reviewerReportPath = reportPathFrom(reviewerTask.spec)
  const criteriaResults = beforeReview.revision!.tasks.flatMap(task => task.criteria.map((_, criterionIndex) => ({
    taskKey: task.taskKey,
    criterionIndex,
    result: 'pass',
    note: 'The criterion is verified against the current folder content.',
  })))
  const reviewerSubmission = await submitReport(h, watcherId, reviewer, {
    verdict: 'approve',
    criteriaResults,
    summary: 'The read-only review approves the checked folder content.',
  })
  expect(reviewerSubmission.result.report.status).toBe('accepted')
  await h.fixture.call('quirky.heimdall/reconcile', { watcherId })

  const terminal = await eventually(
    () => inspection(h, watcherId),
    value => value.status?.state === 'terminal',
    `${watcherId} to land files-on-disk`,
    90_000,
  )
  expect(terminal.status).toMatchObject({ state: 'terminal', reason: 'files-on-disk landing bar reached' })
  const completed = await detail(h, watcherId)
  expect(completed.contentIdentity).toBe(finalIdentity)
  expect(completed.completion).toEqual({
    requestedBar: 'files-on-disk',
    reachedBar: 'files-on-disk',
    state: 'landed',
    reason: 'files-on-disk landing bar reached',
    handoff: null,
    mergedEvidence: null,
  })
  expect(completed.git).toEqual({ branch: null, headSha: null })
  expect(completed.landings).toHaveLength(1)
  expect(completed.landings).toEqual([
    expect.objectContaining({ rung: 'files-on-disk', contentIdentity: finalIdentity, attemptId: expect.any(String) }),
  ])
  expect(completed.verdicts).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'reviewer', contentIdentity: finalIdentity, verdict: 'approve' }),
  ]))
  expect(completed.revision).toMatchObject({ number: 1, repairCount: 1 })
  expect(completed.revision?.tasks.map(row => row.taskKey).sort()).toEqual(['repair-result', 'write-note'])
  expect(completed.revision?.tasks.every(row => row.state === 'succeeded')).toBe(true)
  const checks = completed.revision?.tasks.flatMap(row => row.checks) ?? []
  expect(checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: 'grep -q ready src/result.txt', status: 'passed', contentIdentity: finalIdentity }),
    expect.objectContaining({ command: 'test -f src/result.txt', status: 'passed', contentIdentity: finalIdentity }),
    expect.objectContaining({ command: 'grep -q complete src/note.txt', status: 'passed', contentIdentity: finalIdentity }),
  ]))
  expect(completed.gates).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: 'test -f src/result.txt', status: 'passed', contentIdentity: finalIdentity }),
  ]))
  expect(readFileSync(join(workspacePath, 'src/result.txt'), 'utf8')).toBe('ready\n')
  expect(readFileSync(join(workspacePath, 'src/note.txt'), 'utf8')).toBe('complete\n')
  expect(readFileSync(join(workspacePath, 'outside/pre-existing.txt'), 'utf8')).toBe(outsideBytes)
  expect(readFileSync(join(workspacePath, 'outside/overrun.txt'), 'utf8')).toBe(overrunBytes)
  expect(readdirSync(workspacePath)).not.toContain('.git')
  expect(existsSync(join(workspacePath, '.git'))).toBe(false)
  expect(readFileSync(mutationLog, 'utf8')).toBe('')

  expect(existsSync(reviewerReportPath)).toBe(true)
  const landingsBeforeReportRemoval = completed.landings
  rmSync(reviewerReportPath)
  expect(existsSync(reviewerReportPath)).toBe(false)
  const afterReportRemoval = await detail(h, watcherId)
  expect(afterReportRemoval.contentIdentity).toBe(finalIdentity)
  expect(afterReportRemoval.landings).toEqual(landingsBeforeReportRemoval)
  expect(afterReportRemoval.completion).toEqual(completed.completion)
  expect(afterReportRemoval.git).toEqual({ branch: null, headSha: null })
}

test('folder-project and group-folder objectives complete serially through checks review and files-on-disk landing', async () => {
  harness = await startWorkerAcceptance()
  const mutationLog = guardFolderMutations(harness)
  for (const mode of ['folder-project', 'group-folder'] as const) {
    await completeFolderObjective(harness, mode, mutationLog)
  }
}, 300_000)

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { OrchestrationSubmission, PluginContext, PluginStore, RunOptions, StoreMigration, StoreValue } from '@quirky/protocol'
import { validateValue } from '@quirky/protocol'
import { objectivePayloadSchema } from '../src/contract'
import { createObjectiveStore, type ObjectiveStore } from '../src/store'
import { createObjectiveHooks, type ObjectiveEnrollment } from '../src/hooks'
import { reportDigest } from '../src/plan'
import type { ObjectiveAction, ObjectiveJournalEntry, ObjectiveSnapshot } from '../src/decide'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
type ObjectiveHookTestRig = {
  root: string
  path: string
  store: ObjectiveStore
  hooks: {
    read(input: { enrollment: ObjectiveEnrollment }): Promise<ObjectiveSnapshot>
    decide(input: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[]; enrollment: ObjectiveEnrollment }): { action: ObjectiveAction | null; reason?: string }
    execute(input: { action: ObjectiveAction & { contentIdentity: string }; enrollment: ObjectiveEnrollment; attemptId: string }): Promise<unknown>
    submission(input: { submission: OrchestrationSubmission; enrollment: ObjectiveEnrollment }): Promise<unknown>
  }
  enrollment: ObjectiveEnrollment & { repoId: string }
  journal: ObjectiveJournalEntry[]
  setResolvedWorkspace(workspace: unknown): void
}


function rig(
  tier: 'express' | 'standard' | 'full' = 'express',
  workspaceKind: 'git' | 'folder' = 'git',
  repoId = workspaceKind === 'folder' ? 'folder-project' : 'repo'
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'objective-submission-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-data-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  let version = 0
  const sql: PluginStore = {
    get version() { return version },
    exec: text => { db.exec(text) },
    run: (text, ...args) => {
      const result = db.query(text).run(...args.map(value => typeof value === 'boolean' ? Number(value) : value))
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T>(text: string, ...args: StoreValue[]) { return db.query(text).get(...args.map(value => typeof value === 'boolean' ? Number(value) : value)) as T | null },
    all<T>(text: string, ...args: StoreValue[]) { return db.query(text).all(...args.map(value => typeof value === 'boolean' ? Number(value) : value)) as T[] },
    transaction: work => db.transaction(work)()
  }
  const enrollment: ObjectiveEnrollment & { repoId: string } = {
    watcherId: 'watcher', kind: 'objective', workspacePath: root, worktreeId: 'wt',
    repoId,
    capabilities: { plan: 'gated' as const, implement: 'on' as const },
    kindPayload: { objectiveText: 'Add multiply', tier, landingBar: 'files-on-disk' as const, writeTerritory: ['**'], roleAgents: {}, gates: [], worktree: 'id:wt', lanesEnabled: true, maxConcurrency: 3 }
  }
  let resolvedWorkspace: unknown = {
    id: 'wt', repoId: enrollment.repoId, path: root, kind: workspaceKind,
    branch: workspaceKind === 'git' ? 'main' : null, headSha: workspaceKind === 'git' ? 'head' : null
  }
  const calls: string[] = []
  const callParams: Array<[string, Record<string, unknown>]> = []
  const processCalls: { argv: string[]; cwd?: string }[] = []
  const journal: ObjectiveJournalEntry[] = [{ seq: 1, kind: 'attempt', attemptId: 'attempt', state: 'running', dispatchId: 'dispatch', action: { kind: 'dispatch-planner' } }]
  const context = {
    dataDir,
    error: (_kind: string, message: string) => new Error(message),
    openStore: (migrations: StoreMigration[]) => {
      db.transaction(() => {
        for (const migration of migrations.slice(version)) typeof migration === 'string' ? db.exec(migration) : migration(sql)
      })()
      version = migrations.length
      return sql
    },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method)
      callParams.push([method, params])
      if (method === 'quirky.worktree/resolve') return resolvedWorkspace
      if (method === 'quirky.heimdall/reconcile') return {}
      if (method === 'quirky.agents/list') return { defaultAgent: 'claude' }
      if (method !== 'quirky.heimdall/inspect') throw new Error(`unexpected call ${method}`)
      return [{ enrollment, journal }]
    },
    process: {
      async run(argv: readonly string[], options?: RunOptions) {
        processCalls.push({ argv: [...argv], cwd: options?.cwd })
        const result = Bun.spawnSync([...argv], { cwd: options?.cwd, env: options?.env, stdout: 'pipe', stderr: 'pipe' })
        return { stdout: result.stdout, stdoutText: result.stdout.toString(), stderr: result.stderr.toString(),
          exitCode: result.exitCode, signal: null, durationMs: 0 }
      }
    }
  } as unknown as PluginContext
  const store = createObjectiveStore(context)
  const path = join(root, '.quirky', 'objective', 'watcher', 'attempt.json')
  mkdirSync(join(root, '.quirky', 'objective', 'watcher'), { recursive: true })
  store.issue({ attemptId: 'attempt', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null, reportPath: path, issuedAtMs: 1 })
  const hooks = createObjectiveHooks(context, store)
  const submit = (reportPath?: string, outcome = 'succeeded') => hooks.submission({
    enrollment,
    submission: { runId: 'run', taskId: 'task', dispatchId: 'dispatch', type: 'worker_done', subject: 'Plan', body: 'Plan', payload: { outcome, ...(reportPath === undefined ? {} : { reportPath }) } }
  })
  return {
    root, path, context, store, submit, hooks, enrollment, journal, calls, callParams, processCalls,
    setResolvedWorkspace: (workspace: unknown) => { resolvedWorkspace = workspace }
  }
}

const report = {
  plan: { tasks: [{ taskKey: 'multiply', title: 'Add multiply', spec: 'Export multiply', deps: [], territory: ['math.ts'], criteria: [{ body: 'Export exists', shellCheckable: true, checkCommand: 'grep -q multiply math.ts' }] }] },
  assumptions: []
}
const folderTask = {
  taskKey: 'write', title: 'Write a result', spec: 'Create a ready result file.', deps: [],
  territory: ['src/**'],
  criteria: [
    { body: 'The result content is ready.', shellCheckable: true, checkCommand: 'grep -q ready src/result.txt' },
    { body: 'The result file exists.', shellCheckable: true, checkCommand: 'test -f src/result.txt' }
  ]
}
const folderPlan = { plan: { tasks: [folderTask] }, assumptions: [] }

function activateFolderPlan(r: ObjectiveHookTestRig) {
  const digest = reportDigest(folderPlan)
  r.store.issue({
    attemptId: 'folder-plan', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
    reportPath: r.path, issuedAtMs: 1
  })
  r.store.accept({
    attemptId: 'folder-plan', watcherId: 'watcher', dispatchId: 'folder-plan-dispatch', role: 'planner',
    report: folderPlan, digest, acceptedAtMs: 1
  })
  r.store.activate('watcher', 'folder-plan', digest)
  return digest
}

function folderNodeAction(contentIdentity = 'objective-folder-v1:before') {
  return {
    kind: 'dispatch-node' as const, capability: 'implement' as const, visibility: 'local' as const,
    evidenceKey: 'node:1:write:1', revision: 1, taskKey: 'write', ordinal: 1, repairEpisode: 0,
    contentIdentity
  }
}

function markRunning(r: ObjectiveHookTestRig, attemptId: string, action: ObjectiveAction & { contentIdentity: string }) {
  r.journal.splice(0, r.journal.length, {
    seq: 1, kind: 'attempt', attemptId, state: 'running', dispatchId: `dispatch-${attemptId}`, action
  })
}

function appendRunning(r: ObjectiveHookTestRig, attemptId: string, action: ObjectiveAction & { contentIdentity: string }, seq: number) {
  r.journal.push({
    seq, kind: 'attempt', attemptId, state: 'running', dispatchId: `dispatch-${attemptId}`, action
  })
  return r.journal.length - 1
}

function settleAttempt(r: ObjectiveHookTestRig, index: number, effect: 'landed' | 'not-landed' = 'landed') {
  r.journal[index] = { ...r.journal[index]!, state: 'settled', effect }
}

function folderWorkspace(r: ObjectiveHookTestRig, id = 'wt', repoId = r.enrollment.repoId) {
  r.enrollment.worktreeId = id
  r.enrollment.repoId = repoId
  r.enrollment.kindPayload.worktree = `id:${id}`
  r.setResolvedWorkspace({ id, repoId, path: r.root, kind: 'folder', branch: null, headSha: null })
}

async function dispatchFolderNode(r: ObjectiveHookTestRig, attemptId: string) {
  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  const action = folderNodeAction(snapshot.contentIdentity)
  markRunning(r, attemptId, action)
  await r.hooks.execute({ action, enrollment: r.enrollment, attemptId })
  return { snapshot, action, issued: r.store.issued('watcher').find(row => row.attemptId === attemptId)! }
}

async function runFolderVerifications(r: ObjectiveHookTestRig, firstSeq: number) {
  const commands: string[] = []
  let seq = firstSeq
  for (let index = 0; index < 10; index++) {
    const snapshot = await r.hooks.read({ enrollment: r.enrollment })
    const decision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
    const action = decision.action
    if (!action || (action.kind !== 'run-check' && action.kind !== 'run-gate')) {
      return { snapshot, decision, commands }
    }
    const attemptId = `folder-check-${seq}`
    const journalIndex = appendRunning(r, attemptId, action as ObjectiveAction & { contentIdentity: string }, seq)
    const result = await r.hooks.execute({
      action: action as ObjectiveAction & { contentIdentity: string },
      enrollment: r.enrollment,
      attemptId
    })
    expect(result).toMatchObject({ effect: 'landed' })
    settleAttempt(r, journalIndex)
    commands.push(action.command)
    seq++
  }
  throw new Error('Folder checks did not reach their next review or landing action.')
}

async function submitFolderImplementer(
  r: ObjectiveHookTestRig,
  attemptId: string,
  reportPath: string,
  filesModified: string[] = []
) {
  writeFileSync(reportPath, JSON.stringify({
    taskKey: 'write',
    summary: 'Verified the ready result.',
    filesModified,
    criteriaSelfAssessment: folderTask.criteria.map((_, criterionIndex) => ({
      criterionIndex, result: 'pass', note: 'The criterion is satisfied.'
    }))
  }))
  const verdict = await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: `${attemptId}-run`, taskId: `${attemptId}-task`, dispatchId: `dispatch-${attemptId}`,
      type: 'worker_done', subject: 'Write result', body: 'Verify the result.',
      payload: { outcome: 'succeeded', reportPath }
    }
  })
  expect(verdict).toEqual({ kind: 'accepted' })
  const journalIndex = r.journal.findIndex(entry => entry.attemptId === attemptId)
  expect(journalIndex).toBeGreaterThanOrEqual(0)
  settleAttempt(r, journalIndex)
}

test('folder enrollment accepts files-on-disk and refuses every Git-dependent bar', async () => {
  for (const registration of [
    { id: 'folder-project-wt', repoId: 'folder-project' },
    { id: 'group-folder-wt', repoId: 'group:team' }
  ]) {
    const r = rig('standard', 'folder', registration.repoId)
    folderWorkspace(r, registration.id, registration.repoId)
    for (const maxConcurrency of [undefined, 1, 3, 17, 1024]) {
      const input = {
        objectiveText: 'Complete a folder objective.',
        tier: 'standard',
        landingBar: 'files-on-disk',
        lanesEnabled: true,
        writeTerritory: ['src/**'],
        roleAgents: { planner: 'claude' },
        gates: [],
        worktree: `id:${registration.id}`,
        ...(maxConcurrency === undefined ? {} : { maxConcurrency })
      }
      const authorized = await r.hooks.authorize({ input: { kindPayload: input } })
      expect(authorized).toMatchObject({
        workspaceKey: `local::${r.root}`,
        workspacePath: r.root,
        worktreeId: registration.id,
        repoId: registration.repoId,
        kindPayload: { worktree: `id:${registration.id}`, landingBar: 'files-on-disk', maxConcurrency: 1 }
      })
      expect(r.callParams.filter(([method]) => method === 'quirky.worktree/resolve').at(-1)).toEqual([
        'quirky.worktree/resolve', { selector: `id:${registration.id}` }
      ])
      r.enrollment.worktreeId = registration.id
      Object.assign(r.enrollment.kindPayload, authorized.kindPayload)
    }
    const detail = await r.hooks.detail({ watcherId: 'watcher' })
    expect(detail).toMatchObject({
      workspacePath: r.root,
      worktreeId: registration.id,
      contract: { landingBar: 'files-on-disk', maxConcurrency: 1 },
      effectiveConcurrency: 1,
      git: { branch: null, headSha: null }
    })

    for (const landingBar of ['committed-local-branch', 'pushed-ref', 'hosted-review', 'merged'] as const) {
      await expect(r.hooks.authorize({
        input: { kindPayload: { ...r.enrollment.kindPayload, landingBar } }
      })).rejects.toThrow(/^landing-bar-requires-git:/)
    }
    for (const landingBar of ['dirty', 'committed', 'merged-into-base']) {
      expect(validateValue(objectivePayloadSchema, { ...r.enrollment.kindPayload, landingBar }, 'kindPayload')).not.toBeNull()
    }
    for (const maxConcurrency of [0, 1025, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const invalid = await r.hooks.authorize({
        input: { kindPayload: { ...r.enrollment.kindPayload, maxConcurrency } }
      })
      expect(validateValue(objectivePayloadSchema, invalid.kindPayload, 'kindPayload')).not.toBeNull()
    }
    expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
    expect(r.calls).not.toContain('quirky.hosting/repository')
    expect(r.calls).not.toContain('quirky.hosting/diagnoseAuth')
  }
})

test('folder dispatch baselines survive reopen and reject outside or unreported writes', async () => {
  for (const scenario of [
    {
      attemptId: 'outside-change',
      filesModified: ['src/result.txt'],
      changeOutside: true,
      expected: {
        code: 'observed-change-outside-write-territory',
        observedPaths: ['outside.txt', 'src/result.txt'],
        outsidePaths: ['outside.txt'],
        unreportedPaths: []
      }
    },
    {
      attemptId: 'unreported-change',
      filesModified: [],
      changeOutside: false,
      expected: {
        code: 'unreported-observed-change',
        observedPaths: ['src/result.txt'],
        outsidePaths: [],
        unreportedPaths: ['src/result.txt']
      }
    }
  ]) {
    const r = rig('express', 'folder')
    r.enrollment.kindPayload.writeTerritory = ['src/**']
    folderWorkspace(r)
    mkdirSync(join(r.root, 'src'))
    writeFileSync(join(r.root, 'src', 'before.txt'), 'unchanged inside\n')
    writeFileSync(join(r.root, 'outside.txt'), 'enrollment bytes\n')
    const enrollmentSnapshot = await r.hooks.read({ enrollment: r.enrollment })
    writeFileSync(join(r.root, 'outside.txt'), 'dispatch bytes\n')
    const dispatchSnapshot = await r.hooks.read({ enrollment: r.enrollment })
    activateFolderPlan(r)
    const { issued } = await dispatchFolderNode(r, scenario.attemptId)
    expect(issued.baseline).toMatchObject({
      kind: 'folder',
      version: 1,
      contentIdentity: dispatchSnapshot.contentIdentity,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'outside.txt', kind: 'file' }),
        expect.objectContaining({ path: 'src/before.txt', kind: 'file' })
      ])
    })
    const baseline = issued.baseline
    if (!baseline || baseline.kind !== 'folder') throw new Error('Expected a persisted folder task baseline.')
    expect(baseline.contentIdentity).not.toBe(enrollmentSnapshot.contentIdentity)

    const reopenedStore = createObjectiveStore(r.context)
    const reopenedHooks = createObjectiveHooks(r.context, reopenedStore)
    writeFileSync(join(r.root, 'src', 'result.txt'), 'ready\n')
    if (scenario.changeOutside) writeFileSync(join(r.root, 'outside.txt'), 'worker changed outside\n')
    const workerReport = {
      taskKey: 'write',
      summary: 'Wrote the result.',
      filesModified: scenario.filesModified,
      criteriaSelfAssessment: [
        { criterionIndex: 0, result: 'pass' as const, note: 'The content is ready.' },
        { criterionIndex: 1, result: 'pass' as const, note: 'The file exists.' }
      ]
    }
    writeFileSync(issued.reportPath, JSON.stringify(workerReport))
    const verdict = await reopenedHooks.submission({
      enrollment: r.enrollment,
      submission: {
        runId: 'worker-run', taskId: 'worker-task', dispatchId: `dispatch-${scenario.attemptId}`,
        type: 'worker_done', subject: 'Write result', body: 'Complete the task.',
        payload: { outcome: 'succeeded', reportPath: issued.reportPath }
      }
    })
    expect(verdict).toMatchObject({ kind: 'rejected', code: scenario.expected.code })
    expect(reopenedStore.overruns('watcher')).toContainEqual(expect.objectContaining({
      attemptId: scenario.attemptId,
      code: scenario.expected.code,
      observedPaths: scenario.expected.observedPaths,
      outsidePaths: scenario.expected.outsidePaths,
      unreportedPaths: scenario.expected.unreportedPaths
    }))
    expect(reopenedStore.report(scenario.attemptId)).toBeNull()
    expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
    const resolutions = r.callParams.filter(([method]) => method === 'quirky.worktree/resolve')
    expect(resolutions.length).toBeGreaterThanOrEqual(4)
    expect(resolutions.every(([, params]) => params.selector === 'id:wt')).toBe(true)
  }
})

test('folder checks and tiered review retain content-bound evidence without Git', async () => {
  const r = rig('full', 'folder')
  folderWorkspace(r)
  Object.assign(r.enrollment.capabilities, { check: 'on', review: 'on', land: 'on' })
  Object.assign(r.enrollment.kindPayload, {
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: { planner: 'claude', implementer: 'claude', reviewer: 'claude', integrator: 'claude' },
    gates: [{ name: 'folder-smoke', command: 'test -f src/result.txt', timeoutSeconds: 10 }]
  })
  mkdirSync(join(r.root, 'src'))
  writeFileSync(join(r.root, 'src', 'result.txt'), 'ready\n')
  activateFolderPlan(r)

  const { issued: taskIssue } = await dispatchFolderNode(r, 'folder-implementer')
  await submitFolderImplementer(r, 'folder-implementer', taskIssue.reportPath)
  const taskBaseline = taskIssue.baseline
  if (!taskBaseline || taskBaseline.kind !== 'folder') throw new Error('Expected the integrator workflow task baseline.')
  const initialIdentity = taskBaseline.contentIdentity
  const initialVerification = await runFolderVerifications(r, 2)
  expect(initialVerification.commands).toEqual([
    'grep -q ready src/result.txt',
    'test -f src/result.txt',
    'test -f src/result.txt'
  ])
  expect(initialVerification.decision.action).toMatchObject({
    kind: 'dispatch-reviewer', contentIdentity: initialIdentity
  })
  expect(r.store.checks('watcher')).toEqual(expect.arrayContaining([
    expect.objectContaining({ contentIdentity: initialIdentity, command: 'grep -q ready src/result.txt', status: 'passed' }),
    expect.objectContaining({ contentIdentity: initialIdentity, command: 'test -f src/result.txt', status: 'passed' })
  ]))

  const reviewerAction = initialVerification.decision.action
  if (reviewerAction?.kind !== 'dispatch-reviewer') throw new Error('Expected the first folder reviewer action.')
  const reviewerAttemptId = 'folder-review-1'
  const reviewerIndex = appendRunning(r, reviewerAttemptId, reviewerAction, r.journal.length + 1)
  await r.hooks.execute({ action: reviewerAction, enrollment: r.enrollment, attemptId: reviewerAttemptId })
  const reviewerIssue = r.store.issued('watcher').find(row => row.attemptId === reviewerAttemptId)!
  writeFileSync(reviewerIssue.reportPath, JSON.stringify({
    verdict: 'approve',
    criteriaResults: folderTask.criteria.map((_, criterionIndex) => ({
      taskKey: 'write', criterionIndex, result: 'pass', note: 'The check passed.'
    })),
    summary: 'The folder result is ready.'
  }))
  expect(await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: 'folder-review-1-run', taskId: 'folder-review-1-task', dispatchId: 'dispatch-folder-review-1',
      type: 'worker_done', subject: 'Review', body: 'Approve the result.',
      payload: { outcome: 'succeeded', reportPath: reviewerIssue.reportPath }
    }
  })).toEqual({ kind: 'accepted' })
  settleAttempt(r, reviewerIndex)

  const afterFirstReview = await r.hooks.read({ enrollment: r.enrollment })
  const integrationDecision = r.hooks.decide({
    snapshot: afterFirstReview, journal: r.journal, enrollment: r.enrollment
  })
  const integratorAction = integrationDecision.action
  if (integratorAction?.kind !== 'dispatch-integrator') throw new Error('Expected the full-tier integrator action.')
  expect(integratorAction.contentIdentity).toBe(initialIdentity)
  const integratorAttemptId = 'folder-integrator-1'
  const integratorIndex = appendRunning(r, integratorAttemptId, integratorAction, r.journal.length + 1)
  await r.hooks.execute({ action: integratorAction, enrollment: r.enrollment, attemptId: integratorAttemptId })
  const integratorIssue = r.store.issued('watcher').find(row => row.attemptId === integratorAttemptId)!
  writeFileSync(join(r.root, 'src', 'integrator-note.txt'), 'Inside the authorized territory.\n')
  writeFileSync(integratorIssue.reportPath, JSON.stringify({
    verdict: 'approve',
    criteriaResults: folderTask.criteria.map((_, criterionIndex) => ({
      taskKey: 'write', criterionIndex, result: 'pass', note: 'The criterion is satisfied.'
    })),
    checksRun: [],
    summary: 'Integrated a small in-territory improvement.'
  }))
  expect(await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: 'folder-integrator-1-run', taskId: 'folder-integrator-1-task',
      dispatchId: 'dispatch-folder-integrator-1', type: 'worker_done',
      subject: 'Integrate', body: 'Make the in-territory change.',
      payload: { outcome: 'succeeded', reportPath: integratorIssue.reportPath }
    }
  })).toEqual({ kind: 'accepted' })
  settleAttempt(r, integratorIndex)

  const afterIntegratorEdit = await r.hooks.read({ enrollment: r.enrollment })
  expect(afterIntegratorEdit.contentIdentity).not.toBe(initialIdentity)
  expect(r.store.verdicts('watcher')).toContainEqual(expect.objectContaining({
    attemptId: integratorAttemptId, contentIdentity: afterIntegratorEdit.contentIdentity, verdict: 'approve'
  }))
  const refreshedVerification = await runFolderVerifications(r, r.journal.length + 1)
  expect(refreshedVerification.commands).toEqual(initialVerification.commands)
  const refreshedChecks = r.store.checks('watcher').filter(check =>
    check.contentIdentity === afterIntegratorEdit.contentIdentity && check.status === 'passed'
  )
  expect(refreshedChecks.map(check => check.command).sort()).toEqual([...initialVerification.commands].sort())
  expect(refreshedVerification.decision.action).toMatchObject({
    kind: 'dispatch-reviewer', contentIdentity: afterIntegratorEdit.contentIdentity
  })
  const refreshedReviewerAction = refreshedVerification.decision.action
  if (refreshedReviewerAction?.kind !== 'dispatch-reviewer') throw new Error('Expected fresh review after the integrator edit.')
  const refreshedReviewerId = 'folder-review-2'
  const refreshedReviewerIndex = appendRunning(r, refreshedReviewerId, refreshedReviewerAction, r.journal.length + 1)
  await r.hooks.execute({
    action: refreshedReviewerAction, enrollment: r.enrollment, attemptId: refreshedReviewerId
  })
  const refreshedReviewerIssue = r.store.issued('watcher').find(row => row.attemptId === refreshedReviewerId)!
  writeFileSync(refreshedReviewerIssue.reportPath, JSON.stringify({
    verdict: 'approve',
    criteriaResults: folderTask.criteria.map((_, criterionIndex) => ({
      taskKey: 'write', criterionIndex, result: 'pass', note: 'Fresh checks passed.'
    })),
    summary: 'Approved the changed folder identity.'
  }))
  expect(await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: 'folder-review-2-run', taskId: 'folder-review-2-task',
      dispatchId: 'dispatch-folder-review-2', type: 'worker_done',
      subject: 'Review', body: 'Review the changed identity.',
      payload: { outcome: 'succeeded', reportPath: refreshedReviewerIssue.reportPath }
    }
  })).toEqual({ kind: 'accepted' })
  settleAttempt(r, refreshedReviewerIndex)
  expect(r.store.verdicts('watcher')).toContainEqual(expect.objectContaining({
    attemptId: refreshedReviewerId, contentIdentity: afterIntegratorEdit.contentIdentity, verdict: 'approve'
  }))
  expect(r.store.landings('watcher')).toEqual([])
  expect(r.processCalls.every(call => call.cwd === r.root)).toBe(true)
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
})

test('folder reviewer changes outside private reports are rejected from observed deltas', async () => {
  const r = rig('standard', 'folder')
  folderWorkspace(r)
  Object.assign(r.enrollment.capabilities, { review: 'on' })
  r.enrollment.kindPayload.roleAgents = { reviewer: 'claude' }
  activateFolderPlan(r)
  writeFileSync(join(r.root, 'outside.txt'), 'before review\n')
  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  const action = {
    kind: 'dispatch-reviewer' as const, capability: 'review' as const, visibility: 'local' as const,
    evidenceKey: `review:1:reviewer:${snapshot.contentIdentity}:1`, revision: 1,
    contentIdentity: snapshot.contentIdentity, ordinal: 1
  }
  markRunning(r, 'reviewer-change', action)
  await r.hooks.execute({ action, enrollment: r.enrollment, attemptId: 'reviewer-change' })
  const issued = r.store.issued('watcher').find(row => row.attemptId === 'reviewer-change')!
  writeFileSync(join(r.root, 'outside.txt'), 'reviewer changed user content\n')
  writeFileSync(issued.reportPath, JSON.stringify({
    verdict: 'approve',
    criteriaResults: folderTask.criteria.map((_, criterionIndex) => ({
      taskKey: 'write', criterionIndex, result: 'pass', note: 'The criterion is satisfied.'
    })),
    summary: 'Reviewed the objective.'
  }))

  const submitted = await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: 'reviewer-run', taskId: 'reviewer-task', dispatchId: 'dispatch-reviewer-change',
      type: 'worker_done', subject: 'Review', body: 'Approve the result.',
      payload: { outcome: 'succeeded', reportPath: issued.reportPath }
    }
  })
  expect(submitted).toMatchObject({ kind: 'rejected', code: 'reviewer-modified-workspace' })
  expect(r.store.overruns('watcher')).toContainEqual(expect.objectContaining({
    attemptId: 'reviewer-change', code: 'reviewer-modified-workspace', observedPaths: ['outside.txt']
  }))
  expect(r.store.verdicts('watcher')).toEqual([])
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
})

test('folder runtime uses fresh public workspace facts without Git fallback', async () => {
  const r = rig('standard', 'folder', 'group:team')
  folderWorkspace(r, 'group-folder-wt', 'group:team')
  writeFileSync(join(r.root, 'src.txt'), 'folder bytes\n')

  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  expect(snapshot.world.workspaceKind).toBe('folder')
  expect(snapshot.world.git).toEqual({ branch: null, headSha: null })
  expect(snapshot.contentIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/u)
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
  const forgedPayload = { ...r.enrollment.kindPayload, landingBar: 'committed-local-branch' } as never
  r.enrollment.kindPayload = forgedPayload
  snapshot.world.enrollment.kindPayload = forgedPayload
  r.store.recordLanding({
    watcherId: 'watcher', rung: 'committed-local-branch', contentIdentity: snapshot.contentIdentity,
    attemptId: 'forged-commit', payload: { revision: 1 }, recordedAtMs: 1
  })
  expect(r.hooks.pace({ snapshot, journal: [] })).toBe('idle')
  expect(r.hooks.decide({ snapshot, journal: [], enrollment: r.enrollment })).toMatchObject({
    action: null, reason: 'landing-bar-requires-git'
  })
  expect(r.hooks.stop({ snapshot, journal: [], enrollment: r.enrollment })).toMatchObject({
    kind: 'park', detail: expect.stringContaining('Folder workspaces support only files-on-disk')
  })
  const validFolderPayload = { ...r.enrollment.kindPayload, landingBar: 'files-on-disk' } as never
  r.enrollment.kindPayload = validFolderPayload
  snapshot.world.enrollment.kindPayload = validFolderPayload

  for (const replacement of [
    null,
    { id: 'replacement', repoId: 'group:team', path: r.root, kind: 'folder' },
    { id: 'group-folder-wt', repoId: 'group:other', path: r.root, kind: 'folder' },
    { id: 'group-folder-wt', repoId: 'group:team', path: join(r.root, 'replacement'), kind: 'folder' },
    { id: 'group-folder-wt', repoId: 'group:team', path: r.root, kind: 'unknown' }
  ]) {
    r.setResolvedWorkspace(replacement)
    await expect(r.hooks.read({ enrollment: r.enrollment })).rejects.toThrow()
  }
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
})

test('folder execute and submission refuse changed public workspace facts', async () => {
  const r = rig('express', 'folder')
  folderWorkspace(r)
  r.enrollment.kindPayload.roleAgents = { implementer: 'claude' }
  mkdirSync(join(r.root, 'src'))
  writeFileSync(join(r.root, 'src', 'result.txt'), 'ready\n')
  activateFolderPlan(r)
  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  const action = folderNodeAction(snapshot.contentIdentity)

  markRunning(r, 'stale-execute', action)
  r.setResolvedWorkspace({
    id: 'wt', repoId: 'folder-project', path: join(r.root, 'replacement'),
    kind: 'folder', branch: null, headSha: null
  })
  await expect(r.hooks.execute({
    action, enrollment: r.enrollment, attemptId: 'stale-execute'
  })).rejects.toThrow()

  folderWorkspace(r)
  markRunning(r, 'stale-submission', action)
  await r.hooks.execute({ action, enrollment: r.enrollment, attemptId: 'stale-submission' })
  const issued = r.store.issued('watcher').find(row => row.attemptId === 'stale-submission')!
  writeFileSync(issued.reportPath, JSON.stringify({
    taskKey: 'write', summary: 'Verified the result.', filesModified: [],
    criteriaSelfAssessment: folderTask.criteria.map((_, criterionIndex) => ({
      criterionIndex, result: 'pass', note: 'The criterion is satisfied.'
    }))
  }))
  r.setResolvedWorkspace({
    id: 'wt', repoId: 'group:replacement', path: r.root,
    kind: 'folder', branch: null, headSha: null
  })
  const submission = await r.hooks.submission({
    enrollment: r.enrollment,
    submission: {
      runId: 'stale-submission-run', taskId: 'stale-submission-task',
      dispatchId: 'dispatch-stale-submission', type: 'worker_done',
      subject: 'Write result', body: 'Verify the result.',
      payload: { outcome: 'succeeded', reportPath: issued.reportPath }
    }
  }).then(value => value, () => null)
  expect(submission).not.toMatchObject({ kind: 'accepted' })
  expect(r.store.report('stale-submission')).toBeNull()
  expect(r.callParams.filter(([method]) => method === 'quirky.worktree/resolve').length).toBeGreaterThanOrEqual(4)
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
})

test('folder report creation rejects symlinked report-directory components', async () => {
  for (const component of ['.quirky', 'objective', 'watcher'] as const) {
    const r = rig('express', 'folder')
    folderWorkspace(r)
    r.enrollment.kindPayload.roleAgents = { planner: 'claude' }
    const quirkyPath = join(r.root, '.quirky')
    const objectivePath = join(quirkyPath, 'objective')
    const watcherPath = join(objectivePath, 'watcher')
    if (component === '.quirky') {
      rmSync(quirkyPath, { recursive: true, force: true })
      symlinkSync(r.context.dataDir, quirkyPath)
    } else {
      mkdirSync(quirkyPath, { recursive: true })
      if (component === 'objective') {
        rmSync(objectivePath, { recursive: true, force: true })
        symlinkSync(r.context.dataDir, objectivePath)
      } else {
        mkdirSync(objectivePath, { recursive: true })
        rmSync(watcherPath, { recursive: true, force: true })
        symlinkSync(r.context.dataDir, watcherPath)
      }
    }
    const attemptId = `linked-${component}`
    const action = {
      kind: 'dispatch-planner' as const, capability: 'plan' as const, visibility: 'local' as const,
      evidenceKey: 'plan:1', ordinal: 1, plannerMode: 'initial' as const,
      contentIdentity: 'objective-folder-v1:before'
    }
    markRunning(r, attemptId, action)
    const outcome = await r.hooks.execute({ action, enrollment: r.enrollment, attemptId }).then(
      value => ({ value, error: '' }),
      error => ({ value: null, error: error instanceof Error ? error.message : String(error) })
    )
    expect(outcome.error || JSON.stringify(outcome.value)).toContain('report-path-mismatch')
    const escapedReport = component === '.quirky'
      ? join(r.context.dataDir, 'objective', 'watcher', `${attemptId}.json`)
      : component === 'objective'
        ? join(r.context.dataDir, 'watcher', `${attemptId}.json`)
        : join(r.context.dataDir, `${attemptId}.json`)
    expect(existsSync(escapedReport)).toBe(false)
    expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
  }
})

test('folder files-on-disk landing is verified and cannot execute Git actions', async () => {
  const r = rig('express', 'folder')
  folderWorkspace(r)
  Object.assign(r.enrollment.capabilities, { check: 'on', land: 'on' })
  Object.assign(r.enrollment.kindPayload, {
    maxConcurrency: 1,
    writeTerritory: ['src/**'],
    roleAgents: { implementer: 'claude' }
  })
  mkdirSync(join(r.root, 'src'))
  writeFileSync(join(r.root, 'src', 'result.txt'), 'ready\n')
  activateFolderPlan(r)

  const { issued: taskIssue } = await dispatchFolderNode(r, 'folder-implementer')
  await submitFolderImplementer(r, 'folder-implementer', taskIssue.reportPath)
  const verification = await runFolderVerifications(r, 2)
  expect(verification.commands).toEqual([
    'grep -q ready src/result.txt',
    'test -f src/result.txt'
  ])
  const landingAction = verification.decision.action
  if (landingAction?.kind !== 'record-landing') throw new Error('Expected a verified files-on-disk landing action.')
  const landingAttempt = 'folder-landing-1'
  const landingIndex = appendRunning(r, landingAttempt, landingAction, r.journal.length + 1)
  expect(await r.hooks.execute({
    action: landingAction, enrollment: r.enrollment, attemptId: landingAttempt
  })).toEqual({ effect: 'landed' })
  settleAttempt(r, landingIndex)
  expect(r.store.landings('watcher')).toHaveLength(1)
  expect(r.store.landings('watcher')[0]).toMatchObject({
    rung: 'files-on-disk', contentIdentity: landingAction.contentIdentity
  })

  const recoveryIndex = appendRunning(r, 'folder-landing-recovery', landingAction, r.journal.length + 1)
  expect(await r.hooks.execute({
    action: landingAction, enrollment: r.enrollment, attemptId: 'folder-landing-recovery'
  })).toEqual({ effect: 'landed' })
  settleAttempt(r, recoveryIndex)
  expect(r.store.landings('watcher')).toHaveLength(1)

  const landedSnapshot = await r.hooks.read({ enrollment: r.enrollment })
  expect(r.hooks.stop({ snapshot: landedSnapshot, journal: r.journal, enrollment: r.enrollment })).toEqual({
    kind: 'terminal', state: 'landed', reason: 'files-on-disk landing bar reached'
  })
  const resolutionCountBeforeDetail = r.callParams.filter(([method]) => method === 'quirky.worktree/resolve').length
  const detail = await r.hooks.detail({ watcherId: 'watcher' })
  expect(detail).toMatchObject({
    effectiveConcurrency: 1,
    git: { branch: null, headSha: null },
    completion: {
      requestedBar: 'files-on-disk',
      reachedBar: 'files-on-disk',
      state: 'landed',
      reason: 'files-on-disk landing bar reached',
      handoff: null,
      mergedEvidence: null
    }
  })
  expect(r.callParams.filter(([method]) => method === 'quirky.worktree/resolve').length)
    .toBeGreaterThan(resolutionCountBeforeDetail)

  const contentIdentity = landingAction.contentIdentity
  const actions = [
    {
      kind: 'commit-local-branch', capability: 'land', visibility: 'local', recovery: 'replay-safe',
      evidenceKey: `committed-local-branch:${contentIdentity}:main:head`, revision: 1,
      contentIdentity, branch: 'main', headSha: 'head'
    },
    {
      kind: 'push-ref', capability: 'land', visibility: 'external', evidenceKey: 'push-ref:forged',
      ordinal: 1, retryGeneration: 0, revision: 1, contentIdentity,
      authority: {} as never, expectedState: {} as never
    },
    {
      kind: 'open-hosted-review', capability: 'land', visibility: 'external', evidenceKey: 'review:forged',
      ordinal: 1, retryGeneration: 0, revision: 1, contentIdentity,
      authority: {} as never, expectedState: {} as never
    }
  ] as const
  for (const [index, action] of actions.entries()) {
    const outcome = await r.hooks.execute({
      action: action as never, enrollment: r.enrollment, attemptId: `forged-git-${index}`
    }).then(
      value => ({ value, error: '' }),
      error => ({ value: null, error: error instanceof Error ? error.message : String(error) })
    )
    expect(outcome.error || JSON.stringify(outcome.value)).toContain('landing-bar-requires-git')
  }
  expect(existsSync(join(r.root, '.git'))).toBe(false)
  expect(r.processCalls.every(call => call.cwd === r.root)).toBe(true)
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
  expect(r.calls).not.toContain('quirky.hosting/repository')
  expect(r.calls).not.toContain('quirky.hosting/diagnoseAuth')
})

test('terminal folder detail uses its saved rung after the workspace disappears without Git', async () => {
  const r = rig('standard', 'folder')
  folderWorkspace(r)
  activateFolderPlan(r)
  const contentIdentity = `objective-folder-v1:${'a'.repeat(64)}`
  r.store.recordLanding({
    watcherId: 'watcher', rung: 'files-on-disk', contentIdentity, attemptId: 'saved-folder-rung',
    payload: { revision: 1, tasks: [{ taskKey: 'write', state: 'succeeded', attempts: 1,
      successfulAttemptId: null, summary: 'Saved completed task' }] }, recordedAtMs: 2
  })
  r.enrollment.terminalAtMs = 3
  rmSync(r.root, { recursive: true, force: true })

  const detail = await r.hooks.detail({ watcherId: 'watcher' })
  expect(detail).toMatchObject({
    workspacePath: r.root,
    git: { branch: null, headSha: null },
    completion: {
      requestedBar: 'files-on-disk',
      reachedBar: 'files-on-disk',
      state: 'landed',
      reason: 'files-on-disk landing bar reached',
      handoff: null,
      mergedEvidence: null
    }
  })
  expect(r.processCalls.filter(call => call.argv[0] === 'git')).toEqual([])
})

test('submission rejects missing, aliased, oversized and malformed reports without settling an attempt', async () => {
  const r = rig()
  expect(await r.submit()).toMatchObject({ kind: 'rejected', code: 'missing-report' })
  expect(await r.submit(join(r.root, 'elsewhere.json'))).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  writeFileSync(r.path, JSON.stringify(report))
  const alias = join(r.root, 'alias.json')
  symlinkSync(r.path, alias)
  expect(await r.submit(alias)).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  rmSync(r.path)
  symlinkSync(alias, r.path)
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  rmSync(r.path)
  writeFileSync(r.path, 'x'.repeat(262145))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-too-large' })
  writeFileSync(r.path, '{')
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'invalid-report' })
  writeFileSync(r.path, JSON.stringify({ plan: { tasks: [] }, assumptions: [] }))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'invalid-report', reason: expect.stringContaining('tasks') })
  expect(r.store.reports('watcher')).toEqual([])
  expect(await r.submit(undefined, 'failed')).toEqual({ kind: 'accepted' })
})

test('an accepted report is immutable but the same digest is safe to submit again', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const accepted = r.store.reports('watcher')
  expect(accepted[0]?.report).toEqual(report)
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  expect(r.store.reports('watcher')).toEqual(accepted)
  writeFileSync(r.path, JSON.stringify({ ...report, assumptions: [{ claim: 'A changed report', dependentTaskKeys: ['multiply'] }] }))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-already-accepted' })
  expect(r.store.reports('watcher')).toEqual(accepted)
})

test('deciding and stopping trust reports accepted after the tree snapshot was read', async () => {
  const r = rig()
  const snapshot: ObjectiveSnapshot = { freshness: 'live', contentIdentity: 'tree:before', observedAtMs: 1,
    world: { planMode: 'gated', revision: null, reports: [], issued: r.store.issued('watcher') } }
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const journal: ObjectiveJournalEntry[] = [1, 2, 3].map(seq => ({
    seq, kind: 'attempt', attemptId: seq === 3 ? 'attempt' : `failed-${seq}`, state: 'settled',
    effect: seq === 3 ? 'landed' : 'not-landed', action: { kind: 'dispatch-planner' }
  }))
  expect(r.hooks.stop({ snapshot, journal, enrollment: r.enrollment })).toBeNull()
  expect(r.hooks.decide({ snapshot, journal, enrollment: r.enrollment })).toMatchObject({
    action: { kind: 'activate-plan', plannerAttemptId: 'attempt', contentIdentity: 'tree:before' }
  })
})

test('tree identity includes ignored tracked files and newly staged ignored files without changing the real index', async () => {
  const r = rig()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', r.root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'pipe', stderr: 'pipe'
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-q')
  writeFileSync(join(r.root, '.gitignore'), '*.ts\n.quirky/\n')
  writeFileSync(join(r.root, 'math.ts'), 'export const x = 1\n')
  git('add', '-f', '.gitignore', 'math.ts')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  const indexPath = git('rev-parse', '--git-path', 'index')
  const index = () => readFileSync(isAbsolute(indexPath) ? indexPath : join(r.root, indexPath))
  const originalIndex = index()
  const before = await r.hooks.read({ enrollment: r.enrollment })
  expect(r.hooks.pace({ snapshot: before, journal: [] })).toBe('rapid')
  writeFileSync(join(r.root, 'math.ts'), 'export const x = 2\n')
  const changed = await r.hooks.read({ enrollment: r.enrollment })
  expect(changed.contentIdentity).not.toBe(before.contentIdentity)
  expect(index()).toEqual(originalIndex)
  writeFileSync(join(r.root, 'new.ts'), 'export const y = 1\n')
  git('add', '-f', 'new.ts')
  const stagedIndex = index()
  const staged = await r.hooks.read({ enrollment: r.enrollment })
  expect(staged.contentIdentity).not.toBe(changed.contentIdentity)
  writeFileSync(join(r.root, 'new.ts'), 'export const y = 2\n')
  expect((await r.hooks.read({ enrollment: r.enrollment })).contentIdentity).not.toBe(staged.contentIdentity)
  expect(index()).toEqual(stagedIndex)
  const failedPlanners: ObjectiveJournalEntry[] = [1, 2, 3].map(seq => ({
    seq, kind: 'attempt', attemptId: seq === 3 ? 'attempt' : `failed-${seq}`, state: 'settled',
    effect: 'not-landed', action: { kind: 'dispatch-planner' }
  }))
  expect(r.hooks.pace({ snapshot: before, journal: failedPlanners })).toBe('idle')
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  failedPlanners[2] = { ...failedPlanners[2]!, effect: 'landed' }
  expect(r.hooks.pace({ snapshot: before, journal: failedPlanners })).toBe('rapid')
})

test('draft rejection checks the digest, persists feedback and cannot reject the same draft twice', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.journal.push({ seq: 2, kind: 'attempt', attemptId: 'attempt', state: 'settled', effect: 'landed', action: { kind: 'dispatch-planner' } })
  const digest = r.store.report('attempt')!.digest
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher', digest: 'wrong' })).rejects.toThrow('draft-digest-mismatch')
  expect(r.store.rejectedDrafts('watcher')).toEqual([])
  expect(await r.hooks.rejectDraft({ watcherId: 'watcher', digest, reason: 'Use a narrower plan.' }))
    .toEqual({ rejected: true, attemptId: 'attempt', digest, reason: 'Use a narrower plan.' })
  expect(r.store.rejectedDrafts('watcher')[0]).toMatchObject({ attemptId: 'attempt', digest, reason: 'Use a narrower plan.' })
  expect(r.calls.filter(method => method === 'quirky.heimdall/reconcile')).toEqual(['quirky.heimdall/reconcile'])
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher' })).rejects.toThrow('no-pending-draft')
})

test('draft rejection cannot revoke an already approved revision', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.journal.push({ seq: 2, kind: 'attempt', attemptId: 'attempt', state: 'settled', effect: 'landed', action: { kind: 'dispatch-planner' } })
  const revision = r.store.activate('watcher', 'attempt', r.store.report('attempt')!.digest)
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher' })).rejects.toThrow('no-pending-draft')
  expect(r.store.revision('watcher')).toEqual(revision)
  expect(r.store.rejectedDrafts('watcher')).toEqual([])
})

test('observed territory overruns remain visible even when the worker reports the forbidden path', async () => {
  const r = rig()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', r.root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'pipe', stderr: 'pipe'
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git('init', '-q')
  writeFileSync(join(r.root, 'math.ts'), 'export const multiply = (a, b) => a * b\n')
  git('add', 'math.ts')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.store.activate('watcher', 'attempt', r.store.report('attempt')!.digest)
  r.enrollment.kindPayload.writeTerritory = ['math.ts']
  const baseline = await r.hooks.read({ enrollment: r.enrollment })
  const workerPath = join(r.root, '.quirky', 'objective', 'watcher', 'worker-attempt.json')
  r.store.issue({ attemptId: 'worker-attempt', watcherId: 'watcher', role: 'implementer', revision: 1,
    taskKey: 'multiply', reportPath: workerPath, issuedAtMs: 2, baselineTree: baseline.contentIdentity.slice('objective-tree:'.length) })
  r.journal.splice(0, r.journal.length, { seq: 2, kind: 'attempt', attemptId: 'worker-attempt', state: 'running',
    dispatchId: 'dispatch', action: { kind: 'dispatch-node', revision: 1, taskKey: 'multiply' } })
  writeFileSync(join(r.root, 'outside.txt'), 'Outside the assigned write territory.\n')
  writeFileSync(workerPath, JSON.stringify({ taskKey: 'multiply', summary: 'Changed outside territory.',
    filesModified: ['outside.txt'], criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Implemented.' }] }))
  expect(await r.submit(workerPath)).toMatchObject({ kind: 'rejected', code: 'observed-change-outside-write-territory',
    reason: expect.stringContaining('outside.txt') })
  expect(r.store.overruns('watcher')).toContainEqual(expect.objectContaining({
    attemptId: 'worker-attempt', code: 'observed-change-outside-write-territory', outsidePaths: ['outside.txt']
  }))
})

test('reconciles persisted local effects only with the matching action authority', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const digest = r.store.report('attempt')!.digest
  const resolve = (action: ObjectiveAction & { contentIdentity: string }, attemptId = 'action-attempt') =>
    r.hooks.resolveOutcome({ attempt: { attemptId, action }, enrollment: r.enrollment })
  const activation = { kind: 'activate-plan', capability: 'plan', visibility: 'local', recovery: 'replay-safe',
    evidenceKey: 'activate-plan:attempt', plannerAttemptId: 'attempt', digest, contentIdentity: 'objective-tree:verified' } as const
  expect(resolve(activation)).toBeNull()
  r.store.activate('watcher', 'attempt', digest)
  expect(resolve(activation)).toEqual({ effect: 'landed' })
  expect(resolve({ ...activation, digest: 'different' })).toBeNull()

  const landing = { kind: 'record-landing', capability: 'land', visibility: 'local', recovery: 'replay-safe',
    evidenceKey: 'files-on-disk:objective-tree:verified', revision: 1, contentIdentity: 'objective-tree:verified' } as const
  expect(resolve(landing)).toBeNull()
  r.store.recordLanding({ watcherId: 'watcher', rung: 'files-on-disk', contentIdentity: landing.contentIdentity,
    attemptId: 'action-attempt', payload: { revision: 1 }, recordedAtMs: 10 })
  expect(resolve(landing)).toEqual({ effect: 'landed' })
  expect(resolve({ ...landing, revision: 2 })).toBeNull()
  const commit = { ...landing, kind: 'commit-local-branch', capability: 'land',
    evidenceKey: 'committed-local-branch:objective-tree:verified:main:before', branch: 'main', headSha: 'before' } as const
  expect(resolve(commit)).toBeNull()
  r.store.recordLanding({ watcherId: 'watcher', rung: 'committed-local-branch', contentIdentity: landing.contentIdentity,
    attemptId: 'commit-attempt', payload: { revision: 1, headSha: 'after', committedPaths: ['math.ts'] }, recordedAtMs: 11 })
  expect(resolve(commit, 'commit-attempt')).toEqual({ effect: 'landed' })
  expect(resolve(commit, 'other-attempt')).toBeNull()
})

test('lands a verification-only repair after a historical block and stops terminally', async () => {
  const r = rig('standard')
  async function runGit(...args: string[]): Promise<void> {
    const result = await r.context.process.run(['git', ...args], { cwd: r.root })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  await runGit('init', '-q')
  await runGit('config', 'user.name', 'Fixture')
  await runGit('config', 'user.email', 'fixture@example.test')
  await runGit('config', 'commit.gpgsign', 'false')
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'main.ts'), 'export const value = 1\n')
  await runGit('add', '-A')
  await runGit('commit', '-m', 'baseline')
  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  const contentIdentity = snapshot.contentIdentity
  r.journal.splice(0)

  const initialPlan = {
    plan: { tasks: [{
      taskKey: 'implement', title: 'Existing implementation', spec: 'No source changes are needed.',
      deps: [], territory: ['src/**'],
      criteria: [{ body: 'The existing source is ready.', shellCheckable: false, checkCommand: null }]
    }] },
    assumptions: []
  }
  const initialDigest = reportDigest(initialPlan)
  r.store.issue({
    attemptId: 'initial-plan', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
    reportPath: r.path, issuedAtMs: 1
  })
  r.store.accept({
    attemptId: 'initial-plan', watcherId: 'watcher', dispatchId: 'initial-plan-dispatch', role: 'planner',
    report: initialPlan, digest: initialDigest, acceptedAtMs: 1
  })
  r.store.activate('watcher', 'initial-plan', initialDigest)

  function settleTask(attemptId: string, taskKey: string, seq: number, repairEpisode?: number): void {
    const dispatchId = `${attemptId}-dispatch`
    const taskReport = {
      taskKey, summary: 'Verified without modifying files.', filesModified: [],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass' as const, note: 'Verified.' }]
    }
    r.store.issue({
      attemptId, watcherId: 'watcher', role: 'implementer', revision: 1, taskKey,
      reportPath: r.path, issuedAtMs: seq
    })
    r.store.accept({
      attemptId, watcherId: 'watcher', dispatchId, role: 'implementer',
      report: taskReport, digest: reportDigest(taskReport), acceptedAtMs: seq
    })
    r.journal.push({
      seq, kind: 'attempt', attemptId, state: 'settled', effect: 'landed', dispatchId,
      action: {
        kind: 'dispatch-node', revision: 1, taskKey,
        ...(repairEpisode === undefined ? {} : { repairEpisode })
      }
    })
  }
  settleTask('implementation-completed', 'implement', 1)

  r.store.issue({
    attemptId: 'historical-review', watcherId: 'watcher', role: 'reviewer', revision: 1, taskKey: null,
    reportPath: r.path, issuedAtMs: 2, contentIdentity
  })
  r.store.acceptVerdict({
    attemptId: 'historical-review', watcherId: 'watcher', dispatchId: 'historical-review-dispatch',
    revision: 1, role: 'reviewer', contentIdentity, verdict: 'block',
    criteriaResults: [], checksRun: [], summary: 'The initial review blocked.', digest: 'historical-review-digest', acceptedAtMs: 2
  })
  r.journal.push({
    seq: 2, kind: 'attempt', attemptId: 'historical-review', state: 'settled', effect: 'landed',
    dispatchId: 'historical-review-dispatch',
    action: {
      kind: 'dispatch-reviewer', revision: 1, contentIdentity,
      evidenceKey: `review:1:reviewer:${contentIdentity}:1`
    }
  })
  const verificationCommand = 'test -f src/main.ts'
  r.store.recordCheck({
    attemptId: 'old-verification-check', watcherId: 'watcher', revision: 1, kind: 'criterion',
    targetKey: 'verification:0', contentIdentity, command: verificationCommand, status: 'passed',
    exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '', checkedAtMs: 3
  })
  r.journal.push({
    seq: 3, kind: 'attempt', attemptId: 'old-verification-check', state: 'settled', effect: 'landed',
    action: {
      kind: 'run-check', revision: 1, taskKey: 'verification', criterionIndex: 0, command: verificationCommand,
      contentIdentity, evidenceKey: `check:1:verification:0:${contentIdentity}`
    }
  })
  expect(r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment }).action).toMatchObject({
    kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
  })

  const repairReport = {
    repair: {
      upsertTasks: [{
        taskKey: 'verification', title: 'Verify existing source', spec: 'Run the existing-file check only.',
        deps: ['implement'], territory: ['src/**'],
        criteria: [{ body: 'The source file exists.', shellCheckable: true, checkCommand: verificationCommand }]
      }],
      dropTaskKeys: []
    },
    assumptions: []
  }
  const repairDigest = reportDigest(repairReport)
  r.store.issue({
    attemptId: 'repair-planner', watcherId: 'watcher', role: 'planner', revision: 1, taskKey: null,
    plannerMode: 'repair', reportPath: r.path, issuedAtMs: 4
  })
  r.store.accept({
    attemptId: 'repair-planner', watcherId: 'watcher', dispatchId: 'repair-planner-dispatch', role: 'planner',
    report: repairReport, digest: repairDigest, acceptedAtMs: 4
  })
  r.store.applyRepair('watcher', 1, 1, 'repair-planner', repairDigest)
  const repair = r.store.repairs('watcher')[0]!
  settleTask('verification-completed', 'verification', 4, 1)
  const checkDecision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(checkDecision.action).toMatchObject({
    kind: 'run-check', taskKey: 'verification', evidenceKey: `check:1:verification:0:${contentIdentity}:r1`
  })
  if (checkDecision.action?.kind !== 'run-check') throw new Error('Expected a verification run-check action')
  expect(await r.hooks.execute({
    action: checkDecision.action, enrollment: r.enrollment, attemptId: 'verification-check'
  })).toEqual({ effect: 'landed' })
  r.journal.push({
    seq: 5, kind: 'attempt', attemptId: 'verification-check', state: 'settled', effect: 'landed',
    dispatchId: 'verification-check-dispatch', action: checkDecision.action
  })
  const reviewDecision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(reviewDecision.action).toMatchObject({ kind: 'dispatch-reviewer', ordinal: 2 })
  if (reviewDecision.action?.kind !== 'dispatch-reviewer') throw new Error('Expected a fresh reviewer action')
  const freshReviewAction = reviewDecision.action
  r.store.issue({
    attemptId: 'fresh-review', watcherId: 'watcher', role: 'reviewer', revision: 1, taskKey: null,
    reportPath: r.path, issuedAtMs: repair.appliedAtMs + 1, contentIdentity
  })
  r.store.acceptVerdict({
    attemptId: 'fresh-review', watcherId: 'watcher', dispatchId: 'fresh-review-dispatch',
    revision: 1, role: 'reviewer', contentIdentity, verdict: 'approve',
    criteriaResults: [
      { taskKey: 'implement', criterionIndex: 0, result: 'pass', note: 'Verified.' },
      { taskKey: 'verification', criterionIndex: 0, result: 'pass', note: 'Verified.' }
    ],
    checksRun: [], summary: 'Approved after repair.', digest: 'fresh-review-digest', acceptedAtMs: repair.appliedAtMs + 1
  })
  r.journal.push({
    seq: 6, kind: 'attempt', attemptId: 'fresh-review', state: 'settled', effect: 'landed',
    dispatchId: 'fresh-review-dispatch', action: freshReviewAction
  })

  expect((await r.hooks.read({ enrollment: r.enrollment })).contentIdentity).toBe(contentIdentity)
  const decision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(decision.action).toMatchObject({ kind: 'record-landing', contentIdentity })
  if (decision.action?.kind !== 'record-landing') throw new Error('Expected a record-landing action')
  expect(await r.hooks.execute({
    action: decision.action, enrollment: r.enrollment, attemptId: 'record-landing-attempt'
  })).toEqual({ effect: 'landed' })
  expect(r.store.verdicts('watcher')).toContainEqual(expect.objectContaining({
    attemptId: 'historical-review', verdict: 'block'
  }))
  expect(r.store.landings('watcher')).toHaveLength(1)
  expect(r.hooks.stop({ snapshot, journal: r.journal, enrollment: r.enrollment })).toEqual({
    kind: 'terminal', state: 'landed', reason: 'files-on-disk landing bar reached'
  })
}, 30_000)

test('folder canonical roots cannot be replaced by symlinks after enrollment', async () => {
  for (const repoId of ['folder-project', 'group:team']) {
    const r = rig('standard', 'folder', repoId)
    folderWorkspace(r)
    activateFolderPlan(r)
    const before = await r.hooks.read({ enrollment: r.enrollment })
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'objective-root-target-')))
    const savedRoot = `${r.root}-saved`
    cleanup.push(() => rmSync(target, { recursive: true, force: true }))
    cleanup.push(() => rmSync(savedRoot, { recursive: true, force: true }))
    writeFileSync(join(target, 'outside.txt'), 'not authorized')
    renameSync(r.root, savedRoot)
    symlinkSync(target, r.root)

    await expect(r.hooks.read({ enrollment: r.enrollment })).rejects.toThrow('worktree-unresolved')
    await expect(r.hooks.detail({ watcherId: 'watcher' })).rejects.toThrow('worktree-unresolved')
    await expect(r.hooks.execute({ action: folderNodeAction(before.contentIdentity),
      enrollment: r.enrollment, attemptId: 'retargeted-root' })).rejects.toThrow('worktree-unresolved')
    expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'worktree-unresolved' })
    expect(readFileSync(join(target, 'outside.txt'), 'utf8')).toBe('not authorized')
    expect(existsSync(join(target, '.quirky'))).toBe(false)
    expect(r.store.issued('watcher').some(row => row.attemptId === 'retargeted-root')).toBe(false)
  }
})

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { EvidenceEntry } from '../../shared/fork-heimdall/ledger-types'
import type { EnrollInput, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { HeimdallBudgetClock } from '../fork-heimdall/budget-clock'
import { HeimdallDatabase } from '../fork-heimdall/database'
import { HeimdallEnrollmentStore } from '../fork-heimdall/enrollment-store'
import { HeimdallKernelServiceImpl } from '../fork-heimdall/kernel-service'
import { HeimdallLedgerStore } from '../fork-heimdall/ledger-store'
import type { LeaseStore } from '../fork-heimdall/lease-store'
import type { HeimdallOrchestrationAdapter } from '../fork-heimdall/orchestration/orchestration-adapter'
import type { DispatchWorkerInput } from '../../shared/fork-heimdall/kind-contract'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { createObjectiveKind } from './kind'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { resolveExpectedObjectiveReportPath } from './report-ingestion'

vi.mock('electron', () => ({}))
const EXPECTED_CHANGED_PATHS = ['src/created.txt', 'src/obsolete.txt', 'src/result.txt'] as const

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'write-result',
      title: 'Write the objective result',
      spec: 'Replace the pending result with the completed result.',
      deps: [],
      criteria: [
        {
          body: 'The result file contains the completed value.',
          shellCheckable: true,
          checkCommand:
            'test "$(cat src/result.txt)" = "complete" && test "$(cat src/created.txt)" = "created" && test ! -e src/obsolete.txt'
        }
      ],
      declaresDependencyChange: false,
      declaredPaths: [...EXPECTED_CHANGED_PATHS],
      territory: ['src/**']
    }
  ],
  assumptions: []
}

/** Assesses every declared assumption in `PLAN` (none) with an approving verdict and no findings. */
const PLAN_REVIEW_APPROVAL: PlanReviewReport = {
  verdict: 'approve',
  assumptions: (PLAN.assumptions ?? []).map((_, index) => ({
    index,
    status: 'verified',
    evidence: 'Verified against the plan fixture.'
  })),
  findings: [],
  summary: 'Plan reviewed; no blocking findings.'
}

const temporaryDirectories: string[] = []
const closeables: (() => void)[] = []

afterEach(async () => {
  for (const close of closeables.splice(0).toReversed()) {
    close()
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

type WorkspaceFixture = {
  kind: 'folder' | 'git'
  root: string
  profile: string
  repoId: string
  worktreeId: string | null
  target: ObjectiveWorkspaceTarget
  runtime: QuirkyRuntimeService
  store: Store
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, admissionTier: 'background' })).stdout.trim()
}

async function workspaceFixture(kind: 'folder' | 'git'): Promise<WorkspaceFixture> {
  const parent = await mkdtemp(join(tmpdir(), `quirky-objective-kind-${kind}-`))
  temporaryDirectories.push(parent)
  const profile = join(parent, 'profile')
  const createdRoot = join(parent, 'workspace')
  await mkdir(join(createdRoot, 'src'), { recursive: true })
  await mkdir(profile)
  await writeFile(join(createdRoot, 'src', 'result.txt'), 'pending\n')
  await writeFile(join(createdRoot, 'src', 'obsolete.txt'), 'remove me\n')
  if (kind === 'git') {
    await runGit(createdRoot, ['init', '-b', 'main'])
    await runGit(createdRoot, ['config', 'user.name', 'Objective Integration'])
    await runGit(createdRoot, ['config', 'user.email', 'objective@example.test'])
    await runGit(createdRoot, ['config', 'commit.gpgsign', 'false'])
    await runGit(createdRoot, ['add', 'src'])
    await runGit(createdRoot, [
      '-c',
      'user.name=Objective Integration',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'initial'
    ])
  }
  const root = await realpath(createdRoot)
  const repoId = `repo-${kind}`
  const worktreeId = kind === 'git' ? `${repoId}::${root}` : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large Worktree type; only the fields below are read by objective workspace resolution.
  const gitWorktree = {
    id: worktreeId ?? `${repoId}::${root}`,
    repoId,
    path: root,
    git: {
      path: root,
      head: kind === 'git' ? await runGit(root, ['rev-parse', 'HEAD']) : '',
      branch: 'main',
      isBare: false,
      prunable: false,
      isMainWorktree: true
    }
  } as unknown as RuntimeGitTarget['worktree']
  const runtimeTarget = { executionHostId: 'local' as const, worktree: gitWorktree }
  const target: ObjectiveWorkspaceTarget =
    kind === 'git'
      ? {
          kind,
          executionHostId: 'local',
          workspacePath: root,
          gitTarget: runtimeTarget
        }
      : { kind, executionHostId: 'local', workspacePath: root }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of QuirkyRuntimeService, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  const runtime = {
    resolveRuntimeFileTarget: vi.fn(async () => runtimeTarget),
    resolveRuntimeGitTarget: vi.fn(async () => runtimeTarget)
  } as unknown as QuirkyRuntimeService
  const repo = {
    id: repoId,
    path: root,
    displayName: `Objective ${kind}`,
    badgeColor: '#000000',
    addedAt: 1,
    kind
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of Store, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  const store = {
    getProfileStorageDirectory: () => profile,
    getRepo: (id: string) => (id === repoId ? repo : undefined),
    getWorktreeMetaForHost: () => null,
    getSettings: () => ({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      notifications: { enabled: false }
    })
  } as unknown as Store
  return { kind, root, profile, repoId, worktreeId, target, runtime, store }
}

/** Reads a dynamically-built kindPayload as a spreadable base for building a variant fixture. */
function asKindPayloadOverride(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}

function enrollmentInput(fixture: WorkspaceFixture): EnrollInput {
  return {
    kind: 'objective',
    repoId: fixture.repoId,
    worktreeId: fixture.worktreeId,
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
    budget: { wallClockActiveMs: 100_000, turns: 10 },
    kindPayload: {
      objectiveText: 'Write complete to src/result.txt and prove it with a shell check.',
      tier: 'express',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: fixture.kind,
      writeTerritory: ['src/**'],
      roleAgents: { planner: 'codex', implementer: 'codex' },
      sitterOverrides: {}
    }
  }
}

function mailboxCompletion(args: {
  enrollment: WatcherEnrollment
  sequence: number
  dispatchId: string
  taskId: string
  reportPath: string
  filesModified: string[]
}): EvidenceEntry {
  return {
    eventId: `mail-${args.sequence}`,
    watcherId: args.enrollment.watcherId,
    atMs: 10_000 + args.sequence,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence: args.sequence,
      messageId: `message-${args.sequence}`,
      deliveryId: `delivery-${args.sequence}`
    },
    payload: {
      type: 'worker_done',
      body: 'Objective role completed.',
      payload: {
        dispatchId: args.dispatchId,
        taskId: args.taskId,
        outcome: 'succeeded',
        reportPath: args.reportPath,
        filesModified: args.filesModified
      }
    }
  }
}

function orchestrationSimulation(
  fixture: WorkspaceFixture,
  options: { addUnreportedChange?: boolean } = {}
) {
  const queued: EvidenceEntry[] = []
  const delivered: EvidenceEntry[] = []
  const reportPaths: string[] = []
  let nextDispatch = 0
  let nextSequence = 0
  const dispatchWorker = vi.fn(async (input: DispatchWorkerInput) => {
    const dispatchNumber = ++nextDispatch
    const dispatchId = `dispatch-${dispatchNumber}`
    const taskId = `task-${dispatchNumber}`
    const reportPath = await resolveExpectedObjectiveReportPath(
      fixture.target,
      input.attemptFingerprint
    )
    reportPaths.push(reportPath)
    expect(input.spec).toContain(JSON.stringify(reportPath))
    const planner = input.spec.startsWith('ROLE: Objective planner')
    const implementer = input.spec.startsWith('ROLE: Objective implementer')
    const planReview =
      input.spec.startsWith('ROLE: Objective reviewer') &&
      input.spec.includes('PLAN REVIEW INPUT FILE:')
    if (!planner && !implementer && !planReview) {
      throw new Error('Unexpected objective role dispatch')
    }
    if (implementer) {
      await Promise.all([
        writeFile(join(fixture.root, 'src', 'result.txt'), 'complete\n'),
        writeFile(join(fixture.root, 'src', 'created.txt'), 'created\n'),
        rm(join(fixture.root, 'src', 'obsolete.txt'))
      ])
      if (options.addUnreportedChange) {
        await writeFile(join(fixture.root, 'src', 'unreported.txt'), 'not reported\n')
      }
    }
    const report = planner
      ? PLAN
      : planReview
        ? PLAN_REVIEW_APPROVAL
        : {
            taskKey: 'write-result',
            summary: 'Wrote the completed result.',
            filesModified: [...EXPECTED_CHANGED_PATHS],
            criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'File updated.' }]
          }
    await writeFile(reportPath, JSON.stringify(report))
    queued.push(
      mailboxCompletion({
        enrollment: input.enrollment,
        sequence: ++nextSequence,
        dispatchId,
        taskId,
        reportPath,
        filesModified: implementer ? [...EXPECTED_CHANGED_PATHS] : []
      })
    )
    return { status: 'dispatched' as const, dispatchId }
  })
  const queueWorkerEscalation = (enrollment: WatcherEnrollment): void => {
    const sequence = ++nextSequence
    queued.push({
      eventId: `mail-escalation-${sequence}`,
      watcherId: enrollment.watcherId,
      atMs: 10_000 + sequence,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      source: {
        kind: 'orchestration',
        sequence,
        messageId: `message-escalation-${sequence}`,
        deliveryId: `delivery-escalation-${sequence}`
      },
      payload: {
        type: 'escalation',
        subject: 'Need a human decision',
        body: 'The worker needs operator intervention before continuing.',
        payload: { dispatchId: 'dispatch-blocked' }
      }
    })
  }
  const adapter = {
    ensureRun: vi.fn(async () => ({ runId: 'objective-run' })),
    dispatchWorker,
    recoverDispatch: vi.fn(async () => ({ status: 'absent' as const })),
    readDispatch: vi.fn(async () => ({ status: 'live' as const })),
    readAuthoritativeWorkerReport: vi.fn(async () => null),
    listWorkers: vi.fn(async () => []),
    stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 1 })),
    releaseWorker: vi.fn(async (_enrollment: WatcherEnrollment, dispatchId: string) => ({
      dispatchId,
      state: 'released' as const,
      processAction: 'closed_agent_terminal' as const,
      archive: null
    })),
    drainMailbox: vi.fn(async () => {
      const entries = queued.splice(0)
      delivered.push(...entries)
      return entries
    }),
    answerQuestion: vi.fn(async () => undefined),
    readQuestion: vi.fn(async () => ({ status: 'pending' as const })),
    observeWorkerIdle: vi.fn(async () => ({ status: 'active' as const })),
    sendWorkerPrompt: vi.fn(async () => {})
  } satisfies HeimdallOrchestrationAdapter
  return { adapter, delivered, dispatchWorker, queueWorkerEscalation, reportPaths }
}

async function kernelHarness(
  fixture: WorkspaceFixture,
  instance: string,
  options: { addUnreportedChange?: boolean } = {}
) {
  const database = new HeimdallDatabase(fixture.profile)
  const enrollmentStore = new HeimdallEnrollmentStore(database)
  const ledgerStore = new HeimdallLedgerStore(database)
  const budgetClock = new HeimdallBudgetClock(ledgerStore)
  const objectiveDatabase = new ObjectiveDatabase(fixture.profile)
  const objectiveStore = new ObjectiveStore(objectiveDatabase)
  const orchestration = orchestrationSimulation(fixture, options)
  const leaseStore: LeaseStore = {
    acquireOrRenew: vi.fn(async () => ({
      status: 'held' as const,
      epoch: 1,
      guard: {
        epoch: 1,
        holder: `holder-${instance}`,
        assertHeld: async () => undefined,
        renewLoop: () => ({ dispose: () => undefined })
      }
    })),
    release: vi.fn(async () => undefined)
  }
  let nextId = 0
  let now = 1_000
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake timer handle; only unref is exercised by the kernel service under test.
  const schedule = vi.fn(() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout)
  const service = new HeimdallKernelServiceImpl({
    runtime: fixture.runtime,
    store: fixture.store,
    database,
    enrollmentStore,
    ledgerStore,
    budgetClock,
    leaseStore,
    orchestration: orchestration.adapter,
    now: () => ++now,
    createId: () => `${instance}-${++nextId}`,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock timers cannot match setTimeout/clearTimeout's overloaded global signatures and __promisify__ statics; only the call itself is exercised.
    setTimer: schedule as unknown as typeof setTimeout,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mock timers cannot match setTimeout/clearTimeout's overloaded global signatures and __promisify__ statics; only the call itself is exercised.
    clearTimer: vi.fn() as unknown as typeof clearTimeout,
    holderId: `holder-${instance}`
  })
  service.registerKind(
    createObjectiveKind({ runtime: fixture.runtime, store: fixture.store, objectiveStore })
  )
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    service.stopForShutdown()
    objectiveDatabase.close()
  }
  closeables.push(close)
  return { service, objectiveStore, ledgerStore, orchestration, schedule, close }
}

function fingerprintFileName(fingerprint: string): string {
  return `${createHash('sha256').update(fingerprint).digest('hex')}.json`
}

describe('objective kind through the Heimdall kernel', () => {
  it('publishes the objective database as a kind-owned debug pointer', async () => {
    const fixture = await workspaceFixture('folder')
    const world = await kernelHarness(fixture, 'debug-pointer')
    const enrolled = await world.service.enroll(enrollmentInput(fixture))
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }

    const report = await world.service.debugReport(enrolled.entry.enrollment.watcherId)

    expect(report.pointers).toContainEqual({
      role: 'kind-database',
      host: 'kernel',
      path: world.objectiveStore.databasePath(),
      status: 'resolved'
    })
  })

  it('resumes a worker escalation once without replaying the objective stop predicate', async () => {
    const fixture = await workspaceFixture('folder')
    const world = await kernelHarness(fixture, 'worker-escalation')
    const enrolled = await world.service.enroll(enrollmentInput(fixture))
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    world.orchestration.queueWorkerEscalation(enrolled.entry.enrollment)

    await world.service.reconcileForTesting(watcherId)
    const parkedEntry = (await world.service.fleet()).entries[0]!
    expect(parkedEntry.entry).toMatchObject({
      enrollment: { enabled: false },
      status: {
        state: 'parked',
        reason: 'Need a human decision: The worker needs operator intervention before continuing.'
      }
    })

    await expect(
      world.service.command({
        target: parkedEntry.target,
        expectedOwner: parkedEntry.ownerFence,
        command: { kind: 'resume' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await world.service.reconcileForTesting(watcherId)

    expect(world.orchestration.dispatchWorker).toHaveBeenCalledTimes(1)
    expect((await world.service.list())[0]).toMatchObject({
      enrollment: { enabled: true }
    })
    expect((await world.service.list())[0]?.status.state).not.toBe('parked')
    const ledger = world.service.ledger(watcherId)
    expect(
      ledger.entries.findLast(
        (entry) => entry.kind === 'escalation' && entry.escalationKind === 'worker-escalation'
      )
    ).toMatchObject({ status: 'acknowledged' })
    expect(
      ledger.entries.some(
        (entry) =>
          entry.kind === 'escalation' &&
          entry.escalationKind === 'park-stop-predicate' &&
          entry.status === 'open'
      )
    ).toBe(false)
  })

  it.each(['folder', 'git'] as const)(
    'completes the real %s workspace flow and keeps its terminal watcher inert after restart',
    async (workspaceKind) => {
      const fixture = await workspaceFixture(workspaceKind)
      const initialIdentity = await computeWorkspaceContentIdentity(fixture.target)
      const first = await kernelHarness(fixture, 'first')
      const enrolled = await first.service.enroll(enrollmentInput(fixture))
      if (enrolled.status !== 'enrolled') {
        throw new Error('Expected objective enrollment')
      }
      const watcherId = enrolled.entry.enrollment.watcherId

      await first.service.reconcileForTesting(watcherId)
      expect(first.orchestration.dispatchWorker).toHaveBeenCalledTimes(1)
      expect(await computeWorkspaceContentIdentity(fixture.target)).toBe(initialIdentity)

      await first.service.reconcileForTesting(watcherId)
      expect(first.objectiveStore.project(watcherId).revisions).toEqual([
        expect.objectContaining({ number: 1, status: 'draft' })
      ])

      await first.service.reconcileForTesting(watcherId)
      expect(first.orchestration.dispatchWorker).toHaveBeenCalledTimes(2)
      const planReviewDispatch = getLatestAttempts(first.service.ledger(watcherId)).find(
        (attempt) => attempt.action.kind === 'dispatch-plan-review'
      )
      expect(planReviewDispatch).toBeDefined()

      await first.service.reconcileForTesting(watcherId)
      expect(first.objectiveStore.project(watcherId).planReviews ?? []).toContainEqual(
        expect.objectContaining({ targetKind: 'revision', verdict: 'approve' })
      )

      await first.service.reconcileForTesting(watcherId)
      expect(first.objectiveStore.project(watcherId).revisions[0]).toMatchObject({
        status: 'approved'
      })
      const activateAttempt = getLatestAttempts(first.service.ledger(watcherId)).find(
        (attempt) => attempt.action.kind === 'activate-plan'
      )
      expect(activateAttempt).toBeDefined()
      // proves the plan-review dispatch landed before the gated activation, not merely both present
      expect(planReviewDispatch!.atMs).toBeLessThanOrEqual(activateAttempt!.atMs)

      await first.service.reconcileForTesting(watcherId)
      expect(first.orchestration.dispatchWorker).toHaveBeenCalledTimes(3)
      const dispatchAttempts = getLatestAttempts(first.service.ledger(watcherId)).filter(
        (attempt) => attempt.action.kind.startsWith('dispatch-')
      )
      expect(dispatchAttempts).toHaveLength(3)
      const finalIdentity = await computeWorkspaceContentIdentity(fixture.target)
      expect(finalIdentity).not.toBe(initialIdentity)

      await first.service.reconcileForTesting(watcherId)
      expect(
        first.objectiveStore.project(watcherId, first.service.ledger(watcherId)).nodes[0]
      ).toMatchObject({
        taskKey: 'write-result',
        orchestrationTaskId: 'task-3',
        dispatchId: 'dispatch-3',
        state: 'succeeded'
      })
      await first.service.reconcileForTesting(watcherId)
      const checked = first.objectiveStore.project(
        watcherId,
        first.service.ledger(watcherId),
        finalIdentity
      ).nodes[0]?.criteria[0]?.lastCheck
      expect(checked).toMatchObject({
        contentIdentity: finalIdentity,
        exitCode: 0,
        timedOut: false
      })

      await first.service.reconcileForTesting(watcherId)
      const ledger = first.service.ledger(watcherId)
      expect(first.objectiveStore.project(watcherId).landing).toEqual([
        expect.objectContaining({ rung: 'files-on-disk', contentIdentity: finalIdentity })
      ])
      expect(ledger.entries.filter((entry) => entry.kind === 'terminal')).toEqual([
        expect.objectContaining({
          origin: 'owner',
          class: 'fact',
          state: 'objective-bar-reached',
          reason: 'files-on-disk landing bar reached'
        })
      ])
      expect(first.ledgerStore.readTerminalSummary(watcherId)).toMatchObject({
        kind: 'objective',
        terminalState: 'objective-bar-reached',
        reason: 'files-on-disk landing bar reached'
      })
      expect(first.orchestration.delivered).toHaveLength(3)
      expect(first.orchestration.delivered.every((entry) => entry.kind === 'evidence')).toBe(true)
      expect(await readFile(join(fixture.root, 'src', 'result.txt'), 'utf8')).toBe('complete\n')
      expect(await readFile(join(fixture.root, 'src', 'created.txt'), 'utf8')).toBe('created\n')
      await expect(
        readFile(join(fixture.root, 'src', 'obsolete.txt'), 'utf8')
      ).rejects.toMatchObject({
        code: 'ENOENT'
      })

      expect(first.orchestration.reportPaths).toHaveLength(3)
      for (const [index, reportPath] of first.orchestration.reportPaths.entries()) {
        expect(basename(reportPath)).toBe(fingerprintFileName(dispatchAttempts[index]!.fingerprint))
      }
      const reportDirectory = dirname(first.orchestration.reportPaths[0]!)
      if (workspaceKind === 'folder') {
        expect(reportDirectory).toBe(
          join(fixture.root, '.quirky', 'heimdall', 'objective', 'reports')
        )
      } else {
        const gitDirectory = await runGit(fixture.root, ['rev-parse', '--absolute-git-dir'])
        expect(reportDirectory).toBe(join(gitDirectory, 'quirky-heimdall', 'objective', 'reports'))
      }

      first.close()
      const restarted = await kernelHarness(fixture, 'restarted')
      expect((await restarted.service.list())[0]).toMatchObject({
        enrollment: { watcherId, enabled: false },
        status: { state: 'terminal', phase: 'terminal' }
      })
      restarted.schedule.mockClear()
      restarted.service.resume()
      await restarted.service.reconcileForTesting(watcherId)
      const fleetEntry = (await restarted.service.fleet()).entries[0]!
      await expect(
        restarted.service.command({
          target: fleetEntry.target,
          expectedOwner: fleetEntry.ownerFence,
          command: { kind: 'resume' }
        })
      ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
      await restarted.service.reconcileForTesting(watcherId)
      expect(restarted.schedule).not.toHaveBeenCalled()
      expect(restarted.orchestration.dispatchWorker).not.toHaveBeenCalled()
      expect(
        restarted.service.ledger(watcherId).entries.filter((entry) => entry.kind === 'terminal')
      ).toHaveLength(1)
    }
  )

  it('walks an approved Git objective through commit and first push, then stays inert', async () => {
    const fixture = await workspaceFixture('git')
    const remote = join(dirname(fixture.root), 'objective-remote.git')
    await runGit(dirname(fixture.root), ['init', '--bare', remote])
    await runGit(fixture.root, ['remote', 'add', 'origin', remote])
    const first = await kernelHarness(fixture, 'pushed-ref')
    const baseInput = enrollmentInput(fixture)
    const enrolled = await first.service.enroll({
      ...baseInput,
      capabilities: { ...baseInput.capabilities, land: 'gated' },
      kindPayload: {
        ...asKindPayloadOverride(baseInput.kindPayload),
        landingBar: 'pushed-ref'
      }
    })
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId

    // plan, draft, plan-review dispatch, plan-review ingest, activate, node, report, check, land
    for (let pulse = 0; pulse < 9; pulse += 1) {
      await first.service.reconcileForTesting(watcherId)
    }
    const recordEscalation = first.service
      .ledger(watcherId)
      .entries.findLast(
        (entry) =>
          entry.kind === 'escalation' &&
          entry.status === 'open' &&
          entry.approvalScope?.actionKind === 'record-landing'
      )
    if (
      !recordEscalation ||
      recordEscalation.kind !== 'escalation' ||
      !recordEscalation.approvalScope
    ) {
      throw new Error('Expected files-on-disk approval escalation')
    }
    let fleetEntry = (await first.service.fleet()).entries[0]!
    await expect(
      first.service.command({
        target: fleetEntry.target,
        expectedOwner: fleetEntry.ownerFence,
        command: { kind: 'approve', scope: recordEscalation.approvalScope }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    await first.service.reconcileForTesting(watcherId)
    expect(getLatestAttempts(first.service.ledger(watcherId)).at(-1)?.action.kind).toBe(
      'record-landing'
    )
    await first.service.reconcileForTesting(watcherId)
    const commitEscalation = first.service
      .ledger(watcherId)
      .entries.findLast(
        (entry) =>
          entry.kind === 'escalation' &&
          entry.status === 'open' &&
          entry.approvalScope?.actionKind === 'commit-local-branch'
      )
    if (
      !commitEscalation ||
      commitEscalation.kind !== 'escalation' ||
      !commitEscalation.approvalScope
    ) {
      throw new Error('Expected commit approval escalation')
    }
    fleetEntry = (await first.service.fleet()).entries[0]!
    await expect(
      first.service.command({
        target: fleetEntry.target,
        expectedOwner: fleetEntry.ownerFence,
        command: { kind: 'approve', scope: commitEscalation.approvalScope }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    await first.service.reconcileForTesting(watcherId)
    expect(getLatestAttempts(first.service.ledger(watcherId)).at(-1)?.action.kind).toBe(
      'commit-local-branch'
    )
    await first.service.reconcileForTesting(watcherId)
    const pushEscalation = first.service
      .ledger(watcherId)
      .entries.findLast(
        (entry) =>
          entry.kind === 'escalation' &&
          entry.status === 'open' &&
          entry.approvalScope?.actionKind === 'push-ref'
      )
    if (!pushEscalation || pushEscalation.kind !== 'escalation' || !pushEscalation.approvalScope) {
      throw new Error('Expected push approval escalation')
    }
    fleetEntry = (await first.service.fleet()).entries[0]!
    await expect(
      first.service.command({
        target: fleetEntry.target,
        expectedOwner: fleetEntry.ownerFence,
        command: { kind: 'approve', scope: pushEscalation.approvalScope }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    await first.service.reconcileForTesting(watcherId)
    const ledger = first.service.ledger(watcherId)
    expect(first.objectiveStore.project(watcherId).landing.map((entry) => entry.rung)).toEqual([
      'files-on-disk',
      'committed-local-branch',
      'pushed-ref'
    ])
    const localHead = await runGit(fixture.root, ['rev-parse', 'HEAD'])
    expect(
      await runGit(fixture.root, ['ls-remote', '--heads', 'origin', 'refs/heads/main'])
    ).toContain(localHead)
    expect(ledger.entries.filter((entry) => entry.kind === 'terminal')).toEqual([
      expect.objectContaining({
        state: 'objective-bar-reached',
        reason: 'pushed-ref landing bar reached'
      })
    ])
    expect(first.ledgerStore.readTerminalSummary(watcherId)).toMatchObject({
      kind: 'objective',
      terminalState: 'objective-bar-reached',
      reason: 'pushed-ref landing bar reached'
    })

    first.close()
    const restarted = await kernelHarness(fixture, 'pushed-ref-restarted')
    expect((await restarted.service.list())[0]).toMatchObject({
      enrollment: { watcherId, enabled: false },
      status: { state: 'terminal', phase: 'terminal' }
    })
    restarted.schedule.mockClear()
    restarted.service.resume()
    await restarted.service.reconcileForTesting(watcherId)
    expect(restarted.schedule).not.toHaveBeenCalled()
    expect(restarted.orchestration.dispatchWorker).not.toHaveBeenCalled()
    expect(
      restarted.service.ledger(watcherId).entries.filter((entry) => entry.kind === 'terminal')
    ).toHaveLength(1)
  })

  it('rejects a worker report that omits a host-observed workspace change', async () => {
    const fixture = await workspaceFixture('folder')
    const world = await kernelHarness(fixture, 'unreported-change', {
      addUnreportedChange: true
    })
    const enrolled = await world.service.enroll(enrollmentInput(fixture))
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId

    // plan, draft, plan-review dispatch, plan-review ingest, activate, node, report
    for (let pulse = 0; pulse < 7; pulse += 1) {
      await world.service.reconcileForTesting(watcherId)
    }

    const ledger = world.service.ledger(watcherId)
    const ingestion = getLatestAttempts(ledger).find(
      (attempt) => attempt.action.kind === 'ingest-report'
    )
    expect(await readFile(join(fixture.root, 'src', 'unreported.txt'), 'utf8')).toBe(
      'not reported\n'
    )
    expect(ingestion).toMatchObject({ state: 'settled', effect: 'not-landed' })
    expect(world.objectiveStore.project(watcherId, ledger).nodes[0]).toMatchObject({
      taskKey: 'write-result',
      state: 'failed'
    })
    expect(
      getLatestAttempts(ledger).some(
        (attempt) => attempt.action.kind === 'run-check' || attempt.action.kind === 'record-landing'
      )
    ).toBe(false)
    expect(ledger.entries.some((entry) => entry.kind === 'terminal')).toBe(false)
  })

  it('activates a draft without a plan-review dispatch when review is off', async () => {
    const fixture = await workspaceFixture('folder')
    const world = await kernelHarness(fixture, 'review-off')
    const baseInput = enrollmentInput(fixture)
    const enrolled = await world.service.enroll({
      ...baseInput,
      capabilities: { ...baseInput.capabilities, review: 'off' }
    })
    if (enrolled.status !== 'enrolled') {
      throw new Error('Expected objective enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId

    await world.service.reconcileForTesting(watcherId) // dispatch-planner
    await world.service.reconcileForTesting(watcherId) // ingest-plan -> draft
    await world.service.reconcileForTesting(watcherId) // activate-plan -> approved

    expect(world.objectiveStore.project(watcherId).revisions[0]).toMatchObject({
      status: 'approved'
    })
    expect(world.orchestration.dispatchWorker).toHaveBeenCalledTimes(1)
    expect(
      getLatestAttempts(world.service.ledger(watcherId)).some(
        (attempt) => attempt.action.kind === 'dispatch-plan-review'
      )
    ).toBe(false)
  })
})

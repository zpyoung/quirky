import { readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ledger as watcherLedger,
  projection,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectivePlanLint } from '../../shared/fork-heimdall-objective/plan-lint'
import type {
  ObjectivePlanTask,
  PlannerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { issueObjectiveReportPath } from './report-ingestion'
import {
  buildPlanReviewInput,
  resolveObjectivePlanReviewDispatch,
  writePlanReviewInputFile,
  type PlanReviewInput
} from './plan-review-input'
import {
  cleanupTemporaryDirectories,
  createLocalFolderTarget
} from './objective-temp-workspace-test-fixtures'

const LINT: ObjectivePlanLint = {
  findings: [],
  truncated: false,
  conflictPairs: [],
  criticalPathLength: 1,
  maxWidth: 1
}

function task(overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey: 'core',
    title: 'Core',
    spec: 'Implement the core behavior.',
    deps: [],
    criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    ...overrides
  }
}

function input(overrides: Partial<PlanReviewInput> = {}): PlanReviewInput {
  return {
    target: { kind: 'revision', revisionId: 'revision-1' },
    plan: [task()],
    assumptions: [],
    lint: LINT,
    writeTerritory: ['src/**'],
    gates: undefined,
    effectiveMaxConcurrency: 1,
    ...overrides
  }
}

const temporaryDirectories: string[] = []

async function localFolderTarget(): Promise<ObjectiveWorkspaceTarget> {
  return createLocalFolderTarget(temporaryDirectories, 'quirky-plan-review-input-')
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('buildPlanReviewInput', () => {
  it('passes a small input through unchanged', () => {
    const built = buildPlanReviewInput(input())
    expect(built).toEqual(input())
  })

  it('carries a patch and frozen tasks through untouched when they fit', () => {
    const patch = { repair: { upsertTasks: [task({ taskKey: 'core-2' })], dropTaskKeys: [] } }
    const built = buildPlanReviewInput(
      input({
        target: { kind: 'patch', patchId: 'patch-1' },
        patch,
        frozenTasks: [{ taskKey: 'core', title: 'Core' }]
      })
    )
    expect(built.patch).toEqual(patch)
    expect(built.frozenTasks).toEqual([{ taskKey: 'core', title: 'Core' }])
  })

  it('truncates the longest task spec first until the input fits the 1 MiB cap', () => {
    const huge = 'x'.repeat(600_000)
    const built = buildPlanReviewInput(
      input({ plan: [task({ taskKey: 'a', spec: huge }), task({ taskKey: 'b', spec: huge })] })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(built.plan.some((candidate) => candidate.spec.endsWith('…[truncated]'))).toBe(true)
    expect(built.plan.find((candidate) => candidate.taskKey === 'a')?.spec.length).toBeLessThan(
      huge.length
    )
  })

  it('leaves an oversized criterion body untouched, since only task specs are shrunk', () => {
    const huge = 'y'.repeat(1_200_000)
    const built = buildPlanReviewInput(
      input({
        plan: [task({ criteria: [{ body: huge, shellCheckable: false, checkCommand: null }] })]
      })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeGreaterThan(1024 * 1024)
    expect(built.plan[0]?.criteria[0]?.body).toBe(huge)
  })

  it('leaves an oversized assumption claim untouched, since only task specs are shrunk', () => {
    const huge = 'z'.repeat(1_200_000)
    const built = buildPlanReviewInput(
      input({ assumptions: [{ claim: huge, dependentTaskKeys: [] }] })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeGreaterThan(1024 * 1024)
    expect(built.assumptions[0]?.claim).toBe(huge)
  })

  it('never drops write-territory, task-territory, or lint-finding entries under size pressure', () => {
    const writeTerritory = Array.from({ length: 200 }, (_, index) => `src/dir-${index}/**`)
    const territory = Array.from({ length: 50 }, (_, index) => `src/task-${index}/**`)
    const findings = Array.from({ length: 100 }, (_, index) => ({
      code: 'missing-territory' as const,
      taskKey: null,
      detail: `finding-${index}-${'d'.repeat(200)}`
    }))
    const built = buildPlanReviewInput(
      input({
        plan: [task({ spec: 'x'.repeat(1_200_000), territory })],
        writeTerritory,
        lint: { ...LINT, findings }
      })
    )
    expect(built.writeTerritory).toEqual(writeTerritory)
    expect(built.plan[0]?.territory).toEqual(territory)
    expect(built.lint.findings).toEqual(findings)
  })

  it('never re-selects an already-truncated field, so shrinking terminates', () => {
    const huge = 'w'.repeat(1_200_000)
    const built = buildPlanReviewInput(input({ plan: [task({ spec: huge })] }))
    // truncating twice would grow the marker back on, not shrink it further
    expect(built.plan[0]?.spec).toBe(`${huge.slice(0, 200)}…[truncated]`)
  })

  it('stays oversized when every field is already within target but there are too many of them', () => {
    const plan = Array.from({ length: 128 }, (_, taskIndex) =>
      task({
        taskKey: `task-${taskIndex}`,
        spec: 'ok',
        criteria: Array.from({ length: 64 }, (_, criterionIndex) => ({
          body: `criterion-${taskIndex}-${criterionIndex}-${'c'.repeat(150)}`,
          shellCheckable: false,
          checkCommand: null
        }))
      })
    )
    const built = buildPlanReviewInput(input({ plan }))
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeGreaterThan(1024 * 1024)
  })
})

describe('writePlanReviewInputFile', () => {
  it('writes the input JSON beside a local report path with mode 0600', async () => {
    const target = await localFolderTarget()
    const reportPath = await issueObjectiveReportPath(target, 'attempt-1')

    const written = await writePlanReviewInputFile(target, reportPath, input())

    expect(written).toBe(reportPath.replace(/\.json$/u, '.plan-review-input.json'))
    const contents = await readFile(written, 'utf8')
    expect(JSON.parse(contents)).toEqual(input())
    const mode = (await stat(written)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('refuses to write for a non-local execution host', async () => {
    const target: ObjectiveWorkspaceTarget = {
      kind: 'folder',
      executionHostId: 'ssh:plan-review-input-test',
      workspacePath: '/srv/objective'
    }
    const reportPath = '/srv/objective/.quirky/heimdall/objective/reports/deadbeef.json'

    await expect(writePlanReviewInputFile(target, reportPath, input())).rejects.toThrow(
      'Remote objective target is not served by this host'
    )
  })

  it('fails the dispatch instead of writing a file still oversized after every field is trimmed', async () => {
    const target = await localFolderTarget()
    const reportPath = await issueObjectiveReportPath(target, 'attempt-oversized')
    const plan = Array.from({ length: 128 }, (_, taskIndex) =>
      task({
        taskKey: `task-${taskIndex}`,
        spec: 'ok',
        criteria: Array.from({ length: 64 }, (_, criterionIndex) => ({
          body: `criterion-${taskIndex}-${criterionIndex}-${'c'.repeat(150)}`,
          shellCheckable: false,
          checkCommand: null
        }))
      })
    )
    const oversized = buildPlanReviewInput(input({ plan }))

    await expect(writePlanReviewInputFile(target, reportPath, oversized)).rejects.toThrow(
      /exceeding the 1048576-byte cap/
    )
    await expect(
      readFile(reportPath.replace(/\.json$/u, '.plan-review-input.json'), 'utf8')
    ).rejects.toThrow()
  })
})

describe('resolveObjectivePlanReviewDispatch delta wiring', () => {
  const WATCHER_ID = 'watcher-plan-review-input-delta'
  const openedDatabases: ObjectiveDatabase[] = []

  afterEach(() => {
    for (const database of openedDatabases.splice(0)) {
      database.close()
    }
  })

  function planReport(overrides: Partial<PlannerReport> = {}): PlannerReport {
    return {
      plan: [task()],
      assumptions: [{ claim: 'The fixture already exists.', dependentTaskKeys: ['core'] }],
      ...overrides
    }
  }

  function newStore(): ObjectiveStore {
    const database = new ObjectiveDatabase(':memory:')
    openedDatabases.push(database)
    return new ObjectiveStore(database, () => 9_999)
  }

  async function dispatchFor(
    store: ObjectiveStore,
    target: PlanReviewInput['target'],
    round: 1 | 2
  ) {
    const workspaceTarget = await localFolderTarget()
    const reportPath = await issueObjectiveReportPath(workspaceTarget, `attempt-${round}`)
    return resolveObjectivePlanReviewDispatch({
      target,
      round,
      watcherId: WATCHER_ID,
      objectiveStore: store,
      world: snapshot(projection({ nodes: [] })).world,
      ledger: watcherLedger(),
      writeTerritory: ['src/**'],
      gates: undefined,
      effectiveMaxConcurrency: 1,
      workspaceTarget,
      reportPath
    })
  }

  it('carries no delta for a round-1 revision review', async () => {
    const store = newStore()
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: planReport(),
      digest: 'digest-1',
      createdAtMs: 1
    })

    const { delta, inputPath } = await dispatchFor(
      store,
      { kind: 'revision', revisionId: revision.revisionId },
      1
    )

    expect(delta).toBeUndefined()
    const written = JSON.parse(await readFile(inputPath, 'utf8'))
    expect(written.delta).toBeUndefined()
  })

  it('carries a delta with matching carryEligible once round 2 follows a round-1 revise', async () => {
    const store = newStore()
    const first = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: planReport(),
      digest: 'digest-1',
      createdAtMs: 1
    })
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: first.revisionId,
      round: 1,
      dispatchId: 'review-1',
      report: {
        verdict: 'revise',
        assumptions: [{ index: 0, status: 'verified', evidence: 'Confirmed.' }],
        findings: [{ taskKey: 'core', severity: 'blocking', body: 'Sizing is off.' }],
        summary: 'Needs another pass.'
      },
      reportDigest: 'review-digest-1',
      createdAtMs: 2
    })
    const second = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 2,
      dispatchId: 'planner-2',
      report: planReport({
        plan: [task(), task({ taskKey: 'extra', deps: [] })],
        assumptions: [{ claim: '  The fixture already exists.  ', dependentTaskKeys: ['core'] }]
      }),
      digest: 'digest-2',
      createdAtMs: 3
    })

    const { delta, inputPath } = await dispatchFor(
      store,
      { kind: 'revision', revisionId: second.revisionId },
      2
    )

    expect(delta?.diff.added).toEqual(['extra'])
    expect(delta?.carryEligible).toEqual([0])
    const written = JSON.parse(await readFile(inputPath, 'utf8'))
    expect(written.delta.carryEligible).toEqual([0])
    expect(written.delta.previousReport.verdict).toBe('revise')
  })

  it('never resolves a delta for a patch target, even at round 2', async () => {
    const store = newStore()
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: planReport(),
      digest: 'digest-1',
      createdAtMs: 1
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 2
    })
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'planner-repair-1',
      repairOrdinal: 1,
      report: {
        repair: { upsertTasks: [task({ taskKey: 'follow-up' })], dropTaskKeys: [] },
        assumptions: []
      },
      createdAtMs: 3
    })

    const { delta } = await dispatchFor(store, { kind: 'patch', patchId: patch.id }, 2)

    expect(delta).toBeUndefined()
  })
})

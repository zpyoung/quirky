import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchestrationSubmission, OrchestrationSubmissionVerdict, PluginContext } from '@quirky/protocol'
import { contractProblems, objectivePayload, resolveWorkspace, type ObjectiveDetail, type ObjectivePayload } from './contract'
import { decideObjective, deriveProgress, nextStep, paceObjective, stopObjective } from './decide'
import type { ObjectiveJournalEntry, ObjectiveProgress, ObjectiveSnapshot, ObjectiveWorld } from './decide'
import { implementerReportProblems, integratorReportProblems, plannerReportProblems, repairReportProblems, reportDigest, reviewerReportProblems } from './plan'
import type { ImplementerReport, IntegratorReport, PlannerReport, RepairPlannerReport, ReviewerReport } from './plan'
import { integratorSpec, objectivePrompt, repairPlannerSpec, reviewerSpec } from './prompts'
import type { ObjectiveStore } from './store'
import { baselineProblems, captureContentIdentity, runCriterionCheck, runEnrollmentGate, type ObjectiveRuntime } from './checks'
import { commitLocalBranch, readLocalGitHead, recordFilesOnDisk } from './landing'
import type { ObjectiveAction } from './decide'

export interface ObjectiveEnrollment {
  watcherId: string; kind: string; workspacePath: string; worktreeId?: string | null; terminalAtMs?: number | null
  kindPayload: ObjectivePayload; capabilities: Record<string, 'off' | 'gated' | 'on'>
}
interface Inspection { enrollment: ObjectiveEnrollment; journal: ObjectiveJournalEntry[] }
type WorldEnrollment = Pick<ObjectiveEnrollment, 'watcherId' | 'kindPayload' | 'capabilities'>
type HookWorld = ObjectiveWorld & { enrollment: WorldEnrollment }
type Action = ObjectiveAction & { contentIdentity: string }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const rejected = (code: string, reason: string): OrchestrationSubmissionVerdict => ({ kind: 'rejected', code, reason })

function readIssuedReport(path: string): { value: unknown } | { problem: { code: string; reason: string } } {
  const problem = (code: string, reason: string) => ({ problem: { code, reason } })
  try {
    if (lstatSync(path).isSymbolicLink()) return problem('report-path-mismatch', 'The issued report must not be a symlink.')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return problem('invalid-report', 'The report must be a regular JSON file.')
      if (stat.size > 262_144) return problem('report-too-large', 'The report exceeds 262144 bytes.')
      const bytes = Buffer.alloc(262_145)
      let size = 0
      for (;;) {
        const count = readSync(fd, bytes, size, bytes.length - size, null)
        size += count
        if (size > 262_144) return problem('report-too-large', 'The report exceeds 262144 bytes.')
        if (!count) break
      }
      return { value: JSON.parse(bytes.subarray(0, size).toString('utf8')) }
    } finally { closeSync(fd) }
  } catch (error) {
    return problem('invalid-report', `The report could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Implements the registered kind using only daemon and plugin public methods. */
export function createObjectiveHooks(context: PluginContext, store: ObjectiveStore) {
  async function inspect(watcherId: string): Promise<Inspection | null> {
    const result = await context.call('quirky.heimdall/inspect', { watcherId })
    if (!Array.isArray(result)) throw new Error('Heimdall inspection is unavailable')
    const value: unknown = result.find((item: unknown) => record(item) && record(item.enrollment) && item.enrollment.watcherId === watcherId)
    if (!record(value) || !record(value.enrollment) || !Array.isArray(value.journal)) return null
    return value as unknown as Inspection
  }
  function world(enrollment: WorldEnrollment, snapshot?: ObjectiveSnapshot): HookWorld {
    const watcherId = enrollment.watcherId
    const revision = store.revision(watcherId)
    const issued = store.issued(watcherId)
    return {
      enrollment: { watcherId, kindPayload: enrollment.kindPayload, capabilities: enrollment.capabilities },
      planMode: enrollment.capabilities.plan ?? 'off',
      contract: enrollment.kindPayload, capabilities: enrollment.capabilities,
      contentIdentity: snapshot?.contentIdentity, observedAtMs: snapshot?.observedAtMs,
      git: snapshot?.world.git,
      revision: revision ? {
        number: revision.number, digest: revision.digest, plan: revision.plan,
        tasks: revision.plan.plan.tasks.map(task => ({ taskKey: task.taskKey, deps: task.deps, criteriaCount: task.criteria.length, criteria: task.criteria }))
      } : null,
      reports: store.reports(watcherId).map(report => ({
        attemptId: report.attemptId, role: report.role, digest: report.digest,
        taskKey: issued.find(value => value.attemptId === report.attemptId)?.taskKey ?? null,
        ...('summary' in report.report ? { summary: report.report.summary } : {}),
        ...('filesModified' in report.report ? { filesModified: report.report.filesModified } : {})
      })),
      issued,
      checks: store.checks(watcherId), verdicts: store.verdicts(watcherId), landings: store.landings(watcherId),
      rejectedDrafts: store.rejectedDrafts(watcherId), overruns: store.overruns(watcherId), repairs: store.repairs(watcherId)
    }
  }
  function runtime(enrollment: ObjectiveEnrollment): ObjectiveRuntime {
    return { context, store, enrollment,
      captureContentIdentity: () => captureContentIdentity(context, enrollment.workspacePath, context.dataDir, enrollment.watcherId) }
  }
  async function agentFor(payload: ObjectivePayload, role: 'planner' | 'implementer' | 'reviewer' | 'integrator'): Promise<string> {
    const configured = payload.roleAgents[role]
    if (configured) return configured
    const result = await context.call('quirky.agents/list', {})
    if (record(result) && typeof result.defaultAgent === 'string' && !['auto', 'shell'].includes(result.defaultAgent)) return result.defaultAgent
    return 'claude'
  }
  return {
    async authorize({ input }: { input: { kindPayload: unknown } }) {
      const raw = record(input.kindPayload) ? input.kindPayload : {}
      const workspace = await resolveWorkspace((method, params) => context.call(method, params), typeof raw.worktree === 'string' ? raw.worktree : 'active')
      return {
        workspaceKey: `local::${workspace.path}`, workspacePath: workspace.path,
        executionHostId: 'local', schedulerOwner: 'daemon', worktreeId: workspace.id, repoId: workspace.repoId,
        kindPayload: objectivePayload(input.kindPayload, `id:${workspace.id}`)
      }
    },
    validate({ candidate }: { candidate: { kindPayload: ObjectivePayload; owner?: unknown } }): void {
      const problems = contractProblems(candidate.kindPayload, candidate.owner)
      if (problems.length) throw new Error(problems.join('; '))
    },
    async read({ enrollment }: { enrollment: ObjectiveEnrollment }): Promise<ObjectiveSnapshot & { world: HookWorld }> {
      const contentIdentity = await runtime(enrollment).captureContentIdentity()
      const currentWorld = world(enrollment)
      currentWorld.git = await readLocalGitHead(context, enrollment.workspacePath)
      const observedAtMs = Date.now()
      currentWorld.contentIdentity = contentIdentity
      currentWorld.observedAtMs = observedAtMs
      return { freshness: 'live', contentIdentity, observedAtMs, world: currentWorld }
    },
    decide({ snapshot, journal, enrollment }: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[]; enrollment: ObjectiveEnrollment }) {
      return decideObjective({ ...snapshot, world: world(enrollment, snapshot) }, journal)
    },
    stop({ snapshot, journal, enrollment }: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[]; enrollment: ObjectiveEnrollment }) {
      return stopObjective({ ...snapshot, world: world(enrollment, snapshot) }, journal)
    },
    pace({ snapshot, journal }: { snapshot: ObjectiveSnapshot & { world: HookWorld }; journal: ObjectiveJournalEntry[] }) {
      return paceObjective({ ...snapshot, world: world(snapshot.world.enrollment, snapshot) }, journal)
    },
    resolveOutcome({ attempt, enrollment }: { attempt: { attemptId: string; action: Action }; enrollment: ObjectiveEnrollment }):
      { effect: 'landed' | 'not-landed'; reason?: string } | null {
      const { action } = attempt
      const watcherId = enrollment.watcherId
      if (action.kind === 'activate-plan') {
        return store.revision(watcherId)?.sourceAttemptId === action.plannerAttemptId &&
          store.report(action.plannerAttemptId)?.digest === action.digest ? { effect: 'landed' } : null
      }
      if (action.kind === 'apply-plan-repair') {
        return store.report(action.plannerAttemptId)?.digest === action.digest &&
          store.repairs(watcherId).some(row => row.revision === action.revision && row.ordinal === action.repairEpisode &&
            row.attemptId === action.plannerAttemptId) ? { effect: 'landed' } : null
      }
      if (action.kind === 'record-landing' || action.kind === 'commit-local-branch') {
        const rung = action.kind === 'record-landing' ? 'files-on-disk' : 'committed-local-branch'
        return store.landings(watcherId).some(row => row.rung === rung && row.contentIdentity === action.contentIdentity &&
          row.payload.revision === action.revision && (rung === 'files-on-disk' || row.attemptId === attempt.attemptId))
          ? { effect: 'landed' } : null
      }
      if (action.kind === 'run-check' || action.kind === 'run-gate') {
        const kind = action.kind === 'run-check' ? 'criterion' : 'gate'
        const target = action.kind === 'run-check' ? `${action.taskKey}:${action.criterionIndex}` : action.gateName
        const row = store.checks(watcherId).find(row => row.attemptId === attempt.attemptId && row.revision === action.revision &&
          row.kind === kind && row.targetKey === target && row.command === action.command && row.contentIdentity === action.contentIdentity)
        if (!row) return null
        return row.status === 'passed' ? { effect: 'landed' } : { effect: 'not-landed',
          reason: row.status === 'stale' ? 'check-evidence-stale' : row.timedOut ? 'check-timed-out' : 'check-failed' }
      }
      return null
    },
    async execute({ action, enrollment, attemptId }: { action: Action; enrollment: ObjectiveEnrollment; attemptId: string }) {
      if (action.kind === 'activate-plan') {
        if (!action.plannerAttemptId || !action.digest) throw new Error('Plan activation is missing its draft authority')
        store.activate(enrollment.watcherId, action.plannerAttemptId, action.digest)
        return { effect: 'landed' }
      }
      if (action.kind === 'apply-plan-repair') {
        store.applyRepair(enrollment.watcherId, action.revision, action.repairEpisode, action.plannerAttemptId, action.digest)
        return { effect: 'landed' }
      }
      const run = runtime(enrollment)
      if (action.kind === 'run-check') return runCriterionCheck(run, action, attemptId)
      if (action.kind === 'run-gate') return runEnrollmentGate(run, action, attemptId)
      if (action.kind === 'record-landing') {
        const inspection = await inspect(enrollment.watcherId)
        if (!inspection) throw new Error('The objective watcher no longer exists')
        return recordFilesOnDisk(run, action, attemptId, deriveProgress(world(enrollment), inspection.journal).tasks)
      }
      if (action.kind === 'commit-local-branch') return commitLocalBranch(run, action, attemptId)
      const role = action.kind === 'dispatch-planner' ? 'planner'
        : action.kind === 'dispatch-reviewer' ? 'reviewer' : action.kind === 'dispatch-integrator' ? 'integrator' : 'implementer'
      const revision = store.revision(enrollment.watcherId)
      const task = action.kind === 'dispatch-node' ? revision?.plan.plan.tasks.find(task => task.taskKey === action.taskKey) : undefined
      if (action.kind === 'dispatch-node' && (!task || revision?.number !== action.revision)) throw new Error('The assigned task is not in the approved revision')
      const contentIdentity = await run.captureContentIdentity()
      const directory = join(enrollment.workspacePath, '.quirky', 'objective', enrollment.watcherId)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${attemptId}.json`)
      const repair = action.kind === 'dispatch-planner' && action.plannerMode === 'repair'
      store.issue({ attemptId, watcherId: enrollment.watcherId, role,
        revision: role === 'planner' && !repair ? null : revision?.number ?? null,
        plannerMode: role === 'planner' ? (repair ? 'repair' : 'initial') : undefined,
        baselineTree: contentIdentity.slice('objective-tree:'.length), contentIdentity,
        taskKey: task?.taskKey ?? null, reportPath: path, issuedAtMs: Date.now() })
      const inspection = await inspect(enrollment.watcherId)
      const progress = deriveProgress(world(enrollment), inspection?.journal ?? []).tasks
      const rejectedDraft = store.rejectedDrafts(enrollment.watcherId).at(-1)
      let spec: string
      if (repair) {
        if (!revision) throw new Error('Repair requires an approved revision')
        const frozen = progress.filter(item => item.state === 'succeeded' || item.state === 'in-flight')
        const frozenKeys = new Set(frozen.map(item => item.taskKey))
        const priorRejectedRepairs = store.issued(enrollment.watcherId)
          .filter(issued => issued.plannerMode === 'repair' && issued.revision === revision.number && issued.attemptId !== attemptId && !store.report(issued.attemptId))
          .map(issued => {
            const prior = readIssuedReport(issued.reportPath)
            return { attemptId: issued.attemptId, problems: 'problem' in prior
              ? [prior.problem.reason] : repairReportProblems(prior.value, revision.plan, [...frozenKeys]) }
          })
        spec = repairPlannerSpec(enrollment.kindPayload, path, frozen.map(item => ({
          ...item, title: revision.plan.plan.tasks.find(task => task.taskKey === item.taskKey)?.title,
          state: item.state === 'in-flight' ? 'running' : item.state,
          filesModified: item.successfulAttemptId ? (store.report(item.successfulAttemptId)?.report as ImplementerReport)?.filesModified ?? [] : []
        })), revision.plan.plan.tasks.filter(task => !frozenKeys.has(task.taskKey)),
        { checks: store.checks(enrollment.watcherId), verdicts: store.verdicts(enrollment.watcherId),
          overruns: store.overruns(enrollment.watcherId), priorRejectedRepairs,
          attempts: inspection?.journal.filter(entry => entry.kind === 'attempt') }, rejectedDraft)
      } else if (role === 'reviewer' || role === 'integrator') {
        if (!revision) throw new Error('Review requires an approved revision')
        spec = role === 'reviewer' ? reviewerSpec(enrollment.kindPayload, path, revision.plan) : integratorSpec(enrollment.kindPayload, path, revision.plan)
      } else {
        spec = objectivePrompt(enrollment.kindPayload, role, path, task, progress, rejectedDraft)
      }
      return { worker: {
        spec, worktree: `path:${enrollment.workspacePath}`, agent: await agentFor(enrollment.kindPayload, role), mode: 'terminal',
        taskTitle: task?.title.slice(0, 80) ?? `${role === 'planner' ? 'Plan' : role}: ${enrollment.kindPayload.objectiveText.split(/\r?\n/)[0]!.slice(0, 80)}`
      } }
    },
    async submission({ submission, enrollment }: { submission: OrchestrationSubmission; enrollment: ObjectiveEnrollment }): Promise<OrchestrationSubmissionVerdict> {
      if (submission.type !== 'worker_done' || submission.payload?.outcome === 'failed') return { kind: 'accepted' }
      const inspection = await inspect(enrollment.watcherId)
      const attempts = new Map<string, ObjectiveJournalEntry>()
      for (const entry of [...(inspection?.journal ?? [])].sort((a, b) => a.seq - b.seq)) {
        if (entry.kind === 'attempt' && typeof entry.attemptId === 'string') attempts.set(entry.attemptId, entry)
      }
      const matches = [...attempts.values()].filter(attempt => attempt.dispatchId === submission.dispatchId && attempt.state === 'running')
      if (matches.length !== 1) return rejected('stale-dispatch', 'No running objective attempt owns this dispatch.')
      const issued = store.issued(enrollment.watcherId).find(value => value.attemptId === matches[0]!.attemptId)
      if (!issued) return rejected('missing-report', 'No report path was issued for this attempt.')
      const path = submission.payload?.reportPath
      if (typeof path !== 'string' || !path) return rejected('missing-report', 'A successful worker must provide its report path.')
      if (path !== issued.reportPath) return rejected('report-path-mismatch', 'Use the exact report path issued for this attempt, not an alias.')
      const parsed = readIssuedReport(path)
      if ('problem' in parsed) return rejected(parsed.problem.code, parsed.problem.reason)
      const report = parsed.value
      const revision = store.revision(enrollment.watcherId)
      const task = revision?.number === issued.revision ? revision.plan.plan.tasks.find(task => task.taskKey === issued.taskKey) : undefined
      const progress = deriveProgress(world(enrollment), inspection?.journal ?? [])
      const frozen = progress.tasks.filter(task => task.state === 'succeeded' || task.state === 'in-flight').map(task => task.taskKey)
      const activeRevision = revision?.number === issued.revision ? revision : null
      const problems = issued.role === 'planner'
        ? issued.plannerMode === 'repair'
          ? activeRevision ? repairReportProblems(report, activeRevision.plan, frozen) : ['Repair revision is no longer active.']
          : plannerReportProblems(report)
        : issued.role === 'reviewer' || issued.role === 'integrator'
          ? activeRevision ? (issued.role === 'reviewer' ? reviewerReportProblems : integratorReportProblems)(report, activeRevision.plan) : ['Review revision is no longer active.']
          : task ? implementerReportProblems(report, task, enrollment.kindPayload.writeTerritory) : ['The assigned task is no longer in the approved revision.']
      let afterIdentity: string | null = null
      if (issued.role !== 'planner') {
        const run = runtime(enrollment)
        afterIdentity = await run.captureContentIdentity()
        const identity = afterIdentity
        const filesModified = record(report) && Array.isArray(report.filesModified) && report.filesModified.every(path => typeof path === 'string')
          ? report.filesModified : undefined
        const baseline = await baselineProblems({ ...run, captureContentIdentity: async () => identity }, issued,
          issued.role === 'implementer' ? filesModified : undefined)
        if (baseline.length) return rejected(baseline[0]!.split(':')[0]!, baseline.join('; '))
      }
      if (problems.length) return rejected('invalid-report', problems.join('; '))
      const digest = reportDigest(report)
      const acceptedAtMs = Date.now()
      if (issued.role === 'reviewer' || issued.role === 'integrator') {
        const verdict = report as ReviewerReport | IntegratorReport
        const accepted = store.acceptVerdict({
          attemptId: issued.attemptId, watcherId: enrollment.watcherId, dispatchId: submission.dispatchId,
          revision: issued.revision!, role: issued.role, contentIdentity: afterIdentity!,
          verdict: verdict.verdict, criteriaResults: verdict.criteriaResults,
          checksRun: 'checksRun' in verdict ? verdict.checksRun : [], summary: verdict.summary, digest, acceptedAtMs
        })
        return accepted ? { kind: 'accepted' } : rejected('report-already-accepted', 'A different verdict was already accepted for this attempt.')
      }
      const accepted = store.accept({ attemptId: issued.attemptId, watcherId: enrollment.watcherId, dispatchId: submission.dispatchId,
        role: issued.role, report: report as PlannerReport | ImplementerReport | RepairPlannerReport, digest, acceptedAtMs })
      return accepted ? { kind: 'accepted' } : rejected('report-already-accepted', 'A different report was already accepted for this attempt.')
    },
    async rejectDraft({ watcherId, digest, reason }: { watcherId: string; digest?: string; reason?: string }) {
      const inspection = await inspect(watcherId)
      if (!inspection) throw context.error('not-found', 'watcher-not-found')
      if (inspection.enrollment.kind !== 'objective') throw context.error('invalid-params', 'watcher-not-objective')
      if (inspection.enrollment.terminalAtMs != null) throw context.error('conflict', 'watcher-terminal')
      const progress = deriveProgress(world(inspection.enrollment), inspection.journal)
      const draft = progress.draft
      if (!draft) throw context.error('invalid-params', 'no-pending-draft')
      if (digest !== undefined && digest !== draft.digest) throw context.error('invalid-params', 'draft-digest-mismatch')
      store.rejectDraft({ attemptId: draft.plannerAttemptId, watcherId, digest: draft.digest, reason: reason ?? null, rejectedAtMs: Date.now() })
      await context.call('quirky.heimdall/reconcile', { watcherId })
      return { rejected: true, attemptId: draft.plannerAttemptId, digest: draft.digest, reason: reason ?? null }
    },
    async detail({ watcherId }: { watcherId: string }): Promise<ObjectiveDetail | null> {
      const inspection = await inspect(watcherId)
      if (!inspection || inspection.enrollment.kind !== 'objective') return null
      const enrollment = inspection.enrollment
      const contentIdentity = await runtime(enrollment).captureContentIdentity()
      const git = await readLocalGitHead(context, enrollment.workspacePath)
      const currentWorld = world(enrollment)
      currentWorld.contentIdentity = contentIdentity
      currentWorld.observedAtMs = Date.now()
      currentWorld.git = git
      const progress = deriveProgress(currentWorld, inspection.journal)
      const terminal = enrollment.terminalAtMs != null
      const next = terminal ? { action: null, reason: 'objective-bar-reached' } : nextStep(currentWorld, inspection.journal)
      const draftReport = progress.draft ? store.report(progress.draft.plannerAttemptId) : null
      const draftPlan = draftReport?.report as PlannerReport | RepairPlannerReport | undefined
      const revision = store.revision(watcherId)
      if (terminal) {
        const saved = store.landings(watcherId).filter(row => row.rung === 'files-on-disk' && row.payload.revision === revision?.number).at(-1)
        if (Array.isArray(saved?.payload.tasks)) progress.tasks = saved.payload.tasks as ObjectiveProgress['tasks']
      }
      return {
        watcherId, worktreeId: enrollment.worktreeId ?? null, workspacePath: enrollment.workspacePath,
        contract: enrollment.kindPayload, effectiveConcurrency: 1, contentIdentity, git,
        rejectedDrafts: store.rejectedDrafts(watcherId), gates: store.checks(watcherId).filter(check => check.kind === 'gate'),
        verdicts: store.verdicts(watcherId), landings: store.landings(watcherId),
        next: { actionKind: next.action?.kind ?? null, evidenceKey: next.action?.evidenceKey ?? null, reason: next.action ? null : next.reason ?? null },
        draft: draftReport && draftPlan ? { plannerAttemptId: draftReport.attemptId, digest: draftReport.digest,
          kind: 'repair' in draftPlan ? 'repair' : 'initial',
          ...('repair' in draftPlan ? { repair: draftPlan.repair } : { tasks: draftPlan.plan.tasks }), assumptions: draftPlan.assumptions } : null,
        revision: revision ? {
          number: revision.number, digest: revision.digest, approvedAtMs: revision.approvedAtMs, repairCount: store.repairs(watcherId).filter(repair => repair.revision === revision.number).length,
          tasks: revision.plan.plan.tasks.map(task => {
            const state = progress.tasks.find(value => value.taskKey === task.taskKey)!
            const accepted = state.successfulAttemptId ? store.report(state.successfulAttemptId) : null
            return { ...task, state: state.state, attempts: state.attempts, summary: accepted ? (accepted.report as ImplementerReport).summary : null,
              filesModified: accepted ? (accepted.report as ImplementerReport).filesModified : [],
              overruns: store.overruns(watcherId).filter(overrun => overrun.taskKey === task.taskKey && overrun.revision === revision.number),
              checks: store.checks(watcherId).filter(check => check.kind === 'criterion' && check.revision === revision.number && task.criteria.some((_, index) => check.targetKey === `${task.taskKey}:${index}`)) }
          })
        } : null
      }
    }
  }
}

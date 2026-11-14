import { appendFileSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { OrchestrationSubmission, OrchestrationSubmissionVerdict, PluginContext } from '@quirky/protocol'
import { contractProblems, objectivePayload, resolveWorkspace, type ObjectivePayload } from './contract'
import { decideObjective, deriveProgress, nextStep, paceObjective, stopObjective } from './decide'
import type { ObjectiveJournalEntry, ObjectiveSnapshot, ObjectiveWorld } from './decide'
import { implementerReportProblems, plannerReportProblems, reportDigest } from './plan'
import type { ImplementerReport, PlannerReport } from './plan'
import { objectivePrompt } from './prompts'
import type { ObjectiveStore } from './store'

export interface ObjectiveEnrollment {
  watcherId: string; kind: string; workspacePath: string; worktreeId?: string | null
  kindPayload: ObjectivePayload; capabilities: Record<string, 'off' | 'gated' | 'on'>
}
interface Inspection { enrollment: ObjectiveEnrollment; journal: ObjectiveJournalEntry[] }
interface Action {
  kind: string; plannerAttemptId?: string; digest?: string; revision?: number; taskKey?: string
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const rejected = (code: string, reason: string): OrchestrationSubmissionVerdict => ({ kind: 'rejected', code, reason })

/** Implements the registered kind using only daemon and plugin public methods. */
export function createObjectiveHooks(context: PluginContext, store: ObjectiveStore) {
  const indexes = new Map<string, { source: string; stamp: string | null }>()
  async function inspect(watcherId: string): Promise<Inspection | null> {
    const result = await context.call('quirky.heimdall/inspect', { watcherId })
    if (!Array.isArray(result)) throw new Error('Heimdall inspection is unavailable')
    const value: unknown = result.find((item: unknown) => record(item) && record(item.enrollment) && item.enrollment.watcherId === watcherId)
    if (!record(value) || !record(value.enrollment) || !Array.isArray(value.journal)) return null
    return value as unknown as Inspection
  }
  function world(enrollment: ObjectiveEnrollment): ObjectiveWorld {
    const revision = store.revision(enrollment.watcherId)
    const issued = store.issued(enrollment.watcherId)
    return {
      planMode: enrollment.capabilities.plan ?? 'off',
      revision: revision ? {
        number: revision.number, digest: revision.digest,
        tasks: revision.plan.plan.tasks.map(task => ({ taskKey: task.taskKey, deps: task.deps, criteriaCount: task.criteria.length }))
      } : null,
      reports: store.reports(enrollment.watcherId).map(report => ({
        attemptId: report.attemptId, role: report.role, digest: report.digest,
        taskKey: issued.find(value => value.attemptId === report.attemptId)?.taskKey ?? null
      })),
      issued: issued.map(({ attemptId, role, revision, taskKey }) => ({ attemptId, role, revision, taskKey }))
    }
  }
  async function git(workspacePath: string, args: string[], env?: Record<string, string | undefined>): Promise<string> {
    const result = await context.process.run(['git', ...args], { cwd: workspacePath, timeoutMs: 30_000, ...(env ? { env } : {}) })
    if (result.exitCode !== 0 || result.signal !== null || result.stopped || result.spawnError) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    return result.stdoutText.trim()
  }
  async function reportPath(enrollment: ObjectiveEnrollment, attemptId: string): Promise<string> {
    const raw = await git(enrollment.workspacePath, ['rev-parse', '--git-path', 'info/exclude'])
    if (!raw) throw new Error('Git did not return a private exclude path')
    const path = isAbsolute(raw) ? raw : resolve(enrollment.workspacePath, raw)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const contents = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!contents.split(/\r?\n/).some(line => line.trim() === '/.quirky/objective/')) {
      appendFileSync(path, `${contents && !contents.endsWith('\n') ? '\n' : ''}/.quirky/objective/\n`, { mode: 0o600 })
    }
    const directory = join(enrollment.workspacePath, '.quirky', 'objective', enrollment.watcherId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return join(directory, `${attemptId}.json`)
  }
  async function agentFor(payload: ObjectivePayload, role: 'planner' | 'implementer'): Promise<string> {
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
    async read({ enrollment }: { enrollment: ObjectiveEnrollment }): Promise<ObjectiveSnapshot> {
      const directory = join(context.dataDir, 'identity')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const index = join(directory, `${enrollment.watcherId}.index`)
      let cached = indexes.get(index)
      if (!cached) {
        const raw = await git(enrollment.workspacePath, ['rev-parse', '--git-path', 'index'])
        cached = { source: isAbsolute(raw) ? raw : resolve(enrollment.workspacePath, raw), stamp: null }
        indexes.set(index, cached)
      }
      const stat = existsSync(cached.source) ? statSync(cached.source, { bigint: true }) : null
      const stamp = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'missing'
      if (stamp !== cached.stamp) {
        // tracked ignored files must stay tracked; reuse the private stat cache until the real index changes.
        if (stat) copyFileSync(cached.source, index, constants.COPYFILE_FICLONE)
        else rmSync(index, { force: true })
        cached.stamp = stamp
      }
      const env = { ...process.env, GIT_INDEX_FILE: index }
      await git(enrollment.workspacePath, ['add', '-A'], env)
      const oid = await git(enrollment.workspacePath, ['write-tree'], env)
      return { freshness: 'live', contentIdentity: `objective-tree:${oid}`, observedAtMs: Date.now(), world: world(enrollment) }
    },
    decide({ snapshot, journal, enrollment }: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[]; enrollment: ObjectiveEnrollment }) {
      return decideObjective({ ...snapshot, world: world(enrollment) }, journal)
    },
    stop({ snapshot, journal, enrollment }: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[]; enrollment: ObjectiveEnrollment }) {
      return stopObjective({ ...snapshot, world: world(enrollment) }, journal)
    },
    pace({ snapshot, journal }: { snapshot: ObjectiveSnapshot; journal: ObjectiveJournalEntry[] }) { return paceObjective(snapshot, journal) },
    async execute({ action, enrollment, attemptId }: { action: Action; enrollment: ObjectiveEnrollment; attemptId: string }) {
      if (action.kind === 'activate-plan') {
        if (!action.plannerAttemptId || !action.digest) throw new Error('Plan activation is missing its draft authority')
        store.activate(enrollment.watcherId, action.plannerAttemptId, action.digest)
        return { effect: 'landed' }
      }
      const role = action.kind === 'dispatch-planner' ? 'planner' : 'implementer'
      if (action.kind !== 'dispatch-planner' && action.kind !== 'dispatch-node') throw new Error('Unknown objective action')
      const revision = store.revision(enrollment.watcherId)
      const task = role === 'implementer' ? revision?.plan.plan.tasks.find(task => task.taskKey === action.taskKey) : undefined
      if (role === 'implementer' && (!task || revision?.number !== action.revision)) throw new Error('The assigned task is not in the approved revision')
      const path = await reportPath(enrollment, attemptId)
      store.issue({ attemptId, watcherId: enrollment.watcherId, role, revision: role === 'implementer' ? revision!.number : null,
        taskKey: task?.taskKey ?? null, reportPath: path, issuedAtMs: Date.now() })
      const inspection = role === 'implementer' ? await inspect(enrollment.watcherId) : null
      const progress = inspection ? deriveProgress(world(enrollment), inspection.journal).tasks : undefined
      return { worker: {
        spec: objectivePrompt(enrollment.kindPayload, role, path, task, progress),
        worktree: `path:${enrollment.workspacePath}`, agent: await agentFor(enrollment.kindPayload, role), mode: 'terminal',
        taskTitle: role === 'planner' ? `Plan: ${enrollment.kindPayload.objectiveText.split(/\r?\n/)[0]!.slice(0, 80)}` : task!.title.slice(0, 80)
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
      let report: unknown
      try {
        if (lstatSync(path).isSymbolicLink()) return rejected('report-path-mismatch', 'The issued report must not be a symlink.')
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile()) return rejected('invalid-report', 'The report must be a regular JSON file.')
          if (stat.size > 262_144) return rejected('report-too-large', 'The report exceeds 262144 bytes.')
          const bytes = Buffer.alloc(262_145)
          let size = 0
          for (;;) {
            const count = readSync(fd, bytes, size, bytes.length - size, null)
            size += count
            if (size > 262_144) return rejected('report-too-large', 'The report exceeds 262144 bytes.')
            if (!count) break
          }
          report = JSON.parse(bytes.subarray(0, size).toString('utf8'))
        } finally { closeSync(fd) }
      } catch (error) {
        return rejected('invalid-report', `The report could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const revision = store.revision(enrollment.watcherId)
      const task = revision?.number === issued.revision ? revision.plan.plan.tasks.find(task => task.taskKey === issued.taskKey) : undefined
      const problems = issued.role === 'planner' ? plannerReportProblems(report) : task
        ? implementerReportProblems(report, task, enrollment.kindPayload.writeTerritory) : ['The assigned task is no longer in the approved revision.']
      if (problems.length) return rejected('invalid-report', problems.join('; '))
      const accepted = store.accept({ attemptId: issued.attemptId, watcherId: enrollment.watcherId, dispatchId: submission.dispatchId,
        role: issued.role, report: report as PlannerReport | ImplementerReport, digest: reportDigest(report), acceptedAtMs: Date.now() })
      return accepted ? { kind: 'accepted' } : rejected('report-already-accepted', 'A different report was already accepted for this attempt.')
    },
    async detail({ watcherId }: { watcherId: string }) {
      const inspection = await inspect(watcherId)
      if (!inspection || inspection.enrollment.kind !== 'objective') return null
      const enrollment = inspection.enrollment
      const currentWorld = world(enrollment)
      const progress = deriveProgress(currentWorld, inspection.journal)
      const next = nextStep(currentWorld, inspection.journal)
      const draftReport = progress.draft ? store.report(progress.draft.plannerAttemptId) : null
      const draftPlan = draftReport?.report as PlannerReport | undefined
      const revision = store.revision(watcherId)
      return {
        watcherId, worktreeId: enrollment.worktreeId ?? null, workspacePath: enrollment.workspacePath,
        contract: enrollment.kindPayload, effectiveConcurrency: 1,
        next: { actionKind: next.action?.kind ?? null, evidenceKey: next.action?.evidenceKey ?? null, reason: next.action ? null : next.reason },
        draft: draftReport && draftPlan ? { plannerAttemptId: draftReport.attemptId, digest: draftReport.digest, tasks: draftPlan.plan.tasks, assumptions: draftPlan.assumptions } : null,
        revision: revision ? {
          number: revision.number, digest: revision.digest, approvedAtMs: revision.approvedAtMs,
          tasks: revision.plan.plan.tasks.map(task => {
            const state = progress.tasks.find(value => value.taskKey === task.taskKey)!
            const accepted = state.successfulAttemptId ? store.report(state.successfulAttemptId) : null
            return { ...task, state: state.state, attempts: state.attempts, summary: accepted ? (accepted.report as ImplementerReport).summary : null }
          })
        } : null
      }
    }
  }
}

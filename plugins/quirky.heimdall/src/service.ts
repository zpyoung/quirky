import { parseContributionId, validateValue, type OrchestrationSubmission, type OrchestrationSubmissionVerdict, type PluginCaller, type PluginContext } from '@quirky/protocol'
import { join } from 'node:path'
import type {
  Enrollment,
  EnrollmentInput,
  EnrollmentResult,
  Inspection,
  KernelOptions,
  KernelStore,
  KindRegistration,
  KindRegistry,
  Runner,
  RunnerOptions
} from './contracts'
import { budgetUsage } from './budget'
import { createEnrollmentService } from './enrollment'
import { createKindRegistry } from './registry'
import { createKernelStore } from './store'
import { createOrchestrationAdapter } from './orchestration'
import { createRunner } from './runner'
import { createOwnerDriver } from './owner/driver'
import type { OwnerController } from './owner/contracts'
import { inspectWorkspaceRemoval, terminalizeRemovedEnrollment } from './workspace-lifecycle'
import { isJsonValue, isRecord } from './json'

const SHUTDOWN_DRAIN_MS = 1500


export interface KernelService {
  readonly context: PluginContext
  readonly store: KernelStore
  readonly registry: KindRegistry
  readonly owner: OwnerController
  start(): Promise<void>
  registerKind(descriptor: KindRegistration, caller: PluginCaller): Promise<{ registered: true; kind: string }>
  enroll(input: EnrollmentInput): Promise<EnrollmentResult>
  inspect(watcherId?: string): Inspection[]
  reconcile(watcherId: string): Promise<Inspection>
  submissionPreflight(submission: unknown, caller: PluginCaller): Promise<OrchestrationSubmissionVerdict>
  runner(watcherId: string): Runner | undefined
  /** Drops only the map entry; the caller must fence/suspend the runner and remove its row first. */
  forgetRunner(watcherId: string): void
  changed(watcherId: string): void
  shutdown(): Promise<void>
}

export function createKernelService(context: PluginContext, now: () => number = Date.now): KernelService {
  const store = createKernelStore(context)
  const registry = createKindRegistry(context, store)
  const runners = new Map<string, Runner>()
  const executableKinds = new Set<string>()
  const wakesBeforeRestore = new Set<string>()
  let stopped = false
  let started = false
  let startPromise: Promise<void> | undefined
  let shutdownPromise: Promise<void> | undefined

  const changed = (watcherId: string): void => {
    if (!stopped) context.emit('changed', { watcherId })
  }
  const wake = (watcherId: string): void => {
    if (stopped) return
    const runner = runners.get(watcherId)
    if (!runner) {
      wakesBeforeRestore.add(watcherId)
      return
    }
    void runner.pulse().catch((error: unknown) => {
      context.log(`watcher ${watcherId} mailbox reconciliation failed: ${errorMessage(error)}`)
    })
  }
  const orchestration = createOrchestrationAdapter(context, store, wake)
  const owner = createOwnerDriver({ context, store, registry, reportDirectory: join(context.dataDir, 'owner-reports'), now, wake })
  const options: KernelOptions = { context, store, registry, orchestration, now, onChanged: changed, owner }
  async function handleWorkspaceChange(event: { type: string; data?: unknown }): Promise<void> {
    if (stopped || event.type !== 'quirky.worktree/changed') return
    const candidates = store.list().filter((enrollment) =>
      enrollment.terminalAtMs === null &&
      enrollment.executionHostId === 'local' &&
      enrollment.schedulerOwner === 'daemon' &&
      typeof enrollment.repoId === 'string' &&
      typeof enrollment.worktreeId === 'string'
    )
    for (const enrollment of candidates) {
      if (stopped) return
      const evidence = await inspectWorkspaceRemoval(context, enrollment, event)
      if (stopped) return
      if (evidence === 'unverifiable') {
        context.log(`workspace removal inventory is unverifiable for watcher ${enrollment.watcherId}`)
        continue
      }
      if (evidence !== 'confirmed-removed') continue
      const current = store.get(enrollment.watcherId)
      if (!current || current.terminalAtMs !== null || current.workspaceKey !== enrollment.workspaceKey ||
        current.repoId !== enrollment.repoId || current.worktreeId !== enrollment.worktreeId) continue
      const runner = runners.get(current.watcherId)
      if (runner) {
        await runner.terminateWorkspaceRemoved()
      } else {
        const summary = terminalizeRemovedEnrollment(store, current, now)
        if (!summary) continue
        try {
          await owner.controller.release(current.watcherId)
        } catch (error) {
          context.log(`owner cleanup after workspace removal failed for watcher ${current.watcherId}: ${errorMessage(error)}`)
        }
      }
      const terminal = store.get(current.watcherId)
      if (terminal && terminal.terminalAtMs !== null) changed(current.watcherId)
    }
  }

  const unsubscribeWorkspaceChanges = store.readOnly ? () => {} : context.subscribe((event) => {
    if (event.type !== 'quirky.worktree/changed') return
    const data = 'data' in event ? event.data : undefined
    return handleWorkspaceChange({ type: event.type, data }).catch((error: unknown) => {
      context.log(`workspace removal reconciliation failed: ${errorMessage(error)}`)
    })
  })

  function startRunner(enrollment: Enrollment): Runner | undefined {
    if (stopped || store.readOnly || enrollment.terminalAtMs !== null) return undefined
    if (enrollment.malformed !== undefined) {
      runners.get(enrollment.watcherId)?.suspend()
      runners.delete(enrollment.watcherId)
      return undefined
    }
    if (!executableKinds.has(enrollment.kind)) return undefined
    const kind = registry.get(enrollment.kind)
    if (!kind) return undefined
    const malformed = validateValue(kind.enrollmentPayloadSchema, enrollment.kindPayload, 'kindPayload')
    if (malformed !== null) {
      runners.get(enrollment.watcherId)?.suspend()
      runners.delete(enrollment.watcherId)
      store.save({ ...enrollment, malformed })
      return undefined
    }
    const existing = runners.get(enrollment.watcherId)
    if (existing) {
      existing.schedule(0)
      return existing
    }
    const runnerOptions: RunnerOptions = { ...options, enrollment }
    const runner = createRunner(runnerOptions)
    runners.set(enrollment.watcherId, runner)
    runner.schedule(0)
    if (wakesBeforeRestore.delete(enrollment.watcherId)) wake(enrollment.watcherId)
    return runner
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise
    startPromise = restoreRunners()
    return startPromise
  }

  async function restoreRunners(): Promise<void> {
    if (started || stopped) return
    if (store.readOnly) {
      started = true
      return
    }
    for (const descriptor of store.registrations()) {
      if (typeof descriptor.pluginId !== 'string' || descriptor.pluginId.length === 0 || !hooksBelongToOwner(descriptor, descriptor.pluginId)) {
        context.log(`skipping Heimdall kind registration ${descriptor.id}: invalid owner or hook namespace`)
        continue
      }
      try {
        registry.registerDescriptor(descriptor, descriptor.pluginId)
      } catch (error) {
        context.log(`could not restore Heimdall kind ${descriptor.id}: ${errorMessage(error)}`)
      }
    }
    let effectiveHooks: Set<string>
    try {
      effectiveHooks = await effectiveHookReferences(context)
    } catch (error) {
      context.log(`could not verify Heimdall kind methods; restored watchers remain dormant: ${errorMessage(error)}`)
      started = true
      return
    }
    if (stopped) return
    for (const descriptor of registry.descriptors()) {
      if (
        typeof descriptor.pluginId !== 'string' ||
        !hooksBelongToOwner(descriptor, descriptor.pluginId) ||
        !Object.values(descriptor.hooks).every((method) => effectiveHooks.has(method))
      ) {
        context.log(`Heimdall kind ${descriptor.id} is dormant because one or more owner methods are unavailable`)
        continue
      }
      executableKinds.add(descriptor.id)
    }
    for (const enrollment of store.list()) {
      if (stopped) return
      if (enrollment.terminalAtMs === null && enrollment.orchestrationRunId !== null) {
        try {
          await orchestration.restore(enrollment)
        } catch (error) {
          context.log(`could not restore submission preflight for watcher ${enrollment.watcherId}: ${errorMessage(error)}`)
        }
      }
      if (stopped) return
      startRunner(enrollment)
    }
    started = true
  }

  const enrollmentService = createEnrollmentService(options, (enrollment) => {
    startRunner(enrollment)
  })

  async function registerKind(descriptor: KindRegistration, caller: PluginCaller): Promise<{ registered: true; kind: string }> {
    if (stopped) throw context.error('conflict', 'Heimdall is shutting down')
    if (!started) throw context.error('conflict', 'Heimdall startup has not restored its registrations')
    if (store.readOnly) throw context.error('conflict', 'Heimdall storage is read-only')
    if (caller.role !== 'plugin' || typeof caller.pluginId !== 'string' || caller.pluginId.length === 0) {
      throw context.error('invalid-params', 'only an authenticated plugin may register Heimdall kinds')
    }
    if (
      typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor) ||
      typeof descriptor.hooks !== 'object' || descriptor.hooks === null || Array.isArray(descriptor.hooks)
    ) {
      throw context.error('invalid-params', 'kind registration must contain method-reference hooks')
    }
    if (descriptor.pluginId !== undefined && descriptor.pluginId !== caller.pluginId) {
      throw context.error('invalid-params', 'kind registration cannot claim another plugin identity')
    }
    for (const [name, method] of Object.entries(descriptor.hooks)) {
      if (typeof method !== 'string' || !method.startsWith(`${caller.pluginId}/`) || method.length === caller.pluginId.length + 1) {
        throw context.error('invalid-params', `kind hook ${name} must reference a method in ${caller.pluginId}'s namespace`)
      }
    }
    const effectiveHooks = await effectiveHookReferences(context)
    if (stopped || store.readOnly) throw context.error('conflict', 'Heimdall no longer accepts kind registrations')
    if (!Object.values(descriptor.hooks).every((method) => effectiveHooks.has(method))) {
      throw context.error('invalid-params', 'every kind hook must name an effective method declared by its owner plugin')
    }
    const owned: KindRegistration = { ...descriptor, pluginId: caller.pluginId }
    const current = registry.descriptors().find((registration) => registration.id === owned.id)
    if (
      !current ||
      current.pluginId !== caller.pluginId ||
      JSON.stringify(current) !== JSON.stringify(owned)
    ) {
      registry.registerDescriptor(owned, caller.pluginId)
    }
    executableKinds.add(owned.id)
    for (const enrollment of store.list()) {
      if (enrollment.kind === owned.id) startRunner(enrollment)
    }
    return { registered: true, kind: owned.id }
  }
  async function submissionPreflight(
    value: unknown,
    caller: PluginCaller
  ): Promise<OrchestrationSubmissionVerdict> {
    if (caller.role !== 'plugin' || caller.pluginId !== 'quirky.orchestration') {
      throw context.error('invalid-params', 'submission preflight requires an authenticated quirky.orchestration caller')
    }
    if (!isOrchestrationSubmission(value)) return rejectedSubmission('invalid-submission', 'The submission payload is invalid.')
    if (stopped || !started || store.readOnly) return rejectedSubmission('kernel-unavailable', 'Heimdall cannot validate submissions right now.')

    const ownedRun = (): Enrollment | null => {
      const matching = store.list().filter((enrollment) => enrollment.orchestrationRunId === value.runId)
      if (matching.length !== 1) return null
      const current = store.get(matching[0]!.watcherId)
      return current && current.terminalAtMs === null && current.orchestrationRunId === value.runId ? current : null
    }
    const journalAllowsDispatch = (enrollment: Enrollment): boolean => {
      const latest = new Map<string, Record<string, unknown>>()
      for (const entry of store.journal(enrollment.watcherId)) {
        if (entry.kind === 'attempt' && typeof entry.attemptId === 'string') latest.set(entry.attemptId, entry)
      }
      const attempts = [...latest.values()].filter((attempt) => attempt.dispatchId === value.dispatchId)
      return attempts.length === 0 || (attempts.length === 1 && attempts[0]!.state === 'running')
    }
    const activeDispatchEvidence = async (): Promise<'active' | 'inactive' | 'unverifiable'> => {
      let detail: unknown
      try {
        detail = await context.call('quirky.orchestration/serviceRunShow', { runId: value.runId })
      } catch {
        return 'unverifiable'
      }
      if (!isRecord(detail) || !isRecord(detail.run) || detail.run.id !== value.runId ||
        !Array.isArray(detail.workers)) return 'unverifiable'
      const matches = detail.workers.filter((worker) =>
        isRecord(worker) && worker.dispatchId === value.dispatchId
      )
      if (matches.length === 0) return 'inactive'
      if (matches.length !== 1) return 'unverifiable'
      const worker = matches[0]
      if (!isRecord(worker)) return 'unverifiable'
      if (worker.taskId !== value.taskId) return 'inactive'
      if (typeof worker.assignmentActive !== 'boolean') return 'unverifiable'
      return worker.assignmentActive ? 'active' : 'inactive'
    }

    let current = ownedRun()
    if (!current) {
      const hasRun = store.list().some((enrollment) => enrollment.orchestrationRunId === value.runId)
      return hasRun
        ? rejectedSubmission('stale-dispatch', 'The report no longer belongs to an active Dispatch.')
        : rejectedSubmission('run-not-owned', 'This Run is not owned by an active Heimdall watcher.')
    }
    const dispatchEvidence = await activeDispatchEvidence()
    if (dispatchEvidence === 'unverifiable') {
      return rejectedSubmission('dispatch-unverifiable', 'The active Dispatch could not be verified; the report was not accepted.')
    }
    if (dispatchEvidence !== 'active' || !journalAllowsDispatch(current)) {
      return rejectedSubmission('stale-dispatch', 'The report no longer belongs to an active Dispatch.')
    }

    const kindId = current.kind
    const descriptor = registry.descriptors().find((registration) => registration.id === kindId) ??
      store.registrations().find((registration) => registration.id === kindId)
    const method = descriptor?.hooks.submission
    if (method === undefined) return { kind: 'accepted' }
    if (!descriptor || typeof descriptor.pluginId !== 'string') {
      return rejectedSubmission('hook-unavailable', 'The registered submission hook is unavailable; the report was not accepted.')
    }
    const prefix = `${descriptor.pluginId}/`
    if (!method.startsWith(prefix) || method.slice(prefix.length).includes('/')) {
      return rejectedSubmission('hook-unavailable', 'The registered submission hook is unavailable; the report was not accepted.')
    }
    const kind = registry.get(current.kind)
    if (!kind?.submission) {
      return rejectedSubmission('hook-unavailable', 'The registered submission hook is unavailable; the report was not accepted.')
    }

    let verdict: unknown
    try {
      verdict = await kind.submission(value, current)
    } catch {
      return rejectedSubmission('hook-unavailable', 'The registered submission hook could not be reached; the report was not accepted.')
    }
    if (!isOrchestrationSubmissionVerdict(verdict)) {
      return rejectedSubmission('hook-invalid-result', 'The registered submission hook returned an invalid verdict.')
    }
    current = ownedRun()
    if (!current) return rejectedSubmission('stale-dispatch', 'The report no longer belongs to an active Dispatch.')
    const finalEvidence = await activeDispatchEvidence()
    if (finalEvidence === 'unverifiable') {
      return rejectedSubmission('dispatch-unverifiable', 'The active Dispatch could not be verified; the report was not accepted.')
    }
    if (finalEvidence !== 'active' || !journalAllowsDispatch(current)) {
      return rejectedSubmission('stale-dispatch', 'The report no longer belongs to an active Dispatch.')
    }
    return verdict
  }

  async function enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    if (stopped) throw context.error('conflict', 'Heimdall is shutting down')
    if (store.readOnly) throw context.error('conflict', 'Heimdall storage is read-only')
    const result = await enrollmentService.enroll(input)
    if (stopped) throw context.error('conflict', 'Heimdall shut down while enrollment was in progress')
    return result
  }

  function inspect(watcherId?: string): Inspection[] {
    const enrollments = watcherId === undefined
      ? store.list()
      : [store.get(watcherId)].filter((enrollment): enrollment is Enrollment => enrollment !== null)
    return enrollments.map((enrollment) => {
      const journal = store.journal(enrollment.watcherId)
      const runner = runners.get(enrollment.watcherId)
      const status = runner?.status() ?? (enrollment.malformed === undefined ? null : {
        state: 'malformed' as const,
        reason: enrollment.malformed,
        nextPulseAtMs: null,
        consecutiveErrors: 0,
        consecutiveGateHolds: 0
      })
      const summary = store.summary(enrollment.watcherId)
      return {
        readOnly: store.readOnly,
        enrollment,
        status,
        journal,
        traces: store.traces(enrollment.watcherId),
        summary,
        budget: enrollment.terminalAtMs !== null && summary !== null
          ? summary.budget
          : budgetUsage(journal, now(), enrollment.budget)
      }
    })
  }

  async function reconcile(watcherId: string): Promise<Inspection> {
    if (stopped) throw context.error('conflict', 'Heimdall is shutting down')
    if (store.readOnly) throw context.error('conflict', 'Heimdall storage is read-only')
    const runner = runners.get(watcherId)
    if (!runner) throw context.error('not-found', `no executable Heimdall runner for watcher ${watcherId}`)
    await runner.pulse()
    if (stopped) throw context.error('conflict', 'Heimdall shut down during reconciliation')
    const [inspection] = inspect(watcherId)
    if (!inspection) throw context.error('not-found', `watcher ${watcherId} no longer exists`)
    return inspection
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    stopped = true
    unsubscribeWorkspaceChanges()
    const ownerShutdown = owner.shutdown()
    orchestration.dispose()
    wakesBeforeRestore.clear()
    const startedAt = Date.now()
    const activeRunners = [...runners.values()]
    runners.clear()
    shutdownPromise = Promise.allSettled([
      ownerShutdown,
      ...activeRunners.map((runner) => runner.shutdown(Math.max(0, SHUTDOWN_DRAIN_MS - (Date.now() - startedAt))))
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') context.log(`watcher shutdown failed: ${errorMessage(result.reason)}`)
      }
      store.close()
    })
    return shutdownPromise
  }

  return {
    context,
    store,
    registry,
    owner: owner.controller,
    start,
    registerKind,
    submissionPreflight,
    enroll,
    inspect,
    reconcile,
    runner: (watcherId) => runners.get(watcherId),
    forgetRunner: (watcherId) => {
      runners.delete(watcherId)
      wakesBeforeRestore.delete(watcherId)
    },
    changed,
    shutdown
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isOrchestrationSubmission(value: unknown): value is OrchestrationSubmission {
  if (!isRecord(value) || !isJsonValue(value) ||
    Object.keys(value).some((key) => !['runId', 'taskId', 'dispatchId', 'type', 'subject', 'body', 'payload'].includes(key))) return false
  return typeof value.runId === 'string' && value.runId.length > 0 &&
    typeof value.taskId === 'string' && value.taskId.length > 0 &&
    typeof value.dispatchId === 'string' && value.dispatchId.length > 0 &&
    (value.type === 'worker_done' || value.type === 'status') &&
    typeof value.subject === 'string' && typeof value.body === 'string' &&
    (value.payload === null || (isRecord(value.payload) && isJsonValue(value.payload)))
}

function isOrchestrationSubmissionVerdict(value: unknown): value is OrchestrationSubmissionVerdict {
  if (!isRecord(value) || !isJsonValue(value)) return false
  if (value.kind === 'accepted') return Object.keys(value).length === 1
  return value.kind === 'rejected' && typeof value.code === 'string' && value.code.length > 0 &&
    typeof value.reason === 'string' && value.reason.length > 0 &&
    Object.keys(value).every((key) => key === 'kind' || key === 'code' || key === 'reason')
}

function rejectedSubmission(code: string, reason: string): OrchestrationSubmissionVerdict {
  return { kind: 'rejected', code, reason }
}
function hooksBelongToOwner(descriptor: KindRegistration, pluginId: string): boolean {
  const hooks = descriptor.hooks as unknown
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false
  const references = hooks as Record<string, unknown>
  const prefix = `${pluginId}/`
  for (const required of ['authorize', 'read', 'decide', 'execute']) {
    if (typeof references[required] !== 'string') return false
  }
  return Object.values(references).every((reference) =>
    typeof reference === 'string' && reference.startsWith(prefix) && reference.length > prefix.length
  )
}
async function effectiveHookReferences(context: PluginContext): Promise<Set<string>> {
  const contributions = await context.call('plugin.contributions', { kind: 'method' })
  if (!Array.isArray(contributions)) throw new Error('plugin.contributions returned no method list')
  const references = new Set<string>()
  for (const contribution of contributions) {
    if (typeof contribution !== 'object' || contribution === null || Array.isArray(contribution)) continue
    const item = contribution as { kind?: unknown; status?: unknown; plugin?: unknown; id?: unknown }
    if (
      item.kind === 'method' &&
      item.status === 'effective' &&
      typeof item.plugin === 'string' &&
      typeof item.id === 'string'
    ) {
      const parsed = parseContributionId(item.id)
      if (!parsed || parsed.kind !== 'method' || parsed.namespace !== item.plugin) continue
      references.add(`${parsed.namespace}/${parsed.name}`)
    }
  }
  return references
}

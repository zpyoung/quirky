import { validateValue, type PluginCaller, type PluginContext } from '@quirky/protocol'
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

const SHUTDOWN_DRAIN_MS = 1500


export interface KernelService {
  readonly context: PluginContext
  readonly store: KernelStore
  readonly registry: KindRegistry
  start(): Promise<void>
  registerKind(descriptor: KindRegistration, caller: PluginCaller): Promise<{ registered: true; kind: string }>
  enroll(input: EnrollmentInput): Promise<EnrollmentResult>
  inspect(watcherId?: string): Inspection[]
  reconcile(watcherId: string): Promise<Inspection>
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
  const options: KernelOptions = { context, store, registry, orchestration, now, onChanged: changed }

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
    for (const enrollment of store.list()) startRunner(enrollment)
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
      return {
        readOnly: store.readOnly,
        enrollment,
        status,
        journal,
        traces: store.traces(enrollment.watcherId),
        summary: store.summary(enrollment.watcherId),
        budget: budgetUsage(journal, now(), enrollment.budget)
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
    orchestration.dispose()
    wakesBeforeRestore.clear()
    const startedAt = Date.now()
    const activeRunners = [...runners.values()]
    runners.clear()
    shutdownPromise = Promise.allSettled(activeRunners.map((runner) =>
      runner.shutdown(Math.max(0, SHUTDOWN_DRAIN_MS - (Date.now() - startedAt)))
    )).then((results) => {
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
    start,
    registerKind,
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
      references.add(`${item.plugin}/${item.id}`)
    }
  }
  return references
}

import { createHash } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import type { Attempt, Enrollment, ExecuteContext, ExecuteResult, JournalEntry, KernelAction, KernelStore, KindRegistry, Snapshot } from '../contracts'
import { scanWorkers } from './detection'
import { gateOwnerAction, ownerApprovalScope } from './gate'
import { createOwnerController, parseOwnerDeviation, parseOwnerIntervention } from './runtime'
import { executeWorkerIntervention, readOwnedRun } from './workers'
import type { OwnerController, OwnerDeviation, OwnerEnrollment, OwnerKernelPort, OwnerStepResult, WorkerActivity } from './contracts'

interface DriverOptions {
  context: PluginContext; store: KernelStore; registry: KindRegistry
  reportDirectory: string; now?: () => number; wake(watcherId: string): void
}
interface WorkerView {
  observation: { status: string; exactWorker: boolean; agentWait?: { waiting: boolean }; session?: { id: string; lastActivityAt: number } | null }
}
const latestAttempts = (journal: JournalEntry[]): Attempt[] => {
  const attempts = new Map<string, Attempt>()
  for (const entry of journal) if (entry.kind === 'attempt' && typeof entry.attemptId === 'string') attempts.set(entry.attemptId, entry as Attempt)
  return [...attempts.values()]
}

export function createOwnerDriver(options: DriverOptions): OwnerKernelPort & { controller: OwnerController } {
  const { context, store, registry } = options
  const now = options.now ?? Date.now
  const proposals = new Map<string, KernelAction>()
  const dispatchFences = new Map<string, () => boolean>()
  let stopped = false
  const append = (id: string, kind: string, fields: Record<string, unknown>, resolved = false) => {
    if (stopped || store.readOnly || !store.get(id)) return
    store.append(id, { kind, class: 'fact', origin: 'owner', resolved, ...fields })
  }
  const park = (enrollment: OwnerEnrollment, escalationId: string, detail: string) => {
    if (stopped) return
    const current = store.get(enrollment.watcherId)
    if (!current || current.terminalAtMs !== null || current.paused || current.haltReason === 'explicit-disarm') return
    store.transaction(() => {
      store.save({ ...current, enabled: false, parkReason: 'owner-escalation', haltReason: detail })
      const previous = store.journal(current.watcherId).filter(entry => entry.kind === 'escalation' && entry.escalationId === escalationId).at(-1)
      if (previous?.status !== 'open') append(current.watcherId, 'escalation', { escalationId, escalationKind: 'park-owner-escalation', status: 'open', foldCount: 1, detail })
    })
  }
  const controller = createOwnerController({
    context, store, reportDirectory: options.reportDirectory, now, park, wake: options.wake,
    canDispatch: (watcherId) => !stopped && (dispatchFences.get(watcherId)?.() ?? true),
    apply: async (enrollment, intervention, deviation, snapshot) => {
      const pending = controller.inspect(enrollment.watcherId).pending
      if (!pending || stopped) return { kind: 'refused', reason: 'owner-not-current' }
      const journal = store.journal(enrollment.watcherId)
      const attempted = latestAttempts(journal).filter(entry => entry.action?.ownerReportKey === pending.reportKey).at(-1)
      if (attempted) {
        if (attempted.state === 'running' && attempted.dispatchId) return { kind: 'applied', reason: 'owner-worker-dispatched' }
        if (attempted.state !== 'settled') return { kind: 'held', reason: 'owner-attempt-in-flight' }
        if (attempted.effect === 'landed') return { kind: 'applied', reason: attempted.reason }
        if (attempted.effect === 'indeterminate') return { kind: 'indeterminate', reason: attempted.reason }
        return { kind: 'refused', reason: attempted.reason ?? 'owner-action-not-landed' }
      }
      if (!enrollment.enabled || enrollment.paused || enrollment.parkReason !== null) return { kind: 'held', reason: 'owner-work-inactive' }
      const kind = registry.get(enrollment.kind)
      let action: KernelAction
      if (intervention.kind === 'kind-action') {
        if (!kind?.ownerAction) return { kind: 'refused', reason: 'owner-action-unsupported' }
        action = await kind.ownerAction(intervention.action, snapshot, journal, enrollment)
        if (!action || typeof action.kind !== 'string' || typeof action.capability !== 'string' || !['local', 'external'].includes(action.visibility) || action.contentIdentity !== pending.contentIdentity || typeof action.evidenceKey !== 'string') {
          return { kind: 'refused', reason: 'owner-action-invalid' }
        }
      } else {
        const worker = 'dispatchId' in intervention
        action = {
          kind: `owner-${intervention.kind}`, capability: intervention.kind,
          visibility: 'local', contentIdentity: pending.contentIdentity,
          evidenceKey: pending.reportKey,
          ...(worker ? { expectedState: { target: intervention.dispatchId, before: { deviation: deviation.naturalKey } } } : {}),
        }
      }
      action = { ...action, ownerReportKey: pending.reportKey, ownerKindAction: intervention.kind === 'kind-action', ownerIntervention: intervention }
      if (stopped) return { kind: 'refused', reason: 'owner-stopped' }
      const verdict = gateOwnerAction(enrollment, action, store.journal(enrollment.watcherId))
      if (verdict.verdict !== 'allow' && verdict.reason === 'awaiting-owner-approval') {
        const scope = ownerApprovalScope(action)
        const escalationId = `owner-approval:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`
        const previous = store.journal(enrollment.watcherId).filter(entry => entry.kind === 'escalation' && entry.escalationId === escalationId).at(-1)
        if (!previous) append(enrollment.watcherId, 'escalation', { escalationId, escalationKind: 'awaiting-approval', status: 'open', foldCount: 1, approvalScope: scope, detail: 'Separate owner intervention approval required.' })
      }
      proposals.set(enrollment.watcherId, action)
      return { kind: 'held', reason: 'owner-action-queued', action }
    },
  })

  async function activities(enrollment: OwnerEnrollment): Promise<WorkerActivity[]> {
    const owned = await readOwnedRun(context, enrollment)
    if (!owned || stopped) return []
    const result: WorkerActivity[] = []
    const journal = store.journal(enrollment.watcherId)
    const attempts = new Map(latestAttempts(journal).filter(entry => entry.dispatchId).map(entry => [entry.dispatchId!, entry]))
    const samples = new Map<string, JournalEntry>()
    const progressByWorker = new Map<string, JournalEntry>()
    for (const entry of journal) {
      if (typeof entry.dispatchId !== 'string') continue
      if (entry.kind === 'owner-worker-sample') samples.set(entry.dispatchId, entry)
      if (entry.kind === 'owner-worker-progress' || entry.kind === 'mailbox-observed' || entry.kind === 'escalation' && typeof entry.messageId === 'string') progressByWorker.set(entry.dispatchId, entry)
    }
    for (const worker of owned.workers) {
      const attempt = attempts.get(worker.dispatchId)
      if (!attempt || attempt.state === 'settled') continue
      let contact: WorkerActivity['contact'] = worker.state === 'live' ? 'live' : worker.state === 'exited' ? 'exited' : 'unverifiable'
      let waiting = false, activityStamp = '', lastMessage: string | undefined
      if (contact === 'live') {
        try {
          const view = await context.call('quirky.orchestration/workerShow', { dispatchId: worker.dispatchId }) as WorkerView
          if (stopped) return []
          if (view.observation?.status !== 'live' || !view.observation.exactWorker || view.observation.session?.id !== worker.sessionId) contact = 'unverifiable'
          else {
            waiting = view.observation.agentWait?.waiting === true
            activityStamp = `${worker.processIncarnation}:${view.observation.session.lastActivityAt}`
            if (waiting) {
              try {
                const output = await context.call('quirky.orchestration/workerRead', { dispatchId: worker.dispatchId, source: 'auto', limit: 16384 }) as { sourceExact: boolean; content: string; messages?: { role?: string; text?: string }[] }
                if (stopped) return []
                if (output.sourceExact) lastMessage = output.messages?.filter(message => message.role === 'assistant').at(-1)?.text ?? output.content
              } catch {
                // Output absence is not proof that a positively observed process lost contact.
              }
            }
          }
        } catch { contact = 'unverifiable'; waiting = false }
      }
      const previous = samples.get(worker.dispatchId)
      const idleSinceMs = waiting && contact === 'live'
        ? previous?.waiting === true && previous.activityStamp === activityStamp && typeof previous.idleSinceMs === 'number' ? previous.idleSinceMs : now()
        : undefined
      if (previous?.waiting !== waiting || previous?.activityStamp !== activityStamp || previous?.contact !== contact) {
        append(enrollment.watcherId, 'owner-worker-sample', { dispatchId: worker.dispatchId, waiting, activityStamp, contact, idleSinceMs: idleSinceMs ?? null }, true)
      }
      const progress = progressByWorker.get(worker.dispatchId)
      result.push({ dispatchId: worker.dispatchId, contact, observedAtMs: now(), waitingAtPrompt: waiting, ...(idleSinceMs !== undefined ? { idleSinceMs } : {}), lastProgressAtMs: progress?.atMs ?? attempt.atMs, ...(lastMessage ? { lastMessage } : {}) })
    }
    return result
  }

  async function step(enrollment: Enrollment, snapshot: Snapshot, deviation?: OwnerDeviation, canDispatch?: () => boolean) {
    proposals.delete(enrollment.watcherId)
    if (stopped || enrollment.terminalAtMs !== null) return { handled: false }
    const ownerEnrollment = enrollment as OwnerEnrollment
    const journal = store.journal(enrollment.watcherId)
    const inputs = journal.filter(entry => entry.kind === 'owner-deviation-input').map(entry => parseOwnerDeviation(entry.deviation))
    if (deviation) inputs.push(parseOwnerDeviation(deviation))
    const workers = await activities(ownerEnrollment)
    const scan = scanWorkers(workers, !!ownerEnrollment.owner, now())
    if (stopped) return { handled: false }
    for (const observation of scan.observations) {
      if (!journal.some(entry => entry.kind === 'client-observation' && entry.observationKey === observation.key)) {
        store.append(enrollment.watcherId, { kind: 'client-observation', class: 'observation', origin: 'client', resolved: true, what: 'worker-idle', observationKey: observation.key, ...observation })
      }
    }
    for (const question of scan.questions) {
      const escalationId = `worker-escalation:${question.key}`
      if (journal.some(entry => entry.kind === 'escalation' && entry.escalationId === escalationId)) continue
      const current = store.get(enrollment.watcherId)
      if (!current || !current.enabled || current.paused) continue
      store.transaction(() => {
        store.save({ ...current, enabled: false, parkReason: 'worker-escalation', haltReason: question.body })
        append(current.watcherId, 'escalation', { escalationId, escalationKind: 'park-worker-escalation', status: 'open', foldCount: 1, ...question })
      })
    }
    inputs.push(...scan.deviations)
    if (ownerEnrollment.owner) {
      for (const worker of workers) {
        if (worker.contact === 'exited' || worker.contact === 'unverifiable') {
          const kind = worker.contact === 'exited' ? 'worker-exited' : 'worker-unverifiable'
          inputs.push({ kind, naturalKey: `${kind}:${worker.dispatchId}`, dispatchId: worker.dispatchId, detail: `${kind}: ${worker.dispatchId}` })
        }
      }
    }
    if (canDispatch) dispatchFences.set(enrollment.watcherId, canDispatch)
    let result: OwnerStepResult
    try {
      result = await controller.step(store.get(enrollment.watcherId) as OwnerEnrollment ?? ownerEnrollment, snapshot, inputs)
    } finally {
      dispatchFences.delete(enrollment.watcherId)
    }
    const action = proposals.get(enrollment.watcherId)
    const deadline = Math.min(result.nextCheckAtMs ?? Infinity, scan.nextCheckAtMs ?? Infinity)
    return { ...result, ...(action ? { action } : {}), ...(Number.isFinite(deadline) ? { nextCheckAtMs: deadline } : {}) }
  }

  async function execute(action: KernelAction, executeContext: ExecuteContext): Promise<ExecuteResult> {
    if (stopped || executeContext.signal.aborted) return { effect: 'not-landed', reason: 'owner-stopped' }
    const pending = controller.inspect(executeContext.enrollment.watcherId).pending
    if (!pending || pending.phase !== 'ready' || action.ownerReportKey !== pending.reportKey) return { effect: 'not-landed', reason: 'owner-report-stale' }
    const intervention = parseOwnerIntervention(action.ownerIntervention)
    if (JSON.stringify(intervention) !== JSON.stringify(pending.intervention)) return { effect: 'not-landed', reason: 'owner-report-mismatch' }
    if ('dispatchId' in intervention) return executeWorkerIntervention(context, store, executeContext.enrollment, intervention, executeContext.attemptId)
    if (intervention.kind === 'kind-action') {
      const kind = registry.get(executeContext.enrollment.kind)
      if (!kind) return { effect: 'not-landed', reason: 'unknown-kind' }
      return kind.execute(action, executeContext)
    }
    if (intervention.kind === 'ask-human') park(executeContext.enrollment, pending.escalationId, intervention.question)
    if (intervention.kind === 'abandon') {
      const current = store.get(executeContext.enrollment.watcherId)
      if (!current) return { effect: 'not-landed', reason: 'watcher-not-found' }
      store.save({ ...current, enabled: false, parkReason: null, haltReason: 'explicit-disarm' })
      append(current.watcherId, 'evidence', { evidenceKind: 'owner-abandon', payload: { reason: intervention.reason } }, true)
    }
    return { effect: 'landed', reason: `owner-${intervention.kind}` }
  }
  return { controller, step, execute, onTerminal: watcherId => controller.release(watcherId), shutdown: async () => { stopped = true; proposals.clear(); dispatchFences.clear(); await controller.shutdown() } }
}

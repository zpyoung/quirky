import { randomUUID } from 'node:crypto'
import { RpcErrorCode, type Ask, type AskEnvelope, type AskRegistration, type AskSpec, type PluginCaller, type PluginContext, type PluginErrorKind, type PluginInfo, type PluginSessionAuthority, type Session, type UiState } from '@quirky/protocol'
import { AskService } from './asks'
import { formatSpecErrors, validateAskSpec } from './src/core/spec'
import { flattenAskSpec, mapCoordinatorReply } from './src/core/handoff'
import { askHandoffMigration, askOwnershipMigration, askQueueMigration } from './store-migrations'
import { ClaudeVersionGate, commandProbe, suppressionHook } from './suppression'
import type { AskHandoffIdentity, AskHandoffRequest } from './runtime-types'
import { v1AsksMigration } from './v1-import'

const QUESTIONS_PANEL = 'panel:quirky.ask/questions'
const WORKTREE_VIEW = 'view:quirky.session/worktree'

function focusedSession(state: UiState): string | null {
  if (!state.windows.some((window) => window.focused) || state.layout.focus !== 'view') return null
  const view = state.layout.view
  if (view?.id !== WORKTREE_VIEW) return null
  const slot = state.slots.find((candidate) => candidate.id === WORKTREE_VIEW && candidate.shown)
  if (slot?.report !== undefined) {
    const report = slot.report
    if (typeof report === 'object' && report !== null && !Array.isArray(report) && 'active' in report) {
      return typeof report.active === 'string' ? report.active : null
    }
    return null
  }
  const input = view.input
  if (typeof input === 'object' && input !== null && !Array.isArray(input) && 'session' in input) {
    return typeof input.session === 'string' ? input.session : null
  }
  return null
}


function str(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' ? value : undefined
}


function logSafely(context: PluginContext, message: string): void {
  try {
    context.log(message)
  } catch {
    // The host revokes plugin contexts before calling deactivate.
  }
}

function errorSafely(context: PluginContext, kind: PluginErrorKind, message: string): Error {
  try {
    return context.error(kind, message)
  } catch {
    return new Error(message)
  }
}

function emitSafely(context: PluginContext, event: string, data: unknown): void {
  try {
    context.emit(event, data)
  } catch {
    // Revoked plugin contexts can't emit; ask-store mutations must still complete.
  }
}
const DEFAULT_HANDOFF_TIMEOUT_MS = 600_000
const MAX_HANDOFF_TIMEOUT_MS = 1_800_000
type AskOwnerIdentity = Pick<PluginSessionAuthority, 'sessionId' | 'processIncarnation' | 'source'>
type PlainRecord = Record<string, unknown>

function recordOf(value: unknown): PlainRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as PlainRecord : null
}

function ownerIdentityOf(caller: PluginCaller): AskOwnerIdentity | undefined {
  if (caller.role === 'plugin' || !caller.sessionAuthority) return undefined
  const identity = caller.sessionAuthority
  if (caller.sessionId !== identity.sessionId || identity.live !== true) return undefined
  return { sessionId: identity.sessionId, processIncarnation: identity.processIncarnation, source: identity.source }
}

function handoffIdentityOf(value: unknown, sessionId: string): AskHandoffIdentity | null {
  const identity = recordOf(value)
  if (
    !identity ||
    typeof identity.runId !== 'string' || identity.runId === '' ||
    typeof identity.dispatchId !== 'string' || identity.dispatchId === '' ||
    typeof identity.workerId !== 'string' || identity.workerId === '' ||
    identity.sessionId !== sessionId
  ) return null
  return {
    runId: identity.runId,
    dispatchId: identity.dispatchId,
    workerId: identity.workerId,
    sessionId
  }
}
function sameHandoffIdentity(left: AskHandoffIdentity, right: AskHandoffIdentity): boolean {
  return left.runId === right.runId &&
    left.dispatchId === right.dispatchId &&
    left.workerId === right.workerId &&
    left.sessionId === right.sessionId
}

function errorReason(error: unknown): string | null {
  const rpc = recordOf(error)
  const data = recordOf(rpc?.data)
  if (typeof data?.reason === 'string') return data.reason
  const message = error instanceof Error ? error.message : String(error)
  return /^([a-z][a-z0-9_]*):/.exec(message)?.[1] ?? null
}

function boundedHandoffTimeout(timeoutMs: number | undefined): number {
  return Math.max(1, Math.min(timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS, MAX_HANDOFF_TIMEOUT_MS))
}

async function hasAttachedQuestionSurface(context: PluginContext): Promise<boolean> {
  try {
    const state = (await context.call('ui.state')) as UiState
    return Array.isArray(state.windows) && state.windows.length > 0
  } catch {
    return false
  }
}

async function reconcileOwnerSession(context: PluginContext, asks: AskService, sessionId: string): Promise<void> {
  const owners = asks.pendingOwners(sessionId)
  if (owners.length === 0) return

  let identity: PluginSessionAuthority | null
  try {
    identity = context.launch.sessionIdentity(sessionId)
  } catch {
    return
  }
  if (identity?.live === true && identity.sessionId === sessionId) {
    const expiredIncarnations = new Set(owners
      .filter((owner) => owner.identity.processIncarnation !== identity.processIncarnation)
      .map((owner) => owner.identity.processIncarnation))
    for (const processIncarnation of expiredIncarnations) {
      asks.unavailableForSession(
        sessionId,
        `Session ${sessionId} was replaced; its exact asker process is no longer available.`,
        processIncarnation
      )
    }
    return
  }
  // A structured lease belongs to this daemon's complete kernel registry, unlike an unprobed PTY.
  for (const owner of owners) {
    if (owner.identity.source === 'structured_lease') {
      asks.unavailable(owner.askId, `The kernel no longer owns the native session lease for ${sessionId}.`, false)
    }
  }

  let session: Session
  try {
    session = (await context.call('quirky.session/get', { session: sessionId })) as Session
  } catch {
    // Missing session authority is unknown evidence, not proof that the asker exited.
    return
  }
  if (session.id === sessionId && session.status === 'exited') {
    asks.unavailableForSession(sessionId, `Session ${sessionId} exited; its exact asker process is no longer available.`)
  }
}

async function reconcileOwnerSessions(context: PluginContext, asks: AskService): Promise<void> {
  for (const sessionId of asks.pendingOwnerSessions()) await reconcileOwnerSession(context, asks, sessionId)
}
async function registerAsk(
  context: PluginContext,
  asks: AskService,
  params: Record<string, unknown>,
  caller: PluginCaller
): Promise<AskRegistration> {
  const requestId = str(params, 'requestId')
  if (!requestId) throw errorSafely(context, 'invalid-params', 'requestId must be a non-empty string')
  const checked = validateAskSpec(params.spec, { checkCredentialText: true })
  if (!checked.ok) throw errorSafely(context, 'invalid-params', formatSpecErrors(checked.errors))
  const timeoutMs = params.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw errorSafely(context, 'invalid-params', 'timeoutMs must be an integer of at least 1')
  }
  if (caller.role === 'plugin') throw errorSafely(context, 'invalid-params', 'Ask registration requires an authenticated client caller')

  const owner = ownerIdentityOf(caller)
  const sessionId = owner?.sessionId ?? null
  const worktreeId = caller.worktreeId ?? null
  const existing = asks.registration(requestId, checked.spec, sessionId, worktreeId, owner)
  if (existing) return existing

  if (!owner && caller.sessionId !== undefined) {
    return { status: 'unavailable', reason: `Session ${caller.sessionId} has no live authenticated asker process.` }
  }
  if (!owner) {
    if (!await hasAttachedQuestionSurface(context)) {
      return { status: 'unavailable', reason: 'No attached question surface or live authenticated asker session is available.' }
    }
    return asks.register(checked.spec, null, worktreeId, { requestId, ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}) })
  }

  const live = context.launch.sessionIdentity(owner.sessionId)
  if (!live || live.sessionId !== owner.sessionId || live.processIncarnation !== owner.processIncarnation) {
    return { status: 'unavailable', reason: `Session ${owner.sessionId} no longer has the exact authenticated asker process.` }
  }

  let forwarded: unknown
  try {
    forwarded = await context.forward('quirky.orchestration/ask', {
      mode: 'question',
      question: flattenAskSpec(checked.spec),
      timeoutMs: 0,
      requestId,
      contractVersion: 1,
      includeIdentity: true
    }, caller)
  } catch (error) {
    const reason = errorReason(error)
    const rpc = recordOf(error)
    if (reason !== 'dispatch_inactive' && rpc?.code !== RpcErrorCode.MethodNotFound) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'unavailable', reason: `The exact orchestration handoff could not be created: ${message.slice(0, 800)}` }
    }
  }

  const result = recordOf(forwarded)
  const handoffIdentity = result ? handoffIdentityOf(result.handoffIdentity, owner.sessionId) : null
  const questionId = typeof result?.messageId === 'string' ? result.messageId : ''
  let handoff: AskHandoffRequest | undefined
  if (result !== null && result !== undefined) {
    if (!handoffIdentity || questionId === '') {
      return { status: 'unavailable', reason: 'The orchestration owner did not attest an exact question and worker identity.' }
    }
    handoff = {
      spec: checked.spec,
      identity: handoffIdentity,
      requestId,
      timeoutMs: boundedHandoffTimeout(typeof timeoutMs === 'number' ? timeoutMs : undefined)
    }
  }

  const registration = asks.register(handoff?.spec ?? checked.spec, sessionId, worktreeId, {
    requestId,
    ownerIdentity: owner,
    ...(handoff
      ? { timeoutMs: handoff.timeoutMs, handoff: { identity: handoff.identity, questionId } }
      : typeof timeoutMs === 'number' ? { timeoutMs } : {})
  })

  if (handoff && result?.state === 'answered' && typeof result.answer === 'string') {
    const mapped = mapCoordinatorReply(handoff.spec, result.answer)
    asks.answerHandoff(registration.askId, mapped.answers, mapped.skipped)
  } else if (handoff && result?.state === 'cancelled') {
    asks.cancel(registration.askId)
  }

  const ask = asks.get(registration.askId)
  if (!handoff && ask.envelope.status === 'pending' && !ask.queued) await openQuestionsPanel(context, ask.sessionId)
  return registration
}

async function waitForAsk(
  context: PluginContext,
  asks: AskService,
  askId: string,
  timeoutMs: number | undefined,
  caller: PluginCaller,
  signal: AbortSignal
): Promise<AskEnvelope> {
  let current: Ask
  try {
    current = asks.get(askId)
  } catch (error) {
    if (recordOf(error)?.code !== RpcErrorCode.NotFound) throw error
    const reason = `Ask ${askId} is unknown or has expired.`
    return { status: 'unavailable', askId, answers: {}, skipped: [], summary: reason, reason }
  }
  if (current.envelope.status !== 'pending') return current.envelope
  const handoff = asks.handoff(askId)
  if (!handoff) return asks.wait(askId, timeoutMs, signal)

  const owner = ownerIdentityOf(caller)
  const storedOwner = asks.pendingOwners(handoff.identity.sessionId).find((item) => item.askId === askId)
  if (
    !owner ||
    owner.sessionId !== handoff.identity.sessionId ||
    !storedOwner ||
    owner.processIncarnation !== storedOwner.identity.processIncarnation
  ) {
    throw errorSafely(context, 'conflict', 'This Ask handoff is bound to a different or expired asker session.')
  }

  return asks.waitHandoff(askId, timeoutMs, signal, async (target, chunkMs) => {
    let result: unknown
    try {
      result = await context.forward('quirky.orchestration/ask', {
        mode: 'resume',
        messageId: target.questionId,
        runId: target.identity.runId,
        timeoutMs: chunkMs,
        requestId: randomUUID(),
        contractVersion: 1,
        includeIdentity: true
      }, caller)
    } catch (error) {
      const reason = errorReason(error)
      if (['dispatch_inactive', 'worker_identity_changed', 'consumer_fenced', 'dispatch_run_mismatch', 'question_not_found'].includes(reason ?? '')) {
        const message = error instanceof Error ? error.message : String(error)
        return asks.unavailable(askId, `The exact orchestration handoff is no longer available: ${message}`)
      }
      throw error
    }

    const envelope = recordOf(result)
    const returnedIdentity = envelope ? handoffIdentityOf(envelope.handoffIdentity, target.identity.sessionId) : null
    if (
      !envelope ||
      !returnedIdentity ||
      !sameHandoffIdentity(returnedIdentity, target.identity) ||
      envelope.messageId !== target.questionId
    ) {
      return asks.unavailable(askId, 'The orchestration owner no longer proves the exact Run, Dispatch and session for this question.')
    }

    const ask = asks.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    if (envelope.state === 'answered' && typeof envelope.answer === 'string') {
      const mapped = mapCoordinatorReply(ask.spec, envelope.answer)
      return asks.answerHandoff(askId, mapped.answers, mapped.skipped)
    }
    if (envelope.state === 'cancelled') return asks.cancel(askId)
    if (envelope.state === 'timedOut' && ask.expiresAt !== null && ask.expiresAt <= Date.now()) {
      return asks.expire(askId)
    }
    return asks.get(askId).envelope
  })
}
async function cancelInactiveOwners(context: PluginContext, asks: AskService): Promise<void> {
  try {
    const plugins = (await context.call('plugin.list')) as PluginInfo[]
    const activePluginIds = new Set(plugins.filter((plugin) => plugin.state === 'active').map((plugin) => plugin.id))
    if (service === asks) asks.cancelOwnedByInactivePlugins(activePluginIds)
  } catch (error) {
    logSafely(context, `could not reconcile plugin-owned asks: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Reveals Questions only for the exact active terminal session and never replaces a chosen panel. */
async function openQuestionsPanel(context: PluginContext, sessionId: string | null): Promise<void> {
  if (sessionId === null) return
  try {
    const state = (await context.call('ui.state')) as UiState
    if (state.layout.panel !== null || focusedSession(state) !== sessionId) return
    await context.call('ui.panel.open', { id: QUESTIONS_PANEL })
  } catch (error) {
    logSafely(context, `could not open the Questions panel: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let service: AskService | undefined
let removeEventListener: (() => void) | undefined

/** Provides Ask methods, exact handoff routing, liveness reconciliation, deadlines and the Claude launch hook. */
export function activate(context: PluginContext): void {
  const store = context.openStore([v1AsksMigration(context.home), askQueueMigration, askOwnershipMigration, askHandoffMigration])
  const asks = new AskService(
    store,
    {
      invalidParams: (message) => errorSafely(context, 'invalid-params', message),
      notFound: (message) => errorSafely(context, 'not-found', message),
      conflict: (message) => errorSafely(context, 'conflict', message),
      busy: (message) => Object.assign(errorSafely(context, 'conflict', message), { data: { reason: 'runtime_busy' } })
    },
    {
      created: (ask, seq) => emitSafely(context, 'created', { ask, seq }),
      surfaced: (ask, seq) => {
        emitSafely(context, 'surfaced', { ask, seq })
        void openQuestionsPanel(context, ask.sessionId)
      },
      updated: (askId, partial, seq) => emitSafely(context, 'updated', { askId, partial, seq }),
      resolved: (askId, envelope, seq) => emitSafely(context, 'resolved', { askId, envelope, seq })
    }
  )

  service = asks
  removeEventListener = context.subscribe((event) => {
    if (event.type === 'plugin.changed') {
      void cancelInactiveOwners(context, asks)
      void reconcileOwnerSessions(context, asks)
    }
    if (event.type === 'quirky.session/changed') {
      const eventData = 'data' in event ? recordOf(event.data) : null
      const session = recordOf(eventData?.session)
      if (typeof session?.id === 'string') {
        void reconcileOwnerSession(context, asks, session.id).catch((error) =>
          logSafely(context, `could not reconcile Ask owner ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        )
      }
    }
  })

  context.provide('method:quirky.ask/create', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const client = caller.role === 'plugin' ? undefined : caller
    const sessionId = str(params, 'session') ?? client?.sessionId ?? null
    const worktreeId = str(params, 'worktree') ?? client?.worktreeId ?? null

    // Kernel confirmations also use role "plugin", but have no lifecycle-owned registry entry.
    let ownerPluginId: string | undefined
    if (caller.role === 'plugin') {
      const plugins = (await context.call('plugin.list')) as PluginInfo[]
      if (plugins.some((plugin) => plugin.id === caller.pluginId)) ownerPluginId = caller.pluginId
    }
    const ownerIdentity = ownerIdentityOf(caller)
    const ask = asks.create(
      params.spec,
      sessionId,
      worktreeId,
      {
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        checkCredentialText: caller.role !== 'plugin',
        ...(ownerPluginId === undefined ? {} : { ownerPluginId }),
        ...(ownerIdentity === undefined || ownerIdentity.sessionId !== sessionId ? {} : { ownerIdentity })
      }
    )
    if (ask.envelope.status === 'pending' && !ask.queued) await openQuestionsPanel(context, ask.sessionId)
    return { askId: ask.id }
  })
  context.provide('method:quirky.ask/register', (params: Record<string, unknown>, caller: PluginCaller) =>
    registerAsk(context, asks, params, caller)
  )
  context.provide('method:quirky.ask/wait', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const controller = new AbortController()
    const unsubscribe = caller.role === 'plugin' ? undefined : caller.connection?.onClose(() => controller.abort())
    try {
      return await waitForAsk(context, asks, str(params, 'askId')!, typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined, caller, controller.signal)
    } finally {
      unsubscribe?.()
    }
  })
  context.provide('method:quirky.ask/answer', (params: Record<string, unknown>) => {
    const askId = str(params, 'askId')!
    if (asks.handoff(askId)) throw errorSafely(context, 'conflict', 'This handoff question must be answered through its exact coordinator question.')
    return asks.answer(askId, params.answers, params.skipped)
  })
  context.provide('method:quirky.ask/cancel', (params: Record<string, unknown>) => {
    const askId = str(params, 'askId')!
    if (asks.handoff(askId)) throw errorSafely(context, 'conflict', 'This handoff question must be cancelled through its coordinator.')
    try {
      return asks.cancel(askId)
    } catch (error) {
      if (recordOf(error)?.code !== RpcErrorCode.NotFound) throw error
      const reason = `Ask ${askId} is unknown or has expired.`
      return { status: 'unavailable', askId, answers: {}, skipped: [], summary: reason, reason }
    }
  })
  context.provide('method:quirky.ask/list', (params: Record<string, unknown>, caller: PluginCaller) =>
    asks.list(params.pendingOnly === true, caller.role === 'mobile', str(params, 'askId'))
  )
  context.provide('method:quirky.ask/updatePartial', (params: Record<string, unknown>) =>
    asks.updatePartial(str(params, 'askId')!, params.partial)
  )
  context.provide('method:quirky.ask/expire', (params: Record<string, unknown>) => asks.expire(str(params, 'askId')!))
  context.provide('job:quirky.ask/deadlines', () => asks.sweep())
  context.provide('launch-hook:quirky.ask/claude-ask', suppressionHook(context, new ClaudeVersionGate(commandProbe(context), Date.now)))

  asks.cancelPluginOwned()
  asks.start()
  void reconcileOwnerSessions(context, asks)
}

/** Cancels plugin-owned asks while the store is open, then rejects remaining waits and clears timers. */
export function deactivate(): void {
  const asks = service
  const unsubscribe = removeEventListener
  removeEventListener = undefined
  try {
    unsubscribe?.()
    asks?.cancelPluginOwned()
  } finally {
    asks?.shutdown()
    if (service === asks) service = undefined
  }
}

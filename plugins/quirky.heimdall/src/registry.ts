import { checkSchemaDeclaration, isContributionName, isKind, isPluginId } from '@quirky/protocol'
import { parseOwnerDeviation } from './owner/runtime'
import type { PluginContext, Schema } from '@quirky/protocol'
import type {
  AuthorizedEnrollment,
  Decision,
  DispatchResult,
  ExecuteContext,
  ExecuteResult,
  GateVerdict,
  Json,
  KernelAction,
  KindRegistration,
  KindRegistry,
  KernelStore,
  PacingTier,
  Snapshot,
  StopResult,
  WatcherKind,
  WorkerRequest
} from './contracts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.keys(value).every((key) => isJsonValue((value as Record<string, unknown>)[key], ancestors))
  ancestors.delete(value)
  return valid
}

function freezeJson(value: Json): Json {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry)
  } else {
    for (const entry of Object.values(value)) freezeJson(entry)
  }
  Object.freeze(value)
  return value
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'string'
}

function isOwnerConfig(value: unknown): boolean {
  return value === null || (record(value) && Object.hasOwn(value, 'agent') && value.agent === 'claude' &&
    Object.keys(value).every((key) => ['agent', 'model', 'effort'].includes(key)) &&
    optionalString(value, 'model') && optionalString(value, 'effort'))
}

function isAuthorizedEnrollment(value: unknown): value is AuthorizedEnrollment {
  if (!record(value) || !isJsonValue(value) ||
    !Object.hasOwn(value, 'workspaceKey') || typeof value.workspaceKey !== 'string' ||
    !Object.hasOwn(value, 'workspacePath') || typeof value.workspacePath !== 'string' ||
    !Object.hasOwn(value, 'executionHostId') || typeof value.executionHostId !== 'string' ||
    !Object.hasOwn(value, 'schedulerOwner') || typeof value.schedulerOwner !== 'string' ||
    !Object.hasOwn(value, 'kindPayload') || !isJsonValue(value.kindPayload)) return false
  return (
    (!Object.hasOwn(value, 'repoId') || value.repoId === null || typeof value.repoId === 'string') &&
    (!Object.hasOwn(value, 'worktreeId') || value.worktreeId === null || typeof value.worktreeId === 'string') &&
    (!Object.hasOwn(value, 'undo') || isJsonValue(value.undo)) &&
    (!Object.hasOwn(value, 'owner') || isOwnerConfig(value.owner)) &&
    (!Object.hasOwn(value, 'ownerInterventionCapability') || isCapabilityMode(value.ownerInterventionCapability))
  )
}

function isCapabilityMode(value: unknown): value is 'off' | 'gated' | 'on' {
  return value === 'off' || value === 'gated' || value === 'on'
}

function isSnapshot(value: unknown): value is Snapshot {
  return record(value) && isJsonValue(value) &&
    (value.freshness === 'live' || value.freshness === 'cached') &&
    typeof value.contentIdentity === 'string' && Number.isFinite(value.observedAtMs) &&
    isJsonValue(value.world)
}

function isKernelAction(value: unknown): value is KernelAction {
  if (!record(value) || !isJsonValue(value)) return false
  return typeof value.kind === 'string' && value.kind.length > 0 &&
    typeof value.capability === 'string' && value.capability.length > 0 &&
    (value.visibility === 'external' || value.visibility === 'local') &&
    typeof value.contentIdentity === 'string' && typeof value.evidenceKey === 'string' &&
    (!Object.hasOwn(value, 'recovery') || value.recovery === 'replay-safe') &&
    (!Object.hasOwn(value, 'approvalRequired') || typeof value.approvalRequired === 'boolean') &&
    (!Object.hasOwn(value, 'expectedState') || (record(value.expectedState) &&
      typeof value.expectedState.target === 'string' && isJsonValue(value.expectedState.before)))
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return record(value) && isJsonValue(value) && typeof value.spec === 'string' && typeof value.worktree === 'string' &&
    (!Object.hasOwn(value, 'agent') || typeof value.agent === 'string') &&
    (!Object.hasOwn(value, 'mode') || value.mode === 'terminal' || value.mode === 'structured') &&
    (!Object.hasOwn(value, 'taskTitle') || typeof value.taskTitle === 'string')
}

function isExecuteResult(value: unknown): value is ExecuteResult {
  return record(value) && isJsonValue(value) &&
    (value.effect === 'landed' || value.effect === 'not-landed' || value.effect === 'indeterminate') &&
    optionalString(value, 'reason') && optionalString(value, 'failureClass') &&
    (!Object.hasOwn(value, 'expectedAfter') || isJsonValue(value.expectedAfter))
}

function isDecision(value: unknown): value is Decision {
  if (!record(value) || !isJsonValue(value)) return false
  if (!Object.hasOwn(value, 'action')) return false
  if (value.action === null) return (typeof value.reason === 'string' || value.deviation !== undefined) &&
    optionalString(value, 'reason') && optionalString(value, 'detail') && isStringArray(value.considered) && isDeviation(value.deviation)
  return isKernelAction(value.action) && optionalString(value, 'detail') &&
    isStringArray(value.considered) && isDeviation(value.deviation)
}

function isStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function isDeviation(value: unknown): boolean {
  if (value === undefined) return true
  try {
    parseOwnerDeviation(value)
    return true
  } catch {
    return false
  }
}
function isGateVerdict(value: unknown): value is GateVerdict {
  return record(value) && isJsonValue(value) &&
    (value.verdict === 'allow' || ((value.verdict === 'hold' || value.verdict === 'escalate') &&
      typeof value.reason === 'string' && optionalString(value, 'detail')))
}

function isStopResult(value: unknown): value is StopResult {
  if (value === null) return true
  if (!record(value) || !isJsonValue(value)) return false
  if (value.kind === 'terminal') return typeof value.state === 'string' && typeof value.reason === 'string'
  return value.kind === 'park' && typeof value.reason === 'string' &&
    ['budget', 'stop-predicate', 'worker-question', 'worker-escalation', 'coordinator-seat-lost', 'configuration-error'].includes(value.reason) &&
    typeof value.detail === 'string' && isDeviation(value.deviation)
}

function isPacingTier(value: unknown): value is PacingTier {
  return value === 'rapid' || value === 'active' || value === 'idle' || value === 'stopped'
}

const requiredHooks = ['authorize', 'read', 'decide', 'execute'] as const
const optionalHooks = [
  'validate', 'undo', 'describeEnrollment', 'describeSnapshot', 'resolveOutcome',
  'preflight', 'pace', 'stop', 'reconcile', 'ownerAction'
] as const

function isOwnedHookReference(value: unknown, pluginId: string): value is string {
  if (typeof value !== 'string') return false
  const prefix = `${pluginId}/`
  return value.startsWith(prefix) && !value.slice(prefix.length).includes('/') &&
    isContributionName(value.slice(prefix.length))
}

function normalizeDescriptor(value: unknown, pluginId: string): KindRegistration {
  if (!record(value) || !isPluginId(pluginId) ||
    !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'displayName') ||
    !Object.hasOwn(value, 'enrollmentPayloadSchema') || !Object.hasOwn(value, 'hooks')) {
    throw new Error('invalid kind descriptor or declaring plugin ID')
  }
  if (Object.hasOwn(value, 'pluginId') && value.pluginId !== pluginId) {
    throw new Error('registration pluginId does not match authenticated owner')
  }
  if (typeof value.id !== 'string' || !isKind(value.id)) throw new Error('invalid kind ID')
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0) {
    throw new Error('displayName must be a non-empty string')
  }
  if (!isJsonValue(value.enrollmentPayloadSchema)) throw new Error('enrollment payload schema is not JSON serializable')
  const schemaProblems = checkSchemaDeclaration(value.enrollmentPayloadSchema, 'enrollmentPayloadSchema')
  if (schemaProblems.length > 0) throw new Error(schemaProblems.join('; '))
  if (!record(value.hooks) || !isJsonValue(value.hooks)) throw new Error('hooks must be a JSON object')
  const hooks = value.hooks
  for (const name of requiredHooks) {
    if (!Object.hasOwn(hooks, name) || !isOwnedHookReference(hooks[name], pluginId)) {
      throw new Error(`hook ${name} must be a full method reference owned by ${pluginId}`)
    }
  }
  for (const name of optionalHooks) {
    if (Object.hasOwn(hooks, name) && !isOwnedHookReference(hooks[name], pluginId)) {
      throw new Error(`hook ${name} must be a full method reference owned by ${pluginId}`)
    }
  }
  if (Object.keys(hooks).some((name) => !(requiredHooks as readonly string[]).includes(name) &&
    !(optionalHooks as readonly string[]).includes(name))) throw new Error('hooks contains an unknown hook name')
  let concurrency: KindRegistration['concurrency']
  const rawConcurrency = Object.hasOwn(value, 'concurrency') ? value.concurrency : undefined
  if (rawConcurrency !== undefined) {
    if (!record(rawConcurrency) || !isJsonValue(rawConcurrency) ||
      Object.keys(rawConcurrency).some((key) => key !== 'parallelActions' && key !== 'drainOnBudget') ||
      (Object.hasOwn(rawConcurrency, 'parallelActions') && typeof rawConcurrency.parallelActions !== 'boolean') ||
      (Object.hasOwn(rawConcurrency, 'drainOnBudget') && typeof rawConcurrency.drainOnBudget !== 'boolean')) {
      throw new Error('concurrency must contain only boolean options')
    }
    concurrency = {
      ...(typeof rawConcurrency.parallelActions === 'boolean' ? { parallelActions: rawConcurrency.parallelActions } : {}),
      ...(typeof rawConcurrency.drainOnBudget === 'boolean' ? { drainOnBudget: rawConcurrency.drainOnBudget } : {})
    }
  }
  const schema = freezeJson(JSON.parse(JSON.stringify(value.enrollmentPayloadSchema)) as Json) as Schema
  const normalizedHooks = Object.freeze({ ...hooks }) as KindRegistration['hooks']
  const normalizedConcurrency = concurrency ? Object.freeze(concurrency) : undefined
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    enrollmentPayloadSchema: schema,
    hooks: normalizedHooks,
    ...(normalizedConcurrency ? { concurrency: normalizedConcurrency } : {}),
    pluginId
  }) as KindRegistration
}

function isDispatchResult(value: unknown): value is DispatchResult {
  if (!record(value) || !isJsonValue(value)) return false
  if (value.kind === 'dispatched') {
    return typeof value.dispatchId === 'string' && optionalString(value, 'terminalHandle')
  }
  if (value.kind === 'refused') {
    return typeof value.reason === 'string' && optionalString(value, 'detail')
  }
  return value.kind === 'indeterminate' && typeof value.requestId === 'string' && optionalString(value, 'detail')
}

function adaptDescriptor(context: PluginContext, registration: KindRegistration): WatcherKind {
  const hooks = registration.hooks
  const kind: WatcherKind = {
    id: registration.id,
    displayName: registration.displayName,
    enrollmentPayloadSchema: registration.enrollmentPayloadSchema,
    concurrency: registration.concurrency,
    async authorizeEnrollment(input) {
      const result = await context.call(hooks.authorize, { input })
      if (!isAuthorizedEnrollment(result)) {
        let detail = 'authorize hook returned an invalid authority'
        if (hooks.undo) {
          try {
            const undone = await context.call(hooks.undo, { authorization: result })
            if (undone !== undefined && undone !== null) detail += '; undo hook returned a value'
          } catch (error) {
            detail += `; authorization undo failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        const failure = new Error(detail)
        failure.name = 'InvalidEnrollmentAuthority'
        throw failure
      }
      return result
    },
    async read(enrollment, options) {
      const result = await context.call(hooks.read, { enrollment, options })
      if (!isSnapshot(result)) throw new Error('read hook returned an invalid snapshot')
      return result
    },
    async decide(snapshot, journal, enrollment) {
      const result = await context.call(hooks.decide, { snapshot, journal, enrollment })
      if (!isDecision(result)) throw new Error('decide hook returned an invalid decision')
      return result
    },
    async execute(action, executeContext: ExecuteContext) {
      if (!isKernelAction(action)) throw new Error('execute received an invalid action')
      if (!isJsonValue(executeContext.enrollment) || typeof executeContext.attemptId !== 'string' ||
        typeof executeContext.fingerprint !== 'string') throw new Error('execute received an invalid execution context')
      const result = await context.call(hooks.execute, {
        action,
        enrollment: executeContext.enrollment,
        attemptId: executeContext.attemptId,
        fingerprint: executeContext.fingerprint
      })
      if (record(result) && Object.hasOwn(result, 'worker')) {
        if (Object.keys(result).length !== 1 || !isJsonValue(result) || !isWorkerRequest(result.worker)) {
          throw new Error('execute hook returned an invalid worker request')
        }
        const dispatched = await executeContext.dispatchWorker(result.worker)
        if (!isDispatchResult(dispatched)) throw new Error('worker dispatcher returned an invalid result')
        if (dispatched.kind === 'dispatched') return { effect: 'landed' }
        if (dispatched.kind === 'refused') {
          return {
            effect: 'not-landed',
            reason: dispatched.detail ? `${dispatched.reason}: ${dispatched.detail}` : dispatched.reason
          }
        }
        return {
          effect: 'indeterminate',
          reason: dispatched.detail ? `request ${dispatched.requestId}: ${dispatched.detail}` : `request ${dispatched.requestId} is indeterminate`
        }
      }
      if (!isExecuteResult(result)) throw new Error('execute hook returned an invalid effect result')
      return result
    }
  }
  if (hooks.validate) {
    kind.validateEnrollment = async (candidate, existing) => {
      const result = await context.call(hooks.validate!, { candidate, existing })
      if (result !== undefined && result !== null) throw new Error('validate hook must not return a value')
    }
  }
  if (hooks.undo) {
    kind.undoAuthorization = async (authorization) => {
      const result = await context.call(hooks.undo!, { authorization })
      if (result !== undefined && result !== null) throw new Error('undo hook must not return a value')
    }
  }
  if (hooks.describeEnrollment) {
    kind.describeEnrollment = async (enrollment) => {
      const result = await context.call(hooks.describeEnrollment!, { enrollment })
      if (typeof result !== 'string') throw new Error('describeEnrollment hook must return a string')
      return result
    }
  }
  if (hooks.describeSnapshot) {
    kind.describeSnapshot = async (snapshot) => {
      const result = await context.call(hooks.describeSnapshot!, { snapshot })
      if (!isJsonValue(result)) throw new Error('describeSnapshot hook returned a non-JSON value')
      return result
    }
  }
  if (hooks.resolveOutcome) {
    kind.resolveOutcome = async (attempt, snapshot, journal, enrollment) => {
      const result = await context.call(hooks.resolveOutcome!, { attempt, snapshot, journal, enrollment })
      if (result !== null && !isExecuteResult(result)) throw new Error('resolveOutcome hook returned an invalid result')
      return result
    }
  }
  if (hooks.preflight) {
    kind.preflight = async (action, snapshot, journal, enrollment) => {
      const result = await context.call(hooks.preflight!, { action, snapshot, journal, enrollment })
      if (!isGateVerdict(result)) throw new Error('preflight hook returned an invalid gate verdict')
      return result
    }
  }
  if (hooks.pace) {
    kind.pace = async (snapshot, journal) => {
      const result = await context.call(hooks.pace!, { snapshot, journal })
      if (!isPacingTier(result)) throw new Error('pace hook returned an invalid pacing tier')
      return result
    }
  }
  if (hooks.stop) {
    kind.stop = async (snapshot, journal, enrollment) => {
      const result = await context.call(hooks.stop!, { snapshot, journal, enrollment })
      if (!isStopResult(result)) throw new Error('stop hook returned an invalid result')
      return result
    }
  }
  if (hooks.reconcile) {
    kind.reconcile = async (enrollment, snapshot, journal) => {
      const result = await context.call(hooks.reconcile!, { enrollment, snapshot, journal })
      if (typeof result !== 'boolean') throw new Error('reconcile hook must return a boolean')
      return result
    }
  }
  if (hooks.ownerAction) {
    kind.ownerAction = async (intervention, snapshot, journal, enrollment) => {
      const result = await context.call(hooks.ownerAction!, { intervention, snapshot, journal, enrollment })
      if (!isKernelAction(result)) throw new Error('ownerAction hook returned an invalid action')
      return result
    }
  }
  return kind
}

export function createKindRegistry(context: PluginContext, store: KernelStore): KindRegistry {
  const kinds = new Map<string, WatcherKind>()
  const owners = new Map<string, string>()
  const registrations = new Map<string, KindRegistration>()

  const installDescriptor = (descriptor: unknown, pluginId: string, persist: boolean): void => {
    const normalized = normalizeDescriptor(descriptor, pluginId)
    const existingOwner = owners.get(normalized.id)
    if (existingOwner !== undefined && existingOwner !== pluginId) {
      throw new Error(`kind ${normalized.id} is already owned by ${existingOwner}`)
    }
    if (persist) {
      if (store.readOnly) throw new Error('kind registry is read-only')
      store.saveRegistration(normalized)
    }
    kinds.set(normalized.id, adaptDescriptor(context, normalized))
    owners.set(normalized.id, pluginId)
    registrations.set(normalized.id, normalized)
  }

  for (const saved of store.registrations() as unknown[]) {
    if (!record(saved) || typeof saved.pluginId !== 'string') {
      context.log('Ignoring persisted kind registration without a valid plugin owner')
      continue
    }
    try {
      installDescriptor(saved, saved.pluginId, false)
    } catch (error) {
      context.log(`Ignoring invalid persisted kind registration ${String(saved.id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    get(id) {
      return kinds.get(id)
    },
    register(kind) {
      if (!kind || typeof kind.id !== 'string' || !isKind(kind.id) ||
        typeof kind.displayName !== 'string' || kind.displayName.trim().length === 0 ||
        typeof kind.authorizeEnrollment !== 'function' || typeof kind.read !== 'function' ||
        typeof kind.decide !== 'function' || typeof kind.execute !== 'function') {
        throw new Error('invalid internal kind registration')
      }
      const problems = checkSchemaDeclaration(kind.enrollmentPayloadSchema, 'enrollmentPayloadSchema')
      if (problems.length > 0) throw new Error(problems.join('; '))
      const existingOwner = owners.get(kind.id)
      if (existingOwner !== undefined && existingOwner !== context.pluginId) {
        throw new Error(`kind ${kind.id} is already owned by ${existingOwner}`)
      }
      kinds.set(kind.id, kind)
      owners.set(kind.id, context.pluginId)
    },
    registerDescriptor(descriptor, pluginId) {
      installDescriptor(descriptor, pluginId, true)
    },
    descriptors() {
      return [...registrations.values()].map((registration) =>
        JSON.parse(JSON.stringify(registration)) as KindRegistration)
    }
  }
}
